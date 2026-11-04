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
import * as stateIo from '../workspace/state-io.js';

/* Passthrough by default; N1 installs a one-shot failure on the remap's own
   history read, the way a transient AV / cloud-sync EBUSY would. */
vi.mock('../workspace/state-io.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../workspace/state-io.js')>();
  return { ...actual, readJson: vi.fn(actual.readJson) };
});

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

/* P3-3: runs inside the Phase-1 call for a chapter, before it attributes. A
   test installs it to stop the job (abort + throw) at a chosen chapter. */
let phase1Hook: ((chapterId: number) => void) | undefined;
let lastJob: AnalysisJob | undefined;

function phase1(speakerId: string | string[]): Analyzer {
  const speakers = [speakerId].flat();
  const perChapter = speakers.length > 1 ? 3 : 1;
  return {
    runStage1: () => Promise.reject(new Error('not used')),
    runStage1Chapter: () => Promise.reject(new Error('phase1')),
    /* One line per chapter for a single speaker; with several speakers, three
       lines per chapter handed out in turn, so each clears the minor-cast fold. */
    runStage2Chapter: (async (_m: string, chapterId: number) => {
      phase1Hook?.(chapterId);
      return {
      sentences: Array.from({ length: perChapter }, (_, k) => ({
        id: chapterId * 100 + k + 1,
        chapterId,
        characterId: speakers[(k + (chapterId - 1) * perChapter) % speakers.length],
        confidence: 0.9,
        text: 'Are you sure this will work',
      })),
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
  fresh: { roster: CharacterOutput[]; speakerId: string | string[] } = { roster, speakerId: FRESH_ID },
): Promise<Sent[]> {
  const { job, events } = mkJob(manuscriptId, bookDir, kind);
  lastJob = job;
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
        // P4-1: the adopted merge target keeps the name the user gave it.
        expect(cast.find((c) => c.id === 'old-weir')?.name).toBe('Old Weir');
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

  /* N1(a). The remap used to read the history through the collapsing loader, so
     one transient read failure on THAT read turned the A5 case (a recorded
     merge, flagged downstream) into `{brann-weir: brann}`: the merge silently
     overwritten. The blip is keyed on the caller (the final remap's read, not
     a read count) and every other read stays healthy. The remap then makes no
     name join and the run falls to mergeCore's displaced path. */
  it.each(['main', 'subset'] as const)(
    'N1 %s job: one failed read of the history at the remap never overwrites a recorded merge',
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
      const actualReadJson = (await vi.importActual<typeof import('../workspace/state-io.js')>(
        '../workspace/state-io.js',
      )).readJson;
      let blips = 0;
      vi.mocked(stateIo.readJson).mockImplementation(async (path: string) => {
        if (path.endsWith('cast-id-history.json') && blips === 0) {
          const frames = (new Error().stack ?? '').split(String.fromCharCode(10)).map((l) => l.trim());
          const at = frames.findIndex((l) => l.includes('loadIdHistoryForRemap'));
          const caller = at >= 0 ? frames[at + 1] ?? '' : '';
          if (/(runMainAnalyzerJob|runSubsetAnalyzerJob)/.test(caller)) {
            blips += 1;
            throw new Error('EBUSY: resource busy or locked (simulated transient read blip)');
          }
        }
        return actualReadJson(path);
      });
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        const events = await run(manuscriptId, bookDir, kind, {
          roster: [NARR, brannFresh],
          speakerId: 'brann-weir',
        });
        expect(events.length).toBeGreaterThan(0);
        expect(blips).toBe(1);
        const history = readHistory(bookDir);
        // The silent overwrite is the one outcome this must never reach.
        expect(history.supersededBy['brann-weir']).not.toBe('brann');
        // Flagged exactly as on main: the dropped alias is recorded as displaced
        expect(JSON.stringify(history)).toContain('"displaced"');
        expect(JSON.stringify((history as { displaced?: unknown }).displaced)).toContain('old-weir');
        // ...and the run log tells the user the name joins were limited to exact names.
        expect(JSON.stringify(events)).toContain('only exact-name matches kept their existing character ids');
      } finally {
        warnSpy.mockRestore();
        vi.mocked(stateIo.readJson).mockImplementation(actualReadJson);
        await cleanup(manuscriptId, bookDir);
      }
    },
  );

  /* P3-1. A degraded history read must not regress main's exact tier. Prior
     `w2 "Wren"` (locked, no voiceId) is re-minted by the analyzer as
     `wren-2 "Wren"`. On main the remap's exact tier keeps `w2`. With the read
     failing, the remap used to join nothing, so mergeCore's name fallback kept
     the FRESH id and retired `w2` for good (the locked row's voice keys on
     its id). Now the degraded remap runs main's exact tier. */
  const wrenTwo = {
    ...WREN_FRESH,
    id: 'wren-2',
    name: 'Wren',
    evidence: [{ quote: 'Wren asked' }],
  } as CharacterOutput;
  const blipRemapRead = async (): Promise<{ count: () => number; restore: () => void }> => {
    const actualReadJson = (
      await vi.importActual<typeof import('../workspace/state-io.js')>('../workspace/state-io.js')
    ).readJson;
    let blips = 0;
    vi.mocked(stateIo.readJson).mockImplementation(async (path: string) => {
      if (path.endsWith('cast-id-history.json') && blips === 0) {
        const frames = (new Error().stack ?? '').split(String.fromCharCode(10)).map((l) => l.trim());
        const at = frames.findIndex((l) => l.includes('loadIdHistoryForRemap'));
        const caller = at >= 0 ? (frames[at + 1] ?? '') : '';
        if (/(runMainAnalyzerJob|runSubsetAnalyzerJob)/.test(caller)) {
          blips += 1;
          throw new Error('EBUSY: resource busy or locked (simulated transient read blip)');
        }
      }
      return actualReadJson(path);
    });
    return {
      count: () => blips,
      restore: () => vi.mocked(stateIo.readJson).mockImplementation(actualReadJson),
    };
  };
  const expectW2Kept = (bookDir: string): void => {
    const cast = readCast(bookDir);
    const wrens = cast.filter((c) => c.name === 'Wren');
    expect(wrens).toHaveLength(1);
    expect(wrens[0].id).toBe('w2');
    expect(wrens[0].voiceState).toBe('locked');
    expect(cast.some((c) => c.id === 'wren-2')).toBe(false);
    const attributed = readEdits(bookDir).filter(
      (s) => s.characterId === 'w2' || s.characterId === 'wren-2',
    );
    expect(attributed.length).toBeGreaterThan(0);
    expect(attributed.every((s) => s.characterId === 'w2')).toBe(true);
  };

  it.each(['main', 'subset'] as const)(
    'P3-1 %s job: one failed read of the history at the remap still keeps the prior id on an exact-name drift',
    async (kind) => {
      const { manuscriptId, bookDir } = mkBook([{ ...NARR }, { ...PRIOR_WREN }], {});
      const blip = await blipRemapRead();
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        const events = await run(manuscriptId, bookDir, kind, {
          roster: [NARR, wrenTwo],
          speakerId: 'wren-2',
        });
        expect(blip.count()).toBe(1);
        expectW2Kept(bookDir);
        expect(readHistory(bookDir).supersededBy['wren-2']).toBe('w2');
        expect(JSON.stringify(events)).toContain('only exact-name matches kept');
      } finally {
        warnSpy.mockRestore();
        blip.restore();
        await cleanup(manuscriptId, bookDir);
      }
    },
  );

  it.each(['main', 'subset'] as const)(
    'P3-1 %s job: a malformed history file still keeps the prior id on an exact-name drift',
    async (kind) => {
      const { manuscriptId, bookDir } = mkBook([{ ...NARR }, { ...PRIOR_WREN }]);
      writeFileSync(join(bookDir, '.audiobook', 'cast-id-history.json'), '{ not json');
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      try {
        await run(manuscriptId, bookDir, kind, { roster: [NARR, wrenTwo], speakerId: 'wren-2' });
        expectW2Kept(bookDir);
      } finally {
        warnSpy.mockRestore();
        errSpy.mockRestore();
        await cleanup(manuscriptId, bookDir);
      }
    },
  );

  /* P3-1 persist guard. The blind exact join (wren-2 -> w2) must not overwrite
     a merge the history records: wren-2 was merged into `m1`, a live row. */
  it.each(['main', 'subset'] as const)(
    'P3-1 %s job: a blind exact join under a blip never overwrites a recorded merge, it files displaced',
    async (kind) => {
      const { manuscriptId, bookDir } = mkBook(
        [{ ...NARR }, { ...PRIOR_WREN }, { id: 'm1', name: 'Merged One', voiceState: 'locked' }],
        { 'wren-2': 'm1' },
      );
      const blip = await blipRemapRead();
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        const events = await run(manuscriptId, bookDir, kind, {
          roster: [NARR, wrenTwo],
          speakerId: 'wren-2',
        });
        expect(blip.count()).toBe(1);
        const history = readHistory(bookDir) as ReturnType<typeof readHistory> & {
          displaced?: Record<string, string>;
        };
        expect(history.supersededBy['wren-2']).toBe('m1');
        expect(history.displaced).toEqual({ 'wren-2': 'm1' });
        expect(JSON.stringify(events)).toContain('Kept the recorded merge wren-2 -> m1');
      } finally {
        warnSpy.mockRestore();
        blip.restore();
        await cleanup(manuscriptId, bookDir);
      }
    },
  );

  /* P4-1. When the remap adopts the recorded merge target, the fresh row's NAME
     used to ride onto it: the target "Merged One" became a second "Wren" next to
     the locked `w2 "Wren"`, and the next run's load-time same-name dedup then
     retired one of the two locked rows. Two consecutive runs, same roster: both
     rows keep their own names, voices and the history stays untouched. */
  it.each(['main', 'subset'] as const)(
    'P4-1 %s job: an adopted merge target keeps its own name across two runs',
    async (kind) => {
      const { manuscriptId, bookDir } = mkBook(
        [
          { ...NARR },
          { ...PRIOR_WREN },
          { id: 'm1', name: 'Merged One', voiceState: 'locked', voiceId: 'v_m1' },
        ],
        { 'wren-2': 'm1' },
      );
      try {
        for (const runNo of [1, 2]) {
          await run(manuscriptId, bookDir, kind, { roster: [NARR, wrenTwo], speakerId: 'wren-2' });
          const cast = readCast(bookDir);
          const w2 = cast.find((c) => c.id === 'w2');
          const m1 = cast.find((c) => c.id === 'm1');
          expect([runNo, w2?.name, w2?.voiceState]).toEqual([runNo, 'Wren', 'locked']);
          expect([runNo, m1?.name, m1?.voiceId]).toEqual([runNo, 'Merged One', 'v_m1']);
          expect(cast.filter((c) => c.name === 'Wren')).toHaveLength(1);
          const history = readHistory(bookDir) as ReturnType<typeof readHistory> & {
            displaced?: Record<string, string>;
          };
          expect(history.supersededBy).toEqual({ 'wren-2': 'm1' });
          expect(history.displaced).toBeUndefined();
          expect(readEdits(bookDir).every((s) => s.characterId !== 'wren-2')).toBe(true);
        }
      } finally {
        await cleanup(manuscriptId, bookDir);
      }
    },
  );

  /* P4-4. The persist guard's "live" set was the persisted roster only. An
     UNVOICED merge target the fresh roster omits is in the prior cast (the
     healthy remap adopts it) but not in that roster, so a blip on the remap's
     read let the blind exact join overwrite the recorded merge with no flag. */
  it.each(['main', 'subset'] as const)(
    'P4-4 %s job: a blind exact join under a blip does not overwrite a merge into an unvoiced prior row',
    async (kind) => {
      const { manuscriptId, bookDir } = mkBook(
        [{ ...NARR }, { ...PRIOR_WREN }, { id: 'm1', name: 'Merged One' }],
        { 'wren-2': 'm1' },
      );
      const blip = await blipRemapRead();
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        const events = await run(manuscriptId, bookDir, kind, {
          roster: [NARR, wrenTwo],
          speakerId: 'wren-2',
        });
        expect(blip.count()).toBe(1);
        const history = readHistory(bookDir) as ReturnType<typeof readHistory> & {
          displaced?: Record<string, string>;
        };
        expect(history.supersededBy['wren-2']).not.toBe('w2');
        expect(history.displaced).toEqual({ 'wren-2': 'm1' });
        expect(JSON.stringify(events)).toContain('Kept the recorded merge wren-2 -> m1');
      } finally {
        warnSpy.mockRestore();
        blip.restore();
        await cleanup(manuscriptId, bookDir);
      }
    },
  );

  /* N2 (owner: refuse and flag). The recorded merge brann-weir -> old-weir
     (adoption) and a drifted second fresh row "Old Weir" (an exact-name join)
     both want the prior old-weir row. Joining both wrote two cast rows with
     the id old-weir. The remap makes NEITHER join, so no two rows can share an
     id, and the fresh rows are kept apart. */
  it.each(['main', 'subset'] as const)(
    'N2 %s job: an adoption and an exact-name join on one prior row never write a shared cast id',
    async (kind) => {
      const bw = {
        ...WREN_FRESH,
        id: 'brann-weir',
        name: 'Brann Weir',
        evidence: [{ quote: 'Brann asked' }],
      } as CharacterOutput;
      const ow2 = {
        ...WREN_FRESH,
        id: 'ow2',
        name: 'Old Weir',
        evidence: [{ quote: 'Olga nodded' }],
      } as CharacterOutput;
      const { manuscriptId, bookDir } = mkBook(
        [
          { ...NARR },
          { id: 'brann', name: 'Brann', voiceState: 'locked', voiceId: 'v_brann' },
          { id: 'old-weir', name: 'Old Weir', voiceState: 'locked', voiceId: 'v_ow' },
        ],
        { 'brann-weir': 'old-weir' },
        BODY.replace('Wren asked', 'Brann asked'),
      );
      try {
        await run(manuscriptId, bookDir, kind, {
          roster: [NARR, bw, ow2],
          speakerId: ['brann-weir', 'ow2'],
        });
        const cast = readCast(bookDir);
        const ids = cast.map((c) => String(c.id));
        expect(new Set(ids).size).toBe(ids.length);
        /* Neither join was made, end to end: the fresh rows keep their own ids and
           the prior rows are untouched. The old-weir assertion is the one that
           catches mergeCore making the exact join the remap refused (it carries
           the locked prior row forward only if it was NOT consumed); the voiceId
           on the fixture would otherwise mask that join (P3-2). */
        expect(ids).toEqual(expect.arrayContaining(['brann-weir', 'ow2', 'brann', 'old-weir']));
        expect(cast.find((c) => c.id === 'brann')?.voiceState).toBe('locked');
        // ...and mergeCore's existing path flags the recorded merge it could not honour.
        const history = readHistory(bookDir) as { displaced?: Record<string, string> };
        expect(Object.keys(history.displaced ?? {})).toContain('brann-weir');
      } finally {
        await cleanup(manuscriptId, bookDir);
      }
    },
  );

  /* P3-2. The same fixture as N2 with NO voiceId on the prior rows. A voiceId
     rides across mergeCore's exact join on its own (`voiceId` is a preserved
     voice field), so N2 above passes even when mergeCore consumes old-weir.
     Without a voiceId the voice keys on the row's id, so the join is a silent
     voice change: old-weir must remain in cast.json under its own id and the
     fresh ow2 row must stay a row of its own. */
  it.each(['main', 'subset'] as const)(
    'P3-2 %s job: with no voiceId the refused exact join is not made by mergeCore either',
    async (kind) => {
      const bw = {
        ...WREN_FRESH,
        id: 'brann-weir',
        name: 'Brann Weir',
        evidence: [{ quote: 'Brann asked' }],
      } as CharacterOutput;
      const ow2 = {
        ...WREN_FRESH,
        id: 'ow2',
        name: 'Old Weir',
        evidence: [{ quote: 'Olga nodded' }],
      } as CharacterOutput;
      const { manuscriptId, bookDir } = mkBook(
        [
          { ...NARR },
          { id: 'brann', name: 'Brann', voiceState: 'locked' },
          { id: 'old-weir', name: 'Old Weir', voiceState: 'locked' },
        ],
        { 'brann-weir': 'old-weir' },
        BODY.replace('Wren asked', 'Brann asked'),
      );
      try {
        await run(manuscriptId, bookDir, kind, {
          roster: [NARR, bw, ow2],
          speakerId: ['brann-weir', 'ow2'],
        });
        const cast = readCast(bookDir);
        const ids = cast.map((c) => String(c.id));
        expect(new Set(ids).size).toBe(ids.length);
        expect(ids).toEqual(expect.arrayContaining(['brann-weir', 'ow2', 'brann', 'old-weir']));
        expect(cast.find((c) => c.id === 'old-weir')?.voiceState).toBe('locked');
        const history = readHistory(bookDir) as ReturnType<typeof readHistory> & {
          displaced?: Record<string, string>;
        };
        // No retirement of old-weir onto ow2, and the recorded merge is flagged.
        expect(history.supersededBy).not.toHaveProperty('old-weir');
        expect(Object.keys(history.displaced ?? {})).toContain('brann-weir');
      } finally {
        await cleanup(manuscriptId, bookDir);
      }
    },
  );

  /* N6. The remap does nothing here: the fresh roster holds the recorded target
     (`old-weir`) by id, and `ow2` / `old-weir` share a name. The merge's own
     name fallback is then the only thing between the locked Brann row and a
     retirement into brann-weir, and it refuses only because it is handed the
     id history (`recordedElsewhere`). Passing it `{}` instead retires the
     locked row and moves its voice onto the Brann Weir row. */
  it.each(['main', 'subset'] as const)(
    'N6 %s job: the merge, not the remap, refuses to retire a locked row into a fresh id recorded elsewhere',
    async (kind) => {
      const fr = (id: string, name: string): CharacterOutput =>
        ({ ...WREN_FRESH, id, name, evidence: [{ quote: 'Olga nodded' }] }) as CharacterOutput;
      const { manuscriptId, bookDir } = mkBook(
        [
          { ...NARR },
          { id: 'brann', name: 'Brann', voiceState: 'locked', voiceId: 'v_brann' },
          { id: 'old-weir', name: 'Old Weir', voiceState: 'locked', voiceId: 'v_ow' },
        ],
        { 'brann-weir': 'old-weir' },
      );
      try {
        await run(manuscriptId, bookDir, kind, {
          roster: [
            NARR,
            fr('brann-weir', 'Brann Weir'),
            fr('ow2', 'Old Weir'),
            fr('old-weir', 'Old Weir'),
          ],
          speakerId: ['brann-weir', 'ow2', 'old-weir'],
        });
        const cast = readCast(bookDir);
        const brann = cast.find((c) => c.id === 'brann');
        expect(brann?.voiceState).toBe('locked');
        expect(brann?.voiceId).toBe('v_brann');
        const history = readHistory(bookDir) as ReturnType<typeof readHistory> & {
          displaced?: Record<string, string>;
        };
        expect(history.supersededBy).not.toHaveProperty('brann');
        expect(history.displaced).toEqual({ 'brann-weir': 'old-weir' });
        const ids = cast.map((c) => String(c.id));
        expect(new Set(ids).size).toBe(ids.length);
      } finally {
        await cleanup(manuscriptId, bookDir);
      }
    },
  );

  /* P3-3. A run stopped in Phase 1 and never resumed. The interim snapshots
     write the PRIOR row in place of the drifted fresh row (F1/N3) and drop the
     fresh id, but the Phase-1 roll used to stream the raw analyzer id into
     manuscript-edits.json: lines on `wren-ashby`, an id with no cast row and
     no history entry. Every attributed line must resolve to a cast row. One
     chapter at a time, so chapter 1 is rolled before chapter 2 is stopped. */
  it.each([
    ['main', false],
    ['subset', false],
    // stage 1 already cached: the job writes no snapshot of its own, so the roll
    // computes the table the snapshot would have used from the cached roster
    ['main', true],
  ] as const)(
    'P3-3 %s job (cached stage 1: %s): a Phase-1 stop that is never resumed leaves every attributed line on a cast row',
    async (kind, cachedStage1) => {
      const origC = process.env.ANALYZER_OLLAMA_CONCURRENCY;
      process.env.ANALYZER_OLLAMA_CONCURRENCY = '1';
      const { manuscriptId, bookDir } = mkBook([{ ...NARR }, { ...PRIOR_WREN }]);
      phase1Hook = (chapterId) => {
        if (chapterId !== 2) return;
        lastJob!.controller.abort();
        const e = new Error('aborted');
        e.name = 'AbortError';
        throw e;
      };
      try {
        if (cachedStage1) {
          await saveAnalysisCache(manuscriptId, {
            chapters: {},
            stage1: {
              characters: roster,
              chapters: getManuscript(manuscriptId)!.chapterHints.map((c) => ({
                id: c.id,
                title: c.title,
              })),
            },
          } as never);
        }
        await run(manuscriptId, bookDir, kind).catch(() => {});
        const edits = readEdits(bookDir);
        expect(edits.length).toBeGreaterThan(0);
        const cast = readCast(bookDir);
        const resolver = buildCastResolver(cast as Array<{ id: string }>, {
          supersededBy: (() => {
            try {
              return readHistory(bookDir).supersededBy;
            } catch {
              return {};
            }
          })(),
        });
        const unresolved = [...new Set(edits.map((s) => String(s.characterId)))].filter(
          (id) => resolver.resolve(id) === null || resolver.resolve(id) === undefined,
        );
        expect(unresolved).toEqual([]);
        // the Wren lines sit on the same row the snapshot shows: the prior row
        expect(edits.some((s) => s.characterId === PRIOR_ID)).toBe(true);
        expect(cast.some((c) => c.id === PRIOR_ID)).toBe(true);
      } finally {
        phase1Hook = undefined;
        if (origC === undefined) delete process.env.ANALYZER_OLLAMA_CONCURRENCY;
        else process.env.ANALYZER_OLLAMA_CONCURRENCY = origC;
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
