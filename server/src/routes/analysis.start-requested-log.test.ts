/* D2 (#3169) — a Start click that reaches the server must always print an
   `[analysis]`-prefixed log line, even when everything before the job's
   first milestone (the language pre-flight, getOrHydrateManuscript,
   readUserSettings, readAnalysisLastOutcome, job setup) stalls or the
   client never named a `model`. Two route-level behaviours are pinned here:

   (a) an unconditional `[analysis] start requested …` line prints for EVERY
       POST, before hydration — proven by hitting the route with a
       manuscript id that was never registered, so the request never reaches
       `getOrHydrateManuscript`'s success path (nor the resolved-engine log
       further down, which only fires after hydration succeeds).
   (b) the resolved `[analysis] manuscript=… engine=… model=…` line prints
       even when the POST body omits `model` — previously gated behind
       `if (requestedModel)`, so an unnamed-model click logged nothing here. */

import { describe, it, expect, vi } from 'vitest';
import type { Analyzer, AnalyzerSelection, StageCall } from '../analyzer/index.js';
import type { Stage1ChapterOutput, Stage1Output, Stage2ChapterOutput } from '../handoff/schemas.js';
import type { ChapterHint } from '../store/manuscripts.js';
import { putManuscript, removeManuscript } from '../store/manuscripts.js';
import { clearAnalysisCache } from '../store/analysis-cache.js';

/* select-analyzer is mocked so this route-level test never makes a real
   Ollama/Gemini call — the phase-0 analyzer throws immediately (a plain,
   deterministic error, not GeminiContentBlockedError — the specific failure
   shape doesn't matter here, only that D1's fix makes the job end fast so
   the SSE response actually closes and `supertest` doesn't hang). Same
   pattern as analysis.phase-model.test.ts's buildContentBlockedPhase0Analyzer. */
vi.mock('../analyzer/select-analyzer.js', async () => {
  const actual = await vi.importActual<typeof import('../analyzer/select-analyzer.js')>(
    '../analyzer/select-analyzer.js',
  );
  return {
    ...actual,
    selectAnalyzerForPhase: (opts: { phase: 'phase0' | 'phase1'; model?: string }) => {
      const analyzer: Analyzer = {
        async runStage1(): Promise<Stage1Output> {
          throw new Error('runStage1 not used in this suite');
        },
        async runStage1Chapter(): Promise<Stage1ChapterOutput> {
          throw new Error('deliberate fast failure so the route test does not hang on a live SSE stream');
        },
        async runStage2Chapter(
          _manuscriptId: string,
          chapterId: number,
          _prompt: string,
          _call: StageCall,
        ): Promise<Stage2ChapterOutput> {
          return { sentences: [{ id: chapterId * 100 + 1, chapterId, characterId: 'narrator', text: 'x' }] };
        },
        async runEmotionChapter() {
          throw new Error('not used in this suite');
        },
        async runScriptReviewChapter() {
          throw new Error('not used in this suite');
        },
        async runStage3Chapter() {
          throw new Error('not used in this suite');
        },
        async runAttributionEscalation() {
          throw new Error('not used in this suite');
        },
      };
      const sel: AnalyzerSelection = {
        analyzer,
        engine: 'gemini',
        model: opts.model ?? 'stub-default-model',
        fallbackModel: null,
      };
      return sel;
    },
  };
});

function buildStubChapters(count: number): ChapterHint[] {
  return Array.from({ length: count }, (_, i) => ({
    id: i + 1,
    title: `Chapter ${i + 1}`,
    body: `Chapter ${i + 1} body. ` + 'lorem ipsum dolor sit amet '.repeat(20),
  }));
}

function registerStubManuscript(id: string, count: number): void {
  const chapterHints = buildStubChapters(count);
  putManuscript({
    manuscriptId: id,
    format: 'plaintext',
    title: `Stub ${id}`,
    wordCount: chapterHints.length * 100,
    byteSize: 100_000,
    uploadedAt: new Date().toISOString(),
    sourceText: chapterHints.map((c) => c.body).join('\n\n'),
    chapterHints,
  });
}

describe('D2 (#3169) — every Start click that reaches the server logs under [analysis]', () => {
  it('(a) an unregistered manuscript id still gets the unconditional "start requested" line, printed before hydration', async () => {
    const express = (await import('express')).default;
    const supertest = (await import('supertest')).default;
    const { analysisRouter } = await import('./analysis.js');
    const app = express();
    app.use(express.json());
    app.use('/api/manuscripts', analysisRouter);

    const manuscriptId = `test-start-requested-unknown-${Date.now()}-${Math.random()}`;
    const consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const res = await supertest(app)
        .post(`/api/manuscripts/${manuscriptId}/analysis`)
        .send({})
        .buffer(true);
      expect(res.status).toBe(200);
      expect(res.text).toContain('unknown_manuscript');

      const startRequestedLine = consoleLogSpy.mock.calls
        .map((call) => call[0])
        .find(
          (line): line is string =>
            typeof line === 'string' && line.startsWith('[analysis] start requested'),
        );
      expect(startRequestedLine, 'expected an unconditional [analysis] start requested line').toBeDefined();
      expect(startRequestedLine).toContain(`manuscript=${manuscriptId}`);
      expect(startRequestedLine).toContain('model=(saved/default)');
      expect(startRequestedLine).toContain('fresh=false');

      /* The resolved engine/model line only fires after a successful
         getOrHydrateManuscript — proof the start-requested line above is
         logged strictly BEFORE hydration, not merely earlier in the same
         burst: for an id that was never registered, hydration never
         succeeds, so this line must be entirely absent. */
      const resolvedLine = consoleLogSpy.mock.calls
        .map((call) => call[0])
        .find((line): line is string => typeof line === 'string' && line.startsWith(`[analysis] manuscript=${manuscriptId} engine=`));
      expect(resolvedLine, 'the resolved engine/model line must not print for an unhydrated manuscript').toBeUndefined();
    } finally {
      consoleLogSpy.mockRestore();
    }
  });

  it('(b) the resolved engine=…/model=… line prints even when the POST body omits model', async () => {
    const express = (await import('express')).default;
    const supertest = (await import('supertest')).default;
    const { analysisRouter } = await import('./analysis.js');
    const app = express();
    app.use(express.json());
    app.use('/api/manuscripts', analysisRouter);

    const manuscriptId = `test-start-requested-resolved-${Date.now()}-${Math.random()}`;
    registerStubManuscript(manuscriptId, 1);
    const consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      // No `model` field in the body — the per-phase-split-saved / no-
      // explicit-pick case D2's brief names as the previously-silent one.
      const res = await supertest(app)
        .post(`/api/manuscripts/${manuscriptId}/analysis`)
        .send({})
        .buffer(true);
      expect(res.status).toBe(200);

      const startRequestedLine = consoleLogSpy.mock.calls
        .map((call) => call[0])
        .find(
          (line): line is string =>
            typeof line === 'string' && line.startsWith('[analysis] start requested'),
        );
      expect(startRequestedLine).toBeDefined();
      expect(startRequestedLine).toContain('model=(saved/default)');

      const resolvedLine = consoleLogSpy.mock.calls
        .map((call) => call[0])
        .find(
          (line): line is string =>
            typeof line === 'string' &&
            line.startsWith(`[analysis] manuscript=${manuscriptId} engine=`),
        );
      expect(resolvedLine, 'the resolved engine/model line must print unconditionally').toBeDefined();
      expect(resolvedLine).toMatch(/engine=\S+ model=\S+/);
    } finally {
      consoleLogSpy.mockRestore();
      removeManuscript(manuscriptId);
      await clearAnalysisCache(manuscriptId);
    }
  }, 30_000);

  it('(c) the subset/chapter-range route also gets an unconditional "start requested" line, printed before hydration', async () => {
    const express = (await import('express')).default;
    const supertest = (await import('supertest')).default;
    const { analysisRouter } = await import('./analysis.js');
    const app = express();
    app.use(express.json());
    app.use('/api/manuscripts', analysisRouter);

    const manuscriptId = `test-start-requested-subset-unknown-${Date.now()}-${Math.random()}`;
    const consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const res = await supertest(app)
        .post(`/api/manuscripts/${manuscriptId}/analysis/chapters`)
        .send({ chapterIds: [1] })
        .buffer(true);
      expect(res.status).toBe(200);
      expect(res.text).toContain('unknown_manuscript');

      const startRequestedLine = consoleLogSpy.mock.calls
        .map((call) => call[0])
        .find(
          (line): line is string =>
            typeof line === 'string' && line.startsWith('[analysis-subset] start requested'),
        );
      expect(
        startRequestedLine,
        'expected an unconditional [analysis-subset] start requested line',
      ).toBeDefined();
      expect(startRequestedLine).toContain(`manuscript=${manuscriptId}`);
      expect(startRequestedLine).toContain('model=(saved/default)');
    } finally {
      consoleLogSpy.mockRestore();
    }
  });
});
