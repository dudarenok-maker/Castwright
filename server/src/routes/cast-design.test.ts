/* Integration tests for the "Design full cast" bulk-design route.

   Seeds one confirmed book with several speaking characters and drives the
   server-owned SSE job end to end (real ffmpeg encodes the audition; `global.fetch`
   mocks the sidecar; `generateVoiceStylePersona` is mocked so the persona-fallback
   path doesn't need a Gemini key). Asserts:
     - the serial loop emits progress → character_designed → idle in order, and
       persists `overrideTtsVoices.qwen.name` per character (series scope)
     - a persona-less character triggers the Gemini fallback + persists voiceStyle
     - FRESHNESS-SKIP: a character that already has a Qwen voice is skipped
       (no sidecar call) and counted as skipped
     - a single-character failure is recorded and the loop CONTINUES
     - MUTUAL EXCLUSION: starting a design while analysis is busy → 409; the
       single-design route 409s while a design job is busy
     - status + pause + bare-resubscribe(idle) endpoints. */

import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express, { type Express } from 'express';
import request from 'supertest';

const AUTHOR = 'Della Renwick';
const SERIES = 'The Hollow Tide';
const BOOK = 'The Hollow Tide';
const QWEN_KEY = 'qwen3-tts-0.6b';

let workspaceRoot: string;
let audioDir: string;
let bookDir: string;
let app: Express;
let bookId: string;

const fetchMock = vi.fn();
const { personaMock } = vi.hoisted(() => ({ personaMock: vi.fn() }));

vi.mock('../analyzer/voice-style.js', () => ({
  generateVoiceStylePersona: personaMock,
}));

const characters = [
  { id: 'narrator', name: 'Narrator', role: 'narrator', color: 'narrator' },
  {
    id: 'aria',
    name: 'Aria',
    role: 'supporting',
    color: 'lilac',
    voiceId: 'v_aria',
    voiceStyle: 'a poised, confident teenage girl, clear and warm',
    evidence: [{ quote: '“We have to tell the Council before the others wake.”' }],
  },
  {
    id: 'Brann',
    name: 'Brann',
    role: 'supporting',
    color: 'teal',
    voiceId: 'v_Brann',
    voiceStyle: 'a calm, assured young man, steady and warm',
    evidence: [{ quote: '“Trust me — we can do this together.”' }],
  },
  /* No persona → exercises the Gemini fallback. */
  {
    id: 'Hart',
    name: 'Hart',
    role: 'supporting',
    color: 'amber',
    evidence: [{ quote: '“I built it myself, you know.”' }],
  },
  /* Already designed → freshness-skip. */
  {
    id: 'Wren',
    name: 'Wren',
    role: 'lead',
    color: 'rose',
    voiceId: 'v_Wren',
    voiceStyle: 'a determined, earnest teenage girl',
    overrideTtsVoices: { qwen: { name: 'qwen-v_Wren' } },
  },
];

function writeBookOnDisk(chars: object[]) {
  mkdirSync(join(bookDir, '.audiobook'), { recursive: true });
  writeFileSync(
    join(bookDir, '.audiobook', 'state.json'),
    JSON.stringify({
      bookId,
      manuscriptId: `m_${bookId}`,
      title: BOOK,
      author: AUTHOR,
      series: SERIES,
      seriesPosition: 1,
      isStandalone: false,
      manuscriptFile: 'manuscript.txt',
      castConfirmed: true,
      chapters: [],
      coverGradient: ['#000', '#fff'],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }),
  );
  writeFileSync(join(bookDir, 'manuscript.txt'), 'placeholder');
  writeFileSync(join(bookDir, '.audiobook', 'cast.json'), JSON.stringify({ characters: chars }));
}

function readCast(): { characters: Array<Record<string, any>> } {
  return JSON.parse(readFileSync(join(bookDir, '.audiobook', 'cast.json'), 'utf8'));
}
function charById(id: string) {
  return readCast().characters.find((c) => c.id === id);
}

function okSidecarResponse(pcm = new Uint8Array(24_000 * 2 * 0.3)) {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    headers: new Headers({ 'Content-Type': 'audio/L16', 'X-Sample-Rate': '24000' }),
    arrayBuffer: async () => pcm.buffer,
    json: async () => ({}),
  };
}
function badSidecarResponse() {
  return {
    ok: false,
    status: 500,
    statusText: 'Internal Server Error',
    headers: new Headers(),
    arrayBuffer: async () => new ArrayBuffer(0),
    json: async () => ({ detail: 'model exploded' }),
  };
}

/** Parse an SSE response body into the list of JSON `data:` events. */
function parseSse(text: string): Array<Record<string, any>> {
  return text
    .split('\n')
    .filter((l) => l.startsWith('data: '))
    .map((l) => JSON.parse(l.slice(6)));
}

let designLock: typeof import('../tts/design-lock.js');
let qwenVoiceMod: typeof import('./qwen-voice.js');

beforeAll(async () => {
  workspaceRoot = mkdtempSync(join(tmpdir(), 'audiobook-cast-design-test-'));
  audioDir = mkdtempSync(join(tmpdir(), 'audiobook-cast-design-audio-'));
  process.env.WORKSPACE_DIR = workspaceRoot;
  process.env.VOICE_SAMPLE_AUDIO_DIR = audioDir;
  vi.stubGlobal('fetch', fetchMock);

  const [{ castDesignRouter }, qwenVoice, { makeBookId }, lock] = await Promise.all([
    import('./cast-design.js'),
    import('./qwen-voice.js'),
    import('../workspace/paths.js'),
    import('../tts/design-lock.js'),
  ]);
  qwenVoiceMod = qwenVoice;
  designLock = lock;
  bookId = makeBookId(AUTHOR, SERIES, BOOK);
  bookDir = join(workspaceRoot, 'books', AUTHOR, SERIES, BOOK);

  app = express();
  app.use(express.json());
  app.use('/api/books', castDesignRouter);
  app.use('/api/books', qwenVoice.qwenVoiceRouter);
});

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockResolvedValue(okSidecarResponse());
  personaMock.mockReset();
  personaMock.mockResolvedValue('a bright, quick-witted teenage boy');
  for (const f of readdirSync(audioDir)) rmSync(join(audioDir, f), { force: true });
  rmSync(join(workspaceRoot, 'voices'), { recursive: true, force: true });
  writeBookOnDisk(characters);
});

afterEach(() => {
  /* Defensive — clear any manually-set busy flags so tests stay isolated. */
  designLock.clearDesignBusy(bookDir);
  designLock.clearAnalysisBusy(bookDir);
});

afterAll(() => {
  vi.unstubAllGlobals();
  if (workspaceRoot) rmSync(workspaceRoot, { recursive: true, force: true });
  if (audioDir) rmSync(audioDir, { recursive: true, force: true });
  delete process.env.WORKSPACE_DIR;
  delete process.env.VOICE_SAMPLE_AUDIO_DIR;
});

describe('POST /api/books/:bookId/cast/design', () => {
  it('designs each character in order and persists the qwen override (series scope)', async () => {
    const res = await request(app)
      .post(`/api/books/${bookId}/cast/design`)
      .send({ characterIds: ['aria', 'Brann'], modelKey: QWEN_KEY });

    expect(res.status).toBe(200);
    const events = parseSse(res.text);
    const designed = events.filter((e) => e.type === 'character_designed').map((e) => e.characterId);
    expect(designed).toEqual(['aria', 'Brann']);
    const idle = events.find((e) => e.type === 'idle');
    expect(idle).toMatchObject({ done: 2, total: 2, skipped: 0 });
    expect(idle?.failures).toEqual([]);

    expect(charById('aria')?.overrideTtsVoices?.qwen?.name).toBe('qwen-v_aria');
    expect(charById('Brann')?.overrideTtsVoices?.qwen?.name).toBe('qwen-v_Brann');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('persona fallback: a persona-less character gets a Gemini persona persisted + designed', async () => {
    const res = await request(app)
      .post(`/api/books/${bookId}/cast/design`)
      .send({ characterIds: ['Hart'], modelKey: QWEN_KEY });

    expect(res.status).toBe(200);
    expect(personaMock).toHaveBeenCalledTimes(1);
    expect(charById('Hart')?.voiceStyle).toBe('a bright, quick-witted teenage boy');
    expect(charById('Hart')?.overrideTtsVoices?.qwen?.name).toBe('qwen-Hart');
  });

  it('freshness-skip: an already-designed character is skipped (no sidecar call)', async () => {
    const res = await request(app)
      .post(`/api/books/${bookId}/cast/design`)
      .send({ characterIds: ['Wren'], modelKey: QWEN_KEY });

    const events = parseSse(res.text);
    expect(events.some((e) => e.type === 'character_skipped' && e.characterId === 'Wren')).toBe(true);
    expect(events.some((e) => e.type === 'character_designed')).toBe(false);
    expect(events.find((e) => e.type === 'idle')).toMatchObject({ done: 0, skipped: 1 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('a per-character failure is recorded and the loop continues', async () => {
    fetchMock.mockReset();
    fetchMock.mockResolvedValueOnce(badSidecarResponse()); // aria fails
    fetchMock.mockResolvedValue(okSidecarResponse()); // Brann ok

    const res = await request(app)
      .post(`/api/books/${bookId}/cast/design`)
      .send({ characterIds: ['aria', 'Brann'], modelKey: QWEN_KEY });

    const events = parseSse(res.text);
    expect(events.some((e) => e.type === 'character_failed' && e.characterId === 'aria')).toBe(true);
    expect(events.some((e) => e.type === 'character_designed' && e.characterId === 'Brann')).toBe(true);
    const idle = events.find((e) => e.type === 'idle');
    expect(idle).toMatchObject({ done: 1, total: 2 });
    expect(idle?.failures).toHaveLength(1);
    expect(charById('Brann')?.overrideTtsVoices?.qwen?.name).toBe('qwen-v_Brann');
  });

  it('sidecar liveness watchdog "stopped responding to /health" triggers fast-fail (sidecar_unavailable)', async () => {
    /* Regression: the bulk-design fast-fail regex previously matched
       "unreachable|did not complete within" but NOT the new liveness-watchdog
       message "stopped responding to /health during voice design". Without the
       fix, the job would grind through every remaining character to the 600s
       ceiling instead of stopping early. */
    const stoppedMsg =
      `TTS sidecar (http://localhost:9000) stopped responding to /health during voice design — the process may have crashed or been recycled.`;
    const spy = vi.spyOn(qwenVoiceMod, 'designQwenVoiceForCharacter').mockRejectedValue(
      new Error(stoppedMsg),
    );

    const res = await request(app)
      .post(`/api/books/${bookId}/cast/design`)
      .send({ characterIds: ['aria', 'Brann'], modelKey: QWEN_KEY });

    expect(res.status).toBe(200);
    const events = parseSse(res.text);
    const errorEvent = events.find((e) => e.type === 'error');
    expect(errorEvent).toBeDefined();
    expect(errorEvent?.code).toBe('sidecar_unavailable');
    expect(errorEvent?.message).toMatch(/stopped responding/i);
    /* The loop stopped after the first character — aria is NOT in character_designed */
    expect(events.some((e) => e.type === 'character_designed')).toBe(false);

    spy.mockRestore();
  });

  it('mutual exclusion: refuses to start while analysis is busy (409)', async () => {
    designLock.markAnalysisBusy(bookDir);
    const res = await request(app)
      .post(`/api/books/${bookId}/cast/design`)
      .send({ characterIds: ['aria'], modelKey: QWEN_KEY });
    expect(res.status).toBe(409);
    designLock.clearAnalysisBusy(bookDir);
  });

  it('bare POST with no live job replays idle and ends', async () => {
    const res = await request(app).post(`/api/books/${bookId}/cast/design`).send({});
    expect(res.status).toBe(200);
    expect(parseSse(res.text).find((e) => e.type === 'idle')).toBeTruthy();
  });
});

describe('GET /status + POST /pause', () => {
  it('status is inactive when no job is running; pause is a no-op', async () => {
    const status = await request(app).get(`/api/books/${bookId}/cast/design/status`);
    expect(status.body).toEqual({ active: false });
    const pause = await request(app).post(`/api/books/${bookId}/cast/design/pause`).send({});
    expect(pause.body).toMatchObject({ ok: true, cancelled: false });
  });
});

describe('single-design mutual exclusion', () => {
  it('the single design-voice route 409s while a bulk design is busy', async () => {
    designLock.markDesignBusy(bookDir);
    const res = await request(app)
      .post(`/api/books/${bookId}/cast/aria/design-voice`)
      .send({ sampleVoiceId: 'v_aria', modelKey: QWEN_KEY });
    expect(res.status).toBe(409);
    designLock.clearDesignBusy(bookDir);
  });

  it('bulk design 409s while a single voice design is in progress', async () => {
    designLock.markDesignBusy(bookDir);
    try {
      const res = await request(app)
        .post(`/api/books/${bookId}/cast/design`)
        .send({ characterIds: ['aria'], modelKey: QWEN_KEY });
      expect(res.status).toBe(409);
      expect(res.body.error).toMatch(/single voice design/i);
    } finally {
      designLock.clearDesignBusy(bookDir);
    }
  });
});

describe('scope + variantTasks (fs-25)', () => {
  /* Seed a character that already has a base Qwen voice — ready for variant design. */
  const charWithBase = {
    id: 'Marlow',
    name: 'Marlow',
    role: 'supporting',
    color: 'sky',
    voiceId: 'v_Marlow',
    voiceStyle: 'a charismatic, quick-witted young man, playful with an undercurrent of emotion',
    overrideTtsVoices: { qwen: { name: 'qwen-v_Marlow' } },
  };

  /* Seed a character that has NO base Qwen voice yet. */
  const charNoBase = {
    id: 'Maerin',
    name: 'Maerin',
    role: 'supporting',
    color: 'pink',
    voiceId: 'v_Maerin',
    voiceStyle: 'a graceful, perceptive young woman, polished but warm',
  };

  beforeEach(() => {
    /* Write a cast file with both variant-test characters (plus the standard
       set so the other tests keep working when they run in isolation). */
    writeBookOnDisk([...characters, charWithBase, charNoBase]);
  });

  it('scope:variants designs the requested emotion and persists the variant slot', async () => {
    const spy = vi.spyOn(qwenVoiceMod, 'designQwenVoiceForCharacter').mockResolvedValue({
      voiceId: 'qwen-v_Marlow__angry',
      url: '/voice-samples/qwen-v_Marlow__angry.mp3',
    });

    const res = await request(app)
      .post(`/api/books/${bookId}/cast/design`)
      .send({
        modelKey: QWEN_KEY,
        scope: 'variants',
        characterIds: [],
        variantTasks: [{ characterId: 'Marlow', emotions: ['angry'] }],
      });

    expect(res.status).toBe(200);
    const events = parseSse(res.text);
    const variantEvent = events.find((e) => e.type === 'variant_designed');
    expect(variantEvent).toBeDefined();
    expect(variantEvent).toMatchObject({ characterId: 'Marlow', emotion: 'angry' });

    const cast = readCast();
    const Marlow = cast.characters.find((c) => c.id === 'Marlow');
    expect(Marlow?.overrideTtsVoices?.qwen?.variants?.angry).toBeDefined();

    spy.mockRestore();
  });

  it('scope:variants skips a variant whose base voice is missing', async () => {
    const spy = vi.spyOn(qwenVoiceMod, 'designQwenVoiceForCharacter').mockResolvedValue({
      voiceId: 'qwen-v_Maerin__angry',
      url: '/voice-samples/qwen-v_Maerin__angry.mp3',
    });

    const res = await request(app)
      .post(`/api/books/${bookId}/cast/design`)
      .send({
        modelKey: QWEN_KEY,
        scope: 'variants',
        characterIds: [],
        variantTasks: [{ characterId: 'Maerin', emotions: ['angry'] }],
      });

    expect(res.status).toBe(200);
    const events = parseSse(res.text);
    expect(events.some((e) => e.type === 'character_skipped' && e.characterId === 'Maerin')).toBe(true);
    expect(events.some((e) => e.type === 'variant_designed')).toBe(false);
    expect(spy).not.toHaveBeenCalled();

    spy.mockRestore();
  });

  it('scope:both designs base then its variants in order for one character', async () => {
    /* Maerin has no base yet — scope:both should design the base first, then the variant. */
    const designedIds: string[] = [];
    const spy = vi.spyOn(qwenVoiceMod, 'designQwenVoiceForCharacter').mockImplementation(
      async (p) => {
        const id = p.emotion ? `qwen-v_Maerin__${p.emotion}` : 'qwen-v_Maerin';
        designedIds.push(id);
        /* Simulate a base voice being persisted so the variant skip-check passes. */
        if (!p.emotion) {
          /* Manually write the base into cast.json so the variant freshness check
             sees it (mirrors what applyOverrideToCastFiles would do). */
          const cast = readCast();
          const ch = cast.characters.find((c) => c.id === 'Maerin');
          if (ch) {
            ch.overrideTtsVoices = { ...(ch.overrideTtsVoices ?? {}), qwen: { name: 'qwen-v_Maerin' } };
            writeFileSync(
              join(bookDir, '.audiobook', 'cast.json'),
              JSON.stringify(cast),
            );
          }
        }
        return { voiceId: id, url: `/voice-samples/${id}.mp3` };
      },
    );

    const res = await request(app)
      .post(`/api/books/${bookId}/cast/design`)
      .send({
        modelKey: QWEN_KEY,
        scope: 'both',
        characterIds: ['Maerin'],
        variantTasks: [{ characterId: 'Maerin', emotions: ['whisper'] }],
      });

    expect(res.status).toBe(200);
    const events = parseSse(res.text);

    const baseIdx = events.findIndex((e) => e.type === 'character_designed' && e.characterId === 'Maerin');
    const variantIdx = events.findIndex((e) => e.type === 'variant_designed' && e.characterId === 'Maerin');
    expect(baseIdx).toBeGreaterThanOrEqual(0);
    expect(variantIdx).toBeGreaterThanOrEqual(0);
    expect(baseIdx).toBeLessThan(variantIdx);

    spy.mockRestore();
  });
});
