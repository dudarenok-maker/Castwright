/* fe-32 — scope picker for the single "Design full cast" button. One entry,
   three scopes, each annotated with its live work count so GPU cost is visible
   before starting. A scope with zero work is disabled ("all done"). Closes on
   Escape; the parent handles outside-click. */
import { useEffect, type JSX } from 'react';
import { IconSparkle, IconClose } from '../lib/icons';
import type { CastDesignScope } from '../store/cast-design-slice';

export function DesignScopePicker({
  baseCount,
  variantCount,
  onPick,
  onClose,
}: {
  baseCount: number;
  variantCount: number;
  onPick: (scope: CastDesignScope) => void;
  onClose: () => void;
}): JSX.Element {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const bothCount = baseCount + variantCount;

  function Row({
    scope,
    title,
    desc,
    count,
    unit,
  }: {
    scope: CastDesignScope;
    title: string;
    desc: string;
    count: number;
    unit: string;
  }) {
    return (
      <button
        type="button"
        data-testid={`scope-${scope}`}
        disabled={count === 0}
        onClick={() => onPick(scope)}
        className="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-ink/4 disabled:opacity-40 disabled:cursor-not-allowed border-t border-ink/8 first:border-t-0 min-h-[44px]"
      >
        <span className="flex-1 min-w-0">
          <span className="block text-sm font-bold text-ink">{title}</span>
          <span className="block text-xs text-ink/55">{desc}</span>
        </span>
        <span
          className={`text-xs font-bold px-2.5 py-1 rounded-full shrink-0 ${
            count === 0
              ? 'bg-emerald-500/10 text-emerald-700'
              : 'bg-amber-500/12 text-amber-700'
          }`}
        >
          {count === 0 ? 'all done' : `${count} ${unit}`}
        </span>
      </button>
    );
  }

  return (
    <div
      role="menu"
      aria-label="Choose what to design"
      data-testid="design-scope-picker"
      className="absolute right-0 top-full mt-2 w-80 bg-white rounded-2xl shadow-float border border-ink/10 overflow-hidden z-50 fade-in"
    >
      <div className="flex items-center justify-between px-4 pt-3 pb-1">
        <span className="text-[10px] uppercase tracking-widest text-ink/50 font-semibold">
          What should I design?
        </span>
        <button onClick={onClose} aria-label="Close" className="text-ink/40 hover:text-ink p-1">
          <IconClose className="w-3.5 h-3.5" />
        </button>
      </div>
      <Row
        scope="bases"
        title="Base voices"
        desc="Characters with no designed voice yet"
        count={baseCount}
        unit="needed"
      />
      <Row
        scope="variants"
        title="Emotion variants"
        desc="Tagged emotions missing a variant"
        count={variantCount}
        unit="needed"
      />
      <Row
        scope="both"
        title="Both"
        desc="Bases first, then their needed variants"
        count={bothCount}
        unit="tasks"
      />
      <p className="px-4 py-2.5 text-[11px] text-ink/50 bg-canvas/60 border-t border-ink/8 inline-flex items-center gap-1.5">
        <IconSparkle className="w-3 h-3" /> One at a time on the GPU · safe to close — the pill
        keeps it going
      </p>
    </div>
  );
}
