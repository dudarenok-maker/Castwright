/* Integration tests for the Qwen design-voice proxy router (plan 108,
   Wave 4; reuse-as-sample optimisation).

   Seeds one book with a speaking character carrying a persona + evidence on
   disk and asserts:
     - the route proxies the sidecar's /qwen/design-voice with the derived
       voiceId + persona + a calibrationText drawn from the character's own
       longest evidence quote (so the audition speaks their line)
     - the audition MP3 is written into the voice-sample cache under the
       filename the /sample player computes, and the route returns JSON
       `{ voiceId, url }` pointing at it
     - ONE-PASS: after design, a /sample request for the same identity is a
       cache hit — the TTS provider is never invoked (no second synthesis)
     - the persona defaults to the character's voiceStyle; a body persona wins
     - 400 when neither a body persona nor a persisted voiceStyle exists
     - 400 when sampleVoiceId / modelKey are missing
     - the route does NOT persist the override (design only caches + previews)
     - a sidecar that's down → 502; unknown book / character → 404

   `global.fetch` is mocked (sidecar); selectTtsProvider is mocked so the
   /sample coherence check can assert the provider is untouched. Real ffmpeg
   encodes the audition (same boundary as voice-sample.ts). */

import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach, vi } from 'vitest';
import {
  mkdtempSync,
  rmSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express, { type Express } from 'express';
import request from 'supertest';
import { withCapacityRetry } from '../gpu/capacity-retry.js';
import { NoCapacityError } from '../tts/tts-errors.js';

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


/* #1981 — hoisted `vi.mock` (NOT a runtime `vi.spyOn`) so the promote-voice-
   vs-assign race test far below can deterministically intercept
   qwen-voice.ts's OWN `readJson` call (bound at qwen-voice.ts's own
   module-load time, before any runtime spy could attach to it) — same
   rationale as book-state-preserve-voices.test.ts's own #1981 race test.
   Defaults to a plain passthrough, so every other test in this file behaves
   exactly as if this mock weren't here; only the one race test below
   overrides `mockImplementation` for the duration of its own `it`, then
   restores it. */
vi.mock('../workspace/state-io.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../workspace/state-io.js')>();
  return { ...actual, readJson: vi.fn(actual.readJson) };
});

const AUTHOR = 'Della Renwick';
const SERIES = 'The Hollow Tide';
const BOOK = 'The Hollow Tide';
const QWEN_KEY = 'qwen3-tts-0.6b';

/* Maerin's longest evidence quote, smart-quotes stripped — what buildSampleText
   picks and the audition therefore speaks. */
const MAERIN_LINE = 'We have to tell the Council, and we have to do it before the others wake.';

let workspaceRoot: string;
let audioDir: string;
let app: Express;
let bookId: string;

const fetchMock = vi.fn();
const mockWithCapacityRetry = vi.mocked(withCapacityRetry);
/* selectTtsProvider stub — the /sample coherence test asserts synthesize is
   NEVER called (the design route already wrote the file). */
const { synthesize } = vi.hoisted(() => ({ synthesize: vi.fn() }));

vi.mock('../tts/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../tts/index.js')>();
  return { ...actual, selectTtsProvider: vi.fn(() => ({ synthesize })) };
});

const { withGpuLoadMock } = vi.hoisted(() => ({
  withGpuLoadMock: vi.fn(async (fn: () => Promise<unknown>, _onGpu?: boolean) => fn()), // default: passthrough
}));
vi.mock('../gpu/gpu-load.js', () => ({
  withGpuLoad: (fn: () => Promise<unknown>, onGpu?: boolean) => withGpuLoadMock(fn, onGpu),
  GpuBusyError: class GpuBusyError extends Error {
    code = 'GPU_BUSY';
    constructor(m: string) { super(m); this.name = 'GpuBusyError'; }
  },
}));

/* fs-45 v1 — spy on the TTS VRAM sampler so we can assert the design call site
   invokes it with 'qwen:design'. The whole function is replaced, so the call
   fires regardless of the suite-wide CASTWRIGHT_VRAM_SAMPLE='0' env gate (which
   lives inside the real function). */
const { maybeSampleSidecarEngineMock } = vi.hoisted(() => ({
  maybeSampleSidecarEngineMock: vi.fn(async (_key: string) => {}),
}));
vi.mock('../gpu/sidecar-vram-sample.js', () => ({
  maybeSampleSidecarEngine: (key: string) => maybeSampleSidecarEngineMock(key),
}));

/* #1720 Task 7 — withCapacityRetry is mocked wholesale rather than exercised
   for real (its retry/evict/exhaustion policy is already covered by
   server/src/gpu/capacity-retry.test.ts). The root beforeEach below resets
   it to a plain single-call passthrough so every PRE-EXISTING test in this
   file keeps exercising exactly the same single-fetch behavior it did before
   this wiring landed; the "capacity-aware retry wiring" describe block below
   overrides the implementation locally to pin the new behavior. */
vi.mock('../gpu/capacity-retry.js', () => ({ withCapacityRetry: vi.fn() }));

const characters = [
  { id: 'narrator', name: 'Narrator', role: 'narrator', color: 'narrator' },
  {
    id: 'maerin',
    name: 'Maerin',
    role: 'supporting',
    color: 'lilac',
    voiceId: 'v_maerin',
    /* srv-43: pre-seed a known voiceUuid so the main test suite produces
       deterministic qwen-v_maerin storage keys (qwenStorageKey uses uuid first).
       Tests that exercise the auto-mint path use their own separate bookDirs. */
    voiceUuid: 'v_maerin',
    voiceStyle: 'a poised, confident teenage girl, clear and warm',
    evidence: [{ quote: `”${MAERIN_LINE}”` }, { quote: 'Wait.' }],
  },
  { id: 'nopersona', name: 'Nopersona', role: 'extra', color: 'amber' },
  /* Designed voice via an explicit per-character override (name diverges from
     the derived qwen-<voiceId>) — proves the persona GET resolves the override
     name, not the derived one. */
  {
    id: 'overridechar',
    name: 'Override Char',
    role: 'supporting',
    color: 'teal',
    voiceId: 'v_other',
    overrideTtsVoices: { qwen: { name: 'qwen-custom-name' } },
  },
  /* #1954 — CLONED on qwen (a voice-library clone assigned to this character).
     The slot carries a `name`, so every `overrideTtsVoices?.qwen?.name` check
     reads "already designed"; but the artifact lives at `qwen-<libraryUuid>`,
     which `qwenStorageKey` (voiceUuid/voiceId-derived) cannot produce. The
     divergence is deliberate here: `voiceUuid` and `libraryUuid` are different
     strings, exactly as the real /assign route leaves them (it writes
     `libraryUuid` onto the slot and never touches `character.voiceUuid`). */
  {
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
  },
];

/** Write a designed-voice JSON sidecar under the workspace's voices/qwen dir. */
function writeQwenSidecar(name: string, instruct: unknown) {
  const dir = join(workspaceRoot, 'voices', 'qwen');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${name}.json`), JSON.stringify({ voiceId: name, instruct }));
}

function writeBookOnDisk(chars: object[]) {
  const dir = join(workspaceRoot, 'books', AUTHOR, SERIES, BOOK);
  mkdirSync(join(dir, '.audiobook'), { recursive: true });
  writeFileSync(
    join(dir, '.audiobook', 'state.json'),
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
      language: 'en',
      coverGradient: ['#000', '#fff'],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }),
  );
  writeFileSync(join(dir, 'manuscript.txt'), 'placeholder');
  writeFileSync(join(dir, '.audiobook', 'cast.json'), JSON.stringify({ characters: chars }));
}

function readCast(): { characters: Array<Record<string, unknown>> } {
  const path = join(workspaceRoot, 'books', AUTHOR, SERIES, BOOK, '.audiobook', 'cast.json');
  return JSON.parse(readFileSync(path, 'utf8'));
}

/* A few hundred ms of silence so ffmpeg produces a real MP3 frame. */
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

function isMp3Magic(buf: Buffer): boolean {
  if (buf.length < 3) return false;
  if (buf[0] === 0x49 && buf[1] === 0x44 && buf[2] === 0x33) return true; // ID3v2
  if (buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0) return true; // MPEG frame sync
  return false;
}

const designBody = { sampleVoiceId: 'v_maerin', modelKey: QWEN_KEY };

/* Turn VRAM sampling off so the new /health probe doesn't inflate fetch-mock call counts. */
beforeAll(() => { process.env.CASTWRIGHT_VRAM_SAMPLE = '0'; });
afterAll(() => { delete process.env.CASTWRIGHT_VRAM_SAMPLE; });

beforeAll(async () => {
  workspaceRoot = mkdtempSync(join(tmpdir(), 'audiobook-qwen-voice-test-'));
  audioDir = mkdtempSync(join(tmpdir(), 'audiobook-qwen-voice-audio-'));
  process.env.WORKSPACE_DIR = workspaceRoot;
  process.env.VOICE_SAMPLE_AUDIO_DIR = audioDir;
  vi.stubGlobal('fetch', fetchMock);

  /* #2083 — sequential awaits, not Promise.all: two import chains reaching
     the same to-be-mocked module (e.g. tts/index.js, mocked above) inside one
     Promise.all can race the async vi.mock factory, so whichever chain
     resolves first can bind the REAL module instead of the mock. See Lane
     4's server-wide sweep for the mutation proof (a 50ms delay injected into
     an async vi.mock factory went 15/15 red under Promise.all, 15/15 green
     under sequential awaits). */
  const { qwenVoiceRouter } = await import('./qwen-voice.js');
  const { voiceSampleRouter } = await import('./voice-sample.js');
  /* #1981 — castAliasesRouter and voiceLibraryRouter are mounted here (not
     in their own race describes' beforeAlls further down) so the shared
     `app` object is fully assembled once, up front, rather than mutated
     mid-file by a later describe. */
  const { castAliasesRouter } = await import('./cast-aliases.js');
  const { voiceLibraryRouter } = await import('./voice-library.js');
  const { makeBookId } = await import('../workspace/paths.js');
  bookId = makeBookId(AUTHOR, SERIES, BOOK);

  app = express();
  app.use(express.json());
  app.use('/api/books', qwenVoiceRouter);
  app.use('/api/voices', voiceSampleRouter);
  app.use('/api/books', castAliasesRouter);
  app.use('/api/voice-library', voiceLibraryRouter);
});

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockResolvedValue(okSidecarResponse());
  synthesize.mockReset();
  synthesize.mockResolvedValue({ pcm: Buffer.alloc(24_000 * 2 * 0.3, 0), sampleRate: 24_000 });
  maybeSampleSidecarEngineMock.mockClear();
  mockWithCapacityRetry.mockReset();
  mockWithCapacityRetry.mockImplementation((doPost, opts) => doPost(opts.signal));
  for (const f of readdirSync(audioDir)) rmSync(join(audioDir, f), { force: true });
  /* Wipe designed-voice sidecars between tests so the persona GET cases stay
     isolated (a sidecar written by one test must not leak into the next). */
  rmSync(join(workspaceRoot, 'voices'), { recursive: true, force: true });
  writeBookOnDisk(characters);
});

afterAll(() => {
  vi.unstubAllGlobals();
  if (workspaceRoot) rmSync(workspaceRoot, { recursive: true, force: true });
  if (audioDir) rmSync(audioDir, { recursive: true, force: true });
  delete process.env.WORKSPACE_DIR;
  delete process.env.VOICE_SAMPLE_AUDIO_DIR;
});

describe('POST /api/books/:bookId/cast/:characterId/design-voice', () => {
  it('records a qwen:design VRAM sample at the design call site (fs-45 v1 wiring)', async () => {
    const res = await request(app)
      .post(`/api/books/${bookId}/cast/maerin/design-voice`)
      .send(designBody);

    expect(res.status).toBe(200);
    // The design site calls maybeSampleSidecarEngine('qwen:design') while
    // VoiceDesign is still resident (inside the withGpuLoad callback, before return).
    expect(maybeSampleSidecarEngineMock).toHaveBeenCalledWith('qwen:design');
  });

  it('passes engineDeviceIsGpu(\'qwen\') as withGpuLoad\'s second arg (W2.6 — no QWEN_DEVICE override, default "auto" is GPU)', async () => {
    withGpuLoadMock.mockClear(); // isolate from any prior test's accumulated call history
    const res = await request(app)
      .post(`/api/books/${bookId}/cast/maerin/design-voice`)
      .send(designBody);

    expect(res.status).toBe(200);
    expect(withGpuLoadMock.mock.calls[0][1]).toBe(true);
  });

  it('forwards persona + a calibrationText from the character line, caches the MP3, returns {voiceId,url}', async () => {
    const res = await request(app)
      .post(`/api/books/${bookId}/cast/maerin/design-voice`)
      .send(designBody);

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/application\/json/);
    expect(res.body.voiceId).toBe('qwen-v_maerin');
    expect(res.body.url).toMatch(/^\/audio\/voices\/v_maerin-qwen3-tts-0\.6b-[a-z0-9]+\.mp3$/);

    /* Sidecar called once with the right payload — including the character's
       own line as the audition calibration text. */
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('http://localhost:9000/qwen/design-voice');
    const sent = JSON.parse(init.body);
    expect(sent).toEqual({
      voiceId: 'qwen-v_maerin',
      voiceUuid: 'v_maerin',
      instruct: 'a poised, confident teenage girl, clear and warm',
      language: 'English',
      calibrationText: MAERIN_LINE,
    });

    /* The cached file on disk is a real MP3 at the URL's filename. */
    const fileName = res.body.url.split('/').pop() as string;
    const fileBuf = readFileSync(join(audioDir, fileName));
    expect(isMp3Magic(fileBuf)).toBe(true);
  });

  it('ONE PASS: after design, /sample for the same identity is a cache hit (no provider call)', async () => {
    const design = await request(app)
      .post(`/api/books/${bookId}/cast/maerin/design-voice`)
      .send(designBody);
    expect(design.status).toBe(200);

    /* The drawer / cast row would request the 12s sample with the designed
       voice pinned in overrideTtsVoices.qwen and the character's evidence as
       the hint — exactly the inputs that reproduce the cached filename. */
    const sample = await request(app)
      .post('/api/voices/v_maerin/sample')
      .send({
        modelKey: QWEN_KEY,
        voice: { id: 'v_maerin', overrideTtsVoices: { qwen: { name: 'qwen-v_maerin' } } },
        characterHint: { evidence: [`“${MAERIN_LINE}”`, 'Wait.'] },
      });

    expect(sample.status).toBe(200);
    expect(sample.body.cached).toBe(true);
    expect(sample.body.url).toBe(design.body.url);
    /* The whole point: the player never re-synthesised. */
    expect(synthesize).not.toHaveBeenCalled();
  });

  it('OVERWRITES the cached audition on re-design (an explicit regenerate must refresh the preview)', async () => {
    const first = await request(app)
      .post(`/api/books/${bookId}/cast/maerin/design-voice`)
      .send(designBody);
    expect(first.status).toBe(200);
    const fileName = first.body.url.split('/').pop() as string;
    const firstBytes = readFileSync(join(audioDir, fileName));

    /* Re-designing produces a DIFFERENT audition (the freshly-designed voice).
       The cache filename is keyed on (text, voiceId) — unchanged across
       re-designs of the same character — so the route MUST overwrite the file.
       Before the fix an `existsSync` guard skipped the write, so "Play 12s"
       (and the drawer's post-design playback, which reads this same URL) kept
       serving the FIRST design's audio and the re-design looked like a no-op. */
    fetchMock.mockResolvedValue(okSidecarResponse(new Uint8Array(24_000 * 2).fill(0x40)));
    const second = await request(app)
      .post(`/api/books/${bookId}/cast/maerin/design-voice`)
      .send(designBody);
    expect(second.status).toBe(200);
    expect(second.body.url).toBe(first.body.url); // same deterministic filename
    const secondBytes = readFileSync(join(audioDir, fileName));
    expect(secondBytes.equals(firstBytes)).toBe(false); // refreshed, not stale
  });

  it('defaults the persona to the character voiceStyle and lets the body override it', async () => {
    await request(app)
      .post(`/api/books/${bookId}/cast/maerin/design-voice`)
      .send({ ...designBody, persona: 'a gruff old sailor' });
    const sent = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(sent.instruct).toBe('a gruff old sailor');
  });

  it('does NOT persist the override (design only caches + previews)', async () => {
    await request(app)
      .post(`/api/books/${bookId}/cast/maerin/design-voice`)
      .send(designBody);
    const cast = readCast();
    const maerin = cast.characters.find((c) => c.id === 'maerin');
    expect(maerin?.overrideTtsVoices).toBeUndefined();
    expect(maerin?.ttsEngine).toBeUndefined();
  });

  it('400s when neither a body persona nor a persisted voiceStyle exists', async () => {
    const res = await request(app)
      .post(`/api/books/${bookId}/cast/nopersona/design-voice`)
      .send(designBody);
    expect(res.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('400s when sampleVoiceId is missing', async () => {
    const res = await request(app)
      .post(`/api/books/${bookId}/cast/maerin/design-voice`)
      .send({ modelKey: QWEN_KEY });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/sampleVoiceId/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('400s when modelKey is missing or invalid', async () => {
    const res = await request(app)
      .post(`/api/books/${bookId}/cast/maerin/design-voice`)
      .send({ sampleVoiceId: 'v_maerin', modelKey: 'nope' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/modelKey/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('502s with a clear message when the sidecar is unreachable', async () => {
    fetchMock.mockRejectedValue(new Error('ECONNREFUSED'));
    const res = await request(app)
      .post(`/api/books/${bookId}/cast/maerin/design-voice`)
      .send(designBody);
    expect(res.status).toBe(502);
    expect(res.body.error).toMatch(/unreachable/i);
  });

  /* #1801 — the route used to flatten EVERY sidecar failure to 502. It now
     maps the SidecarDesignError's own status through, so an upstream 500
     arrives as 500 (and the 503 below as 503). The status-0 unreachable case
     above still clamps to 502. */
  it('surfaces the sidecar status when it returns a non-OK status', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 500,
      statusText: 'Internal Server Error',
      headers: new Headers(),
      arrayBuffer: async () => new ArrayBuffer(0),
      json: async () => ({ error: 'qwen-tts not installed' }),
    });
    const res = await request(app)
      .post(`/api/books/${bookId}/cast/maerin/design-voice`)
      .send(designBody);
    expect(res.status).toBe(500);
    expect(res.body.error).toMatch(/qwen-tts not installed/);
  });

  /* The signal this whole fix exists for: a 503 means "no GPU capacity — free
     VRAM and retry", which is retryable. A flat 502 reads as "the gateway is
     broken" and gives a retry UI nothing to key off. */
  it('surfaces a sidecar 503 (free-VRAM-and-retry) instead of flattening to 502', async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ detail: 'GPU is saturated' }), { status: 503 }),
    );
    const res = await request(app)
      .post(`/api/books/${bookId}/cast/maerin/design-voice`)
      .send(designBody);
    expect(res.status).toBe(503);
    expect(res.body.error).toMatch(/GPU is saturated/);
  });

  it('surfaces the sidecar FastAPI {detail} field, not a bare "returned 500"', async () => {
    /* The sidecar reports failures as `{ detail }` (FastAPI), e.g. a CUDA
       "Cannot copy out of meta tensor" load error. The route used to read only
       `.error`, dropping the reason and showing a generic "returned 500" — so
       the user couldn't tell WHY the model failed to load. */
    fetchMock.mockResolvedValue({
      ok: false,
      status: 500,
      statusText: 'Internal Server Error',
      headers: new Headers(),
      arrayBuffer: async () => new ArrayBuffer(0),
      json: async () => ({ detail: 'Cannot copy out of meta tensor; no data!' }),
    });
    const res = await request(app)
      .post(`/api/books/${bookId}/cast/maerin/design-voice`)
      .send(designBody);
    expect(res.status).toBe(500);
    expect(res.body.error).toMatch(/meta tensor/);
    expect(res.body.error).not.toMatch(/returned 500/);
  });

  it('404s for an unknown bookId', async () => {
    const res = await request(app).post('/api/books/nope/cast/maerin/design-voice').send(designBody);
    expect(res.status).toBe(404);
  });

  it('404s for an unknown characterId', async () => {
    const res = await request(app)
      .post(`/api/books/${bookId}/cast/ghost/design-voice`)
      .send(designBody);
    expect(res.status).toBe(404);
  });

  /* fs-2 — the design proxy threads the BOOK's language to the sidecar so the
     designed voice is baked in the right language. */
  it("sends language:'Russian' to the sidecar for a 'ru' book", async () => {
    const statePath = join(
      workspaceRoot,
      'books',
      AUTHOR,
      SERIES,
      BOOK,
      '.audiobook',
      'state.json',
    );
    const state = JSON.parse(readFileSync(statePath, 'utf8'));
    writeFileSync(statePath, JSON.stringify({ ...state, language: 'ru' }));

    const res = await request(app)
      .post(`/api/books/${bookId}/cast/maerin/design-voice`)
      .send(designBody);
    expect(res.status).toBe(200);
    const sent = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(sent.language).toBe('Russian');
  });

  it("sends language:'English' for a book with no language field (legacy default)", async () => {
    /* beforeEach writes the book with no `language` — the seam defaults to 'en'
       → 'English', so legacy books keep designing English voices unchanged. */
    const res = await request(app)
      .post(`/api/books/${bookId}/cast/maerin/design-voice`)
      .send(designBody);
    expect(res.status).toBe(200);
    const sent = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(sent.language).toBe('English');
  });

  it('returns 409 when the GPU is busy with analysis (constrained card)', async () => {
    const { GpuBusyError } = await import('../gpu/gpu-load.js');
    withGpuLoadMock.mockImplementationOnce(() => {
      throw new GpuBusyError('GPU busy with analysis — try again once it finishes.');
    });
    const res = await request(app)
      .post(`/api/books/${bookId}/cast/maerin/design-voice`)
      .send(designBody);
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/GPU busy/i);
  });
});

describe('fs-25 — design-voice emotion variants (Wave 3)', () => {
  it('fs-55: routes emotion variant to /qwen/mint-variant with baseVoiceId + emotionInstruct (not full instruct)', async () => {
    const res = await request(app)
      .post(`/api/books/${bookId}/cast/maerin/design-voice`)
      .send({ ...designBody, emotion: 'angry' });

    expect(res.status).toBe(200);
    expect(res.body.voiceId).toBe('qwen-v_maerin__angry');

    // fs-55: variant design hits /qwen/mint-variant, not /qwen/design-voice.
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('http://localhost:9000/qwen/mint-variant');
    const sent = JSON.parse(init.body);
    // baseVoiceId is the real (non-preview, non-emotion) storage key.
    expect(sent.baseVoiceId).toBe('qwen-v_maerin');
    // variantVoiceId carries the __emotion suffix.
    expect(sent.variantVoiceId).toBe('qwen-v_maerin__angry');
    // emotionInstruct is the delivery clause ONLY — no persona re-description.
    expect(sent.emotionInstruct).toContain('rage');
    expect(sent.emotionInstruct).not.toContain('a poised, confident teenage girl');
    // no legacy `instruct` field on the mint-variant body.
    expect(sent.instruct).toBeUndefined();

    // the variant is persisted onto the character's qwen slot.
    const cast = readCast();
    const maerin = cast.characters.find((c) => c.id === 'maerin') as Record<string, any>;
    expect(maerin.overrideTtsVoices.qwen.variants.angry).toEqual({ name: 'qwen-v_maerin__angry' });
  });

  it("fs-59 CJK: EMOTION_INSTRUCT is language-invariant — a 'zh' book gets the same clause as English, no crash", async () => {
    /* EMOTION_INSTRUCT is keyed purely by emotion, never by language, so the
       lookup can't return undefined for any book language. Documents the
       CJK deferral (Task 4a.2): the delivery clause deliberately stays
       English for zh/ja too, consistent with the Qwen VoiceDesign
       persona-stays-English won't-fix. */
    const statePath = join(workspaceRoot, 'books', AUTHOR, SERIES, BOOK, '.audiobook', 'state.json');
    const state = JSON.parse(readFileSync(statePath, 'utf8'));
    writeFileSync(statePath, JSON.stringify({ ...state, language: 'zh' }));

    const res = await request(app)
      .post(`/api/books/${bookId}/cast/maerin/design-voice`)
      .send({ ...designBody, emotion: 'angry' });

    expect(res.status).toBe(200);
    const sent = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(sent.language).toBe('Chinese');
    // Same English delivery clause as the EN/RU 'angry' case above —
    // language never participates in the EMOTION_INSTRUCT lookup key.
    expect(sent.emotionInstruct).toContain('rage');
  });

  it('#1057: designing a VARIANT for a no-uuid character does NOT mint a uuid (would orphan the base .pt)', async () => {
    /* Strip maerin's pre-seeded uuid so it resolves via the legacy voiceId key
       (qwen-v_maerin), where its base .pt actually lives. Designing a VARIANT
       must anchor on that key WITHOUT minting a fresh uuid — minting would flip
       the base's storage key to qwen-<uuid> while the base .pt stays put,
       orphaning it (the bulk "Emotion variants" no-op bug). */
    const noUuid = characters.map((c) => (c.id === 'maerin' ? { ...c, voiceUuid: undefined } : c));
    writeBookOnDisk(noUuid);

    const res = await request(app)
      .post(`/api/books/${bookId}/cast/maerin/design-voice`)
      .send({ ...designBody, emotion: 'angry' });

    expect(res.status).toBe(200);
    // Anchors on the legacy key, not a freshly-minted qwen-<uuid>.
    const sent = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(sent.baseVoiceId).toBe('qwen-v_maerin');
    // Crucially: no uuid was stamped onto the character.
    const maerin = readCast().characters.find((c) => c.id === 'maerin') as Record<string, unknown>;
    expect(maerin.voiceUuid).toBeUndefined();
  });

  it('rejects an out-of-enum / neutral emotion with 400', async () => {
    const bad = await request(app)
      .post(`/api/books/${bookId}/cast/maerin/design-voice`)
      .send({ ...designBody, emotion: 'furious' });
    expect(bad.status).toBe(400);

    const neutral = await request(app)
      .post(`/api/books/${bookId}/cast/maerin/design-voice`)
      .send({ ...designBody, emotion: 'neutral' });
    expect(neutral.status).toBe(400);
  });

  it('a base design (no emotion) leaves variants untouched', async () => {
    const res = await request(app)
      .post(`/api/books/${bookId}/cast/maerin/design-voice`)
      .send(designBody);
    expect(res.status).toBe(200);
    expect(res.body.voiceId).toBe('qwen-v_maerin');
    const cast = readCast();
    const maerin = cast.characters.find((c) => c.id === 'maerin') as Record<string, any>;
    expect(maerin.overrideTtsVoices?.qwen?.variants).toBeUndefined();
  });
});

/* #1954 — an emotion variant of a CLONED voice is refused, not anchored.

   Pre-fix, the variant path computed its anchor as `qwenStorageKey(character,
   characterId)`, which for `lyra` is `qwen-v_lyra` — while her actual cloned
   artifact lives at `qwen-lyra-lib-uuid`. So the mint either anchored to a
   DIFFERENT voice's `.pt` (whatever `qwen-v_lyra` happens to be) or to nothing,
   and the variant it wrote landed under a key the render path never looks up
   (`pickVoiceForEngine` resolves a cloned qwen slot to `qwen-<libraryUuid>`, so
   `pickEmotionVariantVoice` asks for `qwen-lyra-lib-uuid__angry`).

   The chosen resolution is REFUSAL rather than correct anchoring — see the
   guard's own comment in qwen-voice.ts. */
describe('#1954 — emotion variants for a CLONED voice', () => {
  it('refuses with 409 clone_protected, never calls the sidecar, and persists nothing', async () => {
    const res = await request(app)
      .post(`/api/books/${bookId}/cast/lyra/design-voice`)
      .send({ sampleVoiceId: 'v_lyra', modelKey: QWEN_KEY, emotion: 'angry' });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('clone_protected');
    /* Actionable, not just a refusal: it names the character and says what to
       do instead. */
    expect(res.body.error).toContain('Lyra');
    expect(res.body.error).toMatch(/designed voice/i);

    /* No GPU work at all — the refusal lands before the sidecar is touched. */
    expect(fetchMock).not.toHaveBeenCalled();

    /* And nothing was written onto the cloned slot: no variants map, and the
       clone marker is byte-identical to what was seeded. */
    const lyra = readCast().characters.find((c) => c.id === 'lyra') as Record<string, any>;
    expect(lyra.overrideTtsVoices.qwen).toEqual({
      name: 'qwen-lyra-lib-uuid',
      libraryUuid: 'lyra-lib-uuid',
      provenance: 'cloned',
    });
  });

  it('the refusal lives at the shared design core, so every caller is covered', async () => {
    /* The route guard above is the UX; this is the load-bearing one. The bug
       was reachable precisely because the anchor computation had no guard of
       its own — a second caller (the bulk job, or any future one) reproduced
       it. Pinning the core means the wrong anchor can no longer be COMPUTED,
       not merely no longer offered. */
    const { designQwenVoiceForCharacter } = await import('./qwen-voice.js');
    const clonedCharacter = characters.find((c) => c.id === 'lyra')!;

    await expect(
      designQwenVoiceForCharacter({
        bookDir: join(workspaceRoot, 'books', AUTHOR, SERIES, BOOK),
        character: clonedCharacter as never,
        characterId: 'lyra',
        persona: 'a warm, low-voiced woman',
        sampleVoiceId: 'v_lyra',
        modelKey: QWEN_KEY,
        language: 'English',
        emotion: 'angry',
      }),
    ).rejects.toThrow(/cloned voice/i);

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('does NOT refuse a BASE design for the same cloned character (variants only)', async () => {
    /* Scope discipline: this fix is about the variant anchor. A base design on
       this route writes `qwen-<voiceUuid>.pt` and persists nothing, so it never
       touches the clone — gating it too would be an unrelated behaviour change. */
    const res = await request(app)
      .post(`/api/books/${bookId}/cast/lyra/design-voice`)
      .send({ sampleVoiceId: 'v_lyra', modelKey: QWEN_KEY });

    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe('http://localhost:9000/qwen/design-voice');
  });
});

describe('GET /api/books/:bookId/cast/:characterId/designed-persona', () => {
  it('returns the sidecar instruct for a character whose voice was designed (derived voiceId)', async () => {
    writeQwenSidecar('qwen-v_maerin', 'a poised, confident teenage girl, clear and warm');
    const res = await request(app).get(`/api/books/${bookId}/cast/maerin/designed-persona`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ instruct: 'a poised, confident teenage girl, clear and warm' });
  });

  it('resolves the per-character override name, not the derived qwen-<voiceId>', async () => {
    /* overridechar.voiceId is v_other, but its override pins qwen-custom-name —
       the persona must come from the OVERRIDE sidecar. */
    writeQwenSidecar('qwen-custom-name', 'a gruff old sailor, weathered and slow');
    writeQwenSidecar('qwen-v_other', 'WRONG — derived name, should be ignored');
    const res = await request(app).get(`/api/books/${bookId}/cast/overridechar/designed-persona`);
    expect(res.status).toBe(200);
    expect(res.body.instruct).toBe('a gruff old sailor, weathered and slow');
  });

  it('returns an empty instruct (200, not 404) when no sidecar exists on disk', async () => {
    const res = await request(app).get(`/api/books/${bookId}/cast/maerin/designed-persona`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ instruct: '' });
  });

  it('returns an empty instruct when the sidecar exists but has no instruct key', async () => {
    writeQwenSidecar('qwen-v_maerin', undefined);
    const res = await request(app).get(`/api/books/${bookId}/cast/maerin/designed-persona`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ instruct: '' });
  });

  it('404s for an unknown bookId', async () => {
    const res = await request(app).get('/api/books/nope/cast/maerin/designed-persona');
    expect(res.status).toBe(404);
  });

  it('404s for an unknown characterId', async () => {
    const res = await request(app).get(`/api/books/${bookId}/cast/ghost/designed-persona`);
    expect(res.status).toBe(404);
  });
});

describe('Preview / promote / discard (plan 161 — non-destructive A/B)', () => {
  const qwenDir = () => join(workspaceRoot, 'voices', 'qwen');
  /* Stand in for what the (mocked) sidecar would write at design time. */
  function stagedPreviewArtifacts(previewId: string) {
    mkdirSync(qwenDir(), { recursive: true });
    writeFileSync(join(qwenDir(), `${previewId}.pt`), 'EMBEDDING');
    writeFileSync(
      join(qwenDir(), `${previewId}.json`),
      JSON.stringify({ voiceId: previewId, instruct: 'a brand new take' }),
    );
  }

  it('design-voice with preview:true stages under a -preview id (live voice untouched)', async () => {
    const res = await request(app)
      .post(`/api/books/${bookId}/cast/maerin/design-voice`)
      .send({ ...designBody, preview: true });
    expect(res.status).toBe(200);
    expect(res.body.voiceId).toBe('qwen-v_maerin-preview');
    /* The sidecar was asked to design the PREVIEW id, not the live one. */
    const sent = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(sent.voiceId).toBe('qwen-v_maerin-preview');
  });

  it('promote-voice moves the preview onto the stable id, returns it, and evicts the sidecar cache', async () => {
    stagedPreviewArtifacts('qwen-v_maerin-preview');
    const res = await request(app)
      .post(`/api/books/${bookId}/cast/maerin/promote-voice`)
      .send({ previewVoiceId: 'qwen-v_maerin-preview', sampleVoiceId: 'v_maerin', modelKey: QWEN_KEY });

    expect(res.status).toBe(200);
    expect(res.body.voiceId).toBe('qwen-v_maerin');
    expect(res.body.url).toMatch(/^\/audio\/voices\/v_maerin-qwen3-tts-0\.6b-[a-z0-9]+\.mp3$/);
    /* Files moved: real id now present, preview gone. */
    expect(existsSync(join(qwenDir(), 'qwen-v_maerin.pt'))).toBe(true);
    expect(existsSync(join(qwenDir(), 'qwen-v_maerin.json'))).toBe(true);
    expect(existsSync(join(qwenDir(), 'qwen-v_maerin-preview.pt'))).toBe(false);
    /* The sidecar cache for the REAL id was evicted so the swap is seen. */
    const evictCall = fetchMock.mock.calls.find(([u]) => String(u).endsWith('/qwen/evict-voice'));
    expect(evictCall).toBeTruthy();
    expect(JSON.parse(evictCall![1].body).voiceId).toBe('qwen-v_maerin');
  });

  it('promote-voice renames the preview’s retained reference clip onto the real key (fix wave, §2.3 consent gap)', async () => {
    stagedPreviewArtifacts('qwen-v_maerin-preview');
    writeFileSync(join(qwenDir(), 'qwen-v_maerin-preview__master.wav'), 'REF-CLIP');

    const res = await request(app)
      .post(`/api/books/${bookId}/cast/maerin/promote-voice`)
      .send({ previewVoiceId: 'qwen-v_maerin-preview', sampleVoiceId: 'v_maerin', modelKey: QWEN_KEY });

    expect(res.status).toBe(200);
    expect(existsSync(join(qwenDir(), 'qwen-v_maerin__master.wav'))).toBe(true);
    expect(existsSync(join(qwenDir(), 'qwen-v_maerin-preview__master.wav'))).toBe(false);
  });

  it('promote-voice still succeeds when the preview has no retained reference clip (pre-fix design, best-effort)', async () => {
    stagedPreviewArtifacts('qwen-v_maerin-preview');
    /* No `-preview__master.wav` seeded at all. */
    const res = await request(app)
      .post(`/api/books/${bookId}/cast/maerin/promote-voice`)
      .send({ previewVoiceId: 'qwen-v_maerin-preview', sampleVoiceId: 'v_maerin', modelKey: QWEN_KEY });

    expect(res.status).toBe(200);
    expect(existsSync(join(qwenDir(), 'qwen-v_maerin__master.wav'))).toBe(false);
  });

  it('promote-voice invalidates the redesigned character’s stale emotion variants (slots + .pt/.json + sidecar evict)', async () => {
    /* A redesign replaces the base embedding, so every variant minted from the
       OLD embedding is now stale. Seed maerin with a live base + two designed
       variants, stage a new preview, and promote it: all variants must be torn
       down (cast.json slots + .pt/.json + sidecar eviction), base preserved. */
    stagedPreviewArtifacts('qwen-v_maerin-preview');
    for (const id of ['qwen-v_maerin__angry', 'qwen-v_maerin__sad']) {
      writeFileSync(join(qwenDir(), `${id}.pt`), 'STALE');
      writeFileSync(join(qwenDir(), `${id}.json`), JSON.stringify({ voiceId: id }));
    }
    const withVariants = characters.map((c) =>
      c.id === 'maerin'
        ? {
            ...c,
            overrideTtsVoices: {
              qwen: {
                name: 'qwen-v_maerin',
                variants: {
                  angry: { name: 'qwen-v_maerin__angry' },
                  sad: { name: 'qwen-v_maerin__sad' },
                },
              },
            },
          }
        : c,
    );
    writeFileSync(
      join(workspaceRoot, 'books', AUTHOR, SERIES, BOOK, '.audiobook', 'cast.json'),
      JSON.stringify({ characters: withVariants }),
    );

    const res = await request(app)
      .post(`/api/books/${bookId}/cast/maerin/promote-voice`)
      .send({ previewVoiceId: 'qwen-v_maerin-preview', sampleVoiceId: 'v_maerin', modelKey: QWEN_KEY });

    expect(res.status).toBe(200);
    /* Variant map wiped from cast.json (badge clears); base promoted intact. */
    const maerin = readCast().characters.find((c) => c.id === 'maerin')!;
    const qwen = maerin.overrideTtsVoices as { qwen: { name: string; variants?: unknown } };
    expect(qwen.qwen.variants).toBeUndefined();
    expect(qwen.qwen.name).toBe('qwen-v_maerin');
    /* Variant embeddings gone from disk. */
    expect(existsSync(join(qwenDir(), 'qwen-v_maerin__angry.pt'))).toBe(false);
    expect(existsSync(join(qwenDir(), 'qwen-v_maerin__angry.json'))).toBe(false);
    expect(existsSync(join(qwenDir(), 'qwen-v_maerin__sad.pt'))).toBe(false);
    /* Each variant id evicted from the sidecar cache (alongside the base). */
    const evicted = fetchMock.mock.calls
      .filter(([u]) => String(u).endsWith('/qwen/evict-voice'))
      .map(([, init]) => JSON.parse((init as { body: string }).body).voiceId);
    expect(evicted).toContain('qwen-v_maerin');
    expect(evicted).toContain('qwen-v_maerin__angry');
    expect(evicted).toContain('qwen-v_maerin__sad');
  });

  it('promote-voice 409s when nothing was staged', async () => {
    const res = await request(app)
      .post(`/api/books/${bookId}/cast/maerin/promote-voice`)
      .send({ previewVoiceId: 'qwen-v_maerin-preview', sampleVoiceId: 'v_maerin', modelKey: QWEN_KEY });
    expect(res.status).toBe(409);
  });

  it('promote-voice 409s WITHOUT deleting the live .pt on a double-promote (#1804 data-loss guard)', async () => {
    mkdirSync(qwenDir(), { recursive: true });
    writeFileSync(join(qwenDir(), 'qwen-v_maerin.pt'), 'LIVE');
    // No preview `.pt` staged — mirrors a double-promote (second click after
    // the first already consumed the preview).

    const res = await request(app)
      .post(`/api/books/${bookId}/cast/maerin/promote-voice`)
      .send({ previewVoiceId: 'qwen-v_maerin-preview', sampleVoiceId: 'v_maerin', modelKey: QWEN_KEY });

    expect(res.status).toBe(409);
    expect(existsSync(join(qwenDir(), 'qwen-v_maerin.pt'))).toBe(true); // live artifact must survive
    expect(readFileSync(join(qwenDir(), 'qwen-v_maerin.pt'), 'utf8')).toBe('LIVE');
  });

  it('promote-voice 400s on a previewVoiceId that is not this character’s preview', async () => {
    const res = await request(app)
      .post(`/api/books/${bookId}/cast/maerin/promote-voice`)
      .send({ previewVoiceId: 'qwen-someone-else-preview', sampleVoiceId: 'v_maerin', modelKey: QWEN_KEY });
    expect(res.status).toBe(400);
  });

  it('discard-voice removes the staged preview and never touches the live voice', async () => {
    stagedPreviewArtifacts('qwen-v_maerin-preview');
    /* A live voice exists alongside the preview — it must survive. */
    writeFileSync(join(qwenDir(), 'qwen-v_maerin.pt'), 'LIVE');
    const res = await request(app)
      .post(`/api/books/${bookId}/cast/maerin/discard-voice`)
      .send({ previewVoiceId: 'qwen-v_maerin-preview', sampleVoiceId: 'v_maerin', modelKey: QWEN_KEY });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(existsSync(join(qwenDir(), 'qwen-v_maerin-preview.pt'))).toBe(false);
    expect(existsSync(join(qwenDir(), 'qwen-v_maerin-preview.json'))).toBe(false);
    expect(readFileSync(join(qwenDir(), 'qwen-v_maerin.pt'), 'utf8')).toBe('LIVE');
  });

  it('discard-voice also erases the preview’s retained reference clip (fix wave, §2.3 consent gap)', async () => {
    stagedPreviewArtifacts('qwen-v_maerin-preview');
    writeFileSync(join(qwenDir(), 'qwen-v_maerin-preview__master.wav'), 'REF-CLIP');

    const res = await request(app)
      .post(`/api/books/${bookId}/cast/maerin/discard-voice`)
      .send({ previewVoiceId: 'qwen-v_maerin-preview', sampleVoiceId: 'v_maerin', modelKey: QWEN_KEY });

    expect(res.status).toBe(200);
    expect(existsSync(join(qwenDir(), 'qwen-v_maerin-preview__master.wav'))).toBe(false);
  });
});

/* #1981, Task 7 — promote-voice's stale-variants teardown write races
   POST /voice-library/:voiceUuid/assign for a DIFFERENT character of the same
   book. Unlocked, each side's own `readJson` can land before the other side's
   write, so whichever side writes LAST replays a `characters` snapshot that
   predates the other's write and silently drops it — which side loses
   depends on interleaving (measured: promote-voice's own teardown was the
   one lost, not assign's), so both survival assertions below matter, not
   just one. Locked, promote-voice re-reads fresh cast.json inside
   `withCastLock`, so both mutations survive regardless of interleaving.

   #1981 race-hardening round (Aug 2026) — a bare `Promise.all` of the two
   requests (the original shape of this test) does NOT interleave reliably:
   measured at ~50% per-trial detection (15 red / 30 external runs,
   `withCastLock` mutated to a pass-through, `--retry=0`) — the prior header
   comment's "interleaves deterministically" claim did not hold up under
   measurement. Every OTHER race test hardened in this same round measured
   20/20 deterministic on this box (see the hardening report's table), so
   this one is a genuine outlier: promote-voice's handler does several real
   file renames plus a sidecar-evict `fetch` between its OWN two `readJson`
   calls, which is enough async distance for the interleaving to go either
   way depending on OS/fs scheduling.

   A naive fix — loop the bare-`Promise.all` trial N times and require every
   trial to pass — does NOT work here either, and was tried first: repeating
   the trial WITHIN one vitest process is not independent sampling. Diagnostic
   instrumentation across 25 in-process repeats showed only the FIRST trial
   ever caught the miss; trials 2–25 consistently "passed" once the process's
   JIT/fs-thread-pool state settled — a process-level correlation invisible to
   a per-trial probability model. 25 external re-runs of that loop-based
   version still went green 9/20 times, i.e. no better than the original
   single-trial test.

   The fix that actually reproduces the bug on demand: SCRIPT the
   interleaving deterministically, the same technique
   book-state-preserve-voices.test.ts's own #1981 race test uses for its
   asymmetric-preamble PUT-vs-assign race. Intercept the SECOND call to
   `readJson` for this book's cast.json — promote-voice's own "fresh read"
   inside its (real) `withCastLock` span, the one whose snapshot the
   teardown write is based on — read the real bytes immediately (so the read
   genuinely happens-before assign's write, matching the bug's precondition)
   but hold the JS-visible resolution open behind a manually-released gate.
   /assign then gets a generous one-directional head start: it completes
   fully when unlocked (the bug window) or queues behind promote-voice's
   still-held lock when locked (the fix) — either way nothing depends on
   tuning a tight timing window. This lands a single trial, deterministically,
   in the same 200-of-200-class category the cast-lock.ts docstring cites for
   the base primitive — no in-process repetition needed, and none of the
   process-correlation risk that repetition carries. Confirmed empirically:
   20/20 external re-runs of THIS version go red against the same mutation
   (see the hardening report). */
describe('#1981 — promote-voice races /assign for a different character', () => {
  let vl: typeof import('../workspace/voice-library.js');
  let castJsonPath: typeof import('../workspace/paths.js').castJsonPath;

  beforeAll(async () => {
    /* voiceLibraryRouter itself is mounted in the file's top-level beforeAll,
       alongside the other routers this file shares — this describe still
       needs the workspace module + castJsonPath for its own test body. */
    const [voiceLibMod, { castJsonPath: cjp }] = await Promise.all([
      import('../workspace/voice-library.js'),
      import('../workspace/paths.js'),
    ]);
    vl = voiceLibMod;
    castJsonPath = cjp;
  });

  it('#1981 — keeps both promote-voice’s variant teardown and a concurrent /assign on a different character', async () => {
    const qwenDir = () => join(workspaceRoot, 'voices', 'qwen');
    mkdirSync(qwenDir(), { recursive: true });
    writeFileSync(join(qwenDir(), 'qwen-v_maerin-preview.pt'), 'EMBEDDING');
    writeFileSync(
      join(qwenDir(), 'qwen-v_maerin-preview.json'),
      JSON.stringify({ voiceId: 'qwen-v_maerin-preview', instruct: 'a brand new take' }),
    );
    /* maerin needs a non-empty `variants` map or promote-voice never takes
       the cast lock at all (Task 7 brief — the write is guarded on
       `variants` being non-empty). */
    const withVariants = characters.map((c) =>
      c.id === 'maerin'
        ? {
            ...c,
            overrideTtsVoices: {
              qwen: {
                name: 'qwen-v_maerin',
                variants: { angry: { name: 'qwen-v_maerin__angry' } },
              },
            },
          }
        : c,
    );
    const bookDir = join(workspaceRoot, 'books', AUTHOR, SERIES, BOOK);
    writeFileSync(
      join(bookDir, '.audiobook', 'cast.json'),
      JSON.stringify({ characters: withVariants }),
    );

    const raceVoiceUuid = 'race-assign-promote-1';
    await vl.writeEntry({
      voiceUuid: raceVoiceUuid,
      name: 'Race Assign Voice',
      provenance: 'imported',
      tags: [],
      pinned: false,
      engines: {},
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    });

    /* Script the interleaving: hold promote-voice's SECOND `readJson` call
       for this book's cast.json (its fresh, in-lock read) open until assign
       has had a generous chance to write. See this describe's header
       comment for the full rationale. */
    const stateIo = await import('../workspace/state-io.js');
    const actual = await vi.importActual<typeof import('../workspace/state-io.js')>(
      '../workspace/state-io.js',
    );
    const raceCastPath = castJsonPath(bookDir);
    let released!: () => void;
    const gate = new Promise<void>((resolve) => {
      released = resolve;
    });
    let callsForCastPath = 0;
    let interceptedSecondRead = false;
    const spy = vi.mocked(stateIo.readJson).mockImplementation(async (path: string) => {
      if (path !== raceCastPath) return actual.readJson(path);
      callsForCastPath += 1;
      /* Call #1 is the top-of-handler character lookup, made before any of
         promote-voice's file-rename dance — let it through untouched. Call
         #2 is the fresh, in-lock read the teardown write is based on. */
      if (callsForCastPath === 2) {
        interceptedSecondRead = true;
        const value = await actual.readJson(path); // real bytes, now — happens-before assign's write
        await gate; // hold the RESOLUTION open until released below
        return value;
      }
      return actual.readJson(path);
    });

    let resPromote: request.Response;
    let resAssign: request.Response;
    try {
      const promotePromise = request(app)
        .post(`/api/books/${bookId}/cast/maerin/promote-voice`)
        .send({ previewVoiceId: 'qwen-v_maerin-preview', sampleVoiceId: 'v_maerin', modelKey: QWEN_KEY });
      promotePromise.catch(() => {}); // supertest is lazy — force real dispatch now
      // Let promote-voice run its file-rename dance and reach (and get stuck
      // behind) its second, intercepted read.
      await new Promise((r) => setTimeout(r, 50));
      expect(interceptedSecondRead).toBe(true);

      const assignPromise = request(app)
        .post(`/api/voice-library/${raceVoiceUuid}/assign`)
        .send({ bookId, characterId: 'nopersona' });
      assignPromise.catch(() => {}); // force dispatch now (see above)
      // Generous head start: completes fully when unlocked, queues harmlessly
      // behind promote-voice's held lock when locked. Not a tight window.
      await new Promise((r) => setTimeout(r, 50));

      released();
      [resPromote, resAssign] = await Promise.all([promotePromise, assignPromise]);
    } finally {
      // Not `mockRestore()` — this is a `vi.fn()` wrapper (from the hoisted
      // `vi.mock` factory), not a `vi.spyOn` spy — restore its default
      // passthrough behaviour explicitly.
      spy.mockImplementation(actual.readJson);
    }

    expect(resPromote.status).toBe(200);
    expect(resAssign.status).toBe(200);

    const cast = readCast();
    const maerin = cast.characters.find((c) => c.id === 'maerin')!;
    const nopersona = cast.characters.find((c) => c.id === 'nopersona')!;
    const maerinQwen = maerin.overrideTtsVoices as { qwen: { name: string; variants?: unknown } };
    /* promote-voice's own mutation survived: variants dropped, base kept. */
    expect(maerinQwen.qwen.variants).toBeUndefined();
    expect(maerinQwen.qwen.name).toBe('qwen-v_maerin');
    /* assign's own mutation survived too — the lost-update this test pins. */
    const nopersonaQwen = nopersona.overrideTtsVoices as { qwen?: { libraryUuid?: string } } | undefined;
    expect(nopersonaQwen?.qwen?.libraryUuid).toBe(raceVoiceUuid);
  });
});

describe('#1981 — ensureCharacterVoiceUuid races a non-design cast writer', () => {
  /* ensureCharacterVoiceUuid's whole book-scoped body sits inside
     `withDesignLock(bookDir)`, which serialises it only against OTHER
     design-lock holders (other designs on this book). It does nothing
     against a writer that never takes the design lock at all — cast-aliases'
     add-alias, which takes only the cast lock. Before this task's fix, the
     uuid mint reads cast.json once (no cast lock), so a concurrent add-alias
     that lands between that read and the eventual write is silently
     clobbered when the mint's own writeJsonAtomic replays the stale
     snapshot. Race it directly (not via HTTP) against the real add-alias
     route on the SAME book, a DIFFERENT character, so the two writes don't
     collide on which character index changes — only on whether the whole
     file survives intact. castAliasesRouter is mounted in the file's
     top-level beforeAll, alongside the other routers this file shares. */
  it('#1981 — an add-alias write on a different character survives a concurrent voiceUuid mint on this book', async () => {
    const bookDir = join(workspaceRoot, 'books', AUTHOR, SERIES, BOOK);

    const { ensureCharacterVoiceUuid: ensureFn } = await import('./qwen-voice.js');
    const stateIo = await import('../workspace/state-io.js');
    const actual = await vi.importActual<typeof import('../workspace/state-io.js')>(
      '../workspace/state-io.js',
    );
    const { castJsonPath } = await import('../workspace/paths.js');
    const raceCastPath = castJsonPath(bookDir);

    let released!: () => void;
    const gate = new Promise<void>((resolve) => {
      released = resolve;
    });
    let callsForCastPath = 0;
    let intercepted = false;
    const spy = vi.mocked(stateIo.readJson).mockImplementation(async (path: string) => {
      if (path !== raceCastPath) return actual.readJson(path);
      callsForCastPath += 1;
      /* Call #1 is the outer early-out read (lets it through — it's the
         optimisation, not the write's basis). Call #2 is the fresh,
         in-lock read the mint's own write is based on — hold it open so
         add-alias gets a real chance to run underneath. Any later call
         (add-alias's own read) passes straight through. */
      if (callsForCastPath === 2) {
        intercepted = true;
        const value = await actual.readJson(path); // real bytes, now — happens-before add-alias's write
        await gate; // hold the RESOLUTION open until released below
        return value;
      }
      return actual.readJson(path);
    });

    let uuidPromise: Promise<string | undefined> | undefined;
    let aliasPromise: request.Test | undefined;
    let aliasRes: request.Response;
    try {
      uuidPromise = ensureFn(bookDir, 'nopersona');
      uuidPromise.catch(() => {});
      const deadline = Date.now() + 2000;
      while (!intercepted && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 5));
      }
      expect(intercepted).toBe(true);

      aliasPromise = request(app)
        .post(`/api/books/${bookId}/cast/add-alias`)
        .send({ characterId: 'maerin', aliasName: 'The Wanderer' });
      aliasPromise.catch(() => {});
      // Generous head start: completes fully when unlocked, queues harmlessly
      // behind the held lock when locked. Not a tight window either way.
      await new Promise((r) => setTimeout(r, 50));

      released();
      [, aliasRes] = await Promise.all([uuidPromise, aliasPromise]);
    } finally {
      // Idempotent — also fires here so a throw ANYWHERE above still releases
      // a held `readJson` rather than leaving it stuck on `await gate` forever.
      released();
      // Not `mockRestore()` — this is a `vi.fn()` wrapper (from the hoisted
      // `vi.mock` factory above), not a `vi.spyOn` spy, so restore its
      // default passthrough behaviour explicitly.
      spy.mockImplementation(actual.readJson);
      // On the failure path (an assertion above threw) these are still
      // in-flight — await them so the test can't return while the mint is
      // still running against fixtures `afterAll` is about to delete.
      await Promise.allSettled([uuidPromise, aliasPromise]);
    }

    expect(aliasRes.status).toBe(200);
    const cast = readCast();
    const maerin = cast.characters.find((c) => c.id === 'maerin')!;
    /* add-alias's own mutation survived — the lost-update this test pins. */
    expect(maerin.aliases).toContain('The Wanderer');
    /* the mint's own write survived too — read back from disk, not merely
       inferred from the race not throwing (a silent no-op write would still
       pass every assertion above). */
    const nopersona = cast.characters.find((c) => c.id === 'nopersona')!;
    expect(nopersona.voiceUuid).toBeTruthy();
  });
});

describe('DELETE /api/books/:bookId/cast/:characterId/emotion-variant/:emotion (fs-34)', () => {
  const qwenDir = () => join(workspaceRoot, 'voices', 'qwen');

  /* Seed maerin with TWO designed variants (angry + sad) on cast.json + disk,
     alongside the base voice — so a delete can be shown to drop exactly one. */
  function seedVariants() {
    mkdirSync(qwenDir(), { recursive: true });
    for (const id of ['qwen-v_maerin', 'qwen-v_maerin__angry', 'qwen-v_maerin__sad']) {
      writeFileSync(join(qwenDir(), `${id}.pt`), 'EMBEDDING');
      writeFileSync(join(qwenDir(), `${id}.json`), JSON.stringify({ voiceId: id }));
    }
    const withVariants = characters.map((c) =>
      c.id === 'maerin'
        ? {
            ...c,
            overrideTtsVoices: {
              qwen: {
                name: 'qwen-v_maerin',
                variants: {
                  angry: { name: 'qwen-v_maerin__angry' },
                  sad: { name: 'qwen-v_maerin__sad' },
                },
              },
            },
          }
        : c,
    );
    writeFileSync(
      join(workspaceRoot, 'books', AUTHOR, SERIES, BOOK, '.audiobook', 'cast.json'),
      JSON.stringify({ characters: withVariants }),
    );
  }

  it('drops the variant from cast.json + deletes its .pt/.json, leaving base + siblings intact', async () => {
    seedVariants();
    const res = await request(app).delete(`/api/books/${bookId}/cast/maerin/emotion-variant/angry`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, removed: 'angry' });

    const maerin = readCast().characters.find((c) => c.id === 'maerin')!;
    const qwen = maerin.overrideTtsVoices as { qwen: { name: string; variants?: Record<string, unknown> } };
    expect(qwen.qwen.variants).toEqual({ sad: { name: 'qwen-v_maerin__sad' } });
    expect(qwen.qwen.name).toBe('qwen-v_maerin'); // base untouched

    expect(existsSync(join(qwenDir(), 'qwen-v_maerin__angry.pt'))).toBe(false);
    expect(existsSync(join(qwenDir(), 'qwen-v_maerin__angry.json'))).toBe(false);
    // Sibling + base files survive.
    expect(existsSync(join(qwenDir(), 'qwen-v_maerin__sad.pt'))).toBe(true);
    expect(existsSync(join(qwenDir(), 'qwen-v_maerin.pt'))).toBe(true);
  });

  it('clears the whole variants map (and badge) when the last variant is removed', async () => {
    mkdirSync(qwenDir(), { recursive: true });
    writeFileSync(join(qwenDir(), 'qwen-v_maerin__angry.pt'), 'E');
    const onlyAngry = characters.map((c) =>
      c.id === 'maerin'
        ? { ...c, overrideTtsVoices: { qwen: { name: 'qwen-v_maerin', variants: { angry: { name: 'qwen-v_maerin__angry' } } } } }
        : c,
    );
    writeFileSync(
      join(workspaceRoot, 'books', AUTHOR, SERIES, BOOK, '.audiobook', 'cast.json'),
      JSON.stringify({ characters: onlyAngry }),
    );

    const res = await request(app).delete(`/api/books/${bookId}/cast/maerin/emotion-variant/angry`);
    expect(res.status).toBe(200);
    const qwen = readCast().characters.find((c) => c.id === 'maerin')!.overrideTtsVoices as {
      qwen: { name: string; variants?: unknown };
    };
    expect(qwen.qwen.variants).toBeUndefined();
    expect(qwen.qwen.name).toBe('qwen-v_maerin');
  });

  it('400s on an emotion outside the variant enum (incl. neutral)', async () => {
    seedVariants();
    expect((await request(app).delete(`/api/books/${bookId}/cast/maerin/emotion-variant/furious`)).status).toBe(400);
    expect((await request(app).delete(`/api/books/${bookId}/cast/maerin/emotion-variant/neutral`)).status).toBe(400);
  });

  it('404s for an unknown book or character', async () => {
    seedVariants();
    expect((await request(app).delete(`/api/books/nope/cast/maerin/emotion-variant/angry`)).status).toBe(404);
    expect((await request(app).delete(`/api/books/${bookId}/cast/ghost/emotion-variant/angry`)).status).toBe(404);
  });

  it('is idempotent — removing an absent variant still returns 200', async () => {
    // maerin has no variants in the default cast (beforeEach wrote it).
    const res = await request(app).delete(`/api/books/${bookId}/cast/maerin/emotion-variant/excited`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, removed: 'excited' });
  });

  /* #1981 — two concurrent DELETE emotion-variant calls for DIFFERENT
     characters in the SAME book race that book's cast.json. Unlocked, both
     requests' readJson resolve before either writeJsonAtomic lands, so the
     later write replays a `characters` snapshot taken before the earlier
     write happened and silently drops it — one character's variant map
     reverts to its pre-delete state. `nopersona` gets its own qwen override
     here (it has none by default) purely so it has a second, independent
     variant to delete; tearDownEmotionVariant's own file/sidecar cleanup is
     `{ force: true }` / try-catch best-effort, so this doesn't need matching
     .pt/.json fixtures on disk. */
  it('#1981 — keeps both deletions when two emotion-variant deletes for one book overlap', async () => {
    seedVariants();
    const withSecond = readCast().characters.map((c) =>
      c.id === 'nopersona'
        ? {
            ...c,
            overrideTtsVoices: {
              qwen: {
                name: 'qwen-nopersona',
                variants: { sad: { name: 'qwen-nopersona__sad' } },
              },
            },
          }
        : c,
    );
    writeFileSync(
      join(workspaceRoot, 'books', AUTHOR, SERIES, BOOK, '.audiobook', 'cast.json'),
      JSON.stringify({ characters: withSecond }),
    );

    const [resMaerin, resNopersona] = await Promise.all([
      request(app).delete(`/api/books/${bookId}/cast/maerin/emotion-variant/angry`),
      request(app).delete(`/api/books/${bookId}/cast/nopersona/emotion-variant/sad`),
    ]);
    expect(resMaerin.status).toBe(200);
    expect(resNopersona.status).toBe(200);

    const cast = readCast();
    const maerin = cast.characters.find((c) => c.id === 'maerin')!;
    const nopersona = cast.characters.find((c) => c.id === 'nopersona')!;
    const maerinQwen = maerin.overrideTtsVoices as { qwen: { variants?: Record<string, unknown> } };
    const nopersonaQwen = nopersona.overrideTtsVoices as {
      qwen: { variants?: Record<string, unknown> };
    };
    /* maerin: angry removed, sad survives. */
    expect(maerinQwen.qwen.variants).toEqual({ sad: { name: 'qwen-v_maerin__sad' } });
    /* nopersona: its only variant (sad) removed → whole map cleaned up. */
    expect(nopersonaQwen.qwen.variants).toBeUndefined();
  });

  /* C1 — the teardown's sidecar `fetch` (inside tearDownEmotionVariant) has
     no reason to hold the cast lock across it: it's a best-effort network
     call (#2127 bounds it with EVICT_FETCH_TIMEOUT_MS, but even that bounded
     wait shouldn't pin the lock) — the same defect class promote-voice's own
     "Narrow by design" comment (above, on its withCastLock call) already
     fixes for its teardown. Proves the fix the same way voice-style.test.ts's
     own #1981 lock-narrowing races do (`/generate-all no longer holds the
     book lock across the whole batch`, `/generate no longer holds the book
     lock across the LLM call`): delay the sidecar call artificially and
     assert a concurrent cast write on the SAME book (add-alias) lands
     quickly rather than waiting for it.

     Re-review (2026-08) found the original fixed 50ms warm-up sleep could
     lie: the evict actually starts at ~20ms, a ~2.5x margin, and with the
     defect reintroduced plus the warm-up shrunk to 0ms, 1 of 6 runs still
     passed — a silent false green under load (this box regularly runs
     several concurrent worktree batteries). Replaced with a deferred that
     the evict's own `mockImplementation` resolves the instant it's invoked,
     so the concurrent add-alias fires exactly when the evict has genuinely
     started — no guessed margin, no flake window. */
  it('C1 — releases the cast lock before the sidecar evict, so a concurrent add-alias on the same book lands quickly', async () => {
    seedVariants();
    const EVICT_DELAY_MS = 300;
    /* #2127 composition check — this test's whole point is a DELAYED but
       SUCCESSFUL evict (the lock-release timing), not one that gets aborted
       by the new EVICT_FETCH_TIMEOUT_MS bound. Assert the artificial delay
       stays well under it; the mocked `fetch` below doesn't honor the real
       AbortSignal anyway (it ignores `init` entirely), so this is a guard
       against the two constants drifting into each other, not a behavioural
       dependency. */
    const { EVICT_FETCH_TIMEOUT_MS } = await import('./qwen-voice.js');
    expect(EVICT_DELAY_MS).toBeLessThan(EVICT_FETCH_TIMEOUT_MS);
    let resolveEvictStarted: () => void;
    const evictStarted = new Promise<void>((resolve) => {
      resolveEvictStarted = resolve;
    });
    fetchMock.mockImplementation(async (url: unknown) => {
      if (String(url).endsWith('/qwen/evict-voice')) {
        resolveEvictStarted();
        await new Promise((r) => setTimeout(r, EVICT_DELAY_MS));
      }
      return { ok: true };
    });

    const deletePromise = request(app).delete(
      `/api/books/${bookId}/cast/maerin/emotion-variant/angry`,
    );
    deletePromise.catch(() => {}); // supertest is lazy — force real dispatch now

    // Deterministic warm-up: wait for the evict fetch to actually have been
    // invoked (whether the lock is still held at that point, pre-fix, or
    // already released, post-fix) rather than guessing a fixed delay is
    // enough for the DELETE handler to get there.
    await evictStarted;

    const start = Date.now();
    const addAliasRes = await request(app)
      .post(`/api/books/${bookId}/cast/add-alias`)
      .send({ characterId: 'nopersona', aliasName: 'Quick' });
    const elapsed = Date.now() - start;

    expect(addAliasRes.status).toBe(200);
    /* Under the pre-fix shape the evict ran INSIDE the lock, so add-alias's
       own withCastLock call couldn't even start until the evict resolved —
       >= EVICT_DELAY_MS. Generous headroom under that while staying well
       above the few ms a genuinely-unlocked add-alias takes. */
    expect(elapsed).toBeLessThan(EVICT_DELAY_MS - 100);

    const deleteRes = await deletePromise;
    expect(deleteRes.status).toBe(200);
    const maerin = readCast().characters.find((c) => c.id === 'maerin')!;
    const maerinQwen = maerin.overrideTtsVoices as { qwen: { variants?: Record<string, unknown> } };
    expect(maerinQwen.qwen.variants).toEqual({ sad: { name: 'qwen-v_maerin__sad' } });
  });

  /* #2127 — the evict fetches (inside tearDownEmotionVariant, and
     promote-voice's own direct evict) had no AbortSignal, so a sidecar that
     accepts the TCP connection but never responds (blocked mid model
     load/recycle — routine on this box) hung the triggering request for up
     to undici's ~300s default, even though cast.json had already been
     written successfully before the teardown ran. Proves the fix directly: a
     sidecar mock that never resolves (and never rejects) on its own must
     still let the DELETE respond, bounded by EVICT_FETCH_TIMEOUT_MS rather
     than that ~300s hang. The mock only settles via the real `AbortSignal`
     the route passes — exactly how undici itself behaves — so this only
     passes if the signal is genuinely wired through, not just present. */
  it('#2127 — a sidecar evict that never responds does not hang the DELETE past the eviction timeout', async () => {
    seedVariants();
    const { EVICT_FETCH_TIMEOUT_MS } = await import('./qwen-voice.js');
    fetchMock.mockImplementation((url: unknown, init?: unknown) => {
      if (String(url).endsWith('/qwen/evict-voice')) {
        return new Promise((_resolve, reject) => {
          const signal = (init as { signal?: AbortSignal } | undefined)?.signal;
          signal?.addEventListener('abort', () => {
            const err = new Error('The operation was aborted.');
            err.name = 'AbortError';
            reject(err);
          });
          // Deliberately never settles on its own — mimics a sidecar that
          // accepted the connection but is blocked.
        });
      }
      return Promise.resolve({ ok: true });
    });

    const start = Date.now();
    const res = await request(app).delete(
      `/api/books/${bookId}/cast/maerin/emotion-variant/angry`,
    );
    const elapsed = Date.now() - start;

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, removed: 'angry' });
    /* Bounded by the timeout, not by undici's ~300s default. Generous
       headroom above EVICT_FETCH_TIMEOUT_MS for the abort machinery + route
       handling itself; nowhere near the untimed-out hang this closes. */
    expect(elapsed).toBeGreaterThanOrEqual(EVICT_FETCH_TIMEOUT_MS - 200);
    expect(elapsed).toBeLessThan(EVICT_FETCH_TIMEOUT_MS + 2_000);

    /* cast.json was still written successfully — a timed-out best-effort
       evict must never turn a successful write into an error response. */
    const maerin = readCast().characters.find((c) => c.id === 'maerin')!;
    const maerinQwen = maerin.overrideTtsVoices as { qwen: { variants?: Record<string, unknown> } };
    expect(maerinQwen.qwen.variants).toEqual({ sad: { name: 'qwen-v_maerin__sad' } });
  });
});

describe('persistEmotionVariant', () => {
  /* These tests import persistEmotionVariant and exercise it directly against a
     temp bookDir — isolated from the supertest Express fixture above so they do
     not depend on WORKSPACE_DIR or the sidecar mock. */
  let bookDir: string;
  /* A second temp dir whose character has NO pre-existing qwen override slot —
     exercises the bootstrap-from-derived-base-id default branch. */
  let bookDirFresh: string;
  let persistEmotionVariantFn: typeof import('./qwen-voice.js').persistEmotionVariant;
  let deriveQwenVoiceIdFn: typeof import('./qwen-voice.js').deriveQwenVoiceId;

  beforeAll(async () => {
    ({ persistEmotionVariant: persistEmotionVariantFn, deriveQwenVoiceId: deriveQwenVoiceIdFn } =
      await import('./qwen-voice.js'));
  });

  beforeEach(async () => {
    const { mkdtemp, mkdir, writeFile } = await import('node:fs/promises');
    bookDir = await mkdtemp(join(tmpdir(), 'cast-'));
    await mkdir(join(bookDir, '.audiobook'), { recursive: true });
    await writeFile(
      join(bookDir, '.audiobook', 'cast.json'),
      JSON.stringify({
        characters: [
          { id: 'wren', voiceId: 'wren', overrideTtsVoices: { qwen: { name: 'qwen-wren' } } },
        ],
      }),
    );

    bookDirFresh = await mkdtemp(join(tmpdir(), 'cast-fresh-'));
    await mkdir(join(bookDirFresh, '.audiobook'), { recursive: true });
    await writeFile(
      join(bookDirFresh, '.audiobook', 'cast.json'),
      JSON.stringify({
        /* No overrideTtsVoices at all — exercises the slot-bootstrap path. */
        characters: [{ id: 'fresh', voiceId: 'fresh_voice' }],
      }),
    );
  });

  afterEach(async () => {
    const { rm } = await import('node:fs/promises');
    await rm(bookDir, { recursive: true, force: true });
    await rm(bookDirFresh, { recursive: true, force: true });
  });

  it('records the variant slot without clobbering the base name', async () => {
    const { readFile } = await import('node:fs/promises');
    await persistEmotionVariantFn(bookDir, 'wren', 'angry', 'qwen-wren__angry');
    const cast = JSON.parse(await readFile(join(bookDir, '.audiobook', 'cast.json'), 'utf8'));
    expect(cast.characters[0].overrideTtsVoices.qwen.name).toBe('qwen-wren');
    expect(cast.characters[0].overrideTtsVoices.qwen.variants.angry).toEqual({
      name: 'qwen-wren__angry',
    });
  });

  it('preserves a sibling variant when adding another', async () => {
    const { readFile } = await import('node:fs/promises');
    await persistEmotionVariantFn(bookDir, 'wren', 'angry', 'qwen-wren__angry');
    await persistEmotionVariantFn(bookDir, 'wren', 'sad', 'qwen-wren__sad');
    const cast = JSON.parse(await readFile(join(bookDir, '.audiobook', 'cast.json'), 'utf8'));
    expect(Object.keys(cast.characters[0].overrideTtsVoices.qwen.variants).sort()).toEqual([
      'angry',
      'sad',
    ]);
  });

  it('is a no-op for an unknown character', async () => {
    const { readFile } = await import('node:fs/promises');
    await persistEmotionVariantFn(bookDir, 'ghost', 'angry', 'x');
    const cast = JSON.parse(await readFile(join(bookDir, '.audiobook', 'cast.json'), 'utf8'));
    expect(cast.characters[0].overrideTtsVoices.qwen.variants).toBeUndefined();
  });

  it('bootstraps the qwen slot with the derived base name when absent', async () => {
    const { readFile } = await import('node:fs/promises');
    /* The character has no overrideTtsVoices at all — the helper must derive the
       base voiceId and bootstrap `{ name: <derived> }` before recording the variant. */
    const expectedBaseName = deriveQwenVoiceIdFn({ id: 'fresh', voiceId: 'fresh_voice' } as any, 'fresh');
    const variantVoiceId = `${expectedBaseName}__angry`;
    await persistEmotionVariantFn(bookDirFresh, 'fresh', 'angry', variantVoiceId);
    const cast = JSON.parse(await readFile(join(bookDirFresh, '.audiobook', 'cast.json'), 'utf8'));
    expect(cast.characters[0].overrideTtsVoices.qwen.name).toBe(expectedBaseName);
    expect(cast.characters[0].overrideTtsVoices.qwen.variants.angry).toEqual({ name: variantVoiceId });
  });

  it('#1981 — two concurrent variant writes for the same character both survive (no design lock covers this path)', async () => {
    /* Unlike ensureCharacterVoiceUuid, persistEmotionVariant carries NO design
       lock at all — so the ordinary self-vs-self shape is a valid race here:
       two concurrent book-scoped calls for the SAME character (different
       emotions) is a classic read-modify-write collision if neither takes the
       cast lock. Script the interleaving: hold the FIRST call's read open
       until the second call's write has landed, then release — pre-fix, the
       first call's writeJsonAtomic replays a stale snapshot (no 'sad' slot);
       post-fix its cast-lock body re-reads fresh and merges both. */
    const stateIo = await import('../workspace/state-io.js');
    const actual = await vi.importActual<typeof import('../workspace/state-io.js')>(
      '../workspace/state-io.js',
    );
    const { castJsonPath } = await import('../workspace/paths.js');
    const raceCastPath = castJsonPath(bookDir);

    let released!: () => void;
    const gate = new Promise<void>((resolve) => {
      released = resolve;
    });
    let callsForCastPath = 0;
    let intercepted = false;
    const spy = vi.mocked(stateIo.readJson).mockImplementation(async (path: string) => {
      if (path !== raceCastPath) return actual.readJson(path);
      callsForCastPath += 1;
      /* Call #1 is 'angry''s outer early-out read (lets it through — it's
         the optimisation, not the write's basis). Call #2 is 'angry''s
         fresh, in-lock read the write is based on — hold it open so 'sad'
         gets a real chance to run underneath. Any later call ('sad''s own
         read) passes straight through. */
      if (callsForCastPath === 2) {
        intercepted = true;
        const value = await actual.readJson(path); // real bytes, now — happens-before 'sad''s write
        await gate; // hold the RESOLUTION open until released below
        return value;
      }
      return actual.readJson(path);
    });

    let angryPromise: Promise<void> | undefined;
    let sadPromise: Promise<void> | undefined;
    try {
      angryPromise = persistEmotionVariantFn(bookDir, 'wren', 'angry', 'qwen-wren__angry');
      angryPromise.catch(() => {});
      const deadline = Date.now() + 2000;
      while (!intercepted && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 5));
      }
      expect(intercepted).toBe(true);

      sadPromise = persistEmotionVariantFn(bookDir, 'wren', 'sad', 'qwen-wren__sad');
      sadPromise.catch(() => {});
      // Generous head start: completes fully when unlocked, queues harmlessly
      // behind the held lock when locked. Not a tight window either way.
      await new Promise((r) => setTimeout(r, 50));

      released();
      await Promise.all([angryPromise, sadPromise]);
    } finally {
      // Idempotent — also fires here so a throw ANYWHERE above still releases
      // a held `readJson` rather than leaving it stuck on `await gate` forever.
      released();
      // Not `mockRestore()` — this is a `vi.fn()` wrapper (from the hoisted
      // `vi.mock` factory above), not a `vi.spyOn` spy, so restore its
      // default passthrough behaviour explicitly.
      spy.mockImplementation(actual.readJson);
      // On the failure path (an assertion above threw) these are still
      // in-flight — await them so the test can't return while a write is
      // still running against the fixture `afterEach` is about to delete.
      await Promise.allSettled([angryPromise, sadPromise]);
    }

    const { readFile } = await import('node:fs/promises');
    const cast = JSON.parse(await readFile(join(bookDir, '.audiobook', 'cast.json'), 'utf8'));
    const variants = cast.characters[0].overrideTtsVoices.qwen.variants;
    /* Both writers' own mutations survived — the lost-update this test pins. */
    expect(variants.angry).toEqual({ name: 'qwen-wren__angry' });
    expect(variants.sad).toEqual({ name: 'qwen-wren__sad' });
  });
});

describe('evaluateDesignLiveness', () => {
  /* Import dynamically to avoid loading qwen-voice.ts (and its workspace/paths
     transitive dep) at test-module parse time — paths.ts captures WORKSPACE_DIR
     once at load, so a static top-level import here would race beforeAll's env setup. */
  let evaluateDesignLiveness: typeof import('./qwen-voice.js').evaluateDesignLiveness;
  beforeAll(async () => {
    ({ evaluateDesignLiveness } = await import('./qwen-voice.js'));
  });

  const T0 = 1_000_000;
  it('continues while the sidecar is reachable and under the ceiling', () => {
    expect(
      evaluateDesignLiveness({ startedAt: T0, now: T0 + 200_000, health: 'reachable', absoluteMaxMs: 600_000 }),
    ).toEqual({ action: 'continue' });
  });
  it('aborts as unreachable when the sidecar /health is down', () => {
    expect(
      evaluateDesignLiveness({ startedAt: T0, now: T0 + 200_000, health: 'unreachable', absoluteMaxMs: 600_000 }),
    ).toEqual({ action: 'abort', reason: 'unreachable' });
  });
  it('aborts on the absolute ceiling even if the sidecar still pings', () => {
    expect(
      evaluateDesignLiveness({ startedAt: T0, now: T0 + 600_001, health: 'reachable', absoluteMaxMs: 600_000 }),
    ).toEqual({ action: 'abort', reason: 'absolute' });
  });
  it('prefers unreachable over absolute when both conditions are true', () => {
    /* A sidecar that disappears exactly at the ceiling should report the more
       informative 'unreachable' reason, not the generic 'absolute' ceiling. */
    expect(
      evaluateDesignLiveness({ startedAt: T0, now: T0 + 600_001, health: 'unreachable', absoluteMaxMs: 600_000 }),
    ).toEqual({ action: 'abort', reason: 'unreachable' });
  });
});

describe('qwenVoicePtPath containment', () => {
  it('rejects a poisoned voice name', async () => {
    const { qwenVoicePtPath } = await import('./qwen-voice.js');
    expect(() => qwenVoicePtPath('../../evil')).toThrow();
  });
});

describe('SidecarDesignError', () => {
  /* Call designQwenVoiceForCharacter directly so we can assert on the thrown
     error object — the HTTP route maps it to a 502, losing the shape. */
  let designQwenVoiceForCharacter: typeof import('./qwen-voice.js').designQwenVoiceForCharacter;
  let sdeBookDir: string;

  beforeAll(async () => {
    ({ designQwenVoiceForCharacter } = await import('./qwen-voice.js'));
  });

  beforeEach(async () => {
    const { mkdtemp, mkdir, writeFile } = await import('node:fs/promises');
    sdeBookDir = await mkdtemp(join(tmpdir(), 'sde-'));
    await mkdir(join(sdeBookDir, '.audiobook'), { recursive: true });
    await writeFile(
      join(sdeBookDir, '.audiobook', 'cast.json'),
      JSON.stringify({
        characters: [
          {
            id: 'char1',
            name: 'Char One',
            voiceId: 'v_char1',
            voiceUuid: 'uuid-char1',
            voiceStyle: 'a warm narrator',
            evidence: [{ quote: '"Hello there."' }],
          },
        ],
      }),
    );
  });

  afterEach(async () => {
    const { rm } = await import('node:fs/promises');
    await rm(sdeBookDir, { recursive: true, force: true });
  });

  function makeVariantParams(opts: { persona?: string } = {}): import('./qwen-voice.js').DesignQwenVoiceParams {
    return {
      bookDir: sdeBookDir,
      character: {
        id: 'char1',
        name: 'Char One',
        voiceId: 'v_char1',
        voiceUuid: 'uuid-char1',
        voiceStyle: 'a warm narrator',
        evidence: [{ quote: '"Hello there."' }],
        role: 'supporting',
      },
      characterId: 'char1',
      persona: opts.persona !== undefined ? opts.persona : 'a warm narrator',
      sampleVoiceId: 'v_char1',
      modelKey: QWEN_KEY,
      language: 'English',
      emotion: 'angry',
    };
  }

  it('throws SidecarDesignError carrying status/code/reason on a 503 (non-fallback code)', async () => {
    /* A 503 with a code that is NOT 'base17-unavailable' propagates as-is —
       no fallback is attempted. This tests the SidecarDesignError shape. */
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ code: 'sidecar-overloaded', reason: 'busy', detail: 'x' }), { status: 503 }),
    );
    await expect(
      designQwenVoiceForCharacter(makeVariantParams()),
    ).rejects.toMatchObject({ name: 'SidecarDesignError', status: 503, code: 'sidecar-overloaded' });
  });

  it('falls back to design-voice on 503 not-installed (no retry)', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({ code: 'base17-unavailable', reason: 'not-installed', detail: 'x' }), { status: 503 }))
      .mockResolvedValueOnce(new Response(Buffer.from([0, 0]), { status: 200, headers: { 'X-Sample-Rate': '24000' } }));
    const r = await designQwenVoiceForCharacter(makeVariantParams({ persona: 'a warm narrator' }));
    expect(r.fellBackToDesignVoice).toBe(true);
    expect(r.fallbackReason).toBe('not-installed');
    // exactly two fetches: mint (503) + design-voice (200) — NO retry
    const calls = fetchSpy.mock.calls.map((c) => String(c[0]));
    expect(calls.filter((u) => u.includes('/qwen/mint-variant'))).toHaveLength(1);
    const dvCall = fetchSpy.mock.calls.find((c) => String(c[0]).includes('/qwen/design-voice'))!;
    const sentBody = JSON.parse(String((dvCall[1] as RequestInit).body));
    // EMOTION_INSTRUCT is module-private; assert structurally instead of pasting
    // the (long, real) angry clause. The composed instruct is `${persona} ${clause}`.
    expect(sentBody.instruct.startsWith('a warm narrator ')).toBe(true);
    expect(sentBody.instruct.length).toBeGreaterThan('a warm narrator '.length);
    expect(sentBody.voiceId).toMatch(/__angry$/);
    expect(sentBody.mintMethod).toBe('design-voice-fallback');
  });

  it('falls back on 503 corrupt', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({ code: 'base17-unavailable', reason: 'corrupt', detail: 'x' }), { status: 503 }))
      .mockResolvedValueOnce(new Response(Buffer.from([0, 0]), { status: 200, headers: { 'X-Sample-Rate': '24000' } }));
    const r = await designQwenVoiceForCharacter(makeVariantParams({ persona: 'a warm narrator' }));
    expect(r.fallbackReason).toBe('corrupt');
  });

  it('does NOT fall back on a generic 500 (OOM)', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({ detail: 'Internal error.' }), { status: 500 }));
    await expect(designQwenVoiceForCharacter(makeVariantParams({ persona: 'p' }))).rejects.toThrow();
    expect(fetchSpy.mock.calls.some((c) => String(c[0]).includes('/qwen/design-voice'))).toBe(false);
  });

  it('declines the fallback when no persona is recoverable', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({ code: 'base17-unavailable', reason: 'not-installed', detail: 'x' }), { status: 503 }));
    // readJson stubbed to return no instruct (see setup)
    await expect(designQwenVoiceForCharacter(makeVariantParams({ persona: '' }))).rejects.toThrow(/no persona on disk/i);
  });

  it('empty persona but base .json HAS instruct → fallback uses it', async () => {
    // Write a sidecar JSON for the base voice with an instruct field
    const { mkdirSync: mkdirSyncSync, writeFileSync: wfs } = await import('node:fs');
    const { join: joinPath } = await import('node:path');
    const qwenDir = joinPath(workspaceRoot, 'voices', 'qwen');
    mkdirSyncSync(qwenDir, { recursive: true });
    // baseVoiceName = qwenStorageKey(character, characterId) = qwen-uuid-char1 (voiceUuid wins)
    // character has voiceUuid: 'uuid-char1', voiceId: 'v_char1' → qwen-uuid-char1
    wfs(joinPath(qwenDir, 'qwen-uuid-char1.json'), JSON.stringify({ voiceId: 'qwen-uuid-char1', instruct: 'a warm narrator from disk' }));

    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({ code: 'base17-unavailable', reason: 'not-installed', detail: 'x' }), { status: 503 }))
      .mockResolvedValueOnce(new Response(Buffer.from([0, 0]), { status: 200, headers: { 'X-Sample-Rate': '24000' } }));
    const r = await designQwenVoiceForCharacter(makeVariantParams({ persona: '' }));
    expect(r.fellBackToDesignVoice).toBe(true);
    const dvCall = fetchSpy.mock.calls.find((c) => String(c[0]).includes('/qwen/design-voice'))!;
    const sentBody = JSON.parse(String((dvCall[1] as RequestInit).body));
    expect(sentBody.instruct.startsWith('a warm narrator from disk ')).toBe(true);
  });

  describe('capacity-aware retry wiring (#1720 Task 7)', () => {
    /* withCapacityRetry is mocked wholesale rather than exercised for real
       (its retry/evict/exhaustion policy is already covered by
       server/src/gpu/capacity-retry.test.ts). The file-level beforeEach
       resets it back to a plain single-call passthrough; these tests
       override that locally to pin postDesignAndCache's wiring. */
    function makeBaseParams(opts: { persona?: string } = {}): import('./qwen-voice.js').DesignQwenVoiceParams {
      return {
        bookDir: sdeBookDir,
        character: {
          id: 'char1',
          name: 'Char One',
          voiceId: 'v_char1',
          voiceUuid: 'uuid-char1',
          voiceStyle: 'a warm narrator',
          evidence: [{ quote: '"Hello there."' }],
          role: 'supporting',
        },
        characterId: 'char1',
        persona: opts.persona !== undefined ? opts.persona : 'a warm narrator',
        sampleVoiceId: 'v_char1',
        modelKey: QWEN_KEY,
        language: 'English',
      };
    }

    it('wraps the design POST in withCapacityRetry(engine: "qwen")', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response(Buffer.from([0, 0]), { status: 200, headers: { 'X-Sample-Rate': '24000' } }),
      );
      mockWithCapacityRetry.mockImplementation(async (doPost, opts) => {
        expect(opts.engine).toBe('qwen');
        return doPost(opts.signal);
      });

      const r = await designQwenVoiceForCharacter(makeBaseParams());

      expect(r.voiceId).toBeTruthy();
      expect(mockWithCapacityRetry).toHaveBeenCalledTimes(1);
    });

    it('a doPost that returns a noCapacity 503 once then ok succeeds after the (simulated) evict/retry', async () => {
      let calls = 0;
      vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
        calls += 1;
        return calls === 1
          ? new Response(JSON.stringify({ noCapacity: true, neededMb: 4_000, deviceKey: 'cuda:0' }), {
              status: 503,
            })
          : new Response(Buffer.from([0, 0]), { status: 200, headers: { 'X-Sample-Rate': '24000' } });
      });
      // Stand-in mirroring withCapacityRetry's real evict-then-retry contract:
      // retry the SAME doPost once more on a non-ok first response.
      mockWithCapacityRetry.mockImplementation(async (doPost, opts) => {
        const first = await doPost(opts.signal);
        if (first.ok) return first;
        return doPost(opts.signal);
      });

      const r = await designQwenVoiceForCharacter(makeBaseParams());

      expect(calls).toBe(2);
      expect(r.voiceId).toBeTruthy();
    });

    it('a non-noCapacity 503 returned by withCapacityRetry still becomes a SidecarDesignError with the base17-unavailable code (fallback path untouched)', async () => {
      const fetchSpy = vi
        .spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ code: 'base17-unavailable', reason: 'not-installed', detail: 'x' }), {
            status: 503,
          }),
        )
        .mockResolvedValueOnce(new Response(Buffer.from([0, 0]), { status: 200, headers: { 'X-Sample-Rate': '24000' } }));
      mockWithCapacityRetry.mockImplementation(async (doPost, opts) => doPost(opts.signal));

      const r = await designQwenVoiceForCharacter(makeVariantParams({ persona: 'a warm narrator' }));

      // Same assertion as the existing "falls back to design-voice on 503
      // not-installed" test above — proves withCapacityRetry's passthrough of
      // a non-noCapacity 503 doesn't disturb the mint→fallback flow.
      expect(r.fellBackToDesignVoice).toBe(true);
      expect(r.fallbackReason).toBe('not-installed');
      expect(fetchSpy.mock.calls.filter((c) => String(c[0]).includes('/qwen/mint-variant'))).toHaveLength(1);
    });

    it('maps a thrown NoCapacityError to a SidecarDesignError, carrying its own message through (#1839 finding 4)', async () => {
      // #1839 finding 4 — this used to be replaced with a generic
      // "GPU has no capacity for voice design" string, discarding the real
      // NoCapacityError message (and any named blocker) entirely.
      mockWithCapacityRetry.mockImplementation(async () => {
        throw new NoCapacityError('qwen', 5_000, 'cuda:0');
      });

      await expect(designQwenVoiceForCharacter(makeBaseParams())).rejects.toMatchObject({
        name: 'SidecarDesignError',
        status: 503,
        message: expect.stringMatching(/not enough gpu memory/i),
      });
    });

    it('threads a named VRAM blocker (e.g. Coqui) from NoCapacityError through to the SidecarDesignError message', async () => {
      mockWithCapacityRetry.mockImplementation(async () => {
        throw new NoCapacityError('qwen', 5_000, 'cuda:0', [
          { model: 'Coqui XTTS', remedy: 'Use its Stop button, at the top of the window.' },
        ]);
      });

      await expect(designQwenVoiceForCharacter(makeBaseParams())).rejects.toMatchObject({
        name: 'SidecarDesignError',
        status: 503,
        message: expect.stringContaining('Coqui XTTS is loaded'),
      });
    });
  });
});

describe('srv-43 — qwenStorageKey routing through design-voice', () => {
  /* These tests verify that the storage key used by designQwenVoiceForCharacter
     follows qwenStorageKey: uuid-backed voices go to qwen-<uuid>.pt; legacy
     (no uuid) voices go to qwen-<voiceId>.pt (behaviour-preserving). */

  it('character with pre-seeded voiceUuid designs at qwen-<uuid>.pt (idempotent — no re-mint)', async () => {
    /* Maerin has voiceUuid:'v_maerin' pre-seeded. The route calls ensureCharacterVoiceUuid
       which returns the existing uuid untouched (idempotent). The sidecar receives
       qwen-v_maerin (qwenStorageKey uses the uuid). */
    const res = await request(app)
      .post(`/api/books/${bookId}/cast/maerin/design-voice`)
      .send(designBody);

    expect(res.status).toBe(200);
    /* Storage key is derived from voiceUuid:'v_maerin' → qwen-v_maerin. */
    expect(res.body.voiceId).toBe('qwen-v_maerin');
    const sent = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(sent.voiceId).toBe('qwen-v_maerin');
    /* voiceUuid is unchanged on the character. */
    const cast = readCast();
    const maerin = cast.characters.find((c) => c.id === 'maerin');
    expect(maerin?.voiceUuid).toBe('v_maerin');
  });

  it('character with voiceUuid designs at qwen-<uuid>.pt', async () => {
    /* Temporarily write a character with voiceUuid set. */
    const uuid = 'V1StGXR8Z5';
    const charsWithUuid = characters.map((c) =>
      c.id === 'maerin' ? { ...c, voiceUuid: uuid } : c,
    );
    writeBookOnDisk(charsWithUuid);

    const res = await request(app)
      .post(`/api/books/${bookId}/cast/maerin/design-voice`)
      .send(designBody);

    expect(res.status).toBe(200);
    expect(res.body.voiceId).toBe(`qwen-${uuid}`);
    const sent = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(sent.voiceId).toBe(`qwen-${uuid}`);
  });
});

describe('srv-43 mint + collision regression', () => {
  /* Unit tests for ensureCharacterVoiceUuid and the end-to-end collision
     regression: two standalone books with the same character id/voiceId must
     design to DIFFERENT .pt paths after srv-43 (on pre-srv-43 code both resolve
     to qwen-wren.pt). */

  let bookDirA: string;
  let bookDirB: string;
  let ensureCharacterVoiceUuidFn: typeof import('./qwen-voice.js').ensureCharacterVoiceUuid;
  let readJson: typeof import('../workspace/state-io.js').readJson;
  let castJsonPath: typeof import('../workspace/paths.js').castJsonPath;

  beforeAll(async () => {
    ({ ensureCharacterVoiceUuid: ensureCharacterVoiceUuidFn } = await import('./qwen-voice.js'));
    ({ readJson } = await import('../workspace/state-io.js'));
    ({ castJsonPath } = await import('../workspace/paths.js'));
  });

  beforeEach(async () => {
    const { mkdtemp, mkdir, writeFile } = await import('node:fs/promises');
    /* Two independent standalone books each with {id:'wren', voiceId:'wren'} */
    bookDirA = await mkdtemp(join(tmpdir(), 'srv43-bookA-'));
    await mkdir(join(bookDirA, '.audiobook'), { recursive: true });
    await writeFile(
      join(bookDirA, '.audiobook', 'cast.json'),
      JSON.stringify({
        characters: [
          { id: 'wren', voiceId: 'wren', voiceStyle: 'a bright voice', evidence: [{ quote: '"Hello."' }] },
        ],
      }),
    );

    bookDirB = await mkdtemp(join(tmpdir(), 'srv43-bookB-'));
    await mkdir(join(bookDirB, '.audiobook'), { recursive: true });
    await writeFile(
      join(bookDirB, '.audiobook', 'cast.json'),
      JSON.stringify({
        characters: [
          { id: 'wren', voiceId: 'wren', voiceStyle: 'a bright voice', evidence: [{ quote: '"Hello."' }] },
        ],
      }),
    );
  });

  afterEach(async () => {
    const { rm } = await import('node:fs/promises');
    await rm(bookDirA, { recursive: true, force: true });
    await rm(bookDirB, { recursive: true, force: true });
  });

  it('mints a voiceUuid on the character and persists it', async () => {
    const uuid = await ensureCharacterVoiceUuidFn(bookDirA, 'wren');
    expect(uuid).toMatch(/.+/);
    const cast = await readJson<{ characters: Array<{ id: string; voiceUuid?: string }> }>(castJsonPath(bookDirA));
    expect(cast!.characters.find((c) => c.id === 'wren')!.voiceUuid).toBe(uuid);
  });

  it('is idempotent — a second call returns the same uuid, no re-mint', async () => {
    const a = await ensureCharacterVoiceUuidFn(bookDirA, 'wren');
    const b = await ensureCharacterVoiceUuidFn(bookDirA, 'wren');
    expect(b).toBe(a);
  });

  it('two same-named characters in different standalone books get distinct .pt paths (collision regression)', async () => {
    /* Marquee regression: on pre-srv-43 code both books design to qwen-wren.pt
       (colliding). After srv-43 each book mints a unique voiceUuid so the sidecar
       receives distinct storage keys. We drive the REAL design route for each book
       and capture the voiceId the sidecar fetch body carries — that is the .pt
       name. A passing test on pre-srv-43 code would see both equal 'qwen-wren'. */

    /* Create two standalone books inside the shared workspace so findBookByBookId
       can locate them. Different titles → different bookIds. Both carry 'wren'
       with no voiceUuid so ensureCharacterVoiceUuid mints fresh for each. */
    const { makeBookId } = await import('../workspace/paths.js');
    const wrenChar = {
      id: 'wren',
      voiceId: 'wren',
      voiceStyle: 'a bright voice',
      evidence: [{ quote: '"Hello."' }],
    };
    const designWrenBody = { sampleVoiceId: 'wren', modelKey: QWEN_KEY };

    function writeStandaloneBook(title: string, chars: object[]): string {
      const bId = makeBookId(AUTHOR, 'Standalones', title);
      const dir = join(workspaceRoot, 'books', AUTHOR, 'Standalones', title);
      mkdirSync(join(dir, '.audiobook'), { recursive: true });
      writeFileSync(
        join(dir, '.audiobook', 'state.json'),
        JSON.stringify({
          bookId: bId,
          manuscriptId: `m_${bId}`,
          title,
          author: AUTHOR,
          series: 'Standalones',
          seriesPosition: 0,
          isStandalone: true,
          manuscriptFile: 'manuscript.txt',
          castConfirmed: true,
          chapters: [],
          language: 'en',
          coverGradient: ['#000', '#fff'],
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        }),
      );
      writeFileSync(join(dir, 'manuscript.txt'), 'placeholder');
      writeFileSync(join(dir, '.audiobook', 'cast.json'), JSON.stringify({ characters: chars }));
      return bId;
    }

    const bookIdA = writeStandaloneBook('Collision Alpha', [wrenChar]);
    const bookIdB = writeStandaloneBook('Collision Beta', [wrenChar]);

    /* Design Book A — capture what voiceId the sidecar was asked for. */
    fetchMock.mockReset();
    fetchMock.mockResolvedValue(okSidecarResponse());
    const resA = await request(app)
      .post(`/api/books/${bookIdA}/cast/wren/design-voice`)
      .send(designWrenBody);
    expect(resA.status).toBe(200);
    const sentA = JSON.parse(fetchMock.mock.calls[0][1].body);

    /* Design Book B — reset the mock so call[0] belongs to Book B. */
    fetchMock.mockReset();
    fetchMock.mockResolvedValue(okSidecarResponse());
    const resB = await request(app)
      .post(`/api/books/${bookIdB}/cast/wren/design-voice`)
      .send(designWrenBody);
    expect(resB.status).toBe(200);
    const sentB = JSON.parse(fetchMock.mock.calls[0][1].body);

    /* The two sidecar storage keys must diverge (the whole point of srv-43). */
    expect(sentA.voiceId).toMatch(/^qwen-.+/);
    expect(sentB.voiceId).toMatch(/^qwen-.+/);
    expect(sentA.voiceId).not.toBe(sentB.voiceId);

    /* Clean up the two extra books from the workspace. */
    rmSync(join(workspaceRoot, 'books', AUTHOR, 'Standalones'), { recursive: true, force: true });
  });
});

describe('#2088 — withDesignLock actually serializes ensureCharacterVoiceUuid on the series branch', () => {
  /* srv-85 (#2088) — CORRECTION (independent review of PR #2126, R3): the
     original issue and this file's earlier version of this comment claimed
     withDesignLock (tts/design-lock.ts) had ZERO test coverage. That is
     false — server/src/tts/design-lock.test.ts has existed on main since
     53a30df4 with three direct tests, one of which ("serializes overlapping
     designs for the SAME book") reddens on its own when the primitive is
     neutralised to `return fn();`. The accurate statement: qwen-voice.test.ts
     had NO coverage of it, and the series-branch double-mint property below
     was untested ANYWHERE (design-lock.test.ts's coverage is of the
     primitive in isolation, not of any real caller). Neutralising it to
     `return fn();` left every other test in this 1600-line file fully green
     (80/80 at the time the issue was filed) — which is still true and is
     what makes the new test below worth having.

     Why the SERIES branch specifically, not a self-vs-self race on the
     no-seriesFilter path used just above: ensureCharacterVoiceUuid's whole
     body already sits inside withDesignLock on BOTH branches, but the
     book-scoped branch's own body is one readJson + a tight synchronous loop
     + one write — almost no interleaving window for two racing calls even
     unlocked. The series branch instead hands off to
     forEachMatchingCastCharacter (routes/voices.ts), which does a
     workspace-wide walk with several `await`s (per-book state.json / cast.json
     reads) BEFORE its write — a real race window where two concurrent calls
     can both observe "no voiceUuid yet" and each mint a DIFFERENT uuid before
     either write lands. That is the double-mint #2088 describes: the series
     branch is where withDesignLock's serialization is load-bearing, and
     where the suite had no coverage.

     MUTATION-VERIFIED (not a placebo): with `withDesignLock`'s body
     temporarily reverted to `return fn();` (no locking at all), this test
     reddens — `b` comes back a DIFFERENT uuid than `a` (two mints for one
     character) — across repeated runs; restoring the real lock body makes it
     green again. See the #2088 PR body for the before/after run. */
  let ensureCharacterVoiceUuidRace: typeof import('./qwen-voice.js').ensureCharacterVoiceUuid;

  beforeAll(async () => {
    ({ ensureCharacterVoiceUuid: ensureCharacterVoiceUuidRace } = await import('./qwen-voice.js'));
  });

  it('two concurrent calls for the same book mint ONE uuid, not two', async () => {
    // 'nopersona' (from the shared `characters` fixture) carries no voiceId/
    // voiceUuid, and the root beforeEach rewrites cast.json fresh before this
    // test runs. AUTHOR/SERIES/BOOK is already a non-standalone series book
    // (isStandalone: false — see writeBookOnDisk), so this seriesFilter
    // routes ensureCharacterVoiceUuid through forEachMatchingCastCharacter's
    // workspace walk exactly as the real cast-review "design in a series"
    // flow does.
    const bookDir = join(workspaceRoot, 'books', AUTHOR, SERIES, BOOK);
    const seriesFilter = { author: AUTHOR, series: SERIES };

    const [a, b] = await Promise.all([
      ensureCharacterVoiceUuidRace(bookDir, 'nopersona', seriesFilter),
      ensureCharacterVoiceUuidRace(bookDir, 'nopersona', seriesFilter),
    ]);

    expect(a).toMatch(/.+/);
    // The double-mint symptom: two concurrent callers must agree on ONE uuid.
    expect(b).toBe(a);
    // And exactly that uuid is what actually persisted to disk.
    const cast = readCast();
    expect(cast.characters.find((c) => c.id === 'nopersona')?.voiceUuid).toBe(a);
  });
});

describe('progress token threading (design-progress AR2)', () => {
  /* Verifies that progressToken + progressUrl are forwarded into BOTH sidecar
     request bodies (design-voice and mint-variant) when provided, and are absent
     when not provided. */

  it('threads progressToken + progressUrl into the design-voice body when both are present', async () => {
    const res = await request(app)
      .post(`/api/books/${bookId}/cast/maerin/design-voice`)
      .send({ ...designBody, progressToken: 'tok', progressUrl: 'http://127.0.0.1:8080/api/internal/design-progress' });

    expect(res.status).toBe(200);
    const sent = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(sent.progressToken).toBe('tok');
    expect(sent.progressUrl).toBe('http://127.0.0.1:8080/api/internal/design-progress');
  });

  it('does NOT include progressToken / progressUrl in the design-voice body when omitted', async () => {
    const res = await request(app)
      .post(`/api/books/${bookId}/cast/maerin/design-voice`)
      .send(designBody);

    expect(res.status).toBe(200);
    const sent = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(sent).not.toHaveProperty('progressToken');
    expect(sent).not.toHaveProperty('progressUrl');
  });

  it('threads progressToken + progressUrl into the mint-variant body when both are present', async () => {
    const res = await request(app)
      .post(`/api/books/${bookId}/cast/maerin/design-voice`)
      .send({ ...designBody, emotion: 'angry', progressToken: 'tok2', progressUrl: 'http://127.0.0.1:8080/api/internal/design-progress' });

    expect(res.status).toBe(200);
    const sent = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(sent.progressToken).toBe('tok2');
    expect(sent.progressUrl).toBe('http://127.0.0.1:8080/api/internal/design-progress');
  });
});
