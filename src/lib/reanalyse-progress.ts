/* Progress mapping for a single-chapter re-analysis (per-chapter Reanalyse /
   un-exclude). The server's coarse phase progress is `0.02 + 0.93·(done/total)`,
   so for ONE chapter it pins at 2% for the whole stage-1 call then jumps — a
   useless indicator (the user watched it sit at "2%"). This maps the two real
   LLM steps onto the bar and fills each from wall-clock so the bar actually
   moves, while staying honest (it's an elapsed-based estimate, not a fake count).

   Model:
     - Phase 0a "Detecting characters"  → band [2%, 40%]
     - Phase 1  "Parsing and attribution" → band [40%, 97%]  (the long call)
     - within a phase, an asymptotic ease on the phase's elapsed LLM-call time
       (1 − e^(−t/τ)) creeps toward the band top but never reaches it until the
       server reports the phase essentially done, at which point it snaps to the
       top. The remaining 97%→100% is the finalize/disk-write, handled by the
       caller clearing the row on completion.

   Monotonic by construction: bands don't overlap and `phaseId` only advances, so
   feeding successive ticks yields a non-decreasing value. Pure — no clock reads;
   the caller passes the heartbeat's per-call elapsed. */

export interface ReanalyseProgressInput {
  /** 0 = character detection (stage 1), 1 = sentence attribution (stage 2). */
  phaseId: 0 | 1;
  /** Server's coarse phase progress (0..1). For a single-chapter subset this is
      ~0.02 mid-phase and ~0.95 at phase completion; used only to snap to the
      band top when the phase finishes. */
  serverProgress: number;
  /** Wall-clock ms since the current phase's LLM call started (the heartbeat's
      `elapsedMs`, which resets per call). 0 before the first heartbeat. */
  phaseElapsedMs: number;
}

/** [start, end] fraction each phase occupies on the bar. */
const BANDS: Record<number, readonly [number, number]> = {
  0: [0.02, 0.4],
  1: [0.4, 0.97],
};
/** Ease time-constant per phase (ms). Attribution is the long call, so it
    creeps more slowly to avoid hitting the ceiling long before it finishes. */
const TAU_MS: Record<number, number> = { 0: 6_000, 1: 22_000 };
/** serverProgress at/above this means the phase is essentially complete. */
const PHASE_DONE = 0.9;
/** Cap the intra-phase ease so a phase never visually completes before the
    server confirms it (otherwise a slow call would look done then stall). */
const EASE_CAP = 0.97;

function ease(elapsedMs: number, tauMs: number): number {
  if (elapsedMs <= 0) return 0;
  return Math.min(EASE_CAP, 1 - Math.exp(-elapsedMs / tauMs));
}

/** Map a re-analysis tick to a 0..1 bar fraction. */
export function computeReanalyseProgress(input: ReanalyseProgressInput): number {
  const [lo, hi] = BANDS[input.phaseId] ?? BANDS[1];
  const fraction =
    input.serverProgress >= PHASE_DONE
      ? 1
      : ease(input.phaseElapsedMs, TAU_MS[input.phaseId] ?? TAU_MS[1]);
  const value = lo + (hi - lo) * fraction;
  return Math.max(0, Math.min(1, value));
}

/** ms → "M:SS" for the live "elapsed" readout. */
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}
