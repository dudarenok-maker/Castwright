/* Collapsible accordion card for a group of config knobs.
   Purely presentational — no slice access, no behavior beyond open/close.

   Pattern note: uses a controlled useState toggle rather than native
   <details>/<summary> so the open state is predictable in tests and the
   Reset-section button click can be intercepted without bubbling into the
   toggle (stopPropagation on button vs <summary> is unreliable cross-browser). */

import { createContext, useContext, useEffect, useRef, useState } from 'react';
import type { ConfigGroup } from '../../lib/types';

/* ── Nav context ─────────────────────────────────────────────────────────── */

interface SettingsNavCtx {
  requestedOpenId: string | null;
  requestOpen: (id: string) => void;
}

const NavContext = createContext<SettingsNavCtx>({
  requestedOpenId: null,
  requestOpen: () => {},
});

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

  /* Nav context — when requestedOpenId matches our group, force-open. */
  const ctx = useContext(NavContext);
  useEffect(() => {
    if (ctx.requestedOpenId === group.id) {
      setOpen(true);
    }
  }, [ctx.requestedOpenId, group.id]);

  return (
    <section
      id={`cfg-section-${group.id}`}
      className="rounded-2xl border border-ink/10 bg-white shadow-card overflow-hidden"
    >
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

export interface SectionNavItem {
  id: string;
  label: string;
  risk: ConfigGroup['risk'];
}

export interface SettingsAccordionProps {
  children: React.ReactNode;
  /** When provided, renders a sticky left-rail nav (lg+) and a mobile jump
      dropdown (sm/md). When absent, renders the plain stacked layout as before
      (preserves all existing usages unchanged). */
  sections?: SectionNavItem[];
}

export function SettingsAccordion({ children, sections }: SettingsAccordionProps) {
  /* No sections prop → original behaviour, zero new rendering. */
  if (!sections || sections.length === 0) {
    return <div className="space-y-4">{children}</div>;
  }

  return <SettingsAccordionWithNav sections={sections}>{children}</SettingsAccordionWithNav>;
}

/* ── SettingsAccordionWithNav (internal) ─────────────────────────────────── */

function SettingsAccordionWithNav({
  children,
  sections,
}: {
  children: React.ReactNode;
  sections: SectionNavItem[];
}) {
  /* requestedOpenId drives the NavContext — sections subscribe via useEffect. */
  const [requestedOpenId, setRequestedOpenId] = useState<string | null>(null);
  /* activeId tracks the section nearest the top of the viewport for highlight. */
  const [activeId, setActiveId] = useState<string>(sections[0]?.id ?? '');
  /* nonce lets repeated clicks on the same section re-fire the scroll+open. */
  const nonceRef = useRef(0);

  const requestOpen = (id: string) => {
    nonceRef.current += 1;
    /* Force a re-render that delivers the new id to sections' useEffects. */
    setRequestedOpenId(id);
    /* Scroll in a microtask so the section has time to mount/open. */
    requestAnimationFrame(() => {
      document.getElementById(`cfg-section-${id}`)?.scrollIntoView({
        behavior: 'smooth',
        block: 'start',
      });
    });
    /* Reset after a short delay so the same id can be re-selected again. */
    setTimeout(() => setRequestedOpenId(null), 400);
  };

  /* Scroll-spy via IntersectionObserver — guard for jsdom (undefined in tests). */
  useEffect(() => {
    if (typeof IntersectionObserver === 'undefined') return;
    const entries = new Map<string, number>();
    const observer = new IntersectionObserver(
      (obs) => {
        for (const entry of obs) {
          const id = entry.target.id.replace('cfg-section-', '');
          entries.set(id, entry.intersectionRatio);
        }
        /* The section with the highest intersection ratio near the top wins. */
        let bestId = activeId;
        let bestRatio = -1;
        for (const [id, ratio] of entries) {
          if (ratio > bestRatio) {
            bestRatio = ratio;
            bestId = id;
          }
        }
        if (bestRatio > 0) setActiveId(bestId);
      },
      { threshold: [0, 0.1, 0.5, 1.0] },
    );
    for (const s of sections) {
      const el = document.getElementById(`cfg-section-${s.id}`);
      if (el) observer.observe(el);
    }
    return () => observer.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sections]);

  const navCtxValue: SettingsNavCtx = { requestedOpenId, requestOpen };

  return (
    <NavContext.Provider value={navCtxValue}>
      {/* Mobile dropdown — sticky below the top bar (~top-16) */}
      <div className="lg:hidden sticky top-16 z-10 mb-4">
        <select
          aria-label="Jump to section"
          value={activeId}
          onChange={(e) => requestOpen(e.target.value)}
          className="w-full min-h-[44px] px-3 py-2 rounded-xl border border-ink/15 bg-white text-sm text-ink focus:outline-hidden focus:ring-2 focus:ring-magenta/30"
        >
          {sections.map((s) => (
            <option key={s.id} value={s.id}>
              {s.label}
            </option>
          ))}
        </select>
      </div>

      {/* Desktop layout: sticky rail + content column */}
      <div className="flex gap-8 items-start">
        {/* Left rail — sticky below the top bar (~top-24 on desktop) */}
        <nav
          aria-label="Settings sections"
          className="hidden lg:block lg:sticky lg:top-24 self-start w-52 shrink-0"
        >
          <ul className="space-y-0.5">
            {sections.map((s) => {
              const isActive = s.id === activeId;
              return (
                <li key={s.id}>
                  <button
                    type="button"
                    onClick={() => requestOpen(s.id)}
                    className={[
                      'w-full text-left text-sm py-1.5 border-l-2 transition-colors min-h-[44px] sm:min-h-0',
                      'flex items-center gap-2',
                      isActive
                        ? 'border-magenta pl-3 text-magenta font-semibold'
                        : 'border-transparent pl-3 text-ink/60 hover:text-ink',
                    ].join(' ')}
                  >
                    <span className="truncate">{s.label}</span>
                    {s.risk === 'high' && (
                      <span className="shrink-0 text-rose-500 text-[10px]" aria-hidden="true">
                        ⚠
                      </span>
                    )}
                  </button>
                </li>
              );
            })}
          </ul>
        </nav>

        {/* Content column */}
        <div className="min-w-0 flex-1 space-y-4">{children}</div>
      </div>
    </NavContext.Provider>
  );
}
