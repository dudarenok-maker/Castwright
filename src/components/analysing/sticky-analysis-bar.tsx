import { ANALYSIS_PHASES } from '../../data/analysis-phases';
import { PhaseModelChip } from './phase-model-chip';
import type { ConnState } from './phase-card';

interface StickyAnalysisBarProps {
  /** Current phase from the AnalysingView's `phase` state. Drives both the
      phase chip label and the model chip's `phaseId` (when 0|1). */
  activePhaseId: number;
  conn: ConnState;
  /** True when the SSE is in flight. Drives the button label (Pause vs
      Resume) and the chip state (streaming vs warming/pending). */
  isRunning: boolean;
  /** True if the user has at least clicked Start once this mount — picks
      "Resume" over "Start" wording when not currently running. */
  hasStartedOnce: boolean;
  /** Local-analyzer gate. When false + isRunning false, the button reads
      "Waiting for analyzer…" and is disabled. Identical semantics to the
      header Pause button it shadows. */
  isAnalyzerReady: boolean;
  onPauseOrResume: () => void;
}

/* CSS-only sticky status bar shown on the analysing-stage view. Pinned at
   `top-16` (under the 64px global topbar) with a backdrop blur — `z-30`
   sits above phase logs but below modals (z-50). Lives outside the centred
   `max-w-2xl` column so the blur bleeds edge-to-edge over the gradient
   hero wash.

   No IntersectionObserver, no scroll listener, no React state — the
   browser handles sticky behaviour natively. The bar mounts once, near
   the top of AnalysingView, and stays in place as the page scrolls. */
export function StickyAnalysisBar({
  activePhaseId,
  conn,
  isRunning,
  hasStartedOnce,
  isAnalyzerReady,
  onPauseOrResume,
}: StickyAnalysisBarProps) {
  const phaseConfig = ANALYSIS_PHASES.find((p) => p.id === activePhaseId);
  const phaseLabel = phaseConfig?.label ?? 'Analysing';

  const buttonLabel = isRunning
    ? 'Pause analysis'
    : isAnalyzerReady
      ? hasStartedOnce
        ? 'Resume analysis'
        : 'Start analysis'
      : 'Waiting for analyzer…';
  const buttonDisabled = !isRunning && !isAnalyzerReady;

  /* The model chip's state mirrors the chip inside the active PhaseCard
     so the sticky bar stays a faithful reflection of the page. Phase 2
     (library match) has no model chip — collapse to just the phase label. */
  const chipState =
    isRunning && (activePhaseId === 0 || activePhaseId === 1)
      ? ('streaming' as const)
      : ('pending' as const);

  const showConnDot = conn === 'streaming' || conn === 'connecting';

  return (
    <div
      data-testid="sticky-analysis-bar"
      className="sticky top-16 z-30 -mx-6 px-6 py-2 flex flex-wrap items-center gap-x-3 gap-y-2 bg-canvas/85 backdrop-blur-md border-b border-ink/10"
    >
      <span
        className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-peach/15 text-[11px] font-semibold text-ink"
        data-testid="sticky-phase-chip"
      >
        {showConnDot && (
          <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
        )}
        Phase {activePhaseId} · {phaseLabel}
      </span>
      {(activePhaseId === 0 || activePhaseId === 1) && (
        <PhaseModelChip phaseId={activePhaseId as 0 | 1} state={chipState} />
      )}
      <button
        type="button"
        onClick={onPauseOrResume}
        disabled={buttonDisabled}
        data-testid="sticky-pause-button"
        className={`ml-auto px-4 py-1.5 rounded-full text-xs font-semibold transition-colors ${
          buttonDisabled
            ? 'bg-ink/15 text-ink/40 cursor-not-allowed'
            : 'bg-ink text-canvas hover:bg-ink/90'
        }`}
      >
        {buttonLabel}
      </button>
    </div>
  );
}
