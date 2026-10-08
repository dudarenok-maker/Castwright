/* #3084 P23 — every analysis selection call site reports AnalyzerEndpointMissingError
   as analyzer-endpoint-missing. Phase 0 and the subset retry run the REAL selection
   through the REAL routes: a request model `openai:gone::m` makes PR 3a's selection
   throw. Phase 1 runs runMainAnalyzerJob with the phase-1 selection throwing, the
   way analysis.phase-model.test.ts injects a phase-1 selection. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { analysisRouter, runMainAnalyzerJob, type AnalysisJob } from './analysis.js';
import { clearAnalysisCache } from '../store/analysis-cache.js';
import { getManuscript, putManuscript, removeManuscript } from '../store/manuscripts.js';
import { AnalyzerEndpointMissingError } from '../analyzer/errors.js';
import type { Analyzer, AnalyzerSelection } from '../analyzer/index.js';
import type { Stage1ChapterOutput } from '../handoff/schemas.js';

vi.mock('../analyzer/select-analyzer.js', async () => {
  const actual = await vi.importActual<typeof import('../analyzer/select-analyzer.js')>('../analyzer/select-analyzer.js');
  return {
    ...actual,
    selectAnalyzerForPhase: (opts: Parameters<typeof actual.selectAnalyzerForPhase>[0]) => {
      const injected = (globalThis as Record<string, unknown>).__endpoint_missing_phase1_error;
      if (opts.phase === 'phase1' && injected) throw injected;
      const injected0 = (globalThis as Record<string, unknown>).__selection_phase0_error;
      if (opts.phase === 'phase0' && injected0) throw injected0;
      return actual.selectAnalyzerForPhase(opts);
    },
    isPerPhaseModelSelectionActive: () => false,
  };
});

const app = express();
app.use(express.json());
app.use('/api/manuscripts', analysisRouter);

function parseSse(body: string): Array<Record<string, unknown>> {
  return body
    .split('\n')
    .filter((l) => l.startsWith('data: '))
    .map((l) => JSON.parse(l.slice('data: '.length)) as Record<string, unknown>);
}

function registerStub(): string {
  const id = `m_endpoint_missing_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  const chapterHints = [1, 2].map((n) => ({ id: n, title: `Chapter ${n}`, body: `Chapter ${n} body. ` + 'lorem ipsum dolor sit amet '.repeat(50) }));
  putManuscript({
    manuscriptId: id,
    format: 'plaintext',
    title: `Stub ${id}`,
    wordCount: 200,
    byteSize: 10_000,
    uploadedAt: new Date().toISOString(),
    sourceText: chapterHints.map((c) => c.body).join('\n\n'),
    chapterHints,
  });
  return id;
}

const cast = (chapterId: number): Stage1ChapterOutput => ({
  characters: [
    { id: 'narrator', name: 'Narrator', role: 'narrator', color: 'narrator', evidence: [{ quote: 'lorem ipsum dolor sit amet' }, { quote: 'lorem ipsum dolor sit amet' }, { quote: 'lorem ipsum dolor sit amet' }] },
    { id: `ch${chapterId}-char`, name: `Character_ch${chapterId}`, role: 'character', color: 'unset', evidence: [{ quote: 'lorem ipsum dolor sit amet' }, { quote: 'lorem ipsum dolor sit amet' }, { quote: 'lorem ipsum dolor sit amet' }] },
  ],
});

const phase0Analyzer: Analyzer = {
  runStage1: () => Promise.reject(new Error('not used')),
  runStage1Chapter: (_m, chapterId) => Promise.resolve(cast(chapterId)),
  runStage2Chapter: () => Promise.reject(new Error('not used')),
  runEmotionChapter: () => Promise.reject(new Error('not used')),
  runScriptReviewChapter: () => Promise.reject(new Error('not used')),
  runStage3Chapter: () => Promise.reject(new Error('not used')),
  runAttributionEscalation: () => Promise.resolve(null),
};

afterEach(() => {
  delete (globalThis as Record<string, unknown>).__endpoint_missing_phase1_error;
  delete (globalThis as Record<string, unknown>).__selection_phase0_error;
});

describe('analysis selection call sites report analyzer-endpoint-missing (#3084 P23)', () => {
  it.each([
    ['phase 0 — POST /:id/analysis', (id: string) => request(app).post(`/api/manuscripts/${id}/analysis`).send({ model: 'openai:gone::m' })],
    ['subset retry — POST /:id/analysis/chapters', (id: string) => request(app).post(`/api/manuscripts/${id}/analysis/chapters`).send({ chapterIds: [1], model: 'openai:gone::m' })],
  ] as const)('%s', async (_site, post) => {
    const id = registerStub();
    try {
      const res = await post(id);
      expect(res.status).toBe(200);
      const error = parseSse(res.text).find((e) => e.kind === 'error');
      expect(error).toMatchObject({ kind: 'error', code: 'analyzer-endpoint-missing' });
      expect(String(error?.message)).toContain('Analyzer endpoint "gone" (from this run\'s model pick) cannot be used for analysis yet.');
    } finally {
      removeManuscript(id);
    }
  });

  it('phase 0 — any other selection error is coded too, never sent code-less (#3084 P23)', async () => {
    const id = registerStub();
    (globalThis as Record<string, unknown>).__selection_phase0_error = new Error('misconfigured engine: missing GEMINI_API_KEY');
    try {
      const res = await request(app).post(`/api/manuscripts/${id}/analysis`).send({});
      expect(res.status).toBe(200);
      expect(parseSse(res.text).find((e) => e.kind === 'error')).toMatchObject({
        kind: 'error',
        code: 'unknown',
        message: 'misconfigured engine: missing GEMINI_API_KEY',
      });
    } finally {
      removeManuscript(id);
    }
  });

  it('phase 1 — runMainAnalyzerJob classifies the throw through its job-level catch', async () => {
    const id = registerStub();
    (globalThis as Record<string, unknown>).__endpoint_missing_phase1_error = new AnalyzerEndpointMissingError('gone', 'settings');
    const origCovRetries = process.env.STAGE2_COVERAGE_RETRIES;
    process.env.STAGE2_COVERAGE_RETRIES = '0';
    const events: Array<Record<string, unknown>> = [];
    const job: AnalysisJob = {
      controller: new AbortController(),
      subscribers: new Set(),
      manuscriptId: id,
      kind: 'main',
      bookDir: null,
      engine: 'gemini',
      replay: { logs: [], lastPhase: null, lastEta: null, lastCastUpdate: null, failedByChapterId: new Map(), lastSeriesPrior: null, warnings: new Map() },
      lastDiskWriteAt: 0,
    };
    const keepAlive = setInterval(() => {}, 100_000);
    clearInterval(keepAlive);
    job.subscribers.add({
      send: (payload: unknown) => events.push(payload as Record<string, unknown>),
      res: { end: () => {} } as unknown as import('express').Response,
      keepAlive,
    });
    const phase0: AnalyzerSelection = { analyzer: phase0Analyzer, engine: 'gemini', model: 'gemma-endpoint-missing-test', fallbackModel: null };
    try {
      await runMainAnalyzerJob(job, getManuscript(id) as never, phase0, { requestedFresh: true, allowStage1Shrink: true, requestedModel: undefined });
      expect(events.find((e) => e.kind === 'error')).toMatchObject({ kind: 'error', code: 'analyzer-endpoint-missing' });
    } finally {
      removeManuscript(id);
      await clearAnalysisCache(id);
      process.env.STAGE2_COVERAGE_RETRIES = origCovRetries;
    }
  }, 60_000);
});
