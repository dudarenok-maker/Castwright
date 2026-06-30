/* fs-33/fs-57 — "Detect emotions" trigger for the manuscript header.

   Runs two sequential LLM passes over the whole book:
   1. Emotion-only backfill pass (api.detectEmotions) — per-quote delivery
      emotions (fill-only-empty; hand-set emotions never overwritten).
   2. Stage-3 instruct/vocalization pass (api.detectInstruct) — natural
      reactions (a gasp, sigh, laugh) inserted as new text + delivery
      instructions (fill-only-empty; manual edits always win). Because
      Stage 3 can mutate sentence text, operators see that called out
      clearly in the confirm dialog.

   Both passes share a single AbortController so Cancel stops the whole
   sequence. Progress is reported on a 0-100% scale: emotions occupies
   0–50%, instruct occupies 50–100%. The result summary shows totals
   from both passes combined.

   Whole-book only for v1 (a per-chapter trigger is a tracked follow-up). */

import { useRef, useState } from 'react';
import { useAppDispatch, useAppSelector } from '../store';
import { DetectEmotionsError, DetectInstructError } from '../lib/api';
import { runProsodyPasses } from '../store/prosody-thunk';
import { prosodyActions } from '../store/prosody-slice';
import { selectAnalysisBusyForBook } from '../store/analysis-substage-selectors';
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
  const busy = useAppSelector((s) => (bookId ? selectAnalysisBusyForBook(s, bookId) : false));

  if (!bookId) return null;

  const run = async () => {
    if (!bookId) return;
    setPhase('running');
    setProgress(0);
    setError(null);
    setStatus('Starting…');
    const controller = new AbortController();
    abortRef.current = controller;
    dispatch(prosodyActions.setActive({ bookId, progress: 0, label: 'Detecting emotions' }));
    try {
      const { totalAnnotations, totalChapters } = await runProsodyPasses(bookId, {
        dispatch,
        signal: controller.signal,
        onProgress: (fraction) => {
          setProgress(fraction);
          dispatch(prosodyActions.updateProgress({ bookId, progress: fraction }));
        },
        onStatus: (label) => setStatus(label),
        onThrottle: () => setStatus('Waiting on the analyzer rate limit…'),
      });
      setStatus(
        `Tagged ${totalAnnotations} line${totalAnnotations === 1 ? '' : 's'} across ` +
          `${totalChapters} chapter${totalChapters === 1 ? '' : 's'}.`,
      );
      setPhase('idle');
    } catch (e) {
      if ((e as Error).name === 'AbortError') {
        setStatus(null);
        setPhase('idle');
      } else if (e instanceof DetectEmotionsError && e.code === 'no_attribution') {
        setError('Run analysis first — there are no attributed lines to tag.');
        setPhase('idle');
      } else if (e instanceof DetectInstructError) {
        setError(e.message);
        setPhase('idle');
      } else {
        setError((e as Error).message);
        setPhase('idle');
      }
    } finally {
      dispatch(prosodyActions.clear({ bookId }));
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
        disabled={disabled || busy}
        onClick={() => setPhase((p) => (p === 'confirm' ? 'idle' : 'confirm'))}
        title={
          disabled
            ? 'Analyse the book first to detect emotions'
            : 'Detect per-quote delivery emotions and natural reactions across all included chapters'
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
            Run an LLM pass over all included chapters to detect per-quote delivery emotions and
            add natural reactions — a gasp, sigh, or laugh — to the text where the scene calls
            for it. This uses your analyzer quota and can take a few minutes on a long book.
            Hand-set emotions are never overwritten; sentences you have edited are skipped.
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
