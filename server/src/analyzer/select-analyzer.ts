/* Per-phase analyzer selection — plan 88 (pipelined two-model
   analyzer) + plan 88 phase-2, rewired onto the config resolver (#3141
   step 1) so the Advanced Settings saved override — not the retired
   Account-tab `analyzerPhase{0,1}Model` field — is the persisted layer.

   Adds a phase-aware selector on top of the existing `selectAnalyzer`
   from `./index.ts`. When `ANALYZER_PHASE0_MODEL` /
   `ANALYZER_PHASE1_MODEL` resolve to a non-empty model (env or a saved
   Advanced Settings override), the route layer asks for a per-phase
   analyzer instead of one shared analyzer for both phases. This lets
   Gemma drive Phase 0 cast detection while Gemini drives Phase 1
   attribution in parallel (with a 10-chapter lag).

   Precedence chain:
     1. explicit env (`ANALYZER_PHASE{0,1}_MODEL`) — ops wins for triage
     2. per-run `opts.phaseModel` — the analysis request's own
        `phase0Model` / `phase1Model` field, honoured for that run only
        and never persisted (#3141 step 4)
     3. per-request `opts.model` — UI dropdown for a specific run
     4. saved Advanced Settings override (`analyzer.phase{0,1}.model`)
     5. hardcoded default via `selectAnalyzer({})`

   Env wins over `opts.phaseModel` / `opts.model` so an ops override at
   the process boundary can't be silently shadowed by a per-request
   choice. (This inverts the plan-88-phase-1 precedence where
   `opts.model` won; the Advanced Settings surface gives users a saved
   default they can override, while env stays the triage trump card.)

   Fall-through invariant: when NEITHER env nor a saved override is
   set, the selector returns today's single-model `selectAnalyzer`
   result for both phases — same instance — so legacy
   `ANALYZER=local|gemini` behaviour is preserved verbatim. */

import {
  selectAnalyzer,
  type AnalyzerSelection,
  type SelectAnalyzerOptions,
} from './index.js';
import { configValue, resolveKnob } from '../config/resolver.js';
import { getKnob } from '../config/registry.js';

export type AnalysisPhase = 'phase0' | 'phase1';

export interface PerPhaseAnalyzerOptions extends SelectAnalyzerOptions {
  /** Which phase the analyzer is being selected for. The selector
      resolves `analyzer.phase0.model` for `'phase0'` and
      `analyzer.phase1.model` for `'phase1'` (env `ANALYZER_PHASE{0,1}_MODEL`
      wins over a saved Advanced Settings override — see `config/resolver.ts`). */
  phase: AnalysisPhase;
  /** #3141 step 4 — an optional per-run phase model, carried on the analysis
      request itself (`phase0Model` / `phase1Model`) and never written to
      settings. Beats `opts.model` and the saved Advanced Settings override;
      still loses to an explicit env pin. */
  phaseModel?: string;
}

const PHASE_MODEL_KEY: Record<AnalysisPhase, string> = {
  phase0: 'analyzer.phase0.model',
  phase1: 'analyzer.phase1.model',
};

/** True when at least one phase knob resolves to a non-empty model, OR a
    per-run phase pick was made on this request — either engages the
    pipelined watermark seam. When neither does, the route layer runs the
    non-pipelined sequential phase gate.
    `hasPerRunPhasePick` (#3141 step 4) lets a caller with no saved knob and
    no env still count as split mode when the request itself named a
    `phase0Model` / `phase1Model` for this run only. */
export function isPerPhaseModelSelectionActive(hasPerRunPhasePick = false): boolean {
  return (
    hasPerRunPhasePick ||
    configValue<string>(PHASE_MODEL_KEY.phase0).trim().length > 0 ||
    configValue<string>(PHASE_MODEL_KEY.phase1).trim().length > 0
  );
}

export type PhaseModelSource = 'env' | 'run-pick' | 'settings' | 'default';
/** An explicit id always carries one of 3a's `modelSource` values; only the engine default
    has none, so the union lets `selectAnalyzerForPhase` pass `source` straight through. */
export type PhaseModelSelection =
  | { modelId: string; source: 'env' | 'run-pick' | 'settings' }
  | { modelId: null; source: 'default' };

/** The precedence chain of selectAnalyzerForPhase, without constructing an analyzer, so
    pre-run checks (#3084) validate the same model id the run will use and can name where
    it came from. Precedence (highest first, #3141):
      1. explicit env (`ANALYZER_PHASE{0,1}_MODEL`) → 'env'
      2. per-run `opts.phaseModel` (this request's `phase0Model` / `phase1Model`) → 'run-pick'
      3. per-request `opts.model` → 'run-pick'
      4. saved Advanced Settings override (`analyzer.phase{0,1}.model`) → 'settings'
      5. engine default → modelId null */
export function resolvePhaseModelSelection(opts: PerPhaseAnalyzerOptions): PhaseModelSelection {
  const key = PHASE_MODEL_KEY[opts.phase];
  const knob = getKnob(key);
  if (!knob) throw new Error(`unknown config key ${key}`);
  const resolved = resolveKnob(knob);
  const resolvedModel = String(resolved.effective).trim();
  if (resolved.source === 'env' && resolvedModel.length > 0) return { modelId: resolvedModel, source: 'env' };
  if (opts.phaseModel) return { modelId: opts.phaseModel, source: 'run-pick' };
  if (opts.model) return { modelId: opts.model, source: 'run-pick' };
  if (resolved.source === 'override' && resolvedModel.length > 0) return { modelId: resolvedModel, source: 'settings' };
  return { modelId: null, source: 'default' };
}

/** Resolve an analyzer for the given phase — see resolvePhaseModelSelection for the
    precedence. The route layer caches the result per phase. */
export function selectAnalyzerForPhase(opts: PerPhaseAnalyzerOptions): AnalyzerSelection {
  const resolved = resolvePhaseModelSelection(opts);
  /* 3a's `modelSource` must survive this extraction: it is what makes an endpoint named by
     ANALYZER_PHASE{0,1}_MODEL report `source: 'env'` rather than `run-pick`
     (3a Task 3a.2, `each phase source is named: env, run pick, saved phase model`). */
  return resolved.modelId === null
    ? selectAnalyzer({})
    : selectAnalyzer({ model: resolved.modelId, modelSource: resolved.source });
}

/* Plan 88 phase-2 — Phase 1 minimum-lag resolver, rewired onto the
   config resolver (#3141 step 1). Same precedence shape as
   `selectAnalyzerForPhase` minus the per-request override (there is no
   UI knob for a per-request lag value):
     1. explicit env `ANALYZER_PHASE1_MIN_LAG_CHAPTERS`
     2. saved Advanced Settings override (`analyzer.phase1.minLagChapters`)
     3. hardcoded default (10)
   Negative or non-numeric values at any layer fall through to the
   next layer rather than throwing — the route layer can't surface a
   schema error mid-job. */
export const DEFAULT_PHASE1_MIN_LAG_CHAPTERS = 10;

export function resolvePhase1MinLagChapters(): number {
  const value = configValue<number>('analyzer.phase1.minLagChapters');
  if (Number.isFinite(value) && value >= 0) return Math.floor(value);
  return DEFAULT_PHASE1_MIN_LAG_CHAPTERS;
}
