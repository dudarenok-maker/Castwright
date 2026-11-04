/* #3965 - the id-drift join gates are book-scoped on every path, driven through
   the real runMainAnalyzerJob / runSubsetAnalyzerJob with a record that CARRIES
   a bookId (the production shape; the store-level tests pass currentBookId by
   hand and so cannot see a route that forgets to thread it).

   The seed copies a locked prior row's cross-book `notLinkedTo` edge onto its
   id-drifted twin. A gate that ignores `bookId` then reads that edge as a
   decline between the two group members, so an interrupted run's two-row prior
   never heals. Same-book edges (cast-reject-orphan writes them) must still
   block at every gate. The `currentBookId` arguments at the analysis.ts call
   sites (remapFreshToPriorIds, mergeAnalysisResultWithExistingCast and
   dedupePriorCastByName, main and subset) are each pinned by a case that goes
   red when that one argument alone is removed; the merge call's is pinned by
   the reserved-prior-row case, the one join only the merge makes. */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  runMainAnalyzerJob,
  runSubsetAnalyzerJob,
  type AnalysisJob,
} from './analysis.js';
import type { Analyzer, AnalyzerSelection } from '../analyzer/index.js';
import type { CharacterOutput, Stage1ChapterOutput } from '../handoff/schemas.js';
import { clearAnalysisCache, saveAnalysisCache } from '../store/analysis-cache.js';
import { putManuscript, removeManuscript, getManuscript } from '../store/manuscripts.js';

const { detectOllamaDeviceMock, setLastKnownAnalyzerDeviceMock } = vi.hoisted(() => ({
  detectOllamaDeviceMock: vi.fn(async (): Promise<'cuda' | 'cpu' | 'unknown'> => 'cuda'),
  setLastKnownAnalyzerDeviceMock: vi.fn(),
}));
vi.mock('./ollama-health.js', () => ({
  detectOllamaDevice: detectOllamaDeviceMock,
  unloadResidentOllama: vi.fn(async () => {}),
}));
vi.mock('../gpu/analyzer-device-state.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../gpu/analyzer-device-state.js')>()),
  setLastKnownAnalyzerDevice: setLastKnownAnalyzerDeviceMock,
}));

vi.mock('../analyzer/select-analyzer.js', async () => {
  const actual = await vi.importActual<typeof import('../analyzer/select-analyzer.js')>(
    '../analyzer/select-analyzer.js',
  );
  return {
    ...actual,
    selectAnalyzerForPhase: (opts: { phase: 'phase0' | 'phase1' }) => {
      const g = globalThis as Record<string, unknown>;
      if (opts.phase === 'phase1' && g.__same_book_gate_phase1) return g.__same_book_gate_phase1;
      return actual.selectAnalyzerForPhase(
        opts as Parameters<typeof actual.selectAnalyzerForPhase>[0],
      );
    },
    isPerPhaseModelSelectionActive: () => false,
  };
});

const BOOK = 'author__series__book-two';
const BODY = (who: string): string =>
  `“Are you sure this will work,” ${who} asked.\n\nOlga nodded and looked away.`;

function phase0(rosterRows: CharacterOutput[]): Analyzer {
  return {
    runStage1: () => Promise.reject(new Error('not used')),
    async runStage1Chapter(): Promise<Stage1ChapterOutput> {
      return { characters: rosterRows };
    },
    runStage2Chapter: () => Promise.reject(new Error('phase0')),
    runEmotionChapter: () => Promise.reject(new Error('not used')),
    runScriptReviewChapter: () => Promise.reject(new Error('not used')),
    runStage3Chapter: () => Promise.reject(new Error('not used')),
    runAttributionEscalation: () => Promise.reject(new Error('not used')),
  };
}

function phase1(
  speaker: string | ((chapterId: number) => string),
  onCall?: (chapterId: number) => Promise<void>,
): Analyzer {
  return {
    runStage1: () => Promise.reject(new Error('not used')),
    runStage1Chapter: () => Promise.reject(new Error('phase1')),
    runStage2Chapter: (async (_m: string, chapterId: number) => {
      if (onCall) await onCall(chapterId);
      return {
        sentences: [
          {
            id: chapterId * 100 + 1,
            chapterId,
            characterId: typeof speaker === 'string' ? speaker : speaker(chapterId),
            confidence: 0.9,
            text: 'Are you sure this will work',
          },
        ],
      };
    }) as unknown as Analyzer['runStage2Chapter'],
    runEmotionChapter: () => Promise.reject(new Error('not used')),
    runScriptReviewChapter: () => Promise.reject(new Error('not used')),
    runStage3Chapter: () => Promise.reject(new Error('not used')),
    runAttributionEscalation: () => Promise.reject(new Error('no escalation')),
  };
}

const sel = (analyzer: Analyzer, model: string): AnalyzerSelection => ({
  analyzer,
  engine: 'gemini',
  model,
  fallbackModel: null,
  fallbackEngine: null,
});

type CastRow = Record<string, unknown>;

function mkBook(
  characters: CastRow[],
  name: string | string[],
  history?: unknown,
): { manuscriptId: string; bookDir: string } {
  const manuscriptId = `t3965-${Date.now()}-${Math.random()}`;
  const bookDir = mkdtempSync(join(tmpdir(), 'audiobook-3965-'));
  mkdirSync(join(bookDir, '.audiobook'), { recursive: true });
  writeFileSync(
    join(bookDir, '.audiobook', 'state.json'),
    JSON.stringify({
      bookId: BOOK,
      manuscriptId,
      title: 'Book Two',
      author: 'Author',
      language: 'en',
      series: 'Series',
      seriesPosition: 2,
      isStandalone: false,
      manuscriptFile: 'manuscript.md',
      castConfirmed: true,
      chapters: [
        { id: 1, title: 'Chapter One', slug: '01-chapter-one' },
        { id: 2, title: 'Chapter Two', slug: '02-chapter-two' },
        { id: 3, title: 'Chapter Three', slug: '03-chapter-three' },
      ],
      coverGradient: ['#000', '#fff'],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }),
  );
  writeFileSync(join(bookDir, '.audiobook', 'cast.json'), JSON.stringify({ characters }));
  if (history) {
    writeFileSync(join(bookDir, '.audiobook', 'cast-id-history.json'), JSON.stringify(history));
  }
  const chapterHints = [
    { id: 1, title: 'Chapter One', body: BODY([name].flat()[0]) },
    { id: 2, title: 'Chapter Two', body: BODY([name].flat()[1] ?? [name].flat()[0]) },
    { id: 3, title: 'Chapter Three', body: BODY([name].flat()[2] ?? [name].flat()[0]) },
  ];
  putManuscript({
    manuscriptId,
    format: 'plaintext',
    title: 'Book Two',
    wordCount: 100,
    byteSize: 1000,
    uploadedAt: new Date().toISOString(),
    sourceText: chapterHints.map((c) => c.body).join('\n\n'),
    chapterHints,
    bookId: BOOK,
    bookDir,
  });
  return { manuscriptId, bookDir };
}

function mkJob(manuscriptId: string, bookDir: string, kind: 'main' | 'subset'): AnalysisJob {
  return {
    controller: new AbortController(),
    subscribers: new Set(),
    manuscriptId,
    kind,
    bookDir,
    engine: 'gemini',
    replay: {
      logs: [],
      lastPhase: null,
      lastEta: null,
      lastCastUpdate: null,
      failedByChapterId: new Map(),
      lastSeriesPrior: null,
      warnings: new Map(),
    },
    lastDiskWriteAt: 0,
  } as unknown as AnalysisJob;
}

interface RunOpts {
  speaker: string | ((chapterId: number) => string);
  subset?: boolean;
  onCall?: (chapterId: number) => Promise<void>;
  /** Replaces the fixed-roster Phase 0 analyzer (a per-chapter roster, or one that dies). */
  phase0Analyzer?: Analyzer;
}

async function run(
  manuscriptId: string,
  bookDir: string,
  roster: CharacterOutput[],
  opts: RunOpts,
): Promise<void> {
  const job = mkJob(manuscriptId, bookDir, opts.subset ? 'subset' : 'main');
  const rec = getManuscript(manuscriptId);
  if (!rec) throw new Error('manuscript missing');
  const phase1Sel = sel(phase1(opts.speaker, opts.onCall), 'phase1-model');
  if (opts.onCall) (opts.onCall as { job?: AnalysisJob }).job = job;
  if (opts.subset) {
    /* Pre-seed cache.stage1 so the subset route takes the book-already-analysed
       branch (stage1Existed), the only one that reaches the subset persist. */
    await saveAnalysisCache(manuscriptId, {
      chapters: {},
      stage1: {
        characters: roster,
        chapters: rec.chapterHints.map((c) => ({ id: c.id, title: c.title })),
      },
    } as never);
    await runSubsetAnalyzerJob(
      job,
      rec as never,
      sel(opts.phase0Analyzer ?? phase0(roster), 'phase0-model'),
      phase1Sel,
      rec.chapterHints,
      true,
    );
    return;
  }
  (globalThis as Record<string, unknown>).__same_book_gate_phase1 = phase1Sel;
  await runMainAnalyzerJob(job, rec as never, sel(opts.phase0Analyzer ?? phase0(roster), 'phase0-model'), {
    requestedFresh: false,
    allowStage1Shrink: true,
    requestedModel: undefined,
  } as never);
}

const readCast = (bookDir: string): CastRow[] =>
  JSON.parse(readFileSync(join(bookDir, '.audiobook', 'cast.json'), 'utf8')).characters;
const named = (bookDir: string, name: string): CastRow[] =>
  readCast(bookDir).filter((c) => c.name === name);
const readRejectedPairs = (bookDir: string): Array<{ from: string; to: string }> =>
  JSON.parse(readFileSync(join(bookDir, '.audiobook', 'cast-id-history.json'), 'utf8'))
    .rejectedPairs;

const NARR: CharacterOutput = {
  id: 'narrator',
  name: 'Narrator',
  role: 'narrator',
  color: 'narrator',
} as CharacterOutput;
const rosterRow = (id: string, name: string): CharacterOutput =>
  ({
    id,
    name,
    role: 'lead',
    color: '#111111',
    gender: 'male',
    evidence: [{ quote: `${name} asked` }],
  }) as CharacterOutput;
const LOCKED_TOM: CastRow = {
  id: 'old-tom',
  name: 'Old Tom',
  voiceId: 'v_tom',
  voiceState: 'locked',
  notLinkedTo: [{ bookId: 'book-1', characterId: 'old-tom' }],
};

const abortAtFirstPhase1 = (): ((chapterId: number) => Promise<void>) => {
  const onCall = async (): Promise<void> => {
    (onCall as unknown as { job: AnalysisJob }).job.controller.abort();
    const e = new Error('aborted');
    e.name = 'AbortError';
    throw e;
  };
  return onCall;
};

describe('#3965 same-book join gates, through the real analysis jobs', () => {
  const orig = process.env.STAGE2_COVERAGE_RETRIES;
  beforeEach(() => {
    process.env.STAGE2_COVERAGE_RETRIES = '0';
  });
  afterEach(() => {
    delete (globalThis as Record<string, unknown>).__same_book_gate_phase1;
    if (orig === undefined) delete process.env.STAGE2_COVERAGE_RETRIES;
    else process.env.STAGE2_COVERAGE_RETRIES = orig;
  });
  const cleanup = async (manuscriptId: string, bookDir: string): Promise<void> => {
    removeManuscript(manuscriptId);
    await clearAnalysisCache(manuscriptId);
    rmSync(bookDir, { recursive: true, force: true });
  };
  const tomRoster = [NARR, rosterRow('old-tom-2', 'Old Tom')];

  it('uninterrupted run: an id-drifted locked row stays one row', async () => {
    const { manuscriptId, bookDir } = mkBook([{ ...NARR }, { ...LOCKED_TOM }], 'Old Tom');
    try {
      await run(manuscriptId, bookDir, tomRoster, { speaker: 'old-tom-2' });
      const rows = named(bookDir, 'Old Tom');
      expect(rows).toHaveLength(1);
      expect(rows[0].voiceId).toBe('v_tom');
      expect(rows[0].voiceState).toBe('locked');
      expect(rows[0].lines).toBe(3);
    } finally {
      await cleanup(manuscriptId, bookDir);
    }
  });

  it('a same-book reject edge still blocks the join', async () => {
    const live: CastRow = {
      id: 'alden',
      name: 'Alden',
      voiceId: 'v_alden',
      voiceState: 'locked',
      notLinkedTo: [{ bookId: BOOK, characterId: 'alden-x' }],
    };
    const { manuscriptId, bookDir } = mkBook([{ ...NARR }, live], 'Alden');
    try {
      await run(manuscriptId, bookDir, [NARR, rosterRow('alden-x', 'Alden')], {
        speaker: 'alden-x',
      });
      const rows = named(bookDir, 'Alden');
      expect(rows.map((r) => r.id).sort()).toEqual(['alden', 'alden-x']);
      expect(rows.find((r) => r.id === 'alden-x')?.lines).toBe(3);
      expect(rows.find((r) => r.id === 'alden-x')?.voiceId).toBeUndefined();
    } finally {
      await cleanup(manuscriptId, bookDir);
    }
  });

  it('an interrupted run then a resumed one does not split the locked row', async () => {
    const { manuscriptId, bookDir } = mkBook([{ ...NARR }, { ...LOCKED_TOM }], 'Old Tom');
    try {
      await run(manuscriptId, bookDir, tomRoster, {
        speaker: 'old-tom-2',
        onCall: abortAtFirstPhase1(),
      }).catch(() => {});
      // The snapshot runs the same name-join remap as the final write (#3954),
      // so an exact-name id drift no longer leaves the split on disk either.
      expect(named(bookDir, 'Old Tom').map((r) => r.id)).toEqual(['old-tom']);

      await run(manuscriptId, bookDir, tomRoster, { speaker: 'old-tom-2' });
      const rows = named(bookDir, 'Old Tom');
      expect(rows).toHaveLength(1);
      expect(rows[0].voiceId).toBe('v_tom');
      expect(rows[0].lines).toBe(3);
    } finally {
      await cleanup(manuscriptId, bookDir);
    }
  });

  /* #3954 review finding 1 — the kept PRIOR id must survive an interrupted
     run. A surname drift ("Wren" -> "Wren Ashby") is a name join the remap
     settles by keeping `w2`; the interim snapshot used to persist the fresh
     `wren-ashby` instead, and the resume's held-by-another-prior-row guard then
     refused the join for good. */
  describe('a surname drift keeps the locked row across an interrupted run', () => {
    const LOCKED_WREN: CastRow = {
      id: 'w2',
      name: 'Wren',
      voiceUuid: 'U-wren',
      voiceState: 'locked',
    };
    const wrenRoster = [NARR, rosterRow('wren-ashby', 'Wren Ashby')];
    const wrenRows = (bookDir: string): CastRow[] =>
      readCast(bookDir).filter((c) => c.id !== 'narrator');

    it('control: an uninterrupted run ends with the one locked row', async () => {
      const { manuscriptId, bookDir } = mkBook([{ ...NARR }, { ...LOCKED_WREN }], 'Wren Ashby');
      try {
        await run(manuscriptId, bookDir, wrenRoster, { speaker: 'wren-ashby' });
        const rows = wrenRows(bookDir);
        expect(rows.map((r) => r.id)).toEqual(['w2']);
        expect(rows[0].voiceUuid).toBe('U-wren');
        expect(rows[0].voiceState).toBe('locked');
        expect(rows[0].lines).toBe(3);
      } finally {
        await cleanup(manuscriptId, bookDir);
      }
    });

    it.each(['main', 'subset'] as const)(
      'an interrupted run then a resumed one ends with the same one row (%s job)',
      async (kind) => {
        const { manuscriptId, bookDir } = mkBook([{ ...NARR }, { ...LOCKED_WREN }], 'Wren Ashby');
        try {
          await run(manuscriptId, bookDir, wrenRoster, {
            speaker: 'wren-ashby',
            subset: kind === 'subset',
            onCall: abortAtFirstPhase1(),
          }).catch(() => {});
          // The snapshot never persisted the drifted fresh id.
          expect(wrenRows(bookDir).map((r) => r.id)).toEqual(['w2']);

          await run(manuscriptId, bookDir, wrenRoster, {
            speaker: 'wren-ashby',
            subset: kind === 'subset',
          });
          const rows = wrenRows(bookDir);
          expect(rows.map((r) => r.id)).toEqual(['w2']);
          expect(rows[0].voiceUuid).toBe('U-wren');
          expect(rows[0].voiceState).toBe('locked');
          if (kind === 'main') expect(rows[0].lines).toBe(3);
        } finally {
          await cleanup(manuscriptId, bookDir);
        }
      },
    );
  });

  /* #3954 review finding N3 — the snapshot decides on a PARTIAL roster, so it
     must not persist a decision the full roster could reverse. Chapter 1 names
     "Wren Ashby", chapters 2-3 "Wren Cole": both are surname-tolerant matches of
     the locked "Wren", so the full roster's claim-once refuses BOTH and `w2`
     keeps its name and voice. Chapter 1 alone looks like a lone match; if the
     snapshot renamed `w2` to "Wren Ashby", the resume would match that name
     exactly and hand Wren Ashby the locked voice. */
  describe('a partial-roster snapshot leaves the locked row as the full roster would', () => {
    const LOCKED_WREN: CastRow = {
      id: 'w2',
      name: 'Wren',
      voiceUuid: 'U-wren',
      voiceState: 'locked',
    };
    const ashby = rosterRow('wren-ashby', 'Wren Ashby');
    const cole = rosterRow('wren-cole', 'Wren Cole');
    const byChapter = (dieFrom?: number): Analyzer => ({
      ...phase0([]),
      async runStage1Chapter(_m: string, chapterId: number): Promise<Stage1ChapterOutput> {
        if (dieFrom !== undefined && chapterId >= dieFrom) throw new Error('simulated death');
        return { characters: [NARR, chapterId === 1 ? ashby : cole] };
      },
    });
    const WREN_BODIES = ['Wren Ashby', 'Wren Cole', 'Wren Cole'];
    const wrenSpeaker = (chapterId: number): string => (chapterId === 1 ? 'wren-ashby' : 'wren-cole');
    const summary = (bookDir: string): unknown =>
      readCast(bookDir)
        .map((r) => ({
          id: r.id,
          name: r.name,
          voiceUuid: r.voiceUuid ?? null,
          voiceState: r.voiceState ?? null,
        }))
        .sort((a, b) => String(a.id).localeCompare(String(b.id)));
    const origConcurrency = process.env.ANALYZER_OLLAMA_CONCURRENCY;
    beforeEach(() => {
      // Sequential chapters: chapter 1's snapshot lands before chapter 2 dies.
      process.env.ANALYZER_OLLAMA_CONCURRENCY = '1';
    });
    afterEach(() => {
      if (origConcurrency === undefined) delete process.env.ANALYZER_OLLAMA_CONCURRENCY;
      else process.env.ANALYZER_OLLAMA_CONCURRENCY = origConcurrency;
    });

    it.each(['main', 'subset'] as const)('an interrupted run then a resumed one ends as the uninterrupted run does (%s job)', async (kind) => {
      const control = mkBook([{ ...NARR }, { ...LOCKED_WREN }], WREN_BODIES);
      let controlEnd: unknown;
      try {
        await run(control.manuscriptId, control.bookDir, [NARR, ashby, cole], {
          subset: kind === 'subset',
          speaker: wrenSpeaker,
          phase0Analyzer: byChapter(),
        });
        controlEnd = summary(control.bookDir);
        // The control itself: the locked row keeps its name and voice.
        expect(controlEnd).toContainEqual({
          id: 'w2',
          name: 'Wren',
          voiceUuid: 'U-wren',
          voiceState: 'locked',
        });
      } finally {
        await cleanup(control.manuscriptId, control.bookDir);
      }

      const { manuscriptId, bookDir } = mkBook([{ ...NARR }, { ...LOCKED_WREN }], WREN_BODIES);
      try {
        await run(manuscriptId, bookDir, [NARR, ashby, cole], {
          subset: kind === 'subset',
          speaker: wrenSpeaker,
          phase0Analyzer: byChapter(2),
        }).catch(() => {});
        // Chapter 1's snapshot landed (the run died mid-Phase 0), and it did not
        // rename the locked row after a roster that is only a third of the book.
        expect(readCast(bookDir).find((r) => r.id === 'w2')?.name).toBe('Wren');

        await run(manuscriptId, bookDir, [NARR, ashby, cole], {
          subset: kind === 'subset',
          speaker: wrenSpeaker,
          phase0Analyzer: byChapter(),
        });
        expect(summary(bookDir)).toEqual(controlEnd);
      } finally {
        await cleanup(manuscriptId, bookDir);
      }
    });
  });

  it('a book already split by the bug heals on re-analysis (main job)', async () => {
    const twin: CastRow = {
      id: 'old-tom-2',
      name: 'Old Tom',
      lines: 3,
      notLinkedTo: [{ bookId: 'book-1', characterId: 'old-tom' }],
    };
    const { manuscriptId, bookDir } = mkBook(
      [{ ...NARR }, { ...LOCKED_TOM, lines: 0 }, twin],
      'Old Tom',
    );
    try {
      await run(manuscriptId, bookDir, tomRoster, { speaker: 'old-tom-2' });
      const rows = named(bookDir, 'Old Tom');
      expect(rows).toHaveLength(1);
      expect(rows[0].voiceId).toBe('v_tom');
      expect(rows[0].lines).toBe(3);
    } finally {
      await cleanup(manuscriptId, bookDir);
    }
  });

  it('a book already split by the bug heals on re-analysis (subset job)', async () => {
    const twin: CastRow = {
      id: 'old-tom-2',
      name: 'Old Tom',
      lines: 3,
      notLinkedTo: [{ bookId: 'book-1', characterId: 'old-tom' }],
    };
    const { manuscriptId, bookDir } = mkBook(
      [{ ...NARR }, { ...LOCKED_TOM, lines: 0 }, twin],
      'Old Tom',
    );
    try {
      await run(manuscriptId, bookDir, tomRoster, { speaker: 'old-tom-2', subset: true });
      const rows = named(bookDir, 'Old Tom');
      expect(rows).toHaveLength(1);
      expect(rows[0].voiceId).toBe('v_tom');
    } finally {
      await cleanup(manuscriptId, bookDir);
    }
  });

  it.each(['main', 'subset'] as const)(
    'a cross-book edge naming the fresh id does not stop the remap or the merge (%s job)',
    async (kind) => {
      /* The prior row's edge is another BOOK's decision about an unrelated
         character that happens to share the drifted id: it says nothing about
         this book's fresh row, so the locked voice must carry over. */
      const prior: CastRow = {
        ...LOCKED_TOM,
        notLinkedTo: [{ bookId: 'book-1', characterId: 'old-tom-2' }],
      };
      const { manuscriptId, bookDir } = mkBook([{ ...NARR }, prior], 'Old Tom');
      try {
        await run(manuscriptId, bookDir, tomRoster, {
          speaker: 'old-tom-2',
          subset: kind === 'subset',
        });
        const rows = named(bookDir, 'Old Tom');
        expect(rows).toHaveLength(1);
        expect(rows[0].voiceId).toBe('v_tom');
        expect(rows[0].voiceState).toBe('locked');
      } finally {
        await cleanup(manuscriptId, bookDir);
      }
    },
  );

  it.each(['main', 'subset'] as const)(
    'a same-book edge between two same-name prior rows still blocks the dedupe (%s job)',
    async (kind) => {
      const a: CastRow = {
        id: 'mira',
        name: 'Mira',
        voiceId: 'v_mira',
        voiceState: 'locked',
        notLinkedTo: [{ bookId: BOOK, characterId: 'mira-2' }],
      };
      const b: CastRow = { id: 'mira-2', name: 'Mira', voiceId: 'v_mira2', lines: 3 };
      const { manuscriptId, bookDir } = mkBook([{ ...NARR }, a, b], 'Mira');
      try {
        await run(manuscriptId, bookDir, [NARR, rosterRow('mira-2', 'Mira')], {
          speaker: 'mira-2',
          subset: kind === 'subset',
        });
        expect(
          named(bookDir, 'Mira')
            .map((r) => r.id)
            .sort(),
        ).toEqual(['mira', 'mira-2']);
        expect(named(bookDir, 'Mira').find((r) => r.id === 'mira-2')?.voiceId).toBe('v_mira2');
      } finally {
        await cleanup(manuscriptId, bookDir);
      }
    },
  );

  it.each(['main', 'subset'] as const)(
    'a decline held only by the row that loses the dedupe survives (%s job)',
    async (kind) => {
      const winnerless: CastRow = {
        id: 'thomas',
        name: 'Old Tom',
        voiceId: 'v_a',
        voiceUuid: 'U1',
        lines: 0,
      };
      const loser: CastRow = {
        id: 'old-tom',
        name: 'Old Tom',
        lines: 3,
        notLinkedTo: [{ bookId: 'book-1', characterId: 'old-tom' }],
      };
      const { manuscriptId, bookDir } = mkBook([{ ...NARR }, winnerless, loser], 'Old Tom');
      try {
        await run(manuscriptId, bookDir, [NARR, rosterRow('old-tom', 'Old Tom')], {
          speaker: 'old-tom',
          subset: kind === 'subset',
        });
        const edges = named(bookDir, 'Old Tom').flatMap(
          (r) => (r.notLinkedTo as Array<{ bookId: string; characterId: string }>) ?? [],
        );
        expect(edges).toEqual([{ bookId: 'book-1', characterId: 'old-tom' }]);
      } finally {
        await cleanup(manuscriptId, bookDir);
      }
    },
  );

  it.each(['main', 'subset'] as const)(
    "a row that declines another row's link keeps the rows apart, so the decline survives (%s job)",
    async (kind) => {
      /* `thomas` already holds the series link to book-1/old-tom; `old-tom`
         declined exactly that. Fusing them put the declined link on the
         survivor, and the linker then landed it. */
      const thomas: CastRow = {
        id: 'thomas',
        name: 'Old Tom',
        voiceId: 'v_b1_tom',
        voiceUuid: 'U-b1',
        voiceState: 'reused',
        lines: 0,
        matchedFrom: {
          bookId: 'book-1',
          characterId: 'old-tom',
          bookTitle: 'Book One',
          confidence: 0.9,
        },
      };
      const oldTom: CastRow = {
        id: 'old-tom',
        name: 'Old Tom',
        lines: 3,
        notLinkedTo: [{ bookId: 'book-1', characterId: 'old-tom' }],
      };
      const { manuscriptId, bookDir } = mkBook([{ ...NARR }, thomas, oldTom], 'Old Tom');
      try {
        await run(manuscriptId, bookDir, [NARR, rosterRow('old-tom', 'Old Tom')], {
          speaker: 'old-tom',
          subset: kind === 'subset',
        });
        const rows = named(bookDir, 'Old Tom');
        expect(rows.map((r) => r.id).sort()).toEqual(['old-tom', 'thomas']);
        const declined = rows.find((r) => r.id === 'old-tom');
        expect(declined?.notLinkedTo).toEqual([{ bookId: 'book-1', characterId: 'old-tom' }]);
        expect(declined?.matchedFrom).toBeUndefined();
      } finally {
        await cleanup(manuscriptId, bookDir);
      }
    },
  );

  it.each(['main', 'subset'] as const)(
    "a row's own same-book reject edge still blocks the collapse, keeping the rejected pair (%s job)",
    async (kind) => {
      /* The user merged the reject target `tom` into a same-name `x`, which
         repointed the rejected pair to (thomas, x). `thomas` keeps the seeded
         same-book self-edge. Fusing the two would delete that rejection. */
      const x: CastRow = { id: 'x', name: 'Old Tom', voiceId: 'v_x', lines: 0 };
      const thomas: CastRow = {
        id: 'thomas',
        name: 'Old Tom',
        voiceId: 'v_th',
        voiceState: 'locked',
        lines: 3,
        notLinkedTo: [{ bookId: BOOK, characterId: 'thomas' }],
      };
      const history = {
        schema: 1,
        supersededBy: { tom: 'x' },
        rejectedPairs: [{ from: 'thomas', to: 'x' }],
      };
      const { manuscriptId, bookDir } = mkBook([{ ...NARR }, x, thomas], 'Old Tom', history);
      try {
        await run(manuscriptId, bookDir, [NARR, rosterRow('thomas', 'Old Tom')], {
          speaker: 'thomas',
          subset: kind === 'subset',
        });
        expect(
          named(bookDir, 'Old Tom')
            .map((r) => r.id)
            .sort(),
        ).toEqual(['thomas', 'x']);
        expect(readRejectedPairs(bookDir)).toEqual([{ from: 'thomas', to: 'x' }]);
      } finally {
        await cleanup(manuscriptId, bookDir);
      }
    },
  );

  it.each(['main', 'subset'] as const)(
    'the remap keeps the PRIOR id of an id-drifted locked row (%s job)',
    async (kind) => {
      /* Without the remap's own book scope the merge name-fallback still
         rescues the voice, but the row takes the FRESH id. */
      const { manuscriptId, bookDir } = mkBook([{ ...NARR }, { ...LOCKED_TOM }], 'Old Tom');
      try {
        await run(manuscriptId, bookDir, tomRoster, {
          speaker: 'old-tom-2',
          subset: kind === 'subset',
        });
        const rows = named(bookDir, 'Old Tom');
        expect(rows).toHaveLength(1);
        expect(rows[0].id).toBe('old-tom');
      } finally {
        await cleanup(manuscriptId, bookDir);
      }
    },
  );

  it.each(['main', 'subset'] as const)(
    'a reserved prior row still joins its fresh name past a cross-book edge (%s job)',
    async (kind) => {
      /* The remap refuses a reserved prior id, so this join is made by the
         merge's own name-fallback gate alone: it joins only when that gate reads
         the cross-book edge as book-scoped (currentBookId threaded). */
      const prior: CastRow = {
        id: 'unknown-male',
        name: 'Timkin',
        voiceId: 'v_tim',
        voiceState: 'locked',
        notLinkedTo: [{ bookId: 'book-1', characterId: 'timkin' }],
      };
      const { manuscriptId, bookDir } = mkBook([{ ...NARR }, prior], 'Timkin');
      try {
        await run(manuscriptId, bookDir, [NARR, rosterRow('timkin', 'Timkin')], {
          speaker: 'timkin',
          subset: kind === 'subset',
        });
        const rows = named(bookDir, 'Timkin');
        expect(rows).toHaveLength(1);
        expect(rows[0].voiceId).toBe('v_tim');
      } finally {
        await cleanup(manuscriptId, bookDir);
      }
    },
  );

  it.each(['main', 'subset'] as const)(
    'an id-drifted speaker neither takes the link its same-name twin declined nor loses the decline (%s job)',
    async (kind) => {
      /* The two same-name prior rows stay apart (one declines the link the other
         carries), so the drifted speaker `old-tom-2` has no by-id prior and
         reaches the name fallback with an ambiguous name: the seed must still
         hand it the decline, and the merge must refuse the linked twin. */
      const linked: CastRow = {
        id: 'thomas',
        name: 'Old Tom',
        voiceId: 'v_b1_tom',
        voiceUuid: 'U-b1',
        voiceState: 'reused',
        lines: 0,
        matchedFrom: {
          bookId: 'book-1',
          characterId: 'old-tom',
          bookTitle: 'Book One',
          confidence: 0.9,
        },
      };
      const declining: CastRow = {
        id: 'old-tom',
        name: 'Old Tom',
        lines: 3,
        notLinkedTo: [{ bookId: 'book-1', characterId: 'old-tom' }],
      };
      const { manuscriptId, bookDir } = mkBook([{ ...NARR }, linked, declining], 'Old Tom');
      try {
        await run(manuscriptId, bookDir, tomRoster, {
          speaker: 'old-tom-2',
          subset: kind === 'subset',
        });
        const rows = named(bookDir, 'Old Tom');
        const speaker = rows.find((r) => r.lines === 3);
        expect(speaker?.matchedFrom).toBeUndefined();
        expect(speaker?.voiceUuid).toBeUndefined();
        expect(speaker?.notLinkedTo).toEqual([{ bookId: 'book-1', characterId: 'old-tom' }]);
        expect(rows.find((r) => r.id === 'thomas')?.matchedFrom).toBeDefined();
      } finally {
        await cleanup(manuscriptId, bookDir);
      }
    },
  );

  it.each(['main', 'subset'] as const)(
    'a surname-drifted speaker neither takes the link its same-name twin declined nor loses the decline (%s job, #3954)',
    async (kind) => {
      /* Same twins, but the analyzer returns the speaker under a SURNAME-drifted
         name. The remap refuses the pair (6b94de46); mergeCore's tolerant
         fallback must refuse too, and the seed's decline union must reach the
         speaker, or the declined link lands on it and the decliner is retired. */
      const linked: CastRow = {
        id: 'thomas',
        name: 'Old Tom',
        voiceId: 'v_b1_tom',
        voiceUuid: 'U-b1',
        voiceState: 'reused',
        lines: 0,
        matchedFrom: {
          bookId: 'book-1',
          characterId: 'old-tom',
          bookTitle: 'Book One',
          confidence: 0.9,
        },
      };
      const declining: CastRow = {
        id: 'old-tom',
        name: 'Old Tom',
        lines: 3,
        notLinkedTo: [{ bookId: 'book-1', characterId: 'old-tom' }],
      };
      const { manuscriptId, bookDir } = mkBook([{ ...NARR }, linked, declining], 'Old Tom Weir');
      try {
        await run(manuscriptId, bookDir, [NARR, rosterRow('old-tom-weir', 'Old Tom Weir')], {
          speaker: 'old-tom-weir',
          subset: kind === 'subset',
        });
        const rows = readCast(bookDir);
        const speaker = rows.find((r) => r.id === 'old-tom-weir');
        expect(speaker).toBeDefined();
        expect(speaker?.matchedFrom).toBeUndefined();
        expect(speaker?.voiceUuid).toBeUndefined();
        expect(speaker?.notLinkedTo).toEqual([{ bookId: 'book-1', characterId: 'old-tom' }]);
        expect(rows.find((r) => r.id === 'thomas')?.matchedFrom).toBeDefined();
      } finally {
        await cleanup(manuscriptId, bookDir);
      }
    },
  );

  /* Main job only (#3954 N5). The subset job cannot reach this seed shape: its
     seed runs on the roster AFTER the fold, where "Tom" (no lines of its own,
     and too few to survive as a minor) is gone, so the strict bridge never skips
     the declining twin and the subset case passed with the seed's guard removed.
     A subset roster that keeps "Tom" needs more than the three one-line chapters
     this harness gives it. */
  it(
    'a Phase-0b roster that reuses the decliner id under another name does not write a link with its own decline (main job, #3954)',
    async () => {
      /* Roster [old-tom "Tom", old-tom-2 "Old Tom"]: the strict bridge skips the
         declining twin (a fresh row holds its id), leaving the linked twin as
         the only candidate, so the seed copied matchedFrom next to a
         notLinkedTo naming the same link. */
      const linked: CastRow = {
        id: 'thomas',
        name: 'Old Tom',
        voiceId: 'v_b1_tom',
        voiceUuid: 'U-b1',
        voiceState: 'reused',
        lines: 0,
        matchedFrom: {
          bookId: 'book-1',
          characterId: 'old-tom',
          bookTitle: 'Book One',
          confidence: 0.9,
        },
      };
      const declining: CastRow = {
        id: 'old-tom',
        name: 'Old Tom',
        lines: 3,
        notLinkedTo: [{ bookId: 'book-1', characterId: 'old-tom' }],
      };
      const { manuscriptId, bookDir } = mkBook([{ ...NARR }, linked, declining], 'Old Tom');
      try {
        await run(
          manuscriptId,
          bookDir,
          [NARR, rosterRow('old-tom', 'Tom'), rosterRow('old-tom-2', 'Old Tom')],
          { speaker: 'old-tom-2' },
        );
        const rows = readCast(bookDir);
        const speaker = rows.find((r) => r.id === 'old-tom-2');
        expect(speaker).toBeDefined();
        expect(speaker?.matchedFrom).toBeUndefined();
        expect(speaker?.voiceUuid).toBeUndefined();
        expect(speaker?.notLinkedTo).toEqual([{ bookId: 'book-1', characterId: 'old-tom' }]);
        expect(rows.find((r) => r.id === 'thomas')?.matchedFrom).toBeDefined();
      } finally {
        await cleanup(manuscriptId, bookDir);
      }
    },
  );

  it.each(['main', 'subset'] as const)(
    'a voiced narrator renamed to a character name does not stop the locked row keeping its id (%s job, #3954)',
    async (kind) => {
      /* The roster carries NO narrator row, so the prior narrator is not taken
         over by id and would reach the remap's candidate set. It must not make
         the name ambiguous: the locked row `w2` keeps its id. */
      const narrator: CastRow = { id: 'narrator', name: 'Wren', voiceId: 'v_narr', lines: 0 };
      const locked: CastRow = {
        id: 'w2',
        name: 'Wren',
        voiceId: 'v_w2',
        voiceState: 'locked',
        lines: 3,
      };
      const { manuscriptId, bookDir } = mkBook([narrator, locked], 'Wren');
      try {
        await run(manuscriptId, bookDir, [rosterRow('wren-new', 'Wren')], {
          speaker: 'wren-new',
          subset: kind === 'subset',
        });
        const rows = readCast(bookDir).filter((c) => c.id !== 'narrator');
        expect(rows.map((r) => r.id)).toEqual(['w2']);
        expect(rows[0].voiceId).toBe('v_w2');
      } finally {
        await cleanup(manuscriptId, bookDir);
      }
    },
  );
});
