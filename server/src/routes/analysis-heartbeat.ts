/* Throttled analyzer heartbeat emitter for the subset (per-chapter Re-analyse)
   job. The subset path previously wired only `onThrottle` on its analyzer
   calls — no `onWaiting` / `onChunk` — so during a 60-90s Gemini phase it
   emitted nothing, the global pill's `activeStream.lastTickAt` aged past the
   8s cloud stall threshold, and a working re-analyse falsely read as "Stalled"
   (the main job emits these; the subset job didn't). This factors the emit +
   throttle into a pure, testable unit: both `onWaiting` (500ms wall-clock from
   gemini.ts) and `onChunk` (real model-output progress) funnel through one
   emitter, throttled to at most one event per `throttleMs`, and the analysis-
   stream middleware bumps `lastTickAt` off each. */

export interface HeartbeatChunkInfo {
  receivedBytes?: number;
  elapsedMs?: number;
  sinceLastChunkMs?: number;
}

/** Returns a stateful, throttled heartbeat emitter. Each call past the throttle
    window broadcasts a `kind: 'heartbeat'` payload via `send`; calls inside the
    window are dropped. `charsPerSec` is derived only when both `receivedBytes`
    and a positive `elapsedMs` are present (an `onWaiting` tick with no chunk
    info still refreshes the pill but carries no rate). */
export function makeThrottledHeartbeat(
  send: (payload: unknown) => void,
  throttleMs: number,
): (phaseId: number, chapterId: number, info?: HeartbeatChunkInfo) => void {
  let lastAt = 0;
  return (phaseId, chapterId, info) => {
    const now = Date.now();
    if (now - lastAt < throttleMs) return;
    lastAt = now;
    send({
      kind: 'heartbeat',
      phaseId,
      chapterIndex: chapterId,
      receivedBytes: info?.receivedBytes,
      charsPerSec:
        info?.receivedBytes && info?.elapsedMs && info.elapsedMs > 0
          ? Math.round((info.receivedBytes * 1000) / info.elapsedMs)
          : undefined,
      elapsedMs: info?.elapsedMs,
      sinceLastChunkMs: info?.sinceLastChunkMs,
    });
  };
}
