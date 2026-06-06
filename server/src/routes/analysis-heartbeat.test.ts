/* The subset (per-chapter Re-analyse) job's heartbeat emitter. The 2026-06-06
   incident: a working re-analyse falsely showed "Stalled" because the subset
   path emitted no heartbeats during a long Gemini call, so the pill's
   lastTickAt aged past the 8s cloud threshold. makeThrottledHeartbeat is what
   the subset stage-1/stage-2 calls now funnel onWaiting + onChunk through. */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { makeThrottledHeartbeat } from './analysis-heartbeat.js';

/* Base clock well past any throttle window so the first emit always fires
   (production Date.now() is a huge epoch; the emitter's lastAt starts at 0). */
const T0 = 1_000_000;

describe('makeThrottledHeartbeat', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('emits a kind:heartbeat payload with phase + chapter on the first call', () => {
    const send = vi.fn();
    const emit = makeThrottledHeartbeat(send, 2000);
    emit(1, 12);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0]).toMatchObject({ kind: 'heartbeat', phaseId: 1, chapterIndex: 12 });
  });

  it('throttles: rapid calls within the window collapse to one event', () => {
    const send = vi.fn();
    const emit = makeThrottledHeartbeat(send, 2000);
    emit(1, 12); // sends
    vi.setSystemTime(T0 + 500);
    emit(1, 12); // within window → dropped
    vi.setSystemTime(T0 + 1999);
    emit(1, 12); // still within → dropped
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('emits again once the throttle window has elapsed', () => {
    const send = vi.fn();
    const emit = makeThrottledHeartbeat(send, 2000);
    emit(0, 5); // sends
    vi.setSystemTime(T0 + 2001);
    emit(0, 5); // past window → sends
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('derives charsPerSec from chunk info but omits it for a bare onWaiting tick', () => {
    const send = vi.fn();
    const emit = makeThrottledHeartbeat(send, 1000);
    emit(1, 7, { receivedBytes: 4000, elapsedMs: 2000, sinceLastChunkMs: 100 }); // 4000 bytes / 2s = 2000/s
    expect(send.mock.calls[0][0]).toMatchObject({ charsPerSec: 2000, receivedBytes: 4000, elapsedMs: 2000 });

    vi.setSystemTime(T0 + 2000);
    emit(1, 7); // bare onWaiting → no rate
    expect(send.mock.calls[1][0].charsPerSec).toBeUndefined();
  });

  it('does not divide by zero when elapsedMs is 0', () => {
    const send = vi.fn();
    const emit = makeThrottledHeartbeat(send, 1000);
    emit(1, 9, { receivedBytes: 100, elapsedMs: 0, sinceLastChunkMs: 0 });
    expect(send.mock.calls[0][0].charsPerSec).toBeUndefined();
  });
});
