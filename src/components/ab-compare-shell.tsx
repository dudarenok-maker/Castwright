/* Two-pane A/B audition shell (extracted from CompareCastModal, plan 161).

   Owns the modal chrome only — overlay + dialog, header, the two-column
   side-by-side grid (single column on phones), and the footer with the
   "Auto A → B" sequence button. The playback orchestration lives in
   `use-ab-audition.ts`; each consumer renders its own side bodies + footer
   actions. CompareCastModal (two-character profile compare) and
   VoiceCompareModal (current-vs-proposed voice) both render through this. */

import { useEffect, type ReactNode } from 'react';
import { IconClose, IconPause, IconRefresh } from '../lib/icons';

interface Props {
  title: string;
  subtitle?: string;
  ariaLabel: string;
  /** Overlay test id — defaults to the historical `compare-cast-overlay` so
      the existing CompareCastModal markup is unchanged. */
  overlayTestId?: string;
  autoRunning: boolean;
  /** Disable the Auto button (e.g. while a side is loading and auto isn't
      already running). */
  autoDisabled: boolean;
  footerError: string | null;
  onRunAuto: () => void;
  onClose: () => void;
  sideA: ReactNode;
  sideB: ReactNode;
  /** Trailing footer slot (right-aligned) — e.g. a "Done" or
      "Use proposed voice" / Cancel cluster. */
  footerEnd?: ReactNode;
}

export function AbCompareShell({
  title,
  subtitle,
  ariaLabel,
  overlayTestId = 'compare-cast-overlay',
  autoRunning,
  autoDisabled,
  footerError,
  onRunAuto,
  onClose,
  sideA,
  sideB,
  footerEnd,
}: Props) {
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <>
      <div
        onClick={onClose}
        className="fixed inset-0 bg-ink/40 z-40 fade-in"
        data-testid={overlayTestId}
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={ariaLabel}
        className="fixed inset-0 z-50 overflow-y-auto pointer-events-none"
      >
        <div className="min-h-full flex items-start justify-center p-4 sm:p-8">
          <div className="w-full max-w-[960px] bg-canvas rounded-3xl shadow-float pointer-events-auto">
            <div className="px-6 py-4 border-b border-ink/10 flex items-center gap-3">
              <h3 className="text-lg font-bold text-ink">{title}</h3>
              {subtitle && <p className="text-xs text-ink/50 ml-2">{subtitle}</p>}
              <button
                onClick={onClose}
                aria-label="Close"
                className="ml-auto p-2 rounded-full hover:bg-ink/5 text-ink/60"
              >
                <IconClose className="w-4 h-4" />
              </button>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-6 p-6">
              {sideA}
              {sideB}
            </div>

            <div className="px-6 py-4 border-t border-ink/10 flex items-center gap-3 flex-wrap">
              <button
                onClick={onRunAuto}
                disabled={autoDisabled}
                className={`inline-flex items-center gap-1.5 px-4 py-2 rounded-full text-sm font-semibold transition-colors disabled:opacity-50 disabled:cursor-not-allowed min-h-[44px] sm:min-h-0 ${
                  autoRunning
                    ? 'bg-magenta text-white hover:bg-magenta/90'
                    : 'bg-peach text-ink hover:bg-peach/90'
                }`}
              >
                {autoRunning ? (
                  <IconPause className="w-3.5 h-3.5" />
                ) : (
                  <IconRefresh className="w-3.5 h-3.5" />
                )}
                <span>{autoRunning ? 'Stop auto-compare' : 'Auto A → B'}</span>
              </button>
              {footerError && (
                <span className="text-xs text-red-600/80 truncate" title={footerError}>
                  ⚠ {footerError}
                </span>
              )}
              {footerEnd && <div className="ml-auto flex items-center gap-2">{footerEnd}</div>}
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
