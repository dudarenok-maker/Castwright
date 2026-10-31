/* #3713 / PR #4004 pass 1 (owner decision) -- twins that share a bookId AND a
   manuscriptId (a hand-copied folder, the #3711 split, a pre-#3823 re-import).
   `hydrateFromDisk` and `findBookByManuscriptId` take the first match, so once the
   sweep made the loser reachable, its Analyse wrote into the walk-first twin.
   The sweep now re-mints the loser's manuscriptId in the same state.json write
   and rekeys what lives in its own folder. */

import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express, { type Express } from 'express';
import request from 'supertest';

type G = Record<string, unknown>;
const g = globalThis as G;

/* Paths whose atomic write throws EPERM; everything else is real. */
const failWrite = vi.hoisted(() => new Set<string>());

vi.mock('./state-io.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./state-io.js')>();
  return {
    ...actual,
    writeJsonAtomic: async (path: string, ...rest: unknown[]) => {
      if (failWrite.has(path)) {
        throw Object.assign(new Error(`EPERM: operation not permitted, rename '${path}'`), { code: 'EPERM' });
      }
      return (actual.writeJsonAtomic as (...a: unknown[]) => unknown)(path, ...rest);
    },
  };
});
vi.mock('../routes/ollama-health.js', () => ({
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
      const sel = (globalThis as G)[opts.phase === 'phase1' ? '__ovr_phase1' : '__ovr_phase0'];
      return sel ?? actual.selectAnalyzerForPhase(opts as never);
    },
    isPerPhaseModelSelectionActive: () => false,
  };
});

let root: string;
let app: Express;
let paths: typeof import('./paths.js');
let sweep: typeof import('./duplicate-bookid-sweep.js');
let store: typeof import('../store/manuscripts.js');
let lock: typeof import('./book-op-lock.js');
let warn: ReturnType<typeof vi.spyOn>;

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'audiobook-dup-bookid-manuscript-'));
  process.env.WORKSPACE_DIR = root;
  process.env.STAGE2_COVERAGE_RETRIES = '0';
  /* Sequential imports -- a Promise.all of dynamic imports races vi.mock factories (#2083). */
  const analysisModule = await import('../routes/analysis.js');
  paths = await import('./paths.js');
  sweep = await import('./duplicate-bookid-sweep.js');
  store = await import('../store/manuscripts.js');
  lock = await import('./book-op-lock.js');
  app = express();
  app.use(express.json());
  app.use('/api/manuscripts', analysisModule.analysisRouter);
  vi.spyOn(console, 'log').mockImplementation(() => {});
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
}, 120_000);

afterAll(() => {
  vi.restoreAllMocks();
  rmSync(root, { recursive: true, force: true });
  delete process.env.WORKSPACE_DIR;
});

afterEach(() => {
  failWrite.clear();
  warn.mockClear();
  delete g.__ovr_phase0;
  delete g.__ovr_phase1;
  rmSync(join(root, 'books'), { recursive: true, force: true });
  lock.__bookDirIndexForTest().clear();
  lock.__duplicateBookIdsForTest().clear();
  sweep.__resetDuplicateBookIdRepairsForTest();
});

const nova = () => ({ id: 'nova', name: 'Nova', role: 'character', color: '#abc', evidence: [{ quote: 'speaks' }] });
function stub() {
  return {
    runStage1: () => Promise.reject(new Error('not used')),
    async runStage1Chapter() {
      return { characters: [nova()] };
    },
    async runStage2Chapter(_m: string, chapterId: number) {
      return { sentences: [{ id: chapterId * 100 + 1, chapterId, characterId: 'nova', confidence: 0.9, text: 'x' }] };
    },
    runEmotionChapter: () => Promise.reject(new Error('not used')),
    runScriptReviewChapter: () => Promise.reject(new Error('not used')),
    runStage3Chapter: () => Promise.reject(new Error('not used')),
    runAttributionEscalation: () => Promise.resolve(null),
  };
}
const sel = (a: unknown) => ({ analyzer: a, engine: 'gemini', model: 'gemini-3.6-flash', fallbackModel: null, fallbackEngine: null });

function seed(title: string, bookId: string, manuscriptId: string, rendered: boolean, cast: boolean): string {
  const dir = join(paths.BOOKS_ROOT, 'Auth', 'Ser', title);
  mkdirSync(join(dir, '.audiobook'), { recursive: true });
  writeFileSync(join(dir, 'manuscript.md'), `# Chapter One\n\n"Alpha speaks." Text of ${title}.\n`);
  writeFileSync(
    paths.stateJsonPath(dir),
    JSON.stringify({
      bookId,
      manuscriptId,
      title,
      author: 'Auth',
      series: 'Ser',
      seriesPosition: 1,
      isStandalone: false,
      manuscriptFile: 'manuscript.md',
      castConfirmed: true,
      language: 'en',
      chapters: [
        {
          id: 1,
          title: 'Chapter One',
          slug: '01-chapter-one',
          ...(rendered ? { audioRenderedAt: '2026-02-01T00:00:00.000Z' } : {}),
        },
      ],
      coverGradient: ['#000', '#fff'],
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      schema: 1,
    }),
  );
  if (cast) {
    writeFileSync(
      paths.castJsonPath(dir),
      JSON.stringify({ characters: [{ id: 'hero', name: 'Hero', voiceId: 'tuned-voice', voiceState: 'tuned' }] }),
    );
  }
  return dir;
}

const readState = (dir: string) => JSON.parse(readFileSync(paths.stateJsonPath(dir), 'utf8'));

/** The winner (rendered + cast, so it ranks first) and a copy sharing both ids. */
function sharedPair(mid = 'm_shared') {
  const winner = seed('Book', 'auth__ser__book', mid, true, true);
  const loser = seed('Book copy', 'auth__ser__book', mid, false, false);
  return { winner, loser, mid };
}

describe('twins that share a manuscriptId', () => {
  it('Analyse on the re-minted loser writes the loser and leaves the winner byte-identical', async () => {
    const { winner, loser, mid } = sharedPair();
    const [repair] = await sweep.repairDuplicateBookIds();
    const loserState = readState(loser);
    expect(loserState.bookId).toBe(repair.newBookId);
    expect(loserState.manuscriptId).not.toBe(mid);
    expect(loserState.manuscriptId).toMatch(/^mns_/);

    const winnerState = readFileSync(paths.stateJsonPath(winner));
    const winnerCast = readFileSync(paths.castJsonPath(winner));
    g.__ovr_phase0 = sel(stub());
    g.__ovr_phase1 = sel(stub());

    await request(app).post(`/api/manuscripts/${loserState.manuscriptId}/analysis`).send({});
    await vi.waitFor(() => expect(lock.bookJobKinds(repair.newBookId)).toEqual([]), { timeout: 15_000 });

    expect(readFileSync(paths.stateJsonPath(winner)).equals(winnerState)).toBe(true);
    expect(readFileSync(paths.castJsonPath(winner)).equals(winnerCast)).toBe(true);
    expect(existsSync(paths.manuscriptEditsJsonPath(winner))).toBe(false);
    /* The loser's folder is the one that was written. */
    expect(existsSync(paths.castJsonPath(loser))).toBe(true);
  }, 60_000);

  it("the winner's manuscriptId still resolves to the winner", async () => {
    const { winner, mid } = sharedPair();
    await sweep.repairDuplicateBookIds();
    expect(readState(winner).manuscriptId).toBe(mid);
    const rec = await store.getOrHydrateManuscript(mid);
    expect(rec?.bookDir).toBe(winner);
    expect(rec?.bookId).toBe('auth__ser__book');
  });

  it("the loser's manuscriptId hydrates to the loser", async () => {
    const { loser } = sharedPair();
    const [repair] = await sweep.repairDuplicateBookIds();
    const rec = await store.getOrHydrateManuscript(readState(loser).manuscriptId);
    expect(rec?.bookDir).toBe(loser);
    expect(rec?.bookId).toBe(repair.newBookId);
  });

  it('a second start is a no-op: no repair, manuscriptId unchanged', async () => {
    const { loser, mid } = sharedPair();
    await sweep.repairDuplicateBookIds();
    expect(readState(loser).manuscriptId).not.toBe(mid);
    const once = readFileSync(paths.stateJsonPath(loser));
    expect(await sweep.repairDuplicateBookIds()).toEqual([]);
    expect(readFileSync(paths.stateJsonPath(loser)).equals(once)).toBe(true);
  });

  it('a differing manuscriptId is left alone (only the bookId changes)', async () => {
    const winner = seed('Book', 'auth__ser__book', 'm_a', true, true);
    const loser = seed('Book copy', 'auth__ser__book', 'm_b', false, false);
    await sweep.repairDuplicateBookIds();
    expect(readState(loser).manuscriptId).toBe('m_b');
    expect(readState(winner).manuscriptId).toBe('m_a');
  });

  it('a three-way group gives each loser its own manuscriptId', async () => {
    seed('Book', 'auth__ser__book', 'm_shared', true, true);
    const b = seed('Book b', 'auth__ser__book', 'm_shared', false, false);
    const c = seed('Book c', 'auth__ser__book', 'm_shared', false, false);
    await sweep.repairDuplicateBookIds();
    const ids = new Set(['m_shared', readState(b).manuscriptId, readState(c).manuscriptId]);
    expect(ids.size).toBe(3);
  });

  it('two losers that share an id only with each other: the second keeps it once the first is re-minted', async () => {
    seed('Book', 'auth__ser__book', 'm_win', true, true);
    const b = seed('Book b', 'auth__ser__book', 'm_pair', false, false);
    const c = seed('Book c', 'auth__ser__book', 'm_pair', false, false);
    await sweep.repairDuplicateBookIds();
    const idB = readState(b).manuscriptId;
    const idC = readState(c).manuscriptId;
    expect(idB).not.toBe(idC);
    expect([idB, idC]).toContain('m_pair');
  });

  it("rekeys the loser's own hints, ledger, dropped-quotes and analysis-state files", async () => {
    const { loser, mid } = sharedPair();
    const audiobook = (f: string) => join(loser, '.audiobook', f);
    writeFileSync(paths.manuscriptHintsJsonPath(loser), JSON.stringify({ schema: 1, entries: [{ manuscriptId: mid, other: 1 }, { manuscriptId: 'else' }] }));
    writeFileSync(paths.scriptReviewLedgerJsonPath(loser), JSON.stringify({ nextVersion: 3, entries: { '1': { manuscriptId: mid, version: 2 }, '2': { manuscriptId: 'else', version: 1 } } }));
    writeFileSync(paths.droppedQuotesJsonPath(loser), JSON.stringify({ manuscriptId: mid, batches: [{ n: 1 }] }));
    writeFileSync(paths.analysisStateJsonPath(loser), JSON.stringify({ manuscriptId: mid, state: 'paused' }));
    writeFileSync(paths.analysisLastOutcomeJsonPath(loser), JSON.stringify({ manuscriptId: mid, kind: 'result' }));
    await sweep.repairDuplicateBookIds();
    const fresh = readState(loser).manuscriptId;
    expect(fresh).not.toBe(mid);
    const rd = (p: string) => JSON.parse(readFileSync(p, 'utf8'));
    expect(rd(paths.manuscriptHintsJsonPath(loser)).entries).toEqual([{ manuscriptId: fresh, other: 1 }, { manuscriptId: 'else' }]);
    expect(rd(paths.scriptReviewLedgerJsonPath(loser)).entries['1']).toEqual({ manuscriptId: fresh, version: 2 });
    expect(rd(paths.scriptReviewLedgerJsonPath(loser)).entries['2'].manuscriptId).toBe('else');
    expect(rd(paths.droppedQuotesJsonPath(loser))).toEqual({ manuscriptId: fresh, batches: [{ n: 1 }] });
    expect(rd(paths.analysisStateJsonPath(loser)).manuscriptId).toBe(fresh);
    expect(rd(paths.analysisLastOutcomeJsonPath(loser)).manuscriptId).toBe(fresh);
    expect(existsSync(audiobook('state.json'))).toBe(true);
  });

  it('a side file that cannot be rewritten is logged and does not undo the repair or stop the others', async () => {
    const { loser, mid } = sharedPair();
    writeFileSync(paths.droppedQuotesJsonPath(loser), JSON.stringify({ manuscriptId: mid, batches: [] }));
    writeFileSync(paths.analysisStateJsonPath(loser), JSON.stringify({ manuscriptId: mid, state: 'paused' }));
    failWrite.add(paths.droppedQuotesJsonPath(loser));
    const r = await sweep.repairDuplicateBookIds();
    expect(r).toHaveLength(1);
    const fresh = readState(loser).manuscriptId;
    expect(fresh).not.toBe(mid);
    expect(JSON.parse(readFileSync(paths.droppedQuotesJsonPath(loser), 'utf8')).manuscriptId).toBe(mid);
    expect(JSON.parse(readFileSync(paths.analysisStateJsonPath(loser), 'utf8')).manuscriptId).toBe(fresh);
    expect(warn.mock.calls.some((c: unknown[]) => String(c[0]).includes('could not rekey'))).toBe(true);
  });

  it('a corrupt side file is left byte-for-byte and the repair still lands', async () => {
    const { loser, mid } = sharedPair();
    writeFileSync(paths.scriptReviewLedgerJsonPath(loser), '{not json');
    const r = await sweep.repairDuplicateBookIds();
    expect(r).toHaveLength(1);
    expect(readState(loser).manuscriptId).not.toBe(mid);
    expect(readFileSync(paths.scriptReviewLedgerJsonPath(loser), 'utf8')).toBe('{not json');
  });
});
