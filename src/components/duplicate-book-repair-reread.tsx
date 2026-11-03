/* #3713 — a tab that was open ACROSS a server restart holds a book id the
   startup sweep may have given to a different folder. Its slices are a snapshot
   of whichever twin it loaded. The server refuses that tab's writes on the id
   until it has re-read the book (repaired-book-gate.ts), so nothing stale can be
   saved; this component makes the re-read happen as soon as the poll shows the
   repair, instead of at the first refused save.
   When a repair first shows up in /api/info after this tab already had an answer
   without it, and the tab's slices hold the repaired `previousBookId` (open, or
   left behind on another view, which keeps them):
     - when the repair record proves the open tab holds the re-minted twin (its
       manuscriptId matches `reassignedManuscriptId`), the tab moves to
       `newBookId` and reads that;
     - otherwise the book is marked for a full read of the id, which takes
       whatever the id names now (and the token that lets the tab write again).
   A repair already in this tab's FIRST /api/info answer needs nothing: the tab
   loaded after the sweep. Renders nothing; mounted beside the repair banner. */

import { useEffect, useRef } from 'react';
import { useStore } from 'react-redux';
import { useAppDispatch } from '../store';
import type { RootState } from '../store';
import { useAppInfo } from '../lib/use-app-info';
import { bookMetaActions } from '../store/book-meta-slice';
import { resetBookSlices } from '../store/reset-book-slices';
import { uiActions } from '../store/ui-slice';

export function DuplicateBookRepairReread() {
  const { info } = useAppInfo();
  const dispatch = useAppDispatch();
  const store = useStore<RootState>();
  const known = useRef<Set<string> | null>(null);

  useEffect(() => {
    if (!info) return;
    const repairs = info.duplicateBookIdRepairs ?? [];
    const keyOf = (r: (typeof repairs)[number]) => `${r.previousBookId}\u0000${r.newBookId}`;
    if (known.current === null) {
      known.current = new Set(repairs.map(keyOf));
      return;
    }
    for (const r of repairs) {
      if (known.current.has(keyOf(r))) continue;
      known.current.add(keyOf(r));
      const state = store.getState();
      const open = (state.ui.stage as { bookId?: string }).bookId;
      if (open !== r.previousBookId && state.manuscript.bookId !== r.previousBookId) continue;
      const holdsLoser =
        open === r.previousBookId &&
        !!r.reassignedManuscriptId &&
        state.manuscript.manuscriptId === r.reassignedManuscriptId;
      if (holdsLoser) {
        resetBookSlices(dispatch, r.newBookId);
        dispatch(uiActions.rebindBook({ from: r.previousBookId, to: r.newBookId }));
        dispatch(bookMetaActions.markNeedsFullRead({ bookId: r.newBookId }));
      } else {
        dispatch(bookMetaActions.markNeedsFullRead({ bookId: r.previousBookId }));
      }
    }
  }, [info, dispatch, store]);

  return null;
}
