import { useEffect, useRef, useState, type CSSProperties } from 'react';
import {
  type DesignPhase,
  DESIGN_PHASE_LABELS,
  DESIGN_PHASE_BUDGETS_MS,
  DESIGN_PATH_PHASES,
} from '../lib/design-phase';

const BARS = 12;
/* Real overage: a phase that has run past this multiple of its budget is
   genuinely stuck/contended (not just normally slow). */
const OVERAGE_MULT = 2;

interface Props {
  phase: DesignPhase;
  complete?: boolean;
}

function fmt(ms: number): string {
  const t = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(t / 60)}:${(t % 60).toString().padStart(2, '0')}`;
}

/* Cumulative budget at the START of `phase` and the TOTAL — summed over the
   DESIGN-path phases only (the single-design drawer never mints, so anchoring/
   performing never arrive; counting them would inflate the denominator and the
   ETA — plan review PR-A). The bar self-corrects on each real event (AR8). */
function budgetBounds(phase: DesignPhase): { before: number; total: number } {
  const idx = DESIGN_PATH_PHASES.indexOf(phase);
  let before = 0;
  let total = 0;
  DESIGN_PATH_PHASES.forEach((p, i) => {
    const b = DESIGN_PHASE_BUDGETS_MS[p];
    total += b;
    if (idx >= 0 && i < idx) before += b;
  });
  return { before, total };
}

export function DesignProgress({ phase, complete = false }: Props) {
  const [now, setNow] = useState(0);
  const startRef = useRef(Date.now());
  const phaseStartRef = useRef(Date.now());
  const lastPhaseRef = useRef<DesignPhase>(phase);

  // Reset the in-phase clock whenever the phase advances.
  if (lastPhaseRef.current !== phase) {
    lastPhaseRef.current = phase;
    phaseStartRef.current = Date.now();
  }

  useEffect(() => {
    if (complete) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [complete]);

  const elapsedTotal = now === 0 ? 0 : now - startRef.current;
  const inPhase = now === 0 ? 0 : now - phaseStartRef.current;
  const budget = DESIGN_PHASE_BUDGETS_MS[phase];
  const { before, total } = budgetBounds(phase);

  // Cumulative fill: phases before this one are "done"; within this phase ease
  // toward (but never past) its budget until the next real event arrives.
  const inPhaseFill = Math.min(inPhase, budget * 0.92);
  const pct = complete ? 100 : Math.min(99, ((before + inPhaseFill) / total) * 100);

  const slow = !complete && inPhase > budget * OVERAGE_MULT;
  const remaining = Math.max(0, total - before - inPhase);

  const fillStyle: CSSProperties = complete
    ? { width: '100%', transition: 'width 300ms ease-out', animation: 'none' }
    : slow
      ? { width: `${pct}%`, transition: 'width 700ms ease-out' }
      : { width: `${pct}%`, transition: 'width 700ms ease-out', animation: 'none' };
  const fillClass = `design-fill mt-2${slow ? ' design-fill--indeterminate' : ''}`;

  return (
    <div className="mt-3 rounded-2xl bg-canvas border border-ink/10 p-4">
      <div className="design-wave" data-testid="design-waveform" aria-hidden="true">
        {Array.from({ length: BARS }, (_, i) => (
          <i key={i} />
        ))}
      </div>
      <div className={fillClass} data-testid="design-fill">
        <i style={fillStyle} />
      </div>
      <div className="mt-2 flex items-center justify-between">
        <span className="text-[11px] font-semibold text-purple-deep/70">
          {DESIGN_PHASE_LABELS[phase]}
        </span>
        <span className="text-[11px] text-ink/40 tabular-nums" data-testid="design-elapsed">
          {fmt(elapsedTotal)}
        </span>
      </div>
      <div className="mt-1 text-[11px] text-ink/40" data-testid="design-eta">
        {slow
          ? 'Taking longer than usual — the GPU may be busy with another job.'
          : complete
            ? 'Done'
            : `~${fmt(remaining)} left`}
      </div>
    </div>
  );
}
