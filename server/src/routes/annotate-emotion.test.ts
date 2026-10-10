/* fs-33 — integration tests for the emotion-only backfill route
   POST /api/books/:bookId/annotate-emotion.

   The analyzer is faked via vi.mock('../analyzer/select-analyzer.js') so no
   real LLM is hit. The route is the contract under test: it streams per-chapter
   `annotation` events with {sentenceId, emotion}, NEVER returns characterId
   (re-attribution is out of scope), guards an unattributed book with a
   `no_attribution` error, and on mid-pass DailyQuotaExhaustedError emits a
   `quota_exhausted` error after the chapters it already streamed. */

import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express, { type Express } from 'express';
import request from 'supertest';
import type { Analyzer } from '../analyzer/index.js';
import type { EmotionAnnotationOutput } from '../handoff/schemas.js';
import { _resetUserSettingsCache, _setUserSettingsCacheForTest, USER_SETTINGS_PATH } from '../workspace/user-settings.js';
import { analyzerEndpointSchema } from '../workspace/analyzer-endpoints.js';
import { isEndpointBusy, _resetEndpointBusyForTest } from '../analyzer/analyzer-concurrency.js';
import * as chapterPacing from '../analyzer/chapter-pacing.js';

const AUTHOR = 'Test Author';
const SERIES = 'Test Series';
const BOOK = 'Test Book';

let workspaceRoot: string;
let app: Express;
let bookId: string;
let manuscriptId: string;

/* The fake analyzer's runEmotionChapter — each test swaps its implementation.
   `engineState` lets a test flip the reported engine to 'local' so the chunker
   derives a finite, num_ctx-bound budget and a large chapter splits. */
const { runEmotion, engineState: emotionEngineState } = vi.hoisted(() => ({
  runEmotion: vi.fn(),
  engineState: { engine: 'gemini' as 'gemini' | 'local', selectError: null as Error | null, model: 'test-model' as string },
}));

const { emotionMarks, emotionReleases } = vi.hoisted(() => ({ emotionMarks: [] as string[][], emotionReleases: { count: 0 } }));

vi.mock('../analyzer/analyzer-concurrency.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../analyzer/analyzer-concurrency.js')>();
  return {
    ...actual,
    markEndpointRunActive: (ids: readonly string[]) => {
      emotionMarks.push([...ids]);
      const release = actual.markEndpointRunActive(ids);
      return () => {
        emotionReleases.count += 1;
        release();
      };
    },
  };
});

vi.mock('../analyzer/select-analyzer.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../analyzer/select-analyzer.js')>();
  const fakeAnalyzer: Analyzer = {
    runStage1: () => Promise.reject(new Error('not used')),
    runStage1Chapter: () => Promise.reject(new Error('not used')),
    runStage2Chapter: () => Promise.reject(new Error('not used')),
    runEmotionChapter: (m, c, p, call) => runEmotion(m, c, p, call),
    runScriptReviewChapter: () => Promise.reject(new Error('not used')),
    runStage3Chapter: () => Promise.reject(new Error('not used')),
    runAttributionEscalation: () => Promise.resolve(null),
  };
  return {
    ...actual,
    selectAnalyzerForPhase: () => {
      if (emotionEngineState.selectError) throw emotionEngineState.selectError;
      return {
        analyzer: fakeAnalyzer,
        engine: emotionEngineState.engine,
        model: emotionEngineState.model,
        fallbackModel: null,
      };
    },
  };
});

function bookDir(): string {
  return join(workspaceRoot, 'books', AUTHOR, SERIES, BOOK);
}

function writeBook(sentences: unknown[] | null, chapters: unknown[] = []): void {
  const dir = bookDir();
  mkdirSync(join(dir, '.audiobook'), { recursive: true });
  writeFileSync(
    join(dir, '.audiobook', 'state.json'),
    JSON.stringify({
      bookId,
      manuscriptId,
      title: BOOK,
      author: AUTHOR,
      series: SERIES,
      seriesPosition: 1,
      isStandalone: true,
      manuscriptFile: 'manuscript.txt',
      castConfirmed: true,
      chapters,
      coverGradient: ['#000', '#fff'],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }),
  );
  writeFileSync(join(dir, 'manuscript.txt'), 'placeholder');
  writeFileSync(join(dir, '.audiobook', 'cast.json'), JSON.stringify({ characters: [] }));
  if (sentences) {
    writeFileSync(
      join(dir, '.audiobook', 'manuscript-edits.json'),
      JSON.stringify({ sentences }),
    );
  }
}

/** Parse an SSE response body into the array of JSON `data:` payloads. */
function parseSse(body: string): Array<Record<string, unknown>> {
  return body
    .split('\n')
    .filter((l) => l.startsWith('data: '))
    .map((l) => JSON.parse(l.slice('data: '.length)));
}

const SENTENCES = [
  { id: 1, chapterId: 1, characterId: 'narrator', text: 'The room was quiet.' },
  { id: 2, chapterId: 1, characterId: 'wren', text: '“Get down!”' },
  { id: 3, chapterId: 2, characterId: 'marlow', text: '“It will be okay,” he whispered.' },
];

beforeAll(async () => {
  workspaceRoot = mkdtempSync(join(tmpdir(), 'audiobook-annotate-emotion-test-'));
  process.env.WORKSPACE_DIR = workspaceRoot;
  /* #2083 — sequential awaits, not Promise.all: a Promise.all of dynamic
     imports here races the async vi.mock factory above (module-under-test can
     receive the real binding instead of the mock). Measured latent for this
     file — 0 failures in 14 runs (#2083's own survey) — not the live
     ~2-in-5 rate, which belongs to voices.test.ts, a different file already
     fixed under #2046. */
  const { annotateEmotionRouter } = await import('./annotate-emotion.js');
  const { makeBookId } = await import('../workspace/paths.js');
  bookId = makeBookId(AUTHOR, SERIES, BOOK);
  manuscriptId = `m_${bookId}`;
  app = express();
  app.use(express.json());
  app.use('/api/books', annotateEmotionRouter);
});

beforeEach(() => {
  runEmotion.mockReset();
  emotionEngineState.engine = 'gemini';
  emotionEngineState.selectError = null;
  delete process.env.ANALYZER_NUM_CTX;
  rmSync(join(workspaceRoot, 'books'), { recursive: true, force: true });
});

afterAll(() => {
  if (workspaceRoot) rmSync(workspaceRoot, { recursive: true, force: true });
  delete process.env.WORKSPACE_DIR;
});

describe('POST /api/books/:bookId/annotate-emotion', () => {
  it('streams per-chapter annotation events with {sentenceId, emotion} and a final result', async () => {
    writeBook(SENTENCES);
    runEmotion.mockImplementation((_m, chapterId): Promise<EmotionAnnotationOutput> => {
      if (chapterId === 1) return Promise.resolve({ annotations: [{ sentenceId: 2, emotion: 'angry' }] });
      return Promise.resolve({ annotations: [{ sentenceId: 3, emotion: 'whisper' }] });
    });

    const res = await request(app).post(`/api/books/${bookId}/annotate-emotion`).send({});
    expect(res.status).toBe(200);
    const events = parseSse(res.text);

    const annotations = events.filter((e) => e.kind === 'annotation');
    expect(annotations).toEqual([
      { kind: 'annotation', chapterId: 1, annotations: [{ sentenceId: 2, emotion: 'angry' }] },
      { kind: 'annotation', chapterId: 2, annotations: [{ sentenceId: 3, emotion: 'whisper' }] },
    ]);

    const result = events.find((e) => e.kind === 'result');
    expect(result).toMatchObject({ done: true, annotatedChapters: 2, totalAnnotations: 2 });
  });

  it('sends the already-attributed sentences (id/characterId/text) and never asks for re-attribution', async () => {
    writeBook(SENTENCES);
    runEmotion.mockResolvedValue({ annotations: [] });

    await request(app).post(`/api/books/${bookId}/annotate-emotion`).send({});

    // Chapter 1 call should carry both ch-1 sentences in the prompt.
    const ch1Call = runEmotion.mock.calls.find((c) => c[1] === 1);
    expect(ch1Call).toBeTruthy();
    const prompt = ch1Call![2] as string;
    expect(prompt).toContain('"sentenceId": 1');
    expect(prompt).toContain('"sentenceId": 2');
    expect(prompt).toContain('"characterId": "wren"');
    // The output contract carries no characterId — re-attribution is impossible.
    const res = await request(app).post(`/api/books/${bookId}/annotate-emotion`).send({});
    for (const e of parseSse(res.text).filter((e) => e.kind === 'annotation')) {
      for (const a of e.annotations as Array<Record<string, unknown>>) {
        expect(a).not.toHaveProperty('characterId');
        expect(a).not.toHaveProperty('text');
      }
    }
  });

  it('emits a no_attribution error when the book has no attributed sentences', async () => {
    writeBook(null); // no manuscript-edits.json, no cache
    const res = await request(app).post(`/api/books/${bookId}/annotate-emotion`).send({});
    const events = parseSse(res.text);
    expect(events.some((e) => e.kind === 'error' && e.code === 'no_attribution')).toBe(true);
    expect(events.some((e) => e.kind === 'result')).toBe(false);
    expect(runEmotion).not.toHaveBeenCalled();
  });

  it('404s for an unknown book', async () => {
    const res = await request(app).post(`/api/books/does-not-exist/annotate-emotion`).send({});
    expect(res.status).toBe(404);
  });

  it('skips chapters the user excluded from narration', async () => {
    writeBook(SENTENCES, [
      { id: 1, title: 'One', slug: 'one' },
      { id: 2, title: 'Two', slug: 'two', excluded: true },
    ]);
    runEmotion.mockImplementation((_m, chapterId): Promise<EmotionAnnotationOutput> =>
      Promise.resolve({
        annotations:
          chapterId === 1
            ? [{ sentenceId: 2, emotion: 'angry' }]
            : [{ sentenceId: 3, emotion: 'sad' }],
      }),
    );

    const res = await request(app).post(`/api/books/${bookId}/annotate-emotion`).send({});
    expect(res.status).toBe(200);

    // The analyzer is only called for the included chapter, never the excluded one.
    const calledChapters = runEmotion.mock.calls.map((c) => c[1]);
    expect(calledChapters).toContain(1);
    expect(calledChapters).not.toContain(2);

    const events = parseSse(res.text);
    expect(events.some((e) => e.kind === 'annotation' && e.chapterId === 1)).toBe(true);
    expect(events.some((e) => e.kind === 'annotation' && e.chapterId === 2)).toBe(false);
  });

  it('on mid-pass daily-quota exhaustion, keeps already-streamed chapters and stops with quota_exhausted', async () => {
    writeBook(SENTENCES);
    const { DailyQuotaExhaustedError } = await import('../analyzer/rate-limit.js');
    runEmotion.mockImplementation((_m, chapterId): Promise<EmotionAnnotationOutput> => {
      if (chapterId === 1) return Promise.resolve({ annotations: [{ sentenceId: 2, emotion: 'angry' }] });
      return Promise.reject(new DailyQuotaExhaustedError('test-model', new Date('2099-01-01')));
    });

    const res = await request(app).post(`/api/books/${bookId}/annotate-emotion`).send({});
    const events = parseSse(res.text);

    // Chapter 1 annotation survived.
    expect(events.some((e) => e.kind === 'annotation' && e.chapterId === 1)).toBe(true);
    // Quota error reported; no success result.
    expect(events.some((e) => e.kind === 'error' && e.code === 'quota_exhausted')).toBe(true);
    expect(events.some((e) => e.kind === 'result')).toBe(false);
  });

  it('a reasoning overflow stops the pass like a daily quota: keeps streamed chapters, one analyzer-reasoning-overflow error, no chapter-failed (#3084 P20)', async () => {
    writeBook(SENTENCES);
    const { AnalyzerReasoningOverflowError } = await import('../analyzer/errors.js');
    runEmotion.mockImplementation((_m, chapterId): Promise<EmotionAnnotationOutput> => {
      if (chapterId === 1) return Promise.resolve({ annotations: [{ sentenceId: 2, emotion: 'angry' }] });
      return Promise.reject(new AnalyzerReasoningOverflowError('gemini', 'gemini-3.6-flash', 8100));
    });

    const res = await request(app).post(`/api/books/${bookId}/annotate-emotion`).send({});
    const events = parseSse(res.text);

    expect(events.some((e) => e.kind === 'annotation' && e.chapterId === 1)).toBe(true);
    const err = events.find((e) => e.kind === 'error');
    expect(err).toMatchObject({ code: 'analyzer-reasoning-overflow', model: 'gemini-3.6-flash' });
    expect(String(err?.remediation)).toContain('Gemini max output tokens');
    expect(events.some((e) => e.kind === 'chapter-failed')).toBe(false);
    expect(events.some((e) => e.kind === 'result')).toBe(false);
  });

  it('a single chapter failure does not abort the rest of the pass', async () => {
    writeBook(SENTENCES);
    runEmotion.mockImplementation((_m, chapterId): Promise<EmotionAnnotationOutput> => {
      if (chapterId === 1) return Promise.reject(new Error('flaky chapter'));
      return Promise.resolve({ annotations: [{ sentenceId: 3, emotion: 'sad' }] });
    });

    const res = await request(app).post(`/api/books/${bookId}/annotate-emotion`).send({});
    const events = parseSse(res.text);
    expect(events.some((e) => e.kind === 'chapter-failed' && e.chapterId === 1)).toBe(true);
    expect(events.some((e) => e.kind === 'annotation' && e.chapterId === 2)).toBe(true);
    expect(events.find((e) => e.kind === 'result')).toMatchObject({ annotatedChapters: 1 });
  });

  it('chunks a large chapter across calls and emits each sentence annotation exactly once', async () => {
    // Force local engine + small num_ctx → chapterChunkBudget derives a finite budget
    // that splits a large chapter into ≥2 chunks (gemini's MAX_SAFE_INTEGER never splits).
    emotionEngineState.engine = 'local';
    process.env.ANALYZER_NUM_CTX = '400'; // → budget Math.max(2000, min(24000, 560)) = 2000

    // ~800-char sentences: 2 per chunk under the 2000-char budget.
    const longText = 'C'.repeat(800);
    const chapterSentences = Array.from({ length: 12 }, (_, i) => ({
      id: 400 + i,
      chapterId: 40,
      characterId: 'narrator',
      text: longText,
    }));
    writeBook(chapterSentences);

    // Each call returns one annotation per sentenceId present in the prompt (core + context),
    // so without ownership filtering an overlapped sentence would be emitted by >1 chunk.
    runEmotion.mockImplementation((_m, _c, prompt: string): Promise<EmotionAnnotationOutput> => {
      const ids = [...prompt.matchAll(/"sentenceId":\s*(\d+)/g)].map((m) => Number(m[1]));
      return Promise.resolve({
        annotations: ids.map((sentenceId) => ({ sentenceId, emotion: 'neutral' as const })),
      });
    });

    const res = await request(app).post(`/api/books/${bookId}/annotate-emotion`).send({});
    expect(res.status).toBe(200);
    const events = parseSse(res.text);

    // The chapter split → analyzer was called more than once.
    expect(runEmotion.mock.calls.length).toBeGreaterThan(1);

    // Zero chapter-failed events (no truncation).
    expect(events.some((e) => e.kind === 'chapter-failed')).toBe(false);

    // Union of emitted sentenceIds == chapter sentence ids, each exactly once.
    const emittedIds = events
      .filter((e) => e.kind === 'annotation')
      .flatMap((e) => (e.annotations as Array<{ sentenceId: number }>).map((a) => a.sentenceId));
    const expectedIds = chapterSentences.map((s) => s.id);
    expect([...emittedIds].sort((a, b) => a - b)).toEqual(expectedIds);
    expect(new Set(emittedIds).size).toBe(emittedIds.length); // no duplicates

    expect(events.some((e) => e.kind === 'result')).toBe(true);
  });

  it('scopes the pass to a single chapter when chapterId is provided', async () => {
    writeBook(SENTENCES);
    runEmotion.mockImplementation((_m, chapterId): Promise<EmotionAnnotationOutput> =>
      Promise.resolve({
        annotations:
          chapterId === 1
            ? [{ sentenceId: 2, emotion: 'angry' }]
            : [{ sentenceId: 3, emotion: 'sad' }],
      }),
    );

    const res = await request(app)
      .post(`/api/books/${bookId}/annotate-emotion`)
      .send({ chapterId: 2 });
    expect(res.status).toBe(200);

    // Only chapter 2 was analyzed.
    expect(runEmotion.mock.calls.map((c) => c[1])).toEqual([2]);

    const events = parseSse(res.text);
    expect(events.some((e) => e.kind === 'annotation' && e.chapterId === 2)).toBe(true);
    expect(events.some((e) => e.kind === 'annotation' && e.chapterId === 1)).toBe(false);
    expect(events.find((e) => e.kind === 'result')).toMatchObject({ annotatedChapters: 1 });
  });

  it('emits no_attribution when the requested chapterId is absent/excluded', async () => {
    writeBook(SENTENCES);
    const res = await request(app)
      .post(`/api/books/${bookId}/annotate-emotion`)
      .send({ chapterId: 999 });
    const events = parseSse(res.text);
    expect(events.some((e) => e.kind === 'error' && e.code === 'no_attribution')).toBe(true);
    expect(runEmotion).not.toHaveBeenCalled();
  });

  it('carries chapterIndex/totalChapters on every phase event, and estRemainingMs only from the 2nd chapter onward', async () => {
    writeBook(SENTENCES); // 2 chapters
    runEmotion.mockImplementation(async (_m, chapterId): Promise<EmotionAnnotationOutput> => {
      await new Promise((r) => setTimeout(r, 20));
      return chapterId === 1
        ? { annotations: [{ sentenceId: 2, emotion: 'angry' }] }
        : { annotations: [{ sentenceId: 3, emotion: 'sad' }] };
    });

    const res = await request(app).post(`/api/books/${bookId}/annotate-emotion`).send({});
    const events = parseSse(res.text);
    const phases = events.filter((e) => e.kind === 'phase' && typeof e.chapterId === 'number');

    expect(phases[0]).toMatchObject({ chapterIndex: 1, totalChapters: 2 });
    expect(phases[0].estRemainingMs).toBeUndefined();
    expect(phases[1]).toMatchObject({ chapterIndex: 2, totalChapters: 2 });
    expect(typeof phases[1].estRemainingMs).toBe('number');
    expect(phases[1].estRemainingMs as number).toBeGreaterThanOrEqual(0);
  });

  it('drops the "— chapter N" suffix from the phase label', async () => {
    writeBook(SENTENCES);
    runEmotion.mockResolvedValue({ annotations: [] });
    const res = await request(app).post(`/api/books/${bookId}/annotate-emotion`).send({});
    const events = parseSse(res.text);
    const phases = events.filter((e) => e.kind === 'phase' && typeof e.chapterId === 'number');
    expect(phases.every((e) => e.label === 'Detecting emotions')).toBe(true);
  });

  it('a failed chapter still contributes its wall-clock duration to the next chapter estimate', async () => {
    writeBook(SENTENCES);
    runEmotion.mockImplementation(async (_m, chapterId): Promise<EmotionAnnotationOutput> => {
      await new Promise((r) => setTimeout(r, 20));
      if (chapterId === 1) throw new Error('flaky chapter');
      return { annotations: [{ sentenceId: 3, emotion: 'sad' }] };
    });
    const res = await request(app).post(`/api/books/${bookId}/annotate-emotion`).send({});
    const events = parseSse(res.text);
    const phases = events.filter((e) => e.kind === 'phase' && typeof e.chapterId === 'number');
    // Chapter 1 failed but still took real time — chapter 2's phase event still gets an estimate.
    expect(typeof phases[1].estRemainingMs).toBe('number');
  });

  it('an endpoint id this build cannot run ends the stream with analyzer-endpoint-missing, before any analyzer call (#3084 P23)', async () => {
    writeBook(SENTENCES);
    const { AnalyzerEndpointMissingError } = await import('../analyzer/errors.js');
    emotionEngineState.selectError = new AnalyzerEndpointMissingError('gone', 'run-pick');
    const res = await request(app).post(`/api/books/${bookId}/annotate-emotion`).send({ model: 'openai:gone::m' });
    expect(res.status).toBe(200);
    expect(parseSse(res.text).find((e) => e.kind === 'error')).toMatchObject({ kind: 'error', code: 'analyzer-endpoint-missing' });
    expect(runEmotion).not.toHaveBeenCalled();
  });

  it('any other selection error ends the stream with its classified code instead of escaping the handler (#3084 P23)', async () => {
    writeBook(SENTENCES);
    emotionEngineState.selectError = new Error('misconfigured engine: missing GEMINI_API_KEY');
    const res = await request(app).post(`/api/books/${bookId}/annotate-emotion`).send({});
    expect(res.status).toBe(200);
    expect(parseSse(res.text).find((e) => e.kind === 'error')).toMatchObject({
      kind: 'error',
      code: 'unknown',
      message: 'misconfigured engine: missing GEMINI_API_KEY',
    });
    expect(runEmotion).not.toHaveBeenCalled();
  });

  it('a key-origin selection error (not an endpoint miss) is sent as a classified auth event on the open stream, never rethrown (#3084 P23)', async () => {
    writeBook(SENTENCES);
    const { AnalyzerKeyOriginError } = await import('../analyzer/errors.js');
    emotionEngineState.selectError = new AnalyzerKeyOriginError('run-pick', 'Run Pick');
    const res = await request(app).post(`/api/books/${bookId}/annotate-emotion`).send({});
    expect(res.status).toBe(200);
    expect(parseSse(res.text).find((e) => e.kind === 'error')).toMatchObject({ kind: 'error', code: 'auth' });
    expect(runEmotion).not.toHaveBeenCalled();
  });

  it('#3084 — refuses a model on a deleted endpoint before the analyzer is called', async () => {
    writeBook(SENTENCES);
    _setUserSettingsCacheForTest({ analyzerEndpoints: [] });
    try {
      const res = await request(app).post(`/api/books/${bookId}/annotate-emotion`).send({ model: 'openai:gone::m' });
      expect(parseSse(res.text)).toContainEqual(expect.objectContaining({ kind: 'error', code: 'analyzer-endpoint-missing' }));
      expect(runEmotion).not.toHaveBeenCalled();
    } finally {
      _resetUserSettingsCache();
    }
  });

  it('#3084 N7 — reads saved settings before the checks, so a saved endpoint passes them on a cold cache (after a restart)', async () => {
    writeBook(SENTENCES);
    writeFileSync(
      USER_SETTINGS_PATH,
      JSON.stringify({
        analyzerEndpoints: [{ id: 'lab', name: 'Lab', baseUrl: 'http://127.0.0.1:8080/v1', gpu: 'any', contextTokens: 32768 }],
      }),
    );
    _resetUserSettingsCache(); // nothing cached, exactly as after a server restart
    try {
      const res = await request(app).post(`/api/books/${bookId}/annotate-emotion`).send({ model: 'openai:lab::m' });
      expect(parseSse(res.text)).not.toContainEqual(expect.objectContaining({ code: 'analyzer-endpoint-missing' }));
      expect(runEmotion).toHaveBeenCalled();
    } finally {
      rmSync(USER_SETTINGS_PATH, { force: true });
      _resetUserSettingsCache();
    }
  });

  it('#3084 P1 — an emotion pass on an endpoint holds it busy for the whole pass, including the gaps between chapter calls, and releases it at the end', async () => {
    writeBook(SENTENCES);
    const lab = analyzerEndpointSchema.parse({ id: 'lab', name: 'Lab', baseUrl: 'http://127.0.0.1:8080/v1', gpu: 'cuda:0', contextTokens: 32768 });
    _setUserSettingsCacheForTest({ analyzerEndpoints: [lab] }); // Task 3c.10's checks must pass
    emotionEngineState.model = 'openai:lab::m';
    emotionMarks.length = 0;
    emotionReleases.count = 0;
    try {
      await request(app).post(`/api/books/${bookId}/annotate-emotion`).send({ model: 'openai:lab::m' });
      expect(emotionMarks).toEqual([['lab']]);
      expect(emotionReleases.count).toBe(1);
      expect(isEndpointBusy('lab')).toBe(false);
    } finally {
      emotionEngineState.model = 'test-model';
      _resetUserSettingsCache();
      _resetEndpointBusyForTest();
    }
  });

  it('#3084 A4 — a throw between selection and the chapter loop does not leak the endpoint mark', async () => {
    writeBook(SENTENCES);
    const lab = analyzerEndpointSchema.parse({ id: 'lab', name: 'Lab', baseUrl: 'http://127.0.0.1:8080/v1', gpu: 'cuda:0', contextTokens: 32768 });
    _setUserSettingsCacheForTest({ analyzerEndpoints: [lab] });
    emotionEngineState.model = 'openai:lab::m';
    /* The window A4 names: buildCharsByChapter runs after selection and before the try. */
    const spy = vi.spyOn(chapterPacing, 'buildCharsByChapter').mockImplementationOnce(() => {
      throw new Error('boom');
    });
    try {
      /* The synchronous throw happens after headers are flushed (SSE), so Express 5 forwards
         it to the default error handler, which destroys the socket — supertest sees that as a
         connection error, not a response. The server-side throw (and the mark leak it would
         cause) has already happened by the time that rejection surfaces, so swallow it here;
         the assertion below is what this case is actually proving. */
      await request(app).post(`/api/books/${bookId}/annotate-emotion`).send({ model: 'openai:lab::m' }).catch(() => {});
      expect(isEndpointBusy('lab')).toBe(false);
    } finally {
      spy.mockRestore();
      emotionEngineState.model = 'test-model';
      _resetUserSettingsCache();
      _resetEndpointBusyForTest();
    }
  });
});
