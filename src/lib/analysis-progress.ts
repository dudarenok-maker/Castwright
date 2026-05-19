/* Shared work-weighted progress math for the analysing flow. The top-bar
   AnalysisPill (src/components/layout.tsx) and the "Overall" bar inside the
   analysing view (src/views/analysing.tsx) BOTH need to show overall
   completion in [0, 1]. They previously diverged — the pill weighted phases
   by real work cost (0.45 / 0.5 / 0.05) while the bar averaged naively
   (phase + phaseProgress) / 3 — yielding 55% vs 40% mismatches for the same
   stream state. This module is now the single source of truth. */

import { ANALYSIS_PHASES } from '../data/analysis-phases';

/** Work-weighted share of each analysis phase. Index aligns with
    `ANALYSIS_PHASES`. Must sum to 1.0. Phase 0 (character detection) and
    phase 1 (parsing + attribution) carry the heavy NLP cost; phase 2
    (library matching) is a quick reconciliation pass. */
export const PHASE_WEIGHTS = [0.45, 0.5, 0.05] as const;

/* Keep PHASE_WEIGHTS aligned with ANALYSIS_PHASES — if a future plan
   adds or removes a phase, this guard catches it at module load instead
   of silently mis-weighting the progress bar. */
if (PHASE_WEIGHTS.length !== ANALYSIS_PHASES.length) {
  throw new Error(
    `PHASE_WEIGHTS length (${PHASE_WEIGHTS.length}) must match ANALYSIS_PHASES length (${ANALYSIS_PHASES.length})`,
  );
}

const TOTAL_WEIGHT = PHASE_WEIGHTS.reduce((a, b) => a + b, 0);
/* Allow ±1e-6 for floating-point drift in the weights. */
if (Math.abs(TOTAL_WEIGHT - 1) > 1e-6) {
  throw new Error(`PHASE_WEIGHTS must sum to 1 (got ${TOTAL_WEIGHT})`);
}

/** Compute weighted overall progress in [0, 1].
 *
 * @param phaseId 0-indexed phase id (clamped to a valid index).
 * @param phaseProgress completion within the phase (clamped to [0, 1]).
 */
export function computeOverallProgress(phaseId: number, phaseProgress: number): number {
  const clampedPhase = Math.max(0, Math.min(PHASE_WEIGHTS.length - 1, Math.floor(phaseId)));
  const clampedProgress = Math.max(0, Math.min(1, phaseProgress));
  const phaseBase = PHASE_WEIGHTS.slice(0, clampedPhase).reduce((sum, w) => sum + w, 0);
  const phaseShare = PHASE_WEIGHTS[clampedPhase] ?? 0;
  return Math.min(1, phaseBase + clampedProgress * phaseShare);
}
