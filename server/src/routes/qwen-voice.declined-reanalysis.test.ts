/* #3992 — "Don't reuse" must stick. Declining a series link durably records
   `declinedVoiceFrom: [<bookId>]` on the cast row (a narrow marker: "not THIS
   voice", deliberately weaker than `notLinkedTo`'s "not the same person"). Three
   things honour it, driven here through the REAL pipeline on real cast.json files
   with the default disk-walking resolvers (seed, prune, link, remap, merge, then a
   real design call on the merged row):

     - the series linker never re-links the row to the declined book;
     - the analysis merge never grafts a fresh link to the declined book onto it;
     - the fork predicate forks the shared voiceUuid only for a row that carries
       the marker, so a row nobody declined never forks.

   The sidecar fetch is mocked: it writes the voice it is asked for with DIFFERENT
   bytes, so a missing fork shows up as Book One's bytes being overwritten. */

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
let requestedVoiceIds: string[];
const fetchMock = vi.fn();

const qwenDir = () => join(workspaceRoot, 'voices', 'qwen');
const bookDir = (title: string) => join(workspaceRoot, 'books', AUTHOR, SERIES, title);
const castPath = (title: string) => join(bookDir(title), '.audiobook', 'cast.json');
const readRows = (title: string): Array<{ id: string } & Record<string, any>> =>
  JSON.parse(readFileSync(castPath(title), 'utf8')).characters;
const readRow = (title: string): Record<string, any> => readRows(title)[0];
const writeRows = (title: string, rows: Array<Record<string, unknown>>) =>
  writeFileSync(castPath(title), JSON.stringify({ characters: rows }));

function writeBook(title: string, position: number, id: string, rows: Array<Record<string, unknown>>) {
  const dir = bookDir(title);
  mkdirSync(join(dir, '.audiobook'), { recursive: true });
  writeFileSync(
    join(dir, '.audiobook', 'state.json'),
    JSON.stringify({
      bookId: id,
      manuscriptId: `m_${id}`,
      title,
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
  writeFileSync(join(dir, 'manuscript.txt'), 'placeholder');
  writeRows(title, rows);
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
const freshRoster = () => [
  { id: 'wren', name: 'Wren', role: 'supporting', color: 'sky', gender: 'female', ageRange: 'adult' },
];

function pcm() {
  return new Uint8Array(24_000 * 2 * 0.3);
}

beforeAll(async () => {
  process.env.CASTWRIGHT_VRAM_SAMPLE = '0';
  workspaceRoot = mkdtempSync(join(tmpdir(), 'audiobook-declined-reanalysis-'));
  audioDir = mkdtempSync(join(tmpdir(), 'audiobook-declined-reanalysis-audio-'));
  process.env.WORKSPACE_DIR = workspaceRoot;
  process.env.VOICE_SAMPLE_AUDIO_DIR = audioDir;
  vi.stubGlobal('fetch', fetchMock);

  const { qwenVoiceRouter } = await import('./qwen-voice.js');
  const { makeBookId } = await import('../workspace/paths.js');
  bookOneId = makeBookId(AUTHOR, SERIES, 'Book One');
  bookTwoId = makeBookId(AUTHOR, SERIES, 'Book Two');
  app = express();
  app.use(express.json());
  app.use('/api/books', qwenVoiceRouter);
});

beforeEach(() => {
  requestedVoiceIds = [];
  fetchMock.mockReset();
  fetchMock.mockImplementation(async (_url: unknown, init: { body?: string } | undefined) => {
    let voiceId: string | undefined;
    try {
      const b = JSON.parse(init?.body ?? '{}');
      voiceId = b.variantVoiceId ?? b.voiceId;
    } catch {
      /* not a design call */
    }
    if (voiceId) {
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
  rmSync(join(workspaceRoot, 'books'), { recursive: true, force: true });
  rmSync(join(workspaceRoot, 'voices'), { recursive: true, force: true });
  mkdirSync(qwenDir(), { recursive: true });
  writeFileSync(join(qwenDir(), 'qwen-u_shared.pt'), ORIG_PT);
});

afterAll(() => {
  vi.unstubAllGlobals();
  rmSync(workspaceRoot, { recursive: true, force: true });
  rmSync(audioDir, { recursive: true, force: true });
  delete process.env.WORKSPACE_DIR;
  delete process.env.VOICE_SAMPLE_AUDIO_DIR;
});

/* The analysis route's main-job order, with the DEFAULT disk-walking resolvers.
   `seed: false` skips the guard seeding, which is how a row the seed's name bridge
   misses (roster dedup moved the join) reaches the merge with a fresh link. */
async function reanalyse(opts: { seed?: boolean } = {}): Promise<Record<string, any>> {
  const M = await import('../store/merge-analysis-cast.js');
  const L = await import('../workspace/series-reuse-link.js');
  const R = await import('../store/remap-fresh-to-prior.js');
  const D = await import('../analyzer/roster-dedup.js');
  const prior = readRows('Book Two');
  const fresh = freshRoster() as any[];
  if (opts.seed !== false) M.seedReuseGuardsFromPriorCast(prior, fresh);
  await L.pruneStaleReuseLinks(bookTwoId, fresh);
  await L.linkSeriesReuseAtAnalysis(bookTwoId, fresh);
  const cumulative = D.stripEstablishedAsciiRewrites(D.composeRewrites({}, {}), prior, fresh);
  const remappedToPrior = R.remapFreshToPriorIds(fresh, [], prior, cumulative);
  const remapped = M.applyRewriteToPriorCast(prior, cumulative);
  const { characters: merged } = M.mergeAnalysisResultWithExistingCast(remapped.priorCast, remappedToPrior.characters);
  return merged[0] as Record<string, any>;
}

const design = (id: string, extra: Record<string, unknown> = {}) =>
  request(app)
    .post(`/api/books/${id}/cast/wren/design-voice`)
    .send({ sampleVoiceId: 'v_wren', modelKey: QWEN_KEY, ...extra });

const book1Intact = () => readFileSync(join(qwenDir(), 'qwen-u_shared.pt')).equals(ORIG_PT);

describe('#3992 — Don’t reuse survives re-analysis (the four rows of the pass-1 table)', () => {
  it('A. declined, not redesigned: stays unlinked, keeps the marker, and a later redesign forks off Book One', async () => {
    writeBook('Book One', 1, bookOneId, [{ ...voiced }]);
    writeBook('Book Two', 2, bookTwoId, [{ ...voiced, declinedVoiceFrom: [bookOneId] }]);
    const merged = await reanalyse();
    expect(merged.matchedFrom).toBeUndefined();
    expect(merged.voiceUuid).toBe('u_shared');
    expect(merged.declinedVoiceFrom).toEqual([bookOneId]);

    writeRows('Book Two', [merged]);
    const res = await design(bookTwoId);
    expect(res.status).toBe(200);
    expect(requestedVoiceIds).toHaveLength(1);
    expect(requestedVoiceIds[0]).not.toBe('qwen-u_shared');
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

  it('E. merge backstop: a fresh link to the declined book the seed missed is dropped, the prior voice kept', async () => {
    writeBook('Book One', 1, bookOneId, [{ ...voiced }]);
    writeBook('Book Two', 2, bookTwoId, [
      { ...voiced, voiceUuid: 'u_own', overrideTtsVoices: { qwen: { name: 'qwen-u_own' } }, declinedVoiceFrom: [bookOneId] },
    ]);
    /* seed:false — the fresh row reaches the linker with no marker, so it links to
       Book One; only the merge can stop that graft. */
    const merged = await reanalyse({ seed: false });
    expect(merged.matchedFrom).toBeUndefined();
    expect(merged.voiceUuid).toBe('u_own');
    expect(merged.declinedVoiceFrom).toEqual([bookOneId]);
  });

  it('F. the marker names ONE book: a link to a different earlier book is still made', async () => {
    writeBook('Book One', 1, bookOneId, [{ ...voiced }]);
    writeBook('Book Two', 2, bookTwoId, [{ ...voiced, declinedVoiceFrom: ['some-other-book'] }]);
    const merged = await reanalyse();
    expect(merged.matchedFrom?.bookId).toBe(bookOneId);
  });
});

describe('#3992 — pre-existing declined rows (no marker) behave exactly as before', () => {
  it('G. a row declined before this shipped has no marker, so re-analysis re-links it (unchanged)', async () => {
    writeBook('Book One', 1, bookOneId, [{ ...voiced }]);
    writeBook('Book Two', 2, bookTwoId, [{ ...voiced }]);
    const merged = await reanalyse();
    expect(merged.matchedFrom?.bookId).toBe(bookOneId);
  });
});

describe('#3992 pass-1 finding 3 — a row nobody declined never forks', () => {
  it('H. two rows sharing a series key, no link, no marker: designing Book One twice leaves Book Two on the same uuid', async () => {
    const noUuid = { ...baseRow, voiceUuid: undefined };
    writeBook('Book One', 1, bookOneId, [{ ...noUuid }]);
    writeBook('Book Two', 2, bookTwoId, [{ ...noUuid }]);
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
  const linkFresh = async (extra: Record<string, unknown>) => {
    const L = await import('../workspace/series-reuse-link.js');
    const fresh = [{ ...freshRoster()[0], ...extra }] as any[];
    const linked = await L.linkSeriesReuseAtAnalysis(bookTwoId, fresh);
    return { linked, row: fresh[0] };
  };

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
