/* #3713 / PR #4004 pass 2 — what the app does when the server refuses a write
   because the book's id was repaired after this page loaded it
   (`book_repaired_reload`, see lib/book-read-token.ts): the snapshot this tab holds
   may belong to the other twin, so it is discarded and re-read, the Library rows
   (which may still point at the id's old owner) are refreshed, and the user is told
   once that the edit was not saved. Installed post-creation like the voice-library
   focus listener, since it needs the live store. */

import type { Store } from '@reduxjs/toolkit';
import { api } from '../lib/api';
import { commitBookReadToken, setRepairedBookHandler } from '../lib/book-read-token';
import { bookMetaActions } from './book-meta-slice';
import { libraryActions } from './library-slice';
import { notificationsActions } from './notifications-slice';

export const BOOK_REPAIRED_MESSAGE =
  'This book was repaired after a duplicate id was found, so your last change was not saved. Reloading it now.';

export function installRepairedBookHandler(store: Pick<Store, 'dispatch' | 'getState'>): void {
  setRepairedBookHandler((bookId) => {
    store.dispatch(
      notificationsActions.pushToast({ kind: 'error', message: BOOK_REPAIRED_MESSAGE, dedupeKey: `book-repaired:${bookId}` }),
    );
    store.dispatch(bookMetaActions.markNeedsFullRead({ bookId }));
    api
      .getLibrary()
      .then(async (res) => {
        store.dispatch(libraryActions.hydrate(res));
        /* A book these slices do not hold has no snapshot to be stale: read it so
           the user's retry (Library delete, rename) carries the token. A book they
           DO hold gets its token from the full read the mark above triggers. */
        if ((store.getState() as { manuscript: { bookId: string | null } }).manuscript.bookId === bookId) return;
        await api.getBookState(bookId);
        commitBookReadToken(bookId);
      })
      .catch((err) => console.warn('[repaired-book] re-read failed', err));
  });
}
