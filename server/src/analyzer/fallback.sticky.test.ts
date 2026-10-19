/* #3084 wave 3d review pass 1, finding 1 (owner decision) — the switch to the fallback target is
   STICKY for the FallbackAnalyzer instance (one per job/selection): once a call has fallen back,
   every later call goes straight to the target, even if the primary has since recovered. The job's
   relabel and chunk resize after a switch are only true because of this. */

import { describe, it, expect, vi } from 'vitest';
import { FallbackAnalyzer } from './index.js';
import { LocalUnreachableError } from './ollama.js';
import type { Analyzer, StageCall } from './index.js';

function analyzerOf(tag: string, calls: string[], failFirst = false): Analyzer {
  let n = 0;
  const run = async () => {
    n += 1;
    calls.push(`${tag}:${n}`);
    if (failFirst && n === 1) throw new LocalUnreachableError('blip');
    return {} as never;
  };
  return {
    runStage1: run,
    runStage1Chapter: run,
    runStage2Chapter: run,
    runEmotionChapter: run,
    runScriptReviewChapter: run,
    runStage3Chapter: run,
    runAttributionEscalation: run,
    runNonStoryClassification: run,
  };
}

describe('FallbackAnalyzer — sticky switch', () => {
  it('sends the second call straight to the target although the primary has recovered', async () => {
    const calls: string[] = [];
    const f = new FallbackAnalyzer(analyzerOf('primary', calls, true), analyzerOf('target', calls));
    await f.runStage1Chapter('m', 1, 'p', {});
    await f.runStage1Chapter('m', 2, 'p', {});
    expect(calls).toEqual(['primary:1', 'target:1', 'target:2']);
  });

  it('is shared across every method of the instance, and announces only the first switch', async () => {
    const calls: string[] = [];
    const f = new FallbackAnalyzer(analyzerOf('primary', calls, true), analyzerOf('target', calls));
    const onFallback = vi.fn();
    const call: StageCall = { onFallback };
    await f.runStage2Chapter('m', 1, 'p', call);
    await f.runEmotionChapter('m', 1, 'p', call);
    await f.runScriptReviewChapter('m', 1, 'p', call);
    await f.runStage3Chapter('m', 1, 'p', call);
    await f.runAttributionEscalation('m', 1, 0, 'p', call);
    await f.runNonStoryClassification('m', 1, 'p', call);
    await f.runStage1('m', 'p', call);
    expect(calls.filter((c) => c.startsWith('primary'))).toEqual(['primary:1']);
    expect(onFallback).toHaveBeenCalledTimes(1);
  });

  it('keeps running the input guard on the target for later calls', async () => {
    const calls: string[] = [];
    const guard = vi.fn();
    const f = new FallbackAnalyzer(analyzerOf('primary', calls, true), analyzerOf('target', calls), undefined, guard);
    await f.runStage1Chapter('m', 1, 'p', {});
    await f.runStage1Chapter('m', 2, 'p2', {});
    expect(guard).toHaveBeenCalledTimes(2);
    expect(guard.mock.calls[1][1]).toBe('p2');
  });

  it('does not stick without a fallback (primary stays first)', async () => {
    const calls: string[] = [];
    const f = new FallbackAnalyzer(analyzerOf('primary', calls), analyzerOf('target', calls));
    await f.runStage1Chapter('m', 1, 'p', {});
    await f.runStage1Chapter('m', 2, 'p', {});
    expect(calls).toEqual(['primary:1', 'primary:2']);
  });
});
