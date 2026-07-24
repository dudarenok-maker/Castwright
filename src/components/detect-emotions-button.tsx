/* fs-33 / fs-57 / fs-35 — "Detect emotions" split trigger for the manuscript
   header. Mirrors fs-58 "Review Script":
   - PRIMARY runs BOTH prosody passes (emotion backfill + instruct/vocalization)
     scoped to the CURRENT chapter, immediately — cheap/targeted, no confirm.
   - The ⌄ disclosure opens a menu whose "Detect whole book" runs both passes
     over the whole book behind the existing cost/consequence confirm popover.

   Scope comes from the store (ui.stage.currentChapterId + manuscript.sentences),
   as bookId already does — so manuscript.tsx needs no new props. Both scopes
   share one AbortController + the bookId-keyed prosody substage lock, so only
   one runs at a time. Per-chapter is manual only and never writes the
   prosodyAnnotated watermark (that stays the layout.tsx auto-trigger's job). */

import { useEffect, useRef, useState } from 'react';
import { useAppDispatch, useAppSelector } from '../store';
import { DetectEmotionsError, DetectInstructError } from '../lib/api';
import {
  runProsodyPasses,
  buildProsodyProgressPayload,
  type SubstageDetail,
} from '../store/prosody-thunk';
import { prosodyActions } from '../store/prosody-slice';
import { selectAnalysisBusyForBook } from '../store/analysis-substage-selectors';
import { IconSparkle, IconArrowDn } from '../lib/icons';
import { formatSubstageDetail } from '../lib/substage-progress-text';
import { SubstageProgressPill } from './substage-progress-pill';

type Phase = 'idle' | 'confirm' | 'running';

export function DetectEmotionsButton({ disabled = false }: { disabled?: boolean }) {
  const dispatch = useAppDispatch();
  const stage = useAppSelector(
    (s) => s.ui?.stage as { bookId?: string; currentChapterId?: number | null } | undefined,
  );
  const bookId = stage?.bookId ?? null;
  const currentChapterId = stage?.currentChapterId ?? null;
  const currentChapterHasSentences = useAppSelector((s) =>
    currentChapterId == null
      ? false
      : s.manuscript.sentences.some((x) => x.chapterId === currentChapterId),
  );
  const [phase, setPhase] = useState<Phase>('idle');
  const [progress, setProgress] = useState(0);
  const [status, setStatus] = useState<string | null>(null);
  const [detail, setDetail] = useState<SubstageDetail | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const busy = useAppSelector((s) => (bookId ? selectAnalysisBusyForBook(s, bookId) : false));

  // Close the ⌄ menu on an outside click (mirrors the Review Script menu).
  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [menuOpen]);

  if (!bookId) return null;

  const run = async (scope: { chapterId?: number }) => {
    setMenuOpen(false);
    setPhase('running');
    setProgress(0);
    setDetail(undefined);
    setError(null);
    setStatus('Starting…');
    const controller = new AbortController();
    abortRef.current = controller;
    dispatch(prosodyActions.setActive({ bookId, progress: 0, label: 'Detecting emotions' }));
    try {
      const { totalAnnotations, totalChapters } = await runProsodyPasses(bookId, {
        dispatch,
        signal: controller.signal,
        chapterId: scope.chapterId,
        onProgress: (fraction, d) => {
          setProgress(fraction);
          setDetail(d);
          dispatch(prosodyActions.updateProgress(buildProsodyProgressPayload(bookId, fraction, d)));
        },
        onStatus: (label) => setStatus(label),
        onThrottle: () => setStatus('Waiting on the analyzer rate limit…'),
      });
      const lines = `${totalAnnotations} line${totalAnnotations === 1 ? '' : 's'}`;
      setStatus(
        scope.chapterId != null
          ? `Tagged ${lines} in this chapter.`
          : `Tagged ${lines} across ${totalChapters} chapter${totalChapters === 1 ? '' : 's'}.`,
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
    const detailText = detail ? formatSubstageDetail(detail) : null;
    return (
      <SubstageProgressPill
        testId="detect-emotions-progress"
        detailTestId="detect-emotions-progress-detail"
        status={status ?? 'Detecting…'}
        detailText={detailText}
        percent={Math.round(progress * 100)}
        labelClassName="text-ink/70 max-w-[14rem] truncate"
        onCancel={() => abortRef.current?.abort()}
      />
    );
  }

  const primaryDisabled =
    disabled || busy || currentChapterId == null || !currentChapterHasSentences;
  const wholeBookDisabled = disabled || busy;

  return (
    <div ref={menuRef} className="relative shrink-0 inline-flex items-stretch">
      <button
        type="button"
        data-testid="detect-emotions-button"
        disabled={primaryDisabled}
        onClick={() => void run({ chapterId: currentChapterId ?? undefined })}
        title={
          primaryDisabled
            ? 'Analyse this chapter first to detect emotions'
            : 'Detect per-quote delivery emotions and natural reactions in this chapter'
        }
        className="inline-flex items-center gap-2 px-4 min-h-11 fine-pointer:min-h-0 rounded-l-full border border-ink/15 text-sm font-semibold text-ink hover:bg-ink/5 disabled:opacity-40"
      >
        <IconSparkle className="w-4 h-4 text-magenta" />
        Detect emotions
      </button>
      <button
        type="button"
        data-testid="detect-emotions-menu-toggle"
        disabled={wholeBookDisabled}
        aria-label="Detect emotions options"
        aria-expanded={menuOpen}
        onClick={() => setMenuOpen((o) => !o)}
        className="inline-flex items-center justify-center px-2 min-h-11 fine-pointer:min-h-0 rounded-r-full border border-l-0 border-ink/15 text-ink/60 hover:bg-ink/5 hover:text-ink disabled:opacity-40"
      >
        <IconArrowDn className="w-4 h-4" />
      </button>

      {error && (
        <span data-testid="detect-emotions-error" className="ml-2 self-center text-xs text-magenta">
          {error}
        </span>
      )}
      {status && phase === 'idle' && !error && (
        <span data-testid="detect-emotions-done" className="ml-2 self-center text-xs text-ink/55">
          {status}
        </span>
      )}

      {menuOpen && (
        <div className="absolute top-full left-0 mt-2 z-50 w-72 rounded-2xl border border-ink/10 bg-white picker-surface shadow-float p-3 space-y-2">
          <p className="text-[11px] uppercase tracking-wider font-semibold text-ink/50">
            Detect scope
          </p>
          <button
            type="button"
            data-testid="detect-emotions-wholebook"
            disabled={wholeBookDisabled}
            onClick={() => {
              setMenuOpen(false);
              setPhase('confirm');
            }}
            className="w-full text-left px-3 min-h-11 fine-pointer:min-h-0 py-2 rounded-xl hover:bg-ink/5 text-sm font-medium text-ink disabled:opacity-50"
          >
            Detect whole book
            <span className="block text-xs font-normal text-ink/50">
              All included chapters — uses more analyzer quota
            </span>
          </button>
        </div>
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
              onClick={() => void run({})}
              className="px-3 py-1.5 rounded-full bg-ink text-canvas text-xs font-semibold hover:bg-ink/90"
            >
              Detect emotions
            </button>
          </div>
        </span>
      )}
    </div>
  );
}
