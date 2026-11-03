/* #3954 child 3 - the prior cast id survives a surname-tolerant name join on
   EVERY surface, driven through the real runMainAnalyzerJob /
   runSubsetAnalyzerJob. The store-level tests cannot see a route that writes
   one id to cast.json and another to manuscript-edits.json or the result
   roster, so each surface is read back and must agree on the prior id.

   Prior cast: { id: 'w2', name: 'Wren', voiceState: 'locked' }. The analyzer
   returns { id: 'wren-ashby', name: 'Wren Ashby' } and attributes a sentence
   to it. Harness copied from analysis.same-book-gate.test.ts (#3965). */
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
import { buildCastResolver } from '../store/cast-resolve.js';

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
      if (opts.phase === 'phase1' && g.__keep_prior_id_phase1) return g.__keep_prior_id_phase1;
      return actual.selectAnalyzerForPhase(
        opts as Parameters<typeof actual.selectAnalyzerForPhase>[0],
      );
    },
    isPerPhaseModelSelectionActive: () => false,
  };
});

const BOOK = 'author__series__book-two';
const BODY = '“Are you sure this will work,” Wren asked.\n\nOlga nodded and looked away.';
const FRESH_ID = 'wren-ashby';
const PRIOR_ID = 'w2';

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

function phase1(speakerId: string): Analyzer {
  return {
    runStage1: () => Promise.reject(new Error('not used')),
    runStage1Chapter: () => Promise.reject(new Error('phase1')),
    runStage2Chapter: (async (_m: string, chapterId: number) => ({
      sentences: [
        {
          id: chapterId * 100 + 1,
          chapterId,
          characterId: speakerId,
          confidence: 0.9,
          text: 'Are you sure this will work',
        },
      ],
    })) as unknown as Analyzer['runStage2Chapter'],
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

type Row = Record<string, unknown>;

function mkBook(
  characters: Row[],
  supersededBy?: Record<string, string>,
  body: string = BODY,
): { manuscriptId: string; bookDir: string } {
  const manuscriptId = `t3954-${Date.now()}-${Math.random()}`;
  const bookDir = mkdtempSync(join(tmpdir(), 'audiobook-3954-'));
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
  if (supersededBy) {
    writeFileSync(
      join(bookDir, '.audiobook', 'cast-id-history.json'),
      JSON.stringify({ schema: 1, supersededBy }),
    );
  }
  const chapterHints = [
    { id: 1, title: 'Chapter One', body },
    { id: 2, title: 'Chapter Two', body },
    { id: 3, title: 'Chapter Three', body },
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

type Sent = { kind: string; response?: { characters: Row[]; sentences: Row[] } };

function mkJob(
  manuscriptId: string,
  bookDir: string,
  kind: 'main' | 'subset',
): { job: AnalysisJob; events: Sent[] } {
  const events: Sent[] = [];
  const job = {
    controller: new AbortController(),
    subscribers: new Set([
      { send: (e: Sent) => events.push(e), res: { end() {} }, keepAlive: undefined },
    ]),
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
  return { job, events };
}

const NARR: CharacterOutput = {
  id: 'narrator',
  name: 'Narrator',
  role: 'narrator',
  color: 'narrator',
} as CharacterOutput;
const WREN_FRESH = {
  id: FRESH_ID,
  name: 'Wren Ashby',
  role: 'lead',
  color: '#111111',
  gender: 'female',
  evidence: [{ quote: 'Wren asked' }],
} as CharacterOutput;
const roster = [NARR, WREN_FRESH];
const PRIOR_WREN: Row = { id: PRIOR_ID, name: 'Wren', voiceState: 'locked' };

async function run(
  manuscriptId: string,
  bookDir: string,
  kind: 'main' | 'subset',
  fresh: { roster: CharacterOutput[]; speakerId: string } = { roster, speakerId: FRESH_ID },
): Promise<Sent[]> {
  const { job, events } = mkJob(manuscriptId, bookDir, kind);
  const rec = getManuscript(manuscriptId);
  if (!rec) throw new Error('manuscript missing');
  const phase1Sel = sel(phase1(fresh.speakerId), 'phase1-model');
  if (kind === 'subset') {
    /* Pre-seed cache.stage1 so the subset route takes the book-already-analysed
       branch (stage1Existed), the only one that reaches the subset persist. */
    await saveAnalysisCache(manuscriptId, {
      chapters: {},
      stage1: {
        characters: fresh.roster,
        chapters: rec.chapterHints.map((c) => ({ id: c.id, title: c.title })),
      },
    } as never);
    await runSubsetAnalyzerJob(
      job,
      rec as never,
      sel(phase0(fresh.roster), 'phase0-model'),
      phase1Sel,
      rec.chapterHints,
      true,
    );
    return events;
  }
  (globalThis as Record<string, unknown>).__keep_prior_id_phase1 = phase1Sel;
  await runMainAnalyzerJob(job, rec as never, sel(phase0(fresh.roster), 'phase0-model'), {
    requestedFresh: false,
    allowStage1Shrink: true,
    requestedModel: undefined,
  } as never);
  return events;
}

const readJson = (bookDir: string, file: string): Record<string, unknown> =>
  JSON.parse(readFileSync(join(bookDir, '.audiobook', file), 'utf8'));
const readCast = (bookDir: string): Row[] => readJson(bookDir, 'cast.json').characters as Row[];
const readEdits = (bookDir: string): Row[] =>
  readJson(bookDir, 'manuscript-edits.json').sentences as Row[];
const readHistory = (bookDir: string): { supersededBy: Record<string, string> } =>
  readJson(bookDir, 'cast-id-history.json') as never;

function expectPriorIdOnDisk(bookDir: string): void {
  const cast = readCast(bookDir);
  const wrens = cast.filter((c) => String(c.name).startsWith('Wren'));
  expect(wrens).toHaveLength(1);
  expect(wrens[0].id).toBe(PRIOR_ID);
  expect(wrens[0].voiceState).toBe('locked');
  expect(cast.some((c) => c.id === FRESH_ID)).toBe(false);

  const edits = readEdits(bookDir);
  const attributed = edits.filter((s) => s.characterId === PRIOR_ID || s.characterId === FRESH_ID);
  expect(attributed.length).toBeGreaterThan(0);
  expect(attributed.every((s) => s.characterId === PRIOR_ID)).toBe(true);

  const history = readHistory(bookDir);
  expect(history.supersededBy[FRESH_ID]).toBe(PRIOR_ID);
  const resolved = buildCastResolver(cast as Array<{ id: string }>, history).resolve(FRESH_ID);
  expect(resolved?.character.id).toBe(PRIOR_ID);
}

describe('#3954 the prior id survives a surname-tolerant join, through the real analysis jobs', () => {
  const orig = process.env.STAGE2_COVERAGE_RETRIES;
  beforeEach(() => {
    process.env.STAGE2_COVERAGE_RETRIES = '0';
  });
  afterEach(() => {
    delete (globalThis as Record<string, unknown>).__keep_prior_id_phase1;
    if (orig === undefined) delete process.env.STAGE2_COVERAGE_RETRIES;
    else process.env.STAGE2_COVERAGE_RETRIES = orig;
  });
  const cleanup = async (manuscriptId: string, bookDir: string): Promise<void> => {
    removeManuscript(manuscriptId);
    await clearAnalysisCache(manuscriptId);
    rmSync(bookDir, { recursive: true, force: true });
  };

  it('A1 main job: cast, edits, result and history all carry the prior id', async () => {
    const { manuscriptId, bookDir } = mkBook([{ ...NARR }, { ...PRIOR_WREN }]);
    try {
      const events = await run(manuscriptId, bookDir, 'main');
      expectPriorIdOnDisk(bookDir);

      const result = events.find((e) => e.kind === 'result');
      expect(result?.response).toBeDefined();
      const response = result!.response!;
      expect(response.characters.some((c) => c.id === PRIOR_ID)).toBe(true);
      expect(response.characters.some((c) => c.id === FRESH_ID)).toBe(false);
      const wrenSentences = response.sentences.filter(
        (s) => s.characterId === PRIOR_ID || s.characterId === FRESH_ID,
      );
      expect(wrenSentences.length).toBeGreaterThan(0);
      expect(wrenSentences.every((s) => s.characterId === PRIOR_ID)).toBe(true);
    } finally {
      await cleanup(manuscriptId, bookDir);
    }
  });

  it('A2 subset job: cast, edits and history all carry the prior id', async () => {
    const { manuscriptId, bookDir } = mkBook([{ ...NARR }, { ...PRIOR_WREN }]);
    try {
      await run(manuscriptId, bookDir, 'subset');
      expectPriorIdOnDisk(bookDir);
    } finally {
      await cleanup(manuscriptId, bookDir);
    }
  });

  /* Finding 4 (owner: follow the history). The user merged "Brann Weir" into Old
     Weir, so the history holds brann-weir -> old-weir. The analyzer re-mints
     brann-weir "Brann Weir"; Brann (locked, name "Brann") is a surname-tolerant
     match. Joining would overwrite the user's merge, so the join is refused
     and the fresh lines keep resolving to Old Weir. */
  it.each(['main', 'subset'] as const)(
    'A5 %s job: a fresh id the user merged elsewhere is not name-joined to a tolerant twin',
    async (kind) => {
      const brannFresh = {
        ...WREN_FRESH,
        id: 'brann-weir',
        name: 'Brann Weir',
        evidence: [{ quote: 'Brann asked' }],
      } as CharacterOutput;
      const { manuscriptId, bookDir } = mkBook(
        [
          { ...NARR },
          { id: 'brann', name: 'Brann', voiceState: 'locked' },
          { id: 'old-weir', name: 'Old Weir', aliases: ['Brann Weir'] },
        ],
        { 'brann-weir': 'old-weir' },
        BODY.replace('Wren asked', 'Brann asked'),
      );
      try {
        await run(manuscriptId, bookDir, kind, {
          roster: [NARR, brannFresh],
          speakerId: 'brann-weir',
        });
        const cast = readCast(bookDir);
        const brann = cast.find((c) => c.id === 'brann');
        expect(brann?.voiceState).toBe('locked');
        expect(brann?.name).toBe('Brann');
        const history = readHistory(bookDir);
        expect(history.supersededBy).toEqual({ 'brann-weir': 'old-weir' });
        expect(history).not.toHaveProperty('displaced');
        const resolver = buildCastResolver(cast as Array<{ id: string }>, history);
        expect(resolver.resolve('brann-weir')?.character.id).toBe('old-weir');
        const attributed = readEdits(bookDir).filter(
          (s) => s.characterId === 'brann-weir' || s.characterId === 'old-weir',
        );
        expect(attributed.length).toBeGreaterThan(0);
        expect(readEdits(bookDir).some((s) => s.characterId === 'brann')).toBe(false);
        expect(cast.some((c) => c.id === 'brann-weir')).toBe(false);
      } finally {
        await cleanup(manuscriptId, bookDir);
      }
    },
  );

  it('A3 a second main run is stable', async () => {
    const { manuscriptId, bookDir } = mkBook([{ ...NARR }, { ...PRIOR_WREN }]);
    try {
      await run(manuscriptId, bookDir, 'main');
      await run(manuscriptId, bookDir, 'main');
      const cast = readCast(bookDir);
      const wrens = cast.filter((c) => String(c.name).startsWith('Wren'));
      expect(wrens).toHaveLength(1);
      expect(wrens[0].id).toBe(PRIOR_ID);
      const history = readHistory(bookDir);
      const resolver = buildCastResolver(cast as Array<{ id: string }>, history);
      for (const key of Object.keys(history.supersededBy)) {
        expect(resolver.resolve(key)?.character.id).toBe(PRIOR_ID);
      }
    } finally {
      await cleanup(manuscriptId, bookDir);
    }
  });
});
