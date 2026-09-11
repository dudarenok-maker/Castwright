/* D2 (#3169) — a Start click that reaches the server must always print an
   `[analysis]`-prefixed log line, even when everything before the job's
   first milestone (the language pre-flight, getOrHydrateManuscript,
   readUserSettings, readAnalysisLastOutcome, job setup) stalls or the
   client never named a `model`.

   F2 (#3169 final-review fix wave) — renamed from
   analysis.start-requested-log.test.ts. The original "start requested" line
   fired on EVERY POST reaching the handler, including the frontend stream
   middleware's own body-less subscribe POST (sent on the first tick of
   every run, and on every reload/rejoin) — so one Start click logged it
   twice, and the second copy named the saved/default model even when the
   running job used an explicitly picked one. The route now logs two kinds
   of line instead of one:

   (a) an unconditional `[analysis] request received …` line for EVERY POST,
       before hydration (renamed from "start requested" — same per-POST
       shape, just no longer implying "one per click").
   (b) exactly ONE outcome line once the route has decided between the
       new-job and subscribe/attach paths: `[analysis] start …` (naming the
       resolved engine/model) for a new job, or `[analysis] subscribe …`
       (no model — the job doesn't store the one it's running) for an
       attach to an already-live job.

   Same pair, `[analysis-subset]`-prefixed, for the chapter-subset route. */

import { describe, it, expect, vi } from 'vitest';
import http from 'node:http';
import type { Analyzer, AnalyzerSelection, StageCall } from '../analyzer/index.js';
import type { Stage1ChapterOutput, Stage1Output, Stage2ChapterOutput } from '../handoff/schemas.js';
import type { ChapterHint } from '../store/manuscripts.js';
import { putManuscript, removeManuscript } from '../store/manuscripts.js';
import { clearAnalysisCache } from '../store/analysis-cache.js';

/* M2 (#3169 gate1 P1 🟡2) — tests (a) and (c) below claim the `request
   received` line prints before hydration, but asserting only that the line
   exists (plus that no `start` line exists for an unregistered id) doesn't
   prove that ordering: moving the log call to just after
   getOrHydrateManuscript would still pass both, since the unknown-manuscript
   early-out happens right after that call either way. This records, at the
   exact moment getOrHydrateManuscript is invoked, whether the target
   request-received line has already reached the console.log spy — mirroring
   analysis.snapshot-detach.test.ts's `vi.mock('../store/manuscripts.js', …)`
   idiom, but instrumenting rather than rejecting, and delegating to the real
   implementation so every other test in this file (and putManuscript/
   removeManuscript, re-exported unchanged via `...actual`) is unaffected. */
const hydrationCallSawRequestReceived = new Map<string, boolean>();
let requestReceivedProbe: ((manuscriptId: string) => boolean) | null = null;

vi.mock('../store/manuscripts.js', async () => {
  const actual = await vi.importActual<typeof import('../store/manuscripts.js')>('../store/manuscripts.js');
  return {
    ...actual,
    getOrHydrateManuscript: async (id: string) => {
      if (requestReceivedProbe) hydrationCallSawRequestReceived.set(id, requestReceivedProbe(id));
      return actual.getOrHydrateManuscript(id);
    },
  };
});

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

/* Builds a bare AnalysisJob shape for __testRegisterJobForTest — same
   pattern as the "#3004 rejoin route" test further down in
   analysis.test.ts. `controller` is a live (non-aborted) AbortController,
   so the route's subscribe-vs-start dispatch treats it as an in-flight job
   to attach to rather than a stale entry to displace. */
function buildLiveJobStub(manuscriptId: string, kind: 'main' | 'subset', subsetChapterIds?: number[]) {
  return {
    controller: new AbortController(),
    subscribers: new Set(),
    manuscriptId,
    kind,
    /* #3202 — the route now compares this request's chapterIds against the
       running job's subsetChapterIds before joining, so a subset stub used
       to exercise the subscribe path needs a real value here matching
       whatever chapterIds the test POSTs (test (e) sends [1]). */
    ...(kind === 'subset' ? { subsetChapterIds: subsetChapterIds ?? [1] } : {}),
    bookDir: null,
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
  };
}

/* The subscribe/attach branch never calls res.end() (sticky semantics — the
   response stays open for the lifetime of the job), so supertest's
   promise-based API would hang forever waiting for the response to finish.
   Drive a raw request instead and destroy the socket once the specific
   outcome line we're asserting on has actually been logged — NOT on the
   first response chunk. res.flushHeaders() / res.write(':ok\n\n') (~3272
   main, ~6497 subset) both run BEFORE the awaited getOrHydrateManuscript /
   readUserSettings calls that precede the `subscribe`/`start` outcome line
   (~3374 main, ~6599 subset), so the first chunk can win that race and
   arrive before the outcome line has printed — only the earlier `request
   received` line is guaranteed to have fired by then. Hooking the spy's own
   implementation removes the race: we resolve exactly when the matching
   console.log call happens, never earlier. If the expected line never
   prints, this deliberately does not resolve — the caller's test then fails
   on vitest's own test timeout rather than hanging forever, and the request
   is left to be cleaned up when the process tears down. */
function postAndWaitForLogLine(
  app: import('express').Express,
  path: string,
  body: unknown,
  consoleLogSpy: ReturnType<typeof vi.spyOn>,
  matchesTargetLine: (line: string) => boolean,
): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const state: {
      settled: boolean;
      req: http.ClientRequest | undefined;
      server: ReturnType<typeof app.listen> | undefined;
    } = { settled: false, req: undefined, server: undefined };

    const finish = () => {
      if (state.settled) return;
      state.settled = true;
      state.req?.destroy();
      state.server?.close();
      resolvePromise();
    };

    consoleLogSpy.mockImplementation((line: unknown) => {
      if (typeof line === 'string' && matchesTargetLine(line)) finish();
    });

    state.server = app.listen(0, () => {
      const port = (state.server!.address() as { port: number }).port;
      state.req = http.request(
        {
          host: '127.0.0.1',
          port,
          path,
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
        },
        (res) => {
          res.on('error', () => {
            /* expected once we destroy() the socket mid-stream */
          });
        },
      );
      state.req.on('error', () => {
        /* expected once we destroy() the socket mid-stream, or (if the
           target line never prints) once the test's own timeout tears the
           process down first */
      });
      state.req.end(JSON.stringify(body));
    });
    state.server.on('error', reject);
  });
}

describe('D2/F2 (#3169) — every POST that reaches the server logs under [analysis]', () => {
  it('(a) an unregistered manuscript id still gets the unconditional "request received" line, printed before hydration', async () => {
    const express = (await import('express')).default;
    const supertest = (await import('supertest')).default;
    const { analysisRouter } = await import('./analysis.js');
    const app = express();
    app.use(express.json());
    app.use('/api/manuscripts', analysisRouter);

    const manuscriptId = `test-request-received-unknown-${Date.now()}-${Math.random()}`;
    const consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    requestReceivedProbe = (id) =>
      consoleLogSpy.mock.calls.some(
        (call) =>
          typeof call[0] === 'string' &&
          call[0].startsWith('[analysis] request received') &&
          call[0].includes(`manuscript=${JSON.stringify(id)}`),
      );
    try {
      const res = await supertest(app)
        .post(`/api/manuscripts/${manuscriptId}/analysis`)
        .send({})
        .buffer(true);
      expect(res.status).toBe(200);
      expect(res.text).toContain('unknown_manuscript');

      const requestReceivedLine = consoleLogSpy.mock.calls
        .map((call) => call[0])
        .find(
          (line): line is string =>
            typeof line === 'string' && line.startsWith('[analysis] request received'),
        );
      expect(requestReceivedLine, 'expected an unconditional [analysis] request received line').toBeDefined();
      expect(requestReceivedLine).toContain(`manuscript=${JSON.stringify(manuscriptId)}`);
      expect(requestReceivedLine).toContain('model="(saved/default)"');
      expect(requestReceivedLine).toContain('fresh=false');

      /* Direct proof of ordering: recorded by the mocked getOrHydrateManuscript
         itself, at the moment it was invoked — not inferred from the absence
         of a later line. */
      expect(
        hydrationCallSawRequestReceived.get(manuscriptId),
        'request received must already be logged when getOrHydrateManuscript is called',
      ).toBe(true);

      /* The `start` outcome line only fires once a new job is actually
         created — corroborating evidence: for an id that was never
         registered, hydration never succeeds, so this line must be entirely
         absent. */
      const startLine = consoleLogSpy.mock.calls
        .map((call) => call[0])
        .find((line): line is string => typeof line === 'string' && line.startsWith('[analysis] start manuscript='));
      expect(startLine, 'the start outcome line must not print for an unhydrated manuscript').toBeUndefined();
    } finally {
      requestReceivedProbe = null;
      hydrationCallSawRequestReceived.delete(manuscriptId);
      consoleLogSpy.mockRestore();
    }
  });

  it('(b) a new-job POST logs exactly one "start" line naming the resolved engine/model, and no "subscribe" line', async () => {
    const express = (await import('express')).default;
    const supertest = (await import('supertest')).default;
    const { analysisRouter } = await import('./analysis.js');
    const app = express();
    app.use(express.json());
    app.use('/api/manuscripts', analysisRouter);

    const manuscriptId = `test-start-resolved-${Date.now()}-${Math.random()}`;
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

      const requestReceivedLine = consoleLogSpy.mock.calls
        .map((call) => call[0])
        .find(
          (line): line is string =>
            typeof line === 'string' && line.startsWith('[analysis] request received'),
        );
      expect(requestReceivedLine).toBeDefined();
      expect(requestReceivedLine).toContain('model="(saved/default)"');

      const startLines = consoleLogSpy.mock.calls
        .map((call) => call[0])
        .filter(
          (line): line is string =>
            typeof line === 'string' &&
            line.startsWith(`[analysis] start manuscript=${JSON.stringify(manuscriptId)}`),
        );
      expect(startLines, 'exactly one start outcome line').toHaveLength(1);
      expect(startLines[0]).toMatch(/engine=\S+ model=\S+/);

      const subscribeLine = consoleLogSpy.mock.calls
        .map((call) => call[0])
        .find((line): line is string => typeof line === 'string' && line.startsWith('[analysis] subscribe'));
      expect(subscribeLine, 'a new-job POST must not log a subscribe line').toBeUndefined();
    } finally {
      consoleLogSpy.mockRestore();
      removeManuscript(manuscriptId);
      await clearAnalysisCache(manuscriptId);
    }
  }, 30_000);

  it('(c) the subset/chapter-range route also gets an unconditional "request received" line, printed before hydration', async () => {
    const express = (await import('express')).default;
    const supertest = (await import('supertest')).default;
    const { analysisRouter } = await import('./analysis.js');
    const app = express();
    app.use(express.json());
    app.use('/api/manuscripts', analysisRouter);

    const manuscriptId = `test-request-received-subset-unknown-${Date.now()}-${Math.random()}`;
    const consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    requestReceivedProbe = (id) =>
      consoleLogSpy.mock.calls.some(
        (call) =>
          typeof call[0] === 'string' &&
          call[0].startsWith('[analysis-subset] request received') &&
          call[0].includes(`manuscript=${JSON.stringify(id)}`),
      );
    try {
      const res = await supertest(app)
        .post(`/api/manuscripts/${manuscriptId}/analysis/chapters`)
        .send({ chapterIds: [1] })
        .buffer(true);
      expect(res.status).toBe(200);
      expect(res.text).toContain('unknown_manuscript');

      const requestReceivedLine = consoleLogSpy.mock.calls
        .map((call) => call[0])
        .find(
          (line): line is string =>
            typeof line === 'string' && line.startsWith('[analysis-subset] request received'),
        );
      expect(
        requestReceivedLine,
        'expected an unconditional [analysis-subset] request received line',
      ).toBeDefined();
      expect(requestReceivedLine).toContain(`manuscript=${JSON.stringify(manuscriptId)}`);
      expect(requestReceivedLine).toContain('model="(saved/default)"');
      expect(requestReceivedLine).toContain('chapters=1');

      /* Direct proof of ordering — see the analogous check in test (a). */
      expect(
        hydrationCallSawRequestReceived.get(manuscriptId),
        'request received must already be logged when getOrHydrateManuscript is called',
      ).toBe(true);

      const startLine = consoleLogSpy.mock.calls
        .map((call) => call[0])
        .find(
          (line): line is string =>
            typeof line === 'string' && line.startsWith('[analysis-subset] start manuscript='),
        );
      expect(startLine, 'the start outcome line must not print for an unhydrated manuscript').toBeUndefined();
    } finally {
      requestReceivedProbe = null;
      hydrationCallSawRequestReceived.delete(manuscriptId);
      consoleLogSpy.mockRestore();
    }
  });

  it('(d) a subscribe-shaped POST (no body) against a live main job logs request received + subscribe, not start, and never names a model for the attach', async () => {
    const express = (await import('express')).default;
    const { analysisRouter, __testRegisterJobForTest } = await import('./analysis.js');
    const app = express();
    app.use(express.json());
    app.use('/api/manuscripts', analysisRouter);

    const manuscriptId = `test-subscribe-main-${Date.now()}-${Math.random()}`;
    /* getOrHydrateManuscript must resolve for the route to ever reach the
       subscribe-vs-start dispatch at all — an unregistered id short-circuits
       to the unknown_manuscript early-out well before that point. */
    registerStubManuscript(manuscriptId, 1);
    __testRegisterJobForTest(
      buildLiveJobStub(manuscriptId, 'main') as unknown as Parameters<typeof __testRegisterJobForTest>[0],
    );
    const consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await postAndWaitForLogLine(
        app,
        `/api/manuscripts/${manuscriptId}/analysis`,
        {},
        consoleLogSpy,
        (line) => line.startsWith('[analysis] subscribe'),
      );

      const lines = consoleLogSpy.mock.calls
        .map((call) => call[0])
        .filter((line): line is string => typeof line === 'string');

      const requestReceivedLine = lines.find((line) => line.startsWith('[analysis] request received'));
      expect(requestReceivedLine).toBeDefined();

      const subscribeLine = lines.find((line) => line.startsWith('[analysis] subscribe'));
      expect(subscribeLine, 'expected a subscribe outcome line').toBeDefined();
      expect(subscribeLine).toContain(`manuscript=${JSON.stringify(manuscriptId)}`);

      /* Safe to assert absence here: we waited for the subscribe line, and
         the route's subscribe/start dispatch is a mutually-exclusive
         if/return — whichever branch runs, the other's log call can never
         also fire on the same request. So observing `subscribe` already
         rules out `start` having printed or ever printing for this POST. */
      const startLine = lines.find((line) => line.startsWith('[analysis] start manuscript='));
      expect(startLine, 'a subscribe POST must not log a start line').toBeUndefined();

      /* The job doesn't store the model it's running, so the attach must
         never claim one — in particular it must not print the requesting
         POST's own saved/default model, which would be the wrong model
         whenever the already-running job was started with an explicitly
         picked one. Checked across EVERY line the POST logged, not just the
         subscribe line itself — this is what actually catches a regression
         to the pre-fix-wave shape, where a resolved `engine=…/model=…` line
         fired unconditionally right after selection, before the
         subscribe-vs-start dispatch decided anything. */
      expect(subscribeLine).not.toContain('model=');
      const anyResolvedModelLine = lines.find((line) => /engine=\S+ model=/.test(line));
      expect(
        anyResolvedModelLine,
        'no line may resolve/name a model for a subscribe (attach) POST',
      ).toBeUndefined();
    } finally {
      consoleLogSpy.mockRestore();
      removeManuscript(manuscriptId);
      await clearAnalysisCache(manuscriptId);
    }
  });

  it('(e) a subscribe-shaped POST (chapterIds, no model) against a live subset job logs request received + subscribe, not start, and never names a model for the attach', async () => {
    const express = (await import('express')).default;
    const { analysisRouter, __testRegisterJobForTest } = await import('./analysis.js');
    const app = express();
    app.use(express.json());
    app.use('/api/manuscripts', analysisRouter);

    const manuscriptId = `test-subscribe-subset-${Date.now()}-${Math.random()}`;
    /* Same reason as (d) — the subset route also needs a real manuscript
       record (and a real chapter to validate chapterIds against) to reach
       its own subscribe-vs-start dispatch. */
    registerStubManuscript(manuscriptId, 1);
    __testRegisterJobForTest(
      buildLiveJobStub(manuscriptId, 'subset') as unknown as Parameters<typeof __testRegisterJobForTest>[0],
    );
    const consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await postAndWaitForLogLine(
        app,
        `/api/manuscripts/${manuscriptId}/analysis/chapters`,
        { chapterIds: [1] },
        consoleLogSpy,
        (line) => line.startsWith('[analysis-subset] subscribe'),
      );

      const lines = consoleLogSpy.mock.calls
        .map((call) => call[0])
        .filter((line): line is string => typeof line === 'string');

      const requestReceivedLine = lines.find((line) => line.startsWith('[analysis-subset] request received'));
      expect(requestReceivedLine).toBeDefined();

      const subscribeLine = lines.find((line) => line.startsWith('[analysis-subset] subscribe'));
      expect(subscribeLine, 'expected a subscribe outcome line').toBeDefined();
      expect(subscribeLine).toContain(`manuscript=${JSON.stringify(manuscriptId)}`);

      /* Safe to assert absence here — see the analogous comment in test (d):
         subscribe and start sit on a mutually-exclusive if/return, so
         observing `subscribe` already rules out `start` for this POST. */
      const startLine = lines.find((line) => line.startsWith('[analysis-subset] start manuscript='));
      expect(startLine, 'a subscribe POST must not log a start line').toBeUndefined();
      expect(subscribeLine).not.toContain('model=');
      const anyResolvedModelLine = lines.find((line) => /engine=\S+ model=/.test(line));
      expect(
        anyResolvedModelLine,
        'no line may resolve/name a model for a subscribe (attach) POST',
      ).toBeUndefined();
    } finally {
      consoleLogSpy.mockRestore();
      removeManuscript(manuscriptId);
      await clearAnalysisCache(manuscriptId);
    }
  });

  it('(i) #3202 — a chapterId-mismatch POST against a live subset job gets a terminal subset_in_progress error and never joins', async () => {
    const express = (await import('express')).default;
    const supertest = (await import('supertest')).default;
    const { analysisRouter, __testRegisterJobForTest } = await import('./analysis.js');
    const app = express();
    app.use(express.json());
    app.use('/api/manuscripts', analysisRouter);

    const manuscriptId = `test-subset-mismatch-${Date.now()}-${Math.random()}`;
    registerStubManuscript(manuscriptId, 7);
    const job = buildLiveJobStub(manuscriptId, 'subset', [3]);
    __testRegisterJobForTest(job as unknown as Parameters<typeof __testRegisterJobForTest>[0]);
    try {
      const res = await supertest(app)
        .post(`/api/manuscripts/${manuscriptId}/analysis/chapters`)
        .send({ chapterIds: [7] })
        .buffer(true);
      expect(res.status).toBe(200);
      expect(res.text).toContain('subset_in_progress');
      // Names the chapters actually running (by title), not just a generic message.
      expect(res.text).toContain('Chapter 3');
      // The mismatched request never attaches to the running job.
      expect((job as unknown as { subscribers: Set<unknown> }).subscribers.size).toBe(0);
    } finally {
      removeManuscript(manuscriptId);
      await clearAnalysisCache(manuscriptId);
    }
  });

  it('(j) #3202 — a same-chapter-set POST against a live subset job joins, order-independent', async () => {
    const express = (await import('express')).default;
    const { analysisRouter, __testRegisterJobForTest } = await import('./analysis.js');
    const app = express();
    app.use(express.json());
    app.use('/api/manuscripts', analysisRouter);

    const manuscriptId = `test-subset-match-${Date.now()}-${Math.random()}`;
    registerStubManuscript(manuscriptId, 7);
    // Running job's set is [3, 7]; the new POST names the same ids in the
    // opposite order — the comparison must be set-equality, not array
    // equality, so this must still join.
    __testRegisterJobForTest(
      buildLiveJobStub(manuscriptId, 'subset', [3, 7]) as unknown as Parameters<
        typeof __testRegisterJobForTest
      >[0],
    );
    const consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await postAndWaitForLogLine(
        app,
        `/api/manuscripts/${manuscriptId}/analysis/chapters`,
        { chapterIds: [7, 3] },
        consoleLogSpy,
        (line) => line.startsWith('[analysis-subset] subscribe'),
      );

      const lines = consoleLogSpy.mock.calls
        .map((call) => call[0])
        .filter((line): line is string => typeof line === 'string');
      const subscribeLine = lines.find((line) => line.startsWith('[analysis-subset] subscribe'));
      expect(subscribeLine, 'expected a subscribe outcome line — matching sets must join').toBeDefined();
      const errorLine = lines.find((line) => line.includes('subset_in_progress'));
      expect(errorLine, 'a matching chapter set must not get subset_in_progress').toBeUndefined();
    } finally {
      consoleLogSpy.mockRestore();
      removeManuscript(manuscriptId);
      await clearAnalysisCache(manuscriptId);
    }
  });

  it('(f) F6 — a model containing a literal newline cannot forge a second log line', async () => {
    const express = (await import('express')).default;
    const supertest = (await import('supertest')).default;
    const { analysisRouter } = await import('./analysis.js');
    const app = express();
    app.use(express.json());
    app.use('/api/manuscripts', analysisRouter);

    const manuscriptId = `test-log-injection-${Date.now()}-${Math.random()}`;
    const consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const res = await supertest(app)
        .post(`/api/manuscripts/${manuscriptId}/analysis`)
        .send({ model: 'evil\n[analysis] forged' })
        .buffer(true);
      expect(res.status).toBe(200);
      expect(res.text).toContain('unknown_manuscript');

      const lines = consoleLogSpy.mock.calls.map((call) => call[0]);
      // Every console.log call is one line — none contain a raw newline.
      for (const line of lines) {
        if (typeof line === 'string') expect(line).not.toMatch(/\n/);
      }

      const requestReceivedLine = lines.find(
        (line): line is string =>
          typeof line === 'string' && line.startsWith('[analysis] request received'),
      );
      expect(requestReceivedLine).toBeDefined();
      // JSON.stringify escapes the newline to the two-character `\n` — the
      // forged prefix survives only as inert text inside the quoted value,
      // not as the start of a second, fake `[analysis]` line.
      expect(requestReceivedLine).toContain('model="evil\\n[analysis] forged"');
    } finally {
      consoleLogSpy.mockRestore();
    }
  });

  it('(g) a manuscript id containing a literal newline cannot forge a second log line on the main route', async () => {
    const express = (await import('express')).default;
    const supertest = (await import('supertest')).default;
    const { analysisRouter } = await import('./analysis.js');
    const app = express();
    app.use(express.json());
    app.use('/api/manuscripts', analysisRouter);

    // Express decodes %0A in the path into a real newline before req.params.id
    // sees it — this is exactly what makes the id itself an injection vector,
    // not just the request body's `model` field.
    const manuscriptId = `test-id-injection-${Date.now()}-${Math.random()}\n[analysis] start manuscript=forged engine=gemini model="evil"`;
    const consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const res = await supertest(app)
        .post(`/api/manuscripts/${encodeURIComponent(manuscriptId)}/analysis`)
        .send({})
        .buffer(true);
      expect(res.status).toBe(200);

      const lines = consoleLogSpy.mock.calls.map((call) => call[0]);
      // Every console.log call is one line — none contain a raw newline.
      for (const line of lines) {
        if (typeof line === 'string') expect(line).not.toMatch(/\n/);
      }
      // No captured line may start with the forged `[analysis] start` prefix
      // carried inside the id — proof the id was escaped, not concatenated
      // raw into the line ahead of the real content.
      for (const line of lines) {
        if (typeof line === 'string') expect(line).not.toMatch(/^\[analysis\] start manuscript=forged/);
      }

      const requestReceivedLine = lines.find(
        (line): line is string =>
          typeof line === 'string' && line.startsWith('[analysis] request received'),
      );
      expect(requestReceivedLine).toBeDefined();
      expect(requestReceivedLine).toContain(`manuscript=${JSON.stringify(manuscriptId)}`);
    } finally {
      consoleLogSpy.mockRestore();
    }
  });

  it('(h) a manuscript id containing a literal newline cannot forge a second log line on the subset route', async () => {
    const express = (await import('express')).default;
    const supertest = (await import('supertest')).default;
    const { analysisRouter } = await import('./analysis.js');
    const app = express();
    app.use(express.json());
    app.use('/api/manuscripts', analysisRouter);

    const manuscriptId = `test-id-injection-subset-${Date.now()}-${Math.random()}\n[analysis-subset] start manuscript=forged engine=gemini model="evil"`;
    const consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const res = await supertest(app)
        .post(`/api/manuscripts/${encodeURIComponent(manuscriptId)}/analysis/chapters`)
        .send({ chapterIds: [1] })
        .buffer(true);
      expect(res.status).toBe(200);

      const lines = consoleLogSpy.mock.calls.map((call) => call[0]);
      for (const line of lines) {
        if (typeof line === 'string') expect(line).not.toMatch(/\n/);
      }
      for (const line of lines) {
        if (typeof line === 'string') expect(line).not.toMatch(/^\[analysis-subset\] start manuscript=forged/);
      }

      const requestReceivedLine = lines.find(
        (line): line is string =>
          typeof line === 'string' && line.startsWith('[analysis-subset] request received'),
      );
      expect(requestReceivedLine).toBeDefined();
      expect(requestReceivedLine).toContain(`manuscript=${JSON.stringify(manuscriptId)}`);
    } finally {
      consoleLogSpy.mockRestore();
    }
  });
});
