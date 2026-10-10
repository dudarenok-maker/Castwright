import { describe, it, expect, vi, afterEach } from 'vitest';
import { nonStoryClassificationFailed } from './analysis.js';
import { AnalysisAbortedError, AnalyzerTargetInputTooLargeError, AnalyzerHttpError } from '../analyzer/errors.js';

afterEach(() => vi.restoreAllMocks());

describe('nonStoryClassificationFailed (#3084 P30)', () => {
  it('keeps the story default for a target-too-large refusal, and warns naming the target and limit', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const err = new AnalyzerTargetInputTooLargeError('ollama', 'qwen3.5:4b', 'Ollama (qwen3.5:4b)', 8192, 'context');
    expect(nonStoryClassificationFailed(err, 'm1', 3)).toBe(false);
    expect(warn).toHaveBeenCalledWith(
      '[analysis] m1: chapter 3 non-story check skipped: prompt is larger than the fallback target Ollama (qwen3.5:4b) can take (context 8192 tokens)',
    );
  });

  it('stays quiet for any other error, and rethrows an abort', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(nonStoryClassificationFailed(new AnalyzerHttpError('openai', 500, 'boom', 'boom'), 'm1', 3)).toBe(false);
    expect(warn).not.toHaveBeenCalled();
    expect(() => nonStoryClassificationFailed(new AnalysisAbortedError('stop'), 'm1', 3)).toThrow(AnalysisAbortedError);
  });
});
