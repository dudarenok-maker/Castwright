/* Toast stack — transient error / warn / info notifications.
 *
 * Mounted once at app shell level (in layout.tsx), reads the
 * notifications slice, renders a fixed bottom-right stack above the
 * mini-player. Each toast auto-dismisses after 6s; the cleanup
 * clearTimeout is required for React 18 strict-mode double-invoke
 * safety. A dedupe push (same `dedupeKey`) bumps `createdAt`, which
 * re-runs the effect via the [id, createdAt] deps and resets the
 * timer.
 *
 * role="status" on the stack puts it on aria-live polite — screen
 * readers will announce new toasts without interrupting focus. */

import { useEffect } from 'react';
import { useAppDispatch, useAppSelector } from '../store';
import { IconClose, IconWarning, IconCheck } from '../lib/icons';
import { notificationsActions, selectToasts, type Toast } from '../store/notifications-slice';
import { VoiceNudgeToast } from './voice-nudge-toast';
import { retryReviewScript } from '../store/script-review-thunk';

const AUTO_DISMISS_MS = 6000;

export function ToastStack() {
  const toasts = useAppSelector(selectToasts);
  if (toasts.length === 0) return null;
  return (
    <div
      role="status"
      aria-live="polite"
      className="fixed bottom-20 right-6 z-60 flex flex-col gap-2"
    >
      {toasts.map((t) =>
        t.nudge ? <VoiceNudgeToast key={t.id} toast={t} /> : <ToastItem key={t.id} toast={t} />,
      )}
    </div>
  );
}

function ToastItem({ toast }: { toast: Toast }) {
  const dispatch = useAppDispatch();
  useEffect(() => {
    const id = window.setTimeout(() => {
      dispatch(notificationsActions.dismissToast(toast.id));
    }, AUTO_DISMISS_MS);
    return () => window.clearTimeout(id);
    // Effect re-runs when createdAt is bumped by a dedupe push so the
    // timer resets to the new 6s window.
  }, [toast.id, toast.createdAt, dispatch]);

  const kindClass =
    toast.kind === 'error'
      ? 'bg-rose-50 text-rose-900 border-rose-200'
      : toast.kind === 'warn'
        ? 'bg-amber-50 text-amber-900 border-amber-200'
        : 'bg-white text-ink border-ink/10';

  const Icon = toast.kind === 'info' ? IconCheck : IconWarning;

  // fs-58 Task 9 — model_load_failed carries a serializable RetryReview
  // scope (bookId/wholeBook/chapterId/model); retryReviewScript re-reads
  // live sentences/cast/manuscript from the store at click time rather
  // than replaying whatever was current when the error fired.
  const onRetry = () => {
    if (!toast.retryReview) return;
    const { bookId, wholeBook, chapterId, model } = toast.retryReview;
    dispatch(retryReviewScript(bookId, { wholeBook, chapterId, model }));
    dispatch(notificationsActions.dismissToast(toast.id));
  };

  return (
    <div
      className={`flex items-start gap-3 rounded-2xl border px-4 py-3 shadow-card min-w-[280px] max-w-[360px] fade-in ${kindClass}`}
    >
      <Icon className="w-4 h-4 mt-0.5 shrink-0" />
      <p className="flex-1 text-sm leading-snug">{toast.message}</p>
      {toast.retryReview && (
        <button
          type="button"
          onClick={onRetry}
          className="text-sm font-semibold underline shrink-0 min-h-[44px] fine-pointer:min-h-0"
        >
          Retry
        </button>
      )}
      <button
        type="button"
        aria-label="Dismiss notification"
        onClick={() => dispatch(notificationsActions.dismissToast(toast.id))}
        className="p-1 rounded-full hover:bg-ink/10 shrink-0"
      >
        <IconClose className="w-3.5 h-3.5" />
      </button>
    </div>
  );
}
