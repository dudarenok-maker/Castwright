/* TDD for Task 13: seeding the Coalfall sample into the standard mock flow.
   After mockLoadSample('the-coalfall-commission'):
   - mockGetLibrary() includes the sample bookId in its flat book list.
   - mockGetBookState(SAMPLE_ID) returns a state where the first real story
     chapter (id 3; ids 1–2 are excluded title/credit pages) has slug in
     completedSlugs → the chapters-slice would hydrate it as state:'done'.
*/
import { describe, it, expect, beforeEach } from 'vitest';
import { mockLoadSample, mockGetLibrary, mockGetBookState, _resetMockSample } from './api';

const SAMPLE_ID = 'castwright__standalones__the-coalfall-commission';

/** Flatten all books across all authors/series in a LibraryResponse. */
function allBooks(lib: Awaited<ReturnType<typeof mockGetLibrary>>) {
  return lib.authors.flatMap((a) => a.series.flatMap((s) => s.books));
}

describe('mock sample is navigable', () => {
  beforeEach(() => _resetMockSample());

  it('loadSample registers the book in the library', async () => {
    await mockLoadSample('the-coalfall-commission');
    const lib = await mockGetLibrary();
    expect(allBooks(lib).some((b) => b.bookId === SAMPLE_ID)).toBe(true);
  });

  it('loadSample is idempotent — calling twice does not duplicate the entry', async () => {
    await mockLoadSample('the-coalfall-commission');
    await mockLoadSample('the-coalfall-commission');
    const lib = await mockGetLibrary();
    const matches = allBooks(lib).filter((b) => b.bookId === SAMPLE_ID);
    expect(matches).toHaveLength(1);
  });

  it('the sample book state exists and has chapter 3 (first story ch) completing-eligible', async () => {
    await mockLoadSample('the-coalfall-commission');
    const state = await mockGetBookState(SAMPLE_ID);
    expect(state).not.toBeNull();
    // Chapter 3 is "Chapter One — The Knock", the first real story chapter
    // (ids 1–2 are excluded title/credit pages).
    const ch3 = state!.state.chapters.find((c) => c.id === 3);
    expect(ch3).toBeDefined();
    // Its slug should be in completedSlugs — that's what hydrateFromBookState
    // uses to set state: 'done' in the chapters slice.
    expect(state!.completedSlugs).toContain(ch3!.slug);
  });

  it('the sample book has a non-null cast', async () => {
    await mockLoadSample('the-coalfall-commission');
    const state = await mockGetBookState(SAMPLE_ID);
    expect(state!.cast).not.toBeNull();
    expect(state!.cast!.characters.length).toBeGreaterThan(0);
  });

  it('after _resetMockSample the library no longer contains the sample', async () => {
    await mockLoadSample('the-coalfall-commission');
    _resetMockSample();
    const lib = await mockGetLibrary();
    expect(allBooks(lib).some((b) => b.bookId === SAMPLE_ID)).toBe(false);
  });

  it('after _resetMockSample getBookState returns null for sample', async () => {
    await mockLoadSample('the-coalfall-commission');
    _resetMockSample();
    const state = await mockGetBookState(SAMPLE_ID);
    expect(state).toBeNull();
  });
});
