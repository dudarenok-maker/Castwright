/* FallbackAnalyzer — verifies the load-bearing rule from plan 29: Gemini
   fallback fires ONLY when the primary analyzer throws LocalUnreachableError.
   Every other error type (HTTP 500, validation failure, schema mismatch)
   propagates unchanged. The rule prevents silent Gemini quota burn when
   the local stack is reachable but broken — surfacing the error forces
   the operator to fix the root cause. */

import { describe, it, expect, vi } from 'vitest';
import { FallbackAnalyzer } from './index.js';
import { LocalUnreachableError, AnalysisAbortedError } from './ollama.js';
import type { Analyzer, StageCall } from './index.js';
import type {
  Stage1Output,
  Stage1ChapterOutput,
  Stage2ChapterOutput,
  EmotionAnnotationOutput,
  ScriptReviewOutput,
  Stage3ChapterOutput,
} from '../handoff/schemas.js';

const STAGE1_RESULT: Stage1Output = {
  characters: [{ id: 'n', name: 'Narrator', role: 'narrator', color: 'narrator' }],
  chapters: [{ id: 1, title: 'One' }],
};
const STAGE1_CHAPTER_RESULT: Stage1ChapterOutput = {
  characters: [{ id: 'n', name: 'Narrator', role: 'narrator', color: 'narrator' }],
};
const STAGE2_RESULT: Stage2ChapterOutput = {
  sentences: [{ id: 1, chapterId: 1, characterId: 'n', text: 'Once upon a time.' }],
};
const EMOTION_RESULT: EmotionAnnotationOutput = {
  annotations: [{ sentenceId: 1, emotion: 'angry' }],
};
const SCRIPT_REVIEW_RESULT: ScriptReviewOutput = {
  ops: [{ id: 1, op: 'fix_emotion', emotion: 'excited', rationale: 'test' }],
};
const STAGE3_RESULT: Stage3ChapterOutput = {
  annotations: [{ sentenceId: 1, instruct: 'whisper this line' }],
};

function makeAnalyzer(impl: Partial<Analyzer>): Analyzer & {
  runStage1: ReturnType<typeof vi.fn>;
  runStage1Chapter: ReturnType<typeof vi.fn>;
  runStage2Chapter: ReturnType<typeof vi.fn>;
  runEmotionChapter: ReturnType<typeof vi.fn>;
  runScriptReviewChapter: ReturnType<typeof vi.fn>;
  runStage3Chapter: ReturnType<typeof vi.fn>;
} {
  return {
    runStage1: vi.fn(impl.runStage1 ?? (() => Promise.resolve(STAGE1_RESULT))),
    runStage1Chapter: vi.fn(
      impl.runStage1Chapter ?? (() => Promise.resolve(STAGE1_CHAPTER_RESULT)),
    ),
    runStage2Chapter: vi.fn(impl.runStage2Chapter ?? (() => Promise.resolve(STAGE2_RESULT))),
    runEmotionChapter: vi.fn(impl.runEmotionChapter ?? (() => Promise.resolve(EMOTION_RESULT))),
    runScriptReviewChapter: vi.fn(
      impl.runScriptReviewChapter ?? (() => Promise.resolve(SCRIPT_REVIEW_RESULT)),
    ),
    runStage3Chapter: vi.fn(
      impl.runStage3Chapter ?? (() => Promise.resolve(STAGE3_RESULT)),
    ),
  };
}

const CALL: StageCall = {};

describe('FallbackAnalyzer.runStage1Chapter — fallback policy', () => {
  it('routes to the primary when it succeeds; fallback is never invoked', async () => {
    const primary = makeAnalyzer({});
    const fallback = makeAnalyzer({});
    const f = new FallbackAnalyzer(primary, fallback);

    const result = await f.runStage1Chapter('m', 1, '# p', CALL);
    expect(result).toBe(STAGE1_CHAPTER_RESULT);
    expect(primary.runStage1Chapter).toHaveBeenCalledTimes(1);
    expect(fallback.runStage1Chapter).not.toHaveBeenCalled();
  });

  it('falls back to the secondary on LocalUnreachableError', async () => {
    const primary = makeAnalyzer({
      runStage1Chapter: () => Promise.reject(new LocalUnreachableError('daemon down')),
    });
    const fallback = makeAnalyzer({});
    const f = new FallbackAnalyzer(primary, fallback);

    const result = await f.runStage1Chapter('m', 1, '# p', CALL);
    expect(result).toBe(STAGE1_CHAPTER_RESULT);
    expect(primary.runStage1Chapter).toHaveBeenCalledTimes(1);
    expect(fallback.runStage1Chapter).toHaveBeenCalledTimes(1);
  });

  it('does NOT fall back on a plain Error — the error propagates and the secondary is untouched', async () => {
    const primary = makeAnalyzer({
      runStage1Chapter: () => Promise.reject(new Error('validation failed')),
    });
    const fallback = makeAnalyzer({});
    const f = new FallbackAnalyzer(primary, fallback);

    await expect(f.runStage1Chapter('m', 1, '# p', CALL)).rejects.toThrow(/validation failed/);
    expect(fallback.runStage1Chapter).not.toHaveBeenCalled();
  });

  it('does NOT fall back on an HTTP-like Error (e.g. Ollama returned 500) — the daemon was reachable, so fallback is forbidden', async () => {
    const primary = makeAnalyzer({
      runStage1Chapter: () =>
        Promise.reject(
          new Error('Ollama http://localhost:11434 returned 500 Internal Server Error'),
        ),
    });
    const fallback = makeAnalyzer({});
    const f = new FallbackAnalyzer(primary, fallback);

    await expect(f.runStage1Chapter('m', 1, '# p', CALL)).rejects.toThrow(/500/);
    expect(fallback.runStage1Chapter).not.toHaveBeenCalled();
  });
});

/* AnalysisAbortedError must propagate without consulting the fallback.
   An abort means the SSE client went away (or the route deliberately
   tore the run down) — falling back to Gemini would waste paid quota
   on output nobody can receive. */
describe('FallbackAnalyzer — abort policy', () => {
  it('does NOT fall back on AnalysisAbortedError; the abort propagates verbatim', async () => {
    const primary = makeAnalyzer({
      runStage1Chapter: () => Promise.reject(new AnalysisAbortedError('client gone')),
    });
    const fallback = makeAnalyzer({});
    const f = new FallbackAnalyzer(primary, fallback);

    await expect(f.runStage1Chapter('m', 1, '# p', CALL)).rejects.toBeInstanceOf(
      AnalysisAbortedError,
    );
    expect(fallback.runStage1Chapter).not.toHaveBeenCalled();
  });

  it('abort propagation also applies to runStage1 and runStage2Chapter', async () => {
    const primary = makeAnalyzer({
      runStage1: () => Promise.reject(new AnalysisAbortedError('client gone')),
      runStage2Chapter: () => Promise.reject(new AnalysisAbortedError('client gone')),
    });
    const fallback = makeAnalyzer({});
    const f = new FallbackAnalyzer(primary, fallback);

    await expect(f.runStage1('m', '# p', CALL)).rejects.toBeInstanceOf(AnalysisAbortedError);
    await expect(f.runStage2Chapter('m', 1, '# p', CALL)).rejects.toBeInstanceOf(
      AnalysisAbortedError,
    );
    expect(fallback.runStage1).not.toHaveBeenCalled();
    expect(fallback.runStage2Chapter).not.toHaveBeenCalled();
  });
});

describe('FallbackAnalyzer — all three Analyzer methods share the same policy', () => {
  it('runStage1 follows the same fallback rule', async () => {
    const primary = makeAnalyzer({
      runStage1: () => Promise.reject(new LocalUnreachableError('down')),
    });
    const fallback = makeAnalyzer({});
    const f = new FallbackAnalyzer(primary, fallback);
    await f.runStage1('m', '# p', CALL);
    expect(fallback.runStage1).toHaveBeenCalledTimes(1);
  });

  it('runStage2Chapter follows the same fallback rule', async () => {
    const primary = makeAnalyzer({
      runStage2Chapter: () => Promise.reject(new LocalUnreachableError('down')),
    });
    const fallback = makeAnalyzer({});
    const f = new FallbackAnalyzer(primary, fallback);
    await f.runStage2Chapter('m', 1, '# p', CALL);
    expect(fallback.runStage2Chapter).toHaveBeenCalledTimes(1);
  });

  it('runEmotionChapter (fs-33) follows the same fallback rule', async () => {
    const primary = makeAnalyzer({
      runEmotionChapter: () => Promise.reject(new LocalUnreachableError('down')),
    });
    const fallback = makeAnalyzer({});
    const f = new FallbackAnalyzer(primary, fallback);
    const result = await f.runEmotionChapter('m', 1, '# p', CALL);
    expect(result).toBe(EMOTION_RESULT);
    expect(primary.runEmotionChapter).toHaveBeenCalledTimes(1);
    expect(fallback.runEmotionChapter).toHaveBeenCalledTimes(1);
  });

  it('runEmotionChapter does NOT fall back on a plain Error', async () => {
    const primary = makeAnalyzer({
      runEmotionChapter: () => Promise.reject(new Error('validation failed')),
    });
    const fallback = makeAnalyzer({});
    const f = new FallbackAnalyzer(primary, fallback);
    await expect(f.runEmotionChapter('m', 1, '# p', CALL)).rejects.toThrow(/validation failed/);
    expect(fallback.runEmotionChapter).not.toHaveBeenCalled();
  });

  it('runEmotionChapter does NOT fall back on AnalysisAbortedError', async () => {
    const primary = makeAnalyzer({
      runEmotionChapter: () => Promise.reject(new AnalysisAbortedError('client gone')),
    });
    const fallback = makeAnalyzer({});
    const f = new FallbackAnalyzer(primary, fallback);
    await expect(f.runEmotionChapter('m', 1, '# p', CALL)).rejects.toBeInstanceOf(
      AnalysisAbortedError,
    );
    expect(fallback.runEmotionChapter).not.toHaveBeenCalled();
  });

  it('runScriptReviewChapter (fs-58) follows the same fallback rule', async () => {
    const primary = makeAnalyzer({
      runScriptReviewChapter: () => Promise.reject(new LocalUnreachableError('down')),
    });
    const fallback = makeAnalyzer({});
    const f = new FallbackAnalyzer(primary, fallback);
    const result = await f.runScriptReviewChapter('m', 1, '# p', CALL);
    expect(result).toBe(SCRIPT_REVIEW_RESULT);
    expect(primary.runScriptReviewChapter).toHaveBeenCalledTimes(1);
    expect(fallback.runScriptReviewChapter).toHaveBeenCalledTimes(1);
  });

  it('runScriptReviewChapter does NOT fall back on a plain Error', async () => {
    const primary = makeAnalyzer({
      runScriptReviewChapter: () => Promise.reject(new Error('validation failed')),
    });
    const fallback = makeAnalyzer({});
    const f = new FallbackAnalyzer(primary, fallback);
    await expect(f.runScriptReviewChapter('m', 1, '# p', CALL)).rejects.toThrow(
      /validation failed/,
    );
    expect(fallback.runScriptReviewChapter).not.toHaveBeenCalled();
  });

  it('runScriptReviewChapter does NOT fall back on AnalysisAbortedError', async () => {
    const primary = makeAnalyzer({
      runScriptReviewChapter: () => Promise.reject(new AnalysisAbortedError('client gone')),
    });
    const fallback = makeAnalyzer({});
    const f = new FallbackAnalyzer(primary, fallback);
    await expect(f.runScriptReviewChapter('m', 1, '# p', CALL)).rejects.toBeInstanceOf(
      AnalysisAbortedError,
    );
    expect(fallback.runScriptReviewChapter).not.toHaveBeenCalled();
  });

  it('runStage3Chapter (fs-57) follows the same fallback rule', async () => {
    const primary = makeAnalyzer({
      runStage3Chapter: () => Promise.reject(new LocalUnreachableError('down')),
    });
    const fallback = makeAnalyzer({});
    const f = new FallbackAnalyzer(primary, fallback);
    const result = await f.runStage3Chapter('m', 1, '# p', CALL);
    expect(result).toBe(STAGE3_RESULT);
    expect(primary.runStage3Chapter).toHaveBeenCalledTimes(1);
    expect(fallback.runStage3Chapter).toHaveBeenCalledTimes(1);
  });

  it('runStage3Chapter does NOT fall back on a plain Error', async () => {
    const primary = makeAnalyzer({
      runStage3Chapter: () => Promise.reject(new Error('validation failed')),
    });
    const fallback = makeAnalyzer({});
    const f = new FallbackAnalyzer(primary, fallback);
    await expect(f.runStage3Chapter('m', 1, '# p', CALL)).rejects.toThrow(/validation failed/);
    expect(fallback.runStage3Chapter).not.toHaveBeenCalled();
  });

  it('runStage3Chapter does NOT fall back on AnalysisAbortedError', async () => {
    const primary = makeAnalyzer({
      runStage3Chapter: () => Promise.reject(new AnalysisAbortedError('client gone')),
    });
    const fallback = makeAnalyzer({});
    const f = new FallbackAnalyzer(primary, fallback);
    await expect(f.runStage3Chapter('m', 1, '# p', CALL)).rejects.toBeInstanceOf(
      AnalysisAbortedError,
    );
    expect(fallback.runStage3Chapter).not.toHaveBeenCalled();
  });
});
