import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { IconArrowLeft, IconSpinner, IconClock, IconWarning, IconMenu, IconCheck, CastwaveMark } from '../lib/icons';
import { Avatar } from './primitives';
import { ThemeToggleButton } from './theme-toggle';
import { useAppInfo } from '../lib/use-app-info';
import { buildInfo } from '../lib/build-info';
import { StatusPopover } from './status-popover';
import { AdminPill } from './admin-pill';
import type { Stage, View } from '../lib/types';
import { useAppDispatch } from '../store';
import { startLinearTour, startScreenTour } from '../store/tour-slice';
import { screenForStage } from '../lib/tour-steps';

export type GenerationPillState = 'running' | 'stalled' | 'halted';
export interface GenerationPillData {
  state: GenerationPillState;
  done: number;
  total: number;
  percent: number;
  onClick: () => void;
}

/* Sibling of GenerationPillData for the in-flight analyzer run. Surfaces
   live phase progress so the user knows analysis is still going while
   they're browsing other views; clicking routes back to the analysing
   view. State mirrors the analysis slice's activeStream.state, plus a
   `stalled` UI-derived variant when lastTickAt is older than the
   stall threshold (computed by the slice consumer). */
export type AnalysisPillState = 'running' | 'paused' | 'halted' | 'stalled';
export interface AnalysisPillData {
  state: AnalysisPillState;
  /** Server-supplied phase label, e.g. "Detecting characters". */
  phaseLabel: string;
  /** 0..100 overall percent across the configured phases (caller does
      the per-phase → overall conversion). */
  percent: number;
  /** Reason text rendered on the halted variant — usually the server's
      structured error message (attribution_drift, cast_incomplete, etc.). */
  haltReason?: string;
  /** Discriminator for the in-flight job's shape (plan 32 D2).
      `'subset'` swaps the pill label from "Analysing" to "Retrying"
      and renders the chapter count instead of the generic phase
      label. Undefined / `'main'` keeps the existing rendering. */
  kind?: 'main' | 'subset';
  /** Number of chapters being retried — only meaningful when
      `kind === 'subset'`. Drives the "Retrying N chapters" copy. */
  subsetChapterCount?: number;
  onClick: () => void;
}

/* Sibling of GenerationPillData for the in-flight "Design full cast" bulk job
   (the third status pill). Surfaces designed/total progress + a brief terminal
   "done" summary; clicking routes to the Cast view of the book being designed. */
export type DesignPillState = 'running' | 'stalled' | 'halted' | 'done';
export interface DesignPillData {
  state: DesignPillState;
  done: number;
  total: number;
  percent: number;
  /** Characters skipped (already had a voice) — shown in the terminal summary. */
  skipped: number;
  /** Number of per-character failures (shown in the terminal summary). */
  failureCount: number;
  /** Character currently being designed (running subtitle). */
  currentName?: string | null;
  /** Phase of the current single-character design job (absent for bulk). */
  phase?: 'designing' | 'rendering';
  onClick: () => void;
}

/* The top bar no longer renders the TTS / analysis / generation / revisions
   pills inline; they live behind a single compact Status pill that reveals a
   hover/tap popover. `summarizeStatus` collapses the live state into ONE
   dominant {label, tone, icon, detail} so the pill stays narrow and the nav
   menu keeps its room. The full per-engine / per-stream detail is in the
   popover (src/components/status-popover.tsx). */
export type StatusTone = 'rose' | 'amber' | 'peach' | 'neutral';
export interface StatusSummary {
  label: string;
  tone: StatusTone;
  icon: 'spinner' | 'clock' | 'warning';
  /** Optional trailing live number, e.g. "55%" or "2". Omitted for idle /
      terminal states that have no meaningful number. */
  detail?: string;
}
export interface StatusInput {
  analysis: AnalysisPillData | null;
  generation: GenerationPillData | null;
  design: DesignPillData | null;
  pendingRevisionsCount: number;
  /** True when any in-use TTS engine pill is mid-load (Layout derives this
      from the per-engine ttsLifecycle state). */
  anyModelLoading: boolean;
}

/* Priority ladder (highest wins → the dominant state shown on the pill):
   halted > stalled > generation-running > analysis-running > design-running >
   model-loading > analysis-paused > revisions-pending > idle. Generation
   outranks analysis which outranks design because generation is the user's
   terminal goal and design is the furthest-upstream prep step. Halted / stalled
   stay on top because they're attention states the user must see without
   opening the modal. The terminal design 'done' summary has no dominant rung —
   it surfaces in the popover only. Pure + exported for unit testing. */
export function summarizeStatus({
  analysis,
  generation,
  design,
  pendingRevisionsCount,
  anyModelLoading,
}: StatusInput): StatusSummary {
  if (analysis?.state === 'halted' || generation?.state === 'halted' || design?.state === 'halted')
    return { label: 'Halted', tone: 'rose', icon: 'warning' };
  if (
    analysis?.state === 'stalled' ||
    generation?.state === 'stalled' ||
    design?.state === 'stalled'
  )
    return { label: 'Stalled', tone: 'amber', icon: 'clock' };
  if (generation?.state === 'running')
    return { label: 'Generating', tone: 'peach', icon: 'spinner', detail: `${generation.percent}%` };
  if (analysis?.state === 'running')
    return {
      label: analysis.kind === 'subset' ? 'Retrying' : 'Analysing',
      tone: 'peach',
      icon: 'spinner',
      detail: `${analysis.percent}%`,
    };
  if (design?.state === 'running')
    return { label: 'Designing', tone: 'peach', icon: 'spinner', detail: `${design.percent}%` };
  if (anyModelLoading) return { label: 'Loading model', tone: 'amber', icon: 'spinner' };
  if (analysis?.state === 'paused') return { label: 'Paused', tone: 'neutral', icon: 'clock' };
  if (pendingRevisionsCount > 0)
    return {
      label: 'Revisions',
      tone: 'peach',
      icon: 'warning',
      detail: String(pendingRevisionsCount),
    };
  return { label: 'Status', tone: 'neutral', icon: 'clock' };
}

/* The popover content behind the Status pill — built in Layout (the same data
   the plan-120 modal received) and rendered by StatusPill's hover/tap popover. */
export interface StatusDetail {
  /** The <ModelControlPill> cluster (ttsPillElement), incl. the GPU-busy badge. */
  ttsControls: ReactNode;
  analysis: AnalysisPillData | null;
  generation: GenerationPillData | null;
  design: DesignPillData | null;
  pendingRevisionsCount: number;
  onOpenRevisions: () => void;
  onGoToAnalysing: () => void;
  onGoToGeneration: () => void;
  onGoToDesign: () => void;
}

interface TopBarProps {
  stage: Stage['kind'];
  view: View | null;
  setView: (v: View) => void;
  projectTitle?: string | null;
  onHome: () => void;
  /** Optional override for the project-title click. When omitted, the title
      acts as a back-to-home shortcut (same as the logo). The cast-confirm
      stage uses this to wire the title to re-analyse. */
  onTitleClick?: () => void;
  onOpenVoices: () => void;
  onOpenChangelog: () => void;
  /** Avatar click → Account view. The avatar shows the user's display name
      (sourced from the account slice in the wrapping component), so it acts
      as the single discoverable entry-point to account settings. */
  onOpenAccount: () => void;
  /** fs-18 — entry to the all-users Admin watch console. Always present now
      (the dev-only worktree list lives inside the view). */
  onOpenAdmin: () => void;
  /** Display name rendered as the avatar's initials. Sourced from the
      account slice — the persisted user-level value, with a built-in
      seed default. */
  userDisplayName: string;
  /** Plan 120 — the single compact Status pill's content, pre-summarized in
      Layout (so the per-second clock tick that drives the "stalled" check
      keeps it live). Collapses the former TTS / analysis / generation /
      revisions pill cluster into one dominant state. `null` hides the pill
      entirely — Layout passes null on global views (Books / Voices / Change
      log) when there's no book in scope AND no cross-book activity, so an
      idle workspace shows no dead pill (matches the pre-120 empty cluster). */
  statusSummary: StatusSummary | null;
  /** The detail rendered in the Status pill's hover/tap popover. */
  statusDetail: StatusDetail;
  /** Plan 102 — workspace queue count. When > 0, renders a compact chip in
      the top-right cluster that opens the global queue modal on click. When
      0, the chip is hidden. */
  queueCount?: number;
  /** Plan 102 — click handler for the queue chip; dispatched by Layout. */
  onOpenQueue?: () => void;
}

const TABS: Array<{ id: View; label: string }> = [
  { id: 'manuscript', label: 'Manuscript' },
  { id: 'cast', label: 'Cast' },
  { id: 'library', label: 'Voices' },
  { id: 'generate', label: 'Generate' },
  { id: 'listen', label: 'Listen' },
  { id: 'log', label: 'Log' },
];

/* Cross-book destinations available when no book is open (or when the user
   is browsing a global view). Cast/Manuscript/Generate/Listen are inherently
   per-book and only appear in the `ready` tab strip. */
const GLOBAL_NAV: Array<{ id: 'books' | 'voices' | 'changelog'; label: string }> = [
  { id: 'books', label: 'Books' },
  { id: 'voices', label: 'Voices' },
  { id: 'changelog', label: 'Change log' },
];

export function TopBar({
  stage,
  view,
  setView,
  projectTitle,
  onHome,
  onTitleClick,
  onOpenVoices,
  onOpenChangelog,
  onOpenAccount,
  onOpenAdmin,
  userDisplayName,
  statusSummary,
  statusDetail,
  queueCount,
  onOpenQueue,
}: TopBarProps) {
  const showGlobalNav = stage === 'books' || stage === 'voices' || stage === 'changelog';
  const onGlobal = (id: 'books' | 'voices' | 'changelog') => {
    if (id === 'books') onHome();
    else if (id === 'voices') onOpenVoices();
    else onOpenChangelog();
  };
  /* Plan 81 wave 2 — mobile + tablet responsive shell.

     Goals on `<lg:` viewports (phones + portrait tablets):
       - All pre-plan-81 chrome elements remain reachable.
       - The concurrent-multibook invariant (project memory) is honoured —
         active-stream pills (analysis / generation / TTS) stay visible
         regardless of which book's view is active. No overflow menu hides
         them.

     Mechanism: the central nav + pill cluster sits inside an
     `overflow-x-auto` flex container — on desktop it fits the row; on
     phones it becomes a horizontally-swipeable strip with the same
     ordering. Logo + projectTitle + theme + avatar stay anchored at the
     edges via shrink-0. This keeps the DOM single-render (unit tests
     that getByTestId continue to find exactly one analysis-pill /
     generation-pill / tab button — no dual-render breakage).

     Touch-target compliance: every interactive pill/button picks up
     `min-h-[44px] sm:min-h-0` so phones get WCAG 2.5.5 touch targets
     without changing the desktop sizing. */
  return (
    <header className="sticky top-0 z-40 bg-canvas/85 backdrop-blur-md border-b border-ink/10">
      {/* overflow-x-clip — sticky chrome must never create page-level horizontal
          scroll. On a book route the breadcrumb + the shrink-0 right cluster can
          tip a hair past the 412px phone viewport (a 9px overflow that surfaced
          only on the Linux mobile-chrome runner, where font metrics render
          wider than Windows/macOS); the middle strip already scrolls. Paired
          with hiding the redundant VersionPill on phone (below) so the clip is
          pure insurance and never cuts a visible control. clip (not hidden)
          leaves the y-axis visible so the portaled status/account popovers are
          unaffected. Caught by e2e/responsive/baseline.spec.ts at Pixel-7. */}
      <div className="max-w-[1500px] mx-auto px-3 sm:px-6 h-16 flex items-center gap-3 sm:gap-8 overflow-x-clip">
        <NavDrawer
          stage={stage}
          view={view}
          setView={setView}
          onHome={onHome}
          onOpenVoices={onOpenVoices}
          onOpenChangelog={onOpenChangelog}
        />
        <button
          onClick={onHome}
          aria-label="Castwright — home"
          className="font-bold text-base tracking-tight inline-flex items-center gap-2 hover:opacity-80 transition-opacity shrink-0 min-h-[44px]"
        >
          <CastwaveMark className="w-6 h-6 shrink-0" aria-hidden="true" />
          <span>Castwright</span>
        </button>
        {projectTitle && (
          <button
            onClick={onTitleClick ?? onHome}
            className="flex items-center gap-2 text-sm text-ink/60 hover:text-ink transition-colors min-w-0 min-h-[44px] shrink-0"
          >
            <span className="text-ink/40 shrink-0">/</span>
            <span className="font-medium text-ink truncate max-w-[140px] sm:max-w-none">{projectTitle}</span>
            <IconArrowLeft className="w-3.5 h-3.5 text-ink/40 shrink-0 hidden sm:inline" />
          </button>
        )}
        {/* Middle scrollable strip — flex-1 + overflow-x-auto so it claims
            the leftover space and scrolls horizontally when narrow. */}
        <div className="flex-1 min-w-0 flex items-center gap-3 overflow-x-auto scrollbar-thin">
          {stage === 'ready' && (
            <nav className="hidden xl:flex items-center gap-1 bg-ink/4 rounded-full p-1 shrink-0">
              {TABS.map((t) => (
                <button
                  key={t.id}
                  onClick={() => setView(t.id)}
                  className={`px-4 py-1.5 min-h-[44px] sm:min-h-0 rounded-full text-sm font-medium transition-colors ${view === t.id ? 'bg-white text-ink shadow-card' : 'text-ink/60 hover:text-ink'}`}
                >
                  {t.label}
                </button>
              ))}
            </nav>
          )}
          {showGlobalNav && (
            <nav className="hidden xl:flex items-center gap-1 bg-ink/4 rounded-full p-1 shrink-0">
              {GLOBAL_NAV.map((t) => (
                <button
                  key={t.id}
                  onClick={() => onGlobal(t.id)}
                  className={`px-4 py-1.5 min-h-[44px] sm:min-h-0 rounded-full text-sm font-medium transition-colors ${stage === t.id ? 'bg-white text-ink shadow-card' : 'text-ink/60 hover:text-ink'}`}
                >
                  {t.label}
                </button>
              ))}
            </nav>
          )}
        </div>
        {/* One compact Status pill replacing the former TTS / analysis /
            generation / revisions cluster. Kept OUTSIDE the scrolling middle
            strip (shrink-0) so a wide breadcrumb — e.g. the listen view's long
            book title — can never scroll it off-screen / clip it to "Revis".
            Hovering (or tapping / focusing) reveals an anchored popover with the
            full detail — no modal, no backdrop, so it never dismisses an open
            cast drawer. Hidden on idle global views (statusSummary === null). */}
        {statusSummary && (
          <div className="shrink-0">
            <StatusPill summary={statusSummary} detail={statusDetail} />
          </div>
        )}
        <div className="flex items-center gap-3 shrink-0">
          <AdminPill onClick={onOpenAdmin} active={stage === 'admin'} />
          {(queueCount ?? 0) > 0 && onOpenQueue && (
            <button
              type="button"
              onClick={onOpenQueue}
              aria-label={`Generation queue — ${queueCount} pending`}
              title="Generation queue"
              data-testid="topbar-queue-chip"
              className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-peach/15 hover:bg-peach/25 text-magenta text-xs font-semibold min-h-[44px] sm:min-h-0"
            >
              Queue · {queueCount}
            </button>
          )}
          {/* Hidden on phone — the version is also in the footer + Account, and
              dropping it here gives the book-route top bar comfortable margin at
              the 412px viewport (see overflow-x-clip note above). */}
          <span className="hidden sm:inline-flex">
            <VersionPill onClick={onOpenAccount} />
          </span>
          <HelpMenu stage={stage} view={view} />
          <ThemeToggleButton />
          <button
            type="button"
            onClick={onOpenAccount}
            aria-label={`Account — ${userDisplayName || 'unnamed user'}`}
            className={`rounded-full transition-transform hover:scale-105 focus:outline-hidden focus:ring-2 focus:ring-magenta/40 ${stage === 'account' ? 'ring-2 ring-magenta/60' : ''}`}
          >
            <Avatar name={userDisplayName || 'You'} color="halloran" size={32} />
          </button>
        </div>
      </div>
    </header>
  );
}

/* <xl responsive nav. Below 1280px the inline tab/global strips are hidden
   (hidden xl:flex) and this hamburger opens a portaled left drawer with the
   SAME destinations. Mirrors HelpMenu: local open state, portal-to-body,
   outside-click + Escape, and — crucially — unmounted when closed so jsdom
   never sees the drawer rows alongside the inline strip (no duplicate
   selectors). Renders nothing on stages with no nav. */
function NavDrawer({
  stage,
  view,
  setView,
  onHome,
  onOpenVoices,
  onOpenChangelog,
}: {
  stage: Stage['kind'];
  view: View | null;
  setView: (v: View) => void;
  onHome: () => void;
  onOpenVoices: () => void;
  onOpenChangelog: () => void;
}) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  const showGlobalNav = stage === 'books' || stage === 'voices' || stage === 'changelog';
  const hasNav = stage === 'ready' || showGlobalNav;

  /* Focus the first row when the drawer opens (HelpMenu parity). */
  useEffect(() => {
    if (!open) return;
    panelRef.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
  }, [open]);

  /* Outside-click + Escape dismissal. Escape returns focus to the trigger;
     outside-click intentionally does not (HelpMenu parity). */
  useEffect(() => {
    if (!open) return;
    function onDocMouseDown(e: MouseEvent) {
      const t = e.target as Node | null;
      if (!t) return;
      if (triggerRef.current?.contains(t)) return;
      if (panelRef.current?.contains(t)) return;
      setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        setOpen(false);
        triggerRef.current?.focus();
      }
    }
    document.addEventListener('mousedown', onDocMouseDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDocMouseDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  if (!hasNav) return null;

  const rows: Array<{ id: string; label: string; active: boolean; run: () => void }> =
    stage === 'ready'
      ? TABS.map((t) => ({
          id: t.id,
          label: t.label,
          active: view === t.id,
          run: () => setView(t.id),
        }))
      : GLOBAL_NAV.map((t) => ({
          id: t.id,
          label: t.label,
          active: stage === t.id,
          run: () => {
            if (t.id === 'books') onHome();
            else if (t.id === 'voices') onOpenVoices();
            else onOpenChangelog();
          },
        }));

  const select = (run: () => void) => {
    run();
    setOpen(false);
  };

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        aria-label="Open navigation menu"
        aria-haspopup="menu"
        aria-expanded={open}
        data-testid="topbar-nav-toggle"
        onClick={() => setOpen((s) => !s)}
        className="xl:hidden shrink-0 inline-flex items-center justify-center w-11 h-11 min-h-[44px] min-w-[44px] rounded-full text-ink/70 hover:bg-ink/10 transition-colors"
      >
        <IconMenu className="w-5 h-5" />
      </button>
      {open &&
        typeof document !== 'undefined' &&
        createPortal(
          <>
            <div
              data-testid="topbar-nav-scrim"
              onClick={() => setOpen(false)}
              className="xl:hidden fixed inset-x-0 top-16 bottom-0 bg-ink/30 z-40 fade-in"
            />
            <div
              ref={panelRef}
              data-testid="topbar-nav-drawer"
              role="menu"
              aria-label="Navigation"
              className="xl:hidden fixed top-16 bottom-0 left-0 w-[min(80vw,320px)] bg-canvas shadow-drawer z-50 overflow-y-auto scrollbar-thin slide-in-left p-2"
            >
              {rows.map((r) => (
                <button
                  key={r.id}
                  type="button"
                  role="menuitem"
                  data-testid={`nav-drawer-link-${r.id}`}
                  aria-current={r.active ? 'page' : undefined}
                  onClick={() => select(r.run)}
                  className={`w-full min-h-[44px] flex items-center justify-between gap-3 px-4 py-2.5 rounded-xl text-sm font-medium text-left transition-colors ${
                    r.active ? 'bg-ink/6 text-ink' : 'text-ink/70 hover:bg-ink/5'
                  }`}
                >
                  <span>{r.label}</span>
                  {r.active && <IconCheck className="w-4 h-4 shrink-0" />}
                </button>
              ))}
            </div>
          </>,
          document.body,
        )}
    </>
  );
}

/* Help menu — the "?" button expands into a three-item popover menu anchored
   to the trigger. Portaled (createPortal → document.body) so the top-bar's
   overflow-x-clip never clips it. Outside-click + Escape close it. */
function HelpMenu({ stage, view }: { stage: Stage['kind']; view: View | null }) {
  const dispatch = useAppDispatch();
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const screen = screenForStage(stage, view);

  useLayoutEffect(() => {
    if (!open) return;
    function compute() {
      const el = triggerRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      setPos({ top: rect.bottom + 6, left: rect.right - 160 });
    }
    compute();
    window.addEventListener('scroll', compute, true);
    window.addEventListener('resize', compute);
    return () => {
      window.removeEventListener('scroll', compute, true);
      window.removeEventListener('resize', compute);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    menuRef.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    function onDocMouseDown(e: MouseEvent) {
      const t = e.target as Node | null;
      if (!t) return;
      if (triggerRef.current?.contains(t)) return;
      if (menuRef.current?.contains(t)) return;
      setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') { setOpen(false); triggerRef.current?.focus(); }
    }
    document.addEventListener('mousedown', onDocMouseDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDocMouseDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        aria-label="Help"
        title="Help & troubleshooting"
        data-testid="topbar-help"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((s) => !s)}
        className={`inline-flex items-center justify-center w-9 h-9 min-h-[44px] min-w-[44px] sm:min-h-0 sm:min-w-0 rounded-full text-sm font-semibold transition-colors ${
          stage === 'help' ? 'bg-ink text-canvas' : 'text-ink/70 hover:bg-ink/10'
        }`}
      >
        ?
      </button>
      {open && typeof document !== 'undefined' && createPortal(
        <div
          ref={menuRef}
          role="menu"
          tabIndex={-1}
          aria-label="Help menu"
          onMouseDown={(e) => e.stopPropagation()}
          onClick={(e) => e.stopPropagation()}
          className="fixed z-50 bg-white border border-ink/15 rounded-xl shadow-float py-1 min-w-[160px]"
          style={{
            top: pos?.top ?? 0,
            left: pos?.left ?? 0,
            visibility: pos ? 'visible' : 'hidden',
          }}
        >
          <a
            href="#/help"
            role="menuitem"
            onClick={() => setOpen(false)}
            className="flex items-center px-4 py-2.5 min-h-[44px] sm:min-h-0 text-sm text-ink hover:bg-ink/5 transition-colors"
          >
            Help
          </a>
          <button
            type="button"
            role="menuitem"
            onClick={() => { dispatch(startLinearTour()); setOpen(false); }}
            className="flex items-center w-full px-4 py-2.5 min-h-[44px] sm:min-h-0 text-sm text-ink hover:bg-ink/5 transition-colors text-left"
          >
            Take the tour
          </button>
          <button
            type="button"
            role="menuitem"
            disabled={!screen}
            onClick={() => { if (screen) { dispatch(startScreenTour(screen)); setOpen(false); } }}
            className="flex items-center w-full px-4 py-2.5 min-h-[44px] sm:min-h-0 text-sm text-ink hover:bg-ink/5 transition-colors text-left disabled:opacity-40 disabled:cursor-default"
          >
            Show me this screen
          </button>
        </div>,
        document.body,
      )}
    </>
  );
}

/* Tone → className, reusing the exact tokens the analysis / generation pills
   already use so the compact pill speaks the same visual language. */
const STATUS_TONE_CLASS: Record<StatusTone, string> = {
  rose: 'bg-rose-100 hover:bg-rose-200 text-rose-800',
  amber: 'bg-amber-100 hover:bg-amber-200 text-amber-800',
  peach: 'bg-peach/15 hover:bg-peach/25 text-magenta',
  neutral: 'bg-ink/6 hover:bg-ink/10 text-ink/70',
};
const STATUS_ICON: Record<StatusSummary['icon'], ReactNode> = {
  spinner: <IconSpinner className="w-3.5 h-3.5" />,
  clock: <IconClock className="w-3.5 h-3.5" />,
  warning: <IconWarning className="w-3.5 h-3.5" />,
};

/* The Status pill is the at-a-glance indicator AND the trigger for the hover
   popover. Open-state machine (local, not redux) covers every input mode:
     - hoverOpen  : pointer over the pill OR the panel (hover-bridge); a short
                    close delay lets the mouse cross the gap into the panel.
     - focusOpen  : focus within the pill OR the panel (keyboard peek).
     - stickyOpen : toggled by click/tap — a tap on touch pins it open so the
                    Load/Stop buttons are pressable; an outside click / Escape
                    clears it.
   The popover is portaled (escapes the top bar's overflow-x-auto) and carries
   no backdrop, so clicking its buttons never dismisses an open cast drawer. */
/* fs-1 — compact version pill. Prefers the SERVER version (GET /api/info) over
   the baked-in build stamp, since a stale cached bundle's __APP_VERSION__ can
   lie. Click opens Account (where the upgrade card lives). Tooltip shows the
   sidecar version too. */
function VersionPill({ onClick }: { onClick: () => void }) {
  const { info } = useAppInfo();
  const version = info?.appVersion ?? buildInfo.version;
  const title =
    info?.sidecarVersion != null
      ? `App v${version} · Sidecar v${info.sidecarVersion}`
      : `App v${version}`;
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-label={`Version v${version} — open Account`}
      data-testid="version-pill"
      className="hidden sm:inline-flex items-center rounded-full border border-ink/10 px-2.5 py-1 text-xs font-medium text-ink/60 hover:bg-ink/5 focus:outline-hidden focus:ring-2 focus:ring-magenta/40"
    >
      v{version}
    </button>
  );
}

function StatusPill({ summary, detail }: { summary: StatusSummary; detail: StatusDetail }) {
  const pillRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [hoverOpen, setHoverOpen] = useState(false);
  const [focusOpen, setFocusOpen] = useState(false);
  const [stickyOpen, setStickyOpen] = useState(false);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const open = hoverOpen || focusOpen || stickyOpen;

  const cancelClose = () => {
    if (closeTimer.current) {
      clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
  };
  const openHover = () => {
    cancelClose();
    setHoverOpen(true);
  };
  /* Grace delay so moving the mouse from the pill into the (gap-separated)
     panel doesn't close it mid-cross. */
  const scheduleHoverClose = () => {
    cancelClose();
    closeTimer.current = setTimeout(() => setHoverOpen(false), 140);
  };
  const closeAll = () => {
    cancelClose();
    setHoverOpen(false);
    setFocusOpen(false);
    setStickyOpen(false);
  };

  useEffect(() => () => cancelClose(), []);

  /* Outside-click + Escape dismissal. Excludes the pill and the panel so a
     click inside either keeps it open (the panel ALSO stops propagation, so
     this is belt-and-suspenders and, crucially, never reaches the cast
     drawer's backdrop). */
  useEffect(() => {
    if (!open) return;
    function onDocMouseDown(e: MouseEvent) {
      const t = e.target as Node | null;
      if (!t) return;
      if (pillRef.current?.contains(t)) return;
      if (panelRef.current?.contains(t)) return;
      closeAll();
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        closeAll();
        pillRef.current?.blur();
      }
    }
    document.addEventListener('mousedown', onDocMouseDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDocMouseDown);
      document.removeEventListener('keydown', onKey);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  return (
    <>
      <button
        ref={pillRef}
        type="button"
        data-testid="status-pill"
        data-status-tone={summary.tone}
        aria-haspopup="true"
        aria-expanded={open}
        aria-label={`Status — ${summary.label}${summary.detail ? ` ${summary.detail}` : ''}`}
        className={`inline-flex items-center gap-2 px-3 py-1.5 min-h-[44px] sm:min-h-0 rounded-full text-xs font-semibold transition-colors ${STATUS_TONE_CLASS[summary.tone]}`}
        onPointerEnter={openHover}
        onPointerLeave={scheduleHoverClose}
        onFocus={() => setFocusOpen(true)}
        onBlur={() => setFocusOpen(false)}
        onClick={() => setStickyOpen((s) => !s)}
      >
        {STATUS_ICON[summary.icon]}
        <span className="tabular-nums">
          {summary.label}
          {summary.detail ? ` · ${summary.detail}` : ''}
        </span>
      </button>
      <StatusPopover
        open={open}
        anchorRef={pillRef}
        panelRef={panelRef}
        onPointerEnter={openHover}
        onPointerLeave={scheduleHoverClose}
        onFocusCapture={() => setFocusOpen(true)}
        onBlurCapture={() => setFocusOpen(false)}
        ttsControls={detail.ttsControls}
        analysis={detail.analysis}
        generation={detail.generation}
        design={detail.design}
        pendingRevisionsCount={detail.pendingRevisionsCount}
        onOpenRevisions={() => {
          detail.onOpenRevisions();
          closeAll();
        }}
        onGoToAnalysing={() => {
          detail.onGoToAnalysing();
          closeAll();
        }}
        onGoToGeneration={() => {
          detail.onGoToGeneration();
          closeAll();
        }}
        onGoToDesign={() => {
          detail.onGoToDesign();
          closeAll();
        }}
      />
    </>
  );
}

/* Exported for reuse inside the Status popover, which renders the same live
   pill with its onClick overridden to navigate-and-close. */
export function AnalysisPill({ data }: { data: AnalysisPillData }) {
  const { state, phaseLabel, percent, haltReason, kind, subsetChapterCount, onClick } = data;
  /* Plan 32 D2: subset retries swap the label from "Analysing" to
     "Retrying" so the user knows they're watching a subset re-run
     rather than a fresh whole-book analysis. Halted / paused
     variants for a subset job keep the standard error/pause copy —
     those terminal states are about the same regardless of whether
     the run was a full one or a per-chapter retry. */
  const isSubset = kind === 'subset';
  const variants: Record<AnalysisPillState, { className: string; icon: ReactNode; label: string }> =
    {
      running: {
        className: 'bg-peach/15 hover:bg-peach/25 text-magenta',
        icon: <IconSpinner className="w-3.5 h-3.5" />,
        label: isSubset ? 'Retrying' : 'Analysing',
      },
      stalled: {
        className: 'bg-amber-100 hover:bg-amber-200 text-amber-800',
        icon: <IconClock className="w-3.5 h-3.5" />,
        label: 'Stalled',
      },
      paused: {
        className: 'bg-ink/6 hover:bg-ink/10 text-ink/70',
        icon: <IconClock className="w-3.5 h-3.5" />,
        label: 'Paused',
      },
      halted: {
        className: 'bg-rose-100 hover:bg-rose-200 text-rose-800',
        icon: <IconWarning className="w-3.5 h-3.5" />,
        label: 'Halted',
      },
    };
  const v = variants[state];
  /* Truncate the halt reason on render so a long error message
     doesn't blow out the header layout — the analysing view shows
     the full reason in its own banner. */
  const haltTrim =
    haltReason && haltReason.length > 32 ? haltReason.slice(0, 32) + '…' : haltReason;
  /* Subset secondary copy: "Retrying 3 chapters · 42%" beats
     "Retrying · Detecting characters · 42%" — the user already knows
     it's analysis, they want to know what scope. Fall back to the
     standard phase label when subsetChapterCount is missing (shouldn't
     happen in practice, but tolerant defaults beat NaN displays). */
  const subsetSecondary =
    isSubset && subsetChapterCount && subsetChapterCount > 0
      ? `${subsetChapterCount} chapter${subsetChapterCount === 1 ? '' : 's'}`
      : phaseLabel;
  return (
    <button
      onClick={onClick}
      className={`inline-flex items-center gap-2 px-3 py-1.5 rounded-full text-xs font-semibold transition-colors ${v.className}`}
      title={haltReason && haltReason.length > 32 ? haltReason : undefined}
      data-testid="analysis-pill"
      data-pill-kind={isSubset ? 'subset' : 'main'}
    >
      {v.icon}
      <span className="tabular-nums">
        {v.label} · {state === 'running' && isSubset ? subsetSecondary : phaseLabel}
        {state === 'running' && ` · ${percent}%`}
        {state === 'halted' && haltTrim && ` · ${haltTrim}`}
      </span>
    </button>
  );
}

export function GenerationPill({ data }: { data: GenerationPillData }) {
  const { state, done, total, percent, onClick } = data;
  const variants: Record<
    GenerationPillState,
    { className: string; icon: React.ReactNode; label: string }
  > = {
    running: {
      className: 'bg-peach/15 hover:bg-peach/25 text-magenta',
      icon: <IconSpinner className="w-3.5 h-3.5" />,
      label: 'Generating',
    },
    stalled: {
      className: 'bg-amber-100 hover:bg-amber-200 text-amber-800',
      icon: <IconClock className="w-3.5 h-3.5" />,
      label: 'Stalled',
    },
    halted: {
      className: 'bg-rose-100 hover:bg-rose-200 text-rose-800',
      icon: <IconWarning className="w-3.5 h-3.5" />,
      label: 'Halted',
    },
  };
  const v = variants[state];
  return (
    <button
      onClick={onClick}
      data-testid="generation-pill"
      className={`inline-flex items-center gap-2 px-3 py-1.5 rounded-full text-xs font-semibold transition-colors ${v.className}`}
    >
      {v.icon}
      <span className="tabular-nums">
        {v.label} · {done}/{total}
        {state === 'running' && total > 0 && ` · ${percent}%`}
      </span>
    </button>
  );
}

/* The third status pill — "Design full cast" bulk-job progress. Exported for
   reuse inside the Status popover (onClick overridden to navigate-and-close). */
export function DesignPill({ data }: { data: DesignPillData }) {
  const { state, done, total, percent, skipped, failureCount, currentName, phase, onClick } = data;
  const variants: Record<
    DesignPillState,
    { className: string; icon: React.ReactNode; label: string }
  > = {
    running: {
      className: 'bg-peach/15 hover:bg-peach/25 text-magenta',
      icon: <IconSpinner className="w-3.5 h-3.5" />,
      label: 'Designing',
    },
    stalled: {
      className: 'bg-amber-100 hover:bg-amber-200 text-amber-800',
      icon: <IconClock className="w-3.5 h-3.5" />,
      label: 'Stalled',
    },
    halted: {
      className: 'bg-rose-100 hover:bg-rose-200 text-rose-800',
      icon: <IconWarning className="w-3.5 h-3.5" />,
      label: 'Halted',
    },
    done: {
      className: 'bg-ink/6 hover:bg-ink/10 text-ink/70',
      icon: <IconClock className="w-3.5 h-3.5" />,
      label: 'Designed',
    },
  };
  const v = variants[state];
  /* Terminal summary: "Designed 6 · 1 failed · 2 skipped". Running: "Designing · 3/8 · 38%". */
  const summary =
    state === 'done'
      ? [
          `${done}`,
          failureCount > 0 ? `${failureCount} failed` : null,
          skipped > 0 ? `${skipped} skipped` : null,
        ]
          .filter(Boolean)
          .join(' · ')
      : `${done}/${total}${total > 0 ? ` · ${percent}%` : ''}`;
  return (
    <button
      onClick={onClick}
      data-testid="design-pill"
      className={`inline-flex items-center gap-2 px-3 py-1.5 rounded-full text-xs font-semibold transition-colors ${v.className}`}
    >
      {v.icon}
      <span className="tabular-nums">
        {phase && currentName
          ? `${v.label} ${currentName} · ${phase === 'rendering' ? 'rendering audition' : 'designing'}`
          : `${v.label} · ${summary}`}
      </span>
    </button>
  );
}
