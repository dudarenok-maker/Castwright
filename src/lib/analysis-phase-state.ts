import type { AnalysisLiveInfo } from './api';

/** Coarse render state of one analysis phase card. */
export type PhaseRenderState = 'pending' | 'active' | 'done' | 'paused' | 'halted';

/** Inputs needed to decide one phase's render state, all keyed by phase id. */
export interface PhaseStateInputs {
  /** Latest per-phase progress in [0,1], as reported by `phase` SSE events. */
  progressByPhase: Record<number, number>;
  /** Latest per-phase live payload (null/absent when the phase isn't ticking). */
  liveByPhase: Record<number, AnalysisLiveInfo | null | undefined>;
  /** Highest phase id seen so far this run (the pipeline frontier). */
  maxPhase: number;
  /** Overall run state, mirroring `AnalysisStreamSnapshot.state` (analysis-slice.ts). */
  runState: 'running' | 'paused' | 'halted';
  /** Whether a run has actually started (explicit click, retry, cold-boot
      rehydrate of a running/paused/halted snapshot, …). When false, the
      frontier rule below yields 'pending' instead of 'active' — otherwise
      phase 0 reads as active on an idle page that was never started, since
      maxPhase defaults to 0 and phase 0 IS the frontier. The other rules
      (completion, live chapters, later-phase advance) are all derived from
      real run data, so they keep winning even when started is false. */
  started: boolean;
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
 *  - the run isn't `running` AND this phase would otherwise read as active
 *    (live chapters present, or it's the frontier) AND the run has started
 *    → the run's own state (`paused`/`halted`) — checked BEFORE the
 *    live-chapters check below, because a paused/halted run can still carry
 *    a stale, sticky live payload from before the pause, and that stale data
 *    must not make the phase look active; checked AFTER the completion check
 *    above, because a genuinely completed phase stays `done` regardless of
 *    the overall run state; gated by `started` because a never-started view
 *    with a stale paused/halted snapshot from a different manuscript must not
 *    render paused/halted — it must render pending (#3169);
 *  - live chapters present  → active (a phase that's streaming work is active,
 *    even when a later phase has also started — pipelining);
 *  - a later phase has advanced past it (and no live remains) → done;
 *  - it IS the frontier (the highest phase reached, incl. the initial phase 0
 *    before any event) AND a run has actually started → active — mirrors the
 *    legacy `activePhaseId === id`;
 *  - otherwise (a phase beyond the frontier, or the frontier before start) →
 *    pending.
 */
export function derivePhaseState(phaseId: number, inputs: PhaseStateInputs): PhaseRenderState {
  const prog = inputs.progressByPhase[phaseId];
  const liveInfo = inputs.liveByPhase[phaseId];
  const hasLive = !!liveInfo && liveInfo.chapters.length > 0;

  if (prog !== undefined && prog >= DONE_THRESHOLD) return 'done';
  if (inputs.started && inputs.runState !== 'running' && (hasLive || phaseId === inputs.maxPhase)) return inputs.runState;
  if (hasLive) return 'active';
  if (phaseId < inputs.maxPhase) return 'done';
  if (phaseId === inputs.maxPhase && inputs.started) return 'active';
  return 'pending';
}
