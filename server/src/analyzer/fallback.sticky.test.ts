/* #3084 wave 3d review pass 1, finding 1 (owner decision) — the switch to the fallback target is
   STICKY for the FallbackAnalyzer instance (one per job/selection): once a call has fallen back,
   every later call goes straight to the target, even if the primary has since recovered. The job's
   relabel and chunk resize after a switch are only true because of this. */

import { describe, it, expect, vi } from 'vitest';
import { FallbackAnalyzer, RunFallbackSwitch, fallbackSwitchKey } from './index.js';
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

/* Review pass 2, finding A (owner decision: sticky for the whole RUN) — a job holds one FallbackAnalyzer per
   phase selection. A switch one of them makes is the run's switch: every other selection routed to the same
   failed primary goes straight to the target, announcing itself once so its own job state relabels. */
describe('FallbackAnalyzer — the switch is shared across a run via RunFallbackSwitch', () => {
  it('sends a second selection of the same primary straight to the target, announcing it once', async () => {
    const calls: string[] = [];
    const sw = new RunFallbackSwitch();
    const phase0 = new FallbackAnalyzer(analyzerOf('p0', calls, true), analyzerOf('t0', calls), undefined, undefined, { switch: sw, key: 'local' });
    const phase1 = new FallbackAnalyzer(analyzerOf('p1', calls), analyzerOf('t1', calls), undefined, undefined, { switch: sw, key: 'local' });
    const onFallback0 = vi.fn();
    const onFallback1 = vi.fn();
    await phase0.runStage1Chapter('m', 1, 'p', { onFallback: onFallback0 });
    await phase1.runStage2Chapter('m', 1, 'p', { onFallback: onFallback1 });
    await phase1.runStage2Chapter('m', 2, 'p', { onFallback: onFallback1 });
    expect(calls).toEqual(['p0:1', 't0:1', 't1:1', 't1:2']);
    expect(onFallback0).toHaveBeenCalledTimes(1);
    expect(onFallback1).toHaveBeenCalledTimes(1);
    expect(onFallback1.mock.calls[0][0].reason).toBe(onFallback0.mock.calls[0][0].reason);
  });

  it('leaves a selection of a different primary alone', async () => {
    const calls: string[] = [];
    const sw = new RunFallbackSwitch();
    const a = new FallbackAnalyzer(analyzerOf('a', calls, true), analyzerOf('ta', calls), undefined, undefined, { switch: sw, key: 'local' });
    const b = new FallbackAnalyzer(analyzerOf('b', calls), analyzerOf('tb', calls), undefined, undefined, { switch: sw, key: 'openai:openai:lab::m' });
    await a.runStage1Chapter('m', 1, 'p', {});
    await b.runStage2Chapter('m', 1, 'p', {});
    expect(calls).toEqual(['a:1', 'ta:1', 'b:1']);
  });

  it('never leaks a switch into a run with its own RunFallbackSwitch', async () => {
    const calls: string[] = [];
    const one = new FallbackAnalyzer(analyzerOf('one', calls, true), analyzerOf('t1', calls), undefined, undefined, { switch: new RunFallbackSwitch(), key: 'local' });
    const two = new FallbackAnalyzer(analyzerOf('two', calls), analyzerOf('t2', calls), undefined, undefined, { switch: new RunFallbackSwitch(), key: 'local' });
    await one.runStage1Chapter('m', 1, 'p', {});
    await two.runStage1Chapter('m', 1, 'p', {});
    expect(calls).toEqual(['one:1', 't1:1', 'two:1']);
  });

  it('keys every local selection together and an endpoint by its model id', () => {
    expect(fallbackSwitchKey({ engine: 'local', model: 'qwen3.5:9b' })).toBe(fallbackSwitchKey({ engine: 'local', model: 'gemma4:e4b' }));
    expect(fallbackSwitchKey({ engine: 'openai', model: 'openai:lab::a' })).not.toBe(fallbackSwitchKey({ engine: 'openai', model: 'openai:lab::b' }));
    expect(fallbackSwitchKey({ engine: 'openai', model: 'openai:lab::a' })).toBe(fallbackSwitchKey({ engine: 'openai', model: 'openai:lab::a' }));
  });
});
