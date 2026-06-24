/* fs-33 — "Detect emotions" trigger for the manuscript header.

   Runs the emotion-only backfill pass (api.detectEmotions) over the whole book:
   a quota/time confirm → a lightweight inline progress bar → per-chapter
   annotation batches dispatched to the manuscript store (fill-only-empty, so a
   hand-set emotion always wins) which persist to manuscript-edits.json. The pass
   is non-sticky: navigating away aborts it, but already-applied chapters are
   already persisted, so re-running just fills the remaining neutrals.

   Whole-book only for v1 (a per-chapter trigger is a tracked follow-up). */

import { useRef, useState } from 'react';
import { useAppDispatch, useAppSelector } from '../store';
import { manuscriptActions } from '../store/manuscript-slice';
import { api, DetectEmotionsError } from '../lib/api';
import { IconSparkle, IconSpinner } from '../lib/icons';

type Phase = 'idle' | 'confirm' | 'running';

export function DetectEmotionsButton({ disabled = false }: { disabled?: boolean }) {
  const dispatch = useAppDispatch();
  const bookId = useAppSelector((s) => (s.ui?.stage as { bookId?: string })?.bookId ?? null);
  const [phase, setPhase] = useState<Phase>('idle');
  const [progress, setProgress] = useState(0);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  if (!bookId) return null;

  const run = async () => {
    setPhase('running');
    setProgress(0);
    setError(null);
    setStatus('Starting…');
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const result = await api.detectEmotions(bookId, {
        signal: controller.signal,
        onPhase: (e) => {
          setProgress(e.progress);
          if (e.label) setStatus(e.label);
        },
        onThrottle: () => setStatus('Waiting on the analyzer rate limit…'),
        onAnnotation: (e) => dispatch(manuscriptActions.applyDetectedEmotions(e)),
      });
      setStatus(
        `Tagged ${result.totalAnnotations} line${result.totalAnnotations === 1 ? '' : 's'} across ` +
          `${result.annotatedChapters} chapter${result.annotatedChapters === 1 ? '' : 's'}.`,
      );
      setPhase('idle');
    } catch (e) {
      if ((e as Error).name === 'AbortError') {
        setStatus(null);
        setPhase('idle');
        return;
      }
      setError(
        e instanceof DetectEmotionsError && e.code === 'no_attribution'
          ? 'Run analysis first — there are no attributed lines to tag.'
          : (e as Error).message,
      );
      setPhase('idle');
    } finally {
      abortRef.current = null;
    }
  };

  if (phase === 'running') {
    return (
      <div
        data-testid="detect-emotions-progress"
        className="shrink-0 inline-flex items-center gap-2 px-4 min-h-11 rounded-full border border-ink/15 text-sm"
      >
        <IconSpinner className="w-4 h-4 animate-spin text-magenta" />
        <span className="text-ink/70 max-w-[14rem] truncate">{status ?? 'Detecting…'}</span>
        <span className="tabular-nums text-ink/50">{Math.round(progress * 100)}%</span>
        <button
          type="button"
          onClick={() => abortRef.current?.abort()}
          className="text-xs text-ink/50 hover:text-magenta underline"
        >
          Cancel
        </button>
      </div>
    );
  }

  return (
    <span className="relative inline-block">
      <button
        type="button"
        data-testid="detect-emotions-button"
        disabled={disabled}
        onClick={() => setPhase((p) => (p === 'confirm' ? 'idle' : 'confirm'))}
        title={
          disabled
            ? 'Analyse the book first to detect emotions'
            : 'Detect per-quote delivery emotions across all included chapters'
        }
        className="shrink-0 inline-flex items-center gap-2 px-4 min-h-11 rounded-full border border-ink/15 text-sm font-semibold text-ink hover:bg-ink/5 disabled:opacity-40"
      >
        <IconSparkle className="w-4 h-4 text-magenta" />
        Detect emotions
      </button>
      {error && (
        <span data-testid="detect-emotions-error" className="ml-2 text-xs text-magenta">
          {error}
        </span>
      )}
      {status && phase === 'idle' && !error && (
        <span data-testid="detect-emotions-done" className="ml-2 text-xs text-ink/55">
          {status}
        </span>
      )}
      {phase === 'confirm' && (
        <span
          role="dialog"
          aria-label="Detect emotions"
          className="absolute z-50 left-0 top-full mt-2 w-72 rounded-xl border border-ink/10 bg-white picker-surface shadow-lg p-3 text-left"
        >
          <p className="text-xs text-ink/70 leading-snug">
            Run an LLM pass over all included chapters to detect per-quote delivery emotions. This
            uses your analyzer quota and can take a few minutes on a long book. Hand-set emotions
            are never overwritten.
          </p>
          <div className="mt-3 flex items-center justify-end gap-2">
            <button
              type="button"
              onClick={() => setPhase('idle')}
              className="px-3 py-1.5 text-xs text-ink/60 hover:text-ink"
            >
              Cancel
            </button>
            <button
              type="button"
              data-testid="detect-emotions-confirm"
              onClick={() => void run()}
              className="px-3 py-1.5 rounded-full bg-ink text-canvas text-xs font-semibold hover:bg-ink/90"
            >
              Detect emotions
            </button>
          </div>
        </span>
      )}
    </span>
  );
}
