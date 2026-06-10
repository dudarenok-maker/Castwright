/* fe-32 — scope picker for the single "Design full cast" button. One entry,
   three scopes, each annotated with its live work count so GPU cost is visible
   before starting. A scope with zero ACTIONABLE work is disabled ("all done").
   Closes on Escape; the parent handles outside-click.

   "Emotion variants" reports the WHOLE cast's variant demand (matching the
   cast rows' "Needs variants" chip), split into "ready now" (characters that
   already have a base voice) vs "need a base". The variants-only scope can only
   synthesise on top of an existing base, so it's disabled until ≥1 is ready and
   carries a loud warning; the "Both" scope designs the bases first, so its task
   count includes every variant. */
import { useEffect, type JSX } from 'react';
import { IconSparkle, IconClose, IconCheck, IconAlertTri } from '../lib/icons';
import type { CastDesignScope } from '../store/cast-design-slice';

export function DesignScopePicker({
  baseCount,
  variantTotal,
  variantReady,
  variantBlocked,
  variantBlockedChars,
  onPick,
  onClose,
}: {
  baseCount: number;
  /** Total (character × emotion) variant tasks across the whole cast. */
  variantTotal: number;
  /** Variant tasks for characters that already have a base voice. */
  variantReady: number;
  /** Variant tasks blocked behind a missing base voice. */
  variantBlocked: number;
  /** Distinct characters whose variants are blocked behind a missing base. */
  variantBlockedChars: number;
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

  const bothCount = baseCount + variantTotal;

  const badgeClass = (active: boolean) =>
    `text-xs font-bold px-2.5 py-1 rounded-full shrink-0 ${
      active ? 'bg-amber-500/10 text-amber-700' : 'bg-emerald-500/10 text-emerald-700'
    }`;

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
        role="menuitem"
        data-testid={`scope-${scope}`}
        disabled={count === 0}
        onClick={() => onPick(scope)}
        className="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-ink/4 disabled:opacity-40 disabled:cursor-not-allowed border-t border-ink/8 first:border-t-0 min-h-[44px]"
      >
        <span className="flex-1 min-w-0">
          <span className="block text-sm font-bold text-ink">{title}</span>
          <span className="block text-xs text-ink/55">{desc}</span>
        </span>
        <span className={badgeClass(count > 0)}>{count === 0 ? 'all done' : `${count} ${unit}`}</span>
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
        <button type="button" onClick={onClose} aria-label="Close" className="text-ink/40 hover:text-ink p-1 min-h-[44px] min-w-[44px] sm:min-h-0 sm:min-w-0 grid place-items-center">
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

      {/* Emotion variants — bespoke row: total-demand badge + ready/blocked
          split, disabled until ≥1 is designable, with a loud base-voice
          warning when some are blocked. */}
      <button
        type="button"
        role="menuitem"
        data-testid="scope-variants"
        disabled={variantReady === 0}
        onClick={() => onPick('variants')}
        className="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-ink/4 disabled:cursor-not-allowed border-t border-ink/8 min-h-[44px]"
      >
        <span className="flex-1 min-w-0">
          <span className={`block text-sm font-bold ${variantReady === 0 ? 'text-ink/40' : 'text-ink'}`}>
            Emotion variants
          </span>
          <span className={`block text-xs ${variantReady === 0 ? 'text-ink/35' : 'text-ink/55'}`}>
            Tagged emotions missing a variant
          </span>
          {variantTotal > 0 && (
            <span
              data-testid="variants-split"
              className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px] font-semibold"
            >
              <span className="inline-flex items-center gap-1 text-emerald-700">
                <IconCheck className="w-3 h-3" />
                {variantReady} ready now
              </span>
              {variantBlocked > 0 && (
                <span className="inline-flex items-center gap-1 text-amber-700">
                  <IconAlertTri className="w-3 h-3" />
                  {variantBlocked} need a base
                </span>
              )}
            </span>
          )}
        </span>
        <span className={badgeClass(variantTotal > 0)}>{variantTotal === 0 ? 'all done' : variantTotal}</span>
      </button>
      {variantBlockedChars > 0 && (
        <p
          data-testid="variants-base-warning"
          className="px-4 pb-3 -mt-0.5 text-[11px] text-amber-700 flex items-start gap-1.5"
        >
          <IconAlertTri className="w-3 h-3 mt-0.5 shrink-0" />
          <span>
            Variants only run for voices that already exist —{' '}
            {variantBlockedChars} {variantBlockedChars === 1 ? 'character needs' : 'characters need'} a
            base voice first. Choose “Both” to design everything.
          </span>
        </p>
      )}

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
