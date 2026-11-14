/* #3992 — "Don't reuse" must stick. Declining a series link durably records
   `declinedVoiceFrom: [<bookId>]` on the cast row (a narrow marker: "not THIS
   voice", deliberately weaker than `notLinkedTo`'s "not the same person"). Three
   things honour it, driven here through the REAL analysis job
   (`runMainAnalyzerJob`, via the plan 291 route-job harness) on real cast.json
   files with the default disk-walking resolvers, then a real design call on the
   persisted row:

     - the series linker never links a row to the declined book;
     - the persist never grafts a fresh link onto a row that joined a prior row
       (plan 291: a joined row's link comes from the prior row alone);
     - the fork predicate forks the shared voiceUuid only for a row that carries
       the marker, so a row nobody declined never forks.

   Plan 291 (R43): the linker runs on `new` rows only, so a case whose premise is
   "re-analysis links this row" runs on a row the prior cast does not hold.

   The sidecar fetch is mocked: it writes the voice it is asked for with DIFFERENT
   bytes, so a missing fork shows up as Book One's bytes being overwritten. */

import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll, vi } from 'vitest';
import { rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express, { type Express } from 'express';
import request from 'supertest';

/* Before any import binds BOOKS_ROOT: the books live in this workspace. */
vi.hoisted(() => {
  const fs = process.getBuiltinModule('node:fs');
  const os = process.getBuiltinModule('node:os');
  const path = process.getBuiltinModule('node:path');
  process.env.WORKSPACE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'audiobook-declined-reanalysis-'));
});

import { withCapacityRetry } from '../gpu/capacity-retry.js';
import { NARR, resetHarness, run } from './__test-helpers__/analysis-job-harness.js';
import { clearAnalysisCache } from '../store/analysis-cache.js';
import { putManuscript, removeManuscript } from '../store/manuscripts.js';
import type { CharacterOutput } from '../handoff/schemas.js';

vi.mock('undici', async (importOriginal) => {
  const actual = await importOriginal<typeof import('undici')>();
  return {
    ...actual,
    fetch: (...args: unknown[]) =>
      (globalThis.fetch as unknown as (...a: unknown[]) => unknown)(...args),
  };
});

const { synthesize } = vi.hoisted(() => ({ synthesize: vi.fn() }));
vi.mock('../tts/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../tts/index.js')>();
  return { ...actual, selectTtsProvider: vi.fn(() => ({ synthesize })) };
});
vi.mock('../gpu/gpu-load.js', () => ({
  withGpuLoad: (fn: () => Promise<unknown>) => fn(),
  GpuBusyError: class GpuBusyError extends Error {
    code = 'GPU_BUSY';
  },
}));
vi.mock('../gpu/sidecar-vram-sample.js', () => ({ maybeSampleSidecarEngine: async () => {} }));
vi.mock('../gpu/capacity-retry.js', () => ({ withCapacityRetry: vi.fn() }));
/* The four mocks the route-job harness header requires, plus its two siblings. */
vi.mock('../workspace/state-io.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../workspace/state-io.js')>();
  return { ...actual, readJson: vi.fn(actual.readJson) };
});
vi.mock('../store/cast-id-history.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../store/cast-id-history.js')>();
  return { ...actual, retireCharacterId: vi.fn(actual.retireCharacterId) };
});
vi.mock('./ollama-health.js', () => ({
  detectOllamaDevice: vi.fn(async () => 'cuda'),
  unloadResidentOllama: vi.fn(async () => {}),
}));
vi.mock('../gpu/analyzer-device-state.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../gpu/analyzer-device-state.js')>()),
  setLastKnownAnalyzerDevice: vi.fn(),
}));
vi.mock('../analyzer/select-analyzer.js', async () => {
  const actual = await vi.importActual<typeof import('../analyzer/select-analyzer.js')>(
    '../analyzer/select-analyzer.js',
  );
  return {
    ...actual,
    selectAnalyzerForPhase: (opts: { phase: 'phase0' | 'phase1' }) => {
      const g = globalThis as Record<string, unknown>;
      if (opts.phase === 'phase1' && g.__single_matcher_phase1) return g.__single_matcher_phase1;
      return actual.selectAnalyzerForPhase(opts as Parameters<typeof actual.selectAnalyzerForPhase>[0]);
    },
    isPerPhaseModelSelectionActive: () => Boolean((globalThis as Record<string, unknown>).__single_matcher_pipelined),
  };
});

const AUTHOR = 'Della Renwick';
const SERIES = 'The Hollow Tide';
const QWEN_KEY = 'qwen3-tts-0.6b';
const ORIG_PT = Buffer.from('BOOK-ONE-ORIGINAL-PT');
const NEW_PT = Buffer.from('REDESIGNED-BY-SIDECAR');

let workspaceRoot: string;
let audioDir: string;
let app: Express;
let bookOneId: string;
let bookTwoId: string;
let bookThreeId: string;
let requestedVoiceIds: string[];
/* #4028 — the sidecar renders to a private staging key; the id a design LANDED on
   is the response's voiceId. */
let landedVoiceIds: string[];
const fetchMock = vi.fn();

const qwenDir = () => join(workspaceRoot, 'voices', 'qwen');
const bookDir = (title: string) => join(workspaceRoot, 'books', AUTHOR, SERIES, title);
const castPath = (title: string) => join(bookDir(title), '.audiobook', 'cast.json');
const readRows = (title: string): Array<{ id: string } & Record<string, any>> =>
  JSON.parse(readFileSync(castPath(title), 'utf8')).characters;
/* Wren's row (a re-analysis adds the narrator alongside it). */
const readRow = (title: string): Record<string, any> => {
  const row = readRows(title).find((r) => r.id === 'wren');
  if (!row) throw new Error(`no wren row in ${title}`);
  return row;
};
const writeRows = (title: string, rows: Array<Record<string, unknown>>) =>
  writeFileSync(castPath(title), JSON.stringify({ characters: rows }));

const BODY = '“Are you sure this will work,” Wren asked.\n\nOlga nodded and looked away.';
const CHAPTERS = [
  { id: 1, title: 'Chapter One', slug: '01-chapter-one' },
  { id: 2, title: 'Chapter Two', slug: '02-chapter-two' },
  { id: 3, title: 'Chapter Three', slug: '03-chapter-three' },
];
/* title -> the manuscript registered for that book in this test. */
const manuscripts = new Map<string, string>();

function writeBook(title: string, position: number, id: string, rows: Array<Record<string, unknown>>) {
  const dir = bookDir(title);
  const manuscriptId = `m_${id}_${Date.now()}_${Math.random()}`;
  mkdirSync(join(dir, '.audiobook'), { recursive: true });
  writeFileSync(
    join(dir, '.audiobook', 'state.json'),
    JSON.stringify({
      bookId: id,
      manuscriptId,
      title,
      author: AUTHOR,
      series: SERIES,
      seriesPosition: position,
      isStandalone: false,
      manuscriptFile: 'manuscript.md',
      castConfirmed: true,
      chapters: CHAPTERS,
      language: 'en',
      coverGradient: ['#000', '#fff'],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }),
  );
  writeFileSync(join(dir, 'manuscript.md'), BODY);
  writeRows(title, rows);
  const chapterHints = CHAPTERS.map((c) => ({ id: c.id, title: c.title, body: BODY }));
  putManuscript({
    manuscriptId,
    format: 'plaintext',
    title,
    wordCount: 100,
    byteSize: 1000,
    uploadedAt: new Date().toISOString(),
    sourceText: chapterHints.map((c) => c.body).join('\n\n'),
    chapterHints,
    bookId: id,
    bookDir: dir,
  });
  manuscripts.set(title, manuscriptId);
}

const baseRow = {
  id: 'wren',
  name: 'Wren',
  role: 'supporting',
  color: 'sky',
  voiceId: 'v_wren',
  voiceUuid: 'u_shared',
  voiceStyle: 'a bright voice',
  evidence: [{ quote: '"Hello there."' }],
};
const voiced = {
  ...baseRow,
  gender: 'female',
  ageRange: 'adult',
  overrideTtsVoices: { qwen: { name: 'qwen-u_shared' } },
  ttsEngine: 'qwen',
  voiceState: 'generated',
};
const freshWren = () => ({
  id: 'wren',
  name: 'Wren',
  role: 'supporting',
  color: 'sky',
  gender: 'female',
  ageRange: 'adult',
});

function pcm() {
  return new Uint8Array(24_000 * 2 * 0.3);
}

const origCoverageRetries = process.env.STAGE2_COVERAGE_RETRIES;

beforeAll(async () => {
  process.env.CASTWRIGHT_VRAM_SAMPLE = '0';
  workspaceRoot = process.env.WORKSPACE_DIR as string;
  audioDir = join(tmpdir(), `audiobook-declined-reanalysis-audio-${Date.now()}`);
  mkdirSync(audioDir, { recursive: true });
  process.env.VOICE_SAMPLE_AUDIO_DIR = audioDir;
  vi.stubGlobal('fetch', fetchMock);

  const { qwenVoiceRouter } = await import('./qwen-voice.js');
  const { makeBookId } = await import('../workspace/paths.js');
  bookOneId = makeBookId(AUTHOR, SERIES, 'Book One');
  bookTwoId = makeBookId(AUTHOR, SERIES, 'Book Two');
  bookThreeId = makeBookId(AUTHOR, SERIES, 'Book Three');
  app = express();
  app.use(express.json());
  app.use('/api/books', qwenVoiceRouter);
});

beforeEach(() => {
  requestedVoiceIds = [];
  landedVoiceIds = [];
  fetchMock.mockReset();
  fetchMock.mockImplementation(async (_url: unknown, init: { body?: string } | undefined) => {
    let voiceId: string | undefined;
    try {
      const b = JSON.parse(init?.body ?? '{}');
      voiceId = b.variantVoiceId ?? b.voiceId;
    } catch {
      /* not a design call */
    }
    if (voiceId && !String(_url).includes('evict')) {
      requestedVoiceIds.push(voiceId);
      mkdirSync(qwenDir(), { recursive: true });
      writeFileSync(join(qwenDir(), `${voiceId}.pt`), NEW_PT);
    }
    const bytes = pcm();
    return {
      ok: true,
      status: 200,
      statusText: 'OK',
      headers: new Headers({ 'Content-Type': 'audio/L16', 'X-Sample-Rate': '24000' }),
      arrayBuffer: async () => bytes.buffer,
      json: async () => ({}),
    };
  });
  synthesize.mockReset();
  vi.mocked(withCapacityRetry).mockReset();
  vi.mocked(withCapacityRetry).mockImplementation((doPost, opts) => doPost(opts.signal));
  process.env.STAGE2_COVERAGE_RETRIES = '0';
  rmSync(join(workspaceRoot, 'books'), { recursive: true, force: true });
  rmSync(join(workspaceRoot, 'voices'), { recursive: true, force: true });
  mkdirSync(qwenDir(), { recursive: true });
  writeFileSync(join(qwenDir(), 'qwen-u_shared.pt'), ORIG_PT);
});

afterEach(async () => {
  resetHarness();
  if (origCoverageRetries === undefined) delete process.env.STAGE2_COVERAGE_RETRIES;
  else process.env.STAGE2_COVERAGE_RETRIES = origCoverageRetries;
  for (const id of manuscripts.values()) {
    removeManuscript(id);
    await clearAnalysisCache(id);
  }
  manuscripts.clear();
});

afterAll(() => {
  vi.unstubAllGlobals();
  rmSync(workspaceRoot, { recursive: true, force: true });
  rmSync(audioDir, { recursive: true, force: true });
  delete process.env.WORKSPACE_DIR;
  delete process.env.VOICE_SAMPLE_AUDIO_DIR;
});

/* Re-analyse a book through the real main analysis job (the route-job harness):
   the analyzer's roster is the narrator plus Wren (with `wren` merged onto Wren's
   fresh row), Wren speaks one line a chapter, and the job persists cast.json.
   Returns Wren's persisted row. */
async function reanalyse(
  opts: { title?: string; wren?: Record<string, unknown> } = {},
): Promise<Record<string, any>> {
  const title = opts.title ?? 'Book Two';
  const manuscriptId = manuscripts.get(title);
  if (!manuscriptId) throw new Error(`no manuscript for ${title}`);
  const events = await run(manuscriptId, bookDir(title), 'main', {
    roster: [NARR, { ...freshWren(), ...opts.wren } as unknown as CharacterOutput],
    speakerId: 'wren',
  });
  if (!events.some((e) => e.kind === 'result')) {
    throw new Error(`re-analysis of ${title} did not complete: ${JSON.stringify(events.filter((e) => e.kind === 'error'))}`);
  }
  return readRow(title);
}

/* Two prior rows fresh "Wren" both match by surname (T3), so the plan makes it a
   `new` row suggesting both; `marker` goes on the first. */
const twinCandidates = (marker: Record<string, unknown>) => [
  { id: 'wren-ash', name: 'Wren Ash', role: 'supporting', color: 'sky', ...marker },
  { id: 'wren-bay', name: 'Wren Bay', role: 'supporting', color: 'sky' },
];

/* A fresh link onto Book One's Wren, as the series linker would stamp it: what the
   persist must not graft onto a row that joined a prior row. */
const freshLinkToBookOne = () => ({
  matchedFrom: { bookId: bookOneId, characterId: 'wren', bookTitle: 'Book One', confidence: 1 },
  voiceUuid: 'u_shared',
  overrideTtsVoices: { qwen: { name: 'qwen-u_shared' } },
});

const design = (id: string, extra: Record<string, unknown> = {}) =>
  request(app)
    .post(`/api/books/${id}/cast/wren/design-voice`)
    .send({ sampleVoiceId: 'v_wren', modelKey: QWEN_KEY, ...extra })
    .then((res) => {
      if (typeof res.body?.voiceId === 'string') landedVoiceIds.push(res.body.voiceId);
      return res;
    });

const book1Intact = () => readFileSync(join(qwenDir(), 'qwen-u_shared.pt')).equals(ORIG_PT);

describe('#3992 — Don’t reuse survives re-analysis (the four rows of the pass-1 table)', () => {
  it('A. declined, not redesigned: stays unlinked, keeps the marker, and a later redesign forks off Book One', async () => {
    writeBook('Book One', 1, bookOneId, [{ ...voiced }]);
    writeBook('Book Two', 2, bookTwoId, [{ ...voiced, declinedVoiceFrom: [bookOneId] }]);
    const merged = await reanalyse();
    expect(merged.matchedFrom).toBeUndefined();
    expect(merged.voiceUuid).toBe('u_shared');
    expect(merged.declinedVoiceFrom).toEqual([bookOneId]);

    const res = await design(bookTwoId);
    expect(res.status).toBe(200);
    expect(landedVoiceIds).toHaveLength(1);
    expect(landedVoiceIds[0]).not.toBe('qwen-u_shared');
    expect(book1Intact()).toBe(true);
    expect(readRow('Book Two').voiceUuid).not.toBe('u_shared');
  });

  it('B. declined and forked, still generated (A/B Cancel, promote without Save, bulk): not re-linked, keeps its own voice', async () => {
    writeBook('Book One', 1, bookOneId, [{ ...voiced }]);
    writeBook('Book Two', 2, bookTwoId, [{ ...voiced, declinedVoiceFrom: [bookOneId] }]);
    expect((await design(bookTwoId)).status).toBe(200);
    const forked = readRow('Book Two').voiceUuid;
    expect(forked).not.toBe('u_shared');

    const merged = await reanalyse();
    expect(merged.voiceUuid).toBe(forked);
    expect(merged.matchedFrom).toBeUndefined();
    expect(merged.declinedVoiceFrom).toEqual([bookOneId]);
    expect(book1Intact()).toBe(true);
  });

  it('C. declined, forked and Saved (tuned): stays off the link and keeps the marker', async () => {
    writeBook('Book One', 1, bookOneId, [{ ...voiced }]);
    writeBook('Book Two', 2, bookTwoId, [{ ...voiced, declinedVoiceFrom: [bookOneId] }]);
    expect((await design(bookTwoId)).status).toBe(200);
    const forked = readRow('Book Two').voiceUuid;
    writeRows('Book Two', [{ ...readRow('Book Two'), voiceState: 'tuned' }]);

    const merged = await reanalyse();
    expect(merged.voiceUuid).toBe(forked);
    expect(merged.matchedFrom).toBeUndefined();
    expect(merged.declinedVoiceFrom).toEqual([bookOneId]);
  });

  it('D. control: a notLinkedTo edge is still not re-linked', async () => {
    writeBook('Book One', 1, bookOneId, [{ ...voiced }]);
    writeBook('Book Two', 2, bookTwoId, [
      { ...voiced, notLinkedTo: [{ bookId: bookOneId, characterId: 'wren' }] },
    ]);
    const merged = await reanalyse();
    expect(merged.matchedFrom).toBeUndefined();
  });

  it('E. persist backstop: a fresh link to the declined book is not grafted onto the joined row, the prior voice kept', async () => {
    writeBook('Book One', 1, bookOneId, [{ ...voiced }]);
    writeBook('Book Two', 2, bookTwoId, [
      { ...voiced, voiceUuid: 'u_own', overrideTtsVoices: { qwen: { name: 'qwen-u_own' } }, declinedVoiceFrom: [bookOneId] },
    ]);
    /* The fresh row arrives already linked to Book One (a link no guard stopped);
       only the joined-row rule (applyMatchPlan, then the persist overlay) can keep
       it off the row. */
    const merged = await reanalyse({ wren: freshLinkToBookOne() });
    expect(merged.matchedFrom).toBeUndefined();
    expect(merged.voiceUuid).toBe('u_own');
    expect(merged.declinedVoiceFrom).toEqual([bookOneId]);
  });

  /* Plan 291 (R43, R46): restated on a `new` row, where the linker runs. Fresh
     "Wren" is ambiguous between two prior rows, so it is `new` and inherits the
     candidates' decline markers at the linker. */
  it('F. the marker names ONE book: a link to a different earlier book is still made', async () => {
    writeBook('Book One', 1, bookOneId, [{ ...voiced }]);
    writeBook('Book Two', 2, bookTwoId, twinCandidates({ declinedVoiceFrom: ['some-other-book'] }));
    const merged = await reanalyse();
    expect(merged.matchedFrom?.bookId).toBe(bookOneId);
  });
});

describe('#3992 — a row with no marker is linked as before', () => {
  /* Plan 291 (R43): the original claim, that a pre-#3992 declined JOINED row is
     re-linked, is retired - a joined row is never re-linked (plan-overlay A7b).
     Restated on a `new` row, where the linker runs. */
  it('G. a new row with no marker is linked to the earlier book', async () => {
    writeBook('Book One', 1, bookOneId, [{ ...voiced }]);
    writeBook('Book Two', 2, bookTwoId, []);
    const merged = await reanalyse();
    expect(merged.matchedFrom?.bookId).toBe(bookOneId);
  });
});

describe('#3992 pass-1 finding 3 — a row nobody declined never forks', () => {
  it('H. two rows sharing a series key, no link, no marker: designing Book One twice leaves Book Two on the same uuid', async () => {
    const noUuid = { ...baseRow, voiceUuid: undefined };
    writeBook('Book One', 1, bookOneId, [{ ...noUuid }]);
    writeBook('Book Two', 2, bookTwoId, [{ ...noUuid }]);
    /* Pass 11 (owner decision): the series mint stamps the linked rows only when
       it has a designed legacy voice to copy, so the shared key is designed. */
    writeFileSync(join(qwenDir(), 'qwen-v_wren.pt'), ORIG_PT);
    expect((await design(bookOneId)).status).toBe(200);
    const first = readRow('Book One').voiceUuid;
    expect(first).toBeTruthy();
    expect(readRow('Book Two').voiceUuid).toBe(first);

    expect((await design(bookOneId)).status).toBe(200);
    expect(readRow('Book One').voiceUuid).toBe(first);
    expect(readRow('Book Two').voiceUuid).toBe(first);
  });
});

describe('#3992 — the series linker on its own', () => {
  const linkFresh = async (extra: Record<string, unknown>, bookId = bookTwoId) => {
    const L = await import('../workspace/series-reuse-link.js');
    const fresh = [{ ...freshWren(), ...extra }] as any[];
    const linked = await L.linkSeriesReuseAtAnalysis(bookId, fresh);
    return { linked, row: fresh[0] };
  };

  it('never links a row to a book holding a voice uuid in its declinedVoiceUuids', async () => {
    writeBook('Book One', 1, bookOneId, [{ ...voiced }]);
    writeBook('Book Two', 2, bookTwoId, [
      { ...voiced, matchedFrom: { bookId: bookOneId, characterId: 'wren', bookTitle: 'Book One', confidence: 1 } },
    ]);
    writeBook('Book Three', 3, bookThreeId, []);
    const { linked, row } = await linkFresh(
      { declinedVoiceFrom: [bookTwoId], declinedVoiceUuids: ['u_shared'] },
      bookThreeId,
    );
    expect(linked).toBe(0);
    expect(row.matchedFrom).toBeUndefined();
  });

  it('never links a row to a book in its declinedVoiceFrom, and leaves the row untouched', async () => {
    writeBook('Book One', 1, bookOneId, [{ ...voiced }]);
    writeBook('Book Two', 2, bookTwoId, [{ ...voiced }]);
    const { linked, row } = await linkFresh({ declinedVoiceFrom: [bookOneId] });
    expect(linked).toBe(0);
    expect(row.matchedFrom).toBeUndefined();
    expect(row.voiceUuid).toBeUndefined();
  });

  it('the same row WITHOUT the marker links (the marker is what stops it)', async () => {
    writeBook('Book One', 1, bookOneId, [{ ...voiced }]);
    writeBook('Book Two', 2, bookTwoId, [{ ...voiced }]);
    const { linked, row } = await linkFresh({});
    expect(linked).toBe(1);
    expect(row.matchedFrom?.bookId).toBe(bookOneId);
  });
});

describe('#3992 pass-2 V — the marker names a voice, not only a book', () => {
  /* Book Two is linked to Book One (both hold u_shared). Book Three declined
     Book Two's voice. Linking Book Three to Book One would hand it the very same
     u_shared, so the decline has to cover every book holding that voice. */
  const seedThree = (marker: Record<string, unknown>) => {
    writeBook('Book One', 1, bookOneId, [{ ...voiced }]);
    writeBook('Book Two', 2, bookTwoId, [
      { ...voiced, matchedFrom: { bookId: bookOneId, characterId: 'wren', bookTitle: 'Book One', confidence: 1 } },
    ]);
    writeBook('Book Three', 3, bookThreeId, [{ ...voiced, ...marker }]);
  };

  it('re-analysis does not link Book Three to Book One, which holds the declined voice', async () => {
    seedThree({ declinedVoiceFrom: [bookTwoId], declinedVoiceUuids: ['u_shared'] });
    const merged = await reanalyse({ title: 'Book Three' });
    expect(merged.matchedFrom).toBeUndefined();
    expect(merged.declinedVoiceUuids).toEqual(['u_shared']);

    expect((await design(bookThreeId)).status).toBe(200);
    expect(book1Intact()).toBe(true);
  });

  it('the persist backstop keeps a fresh link whose voice uuid was declined off the joined row, whatever its book', async () => {
    seedThree({
      declinedVoiceFrom: [bookTwoId],
      declinedVoiceUuids: ['u_shared'],
      voiceUuid: 'u_own',
      overrideTtsVoices: { qwen: { name: 'qwen-u_own' } },
    });
    const merged = await reanalyse({ title: 'Book Three', wren: freshLinkToBookOne() });
    expect(merged.matchedFrom).toBeUndefined();
    expect(merged.voiceUuid).toBe('u_own');
  });

  /* Plan 291 (R46): a `new` row (fresh "Wren" between two prior candidates) is
     not linked to Book One when a candidate declined Book Two's voice uuid -
     Book One holds the same uuid. The new row inherits the marker at the linker. */
  it('a new row whose candidate declined the voice uuid is not linked to a book holding it', async () => {
    writeBook('Book One', 1, bookOneId, [{ ...voiced }]);
    writeBook('Book Two', 2, bookTwoId, [
      { ...voiced, matchedFrom: { bookId: bookOneId, characterId: 'wren', bookTitle: 'Book One', confidence: 1 } },
    ]);
    writeBook('Book Three', 3, bookThreeId, twinCandidates({ declinedVoiceFrom: [bookTwoId], declinedVoiceUuids: ['u_shared'] }));
    const merged = await reanalyse({ title: 'Book Three' });
    expect(merged.matchedFrom).toBeUndefined();
    // The marker stays in the linker's view: the linker never writes it onto the row.
    expect(merged.declinedVoiceFrom).toBeUndefined();
    expect(merged.declinedVoiceUuids).toBeUndefined();
  });

  /* Plan 291 (R43, R46): restated on a `new` row, which inherits the candidates'
     markers at the linker. */
  it('control: a link to a book holding a DIFFERENT voice is still made', async () => {
    writeBook('Book One', 1, bookOneId, [{ ...voiced, voiceUuid: 'u_other', overrideTtsVoices: { qwen: { name: 'qwen-u_other' } } }]);
    writeBook('Book Two', 2, bookTwoId, [{ ...voiced }]);
    writeBook('Book Three', 3, bookThreeId, twinCandidates({ declinedVoiceFrom: [bookTwoId], declinedVoiceUuids: ['u_shared'] }));
    const merged = await reanalyse({ title: 'Book Three' });
    expect(merged.matchedFrom?.bookId).toBe(bookOneId);
  });
});
