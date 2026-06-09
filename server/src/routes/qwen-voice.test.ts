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

import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
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

const AUTHOR = 'Shannon Messenger';
const SERIES = 'Keeper of the Lost Cities';
const BOOK = 'Keeper of the Lost Cities';
const QWEN_KEY = 'qwen3-tts-0.6b';

/* Biana's longest evidence quote, smart-quotes stripped — what buildSampleText
   picks and the audition therefore speaks. */
const BIANA_LINE = 'We have to tell the Council, and we have to do it before the others wake.';

let workspaceRoot: string;
let audioDir: string;
let app: Express;
let bookId: string;

const fetchMock = vi.fn();
/* selectTtsProvider stub — the /sample coherence test asserts synthesize is
   NEVER called (the design route already wrote the file). */
const { synthesize } = vi.hoisted(() => ({ synthesize: vi.fn() }));

vi.mock('../tts/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../tts/index.js')>();
  return { ...actual, selectTtsProvider: vi.fn(() => ({ synthesize })) };
});

const characters = [
  { id: 'narrator', name: 'Narrator', role: 'narrator', color: 'narrator' },
  {
    id: 'biana',
    name: 'Biana',
    role: 'supporting',
    color: 'lilac',
    voiceId: 'v_biana',
    voiceStyle: 'a poised, confident teenage girl, clear and warm',
    evidence: [{ quote: `“${BIANA_LINE}”` }, { quote: 'Wait.' }],
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

const designBody = { sampleVoiceId: 'v_biana', modelKey: QWEN_KEY };

beforeAll(async () => {
  workspaceRoot = mkdtempSync(join(tmpdir(), 'audiobook-qwen-voice-test-'));
  audioDir = mkdtempSync(join(tmpdir(), 'audiobook-qwen-voice-audio-'));
  process.env.WORKSPACE_DIR = workspaceRoot;
  process.env.VOICE_SAMPLE_AUDIO_DIR = audioDir;
  vi.stubGlobal('fetch', fetchMock);

  const [{ qwenVoiceRouter }, { voiceSampleRouter }, { makeBookId }] = await Promise.all([
    import('./qwen-voice.js'),
    import('./voice-sample.js'),
    import('../workspace/paths.js'),
  ]);
  bookId = makeBookId(AUTHOR, SERIES, BOOK);

  app = express();
  app.use(express.json());
  app.use('/api/books', qwenVoiceRouter);
  app.use('/api/voices', voiceSampleRouter);
});

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockResolvedValue(okSidecarResponse());
  synthesize.mockReset();
  synthesize.mockResolvedValue({ pcm: Buffer.alloc(24_000 * 2 * 0.3, 0), sampleRate: 24_000 });
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
  it('forwards persona + a calibrationText from the character line, caches the MP3, returns {voiceId,url}', async () => {
    const res = await request(app)
      .post(`/api/books/${bookId}/cast/biana/design-voice`)
      .send(designBody);

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/application\/json/);
    expect(res.body.voiceId).toBe('qwen-v_biana');
    expect(res.body.url).toMatch(/^\/audio\/voices\/v_biana-qwen3-tts-0\.6b-[a-z0-9]+\.mp3$/);

    /* Sidecar called once with the right payload — including the character's
       own line as the audition calibration text. */
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('http://localhost:9000/qwen/design-voice');
    const sent = JSON.parse(init.body);
    expect(sent).toEqual({
      voiceId: 'qwen-v_biana',
      instruct: 'a poised, confident teenage girl, clear and warm',
      language: 'English',
      calibrationText: BIANA_LINE,
    });

    /* The cached file on disk is a real MP3 at the URL's filename. */
    const fileName = res.body.url.split('/').pop() as string;
    const fileBuf = readFileSync(join(audioDir, fileName));
    expect(isMp3Magic(fileBuf)).toBe(true);
  });

  it('ONE PASS: after design, /sample for the same identity is a cache hit (no provider call)', async () => {
    const design = await request(app)
      .post(`/api/books/${bookId}/cast/biana/design-voice`)
      .send(designBody);
    expect(design.status).toBe(200);

    /* The drawer / cast row would request the 12s sample with the designed
       voice pinned in overrideTtsVoices.qwen and the character's evidence as
       the hint — exactly the inputs that reproduce the cached filename. */
    const sample = await request(app)
      .post('/api/voices/v_biana/sample')
      .send({
        modelKey: QWEN_KEY,
        voice: { id: 'v_biana', overrideTtsVoices: { qwen: { name: 'qwen-v_biana' } } },
        characterHint: { evidence: [`“${BIANA_LINE}”`, 'Wait.'] },
      });

    expect(sample.status).toBe(200);
    expect(sample.body.cached).toBe(true);
    expect(sample.body.url).toBe(design.body.url);
    /* The whole point: the player never re-synthesised. */
    expect(synthesize).not.toHaveBeenCalled();
  });

  it('OVERWRITES the cached audition on re-design (an explicit regenerate must refresh the preview)', async () => {
    const first = await request(app)
      .post(`/api/books/${bookId}/cast/biana/design-voice`)
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
      .post(`/api/books/${bookId}/cast/biana/design-voice`)
      .send(designBody);
    expect(second.status).toBe(200);
    expect(second.body.url).toBe(first.body.url); // same deterministic filename
    const secondBytes = readFileSync(join(audioDir, fileName));
    expect(secondBytes.equals(firstBytes)).toBe(false); // refreshed, not stale
  });

  it('defaults the persona to the character voiceStyle and lets the body override it', async () => {
    await request(app)
      .post(`/api/books/${bookId}/cast/biana/design-voice`)
      .send({ ...designBody, persona: 'a gruff old sailor' });
    const sent = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(sent.instruct).toBe('a gruff old sailor');
  });

  it('does NOT persist the override (design only caches + previews)', async () => {
    await request(app)
      .post(`/api/books/${bookId}/cast/biana/design-voice`)
      .send(designBody);
    const cast = readCast();
    const biana = cast.characters.find((c) => c.id === 'biana');
    expect(biana?.overrideTtsVoices).toBeUndefined();
    expect(biana?.ttsEngine).toBeUndefined();
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
      .post(`/api/books/${bookId}/cast/biana/design-voice`)
      .send({ modelKey: QWEN_KEY });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/sampleVoiceId/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('400s when modelKey is missing or invalid', async () => {
    const res = await request(app)
      .post(`/api/books/${bookId}/cast/biana/design-voice`)
      .send({ sampleVoiceId: 'v_biana', modelKey: 'nope' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/modelKey/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('502s with a clear message when the sidecar is unreachable', async () => {
    fetchMock.mockRejectedValue(new Error('ECONNREFUSED'));
    const res = await request(app)
      .post(`/api/books/${bookId}/cast/biana/design-voice`)
      .send(designBody);
    expect(res.status).toBe(502);
    expect(res.body.error).toMatch(/unreachable/i);
  });

  it('502s when the sidecar returns a non-OK status', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 500,
      statusText: 'Internal Server Error',
      headers: new Headers(),
      arrayBuffer: async () => new ArrayBuffer(0),
      json: async () => ({ error: 'qwen-tts not installed' }),
    });
    const res = await request(app)
      .post(`/api/books/${bookId}/cast/biana/design-voice`)
      .send(designBody);
    expect(res.status).toBe(502);
    expect(res.body.error).toMatch(/qwen-tts not installed/);
  });

  it('502 surfaces the sidecar FastAPI {detail} field, not a bare "returned 500"', async () => {
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
      .post(`/api/books/${bookId}/cast/biana/design-voice`)
      .send(designBody);
    expect(res.status).toBe(502);
    expect(res.body.error).toMatch(/meta tensor/);
    expect(res.body.error).not.toMatch(/returned 500/);
  });

  it('404s for an unknown bookId', async () => {
    const res = await request(app).post('/api/books/nope/cast/biana/design-voice').send(designBody);
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
      .post(`/api/books/${bookId}/cast/biana/design-voice`)
      .send(designBody);
    expect(res.status).toBe(200);
    const sent = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(sent.language).toBe('Russian');
  });

  it("sends language:'English' for a book with no language field (legacy default)", async () => {
    /* beforeEach writes the book with no `language` — the seam defaults to 'en'
       → 'English', so legacy books keep designing English voices unchanged. */
    const res = await request(app)
      .post(`/api/books/${bookId}/cast/biana/design-voice`)
      .send(designBody);
    expect(res.status).toBe(200);
    const sent = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(sent.language).toBe('English');
  });
});

describe('fs-25 — design-voice emotion variants (Wave 3)', () => {
  it('designs an emotion variant under <base>__<emotion>, augments the instruct, and records it on the cast', async () => {
    const res = await request(app)
      .post(`/api/books/${bookId}/cast/biana/design-voice`)
      .send({ ...designBody, emotion: 'angry' });

    expect(res.status).toBe(200);
    expect(res.body.voiceId).toBe('qwen-v_biana__angry');

    const sent = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(sent.voiceId).toBe('qwen-v_biana__angry');
    // base persona is preserved AND an emotion delivery clause is appended.
    expect(sent.instruct).toContain('a poised, confident teenage girl, clear and warm');
    expect(sent.instruct.toLowerCase()).toContain('angr');

    // the variant is persisted onto the character's qwen slot.
    const cast = readCast();
    const biana = cast.characters.find((c) => c.id === 'biana') as Record<string, any>;
    expect(biana.overrideTtsVoices.qwen.variants.angry).toEqual({ name: 'qwen-v_biana__angry' });
  });

  it('rejects an out-of-enum / neutral emotion with 400', async () => {
    const bad = await request(app)
      .post(`/api/books/${bookId}/cast/biana/design-voice`)
      .send({ ...designBody, emotion: 'furious' });
    expect(bad.status).toBe(400);

    const neutral = await request(app)
      .post(`/api/books/${bookId}/cast/biana/design-voice`)
      .send({ ...designBody, emotion: 'neutral' });
    expect(neutral.status).toBe(400);
  });

  it('a base design (no emotion) leaves variants untouched', async () => {
    const res = await request(app)
      .post(`/api/books/${bookId}/cast/biana/design-voice`)
      .send(designBody);
    expect(res.status).toBe(200);
    expect(res.body.voiceId).toBe('qwen-v_biana');
    const cast = readCast();
    const biana = cast.characters.find((c) => c.id === 'biana') as Record<string, any>;
    expect(biana.overrideTtsVoices?.qwen?.variants).toBeUndefined();
  });
});

describe('GET /api/books/:bookId/cast/:characterId/designed-persona', () => {
  it('returns the sidecar instruct for a character whose voice was designed (derived voiceId)', async () => {
    writeQwenSidecar('qwen-v_biana', 'a poised, confident teenage girl, clear and warm');
    const res = await request(app).get(`/api/books/${bookId}/cast/biana/designed-persona`);
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
    const res = await request(app).get(`/api/books/${bookId}/cast/biana/designed-persona`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ instruct: '' });
  });

  it('returns an empty instruct when the sidecar exists but has no instruct key', async () => {
    writeQwenSidecar('qwen-v_biana', undefined);
    const res = await request(app).get(`/api/books/${bookId}/cast/biana/designed-persona`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ instruct: '' });
  });

  it('404s for an unknown bookId', async () => {
    const res = await request(app).get('/api/books/nope/cast/biana/designed-persona');
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
      .post(`/api/books/${bookId}/cast/biana/design-voice`)
      .send({ ...designBody, preview: true });
    expect(res.status).toBe(200);
    expect(res.body.voiceId).toBe('qwen-v_biana-preview');
    /* The sidecar was asked to design the PREVIEW id, not the live one. */
    const sent = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(sent.voiceId).toBe('qwen-v_biana-preview');
  });

  it('promote-voice moves the preview onto the stable id, returns it, and evicts the sidecar cache', async () => {
    stagedPreviewArtifacts('qwen-v_biana-preview');
    const res = await request(app)
      .post(`/api/books/${bookId}/cast/biana/promote-voice`)
      .send({ previewVoiceId: 'qwen-v_biana-preview', sampleVoiceId: 'v_biana', modelKey: QWEN_KEY });

    expect(res.status).toBe(200);
    expect(res.body.voiceId).toBe('qwen-v_biana');
    expect(res.body.url).toMatch(/^\/audio\/voices\/v_biana-qwen3-tts-0\.6b-[a-z0-9]+\.mp3$/);
    /* Files moved: real id now present, preview gone. */
    expect(existsSync(join(qwenDir(), 'qwen-v_biana.pt'))).toBe(true);
    expect(existsSync(join(qwenDir(), 'qwen-v_biana.json'))).toBe(true);
    expect(existsSync(join(qwenDir(), 'qwen-v_biana-preview.pt'))).toBe(false);
    /* The sidecar cache for the REAL id was evicted so the swap is seen. */
    const evictCall = fetchMock.mock.calls.find(([u]) => String(u).endsWith('/qwen/evict-voice'));
    expect(evictCall).toBeTruthy();
    expect(JSON.parse(evictCall![1].body).voiceId).toBe('qwen-v_biana');
  });

  it('promote-voice 409s when nothing was staged', async () => {
    const res = await request(app)
      .post(`/api/books/${bookId}/cast/biana/promote-voice`)
      .send({ previewVoiceId: 'qwen-v_biana-preview', sampleVoiceId: 'v_biana', modelKey: QWEN_KEY });
    expect(res.status).toBe(409);
  });

  it('promote-voice 400s on a previewVoiceId that is not this character’s preview', async () => {
    const res = await request(app)
      .post(`/api/books/${bookId}/cast/biana/promote-voice`)
      .send({ previewVoiceId: 'qwen-someone-else-preview', sampleVoiceId: 'v_biana', modelKey: QWEN_KEY });
    expect(res.status).toBe(400);
  });

  it('discard-voice removes the staged preview and never touches the live voice', async () => {
    stagedPreviewArtifacts('qwen-v_biana-preview');
    /* A live voice exists alongside the preview — it must survive. */
    writeFileSync(join(qwenDir(), 'qwen-v_biana.pt'), 'LIVE');
    const res = await request(app)
      .post(`/api/books/${bookId}/cast/biana/discard-voice`)
      .send({ previewVoiceId: 'qwen-v_biana-preview', sampleVoiceId: 'v_biana', modelKey: QWEN_KEY });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(existsSync(join(qwenDir(), 'qwen-v_biana-preview.pt'))).toBe(false);
    expect(existsSync(join(qwenDir(), 'qwen-v_biana-preview.json'))).toBe(false);
    expect(readFileSync(join(qwenDir(), 'qwen-v_biana.pt'), 'utf8')).toBe('LIVE');
  });
});

describe('DELETE /api/books/:bookId/cast/:characterId/emotion-variant/:emotion (fs-34)', () => {
  const qwenDir = () => join(workspaceRoot, 'voices', 'qwen');

  /* Seed biana with TWO designed variants (angry + sad) on cast.json + disk,
     alongside the base voice — so a delete can be shown to drop exactly one. */
  function seedVariants() {
    mkdirSync(qwenDir(), { recursive: true });
    for (const id of ['qwen-v_biana', 'qwen-v_biana__angry', 'qwen-v_biana__sad']) {
      writeFileSync(join(qwenDir(), `${id}.pt`), 'EMBEDDING');
      writeFileSync(join(qwenDir(), `${id}.json`), JSON.stringify({ voiceId: id }));
    }
    const withVariants = characters.map((c) =>
      c.id === 'biana'
        ? {
            ...c,
            overrideTtsVoices: {
              qwen: {
                name: 'qwen-v_biana',
                variants: {
                  angry: { name: 'qwen-v_biana__angry' },
                  sad: { name: 'qwen-v_biana__sad' },
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
    const res = await request(app).delete(`/api/books/${bookId}/cast/biana/emotion-variant/angry`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, removed: 'angry' });

    const biana = readCast().characters.find((c) => c.id === 'biana')!;
    const qwen = biana.overrideTtsVoices as { qwen: { name: string; variants?: Record<string, unknown> } };
    expect(qwen.qwen.variants).toEqual({ sad: { name: 'qwen-v_biana__sad' } });
    expect(qwen.qwen.name).toBe('qwen-v_biana'); // base untouched

    expect(existsSync(join(qwenDir(), 'qwen-v_biana__angry.pt'))).toBe(false);
    expect(existsSync(join(qwenDir(), 'qwen-v_biana__angry.json'))).toBe(false);
    // Sibling + base files survive.
    expect(existsSync(join(qwenDir(), 'qwen-v_biana__sad.pt'))).toBe(true);
    expect(existsSync(join(qwenDir(), 'qwen-v_biana.pt'))).toBe(true);
  });

  it('clears the whole variants map (and badge) when the last variant is removed', async () => {
    mkdirSync(qwenDir(), { recursive: true });
    writeFileSync(join(qwenDir(), 'qwen-v_biana__angry.pt'), 'E');
    const onlyAngry = characters.map((c) =>
      c.id === 'biana'
        ? { ...c, overrideTtsVoices: { qwen: { name: 'qwen-v_biana', variants: { angry: { name: 'qwen-v_biana__angry' } } } } }
        : c,
    );
    writeFileSync(
      join(workspaceRoot, 'books', AUTHOR, SERIES, BOOK, '.audiobook', 'cast.json'),
      JSON.stringify({ characters: onlyAngry }),
    );

    const res = await request(app).delete(`/api/books/${bookId}/cast/biana/emotion-variant/angry`);
    expect(res.status).toBe(200);
    const qwen = readCast().characters.find((c) => c.id === 'biana')!.overrideTtsVoices as {
      qwen: { name: string; variants?: unknown };
    };
    expect(qwen.qwen.variants).toBeUndefined();
    expect(qwen.qwen.name).toBe('qwen-v_biana');
  });

  it('400s on an emotion outside the variant enum (incl. neutral)', async () => {
    seedVariants();
    expect((await request(app).delete(`/api/books/${bookId}/cast/biana/emotion-variant/furious`)).status).toBe(400);
    expect((await request(app).delete(`/api/books/${bookId}/cast/biana/emotion-variant/neutral`)).status).toBe(400);
  });

  it('404s for an unknown book or character', async () => {
    seedVariants();
    expect((await request(app).delete(`/api/books/nope/cast/biana/emotion-variant/angry`)).status).toBe(404);
    expect((await request(app).delete(`/api/books/${bookId}/cast/ghost/emotion-variant/angry`)).status).toBe(404);
  });

  it('is idempotent — removing an absent variant still returns 200', async () => {
    // biana has no variants in the default cast (beforeEach wrote it).
    const res = await request(app).delete(`/api/books/${bookId}/cast/biana/emotion-variant/excited`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, removed: 'excited' });
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
});
