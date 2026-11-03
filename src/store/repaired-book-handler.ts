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

/** True when the open stage is one Layout hydrates from disk, for this book. */
function stageShows(state: unknown, bookId: string): boolean {
  const stage = (state as { ui?: { stage?: { kind?: string; bookId?: string } } }).ui?.stage;
  return (
    (stage?.kind === 'analysing' || stage?.kind === 'confirm' || stage?.kind === 'ready') && stage.bookId === bookId
  );
}

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
        /* Only a book the STAGE shows gets its token from the full read the mark above
           triggers (Layout reads on analysing/confirm/ready only). Any other book is read
           here so the user's retry (Library delete, rename) carries the token: a tab on the
           Library whose slices still hold the book has no read coming, and would otherwise
           be refused on every retry. */
        if (stageShows(store.getState(), bookId)) return;
        await api.getBookState(bookId);
        commitBookReadToken(bookId);
      })
      .catch((err) => console.warn('[repaired-book] re-read failed', err));
  });
}
