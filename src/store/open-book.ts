/* #3435 (PR #3505 review passes 3-4) — which book a late analysis result
   may write into. A subset run (a Retry on the analysing view, an Include or a
   Re-analyse on the Generate view) is a request that outlives its view: by
   the time it settles the user may be on another book. The cast, chapters and
   manuscript slices hold ONE book at a time, and the persistence middleware
   saves them into whichever book the stage names, so a write into another
   book's slices ends up in that book's files on its next edit.

   The slices decide, not the stage: the stage names a new book at once, the
   slices move only when that book's read lands (the layout hydrates all
   three together). A result for the book the slices hold lands in them, even
   once the stage has moved on, because the layout will not reload them on
   the way back. A result for any other book is skipped; the server has
   already persisted it, and since the slices hold another book the layout's
   next open of this one is a full read from disk. */

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

/* Is this book the open one: the book the cast, chapters and manuscript
   slices hold, whatever the stage shows. The manuscript slice's manuscriptId
   names that book: the layout's hydrate sets it together with the cast and
   chapters. */
export function selectIsOpenBook(
  state: { manuscript: { manuscriptId: string | null } },
  book: BookRef,
): boolean {
  return state.manuscript.manuscriptId === book.manuscriptId;
}
