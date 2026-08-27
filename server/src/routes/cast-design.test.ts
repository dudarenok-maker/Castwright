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

/* Some calls this suite exercises moved to undici's fetch (they need a
   dispatcher so a legitimate multi-minute wait isn't cut off at undici's
   hidden 300s headersTimeout — see DERIVE_DISPATCHER / DESIGN_DISPATCHER),
   while others legitimately stay on the global one. Delegating undici's fetch
   to whatever this file stubs globally keeps every existing mock and
   assertion working across both transports, with no per-test changes. */
vi.mock('undici', async (importOriginal) => {
  const actual = await importOriginal<typeof import('undici')>();
  return {
    ...actual,
    fetch: (...args: unknown[]) =>
      (globalThis.fetch as unknown as (...a: unknown[]) => unknown)(...args),
  };
});


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
  /* GATE 2 fix-lane-1b — cloned on coqui, no qwen slot at all: the exact
     shape a bulk qwen design sweep must skip rather than retarget. */
  {
    id: 'zara',
    name: 'Zara',
    role: 'supporting',
    color: 'gold',
    voiceId: 'v_zara',
    voiceStyle: 'a sly, low-voiced smuggler',
    ttsEngine: 'coqui',
    overrideTtsVoices: {
      coqui: { name: 'xtts-zara-uuid', libraryUuid: 'zara-uuid', provenance: 'cloned' },
    },
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
  /* #1720 Task 7 — postDesignAndCache now routes its fetch through
     withCapacityRetry, which calls `.clone()` on any non-ok response to peek
     at the body before deciding whether it's a noCapacity 503 (this one is a
     plain 500, so parseNoCapacity bails on the status check without reading
     the clone further). A real Response has `.clone()`; this fixture is a
     plain object standing in for one, so it needs its own — returning the
     same fake is sufficient since nothing reads the clone's body here. */
  const response = {
    ok: false,
    status: 500,
    statusText: 'Internal Server Error',
    headers: new Headers(),
    arrayBuffer: async () => new ArrayBuffer(0),
    json: async () => ({ detail: 'model exploded' }),
  };
  return Object.assign(response, { clone: () => response });
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
  /* #1981 fix-round sweep — restoration MUST NOT depend on a test reaching
     its own last statement. Several tests below spy on
     ensureSidecarEngineReady / designQwenVoiceForCharacter and restored via
     a trailing `spy.mockRestore()` with nothing covering an earlier
     assertion throw; that leaves the spy live for every later test in the
     file. Same shape and same fix as cast-lock.test.ts's #1981 fix round
     Finding 1. */
  vi.restoreAllMocks();
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

  it('bug #1411 code-review follow-up: caches a voiceId-less character\'s sample under the book-scoped scope', async () => {
    /* narrator has no voiceId, so its sample-cache scope must match
       sample-scope.ts's / voices.ts's book-scoped fallback (`char-<bookId>__<id>`)
       — otherwise the Voices Library's aggregateVoices check (which uses that
       same book-scoped scope) never finds the file this design just cached,
       and shows "Not sampled" for a voice that was just designed. */
    const res = await request(app)
      .post(`/api/books/${bookId}/cast/design`)
      .send({ characterIds: ['narrator'], modelKey: QWEN_KEY });

    expect(res.status).toBe(200);
    const events = parseSse(res.text);
    expect(events.some((e) => e.type === 'character_designed' && e.characterId === 'narrator')).toBe(
      true,
    );
    const files = readdirSync(audioDir);
    expect(files.some((f) => f.startsWith(`char-${bookId}__narrator-${QWEN_KEY}-`))).toBe(true);
    expect(files.some((f) => f.startsWith(`char-narrator-${QWEN_KEY}-`))).toBe(false);
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

  /* GATE 2 fix-lane-1b — a bulk qwen design sweep must skip (not retarget) a
     character already cloned on coqui: applyOverrideToCastFiles pins
     ttsEngine = 'qwen' unconditionally, which would otherwise silently
     route the character off its coqui clone while the clone marker stays
     intact on disk. */
  it('GATE 2 fix-lane-1b: skips a coqui-cloned character instead of retargeting it, and reports it', async () => {
    const res = await request(app)
      .post(`/api/books/${bookId}/cast/design`)
      .send({ characterIds: ['zara', 'aria'], modelKey: QWEN_KEY });

    expect(res.status).toBe(200);
    const events = parseSse(res.text);
    expect(events.some((e) => e.type === 'character_designed' && e.characterId === 'zara')).toBe(false);
    expect(
      events.some(
        (e) =>
          e.type === 'character_skipped' &&
          e.characterId === 'zara' &&
          e.reason === 'already_cloned' &&
          e.name === 'Zara',
      ),
    ).toBe(true);
    // Only the untouched character was designed — the sidecar call count proves
    // the sweep never even attempted zara.
    expect(events.some((e) => e.type === 'character_designed' && e.characterId === 'aria')).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const idle = events.find((e) => e.type === 'idle');
    expect(idle).toMatchObject({ done: 1, total: 2, skipped: 1 });
    expect(idle?.clonedSkips).toEqual([{ characterId: 'zara', name: 'Zara' }]);

    /* The actual defect: `ttsEngine` must be UNCHANGED, not merely that the
       coqui slot survived (slot survival alone is what the bug already
       produced, so asserting only that would be a placebo). */
    const zara = charById('zara');
    expect(zara?.ttsEngine).toBe('coqui');
    expect(zara?.overrideTtsVoices?.coqui).toEqual({
      name: 'xtts-zara-uuid',
      libraryUuid: 'zara-uuid',
      provenance: 'cloned',
    });
    expect(zara?.overrideTtsVoices?.qwen).toBeUndefined();
  });

  describe('base-voice path: series-wide clone veto (#2006 Task 4)', () => {
    const SIBLING_BOOK = 'The Salt Line';
    let siblingBookDir: string;

    function writeSiblingBookOnDisk(chars: object[]) {
      siblingBookDir = join(workspaceRoot, 'books', AUTHOR, SERIES, SIBLING_BOOK);
      mkdirSync(join(siblingBookDir, '.audiobook'), { recursive: true });
      writeFileSync(
        join(siblingBookDir, '.audiobook', 'state.json'),
        JSON.stringify({
          bookId: `sibling_${bookId}`,
          manuscriptId: `m_sibling_${bookId}`,
          title: SIBLING_BOOK,
          author: AUTHOR,
          series: SERIES,
          seriesPosition: 2,
          isStandalone: false,
          manuscriptFile: 'manuscript.txt',
          castConfirmed: true,
          chapters: [],
          coverGradient: ['#000', '#fff'],
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        }),
      );
      writeFileSync(join(siblingBookDir, 'manuscript.txt'), 'placeholder');
      writeFileSync(join(siblingBookDir, '.audiobook', 'cast.json'), JSON.stringify({ characters: chars }));
    }

    beforeEach(() => {
      writeBookOnDisk([
        ...characters,
        {
          id: 'linked',
          name: 'Linked',
          role: 'supporting',
          color: 'blue',
          voiceId: 'v_linked',
          voiceUuid: 'v_linked',
          voiceStyle: 'a measured, patient older man',
          evidence: [{ quote: '”We wait for the tide.”' }],
        },
      ]);
      writeSiblingBookOnDisk([
        {
          id: 'linked-sibling',
          name: 'Linked Sibling',
          voiceId: 'v_linked',
          ttsEngine: 'coqui',
          overrideTtsVoices: {
            coqui: { name: 'xtts-linked-uuid', libraryUuid: 'linked-uuid', provenance: 'cloned' },
          },
        },
      ]);
    });

    afterEach(() => {
      if (siblingBookDir) rmSync(siblingBookDir, { recursive: true, force: true });
    });

    it('a series-wide clone (sibling book) is reported through clonedSkips instead of silently "designed"', async () => {
      const res = await request(app)
        .post(`/api/books/${bookId}/cast/design`)
        .send({ characterIds: ['linked'], modelKey: QWEN_KEY });

      expect(res.status).toBe(200);
      const events = parseSse(res.text);
      expect(events.some((e) => e.type === 'character_designed' && e.characterId === 'linked')).toBe(
        false,
      );
      expect(
        events.some(
          (e) =>
            e.type === 'character_skipped' &&
            e.characterId === 'linked' &&
            e.reason === 'already_cloned',
        ),
      ).toBe(true);
      const idle = events.find((e) => e.type === 'idle');
      expect(idle?.clonedSkips).toContainEqual({ characterId: 'linked', name: 'Linked' });
      expect(charById('linked')?.overrideTtsVoices?.qwen).toBeUndefined();
    });

    it('upfront: a series-wide clone (sibling book) is reported before any sidecar call, not after', async () => {
      const res = await request(app)
        .post(`/api/books/${bookId}/cast/design`)
        .send({ characterIds: ['linked'], modelKey: QWEN_KEY });

      expect(res.status).toBe(200);
      const events = parseSse(res.text);
      expect(
        events.some(
          (e) =>
            e.type === 'character_skipped' &&
            e.characterId === 'linked' &&
            e.reason === 'already_cloned',
        ),
      ).toBe(true);
      expect(fetchMock).not.toHaveBeenCalled();
    });
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
  });

  it('rides out the recycling drain-fence message too (widened SIDECAR_DOWN_RE)', async () => {
    /* Pre-existing gap found during spec review: "Voice engine is recycling to
       free memory; retry shortly." never matched the old SIDECAR_DOWN_RE, so
       this transient case was ALSO wrongly treated as an ordinary per-character
       failure before this fix. */
    const ensureSpy = vi
      .spyOn(ensureMod, 'ensureSidecarEngineReady')
      .mockResolvedValue(undefined);
    vi.spyOn(qwenVoiceMod, 'designQwenVoiceForCharacter')
      .mockRejectedValueOnce(new Error('Voice engine is recycling to free memory; retry shortly.'))
      .mockResolvedValue({ voiceId: 'qwen-v_aria' } as Awaited<
        ReturnType<typeof qwenVoiceMod.designQwenVoiceForCharacter>
      >);

    const res = await request(app)
      .post(`/api/books/${bookId}/cast/design`)
      .send({ characterIds: ['aria'], modelKey: QWEN_KEY });

    const events = parseSse(res.text);
    expect(events.find((e) => e.type === 'error')).toBeUndefined();
    expect(events.find((e) => e.type === 'idle')).toMatchObject({ done: 1, total: 1 });
    expect(ensureSpy).toHaveBeenCalled();
  });

  it('rides out a gpu_poisoned sidecar response via the health-poll wait, then completes', async () => {
    const ensureSpy = vi
      .spyOn(ensureMod, 'ensureSidecarEngineReady')
      .mockResolvedValue(undefined); // sidecar reports ready again
    const designSpy = vi
      .spyOn(qwenVoiceMod, 'designQwenVoiceForCharacter')
      .mockRejectedValueOnce(
        Object.assign(new Error('GPU is out of memory — likely another job is using it.'), {
          code: 'gpu_poisoned',
          status: 503,
        }),
      )
      .mockResolvedValue({ voiceId: 'qwen-v_aria' } as Awaited<
        ReturnType<typeof qwenVoiceMod.designQwenVoiceForCharacter>
      >);

    const res = await request(app)
      .post(`/api/books/${bookId}/cast/design`)
      .send({ characterIds: ['aria'], modelKey: QWEN_KEY });

    const events = parseSse(res.text);
    expect(events.find((e) => e.type === 'error')).toBeUndefined();
    expect(events.find((e) => e.type === 'idle')).toMatchObject({ done: 1, total: 1 });
    expect(ensureSpy).toHaveBeenCalled(); // used the health-poll wait, not a raw sleep
    expect(designSpy).toHaveBeenCalledTimes(2);
  });

  it('halts with gpu_contention (not sidecar_unavailable) after a GPU_BUSY ride-out is exhausted', async () => {
    const ensureSpy = vi.spyOn(ensureMod, 'ensureSidecarEngineReady');
    const designSpy = vi
      .spyOn(qwenVoiceMod, 'designQwenVoiceForCharacter')
      .mockRejectedValue(
        Object.assign(new Error('GPU busy with analysis — try again once it finishes.'), {
          code: 'GPU_BUSY',
        }),
      );

    const res = await request(app)
      .post(`/api/books/${bookId}/cast/design`)
      .send({ characterIds: ['aria', 'brann'], modelKey: QWEN_KEY });

    const events = parseSse(res.text);
    const errorEvent = events.find((e) => e.type === 'error');
    expect(errorEvent?.code).toBe('gpu_contention');
    expect(errorEvent?.message).toContain('0 of 2 designed');
    expect(events.some((e) => e.type === 'character_designed')).toBe(false);
    expect(designSpy).toHaveBeenCalledTimes(1 + MAX_RECYCLE_RIDEOUTS);
    /* GPU_BUSY uses the new bounded sleep, NOT the sidecar health-poll wait —
       ensureSidecarEngineReady must never be called for this class. */
    expect(ensureSpy).not.toHaveBeenCalled();
  }, 10_000);

  it('base17-unavailable is NOT treated as systemic — records a per-character failure and continues', async () => {
    const ensureSpy = vi.spyOn(ensureMod, 'ensureSidecarEngineReady');
    const designSpy = vi
      .spyOn(qwenVoiceMod, 'designQwenVoiceForCharacter')
      .mockRejectedValueOnce(
        Object.assign(new Error("Qwen 1.7B-Base unavailable (not-installed)."), {
          code: 'base17-unavailable',
          status: 503,
        }),
      )
      .mockResolvedValue({ voiceId: 'qwen-v_brann' } as Awaited<
        ReturnType<typeof qwenVoiceMod.designQwenVoiceForCharacter>
      >);

    const res = await request(app)
      .post(`/api/books/${bookId}/cast/design`)
      .send({ characterIds: ['aria', 'brann'], modelKey: QWEN_KEY });

    const events = parseSse(res.text);
    expect(events.find((e) => e.type === 'error')).toBeUndefined();
    expect(events.some((e) => e.type === 'character_failed' && e.characterId === 'aria')).toBe(true);
    expect(events.some((e) => e.type === 'character_designed' && e.characterId === 'brann')).toBe(true);
    /* No ride-out attempted for a permanent condition. */
    expect(designSpy).toHaveBeenCalledTimes(2); // one failed attempt (aria) + one success (brann)
    expect(ensureSpy).not.toHaveBeenCalled();
  });

  it('regression: a non-abort error during the sidecar-restart wait retries instead of silently dropping the character', async () => {
    /* Bug found during spec review: the OLD code's `catch { break }` around
       ensureSidecarEngineReady treated ANY thrown error there as a clean
       pause and silently exited without recording done/skipped/failures.
       ensureSidecarEngineReady wraps withGpuLoad, which CAN throw
       GpuBusyError (analysis contention) during the wait itself — that must
       NOT be treated as a run-level abort. */
    vi.spyOn(ensureMod, 'ensureSidecarEngineReady')
      .mockRejectedValueOnce(
        Object.assign(new Error('GPU busy with analysis — try again once it finishes.'), {
          code: 'GPU_BUSY',
        }),
      )
      .mockResolvedValue(undefined); // second ride-out's wait succeeds
    vi.spyOn(qwenVoiceMod, 'designQwenVoiceForCharacter')
      .mockRejectedValueOnce(new Error('TTS sidecar (http://localhost:9000) is unreachable'))
      .mockResolvedValue({ voiceId: 'qwen-v_aria' } as Awaited<
        ReturnType<typeof qwenVoiceMod.designQwenVoiceForCharacter>
      >);

    const res = await request(app)
      .post(`/api/books/${bookId}/cast/design`)
      .send({ characterIds: ['aria'], modelKey: QWEN_KEY });

    const events = parseSse(res.text);
    const idle = events.find((e) => e.type === 'idle');
    /* The character must be accounted for — either designed here (this test's
       retry path succeeds) or, at minimum, never silently vanish from
       done+skipped+failures. */
    expect(idle).toBeDefined();
    expect((idle!.done as number) + (idle!.skipped as number) + (idle!.failures as unknown[]).length).toBe(1);
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

  /* #1954 — CLONED on qwen. The slot carries a `name`, so the variant branch's
     only pre-existing gate (`overrideTtsVoices?.qwen?.name` present) reads
     "base is designed, go ahead" — which is exactly how a cloned character
     reached the wrong-anchor mint. */
  const charClonedOnQwen = {
    id: 'lyra',
    name: 'Lyra',
    role: 'lead',
    color: 'rose',
    voiceId: 'v_lyra',
    voiceUuid: 'v_lyra',
    voiceStyle: 'a warm, low-voiced woman',
    ttsEngine: 'qwen',
    overrideTtsVoices: {
      qwen: { name: 'qwen-lyra-lib-uuid', libraryUuid: 'lyra-lib-uuid', provenance: 'cloned' },
    },
  };

  beforeEach(() => {
    /* Write a cast file with both variant-test characters (plus the standard
       set so the other tests keep working when they run in isolation). */
    writeBookOnDisk([...characters, charWithBase, charNoBase, charClonedOnQwen]);
  });

  /* #1954 — the variant branch gets the same clone gate the base branch has
     had since GATE 2 fix-lane-1b, and reports through the same `clonedSkips`
     channel the UI already renders ("already cloned: …"). */
  it('#1954: scope:variants skips a CLONED character instead of minting a mis-anchored variant', async () => {
    const spy = vi.spyOn(qwenVoiceMod, 'designQwenVoiceForCharacter').mockResolvedValue({
      voiceId: 'qwen-v_lyra__angry',
      url: '/voice-samples/qwen-v_lyra__angry.mp3',
    });

    const res = await request(app)
      .post(`/api/books/${bookId}/cast/design`)
      .send({
        modelKey: QWEN_KEY,
        scope: 'variants',
        characterIds: [],
        variantTasks: [
          { characterId: 'lyra', emotions: ['angry'] },
          { characterId: 'marlow', emotions: ['angry'] },
        ],
      });

    expect(res.status).toBe(200);
    const events = parseSse(res.text);

    expect(
      events.some(
        (e) =>
          e.type === 'character_skipped' &&
          e.characterId === 'lyra' &&
          e.reason === 'already_cloned' &&
          e.name === 'Lyra',
      ),
    ).toBe(true);
    expect(events.some((e) => e.type === 'variant_designed' && e.characterId === 'lyra')).toBe(false);

    /* One cloned character must not block the rest of the sweep — the same
       "skip and report, don't refuse the whole run" call the base branch makes. */
    expect(events.some((e) => e.type === 'variant_designed' && e.characterId === 'marlow')).toBe(true);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][0].characterId).toBe('marlow');

    const idle = events.find((e) => e.type === 'idle');
    expect(idle).toMatchObject({ done: 1, total: 2, skipped: 1 });
    expect(idle?.clonedSkips).toEqual([{ characterId: 'lyra', name: 'Lyra' }]);

    /* THE defect, not a proxy for it: no variant slot was written onto the
       clone. Pre-fix this held `{ name: 'qwen-v_lyra__angry' }` — a key the
       render path (which resolves a cloned qwen slot to `qwen-<libraryUuid>`)
       never looks up. */
    const lyra = readCast().characters.find((c) => c.id === 'lyra');
    expect(lyra?.overrideTtsVoices?.qwen).toEqual({
      name: 'qwen-lyra-lib-uuid',
      libraryUuid: 'lyra-lib-uuid',
      provenance: 'cloned',
    });
  });

  it('scope:variants designs the requested emotion and persists the variant slot', async () => {
    vi.spyOn(qwenVoiceMod, 'designQwenVoiceForCharacter').mockResolvedValue({
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
  });

  it('marks variant_designed viaFallback when the mint fell back', async () => {
    vi.spyOn(qwenVoiceMod, 'designQwenVoiceForCharacter').mockResolvedValue({
      voiceId: 'qwen-v_marlow__angry',
      url: '/u',
      fellBackToDesignVoice: true,
      fallbackReason: 'not-installed',
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
    const ev = events.find((e) => e.type === 'variant_designed');
    expect(ev).toBeDefined();
    expect(ev).toMatchObject({ viaFallback: true, fallbackReason: 'not-installed' });
  });

  it('variant_designed without fallback does NOT include viaFallback/fallbackReason fields', async () => {
    vi.spyOn(qwenVoiceMod, 'designQwenVoiceForCharacter').mockResolvedValue({
      voiceId: 'qwen-v_marlow__angry',
      url: '/u',
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
    const ev = events.find((e) => e.type === 'variant_designed');
    expect(ev).toBeDefined();
    expect(ev).not.toHaveProperty('viaFallback');
    expect(ev).not.toHaveProperty('fallbackReason');
  });

  describe('variant path: series-wide clone veto (#2006 Task 8)', () => {
    const SIBLING_BOOK = 'The Salt Line';
    let siblingBookDir: string;

    function writeVariantSiblingBookOnDisk(chars: object[]) {
      siblingBookDir = join(workspaceRoot, 'books', AUTHOR, SERIES, SIBLING_BOOK);
      mkdirSync(join(siblingBookDir, '.audiobook'), { recursive: true });
      writeFileSync(
        join(siblingBookDir, '.audiobook', 'state.json'),
        JSON.stringify({
          bookId: `sibling_${bookId}`,
          manuscriptId: `m_sibling_${bookId}`,
          title: SIBLING_BOOK,
          author: AUTHOR,
          series: SERIES,
          seriesPosition: 2,
          isStandalone: false,
          manuscriptFile: 'manuscript.txt',
          castConfirmed: true,
          chapters: [],
          coverGradient: ['#000', '#fff'],
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        }),
      );
      writeFileSync(join(siblingBookDir, 'manuscript.txt'), 'placeholder');
      writeFileSync(join(siblingBookDir, '.audiobook', 'cast.json'), JSON.stringify({ characters: chars }));
    }

    beforeEach(() => {
      writeBookOnDisk([
        ...characters,
        charWithBase,
        charNoBase,
        charClonedOnQwen,
        {
          id: 'quill',
          name: 'Quill',
          role: 'supporting',
          color: 'moss',
          voiceId: 'v_quill',
          voiceUuid: 'v_quill',
          voiceStyle: 'a dry, watchful older woman',
          overrideTtsVoices: { qwen: { name: 'qwen-v_quill' } },
        },
      ]);
      writeVariantSiblingBookOnDisk([
        {
          id: 'quill-sibling',
          name: 'Quill Sibling',
          voiceId: 'v_quill',
          ttsEngine: 'coqui',
          overrideTtsVoices: {
            coqui: { name: 'xtts-quill-uuid', libraryUuid: 'quill-uuid', provenance: 'cloned' },
          },
        },
      ]);
    });

    afterEach(() => {
      if (siblingBookDir) rmSync(siblingBookDir, { recursive: true, force: true });
    });

    it('variant upfront: a series-wide clone (sibling book) is reported before any GPU call, not after', async () => {
      const spy = vi.spyOn(qwenVoiceMod, 'designQwenVoiceForCharacter');

      const res = await request(app)
        .post(`/api/books/${bookId}/cast/design`)
        .send({
          modelKey: QWEN_KEY,
          scope: 'variants',
          characterIds: [],
          variantTasks: [{ characterId: 'quill', emotions: ['angry'] }],
        });

      expect(res.status).toBe(200);
      const events = parseSse(res.text);
      expect(
        events.some(
          (e) =>
            e.type === 'character_skipped' &&
            e.characterId === 'quill' &&
            e.reason === 'already_cloned',
        ),
      ).toBe(true);
      expect(events.some((e) => e.type === 'variant_designed' && e.characterId === 'quill')).toBe(false);
      expect(spy).not.toHaveBeenCalled();
    });

    it('variant write-time: persistEmotionVariant resolving skippedClone reports through the same clonedSkips channel', async () => {
      vi.spyOn(qwenVoiceMod, 'designQwenVoiceForCharacter').mockResolvedValue({
        voiceId: 'qwen-v_marlow__angry',
        url: '/voice-samples/qwen-v_marlow__angry.mp3',
      });
      vi.spyOn(qwenVoiceMod, 'persistEmotionVariant').mockResolvedValueOnce('skippedClone');

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
      expect(
        events.some(
          (e) =>
            e.type === 'character_skipped' &&
            e.characterId === 'marlow' &&
            e.reason === 'already_cloned',
        ),
      ).toBe(true);
      expect(events.some((e) => e.type === 'variant_designed' && e.characterId === 'marlow')).toBe(false);
      const idle = events.find((e) => e.type === 'idle');
      expect(idle?.clonedSkips).toContainEqual({ characterId: 'marlow', name: 'Marlow' });
    });
  });

  it('scope:both designs base then its variants in order for one character', async () => {
    /* maerin has no base yet — scope:both should design the base first, then the variant. */
    const designedIds: string[] = [];
    vi.spyOn(qwenVoiceMod, 'designQwenVoiceForCharacter').mockImplementation(
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

/* #1981 — cast-design.ts can't use the self-vs-self race shape every other
   module in this sweep uses: `inFlightByBook` means a second concurrent POST
   for the same book attaches to the running job's SSE stream instead of
   starting a second one (see cast-design.ts's `inFlightByBook.get` gate) —
   there is only ever one design writer per book. So this races the design
   job's `writeVoiceStylePersona` write helper (the locked fresh-read-through-
   write span both design call sites share) DIRECTLY against a different
   module's writer (cast-aliases' add-alias) on the same book, per the #1981
   plan's note for this file. Driving the helper directly (not the route)
   sidesteps having to time a real SSE job's internal write against another
   request — the job runs detached from the request that started it, so a
   route-level race here can't be made deterministic. */
describe('#1981 — cross-writer race: cast-design write helper vs cast-aliases add-alias', () => {
  it('keeps both writes when a design persona write and an add-alias call for one book overlap', async () => {
    const { writeVoiceStylePersona } = await import('./cast-design.js');
    const { castAliasesRouter } = await import('./cast-aliases.js');
    const aliasApp = express();
    aliasApp.use(express.json());
    aliasApp.use('/api/books', castAliasesRouter);

    const [, resAlias] = await Promise.all([
      writeVoiceStylePersona(bookDir, 'hart', 'a race persona for hart'),
      request(aliasApp)
        .post(`/api/books/${bookId}/cast/add-alias`)
        .send({ characterId: 'brann', aliasName: 'Race Alias' }),
    ]);
    expect(resAlias.status).toBe(200);

    const cast = readCast();
    expect(cast.characters.find((c) => c.id === 'hart')?.voiceStyle).toBe(
      'a race persona for hart',
    );
    expect(cast.characters.find((c) => c.id === 'brann')?.aliases).toContain('Race Alias');
  });
});

/* #2292 (owner decision) — a lock timeout on ONE character's persist reports
 * contention, not a failed design.
 *
 * The bulk-design loop's per-character `catch` covers real synthesis failures
 * AND the persist steps that follow them — `applyOverrideToCastFiles`,
 * `persistEmotionVariant`, `ensureCharacterVoiceUuid`, all of which take the
 * cast lock. On a timeout the voice WAS designed and only the write was
 * blocked, so "Voice design failed" described the opposite of what happened.
 *
 * The per-character shape is unchanged (one contended character must not fail
 * the other N, and the loop continuing is what the existing "a per-character
 * failure is recorded and the loop continues" test pins), and the same string
 * has to reach BOTH surfaces — the live `character_failed` broadcast and the
 * terminal `idle` event's `failures` list — or the toast and the summary
 * disagree.
 *
 * Two-directional: an ordinary synthesis failure at the same site keeps its
 * own message.
 */
describe('cast-design — per-character reason on a lock timeout (#2292)', () => {
  async function designWithThrowOnAria(toThrow: unknown) {
    const voices = await import('./voices.js');
    const original = voices.applyOverrideToCastFiles;
    const spy = vi
      .spyOn(voices, 'applyOverrideToCastFiles')
      .mockImplementation(
        async (
          matchKey: Parameters<typeof original>[0],
          override: Parameters<typeof original>[1],
          seriesFilter: Parameters<typeof original>[2],
          dir: Parameters<typeof original>[3],
        ) => {
          if (matchKey === 'v_aria') throw toThrow;
          return original(matchKey, override, seriesFilter, dir);
        },
      );
    try {
      return await request(app)
        .post(`/api/books/${bookId}/cast/design`)
        .send({ characterIds: ['aria', 'brann'], modelKey: QWEN_KEY });
    } finally {
      spy.mockRestore();
    }
  }

  it('reports contention on both surfaces and still designs the other character', async () => {
    const { LockAcquisitionTimeoutError, LOCK_CONTENTION_ITEM_REASON } = await import(
      '../workspace/file-lock.js'
    );
    const res = await designWithThrowOnAria(
      new LockAcquisitionTimeoutError('cast:/w/hollow-tide', 10_000),
    );

    expect(res.status).toBe(200);
    const events = parseSse(res.text);

    /* The live broadcast the user sees first... */
    const failedEvent = events.find((e) => e.type === 'character_failed' && e.characterId === 'aria');
    expect(failedEvent).toBeDefined();
    expect(failedEvent?.errorReason).toBe(LOCK_CONTENTION_ITEM_REASON);

    /* ...and the terminal summary, which must agree with it. */
    const idle = events.find((e) => e.type === 'idle');
    expect(idle?.failures).toHaveLength(1);
    expect(idle?.failures?.[0].characterId).toBe('aria');
    expect(idle?.failures?.[0].error).toBe(LOCK_CONTENTION_ITEM_REASON);
    expect(idle?.failures?.[0].error).not.toContain('withKeyLock');

    /* Not escalated: the loop carried on and the other character landed. */
    expect(idle?.done).toBe(1);
    expect(charById('brann')?.overrideTtsVoices?.qwen?.name).toBe('qwen-v_brann');
  });

  it('an ordinary failure at the same site keeps its own message', async () => {
    const res = await designWithThrowOnAria(new Error('model exploded'));

    const events = parseSse(res.text);
    const idle = events.find((e) => e.type === 'idle');
    expect(idle?.failures).toHaveLength(1);
    expect(idle?.failures?.[0].error).toBe('model exploded');
  });
});
