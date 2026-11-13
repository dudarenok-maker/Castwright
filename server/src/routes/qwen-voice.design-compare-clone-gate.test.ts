/* #4104 -- the drawer's Design & compare flow on a "Don't reuse" (declined) row:
   REST design-voice with `preview: true` -> promote-voice -> the drawer's Save, which is
   `PUT /api/voices/:voiceId/override` (series scope). The REST design route passes no
   `refuseIfSeriesCloned` (the stream route does): a preview writes no override, promote
   writes only files, so the series clone gate for this flow is the override route's
   (#4069), scoped to the rows on the row's new uuid. These pins drive the whole chain and
   assert no cloned row loses its clone or is retargeted off it. */

import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express, { type Express } from 'express';
import request from 'supertest';
import { withCapacityRetry } from '../gpu/capacity-retry.js';

vi.mock('undici', async (importOriginal) => {
  const actual = await importOriginal<typeof import('undici')>();
  return {
    ...actual,
    fetch: (...args: unknown[]) =>
      (globalThis.fetch as unknown as (...a: unknown[]) => unknown)(...args),
  };
});
vi.mock('../analyzer/voice-style.js', () => ({
  generateVoiceStylePersona: vi.fn().mockResolvedValue('a bright voice'),
  personaSharesGpu: vi.fn().mockReturnValue(false),
}));
vi.mock('../tts/persona-gpu-plan.js', () => ({
  preparePersonaBatch: vi.fn().mockResolvedValue({ onCpu: false, keepAlive: 0 }),
  resolvePersonaGpuPlan: vi.fn().mockReturnValue({ onCpu: false, evict: false, keepAlive: 0 }),
}));
vi.mock('../gpu/gpu-load.js', () => ({
  withGpuLoad: (fn: () => Promise<unknown>) => fn(),
  GpuBusyError: class GpuBusyError extends Error {
    code = 'GPU_BUSY';
  },
}));
vi.mock('../gpu/sidecar-vram-sample.js', () => ({ maybeSampleSidecarEngine: async () => {} }));
vi.mock('../gpu/capacity-retry.js', () => ({ withCapacityRetry: vi.fn() }));

const AUTHOR = 'Della Renwick';
const SERIES = 'The Hollow Tide';
const QWEN_KEY = 'qwen3-tts-0.6b';

let workspaceRoot: string;
let audioDir: string;
let app: Express;
let bookOneId: string;
let bookTwoId: string;
let bookThreeId: string;
let bookFourId: string;
const fetchMock = vi.fn();

const qwenDir = () => join(workspaceRoot, 'voices', 'qwen');
const bookDir = (t: string) => join(workspaceRoot, 'books', AUTHOR, SERIES, t);
const castPath = (t: string) => join(bookDir(t), '.audiobook', 'cast.json');
const readRow = (t: string): Record<string, any> => JSON.parse(readFileSync(castPath(t), 'utf8')).characters[0];

function writeBook(t: string, position: number, id: string, row: Record<string, unknown>) {
  mkdirSync(join(bookDir(t), '.audiobook'), { recursive: true });
  writeFileSync(
    join(bookDir(t), '.audiobook', 'state.json'),
    JSON.stringify({
      bookId: id,
      manuscriptId: `m_${id}`,
      title: t,
      author: AUTHOR,
      series: SERIES,
      seriesPosition: position,
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
  writeFileSync(join(bookDir(t), 'manuscript.txt'), 'placeholder');
  writeFileSync(castPath(t), JSON.stringify({ characters: [row] }));
}

const wren = (extra: Record<string, unknown> = {}) => ({
  id: 'wren',
  name: 'Wren',
  role: 'supporting',
  color: 'sky',
  voiceId: 'v_wren',
  voiceStyle: 'a bright voice',
  evidence: [{ quote: '"Hello there."' }],
  ...extra,
});
const coquiClone = { coqui: { name: 'wren-clone', libraryUuid: 'C1', provenance: 'cloned' } };
const linkedToBookOne = () => ({
  matchedFrom: { bookId: bookOneId, characterId: 'wren', bookTitle: 'Book One', confidence: 1 },
});

beforeAll(async () => {
  process.env.CASTWRIGHT_VRAM_SAMPLE = '0';
  workspaceRoot = mkdtempSync(join(tmpdir(), 'audiobook-design-compare-clone-'));
  audioDir = mkdtempSync(join(tmpdir(), 'audiobook-design-compare-clone-audio-'));
  process.env.WORKSPACE_DIR = workspaceRoot;
  process.env.VOICE_SAMPLE_AUDIO_DIR = audioDir;
  vi.stubGlobal('fetch', fetchMock);

  const { castDeclineVoiceLinkRouter } = await import('./cast-decline-voice-link.js');
  const { qwenVoiceRouter } = await import('./qwen-voice.js');
  const { voicesRouter } = await import('./voices.js');
  const { voiceOverrideLinkedRouter } = await import('./voice-override-linked.js');
  const { makeBookId } = await import('../workspace/paths.js');
  bookOneId = makeBookId(AUTHOR, SERIES, 'Book One');
  bookTwoId = makeBookId(AUTHOR, SERIES, 'Book Two');
  bookThreeId = makeBookId(AUTHOR, SERIES, 'Book Three');
  bookFourId = makeBookId(AUTHOR, SERIES, 'Book Four');
  app = express();
  app.use(express.json());
  app.use('/api/books', castDeclineVoiceLinkRouter);
  app.use('/api/books', qwenVoiceRouter);
  app.use('/api/books', voiceOverrideLinkedRouter);
  app.use('/api/voices', voicesRouter);
});

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockImplementation(async (url: unknown, init: { body?: string } | undefined) => {
    let voiceId: string | undefined;
    try {
      const b = JSON.parse(init?.body ?? '{}');
      voiceId = b.variantVoiceId ?? b.voiceId;
    } catch {
      /* not a design call */
    }
    if (voiceId && !String(url).includes('evict')) {
      mkdirSync(qwenDir(), { recursive: true });
      writeFileSync(join(qwenDir(), `${voiceId}.pt`), Buffer.from('PT'));
      writeFileSync(join(qwenDir(), `${voiceId}.json`), JSON.stringify({ instruct: 'persona' }));
    }
    const bytes = new Uint8Array(24_000 * 2 * 0.3);
    return {
      ok: true,
      status: 200,
      statusText: 'OK',
      headers: new Headers({ 'Content-Type': 'audio/L16', 'X-Sample-Rate': '24000' }),
      arrayBuffer: async () => bytes.buffer,
      json: async () => ({}),
    };
  });
  vi.mocked(withCapacityRetry).mockReset();
  vi.mocked(withCapacityRetry).mockImplementation((doPost, opts) => doPost(opts.signal));
  rmSync(join(workspaceRoot, 'books'), { recursive: true, force: true });
  rmSync(join(workspaceRoot, 'voices'), { recursive: true, force: true });
});

afterAll(() => {
  vi.unstubAllGlobals();
  rmSync(workspaceRoot, { recursive: true, force: true });
  rmSync(audioDir, { recursive: true, force: true });
  delete process.env.WORKSPACE_DIR;
  delete process.env.VOICE_SAMPLE_AUDIO_DIR;
});

const designRest = (preview: boolean) =>
  request(app)
    .post(`/api/books/${bookTwoId}/cast/wren/design-voice`)
    .send({ persona: 'a warm voice', sampleVoiceId: 'v_wren', modelKey: QWEN_KEY, preview });
const promote = (previewVoiceId: string) =>
  request(app)
    .post(`/api/books/${bookTwoId}/cast/wren/promote-voice`)
    .send({ previewVoiceId, sampleVoiceId: 'v_wren', modelKey: QWEN_KEY });
/* The drawer's Save after approve(): a series-scoped override naming the promoted voice. */
const apply = (voiceId: string) =>
  request(app)
    .put('/api/voices/v_wren/override')
    .send({ override: { engine: 'qwen', name: voiceId }, scope: 'series', bookId: bookTwoId });

/* Book Two is a pre-separation decline (marker, shared uuid); the design's uuid step
   separates it, and Book Three -- linked from Book Two, holding a consented clone --
   moves with it onto the new uuid. */
function seedDeclinedWithClonedFollower() {
  writeBook('Book One', 1, bookOneId, wren({ voiceUuid: 'u_shared' }));
  writeBook(
    'Book Two',
    2,
    bookTwoId,
    wren({ ...linkedToBookOne(), voiceUuid: 'u_shared', declinedVoiceFrom: [bookOneId], declinedVoiceUuids: ['u_shared'] }),
  );
  writeBook(
    'Book Three',
    3,
    bookThreeId,
    wren({
      voiceUuid: 'u_shared',
      ttsEngine: 'coqui',
      overrideTtsVoices: coquiClone,
      matchedFrom: { bookId: bookTwoId, characterId: 'wren', bookTitle: 'Book Two', confidence: 1 },
    }),
  );
}

describe('Design & compare on a declined row whose new voice carries a consented clone (#4104)', () => {
  it('the series Save route is refused (409) for a clone on the new uuid, and no cloned row is retargeted', async () => {
    seedDeclinedWithClonedFollower();
    const threeBefore = readRow('Book Three');
    const oneBefore = readRow('Book One');

    const preview = await designRest(true);
    expect(preview.status).toBe(200);
    const moved = readRow('Book Two').voiceUuid as string;
    expect(moved).not.toBe('u_shared');
    /* the clone row travelled with the separation: it IS on the uuid the Save will name */
    expect(readRow('Book Three').voiceUuid).toBe(moved);
    expect(readRow('Book Three').overrideTtsVoices).toEqual(threeBefore.overrideTtsVoices);
    expect(readRow('Book Three').ttsEngine).toBe('coqui');
    expect(readRow('Book Two').overrideTtsVoices?.qwen).toBeUndefined();

    const kept = await promote(preview.body.voiceId);
    expect(kept.status).toBe(200);
    expect(kept.body.voiceId).toBe(`qwen-${moved}`);
    expect(readRow('Book Three').ttsEngine).toBe('coqui');
    expect(readRow('Book Two').overrideTtsVoices?.qwen).toBeUndefined();

    const saved = await apply(kept.body.voiceId);
    expect(saved.status).toBe(409);
    const three = readRow('Book Three');
    expect(three.ttsEngine).toBe('coqui');
    expect(three.overrideTtsVoices).toEqual(threeBefore.overrideTtsVoices);
    expect(three.overrideTtsVoices.qwen).toBeUndefined();
    /* the refused series PUT wrote nothing to Book Two; the real drawer ALSO saves its open book
       through its own cast PUT (onSave), which is not driven here and is clone-safe by itself */
    expect(readRow('Book Two').overrideTtsVoices?.qwen).toBeUndefined();
    expect(readRow('Book One')).toEqual(oneBefore);
  });

  it('a non-preview REST base design for such a row writes no override and retargets no row', async () => {
    seedDeclinedWithClonedFollower();
    const threeBefore = readRow('Book Three');
    const res = await designRest(false);
    expect(res.status).toBe(200);
    const three = readRow('Book Three');
    expect(three.ttsEngine).toBe('coqui');
    expect(three.overrideTtsVoices).toEqual(threeBefore.overrideTtsVoices);
    expect(readRow('Book Two').overrideTtsVoices?.qwen).toBeUndefined();
    expect(readRow('Book One').overrideTtsVoices?.qwen).toBeUndefined();
  });

  it('a clone only on the book the row declined away from does not block the Save, and stays intact', async () => {
    writeBook('Book One', 1, bookOneId, wren({ ttsEngine: 'coqui', overrideTtsVoices: coquiClone }));
    writeBook('Book Two', 2, bookTwoId, wren(linkedToBookOne()));
    const declined = await request(app)
      .post(`/api/books/${bookTwoId}/cast/wren/decline-voice-link`)
      .send({ fromBookId: bookOneId });
    expect(declined.status).toBe(200);
    const oneBefore = readRow('Book One');

    const preview = await designRest(true);
    expect(preview.status).toBe(200);
    const kept = await promote(preview.body.voiceId);
    expect(kept.status).toBe(200);
    const saved = await apply(kept.body.voiceId);
    expect(saved.status).toBe(204);
    expect(readRow('Book One')).toEqual(oneBefore);
    expect(readRow('Book Two').overrideTtsVoices.qwen.name).toBe(kept.body.voiceId);
  });
});

describe('Design & compare when the follower clone is on the qwen engine (#4104 review)', () => {
  it('the Save is not refused, and the cloned slot keeps its libraryUuid and provenance so it still plays', async () => {
    writeBook('Book One', 1, bookOneId, wren({ voiceUuid: 'u_shared' }));
    writeBook(
      'Book Two',
      2,
      bookTwoId,
      wren({ ...linkedToBookOne(), voiceUuid: 'u_shared', declinedVoiceFrom: [bookOneId], declinedVoiceUuids: ['u_shared'] }),
    );
    const qwenClone = { qwen: { name: 'qwen-wren-clone', libraryUuid: 'L1', provenance: 'cloned' } };
    writeBook(
      'Book Three',
      3,
      bookThreeId,
      wren({
        voiceUuid: 'u_shared',
        ttsEngine: 'qwen',
        overrideTtsVoices: qwenClone,
        matchedFrom: { bookId: bookTwoId, characterId: 'wren', bookTitle: 'Book Two', confidence: 1 },
      }),
    );

    const preview = await designRest(true);
    expect(preview.status).toBe(200);
    const kept = await promote(preview.body.voiceId);
    expect(kept.status).toBe(200);
    /* the SET check counts only clones on a different engine, so a same-engine clone does not refuse */
    const saved = await apply(kept.body.voiceId);
    expect(saved.status).toBe(204);

    const three = readRow('Book Three');
    expect(three.ttsEngine).toBe('qwen');
    expect(three.overrideTtsVoices.qwen.libraryUuid).toBe('L1');
    expect(three.overrideTtsVoices.qwen.provenance).toBe('cloned');
    expect(three.overrideTtsVoices.qwen.name).toBe(kept.body.voiceId);
  });
});

/* The rebaseline modal's other non-preview caller: a REST base design, then
   `voice-override-linked` with the designed name. The group match is by shared voiceId, so
   without the decline check it walked straight back across a "Don't reuse". */
describe('voice-override-linked after a "Don\'t reuse" decline (#4104 review)', () => {
  const link = (fromBook: string, name: string) =>
    request(app)
      .post(`/api/books/${fromBook}/cast/wren/voice-override-linked`)
      .send({ override: { engine: 'qwen', name } });

  async function declineThenDesign() {
    writeBook('Book One', 1, bookOneId, wren({ voiceUuid: 'u_one' }));
    writeBook('Book Two', 2, bookTwoId, wren({ ...linkedToBookOne(), voiceUuid: 'u_one' }));
    const declined = await request(app)
      .post(`/api/books/${bookTwoId}/cast/wren/decline-voice-link`)
      .send({ fromBookId: bookOneId });
    expect(declined.status).toBe(200);
    const designed = await designRest(false);
    expect(designed.status).toBe(200);
    return designed.body.voiceId as string;
  }

  it('a rebaseline from the decliner does not put its new voice back on the book it declined', async () => {
    const name = await declineThenDesign();
    const oneBefore = readRow('Book One');
    const res = await link(bookTwoId, name);
    expect(res.status).toBe(200);
    expect(res.body.updated.map((u: { bookId: string }) => u.bookId)).not.toContain(bookOneId);
    expect(readRow('Book One')).toEqual(oneBefore);
    expect(readRow('Book Two').voiceUuid).not.toBe('u_one');
  });

  it('a rebaseline from the declined-from book does not reach the decliner', async () => {
    await declineThenDesign();
    const twoBefore = readRow('Book Two');
    const res = await link(bookOneId, 'qwen-u_one');
    expect(res.status).toBe(200);
    expect(res.body.updated.map((u: { bookId: string }) => u.bookId)).not.toContain(bookTwoId);
    expect(readRow('Book Two')).toEqual(twoBefore);
  });
});

/* Pass-2 review (#4110): only the declining row carries the marker, so its followers (and a
   book nobody declined) keep the shared voiceId and used to match across the separation.
   PR #4007 pass 13: a voice "Don't reuse" created is never shared outside its chain, so a
   separated uuid matches only a row on the SAME uuid. */
describe('voice-override-linked across a separated chain (#4110)', () => {
  const link = (fromBook: string, name: string) =>
    request(app)
      .post(`/api/books/${fromBook}/cast/wren/voice-override-linked`)
      .send({ override: { engine: 'qwen', name } });
  const ids = (res: { body: { updated: Array<{ bookId: string }> } }) => res.body.updated.map((u) => u.bookId);
  const fromTwo = () => ({
    matchedFrom: { bookId: bookTwoId, characterId: 'wren', bookTitle: 'Book Two', confidence: 1 },
  });

  /* One on u_one; Two linked to One; Three linked to Two; Two declines, so Two and Three move. */
  async function declineWithFollower() {
    writeBook('Book One', 1, bookOneId, wren({ voiceUuid: 'u_one' }));
    writeBook('Book Two', 2, bookTwoId, wren({ ...linkedToBookOne(), voiceUuid: 'u_one' }));
    writeBook('Book Three', 3, bookThreeId, wren({ ...fromTwo(), voiceUuid: 'u_one' }));
    const declined = await request(app)
      .post(`/api/books/${bookTwoId}/cast/wren/decline-voice-link`)
      .send({ fromBookId: bookOneId });
    expect(declined.status).toBe(200);
    const moved = readRow('Book Two').voiceUuid as string;
    expect(moved).not.toBe('u_one');
    expect(readRow('Book Three').voiceUuid).toBe(moved);
    const designed = await designRest(false);
    expect(designed.status).toBe(200);
    return { name: designed.body.voiceId as string, moved };
  }

  it('F-A: a rebaseline from the follower does not stamp the new voice onto the declined book', async () => {
    const { name } = await declineWithFollower();
    const oneBefore = readRow('Book One');
    const res = await link(bookThreeId, name);
    expect(res.status).toBe(200);
    expect(ids(res)).not.toContain(bookOneId);
    expect(readRow('Book One')).toEqual(oneBefore);
  });

  it('F-B: a rebaseline from the declined book does not pull the follower back', async () => {
    await declineWithFollower();
    const threeBefore = readRow('Book Three');
    const res = await link(bookOneId, 'qwen-u_one');
    expect(res.status).toBe(200);
    expect(ids(res)).not.toContain(bookThreeId);
    expect(ids(res)).not.toContain(bookTwoId);
    expect(readRow('Book Three')).toEqual(threeBefore);
  });

  it('a book nobody declined that matches by voiceId does not receive the separated uuid', async () => {
    const { name } = await declineWithFollower();
    writeBook('Book Four', 4, bookFourId, wren({ voiceUuid: 'u_four' }));
    const fourBefore = readRow('Book Four');
    const res = await link(bookTwoId, name);
    expect(res.status).toBe(200);
    expect(ids(res)).not.toContain(bookFourId);
    expect(readRow('Book Four')).toEqual(fourBefore);
  });

  it('a rebaseline within the separated chain still updates the follower', async () => {
    const { name, moved } = await declineWithFollower();
    const res = await link(bookTwoId, name);
    expect(res.status).toBe(200);
    expect(ids(res)).toContain(bookThreeId);
    expect(readRow('Book Three').voiceUuid).toBe(moved);
    expect(readRow('Book Three').overrideTtsVoices.qwen.name).toBe(name);
  });
});
