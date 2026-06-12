import { useEffect, useLayoutEffect, useState, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { useAppDispatch, useAppSelector } from '../../store';
import { TOUR_STEPS } from '../../lib/tour-steps';
import { tourActions, nextStep, prevStep } from '../../store/tour-slice';

type Rect = { top: number; left: number; width: number; height: number };

function measure(anchor: string | null): Rect | null {
  if (!anchor) return null;
  const el = document.querySelector<HTMLElement>(`[data-tour-id="${anchor}"]`);
  if (!el) return null;
  const r = el.getBoundingClientRect();
  if (r.width === 0 && r.height === 0) return null;
  return { top: r.top, left: r.left, width: r.width, height: r.height };
}

export function TourOverlay() {
  const dispatch = useAppDispatch();
  const { active, stepIndex } = useAppSelector((s) => s.tour);
  const step = active ? TOUR_STEPS[stepIndex] : null;
  const [rect, setRect] = useState<Rect | null>(null);

  const remeasure = useCallback(() => {
    setRect(step ? measure(step.anchor) : null);
  }, [step]);

  useLayoutEffect(() => {
    if (!step) return;
    remeasure();
    const ids = [50, 150, 350].map((ms) => window.setTimeout(remeasure, ms));
    return () => ids.forEach(clearTimeout);
  }, [step, remeasure]);

  useEffect(() => {
    if (!step) return;
    window.addEventListener('scroll', remeasure, true);
    window.addEventListener('resize', remeasure);
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') dispatch(tourActions.endTour()); };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('scroll', remeasure, true);
      window.removeEventListener('resize', remeasure);
      window.removeEventListener('keydown', onKey);
    };
  }, [step, remeasure, dispatch]);

  if (!step) return null;

  const anchored = rect != null;
  const pad = 6;
  const bubbleStyle: React.CSSProperties = anchored
    ? { position: 'fixed', top: Math.min(rect!.top + rect!.height + 12, window.innerHeight - 220),
        left: Math.max(12, Math.min(rect!.left, window.innerWidth - 332)), width: 320 }
    : { position: 'fixed', top: '50%', left: '50%', transform: 'translate(-50%,-50%)', width: 320 };

  return createPortal(
    <div data-testid="tour-overlay" className="fixed inset-0 z-[75]" aria-live="polite">
      {anchored ? (
        <div
          aria-hidden
          style={{
            position: 'fixed',
            top: rect!.top - pad, left: rect!.left - pad,
            width: rect!.width + pad * 2, height: rect!.height + pad * 2,
            borderRadius: 10, boxShadow: '0 0 0 9999px rgba(15,14,13,.55)',
            outline: '2px solid var(--peach)', pointerEvents: 'none',
          }}
        />
      ) : (
        <div aria-hidden className="fixed inset-0" style={{ background: 'rgba(15,14,13,.55)' }} />
      )}

      <div
        data-testid="tour-bubble"
        data-anchored={anchored ? 'true' : 'false'}
        role="dialog"
        aria-label={step.title}
        className="rounded-2xl bg-ink text-canvas p-4 shadow-float"
        style={bubbleStyle}
      >
        <h4 className="font-semibold text-sm">{step.title}</h4>
        <p className="mt-1 text-xs text-canvas/75 leading-relaxed">{step.body}</p>
        <div className="mt-3 flex items-center gap-2">
          <div className="flex gap-1" aria-hidden>
            {TOUR_STEPS.map((s, i) => (
              <span key={s.id} className={`w-1.5 h-1.5 rounded-full ${i === stepIndex ? 'bg-peach' : 'bg-canvas/30'}`} />
            ))}
          </div>
          <button type="button" onClick={() => dispatch(tourActions.endTour())}
            className="ml-auto text-xs text-canvas/60 min-h-[44px] sm:min-h-0">Skip</button>
          {stepIndex > 0 && (
            <button type="button" onClick={() => dispatch(prevStep())}
              className="text-xs font-semibold text-canvas/80 min-h-[44px] sm:min-h-0">Back</button>
          )}
          <button type="button" onClick={() => dispatch(nextStep())}
            className="text-xs font-bold bg-peach text-ink rounded-lg px-3 py-1.5 min-h-[44px] sm:min-h-0">
            {stepIndex === TOUR_STEPS.length - 1 ? 'Done' : 'Next →'}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
