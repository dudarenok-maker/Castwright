/* #4040 — after a base redesign lands, the server marks every emotion variant
 * minted from the old base stale (book GET / cast PUT / render drop them) on
 * every row sharing that voice key. The open tab only knows about the row it
 * redesigned, so re-read the book and prune the local variants the server no
 * longer carries (`cast/pruneStaleEmotionVariants` — variants only, so unsaved
 * edits to other cast fields survive). Best-effort: a failed read leaves the
 * tab as it was and the next book open reads the truth. The slices hold ONE
 * book, so a read for a book that is no longer open is dropped (open-book.ts). */

import { castActions } from './cast-slice';
import { selectIsOpenBook } from './open-book';
import { api } from '../lib/api';
import type { AppDispatch, RootState } from './index';

export function refreshEmotionVariants(bookId: string) {
  return async (dispatch: AppDispatch, getState: () => RootState): Promise<void> => {
    try {
      const openBook = { manuscriptId: getState().manuscript.manuscriptId as string };
      const res = await api.getBookState(bookId);
      const characters = res?.cast?.characters;
      if (!characters || !selectIsOpenBook(getState(), openBook)) return;
      dispatch(
        castActions.pruneStaleEmotionVariants(
          characters.map((c) => ({ id: c.id, variants: c.overrideTtsVoices?.qwen?.variants })),
        ),
      );
    } catch {
      /* non-fatal — see the header */
    }
  };
}
