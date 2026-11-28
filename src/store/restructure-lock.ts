/* #3400 pass 7 — the client side of "nothing but the restructure writes a book
   while it restructures". The guard middleware is the backstop; surfaces that
   dispatch a guarded manuscript action, or send a chapter-id-keyed write
   (held / exclude), disable themselves from this selector and check it BEFORE
   their side writes, so a refused edit never resolves review ops, logs a
   `boundary_move`, or closes its modal as done. Tolerates a store without a
   `ui` / `manuscript` / `loadedBook` slice (component tests build partial
   stores). */

import type { RootState } from './index';
import { notificationsActions } from './notifications-slice';
import { selectHeldBookId } from './loaded-book-slice';
import {
  CAST_READ_ONLY_DEDUPE_KEY,
  CAST_READ_ONLY_MESSAGE,
  selectCastReadOnly,
  stageBookId,
} from './book-busy-slice';

export const RESTRUCTURING_REASON = 'Unavailable while the chapters are being restructured.';

/** The server refuses a chapter restructure while an analysis job runs for the
    book (an analysis's final write would undo the remap), so every Restructure
    entry point disables itself with this reason. */
export const ANALYSIS_RUNNING_REASON =
  'Unavailable while an analysis is running. Pause it or wait for it to finish.';

export const RESTRUCTURING_TOAST_KEY = 'restructuring-edit-refused';

export const RESTRUCTURING_TOAST_MESSAGE =
  'The chapters are being restructured. Edits to this book are unavailable until it finishes.';

/** True while the book in scope (the held one, or the open stage's) is being
    restructured. */
export const selectEditsLocked = (s: RootState): boolean => {
  const r = s.ui?.restructuringBooks;
  if (!r) return false;
  const heldBook = selectHeldBookId(s);
  const stageBook = (s.ui?.stage as { bookId?: string } | undefined)?.bookId;
  return !!((heldBook && r[heldBook]) || (stageBook && r[stageBook]));
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

/** #4098 — the manuscript-editing variant. A manuscript edit is also refused
    while the book's cast is read-only (its analysis runs, or the era is latched
    until the re-read): the persistence gate drops the save at build time, so a
    surface that goes on to resolve review ops or log a `boundary_move` would
    record an edit that never landed. Toast only; the controls stay enabled.
    Every surface that dispatches a persisted `manuscript/*` action calls this
    BEFORE its side writes. Restructure keeps its own message and is checked
    first. */
export function refuseIfManuscriptEditsLocked(
  getState: () => RootState,
  dispatch: (a: ReturnType<typeof notificationsActions.pushToast>) => unknown,
  bookId?: string | null,
): boolean {
  if (refuseIfEditsLocked(getState, dispatch, bookId)) return true;
  const state = getState();
  const book = bookId ?? stageBookId(state);
  if (!book || !selectCastReadOnly(state, book)) return false;
  dispatch(
    notificationsActions.pushToast({
      kind: 'error',
      message: CAST_READ_ONLY_MESSAGE,
      dedupeKey: CAST_READ_ONLY_DEDUPE_KEY,
    }),
  );
  return true;
}
