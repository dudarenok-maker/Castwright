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
const { personaMock, resolvePersonaEngineMock } = vi.hoisted(() => ({
  personaMock: vi.fn(),
  /* Default to 'gemini' so the pre-pass is a no-op for all the existing tests
     that have nothing to do with the local persona path. */
  resolvePersonaEngineMock: vi.fn().mockReturnValue('gemini'),
}));

vi.mock('../analyzer/voice-style.js', () => ({
  generateVoiceStylePersona: personaMock,
  resolvePersonaEngine: resolvePersonaEngineMock,
}));

/* Passthrough mock — persona-gpu-plan.preparePersonaBatch so the pre-pass
   doesn't try to reach a real sidecar or GPU during existing tests.  The
   resolvePersonaEngineMock defaults to 'gemini' so preparePersonaBatch is never
   reached in the existing tests anyway, but the mock is here as a safety net
   and is overridden per-test in the pre-pass describe block. */
vi.mock('../tts/persona-gpu-plan.js', () => ({
  preparePersonaBatch: vi.fn().mockResolvedValue({ onCpu: false, keepAlive: 0 }),
  resolvePersonaGpuPlan: vi.fn().mockReturnValue({ onCpu: false, evict: false, keepAlive: 0 }),
  unloadResidentSidecar: vi.fn().mockResolvedValue(undefined),
  GpuBusyForPersonaError: class GpuBusyForPersonaError extends Error {
    code = 'GPU_BUSY_FOR_PERSONA';
    constructor(m: string) { super(m); this.name = 'GpuBusyForPersonaError'; }
  },
}));

/* Passthrough mock — keeps withGpuLoad a no-op in tests so the unit boundary
   stays at the sidecar fetch and doesn't try to evict a real Ollama. */
vi.mock('../gpu/gpu-load.js', () => ({
  withGpuLoad: async (fn: () => Promise<unknown>) => fn(),
  GpuBusyError: class GpuBusyError extends Error {
    code = 'GPU_BUSY';
    constructor(m: string) { super(m); this.name = 'GpuBusyError'; }
  },
}));

const characters = [
  { id: 'narrator', name: 'Narrator', role: 'narrator', color: 'narrator' },
  {
    id: 'aria',
    name: 'Aria',
    role: 'supporting',
    color: 'lilac',
    voiceId: 'v_aria',
    /* srv-43: pre-seed voiceUuid so ensureCharacterVoiceUuid is idempotent and
       qwenStorageKey returns a deterministic key for test assertions. */
    voiceUuid: 'v_aria',
    voiceStyle: 'a poised, confident teenage girl, clear and warm',
    evidence: [{ quote: '”We have to tell the Council before the others wake.”' }],
  },
  {
    id: 'brann',
    name: 'Brann',
    role: 'supporting',
    color: 'teal',
    voiceId: 'v_brann',
    /* srv-43: pre-seed voiceUuid for deterministic storage key. */
    voiceUuid: 'v_brann',
    voiceStyle: 'a calm, assured young man, steady and warm',
    evidence: [{ quote: '”Trust me — we can do this together.”' }],
  },
  /* No persona → exercises the Gemini fallback. */
  /* srv-43: hart has no voiceId, so fallback id is 'hart' → voiceUuid 'hart'
     gives storage key qwen-hart, matching the assertion. */
  {
    id: 'hart',
    name: 'Hart',
    role: 'supporting',
    color: 'amber',
    voiceUuid: 'hart',
    evidence: [{ quote: '”I built it myself, you know.”' }],
  },
  /* Already designed → freshness-skip. */
  {
    id: 'wren',
    name: 'Wren',
    role: 'lead',
    color: 'rose',
    voiceId: 'v_wren',
    voiceStyle: 'a determined, earnest teenage girl',
    overrideTtsVoices: { qwen: { name: 'qwen-v_wren' } },
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
let ensureMod: typeof import('../tts/ensure-sidecar-loaded.js');
let MAX_RECYCLE_RIDEOUTS: number;

/* Turn VRAM sampling off so the new /health probe doesn't inflate fetch-mock call counts. */
beforeAll(() => { process.env.CASTWRIGHT_VRAM_SAMPLE = '0'; });
afterAll(() => { delete process.env.CASTWRIGHT_VRAM_SAMPLE; });

beforeAll(async () => {
  workspaceRoot = mkdtempSync(join(tmpdir(), 'audiobook-cast-design-test-'));
  audioDir = mkdtempSync(join(tmpdir(), 'audiobook-cast-design-audio-'));
  process.env.WORKSPACE_DIR = workspaceRoot;
  process.env.VOICE_SAMPLE_AUDIO_DIR = audioDir;
  vi.stubGlobal('fetch', fetchMock);

  const [castDesign, qwenVoice, { makeBookId }, lock, ensure] = await Promise.all([
    import('./cast-design.js'),
    import('./qwen-voice.js'),
    import('../workspace/paths.js'),
    import('../tts/design-lock.js'),
    import('../tts/ensure-sidecar-loaded.js'),
  ]);
  const { castDesignRouter } = castDesign;
  MAX_RECYCLE_RIDEOUTS = castDesign.MAX_RECYCLE_RIDEOUTS;
  qwenVoiceMod = qwenVoice;
  designLock = lock;
  ensureMod = ensure;
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
      .send({ characterIds: ['aria', 'brann'], modelKey: QWEN_KEY });

    expect(res.status).toBe(200);
    const events = parseSse(res.text);
    const designed = events.filter((e) => e.type === 'character_designed').map((e) => e.characterId);
    expect(designed).toEqual(['aria', 'brann']);
    const idle = events.find((e) => e.type === 'idle');
    expect(idle).toMatchObject({ done: 2, total: 2, skipped: 0 });
    expect(idle?.failures).toEqual([]);

    expect(charById('aria')?.overrideTtsVoices?.qwen?.name).toBe('qwen-v_aria');
    expect(charById('brann')?.overrideTtsVoices?.qwen?.name).toBe('qwen-v_brann');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('persona fallback: a persona-less character gets a Gemini persona persisted + designed', async () => {
    const res = await request(app)
      .post(`/api/books/${bookId}/cast/design`)
      .send({ characterIds: ['hart'], modelKey: QWEN_KEY });

    expect(res.status).toBe(200);
    expect(personaMock).toHaveBeenCalledTimes(1);
    expect(charById('hart')?.voiceStyle).toBe('a bright, quick-witted teenage boy');
    expect(charById('hart')?.overrideTtsVoices?.qwen?.name).toBe('qwen-hart');
  });

  it('freshness-skip: an already-designed character is skipped (no sidecar call)', async () => {
    const res = await request(app)
      .post(`/api/books/${bookId}/cast/design`)
      .send({ characterIds: ['wren'], modelKey: QWEN_KEY });

    const events = parseSse(res.text);
    expect(events.some((e) => e.type === 'character_skipped' && e.characterId === 'wren')).toBe(true);
    expect(events.some((e) => e.type === 'character_designed')).toBe(false);
    expect(events.find((e) => e.type === 'idle')).toMatchObject({ done: 0, skipped: 1 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('a per-character failure is recorded and the loop continues', async () => {
    fetchMock.mockReset();
    fetchMock.mockResolvedValueOnce(badSidecarResponse()); // aria fails
    fetchMock.mockResolvedValue(okSidecarResponse()); // brann ok

    const res = await request(app)
      .post(`/api/books/${bookId}/cast/design`)
      .send({ characterIds: ['aria', 'brann'], modelKey: QWEN_KEY });

    const events = parseSse(res.text);
    expect(events.some((e) => e.type === 'character_failed' && e.characterId === 'aria')).toBe(true);
    expect(events.some((e) => e.type === 'character_designed' && e.characterId === 'brann')).toBe(true);
    const idle = events.find((e) => e.type === 'idle');
    expect(idle).toMatchObject({ done: 1, total: 2 });
    expect(idle?.failures).toHaveLength(1);
    expect(charById('brann')?.overrideTtsVoices?.qwen?.name).toBe('qwen-v_brann');
  });

  it('rides out a mid-bulk sidecar recycle: waits for respawn, retries the character, and completes', async () => {
    /* A recycle (committed/VRAM ceiling) mid-bulk makes ONE design fail with an
       "unreachable" error while the supervisor respawns. The job must wait for
       the sidecar to come back (ensureSidecarEngineReady) and RETRY that
       character — NOT halt the whole run. This is the core robustness fix:
       bulk design survives the recycles it is statistically guaranteed to hit. */
    const ensureSpy = vi
      .spyOn(ensureMod, 'ensureSidecarEngineReady')
      .mockResolvedValue(undefined); // sidecar is back immediately
    const designSpy = vi
      .spyOn(qwenVoiceMod, 'designQwenVoiceForCharacter')
      .mockRejectedValueOnce(new Error('TTS sidecar (http://localhost:9000) is unreachable'))
      .mockResolvedValue({ voiceId: 'qwen-v_aria' } as Awaited<
        ReturnType<typeof qwenVoiceMod.designQwenVoiceForCharacter>
      >);

    const res = await request(app)
      .post(`/api/books/${bookId}/cast/design`)
      .send({ characterIds: ['aria'], modelKey: QWEN_KEY });

    expect(res.status).toBe(200);
    const events = parseSse(res.text);
    expect(events.find((e) => e.type === 'error')).toBeUndefined(); // NOT halted
    expect(events.some((e) => e.type === 'character_designed' && e.characterId === 'aria')).toBe(
      true,
    );
    expect(events.find((e) => e.type === 'idle')).toMatchObject({ done: 1, total: 1 });
    expect(ensureSpy).toHaveBeenCalled(); // rode out the respawn
    expect(designSpy).toHaveBeenCalledTimes(2); // initial failure + one retry

    ensureSpy.mockRestore();
    designSpy.mockRestore();
  });

  it('halts with sidecar_unavailable only after the ride-out retries are exhausted', async () => {
    /* If the sidecar never returns (genuinely dead, not a transient recycle),
       the job must still stop rather than grind forever — but only AFTER it has
       given the supervisor a bounded number of respawn-and-retry attempts. */
    const ensureSpy = vi
      .spyOn(ensureMod, 'ensureSidecarEngineReady')
      .mockResolvedValue(undefined);
    const designSpy = vi
      .spyOn(qwenVoiceMod, 'designQwenVoiceForCharacter')
      .mockRejectedValue(
        new Error(
          'TTS sidecar (http://localhost:9000) stopped responding to /health during voice design.',
        ),
      );

    const res = await request(app)
      .post(`/api/books/${bookId}/cast/design`)
      .send({ characterIds: ['aria', 'brann'], modelKey: QWEN_KEY });

    expect(res.status).toBe(200);
    const events = parseSse(res.text);
    const errorEvent = events.find((e) => e.type === 'error');
    expect(errorEvent?.code).toBe('sidecar_unavailable');
    expect(events.some((e) => e.type === 'character_designed')).toBe(false);
    /* One initial attempt + the bounded ride-out retries, then halt — and it
       gave up on the FIRST character (didn't grind through brann too). */
    expect(designSpy).toHaveBeenCalledTimes(1 + MAX_RECYCLE_RIDEOUTS);
    expect(ensureSpy).toHaveBeenCalledTimes(MAX_RECYCLE_RIDEOUTS);

    ensureSpy.mockRestore();
    designSpy.mockRestore();
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
    id: 'marlow',
    name: 'Marlow',
    role: 'supporting',
    color: 'sky',
    voiceId: 'v_marlow',
    voiceStyle: 'a charismatic, quick-witted young man, playful with an undercurrent of emotion',
    overrideTtsVoices: { qwen: { name: 'qwen-v_marlow' } },
  };

  /* Seed a character that has NO base Qwen voice yet. */
  const charNoBase = {
    id: 'maerin',
    name: 'Maerin',
    role: 'supporting',
    color: 'pink',
    voiceId: 'v_maerin',
    voiceStyle: 'a graceful, perceptive young woman, polished but warm',
  };

  beforeEach(() => {
    /* Write a cast file with both variant-test characters (plus the standard
       set so the other tests keep working when they run in isolation). */
    writeBookOnDisk([...characters, charWithBase, charNoBase]);
  });

  it('scope:variants designs the requested emotion and persists the variant slot', async () => {
    const spy = vi.spyOn(qwenVoiceMod, 'designQwenVoiceForCharacter').mockResolvedValue({
      voiceId: 'qwen-v_marlow__angry',
      url: '/voice-samples/qwen-v_marlow__angry.mp3',
    });

    const res = await request(app)
      .post(`/api/books/${bookId}/cast/design`)
      .send({
        modelKey: QWEN_KEY,
        scope: 'variants',
        characterIds: [],
        variantTasks: [{ characterId: 'marlow', emotions: ['angry'] }],
      });

    expect(res.status).toBe(200);
    const events = parseSse(res.text);
    const variantEvent = events.find((e) => e.type === 'variant_designed');
    expect(variantEvent).toBeDefined();
    expect(variantEvent).toMatchObject({ characterId: 'marlow', emotion: 'angry' });

    const cast = readCast();
    const marlow = cast.characters.find((c) => c.id === 'marlow');
    expect(marlow?.overrideTtsVoices?.qwen?.variants?.angry).toBeDefined();

    spy.mockRestore();
  });

  it('scope:variants skips a variant whose base voice is missing', async () => {
    const spy = vi.spyOn(qwenVoiceMod, 'designQwenVoiceForCharacter').mockResolvedValue({
      voiceId: 'qwen-v_maerin__angry',
      url: '/voice-samples/qwen-v_maerin__angry.mp3',
    });

    const res = await request(app)
      .post(`/api/books/${bookId}/cast/design`)
      .send({
        modelKey: QWEN_KEY,
        scope: 'variants',
        characterIds: [],
        variantTasks: [{ characterId: 'maerin', emotions: ['angry'] }],
      });

    expect(res.status).toBe(200);
    const events = parseSse(res.text);
    expect(events.some((e) => e.type === 'character_skipped' && e.characterId === 'maerin')).toBe(true);
    expect(events.some((e) => e.type === 'variant_designed')).toBe(false);
    expect(spy).not.toHaveBeenCalled();

    spy.mockRestore();
  });

  it('scope:both designs base then its variants in order for one character', async () => {
    /* maerin has no base yet — scope:both should design the base first, then the variant. */
    const designedIds: string[] = [];
    const spy = vi.spyOn(qwenVoiceMod, 'designQwenVoiceForCharacter').mockImplementation(
      async (p) => {
        const id = p.emotion ? `qwen-v_maerin__${p.emotion}` : 'qwen-v_maerin';
        designedIds.push(id);
        /* Simulate a base voice being persisted so the variant skip-check passes. */
        if (!p.emotion) {
          /* Manually write the base into cast.json so the variant freshness check
             sees it (mirrors what applyOverrideToCastFiles would do). */
          const cast = readCast();
          const ch = cast.characters.find((c) => c.id === 'maerin');
          if (ch) {
            ch.overrideTtsVoices = { ...(ch.overrideTtsVoices ?? {}), qwen: { name: 'qwen-v_maerin' } };
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
        characterIds: ['maerin'],
        variantTasks: [{ characterId: 'maerin', emotions: ['whisper'] }],
      });

    expect(res.status).toBe(200);
    const events = parseSse(res.text);

    const baseIdx = events.findIndex((e) => e.type === 'character_designed' && e.characterId === 'maerin');
    const variantIdx = events.findIndex((e) => e.type === 'variant_designed' && e.characterId === 'maerin');
    expect(baseIdx).toBeGreaterThanOrEqual(0);
    expect(variantIdx).toBeGreaterThanOrEqual(0);
    expect(baseIdx).toBeLessThan(variantIdx);

    spy.mockRestore();
  });
});

// ── Task 9: persona pre-pass ────────────────────────────────────────────────
describe('cast-design persona pre-pass', () => {
  /* Each test imports the modules under test dynamically so vi.spyOn can
     intercept the cross-module calls.  We reuse the shared `job`-construction
     infrastructure by driving the full HTTP POST but with all heavy dependencies
     mocked at the module level. */

  afterEach(() => {
    vi.restoreAllMocks();
    // Clear all mock call counts so spies in later tests don't inherit accumulated
    // history from the shared module-level vi.fn() mocks (vi.restoreAllMocks resets
    // implementations but not call counts; vi.clearAllMocks resets counts).
    vi.clearAllMocks();
    // Reset the hoisted mock return values to defaults so tests are fully isolated.
    resolvePersonaEngineMock.mockReturnValue('gemini');
    personaMock.mockReset();
    personaMock.mockResolvedValue('a bright, quick-witted teenage boy');
  });

  it('local: all personas generated before the first designQwenVoiceForCharacter; variants skipped', async () => {
    // Use the hoisted mock directly — avoids spy ordering issues between tests.
    resolvePersonaEngineMock.mockReturnValue('local');

    const plan = await import('../tts/persona-gpu-plan.js');
    vi.spyOn(plan, 'preparePersonaBatch').mockResolvedValue({ onCpu: false, keepAlive: '5m' });

    const vs = await import('../analyzer/voice-style.js');
    const callOrder: string[] = [];
    vi.spyOn(vs, 'generateVoiceStylePersona').mockImplementation(async (c: any) => {
      callOrder.push(`persona:${c.id}`);
      return 'A persona.';
    });

    const qwen = await import('./qwen-voice.js');
    vi.spyOn(qwen, 'designQwenVoiceForCharacter').mockImplementation(async (a: any) => {
      callOrder.push(`design:${a.characterId}`);
      return { voiceId: `qwen-${a.characterId}`, url: `/v/${a.characterId}.mp3` };
    });

    /* Two base tasks + one variant-only character.
       We send: aria (base, has voiceStyle → idempotent skip in pre-pass),
       hart (base, no voiceStyle → persona needed), and a variant task for aria
       (emotion: 'angry').  Scope 'both' produces tasks: [base:aria, base:hart,
       variant:aria@angry].  Pre-pass baseIds = ['aria','hart'].  aria already
       has voiceStyle → skipped in the pre-pass (idempotent).  hart has none →
       persona generated.  The design loop runs after. */
    const res = await request(app)
      .post(`/api/books/${bookId}/cast/design`)
      .send({
        modelKey: QWEN_KEY,
        scope: 'both',
        characterIds: ['aria', 'hart'],
        variantTasks: [{ characterId: 'aria', emotions: ['angry'] }],
      });

    expect(res.status).toBe(200);

    // preparePersonaBatch must have been called exactly once (one GPU decision for the whole batch)
    expect(plan.preparePersonaBatch).toHaveBeenCalledTimes(1);

    // hart (no voiceStyle) must have got a persona call; aria (has voiceStyle) must not
    expect(callOrder.filter((s) => s.startsWith('persona:'))).toContain('persona:hart');
    expect(callOrder.filter((s) => s.startsWith('persona:'))).not.toContain('persona:aria');

    // ALL persona calls must appear BEFORE the FIRST design call
    const firstDesignIdx = callOrder.findIndex((s) => s.startsWith('design:'));
    const lastPersonaIdx = [...callOrder].reverse().findIndex((s) => s.startsWith('persona:'));
    const lastPersonaPos = lastPersonaIdx === -1 ? -1 : callOrder.length - 1 - lastPersonaIdx;
    if (firstDesignIdx !== -1 && lastPersonaPos !== -1) {
      expect(lastPersonaPos).toBeLessThan(firstDesignIdx);
    }

    // variant-only task (aria@angry) must NOT trigger a pre-pass persona call
    // (pre-pass is base-tasks-only; variants are filtered out)
    expect(callOrder.filter((s) => s === 'persona:aria')).toHaveLength(0);
  });

  it('busy box: preparePersonaBatch returns CPU args, threaded into persona calls', async () => {
    resolvePersonaEngineMock.mockReturnValue('local');

    const plan = await import('../tts/persona-gpu-plan.js');
    vi.spyOn(plan, 'preparePersonaBatch').mockResolvedValue({ onCpu: true, keepAlive: 0 });

    const vs = await import('../analyzer/voice-style.js');
    const genSpy = vi.spyOn(vs, 'generateVoiceStylePersona').mockResolvedValue('A persona.');

    const qwen = await import('./qwen-voice.js');
    vi.spyOn(qwen, 'designQwenVoiceForCharacter').mockResolvedValue({
      voiceId: 'qwen-hart',
      url: '/v/hart.mp3',
    });

    /* hart has no voiceStyle, so it gets a persona call; the CPU args must be forwarded. */
    const res = await request(app)
      .post(`/api/books/${bookId}/cast/design`)
      .send({ modelKey: QWEN_KEY, characterIds: ['hart'] });

    expect(res.status).toBe(200);

    // generateVoiceStylePersona must have been called with the CPU plan args from preparePersonaBatch
    expect(genSpy).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'hart' }),
      { onCpu: true, keepAlive: 0 },
    );

    // design must still run (pre-pass does not abort the design)
    const events = parseSse(res.text);
    expect(events.some((e) => e.type === 'character_designed' && e.characterId === 'hart')).toBe(true);
  });

  it('gemini engine: pre-pass returns early — preparePersonaBatch NOT called', async () => {
    // resolvePersonaEngineMock is already reset to 'gemini' by afterEach; make it explicit.
    resolvePersonaEngineMock.mockReturnValue('gemini');

    const plan = await import('../tts/persona-gpu-plan.js');
    // Wrap the module-level mock in a fresh spy so we can count calls in THIS test only.
    const prepSpy = vi.spyOn(plan, 'preparePersonaBatch').mockResolvedValue({ onCpu: false, keepAlive: 0 });

    const qwen = await import('./qwen-voice.js');
    vi.spyOn(qwen, 'designQwenVoiceForCharacter').mockResolvedValue({
      voiceId: 'qwen-v_aria',
      url: '/v/aria.mp3',
    });

    const res = await request(app)
      .post(`/api/books/${bookId}/cast/design`)
      .send({ modelKey: QWEN_KEY, characterIds: ['aria'] });

    expect(res.status).toBe(200);
    // resolvePersonaEngine returns 'gemini' → pre-pass returns immediately.
    // preparePersonaBatch must NOT have been called at all by the pre-pass.
    expect(prepSpy).not.toHaveBeenCalled();
    // resolvePersonaEngineMock must have been called (confirms the guard ran)
    expect(resolvePersonaEngineMock).toHaveBeenCalled();
  });

  it('heartbeat is emitted during pre-pass before the first character_designed event', async () => {
    /* Verify the setInterval inside runPersonaPrePass fires a { type: 'heartbeat' }
       event before any design work begins.

       Strategy: hold generateVoiceStylePersona pending behind a deferred promise so
       the pre-pass is "stuck" while we advance fake timers past PERSONA_HEARTBEAT_MS
       (6 000 ms), then release the promise and let the run complete.  We capture
       all SSE events from the response body and assert the heartbeat appears before
       the first character_designed event.

       supertest buffers the full SSE body after res.end(), so we need the run to
       complete before asserting order.  The sequence is:
         1. POST starts, pre-pass begins, persona promise pends.
         2. We advance fake timers by 6 000 ms → heartbeat fires.
         3. Release the persona promise → pre-pass finishes → design loop runs →
            character_designed fires → idle → response ends.
       Because supertest awaits the full response, we interleave step 2 inside
       the persona mock (the mock is called during the await of the POST, so we
       advance timers from within the mock implementation). */
    resolvePersonaEngineMock.mockReturnValue('local');

    const plan = await import('../tts/persona-gpu-plan.js');
    vi.spyOn(plan, 'preparePersonaBatch').mockResolvedValue({ onCpu: false, keepAlive: '5m' });

    vi.useFakeTimers();

    const vs = await import('../analyzer/voice-style.js');
    vi.spyOn(vs, 'generateVoiceStylePersona').mockImplementation(async () => {
      // Advance timers past PERSONA_HEARTBEAT_MS while the pre-pass is mid-flight.
      await vi.advanceTimersByTimeAsync(7000);
      return 'A persona.';
    });

    const qwen = await import('./qwen-voice.js');
    vi.spyOn(qwen, 'designQwenVoiceForCharacter').mockResolvedValue({
      voiceId: 'qwen-hart',
      url: '/v/hart.mp3',
    });

    // Run with hart (no voiceStyle → triggers pre-pass persona call).
    const res = await request(app)
      .post(`/api/books/${bookId}/cast/design`)
      .send({ modelKey: QWEN_KEY, characterIds: ['hart'] });

    vi.useRealTimers();

    expect(res.status).toBe(200);
    const events = parseSse(res.text);

    // There must be at least one heartbeat event.
    const heartbeatIdx = events.findIndex((e) => e.type === 'heartbeat');
    expect(heartbeatIdx).toBeGreaterThanOrEqual(0);

    // The heartbeat must come BEFORE the first character_designed event.
    const designedIdx = events.findIndex((e) => e.type === 'character_designed');
    expect(designedIdx).toBeGreaterThanOrEqual(0);
    expect(heartbeatIdx).toBeLessThan(designedIdx);
  });

  it('abort mid-pre-pass (signal.aborted) stops the loop before designQwenVoiceForCharacter runs', async () => {
    /* Verify the `if (job.controller.signal.aborted) return;` guard at the top of
       the per-character loop in runPersonaPrePass.

       The AbortController lives on the internal DesignJob which is unreachable from
       test code directly.  We trigger the abort by hitting the pause endpoint from
       inside the generateVoiceStylePersona mock — the mock is called while the HTTP
       request is still in flight (supertest hasn't received res.end() yet), and the
       pause endpoint calls job.controller.abort() synchronously.  After the mock
       returns, the pre-pass loop checks signal.aborted and exits — so
       designQwenVoiceForCharacter must never be called. */
    resolvePersonaEngineMock.mockReturnValue('local');

    const plan = await import('../tts/persona-gpu-plan.js');
    vi.spyOn(plan, 'preparePersonaBatch').mockResolvedValue({ onCpu: false, keepAlive: '5m' });

    const vs = await import('../analyzer/voice-style.js');
    vi.spyOn(vs, 'generateVoiceStylePersona').mockImplementation(async () => {
      // Abort the running job via the pause endpoint while we are inside the pre-pass.
      await request(app).post(`/api/books/${bookId}/cast/design/pause`).send({});
      return 'A persona.';
    });

    const qwen = await import('./qwen-voice.js');
    const designSpy = vi.spyOn(qwen, 'designQwenVoiceForCharacter').mockResolvedValue({
      voiceId: 'qwen-hart',
      url: '/v/hart.mp3',
    });

    // Use two persona-less characters so there is a second iteration that would
    // run IF the abort guard were missing.
    const extraChar2 = { id: 'orin', name: 'Orin', role: 'supporting', color: 'green', voiceUuid: 'orin' };
    writeBookOnDisk([...characters, extraChar2]);

    const res = await request(app)
      .post(`/api/books/${bookId}/cast/design`)
      .send({ modelKey: QWEN_KEY, characterIds: ['hart', 'orin'] });

    expect(res.status).toBe(200);

    // The design loop must never have been entered.
    expect(designSpy).not.toHaveBeenCalled();

    const events = parseSse(res.text);
    // The job should end (idle or error) — not hang.
    expect(events.some((e) => e.type === 'idle' || e.type === 'error')).toBe(true);

    // Restore cast.json for subsequent tests.
    writeBookOnDisk(characters);
  });

  it('I1/I2 skip guard: LOCAL pre-pass failure does NOT retry in design loop (no un-evicted OOM call)', async () => {
    /* Locks the OOM seam (plan-108): when the pre-pass's generateVoiceStylePersona
       throws a non-LocalUnreachableError for character A (e.g. empty persona), the
       design loop must NOT call generateVoiceStylePersona or designQwenVoiceForCharacter
       for A a second time.  Character B (whose pre-pass succeeds) must still be designed.

       Assertions:
         - generateVoiceStylePersona called ONCE total (pre-pass only for A; B has a
           voiceStyle so the pre-pass skips it idempotently — total = 1 call for A).
         - designQwenVoiceForCharacter NOT called for A (skip guard prevents the retry).
         - designQwenVoiceForCharacter IS called for B (the healthy path is unaffected). */
    resolvePersonaEngineMock.mockReturnValue('local');

    const plan = await import('../tts/persona-gpu-plan.js');
    vi.spyOn(plan, 'preparePersonaBatch').mockResolvedValue({ onCpu: false, keepAlive: '5m' });

    // hart (no voiceStyle) will be character A — pre-pass throws a transient error.
    // aria (has voiceStyle) will be character B — pre-pass skips (idempotent), design runs.
    const vs = await import('../analyzer/voice-style.js');
    vi.spyOn(vs, 'generateVoiceStylePersona').mockImplementation(async (c: any) => {
      if (c.id === 'hart') throw new Error('empty persona'); // non-LocalUnreachableError
      return 'A persona.'; // should never be called for aria (has voiceStyle)
    });

    const qwen = await import('./qwen-voice.js');
    const designSpy = vi.spyOn(qwen, 'designQwenVoiceForCharacter').mockResolvedValue({
      voiceId: 'qwen-v_aria',
      url: '/v/aria.mp3',
    });

    const res = await request(app)
      .post(`/api/books/${bookId}/cast/design`)
      .send({ modelKey: QWEN_KEY, characterIds: ['hart', 'aria'] });

    expect(res.status).toBe(200);

    // generateVoiceStylePersona must have been called exactly ONCE (for hart in pre-pass only).
    // The design loop must NOT retry hart — that would be the OOM call.
    const personaCalls = (vs.generateVoiceStylePersona as ReturnType<typeof vi.fn>).mock.calls;
    expect(personaCalls).toHaveLength(1);
    expect((personaCalls[0][0] as any).id).toBe('hart');

    // designQwenVoiceForCharacter must NOT have been called for hart (skipped by guard).
    const designCalls = designSpy.mock.calls;
    const hartDesign = designCalls.filter((c) => (c[0] as any).characterId === 'hart');
    expect(hartDesign).toHaveLength(0);

    // designQwenVoiceForCharacter MUST have been called for aria (healthy path unaffected).
    const ariaDesign = designCalls.filter((c) => (c[0] as any).characterId === 'aria');
    expect(ariaDesign.length).toBeGreaterThanOrEqual(1);

    const events = parseSse(res.text);
    // hart must appear in failures (recorded by the pre-pass), aria must be designed.
    const idle = events.find((e) => e.type === 'idle');
    expect(idle?.failures?.some((f: any) => f.characterId === 'hart')).toBe(true);
    expect(events.some((e) => e.type === 'character_designed' && e.characterId === 'aria')).toBe(true);
  });

  it('LocalUnreachableError in pre-pass propagates and stops designs; heartbeat interval is cleared', async () => {
    /* This test covers two contracts from the brief:
       1. A LocalUnreachableError in generateVoiceStylePersona propagates wholesale
          (the job ends with an error event, no character_designed fires).
       2. By implication the finally{clearInterval(beat)} guard runs (no leaked
          timer — we can't directly assert that, but the test exercises the path). */
    resolvePersonaEngineMock.mockReturnValue('local');

    const plan = await import('../tts/persona-gpu-plan.js');
    vi.spyOn(plan, 'preparePersonaBatch').mockResolvedValue({ onCpu: false, keepAlive: '5m' });

    const vs = await import('../analyzer/voice-style.js');
    const { LocalUnreachableError } = await import('../analyzer/ollama.js');
    vi.spyOn(vs, 'generateVoiceStylePersona').mockRejectedValue(
      new LocalUnreachableError('Ollama is down'),
    );

    const qwen = await import('./qwen-voice.js');
    const designSpy = vi.spyOn(qwen, 'designQwenVoiceForCharacter').mockResolvedValue({
      voiceId: 'qwen-hart',
      url: '/v/hart.mp3',
    });

    // Use two persona-less characters to ensure a real pre-pass runs.
    const extraChar = { id: 'nova', name: 'Nova', role: 'supporting', color: 'blue', voiceUuid: 'nova' };
    writeBookOnDisk([...characters, extraChar]);

    const res = await request(app)
      .post(`/api/books/${bookId}/cast/design`)
      .send({ modelKey: QWEN_KEY, characterIds: ['hart', 'nova'] });

    expect(res.status).toBe(200);
    const events = parseSse(res.text);

    // LocalUnreachableError must propagate → the job ends with an error event.
    const errorEvent = events.find((e) => e.type === 'error');
    expect(errorEvent).toBeDefined();

    // No design must have run (the pre-pass threw before the design loop could start).
    expect(designSpy).not.toHaveBeenCalled();

    // Restore the cast.json for subsequent tests.
    writeBookOnDisk(characters);
  });
});
