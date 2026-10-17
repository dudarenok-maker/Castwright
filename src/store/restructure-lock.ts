/* #3400 pass 7 — the client side of "nothing but the restructure writes a book
   while it restructures". The guard middleware is the backstop; surfaces that
   dispatch a guarded manuscript action, or send a chapter-id-keyed write
   (held / exclude), disable themselves from this selector and check it BEFORE
   their side writes, so a refused edit never resolves review ops, logs a
   `boundary_move`, or closes its modal as done. Tolerates a store without a
   `ui` / `manuscript` slice (component tests build partial stores). */

import type { RootState } from './index';
import { notificationsActions } from './notifications-slice';

export const RESTRUCTURING_REASON = 'Unavailable while the chapters are being restructured.';

export const RESTRUCTURING_TOAST_KEY = 'restructuring-edit-refused';

export const RESTRUCTURING_TOAST_MESSAGE =
  'The chapters are being restructured. Edits to this book are unavailable until it finishes.';

/** True while the book in scope (the loaded manuscript's, or the open stage's)
    is being restructured. */
export const selectEditsLocked = (s: RootState): boolean => {
  const r = s.ui?.restructuringBooks;
  if (!r) return false;
  const manuscriptBook = s.manuscript?.bookId;
  const stageBook = (s.ui?.stage as { bookId?: string } | undefined)?.bookId;
  return !!((manuscriptBook && r[manuscriptBook]) || (stageBook && r[stageBook]));
};

/** True while `bookId` specifically is being restructured — for surfaces that
    name their book (a queue entry, the Generate view's `bookId` prop) rather
    than acting on the one in scope. */
export const selectBookEditsLocked = (s: RootState, bookId: string | null | undefined): boolean =>
  !!bookId && !!s.ui?.restructuringBooks?.[bookId];

/** Caller-side check for use BEFORE any side write. Toasts and returns true
    when the book is restructuring (the caller must then do nothing). Pass
    `bookId` when the surface acts on a named book rather than the one in scope. */
export function refuseIfEditsLocked(
  getState: () => RootState,
  dispatch: (a: ReturnType<typeof notificationsActions.pushToast>) => unknown,
  bookId?: string | null,
): boolean {
  const state = getState();
  if (!(bookId ? selectBookEditsLocked(state, bookId) : selectEditsLocked(state))) return false;
  dispatch(
    notificationsActions.pushToast({
      kind: 'warn',
      message: RESTRUCTURING_TOAST_MESSAGE,
      dedupeKey: RESTRUCTURING_TOAST_KEY,
    }),
  );
  return true;
}
