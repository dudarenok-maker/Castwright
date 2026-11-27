import { describe, expect, it } from 'vitest';
import { selectIsOpenBook, stageNamesBook } from './open-book';

const A = { bookId: 'b1', manuscriptId: 'm1' };
/* The loaded-book pair and the manuscript slice name the same book unless a
   case passes `manuscriptSliceId` to tell them apart. */
const state = (
  stage: { kind: string; bookId?: string; manuscriptId?: string | null },
  loadedManuscriptId: string | null,
  manuscriptSliceId: string | null = loadedManuscriptId,
) => ({
  ui: { stage },
  manuscript: { manuscriptId: manuscriptSliceId },
  loadedBook: { loadedBookId: null, loadedManuscriptId },
});

describe('stageNamesBook', () => {
  it('compares bookIds when both have one', () => {
    expect(stageNamesBook({ kind: 'ready', bookId: 'b1' }, A)).toBe(true);
    expect(stageNamesBook({ kind: 'ready', bookId: 'b2' }, A)).toBe(false);
  });
  it('falls back to an analysing stage\'s manuscriptId', () => {
    expect(stageNamesBook({ kind: 'analysing', manuscriptId: 'm1' }, { manuscriptId: 'm1' })).toBe(true);
    expect(stageNamesBook({ kind: 'analysing', manuscriptId: 'm2' }, { manuscriptId: 'm1' })).toBe(false);
  });
  it('a stage naming a book this request cannot match is another book; no book named is null', () => {
    expect(stageNamesBook({ kind: 'ready', bookId: 'b2' }, { manuscriptId: 'm1' })).toBe(false);
    expect(stageNamesBook({ kind: 'books' }, A)).toBeNull();
  });
});

/* #3435 (PR #3505 review pass 4) — the slices decide, not the stage: the
   stage moves to a new book at once, the slices only when that book's read
   lands. */
describe('selectIsOpenBook', () => {
  it('true while the stage shows the book and the slices hold it', () => {
    expect(selectIsOpenBook(state({ kind: 'ready', bookId: 'b1' }, 'm1'), A)).toBe(true);
  });
  it('true on a stage with no book while the slices still hold it (the library)', () => {
    expect(selectIsOpenBook(state({ kind: 'books' }, 'm1'), A)).toBe(true);
  });
  it('true once the stage names another book whose read has not landed: the slices still hold this one', () => {
    expect(selectIsOpenBook(state({ kind: 'ready', bookId: 'b2' }, 'm1'), A)).toBe(true);
  });
  it('false once the slices hold another book, even while the stage shows this one', () => {
    expect(selectIsOpenBook(state({ kind: 'books' }, 'm2'), A)).toBe(false);
    expect(selectIsOpenBook(state({ kind: 'analysing', bookId: 'b1', manuscriptId: 'm1' }, 'm2'), A)).toBe(false);
  });
  /* #3519 — the loaded-book pair answers, not the manuscript slice's own id. */
  it("true for the pair's manuscript id, even when the manuscript slice names another", () => {
    expect(selectIsOpenBook(state({ kind: 'books' }, 'm1', 'm2'), A)).toBe(true);
  });
  it('false for a book the pair does not name, even when the manuscript slice names it', () => {
    expect(selectIsOpenBook(state({ kind: 'books' }, 'm2', 'm1'), A)).toBe(false);
  });
  it('false while the pair is null, even when the manuscript slice names the book', () => {
    expect(selectIsOpenBook(state({ kind: 'books' }, null, 'm1'), A)).toBe(false);
  });
});
