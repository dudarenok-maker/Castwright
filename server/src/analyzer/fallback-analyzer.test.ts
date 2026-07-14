import { describe, it, expect, vi } from 'vitest';
import { FallbackAnalyzer } from './index.js';
import { LocalUnreachableError } from './ollama.js'; // NOT ./errors — errors.ts only exports AnalyzerTruncatedError

const stubOut = { ops: [] } as any;

describe('FallbackAnalyzer.runScriptReviewChapter onFallback', () => {
  it('fires onFallback once and returns the fallback result when primary is unreachable', async () => {
    const primary = { runScriptReviewChapter: vi.fn().mockRejectedValue(new LocalUnreachableError('down')) } as any;
    const fallback = { runScriptReviewChapter: vi.fn().mockResolvedValue(stubOut) } as any;
    const fa = new FallbackAnalyzer(primary, fallback);
    const onFallback = vi.fn();
    const out = await fa.runScriptReviewChapter('m', 1, 'p', { onFallback } as any);
    expect(out).toBe(stubOut);
    expect(onFallback).toHaveBeenCalledTimes(1);
    expect(onFallback).toHaveBeenCalledWith({ reason: expect.any(String) });
  });

  it('does NOT fire onFallback when primary succeeds', async () => {
    const primary = { runScriptReviewChapter: vi.fn().mockResolvedValue(stubOut) } as any;
    const fallback = { runScriptReviewChapter: vi.fn() } as any;
    const onFallback = vi.fn();
    await new FallbackAnalyzer(primary, fallback).runScriptReviewChapter('m', 1, 'p', { onFallback } as any);
    expect(onFallback).not.toHaveBeenCalled();
  });
});
