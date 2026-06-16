import { useEffect, useState } from 'react';
import { MODEL_OPTIONS, buildLocalModelOptions, buildModelOptionGroups } from '../../lib/models';
import { useAppDispatch, useAppSelector } from '../../store';
import {
  saveAccountSettings,
  selectAnalyzerPhase0Model,
  selectAnalyzerPhase1Model,
} from '../../store/account-slice';

interface PhaseModelSwapProps {
  phaseId: 0 | 1;
  /** True when the phase is currently mid-stream. Mid-run swap is allowed
      but the toast surfaces that it only takes effect on the next chapter
      per the warm-up-window memory. */
  isActive: boolean;
}

const TOAST_MS = 4000;

/* Inline dropdown for swapping a phase's analyzer model from the analysing
   view, without round-tripping through the Account tab. Writes to the same
   UserSettings keys (`analyzerPhase{0,1}Model`) the Account picker uses —
   the change is persisted server-side via PUT /api/user/settings and
   takes effect from the next chapter forward, never mid-chapter. */
export function PhaseModelSwap({ phaseId, isActive }: PhaseModelSwapProps) {
  const dispatch = useAppDispatch();
  const current = useAppSelector((s) =>
    phaseId === 0 ? selectAnalyzerPhase0Model(s.account) : selectAnalyzerPhase1Model(s.account),
  );
  const rawValue = useAppSelector((s) =>
    phaseId === 0 ? s.account.analyzerPhase0Model : s.account.analyzerPhase1Model,
  );
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
  const [toast, setToast] = useState<string | null>(null);

  /* Dynamic curated ∪ live-Ollama-tag union so a pulled-but-uncurated tag is
     selectable here. localAnalyzerModels is populated by fetchAnalyzerModels
     dispatched from the analysing-view failure card / Model Manager — this
     picker renders inside every phase card (cloud runs included), so it must
     NOT itself probe Ollama (that would break the cloud-run no-probe invariant).
     Empty (not yet fetched / offline) falls back to the curated catalog. */
  const localAnalyzerModels = useAppSelector((s) => s.account.localAnalyzerModels);
  const modelGroups = buildModelOptionGroups(buildLocalModelOptions(localAnalyzerModels));

  useEffect(() => {
    if (!toast) return;
    const id = setTimeout(() => setToast(null), TOAST_MS);
    return () => clearTimeout(id);
  }, [toast]);

  const onChange = (raw: string) => {
    const next = raw === '' ? null : raw;
    /* No-op if the user picked the sentinel and the slice is already null,
       or the same id. Avoids a spurious save + toast. */
    if (next === rawValue) return;
    const patch =
      phaseId === 0 ? { analyzerPhase0Model: next } : { analyzerPhase1Model: next };
    void dispatch(saveAccountSettings(patch));
    setToast(
      isActive
        ? 'Applies from the next chapter — current chapter finishes on the previous model'
        : 'Applies from next chapter',
    );
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
        onChange={(e) => onChange(e.target.value)}
        data-testid={`phase-model-swap-${phaseId}`}
        title={`Swap the Phase ${phaseId} model. Applies from the next chapter; the in-flight chapter completes on the current model.`}
        className="px-2.5 py-1 rounded-full border border-ink/15 bg-white text-[11px] font-medium text-ink focus:outline-hidden focus:ring-2 focus:ring-magenta/30"
        aria-label={`Phase ${phaseId} model swap`}
      >
        <option value="">(use server default)</option>
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
      {toast && (
        <span
          className="text-[11px] text-emerald-700 font-medium"
          role="status"
          data-testid={`phase-model-swap-${phaseId}-toast`}
        >
          {toast}
        </span>
      )}
      {/* Suppress unused-var warning for `current` — kept as documentation
          that the slice's effective value is read; the <select> shows the
          raw user-setting (with the "(use server default)" sentinel
          mapped to ""). */}
      <span aria-hidden="true" data-current-effective={current} className="hidden" />
    </span>
  );
}
