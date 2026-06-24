/* Status popover — the hover/tap/focus-revealed panel anchored to the top-bar
 * Status pill (src/components/top-bar.tsx, StatusPill). Replaces the plan-120
 * click-modal: same four sections (TTS model controls, analysis, generation,
 * pending revisions) but rendered as a small anchored panel with NO dimming
 * backdrop, so it never obscures or dismisses an open cast drawer.
 *
 * Presentational: the StatusPill owns the open-state machine (hover-bridge +
 * focus + click-pin) and passes `open` + the hover/focus handlers + a forwarded
 * `panelRef`. This component just positions + portals + renders.
 *
 * Why portaled (createPortal → document.body): the Status pill lives inside the
 * top bar's `overflow-x-auto` strip, which would clip an in-flow dropdown. The
 * portal + getBoundingClientRect positioning mirrors src/components/
 * searchable-picker.tsx.
 *
 * CRITICAL (the cast-drawer must-pass): clicks inside this panel must NOT close
 * the cast drawer. Two guards: (1) the panel is a separate portaled subtree
 * painted at z-50 above the drawer's z-40 backdrop, so a click on Load/Stop is
 * captured here and never reaches the backdrop's onClick; (2) the panel root
 * stops mousedown/click propagation so the event can't reach ANY document-level
 * dismiss listener (the pill's own outside-close, or any future one). */

import { useLayoutEffect, useState, type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import {
  AnalysisPill,
  GenerationPill,
  DesignPill,
  type AnalysisPillData,
  type GenerationPillData,
  type DesignPillData,
} from './top-bar';
import { MODEL_OPTIONS } from '../lib/models';

const PANEL_WIDTH = 340;
const ESTIMATED_HEIGHT = 320;
const VIEWPORT_MARGIN = 8;

interface StatusPopoverProps {
  open: boolean;
  /** The pill button — anchor for positioning. */
  anchorRef: RefObject<HTMLElement | null>;
  /** Forwarded to the panel root so the StatusPill's outside-click + hover
      logic can test `contains(target)`. */
  panelRef: RefObject<HTMLDivElement | null>;
  /** Hover-bridge: keep the popover open while the pointer is over the panel. */
  onPointerEnter: () => void;
  onPointerLeave: () => void;
  /** Focus-bridge: keep it open while focus is inside the panel. */
  onFocusCapture: () => void;
  onBlurCapture: () => void;
  /** The <ModelControlPill> cluster Layout builds (ttsPillElement), incl. the
      GPU-busy badge. null when no book is in scope. */
  ttsControls: ReactNode;
  analysis: AnalysisPillData | null;
  generation: GenerationPillData | null;
  design: DesignPillData | null;
  pendingRevisionsCount: number;
  /** Navigate handlers (wired in Layout via the pills' existing onClick); the
      StatusPill clears its sticky-open after these fire so the panel closes. */
  onOpenRevisions: () => void;
  onGoToAnalysing: () => void;
  onGoToGeneration: () => void;
  onGoToDesign: () => void;
}

function Section({
  title,
  testid,
  children,
}: {
  title: string;
  testid: string;
  children: ReactNode;
}) {
  return (
    <section data-testid={testid} className="py-3 border-b border-ink/10 last:border-b-0">
      <p className="text-[10px] uppercase tracking-widest text-ink/50 font-semibold mb-2">{title}</p>
      {children}
    </section>
  );
}

export function StatusPopover({
  open,
  anchorRef,
  panelRef,
  onPointerEnter,
  onPointerLeave,
  onFocusCapture,
  onBlurCapture,
  ttsControls,
  analysis,
  generation,
  design,
  pendingRevisionsCount,
  onOpenRevisions,
  onGoToAnalysing,
  onGoToGeneration,
  onGoToDesign,
}: StatusPopoverProps) {
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

  /* Position under the pill, right-aligned (bottom-end). Flip above only if it
     would spill past the viewport bottom. Tracks scroll/resize like the
     searchable-picker. */
  useLayoutEffect(() => {
    if (!open) return;
    function compute() {
      const el = anchorRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const spillsBelow = rect.bottom + ESTIMATED_HEIGHT > vh - VIEWPORT_MARGIN;
      const top = spillsBelow
        ? Math.max(VIEWPORT_MARGIN, rect.top - ESTIMATED_HEIGHT - 6)
        : rect.bottom + 6;
      let left = rect.right - PANEL_WIDTH; // right-aligned to the pill
      left = Math.min(Math.max(VIEWPORT_MARGIN, left), vw - PANEL_WIDTH - VIEWPORT_MARGIN);
      setPos({ top, left });
    }
    compute();
    window.addEventListener('scroll', compute, true);
    window.addEventListener('resize', compute);
    return () => {
      window.removeEventListener('scroll', compute, true);
      window.removeEventListener('resize', compute);
    };
  }, [open, anchorRef]);

  if (!open || typeof document === 'undefined') return null;

  return createPortal(
    <div
      ref={panelRef}
      data-testid="status-popover"
      role="group"
      aria-label="Status detail"
      className="fixed z-50 bg-white border border-ink/15 rounded-2xl shadow-float px-4 py-1 fade-in"
      style={{
        top: pos?.top ?? 0,
        left: pos?.left ?? 0,
        width: `min(92vw, ${PANEL_WIDTH}px)`,
        visibility: pos ? 'visible' : 'hidden',
      }}
      /* Guard: never let an in-panel mousedown/click reach a document-level
         dismiss listener (the drawer stays open; the popover stays open). */
      onMouseDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
      onPointerEnter={onPointerEnter}
      onPointerLeave={onPointerLeave}
      onFocusCapture={onFocusCapture}
      onBlurCapture={onBlurCapture}
    >
      <Section title="TTS engines" testid="status-popover-tts">
        {ttsControls ?? (
          <p className="text-sm text-ink/60">TTS controls appear once a manuscript is open.</p>
        )}
      </Section>
      <Section title="Analysis" testid="status-popover-analysis">
        {analysis ? (
          <div className="flex flex-col items-start gap-1.5">
            <AnalysisPill data={{ ...analysis, onClick: onGoToAnalysing }} />
            {analysis.model && (
              <span
                data-testid="status-popover-analysis-model"
                className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-medium bg-ink/5 text-ink/70"
              >
                <span className="w-1.5 h-1.5 rounded-full bg-ink/30" />
                <span className="tabular-nums">
                  {MODEL_OPTIONS.find((m) => m.id === analysis.model)?.label ?? analysis.model}
                </span>
              </span>
            )}
          </div>
        ) : (
          <p className="text-sm text-ink/60">No analysis running.</p>
        )}
      </Section>
      <Section title="Design" testid="status-popover-design">
        {design ? (
          <DesignPill data={{ ...design, onClick: onGoToDesign }} />
        ) : (
          <p className="text-sm text-ink/60">No voice design running.</p>
        )}
      </Section>
      <Section title="Generation" testid="status-popover-generation">
        {generation ? (
          <GenerationPill data={{ ...generation, onClick: onGoToGeneration }} />
        ) : (
          <p className="text-sm text-ink/60">Nothing generating.</p>
        )}
      </Section>
      <Section title="Revisions" testid="status-popover-revisions">
        {pendingRevisionsCount > 0 ? (
          <button
            type="button"
            onClick={onOpenRevisions}
            className="inline-flex items-center gap-2 px-3 py-1.5 min-h-[44px] sm:min-h-0 rounded-full bg-peach/15 hover:bg-peach/25 text-magenta text-xs font-semibold transition-colors"
          >
            {pendingRevisionsCount} revision{pendingRevisionsCount === 1 ? '' : 's'} pending · Open
          </button>
        ) : (
          <p className="text-sm text-ink/60">No pending revisions.</p>
        )}
      </Section>
    </div>,
    document.body,
  );
}
