/* #3084 P14 — the analysis POSTs run the pre-run checks only when a NEW job is created, and
   every check or selection failure carries a failure code. */
import { describe, it, expect, vi, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { putManuscript, removeManuscript, type ChapterHint } from '../store/manuscripts.js';
import { _resetUserSettingsCache, _setUserSettingsCacheForTest } from '../workspace/user-settings.js';

const { selectSpy, selectOverride, digest, bookLookup } = vi.hoisted(() => ({
  selectSpy: vi.fn(),
  selectOverride: { fn: null as null | ((opts: unknown) => unknown) },
  /* A3 — every installed-digest read the routes make, answered by hand when `answer` is set. */
  digest: { models: [] as string[], answer: null as null | ((model: string) => Promise<string | undefined>) },
  /* When set, a newly registered job waits on this promise at its first await. */
  bookLookup: { held: null as null | Promise<unknown> },
}));
vi.mock('../analyzer/select-analyzer.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../analyzer/select-analyzer.js')>();
  return {
    ...actual,
    selectAnalyzerForPhase: (opts: Parameters<typeof actual.selectAnalyzerForPhase>[0]) => {
      selectSpy(opts);
      if (selectOverride.fn) return selectOverride.fn(opts);
      return actual.selectAnalyzerForPhase(opts);
    },
  };
});

/* #3084 A3 — preflight.ts reads installed digests through this leaf. An unanswered read resolves
   undefined (fail-open), so no case here waits on a real Ollama. */
vi.mock('../analyzer/ollama-digest.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../analyzer/ollama-digest.js')>();
  return {
    ...actual,
    ollamaModelDigest: async (_url: string, model: string): Promise<string | undefined> => {
      digest.models.push(model);
      return digest.answer ? digest.answer(model) : undefined;
    },
  };
});
/* runMainAnalyzerJob and runSubsetAnalyzerJob both start with
   `await resolveBookLanguageForManuscript(id)`, which awaits this lookup: holding it keeps a
   registered job live, and resolving it with a book that has no language ends that job as
   `language_unset` before any analyzer call. */
vi.mock('../workspace/scan.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../workspace/scan.js')>();
  return {
    ...actual,
    findBookByManuscriptId: ((id: string) => bookLookup.held ?? actual.findBookByManuscriptId(id)) as typeof actual.findBookByManuscriptId,
  };
});

const { analysisRouter, __testRegisterJobForTest, endJob } = await import('./analysis.js');
type AnalysisJob = import('./analysis.js').AnalysisJob;

afterEach(() => {
  removeManuscript('m_preflight');
  _resetUserSettingsCache();
  selectSpy.mockReset();
  selectOverride.fn = null;
  digest.models.length = 0;
  digest.answer = null;
  bookLookup.held = null;
});

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/manuscripts', analysisRouter);
  return app;
}

function seedManuscript() {
  const chapterHints = [{ id: 1, title: 'Chapter One', body: 'The lamp guttered.' }] as unknown as ChapterHint[];
  putManuscript({
    manuscriptId: 'm_preflight', format: 'plaintext', title: 'Stub', wordCount: 3, byteSize: 100,
    uploadedAt: new Date().toISOString(), sourceText: 'The lamp guttered.', chapterHints,
  });
}

function parseSse(body: string): Array<Record<string, unknown>> {
  return body.split('\n').filter((l) => l.startsWith('data: ')).map((l) => JSON.parse(l.slice('data: '.length)));
}

describe('POST /api/manuscripts/:id/analysis — pre-run checks (#3084)', () => {
  it('refuses a per-run pick of a deleted endpoint with analyzer-endpoint-missing, before selection', async () => {
    seedManuscript();
    _setUserSettingsCacheForTest({ analyzerEndpoints: [] });
    const res = await request(makeApp()).post('/api/manuscripts/m_preflight/analysis').send({ model: 'openai:gone::qwen3-30b' });
    expect(parseSse(res.text)).toContainEqual(expect.objectContaining({ kind: 'error', code: 'analyzer-endpoint-missing' }));
    expect(selectSpy).not.toHaveBeenCalled();
  });

  it('refuses a phase1Model pick of an unsaved endpoint with analyzer-endpoint-missing, before selection (#3141 per-run pick)', async () => {
    seedManuscript();
    _setUserSettingsCacheForTest({ analyzerEndpoints: [] });
    const res = await request(makeApp()).post('/api/manuscripts/m_preflight/analysis').send({ phase1Model: 'openai:gone::m' });
    expect(parseSse(res.text)).toContainEqual(expect.objectContaining({ kind: 'error', code: 'analyzer-endpoint-missing' }));
    expect(selectSpy).not.toHaveBeenCalled();
  });

  it('a reload of a live job still joins it after its endpoint was deleted (checks run only on new-job creation, P14)', async () => {
    seedManuscript();
    const job = {
      controller: new AbortController(),
      subscribers: new Set(),
      manuscriptId: 'm_preflight',
      kind: 'main',
      bookDir: null,
      engine: 'openai',
      replay: { logs: [], lastPhase: null, lastEta: null, lastCastUpdate: null, failedByChapterId: new Map(), lastSeriesPrior: null, warnings: new Map() },
      lastDiskWriteAt: 0,
    } as unknown as AnalysisJob;
    __testRegisterJobForTest(job);
    _setUserSettingsCacheForTest({ analyzerEndpoints: [] });
    const done = request(makeApp()).post('/api/manuscripts/m_preflight/analysis').send({ model: 'openai:gone::qwen3-30b' }).then((r) => r);
    await vi.waitFor(() => expect(job.subscribers.size).toBe(1));
    endJob(job, { kind: 'error', code: 'cancelled', message: 'test over' });
    const events = parseSse((await done).text);
    expect(events).not.toContainEqual(expect.objectContaining({ code: 'analyzer-endpoint-missing' }));
    expect(events).toContainEqual(expect.objectContaining({ kind: 'error', code: 'cancelled' }));
    expect(selectSpy).not.toHaveBeenCalled();
  });

  /* A missing endpoint is coded by 3b Task 3b.1a's helper at both POSTs, which
     selection-error-coding.test.ts pins. These two cases pin the rest of that catch: every
     OTHER check or selection failure keeps its classified code once the block moves below
     the live-job re-check. The helper codes every class (Q2), so nothing here may go back to a
     code-less `{ kind: 'error', message }`. */
  it('a selection failure other than a missing endpoint carries its classified code (P14)', async () => {
    seedManuscript();
    _setUserSettingsCacheForTest({ analyzerEndpoints: [] });
    selectOverride.fn = () => {
      throw new Error('misconfigured engine');
    };
    const res = await request(makeApp()).post('/api/manuscripts/m_preflight/analysis').send({ model: 'qwen3.5:4b' });
    expect(parseSse(res.text)).toContainEqual(
      expect.objectContaining({ kind: 'error', code: 'unknown', message: expect.stringContaining('misconfigured engine') }),
    );
    expect(selectSpy).toHaveBeenCalled();
  });

  it('the subset POST classifies a selection failure other than a missing endpoint too (P14)', async () => {
    seedManuscript();
    _setUserSettingsCacheForTest({ analyzerEndpoints: [] });
    selectOverride.fn = () => {
      throw new Error('misconfigured engine');
    };
    const res = await request(makeApp()).post('/api/manuscripts/m_preflight/analysis/chapters').send({ model: 'qwen3.5:4b', chapterIds: [1] });
    expect(parseSse(res.text)).toContainEqual(
      expect.objectContaining({ kind: 'error', code: 'unknown', message: expect.stringContaining('misconfigured engine') }),
    );
  });
});

/* #3084 P14 + A3 + #3004 — the double-checked dispatch. A reload joins a live job before any
   digest read. A new job reads the digests, re-checks for a job registered while it waited,
   then checks, selects and registers with no await in between. */
describe('analysis POSTs — digest read on the new-job path only, live job re-checked after it (#3084, #3004)', () => {
  function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((r) => {
      resolve = r;
    });
    return { promise, resolve };
  }
  /* No case reaches an analyzer call, so selection never has to build a real analyzer. */
  const stubSelection = () => ({ analyzer: {}, engine: 'local', model: 'qwen3.5:4b', fallbackModel: null });
  /* Each POST selects phase 0 once per job it creates, and nothing else selects phase 0
     (runMainAnalyzerJob selects phase 1 only, and only after its first await). */
  const phase0Selections = () => selectSpy.mock.calls.filter(([opts]) => (opts as { phase: string }).phase === 'phase0').length;
  function liveJob(kind: 'main' | 'subset'): AnalysisJob {
    return {
      controller: new AbortController(),
      subscribers: new Set(),
      manuscriptId: 'm_preflight',
      kind,
      ...(kind === 'subset' ? { subsetChapterIds: [1] } : {}),
      bookDir: null,
      engine: 'local',
      replay: { logs: [], lastPhase: null, lastEta: null, lastCastUpdate: null, failedByChapterId: new Map(), lastSeriesPrior: null, warnings: new Map() },
      lastDiskWriteAt: 0,
    } as unknown as AnalysisJob;
  }
  interface Route {
    route: 'main' | 'subset';
    post: (app: express.Express) => request.Test;
  }
  const ROUTES: Route[] = [
    { route: 'main', post: (app) => request(app).post('/api/manuscripts/m_preflight/analysis').send({ model: 'qwen3.5:4b' }) },
    { route: 'subset', post: (app) => request(app).post('/api/manuscripts/m_preflight/analysis/chapters').send({ model: 'qwen3.5:4b', chapterIds: [1] }) },
  ];

  it.each(ROUTES)('$route: a reload of a live job reads no digest and runs no check (P14)', async ({ route, post }) => {
    seedManuscript();
    const job = liveJob(route);
    __testRegisterJobForTest(job);
    const done = post(makeApp()).then((r) => r);
    await vi.waitFor(() => expect(job.subscribers.size).toBe(1));
    expect(digest.models).toEqual([]); // an Ollama pick: a new job would have read its digest
    expect(selectSpy).not.toHaveBeenCalled();
    endJob(job, { kind: 'error', code: 'cancelled', message: 'test over' });
    expect(parseSse((await done).text)).toContainEqual(expect.objectContaining({ kind: 'error', code: 'cancelled' }));
  });

  it.each(ROUTES)('$route: two new-job POSTs parked on the digest read start ONE job, and the other joins it (#3004)', async ({ route, post }) => {
    seedManuscript();
    selectOverride.fn = stubSelection;
    const digestRead = deferred<string | undefined>();
    digest.answer = () => digestRead.promise;
    const app = makeApp();
    const first = post(app).then((r) => r);
    const second = post(app).then((r) => r);
    /* Both passed the first live-job check (no job existed) and now wait on the same read. */
    await vi.waitFor(() => expect(digest.models).toHaveLength(2));
    const lookup = deferred<unknown>();
    bookLookup.held = lookup.promise; // armed only now: the main POST's own language check has already run
    /* One promise answers both reads, so both POSTs resume in the same microtask checkpoint. The
       first to resume registers a job; the second's re-check runs before any timer fires. */
    digestRead.resolve('sha256:q');
    await vi.waitFor(() => expect(phase0Selections()).toBeGreaterThan(0));
    lookup.resolve({ state: {} }); // a located book with no language: every registered job ends as language_unset
    const events = (await Promise.all([first, second])).map((r) => parseSse(r.text));
    expect(phase0Selections()).toBe(1);
    for (const stream of events) {
      expect(stream).toContainEqual(expect.objectContaining({ kind: 'error', code: 'language_unset' }));
    }
    if (route === 'main') expect(events.flat().filter((e) => e.kind === 'rejoin-miss')).toHaveLength(1);
  });

  it('subset: a job for other chapters registered during the digest read is refused with subset_in_progress, never joined (#3202)', async () => {
    seedManuscript();
    selectOverride.fn = stubSelection;
    const digestRead = deferred<string | undefined>();
    digest.answer = () => digestRead.promise;
    let settled = false;
    const done = request(makeApp())
      .post('/api/manuscripts/m_preflight/analysis/chapters')
      .send({ model: 'qwen3.5:4b', chapterIds: [1] })
      .then((r) => {
        settled = true;
        return r;
      });
    /* Past the first live-job check (no job existed), parked on the digest read. */
    await vi.waitFor(() => expect(digest.models).toHaveLength(1));
    const other = liveJob('subset');
    (other as unknown as { subsetChapterIds: number[] }).subsetChapterIds = [2];
    __testRegisterJobForTest(other);
    digestRead.resolve('sha256:q');
    await vi.waitFor(() => expect(settled || other.subscribers.size > 0).toBe(true));
    const joined = other.subscribers.size > 0;
    endJob(other, { kind: 'error', code: 'cancelled', message: 'test over' });
    const events = parseSse((await done).text);
    expect(joined).toBe(false);
    expect(events).toContainEqual(expect.objectContaining({ kind: 'error', code: 'subset_in_progress' }));
    expect(phase0Selections()).toBe(0);
  });

  const rejectedAtOff = {
    serverUrl: 'http://localhost:11434', testedAt: '2026-09-11T10:00:00.000Z', control: { ok: true as const },
    structuredOutput: { schema: { off: 'rejected' as const } }, reasoning: {}, digest: 'sha256:old',
  };

  it('a new job reads the installed digest and still refuses a Test rejection recorded for that build (A3)', async () => {
    seedManuscript();
    _setUserSettingsCacheForTest({ analyzerEndpoints: [], analyzerCapabilitiesByModel: { 'qwen3.5:4b': rejectedAtOff } });
    digest.answer = async () => 'sha256:old';
    const res = await request(makeApp()).post('/api/manuscripts/m_preflight/analysis').send({ model: 'qwen3.5:4b' });
    expect(digest.models).toEqual(['qwen3.5:4b']);
    expect(parseSse(res.text)).toContainEqual(expect.objectContaining({ kind: 'error', code: 'analyzer-request-rejected' }));
    expect(selectSpy).not.toHaveBeenCalled();
  });

  it('a new job for a re-pulled model discards that rejection and reaches selection (A3)', async () => {
    seedManuscript();
    _setUserSettingsCacheForTest({ analyzerEndpoints: [], analyzerCapabilitiesByModel: { 'qwen3.5:4b': rejectedAtOff } });
    digest.answer = async () => 'sha256:new';
    selectOverride.fn = () => {
      throw new Error('reached selection');
    };
    const res = await request(makeApp()).post('/api/manuscripts/m_preflight/analysis').send({ model: 'qwen3.5:4b' });
    expect(digest.models).toEqual(['qwen3.5:4b']);
    expect(parseSse(res.text)).not.toContainEqual(expect.objectContaining({ code: 'analyzer-request-rejected' }));
    expect(selectSpy).toHaveBeenCalled();
  });
});
