/* #3084 F7 — the persistent "reasoning overflow" notification.

   A sticky toast (NO auto-dismiss), rendered by ToastStack when a Toast
   carries `fixes`. It mirrors VoiceNudgeToast's exemption from ToastItem's 6 s
   timer because this is the diagnostic a user needs to act on AFTER the run
   has already failed and they have navigated away from the Analysing view:
   auto-dismissing it would drop the "How to fix" list on the floor. The user
   dismisses it explicitly.

   The stream that pushes it is the analysis-stream middleware, not the
   Analysing view's own fetch — the view's stream aborts on unmount, so a toast
   pushed from there would vanish the moment the user navigates away, which is
   exactly the case this toast exists to cover. */

import { useAppDispatch } from '../store';
import { IconWarning, IconClose } from '../lib/icons';
import { notificationsActions, type Toast } from '../store/notifications-slice';
import { FailureFixList } from './failure-fix-list';

export function ReasoningOverflowToast({ toast }: { toast: Toast }) {
  const dispatch = useAppDispatch();
  const fixes = toast.fixes ?? [];

  return (
    <div className="flex flex-col gap-2 rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3 shadow-card min-w-[280px] max-w-[400px] fade-in text-rose-900">
      <div className="flex items-start gap-3">
        <IconWarning className="w-4 h-4 mt-0.5 shrink-0" />
        <p className="flex-1 text-sm font-semibold leading-snug wrap-break-word">
          {toast.message}
        </p>
        <button
          type="button"
          aria-label="Dismiss notification"
          onClick={() => dispatch(notificationsActions.dismissToast(toast.id))}
          className="p-1 rounded-full hover:bg-ink/10 shrink-0"
        >
          <IconClose className="w-3.5 h-3.5" />
        </button>
      </div>
      {fixes.length > 0 && (
        <div className="pl-7">
          <p className="text-xs font-semibold text-rose-900/80">How to fix:</p>
          <FailureFixList fixes={fixes} className="mt-1 flex flex-col gap-1" />
        </div>
      )}
    </div>
  );
}
