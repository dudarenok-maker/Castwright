/* #3084 P1 — an analysis run marks the endpoints it uses busy at job creation, and the mark
   lasts until endJob, so TTS eviction never unloads the model between two chunk calls. The
   analyzer is faked: every call rejects with AnalysisAbortedError, which the job loop ends
   through endJob (analysis.ts:3063), so the SSE stream closes. */
import { describe, it, expect, vi, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { putManuscript, removeManuscript, type ChapterHint } from '../store/manuscripts.js';
import { _resetUserSettingsCache, _setUserSettingsCacheForTest } from '../workspace/user-settings.js';
import { analyzerEndpointSchema } from '../workspace/analyzer-endpoints.js';
import { AnalysisAbortedError } from '../analyzer/errors.js';

const { marks, releases } = vi.hoisted(() => ({ marks: [] as string[][], releases: { count: 0 } }));

vi.mock('../analyzer/analyzer-concurrency.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../analyzer/analyzer-concurrency.js')>();
  return {
    ...actual,
    markEndpointRunActive: (ids: readonly string[]) => {
      marks.push([...ids]);
      const release = actual.markEndpointRunActive(ids);
      return () => {
        releases.count += 1;
        release();
      };
    },
  };
});

vi.mock('../analyzer/select-analyzer.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../analyzer/select-analyzer.js')>();
  const stop = () => Promise.reject(new AnalysisAbortedError('fake analyzer: stop'));
  const analyzer = {
    runStage1: stop,
    runStage1Chapter: stop,
    runStage2Chapter: stop,
    runEmotionChapter: stop,
    runScriptReviewChapter: stop,
    runStage3Chapter: stop,
    runAttributionEscalation: stop,
  };
  return {
    ...actual,
    selectAnalyzerForPhase: () => ({ analyzer, engine: 'openai', model: 'openai:lab::qwen3-30b', fallbackModel: null }),
  };
});

const { analysisRouter } = await import('./analysis.js');
const { isEndpointBusy, _resetEndpointBusyForTest } = await import('../analyzer/analyzer-concurrency.js');

const lab = analyzerEndpointSchema.parse({ id: 'lab', name: 'Lab', baseUrl: 'http://127.0.0.1:8080/v1', gpu: 'cuda:0', contextTokens: 32768 });

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/manuscripts', analysisRouter);
  return app;
}

function seed() {
  const chapterHints = [{ id: 1, title: 'Chapter One', body: 'The lamp guttered.' }] as unknown as ChapterHint[];
  putManuscript({
    manuscriptId: 'm_endpoint_run', format: 'plaintext', title: 'Stub', wordCount: 3, byteSize: 100,
    uploadedAt: new Date().toISOString(), sourceText: 'The lamp guttered.', chapterHints,
  });
  _setUserSettingsCacheForTest({ analyzerEndpoints: [lab], analyzerEndpointKeys: {} });
}

afterEach(() => {
  removeManuscript('m_endpoint_run');
  _resetUserSettingsCache();
  _resetEndpointBusyForTest();
  marks.length = 0;
  releases.count = 0;
});

describe('analysis runs hold their endpoints busy (#3084 P1)', () => {
  it('the main POST marks the endpoints of both phases at job creation and releases them when the job ends', async () => {
    seed();
    await request(makeApp()).post('/api/manuscripts/m_endpoint_run/analysis').send({ model: 'openai:lab::qwen3-30b' });
    expect(marks).toEqual([['lab']]);
    expect(releases.count).toBe(1);
    expect(isEndpointBusy('lab')).toBe(false);
  }, 20_000);

  it('the subset POST marks and releases the same way', async () => {
    seed();
    await request(makeApp()).post('/api/manuscripts/m_endpoint_run/analysis/chapters').send({ model: 'openai:lab::qwen3-30b', chapterIds: [1] });
    expect(marks).toEqual([['lab']]);
    expect(releases.count).toBe(1);
    expect(isEndpointBusy('lab')).toBe(false);
  }, 20_000);

  it('a run whose phase1Model names an endpoint is pre-checked and marked for that endpoint (#3141 per-run pick)', async () => {
    seed();
    /* Phase 0 runs a Gemini id (no digest read, no endpoint); only the per-run phase-1 pick names `lab`. */
    await request(makeApp()).post('/api/manuscripts/m_endpoint_run/analysis').send({ model: 'gemini-3.6-flash', phase1Model: 'openai:lab::qwen3-30b' });
    expect(marks).toEqual([['lab']]);
    expect(releases.count).toBe(1);
    expect(isEndpointBusy('lab')).toBe(false);
  }, 20_000);
});
