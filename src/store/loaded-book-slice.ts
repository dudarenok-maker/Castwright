/* #3519 — the one record of which book the cast, chapters and manuscript
   slices hold, as one pair. It has no actions of its own: it moves only on the
   manuscript slice's identity actions, so it never moves without the
   manuscript hydrate that moves it. The layout dispatches the cast and chapters
   hydrates synchronously after that one, so all of them settle in one tick.

   It describes this tab's in-memory slices, so it is neither persisted (no
   persistReducer wrapper in store/index.ts) nor broadcast cross-tab. */

import { createSlice } from '@reduxjs/toolkit';
import { manuscriptActions } from './manuscript-slice';
import { stageNamesBook } from './open-book';

export interface LoadedBookState {
  loadedBookId: string | null;
  loadedManuscriptId: string | null;
}

const initialState: LoadedBookState = { loadedBookId: null, loadedManuscriptId: null };

export const loadedBookSlice = createSlice({
  name: 'loadedBook',
  initialState,
  reducers: {},
  extraReducers: (builder) => {
    builder
      .addCase(manuscriptActions.hydrateFromBookState, (s, a) => {
        s.loadedBookId = a.payload.state.bookId;
        s.loadedManuscriptId = a.payload.state.manuscriptId;
      })
      .addCase(manuscriptActions.hydrateFromAnalysis, (s, a) => {
        if (a.payload.bookId) s.loadedBookId = a.payload.bookId;
      })
      .addCase(manuscriptActions.resetForBook, (s, a) => {
        s.loadedBookId = a.payload;
        s.loadedManuscriptId = null;
      })
      .addCase(manuscriptActions.uploadComplete, (s, a) => {
        /* The upload's manuscript must never sit beside the previous book's id. */
        s.loadedBookId = null;
        s.loadedManuscriptId = a.payload.manuscriptId;
      })
      /* Also the re-parse and manuscript-replace path: both library handlers in
         routes/index.tsx dispatch `reset` when the slices hold that book. */
      .addCase(manuscriptActions.reset, () => initialState);
  },
});

export const selectLoadedBook = (state: { loadedBook: LoadedBookState }): LoadedBookState =>
  state.loadedBook;

/** The held book, still answered after a page reload: redux-persist restores
    `manuscript.bookId` while the pair is empty until a read lands, so that id
    is read when the pair names no book. The pair wins whenever it names one.

    Only for a caller that must keep treating the restored book as held in that
    window: a guard that refuses or drops a write, a reset of what the slices
    remember of a book, and what a view renders from the restored fields. A
    writer asks `selectHoldsBook` (store/open-book.ts), which says "not held"
    there. Tolerates a partial store. */
export function selectHeldBookId(state: {
  loadedBook?: { loadedBookId: string | null };
  manuscript?: { bookId?: string | null };
}): string | null {
  return state.loadedBook?.loadedBookId ?? state.manuscript?.bookId ?? null;
}

/** Do the slices hold the book the stage names? `null` when it names none. */
export function selectLoadedBookMatchesStage(state: {
  ui: { stage: Parameters<typeof stageNamesBook>[0] };
  loadedBook: LoadedBookState;
}): boolean | null {
  const { loadedBookId, loadedManuscriptId } = state.loadedBook;
  return stageNamesBook(state.ui.stage, {
    bookId: loadedBookId,
    manuscriptId: loadedManuscriptId ?? '',
  });
}

/** Must edits be held back: a Confirm or Ready view over slices that do not
    hold its book. Analysing is left out, as it starts on empty slices and
    grows them. */
export function selectEditsGated(
  state: Parameters<typeof selectLoadedBookMatchesStage>[0],
): boolean {
  const { kind } = state.ui.stage;
  return (kind === 'confirm' || kind === 'ready') && selectLoadedBookMatchesStage(state) === false;
}
