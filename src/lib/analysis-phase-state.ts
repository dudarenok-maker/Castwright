import type { AnalysisLiveInfo } from './api';

/** Coarse render state of one analysis phase card. */
export type PhaseRenderState = 'pending' | 'active' | 'done';

/** Inputs needed to decide one phase's render state, all keyed by phase id. */
export interface PhaseStateInputs {
  /** Latest per-phase progress in [0,1], as reported by `phase` SSE events. */
  progressByPhase: Record<number, number>;
  /** Latest per-phase live payload (null/absent when the phase isn't ticking). */
  liveByPhase: Record<number, AnalysisLiveInfo | null | undefined>;
  /** Highest phase id seen so far this run (the pipeline frontier). */
  maxPhase: number;
}

const DONE_THRESHOLD = 0.999;

/** Decide whether a phase card should read as pending / active / done.
 *
 * The split analyzer pipelines Phase 0 (cast) and Phase 1 (attribution): both
 * emit `phase` SSE events with their own `live` payload in the same window. The
 * analysing view used to collapse these into a single `phase`/`live` state, so
 * the active card and its ticker flip-flopped between the two — the timer
 * "flicker" the user saw. Deriving each card's state independently from
 * per-phase data lets both pipelined phases stay active at once.
 *
 * Rules, in order:
 *  - progress at completion → done (checked FIRST: live payloads are sticky —
 *    we never blank a phase's last live — so a finished phase can still carry
 *    stale live chapters; completion must win or its ticker would never clear);
 *  - live chapters present  → active (a phase that's streaming work is active,
 *    even when a later phase has also started — pipelining);
 *  - a later phase has advanced past it (and no live remains) → done;
 *  - it IS the frontier (the highest phase reached, incl. the initial phase 0
 *    before any event) → active — mirrors the legacy `activePhaseId === id`;
 *  - otherwise (a phase beyond the frontier) → pending.
 */
export function derivePhaseState(phaseId: number, inputs: PhaseStateInputs): PhaseRenderState {
  const prog = inputs.progressByPhase[phaseId];
  const liveInfo = inputs.liveByPhase[phaseId];
  const hasLive = !!liveInfo && liveInfo.chapters.length > 0;

  if (prog !== undefined && prog >= DONE_THRESHOLD) return 'done';
  if (hasLive) return 'active';
  if (phaseId < inputs.maxPhase) return 'done';
  if (phaseId === inputs.maxPhase) return 'active';
  return 'pending';
}
