import { MODEL_OPTIONS, buildLocalModelOptions, buildModelOptionGroups } from '../../lib/models';
import { useAppDispatch, useAppSelector } from '../../store';
import {
  fetchAnalyzerModels,
  selectAnalyzerPhase0Model,
  selectAnalyzerPhase1Model,
} from '../../store/account-slice';
import { uiActions, selectPhaseModelPick } from '../../store/ui-slice';

interface PhaseModelSwapProps {
  manuscriptId: string | null | undefined;
  phaseId: 0 | 1;
  /** True while a run is live for this manuscript (connecting or streaming).
      The control renders read-only — still showing the current pick — while
      a run is live, since the pick only ever applies to the *next* run
      started from this view. */
  isRunLive: boolean;
}

/* Inline dropdown for choosing a phase's analyzer model for the NEXT
   analysis run started from this view. Dispatches a per-run pick
   (ui-slice's `analyzerPhasePicks`, keyed by manuscript id) rather than
   writing to UserSettings — the choice never changes the saved account
   default and never affects a run already in flight. */
export function PhaseModelSwap({ manuscriptId, phaseId, isRunLive }: PhaseModelSwapProps) {
  const dispatch = useAppDispatch();
  /* The saved account default, shown when no per-run pick is set for this
     manuscript. */
  const current = useAppSelector((s) =>
    phaseId === 0 ? selectAnalyzerPhase0Model(s.account) : selectAnalyzerPhase1Model(s.account),
  );
  const accountValue = useAppSelector((s) =>
    phaseId === 0 ? s.account.analyzerPhase0Model : s.account.analyzerPhase1Model,
  );
  const pick = useAppSelector((s) => selectPhaseModelPick(s.ui, manuscriptId, phaseId));
  const rawValue = pick ?? accountValue;
  /* A per-run override (explicit pick on the analysis-failed card) collapses
     both phases onto the override server-side, so the saved per-phase model
     is moot for this run. Show the override, disabled, so this dropdown can't
     contradict the phase chip — editing the saved setting is only meaningful
     once the override is cleared via "Reset to default". Defensive read: some
     legacy test harnesses mount without the ui slice. */
  const overrideActive = useAppSelector(
    (s) => (s as { ui?: { selectedModelExplicit?: boolean } }).ui?.selectedModelExplicit === true,
  );
  const overrideModelId = useAppSelector(
    (s) => (s as { ui?: { selectedModel?: string } }).ui?.selectedModel ?? '',
  );

  /* Dynamic curated ∪ live-Ollama-tag union so a pulled-but-uncurated tag is
     selectable here. localAnalyzerModels is seeded by fetchAnalyzerModels
     (analysing-view failure card / Model Manager / upload) and refreshed lazily
     when THIS picker is opened (onFocus below). The lazy refresh keeps a healthy
     run from auto-probing Ollama — the probe fires only on an explicit user
     interaction (opening the dropdown), so the cloud-run no-probe invariant
     holds while a just-pulled model still becomes selectable without a reload.
     Empty (not yet fetched / offline) falls back to the curated catalog. */
  const localAnalyzerModels = useAppSelector((s) => s.account.localAnalyzerModels);
  const modelGroups = buildModelOptionGroups(buildLocalModelOptions(localAnalyzerModels));

  const disabled = isRunLive || !manuscriptId;

  const onChange = (raw: string) => {
    if (disabled || !manuscriptId) return;
    const next = raw === '' ? null : raw;
    /* No-op if the user picked the sentinel and there's already no pick, or
       re-picked the same value. */
    if (next === rawValue) return;
    dispatch(uiActions.setPhaseModelPick({ manuscriptId, phaseId, modelId: next }));
  };

  if (overrideActive) {
    const overrideLabel =
      MODEL_OPTIONS.find((m) => m.id === overrideModelId)?.label ?? overrideModelId ?? 'override';
    return (
      <span className="inline-flex items-center gap-2">
        <select
          value="__override__"
          disabled
          data-testid={`phase-model-swap-${phaseId}`}
          title="Per-run override active — reset it to default to edit the per-phase model."
          className="px-2.5 py-1 rounded-full border border-ink/10 bg-ink/5 text-[11px] font-medium text-ink/50 cursor-not-allowed"
          aria-label={`Phase ${phaseId} model (per-run override active)`}
          onChange={() => {}}
        >
          <option value="__override__">{overrideLabel}</option>
        </select>
      </span>
    );
  }

  return (
    <span className="inline-flex items-center gap-2">
      <select
        value={rawValue ?? ''}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        onFocus={() => void dispatch(fetchAnalyzerModels())}
        data-testid={`phase-model-swap-${phaseId}`}
        title={
          disabled
            ? 'A run is in progress — pick a model for the next run started from this view.'
            : `Choose the Phase ${phaseId} model for the next run started from this view. Does not change your saved settings.`
        }
        className={`px-2.5 py-1 rounded-full border text-[11px] font-medium focus:outline-hidden focus:ring-2 focus:ring-magenta/30 ${
          disabled
            ? 'border-ink/10 bg-ink/5 text-ink/50 cursor-not-allowed'
            : 'border-ink/15 bg-white text-ink'
        }`}
        aria-label={`Phase ${phaseId} model for the next run`}
      >
        <option value="">(use saved default)</option>
        {modelGroups.map((g) => (
          <optgroup key={g.engine} label={g.label}>
            {g.models.map((m) => (
              <option key={m.id} value={m.id} title={m.hint}>
                {m.label}
              </option>
            ))}
          </optgroup>
        ))}
      </select>
      {/* Suppress unused-var warning for `current` — kept as documentation
          that the slice's effective value is read; the <select> shows the
          raw user-setting (with the "(use saved default)" sentinel
          mapped to ""). */}
      <span aria-hidden="true" data-current-effective={current} className="hidden" />
    </span>
  );
}
