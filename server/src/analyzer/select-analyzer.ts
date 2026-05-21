/* Per-phase analyzer selection — plan 88 (pipelined two-model
   analyzer) + plan 88 phase-2 (Account-tab UI surface).

   Adds a phase-aware selector on top of the existing `selectAnalyzer`
   from `./index.ts`. When `ANALYZER_PHASE0_MODEL` /
   `ANALYZER_PHASE1_MODEL` are set, the route layer asks for a
   per-phase analyzer instead of one shared analyzer for both phases.
   This lets Gemma drive Phase 0a cast detection while Gemini drives
   Phase 1 attribution in parallel (with a 10-chapter lag).

   Precedence chain (plan 88 phase-2):
     1. explicit env (`ANALYZER_PHASE{0,1}_MODEL`) — ops wins for triage
     2. per-request `opts.model` — UI dropdown for a specific run
     3. user-settings JSON `analyzerPhase{0,1}Model` — Account tab
     4. hardcoded default via `selectAnalyzer({})`

   Env wins over `opts.model` so an ops override at the process
   boundary can't be silently shadowed by a per-request choice. (This
   inverts the plan-88-phase-1 precedence where `opts.model` won; the
   Account-tab surface gives users a saved-default they can override,
   while env stays the triage trump card.)

   Fall-through invariant: when NEITHER env var nor user-settings is
   set, the selector returns today's single-model `selectAnalyzer`
   result for both phases — same instance — so legacy
   `ANALYZER=local|gemini|manual` behaviour is preserved verbatim. */

import {
  selectAnalyzer,
  type AnalyzerSelection,
  type SelectAnalyzerOptions,
} from './index.js';
import { getCachedUserSettings, type UserSettings } from '../workspace/user-settings.js';

export type AnalysisPhase = 'phase0' | 'phase1';

export interface PerPhaseAnalyzerOptions extends SelectAnalyzerOptions {
  /** Which phase the analyzer is being selected for. The selector
      reads `ANALYZER_PHASE0_MODEL` for `'phase0'` and
      `ANALYZER_PHASE1_MODEL` for `'phase1'`. */
  phase: AnalysisPhase;
  /** Optional pre-fetched user-settings snapshot used as the
      third-priority fallback (after env + opts.model). When
      undefined, the selector reads from the in-process cache via
      `getCachedUserSettings()`. The route layer should pass the
      snapshot it already read at request-start so the precedence
      reflects the read-once view of the file. */
  userSettings?: UserSettings;
}

/** True when at least one signal — env or user-settings — engages the
    pipelined watermark seam. The route layer also short-circuits to
    sequential when `ANALYZER=manual` regardless of these signals
    (manual cowork loop can't pipeline). */
export function isPerPhaseModelSelectionActive(userSettings?: UserSettings): boolean {
  if (process.env.ANALYZER_PHASE0_MODEL || process.env.ANALYZER_PHASE1_MODEL) return true;
  const s = userSettings ?? getCachedUserSettings();
  if (s.analyzerPhase0Model || s.analyzerPhase1Model) return true;
  return false;
}

/** Resolve an analyzer for the given phase. Precedence (highest first):
      1. explicit env (`ANALYZER_PHASE{0,1}_MODEL`)
      2. per-request `opts.model`
      3. user-settings JSON `analyzerPhase{0,1}Model`
      4. hardcoded default via `selectAnalyzer({})`
    The route layer is responsible for caching the result per phase so
    each phase only constructs its analyzer once. */
export function selectAnalyzerForPhase(opts: PerPhaseAnalyzerOptions): AnalyzerSelection {
  /* Priority 1 — explicit env. Ops needs the override for triage so
     this beats both opts.model and the saved user-settings value. */
  const phaseEnvKey = opts.phase === 'phase0' ? 'ANALYZER_PHASE0_MODEL' : 'ANALYZER_PHASE1_MODEL';
  const phaseEnvModel = process.env[phaseEnvKey];
  if (phaseEnvModel && phaseEnvModel.trim().length > 0) {
    /* Delegate the engine inference + Fallback wrapping to the existing
       `selectAnalyzer` — passing the model id is enough; it routes via
       `inferEngineFromModelId` (':' → local, otherwise → Gemini). */
    return selectAnalyzer({ model: phaseEnvModel.trim() });
  }

  /* Priority 2 — per-request override. UI dropdown for one specific run. */
  if (opts.model) {
    return selectAnalyzer({ model: opts.model });
  }

  /* Priority 3 — saved user-settings. The Account-tab Analyzer card
     writes these; null/empty falls through to the hardcoded default. */
  const settings = opts.userSettings ?? getCachedUserSettings();
  const settingsModelRaw =
    opts.phase === 'phase0' ? settings.analyzerPhase0Model : settings.analyzerPhase1Model;
  const settingsModel = settingsModelRaw?.trim();
  if (settingsModel && settingsModel.length > 0) {
    return selectAnalyzer({ model: settingsModel });
  }

  /* Priority 4 — hardcoded default. Falls through to today's
     single-model resolution. The route layer can compare the two
     returned selections to detect "same analyzer for both phases" and
     skip the per-phase plumbing. */
  return selectAnalyzer({});
}

/* Plan 88 phase-2 — Phase 1 minimum-lag resolver. Same precedence
   shape as `selectAnalyzerForPhase` minus the per-request override
   (there is no UI knob for a per-request lag value):
     1. explicit env `ANALYZER_PHASE1_MIN_LAG_CHAPTERS`
     2. user-settings JSON `analyzerPhase1MinLagChapters`
     3. hardcoded default (10)
   Negative or non-numeric values at any layer fall through to the
   next layer rather than throwing — the route layer can't surface a
   schema error mid-job. */
export const DEFAULT_PHASE1_MIN_LAG_CHAPTERS = 10;

export function resolvePhase1MinLagChapters(userSettings?: UserSettings): number {
  const rawEnv = process.env.ANALYZER_PHASE1_MIN_LAG_CHAPTERS;
  if (rawEnv !== undefined && rawEnv !== null && rawEnv.trim() !== '') {
    const parsed = Number(rawEnv);
    if (Number.isFinite(parsed) && parsed >= 0) return Math.floor(parsed);
  }
  const settings = userSettings ?? getCachedUserSettings();
  const fromSettings = settings.analyzerPhase1MinLagChapters;
  if (
    fromSettings !== undefined &&
    fromSettings !== null &&
    Number.isFinite(fromSettings) &&
    fromSettings >= 0
  ) {
    return Math.floor(fromSettings);
  }
  return DEFAULT_PHASE1_MIN_LAG_CHAPTERS;
}
