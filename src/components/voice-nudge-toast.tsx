/* fs-63 — off-roster "Design now" nudge. A sticky toast (no auto-dismiss)
   rendered by ToastStack when a Toast carries a `nudge`. It mirrors the Cast
   view's busy semantics: while a cast-design run is active (any book) the
   action is disabled, so a tap can never silently no-op against the
   single-stream middleware. Tapping enqueues bespoke Qwen design for exactly
   the created characters via the existing designAllRequested pipeline. */

import { useAppDispatch, useAppSelector } from '../store';
import { IconWarning, IconClose } from '../lib/icons';
import { notificationsActions, type Toast } from '../store/notifications-slice';
import { castDesignActions } from '../store/cast-design-slice';

export function VoiceNudgeToast({ toast }: { toast: Toast }) {
  const dispatch = useAppDispatch();
  const designRunning = useAppSelector((s) => s.castDesign.active?.state === 'running');
  const nudge = toast.nudge!;
  const count = nudge.characterIds.length;
  const label = count > 1 ? 'Design all' : 'Design now';
  const message =
    count > 1
      ? `${count} new characters need voices`
      : `New character «${nudge.names[0]}» needs a voice`;

  const onDesign = () => {
    dispatch(
      castDesignActions.designAllRequested({
        bookId: nudge.bookId,
        characterIds: nudge.characterIds,
        modelKey: nudge.modelKey,
        scope: 'bases',
      }),
    );
    dispatch(notificationsActions.dismissToast(toast.id));
  };

  return (
    <div className="flex flex-col gap-2 rounded-2xl border border-ink/10 bg-white px-4 py-3 shadow-card min-w-[280px] max-w-[360px] fade-in text-ink">
      <div className="flex items-start gap-3">
        <IconWarning className="w-4 h-4 mt-0.5 shrink-0" />
        <p className="flex-1 text-sm leading-snug">{message}</p>
        <button
          type="button"
          aria-label="Dismiss notification"
          onClick={() => dispatch(notificationsActions.dismissToast(toast.id))}
          className="p-1 rounded-full hover:bg-ink/10 shrink-0"
        >
          <IconClose className="w-3.5 h-3.5" />
        </button>
      </div>
      <div className="flex items-center gap-2 pl-7">
        <button
          type="button"
          disabled={designRunning}
          onClick={onDesign}
          className="px-3 min-h-[44px] sm:min-h-0 sm:py-1.5 rounded-full bg-ink text-canvas text-sm font-semibold disabled:opacity-40"
        >
          {label}
        </button>
        {designRunning && (
          <span className="text-xs text-ink/55">A voice design is already running…</span>
        )}
      </div>
    </div>
  );
}
