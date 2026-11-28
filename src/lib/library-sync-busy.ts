/* #4564 (owner decision, PR #4862 review pass 1) — the copy for a Confirm-cast "Sync profile"
   that cannot run because an analysis holds one of its two books. The server's own 409 sentence
   ("This book is busy (analysing)...") is never shown here: it says "this book", which is the
   wrong book when the busy one is the library book. Both strings name the busy book by title. */

export const THIS_BOOK_FALLBACK_TITLE = 'this book';

/** Shown beside a disabled "Sync profile" checkbox. */
export const librarySyncPausedReason = (busyTitle: string): string =>
  `Sync paused — "${busyTitle}" is re-analysing. Available again when it finishes.`;

/** Toast for a sync the server refused with 409 `book_busy` after the screen loaded. */
export const librarySyncBusyToast = (busyTitle: string): string =>
  `Profile sync not applied — "${busyTitle}" is re-analysing. Run the sync again once it finishes.`;
