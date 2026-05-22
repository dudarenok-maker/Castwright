import { MODEL_OPTIONS } from '../../lib/models';
import { useAppSelector } from '../../store';
import {
  type AccountState,
  selectAnalyzerPhase0Model,
  selectAnalyzerPhase1Model,
  selectAnalyzerPhase1MinLag,
} from '../../store/account-slice';

export type PhaseChipState = 'pending' | 'warming' | 'streaming' | 'done';

interface PhaseModelChipProps {
  phaseId: 0 | 1 | 2;
  state: PhaseChipState;
  /** Override the chip label (used by sticky bar to render "Phase N · model").
      Default is just the model name. */
  prefix?: string;
}

function selectModelForPhase(phaseId: 0 | 1 | 2): (account: AccountState) => string {
  if (phaseId === 0) return selectAnalyzerPhase0Model;
  if (phaseId === 1) return selectAnalyzerPhase1Model;
  // Phase 2 is library-match — no model selection. PhaseCard gates the chip
  // render so this path never paints; returning '' keeps the type happy.
  return () => '';
}

/* Pill displaying the model that owns a phase, with a state-coloured dot.
   Reads from the account slice — same source of truth as the Account-tab
   pickers (plan 88 / PR #118). Phase 2 has no model and is intentionally
   not surfaced. */
export function PhaseModelChip({ phaseId, state, prefix }: PhaseModelChipProps) {
  const modelId = useAppSelector((s) => selectModelForPhase(phaseId)(s.account));
  const minLag = useAppSelector((s) => selectAnalyzerPhase1MinLag(s.account));
  if (phaseId === 2) return null;
  const label = MODEL_OPTIONS.find((m) => m.id === modelId)?.label ?? modelId;

  const meta = (() => {
    if (state === 'streaming') {
      return { tone: 'text-emerald-700 bg-emerald-100/70', dot: 'bg-emerald-500 animate-pulse' };
    }
    if (state === 'warming') {
      return { tone: 'text-ink/50 bg-ink/[0.05]', dot: 'bg-ink/30' };
    }
    if (state === 'done') {
      return { tone: 'text-emerald-700 bg-emerald-100/70', dot: 'bg-emerald-500' };
    }
    return { tone: 'text-ink/50 bg-ink/[0.05]', dot: 'bg-ink/30' };
  })();

  const title =
    state === 'warming' && phaseId === 1 ? `Warms up after chapter ${minLag}` : undefined;

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
      {state === 'warming' && phaseId === 1 && (
        <span className="text-ink/40">· warms up after ch. {minLag}</span>
      )}
    </span>
  );
}
