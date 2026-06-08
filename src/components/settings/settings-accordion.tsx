/* Collapsible accordion card for a group of config knobs.
   Purely presentational — no slice access, no behavior beyond open/close.

   Pattern note: uses a controlled useState toggle rather than native
   <details>/<summary> so the open state is predictable in tests and the
   Reset-section button click can be intercepted without bubbling into the
   toggle (stopPropagation on button vs <summary> is unreliable cross-browser). */

import { useState } from 'react';
import type { ConfigGroup } from '../../lib/types';

/* ── Risk badge ──────────────────────────────────────────────────────────── */

function RiskBadge({ risk }: { risk: ConfigGroup['risk'] }) {
  if (risk === 'low') return null;
  const cls =
    risk === 'high'
      ? 'bg-rose-100 text-rose-800'
      : 'bg-amber-100 text-amber-800';
  return (
    <span
      data-testid="risk-badge"
      className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-semibold ${cls}`}
    >
      {risk === 'high' ? '⚠' : '⚠'} {risk}
    </span>
  );
}

/* ── SettingsSection ─────────────────────────────────────────────────────── */

export interface SettingsSectionProps {
  group: ConfigGroup;
  overriddenCount: number;
  /** Overrides computed default; use to keep a section open across renders. */
  defaultOpen?: boolean;
  onResetSection?: () => void;
  children: React.ReactNode;
}

export function SettingsSection({
  group,
  overriddenCount,
  defaultOpen,
  onResetSection,
  children,
}: SettingsSectionProps) {
  /* High-risk groups start collapsed; otherwise honour collapsedByDefault.
     The `defaultOpen` prop is a manual override for the parent. */
  const startsOpen =
    defaultOpen !== undefined
      ? defaultOpen
      : group.risk === 'high'
        ? false
        : !group.collapsedByDefault;

  const [open, setOpen] = useState(startsOpen);

  return (
    <section className="rounded-2xl border border-ink/10 bg-white shadow-card overflow-hidden">
      {/* Header row — toggle area + reset button sit side-by-side in a div
          (not nested buttons) to avoid the button-in-button HTML violation. */}
      <div className="flex items-center gap-2 px-6 py-4 hover:bg-ink/2 transition-colors">
        <button
          type="button"
          aria-label={group.label}
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
          className="flex flex-1 items-center gap-3 text-left min-w-0"
        >
          {/* Expand/collapse chevron */}
          <span
            className={`shrink-0 text-ink/40 transition-transform duration-150 ${open ? 'rotate-90' : ''}`}
            aria-hidden="true"
          >
            ▶
          </span>

          <span className="flex-1 min-w-0 flex items-center gap-2 flex-wrap">
            <span className="text-base font-semibold text-ink">{group.label}</span>
            <RiskBadge risk={group.risk} />
            {overriddenCount > 0 && (
              <span className="text-xs text-ink/55 font-normal">· {overriddenCount} overridden</span>
            )}
          </span>
        </button>

        {/* Reset-section action — shown only when there are overrides */}
        {overriddenCount > 0 && onResetSection && (
          <button
            type="button"
            aria-label="Reset section"
            onClick={onResetSection}
            className="shrink-0 px-2.5 py-1 rounded-lg border border-ink/15 bg-white text-xs text-ink/60 hover:bg-ink/4 min-h-[44px] sm:min-h-0"
          >
            Reset section
          </button>
        )}
      </div>

      {/* Hint line */}
      {group.help && open && (
        <p className="px-6 pb-2 text-xs text-ink/55">{group.help}</p>
      )}

      {/* Body */}
      {open && <div className="px-6 pb-5">{children}</div>}
    </section>
  );
}

/* ── SettingsAccordion ───────────────────────────────────────────────────── */

export interface SettingsAccordionProps {
  children: React.ReactNode;
}

export function SettingsAccordion({ children }: SettingsAccordionProps) {
  return <div className="space-y-4">{children}</div>;
}
