import type { Dispatch } from '@reduxjs/toolkit';
import { castActions } from './cast-slice';
import { chaptersActions } from './chapters-slice';
import { changeLogActions } from './change-log-slice';
import { manuscriptActions } from './manuscript-slice';

/**
 * Reset the per-book slices to an empty book stamped with `bookId` (#3624,
 * #3841). Non-persisted actions only: the reset itself must never PUT (#3376).
 */
export function resetBookSlices(dispatch: Dispatch, bookId: string): void {
  dispatch(manuscriptActions.resetForBook(bookId));
  dispatch(castActions.hydrateCharacters([]));
  dispatch(castActions.setRenderedFallback({}));
  dispatch(castActions.setOrphanedCharacterFallbacks({}));
  dispatch(changeLogActions.hydrateFromBookState(null));
  /* The chapters slice too: Generate and Listen read it with no book check, so
     left alone they'd list B's chapters under A. */
  dispatch(
    chaptersActions.hydrateFromBookState({
      bookId,
      chapters: [],
      completedSlugs: [],
      characters: [],
    }),
  );
}
