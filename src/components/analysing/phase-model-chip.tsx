import { MODEL_OPTIONS } from '../../lib/models';
import { useAppSelector } from '../../store';
import {
  selectAnalyzerSplitIsActive,
  selectAnalyzerPhase1MinLag,
} from '../../store/account-slice';

export type PhaseChipState = 'pending' | 'warming' | 'streaming' | 'done';

interface PhaseModelChipProps {
  phaseId: 0 | 1 | 2;
  state: PhaseChipState;
  /** Override the chip label (used by sticky bar to render "Phase N · model").
      Default is just the model name. */
  prefix?: string;
  /** Server-resolved model id, carried from the `model` field on SSE phase
      events. When present, PREFERRED over the Redux-derived selection so the
      chip shows what the server actually ran on rather than the UI default.
      Absent pre-stream (no SSE events yet) → existing Redux fallback applies. */
  serverModel?: string;
}

/* Pill displaying the model that ACTUALLY owns a phase, with a state-coloured
   dot. Truthfulness rules (plan 118 — the old chip fabricated a hardcoded
   per-phase default and so claimed "Gemma 4 31B" while the run was really on
   the single default model):
     - Split OFF (no per-phase models saved): both phases run the single
       effective model, so show `ui.selectedModel` (the per-run model, which
       defaults to `defaultAnalysisModel`).
     - Split ON: show the saved per-phase model. If that phase was left blank
       the server falls through to its own default, which the client can't
       see (it depends on server env) — show an honest "Server default" rather
       than guessing.
   Phase 2 (library match) has no model and is intentionally not surfaced. */
export function PhaseModelChip({ phaseId, state, prefix, serverModel }: PhaseModelChipProps) {
  const splitActive = useAppSelector((s) => selectAnalyzerSplitIsActive(s.account));
  const minLag = useAppSelector((s) => selectAnalyzerPhase1MinLag(s.account));
  const phaseModel = useAppSelector((s) =>
    phaseId === 0 ? s.account.analyzerPhase0Model : phaseId === 1 ? s.account.analyzerPhase1Model : null,
  );
  /* The model that a single-model run uses for BOTH phases: the per-run pick
     (ui.selectedModel) which is seeded from, and falls back to, the account
     default. Defensive read mirroring SeriesPriorPill — some test harnesses
     mount the chip without the ui slice; production always has it. */
  const effectiveSingleModel = useAppSelector(
    (s) =>
      (s as { ui?: { selectedModel?: string } }).ui?.selectedModel || s.account.defaultAnalysisModel,
  );
  /* A per-run override (an explicit pick on the analysis-failed card, e.g.
     qwen3.5:4b chosen to dodge a Gemini block) wins over the saved per-phase
     models AND collapses both phases onto the single override — exactly what
     the server does (analysis.ts precedence priority 2: a per-request `model`
     short-circuits the per-phase split). When it's active the chip must show
     that override for both phases, not the now-shadowed saved phase model.
     Mirrors `requestModel` in analysing.tsx. */
  const overrideActive = useAppSelector(
    (s) => (s as { ui?: { selectedModelExplicit?: boolean } }).ui?.selectedModelExplicit === true,
  );
  if (phaseId === 2) return null;

  const useSingle = overrideActive || !splitActive;
  const serverDefault = !useSingle && !phaseModel;
  const modelId = useSingle ? effectiveSingleModel : phaseModel;
  /* Prefer the server-reported model id when one has arrived over SSE —
     it reflects what the server ACTUALLY ran on, overriding the client's
     Redux selection. Falls back to the existing Redux derivation pre-stream
     (when serverModel is undefined). */
  const label = serverModel !== undefined
    ? (MODEL_OPTIONS.find((m) => m.id === serverModel)?.label ?? serverModel)
    : serverDefault
      ? 'Server default'
      : (MODEL_OPTIONS.find((m) => m.id === modelId)?.label ?? modelId ?? 'Server default');

  const meta = (() => {
    if (state === 'streaming') {
      return { tone: 'text-emerald-700 bg-emerald-100/70', dot: 'bg-emerald-500 animate-pulse' };
    }
    if (state === 'warming') {
      return { tone: 'text-ink/50 bg-ink/5', dot: 'bg-ink/30' };
    }
    if (state === 'done') {
      return { tone: 'text-emerald-700 bg-emerald-100/70', dot: 'bg-emerald-500' };
    }
    return { tone: 'text-ink/50 bg-ink/5', dot: 'bg-ink/30' };
  })();

  /* Warm-up only means something when the split is actually engaged — Phase 1
     then dispatches `minLag` chapters behind Phase 0. With the split off,
     Phase 1 simply waits for all of Phase 0, so don't promise a handoff.
     PhaseCard already gates the `warming` state on splitActive; this is a
     belt-and-suspenders guard so the sticky bar can't surface it either. */
  const showWarmup = state === 'warming' && phaseId === 1 && splitActive && !overrideActive;
  const title = showWarmup ? `Warms up after chapter ${minLag}` : undefined;

  return (
    <span
      className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-medium ${meta.tone}`}
      data-testid={`phase-model-chip-${phaseId}`}
      data-phase-state={state}
      title={title}
    >
      <span className={`w-1.5 h-1.5 rounded-full ${meta.dot}`} />
      <span className="tabular-nums">
        {prefix ? `${prefix} · ` : ''}
        {label}
      </span>
      {state === 'streaming' && <span className="text-ink/40">· streaming</span>}
      {showWarmup && <span className="text-ink/40">· warms up after ch. {minLag}</span>}
    </span>
  );
}
