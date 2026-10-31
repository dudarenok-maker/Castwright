/* #3965 - the id-drift join gates are book-scoped on every path, driven through
   the real runMainAnalyzerJob / runSubsetAnalyzerJob with a record that CARRIES
   a bookId (the production shape; the store-level tests pass currentBookId by
   hand and so cannot see a route that forgets to thread it).

   The seed copies a locked prior row's cross-book `notLinkedTo` edge onto its
   id-drifted twin. A gate that ignores `bookId` then reads that edge as a
   decline between the two group members, so an interrupted run's two-row prior
   never heals. Same-book edges (cast-reject-orphan writes them) must still
   block at every gate. These tests go red when any of the four `currentBookId`
   arguments at the analysis.ts call sites (remapFreshToPriorIds and
   dedupePriorCastByName, main and subset) is removed. */
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

function phase1(speakerId: string, onCall?: (chapterId: number) => Promise<void>): Analyzer {
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
            characterId: speakerId,
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

function mkBook(characters: CastRow[], name: string): { manuscriptId: string; bookDir: string } {
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
  const chapterHints = [
    { id: 1, title: 'Chapter One', body: BODY(name) },
    { id: 2, title: 'Chapter Two', body: BODY(name) },
    { id: 3, title: 'Chapter Three', body: BODY(name) },
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
  speaker: string;
  subset?: boolean;
  onCall?: (chapterId: number) => Promise<void>;
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
      sel(phase0(roster), 'phase0-model'),
      phase1Sel,
      rec.chapterHints,
      true,
    );
    return;
  }
  (globalThis as Record<string, unknown>).__same_book_gate_phase1 = phase1Sel;
  await runMainAnalyzerJob(job, rec as never, sel(phase0(roster), 'phase0-model'), {
    requestedFresh: false,
    allowStage1Shrink: true,
    requestedModel: undefined,
  } as never);
}

const readCast = (bookDir: string): CastRow[] =>
  JSON.parse(readFileSync(join(bookDir, '.audiobook', 'cast.json'), 'utf8')).characters;
const named = (bookDir: string, name: string): CastRow[] =>
  readCast(bookDir).filter((c) => c.name === name);

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
      expect(
        named(bookDir, 'Old Tom')
          .map((r) => r.id)
          .sort(),
      ).toEqual(['old-tom', 'old-tom-2']);

      await run(manuscriptId, bookDir, tomRoster, { speaker: 'old-tom-2' });
      const rows = named(bookDir, 'Old Tom');
      expect(rows).toHaveLength(1);
      expect(rows[0].voiceId).toBe('v_tom');
      expect(rows[0].lines).toBe(3);
    } finally {
      await cleanup(manuscriptId, bookDir);
    }
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
      const b: CastRow = { id: 'mira-2', name: 'Mira', lines: 3 };
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
      } finally {
        await cleanup(manuscriptId, bookDir);
      }
    },
  );
});
