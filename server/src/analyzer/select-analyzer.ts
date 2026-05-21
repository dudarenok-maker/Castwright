/* Per-phase analyzer selection — plan 88 (pipelined two-model
   analyzer).

   Adds a phase-aware selector on top of the existing `selectAnalyzer`
   from `./index.ts`. When `ANALYZER_PHASE0_MODEL` /
   `ANALYZER_PHASE1_MODEL` are set, the route layer asks for a
   per-phase analyzer instead of one shared analyzer for both phases.
   This lets Gemma drive Phase 0a cast detection while Gemini drives
   Phase 1 attribution in parallel (with a 10-chapter lag).

   Fall-through invariant: when NEITHER env var is set, the selector
   returns today's single-model `selectAnalyzer` result for both
   phases — same instance — so legacy `ANALYZER=local|gemini|manual`
   behaviour is preserved verbatim. This is the regression contract
   the test suite pins. */

import {
  selectAnalyzer,
  type AnalyzerSelection,
  type SelectAnalyzerOptions,
} from './index.js';

export type AnalysisPhase = 'phase0' | 'phase1';

export interface PerPhaseAnalyzerOptions extends SelectAnalyzerOptions {
  /** Which phase the analyzer is being selected for. The selector
      reads `ANALYZER_PHASE0_MODEL` for `'phase0'` and
      `ANALYZER_PHASE1_MODEL` for `'phase1'`. */
  phase: AnalysisPhase;
}

/** True when at least one of the two per-phase env vars is set —
    i.e. the route layer should engage the pipelined watermark seam
    instead of today's sequential phase gate. The route layer also
    short-circuits to sequential when `ANALYZER=manual` regardless of
    these vars (manual cowork loop can't pipeline). */
export function isPerPhaseModelSelectionActive(): boolean {
  return Boolean(process.env.ANALYZER_PHASE0_MODEL || process.env.ANALYZER_PHASE1_MODEL);
}

/** Resolve an analyzer for the given phase. When the per-phase env
    vars are set, returns an analyzer keyed to that phase's model.
    When neither is set, falls through to today's `selectAnalyzer`
    (single-model, both phases share one analyzer). The route layer
    is responsible for caching the result per phase so each phase
    only constructs its analyzer once. */
export function selectAnalyzerForPhase(opts: PerPhaseAnalyzerOptions): AnalyzerSelection {
  /* Per-request model override (`opts.model`) wins over per-phase env
     vars — same precedence as the existing `selectAnalyzer`. The UI
     model-picker dropdown is the most-specific signal we have. */
  if (opts.model) {
    return selectAnalyzer({ model: opts.model });
  }

  const phaseEnvKey = opts.phase === 'phase0' ? 'ANALYZER_PHASE0_MODEL' : 'ANALYZER_PHASE1_MODEL';
  const phaseModel = process.env[phaseEnvKey];

  if (phaseModel && phaseModel.trim().length > 0) {
    /* Delegate the engine inference + Fallback wrapping to the existing
       `selectAnalyzer` — passing the model id is enough; it routes via
       `inferEngineFromModelId` (':' → local, otherwise → Gemini). The
       Gemini-API-key requirement is enforced inside `selectAnalyzer`
       and propagates verbatim. */
    return selectAnalyzer({ model: phaseModel.trim() });
  }

  /* Neither per-phase env var nor a request-level override — fall
     through to today's single-model resolution. The route layer can
     compare the two returned selections to detect "same analyzer for
     both phases" and skip the per-phase plumbing. */
  return selectAnalyzer({});
}
