/* #3435 (PR #3505 review pass 3) — which book a late analysis result may
   write into. A subset run (a Retry on the analysing view, an Include or a
   Re-analyse on the Generate view) is a request that outlives its view: by
   the time it settles the user may be on another book. The cast, chapters and
   manuscript slices hold ONE book at a time, and the persistence middleware
   saves them into whichever book the stage names, so a write into another
   book's slices ends up in that book's files on its next edit. The server has
   already persisted the result; the next open of the book reads it from
   disk. */

export interface BookRef {
  bookId?: string | null;
  manuscriptId: string;
}

interface StageLike {
  kind: string;
  bookId?: string;
  manuscriptId?: string | null;
}

/* Does the stage name this book? `true`/`false` when it names a book (by
   bookId when both have one, else an analysing stage's manuscriptId), `null`
   when it names none (the library, settings, ...). */
export function stageNamesBook(stage: StageLike, book: BookRef): boolean | null {
  if (stage.bookId && book.bookId) return stage.bookId === book.bookId;
  if (stage.kind === 'analysing' && stage.manuscriptId) return stage.manuscriptId === book.manuscriptId;
  if (stage.bookId) return false;
  return null;
}

/* Is this book the open one: the book the slices hold, and not one the stage
   has moved away from? A stage that names no book leaves the slices as they
   were — and a return to the same book does not reload them — so the write
   still applies there. A stage that names another book before that book's
   hydrate lands does not. */
export function selectIsOpenBook(
  state: { ui: { stage: StageLike }; manuscript: { manuscriptId: string | null } },
  book: BookRef,
): boolean {
  if (stageNamesBook(state.ui.stage, book) === false) return false;
  return state.manuscript.manuscriptId === book.manuscriptId;
}
