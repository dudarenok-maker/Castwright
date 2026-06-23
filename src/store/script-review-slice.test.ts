import { describe, it, expect } from 'vitest';
import { configureStore } from '@reduxjs/toolkit';
import {
  scriptReviewSlice,
  scriptReviewActions,
  selectActiveReview,
  opKey,
  type ReviewOpWithChapter,
} from './script-review-slice';

// ---------------------------------------------------------------------------
// Minimal test store — includes only scriptReview so tests don't depend on
// the full store shape (avoids redux-persist / env complications).
// ---------------------------------------------------------------------------
function makeStore() {
  return configureStore({
    reducer: { scriptReview: scriptReviewSlice.reducer },
  });
}

type TestStore = ReturnType<typeof makeStore>;
type TestState = ReturnType<TestStore['getState']>;

// Re-wire selectActiveReview against the test store's state shape.
function selectReview(state: TestState, bookId: string) {
  // Cast: the test store has only scriptReview, which matches the key the
  // selector reads. Use 'as any' to satisfy the full RootState type param
  // without pulling in the real store (which has side-effects).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return selectActiveReview(state as any, bookId);
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------
const op1: ReviewOpWithChapter = {
  id: 1,
  op: 'strip_tag',
  newText: 'Hello',
  rationale: 'remove tag',
  chapterId: 10,
};
const op2: ReviewOpWithChapter = {
  id: 2,
  op: 'fix_emotion',
  emotion: 'angry',
  rationale: 'wrong tone',
  chapterId: 10,
};
const op3: ReviewOpWithChapter = {
  id: 3,
  op: 'strip_tag',
  newText: 'World',
  rationale: 'another tag',
  chapterId: 11,
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe('scriptReviewSlice', () => {
  it('setReview defaults all selected ON', () => {
    const store = makeStore();
    store.dispatch(
      scriptReviewActions.setReview({
        bookId: 'book-a',
        ops: [op1, op2],
        unappliable: [],
      }),
    );
    const bucket = selectReview(store.getState(), 'book-a');
    expect(bucket).toBeDefined();
    expect(bucket!.selected[opKey(10, 1, 'strip_tag')]).toBe(true);
    expect(bucket!.selected[opKey(10, 2, 'fix_emotion')]).toBe(true);
    // Every key is true
    expect(Object.values(bucket!.selected).every(Boolean)).toBe(true);
  });

  it('selectActiveReview returns only the requested book bucket', () => {
    const store = makeStore();
    store.dispatch(
      scriptReviewActions.setReview({ bookId: 'book-a', ops: [op1], unappliable: [] }),
    );
    store.dispatch(
      scriptReviewActions.setReview({ bookId: 'book-b', ops: [op2], unappliable: [] }),
    );
    const a = selectReview(store.getState(), 'book-a');
    const b = selectReview(store.getState(), 'book-b');
    expect(a!.ops).toHaveLength(1);
    expect(a!.ops[0].id).toBe(1);
    expect(b!.ops).toHaveLength(1);
    expect(b!.ops[0].id).toBe(2);
  });

  it("a second book's setReview does NOT wipe the first book's bucket", () => {
    const store = makeStore();
    store.dispatch(
      scriptReviewActions.setReview({ bookId: 'book-a', ops: [op1], unappliable: [] }),
    );
    store.dispatch(
      scriptReviewActions.setReview({ bookId: 'book-b', ops: [op2], unappliable: [] }),
    );
    // book-a must still be intact
    const a = selectReview(store.getState(), 'book-a');
    expect(a).toBeDefined();
    expect(a!.ops[0].id).toBe(1);
  });

  it('toggleClass flips all ops of one class and ONLY that class', () => {
    const store = makeStore();
    // op1 + op3 are both 'strip_tag'; op2 is 'fix_emotion'
    store.dispatch(
      scriptReviewActions.setReview({
        bookId: 'book-a',
        ops: [op1, op2, op3],
        unappliable: [],
      }),
    );
    // All start true. Toggle strip_tag → both should become false.
    store.dispatch(scriptReviewActions.toggleClass({ bookId: 'book-a', op: 'strip_tag' }));
    const after1 = selectReview(store.getState(), 'book-a')!;
    expect(after1.selected[opKey(10, 1, 'strip_tag')]).toBe(false);
    expect(after1.selected[opKey(11, 3, 'strip_tag')]).toBe(false);
    // fix_emotion must remain true (different class)
    expect(after1.selected[opKey(10, 2, 'fix_emotion')]).toBe(true);

    // Toggle strip_tag again → both should become true again.
    store.dispatch(scriptReviewActions.toggleClass({ bookId: 'book-a', op: 'strip_tag' }));
    const after2 = selectReview(store.getState(), 'book-a')!;
    expect(after2.selected[opKey(10, 1, 'strip_tag')]).toBe(true);
    expect(after2.selected[opKey(11, 3, 'strip_tag')]).toBe(true);
    expect(after2.selected[opKey(10, 2, 'fix_emotion')]).toBe(true);
  });

  it('toggleOp flips a single op without touching others', () => {
    const store = makeStore();
    store.dispatch(
      scriptReviewActions.setReview({ bookId: 'book-a', ops: [op1, op2], unappliable: [] }),
    );
    const key1 = opKey(10, 1, 'strip_tag');
    const key2 = opKey(10, 2, 'fix_emotion');
    store.dispatch(scriptReviewActions.toggleOp({ bookId: 'book-a', key: key1 }));
    const s = selectReview(store.getState(), 'book-a')!;
    expect(s.selected[key1]).toBe(false);
    expect(s.selected[key2]).toBe(true);
  });

  it('clearReview removes the book bucket', () => {
    const store = makeStore();
    store.dispatch(
      scriptReviewActions.setReview({ bookId: 'book-a', ops: [op1], unappliable: [] }),
    );
    expect(selectReview(store.getState(), 'book-a')).toBeDefined();
    store.dispatch(scriptReviewActions.clearReview({ bookId: 'book-a' }));
    expect(selectReview(store.getState(), 'book-a')).toBeUndefined();
  });

  it('unappliable is stored and accessible', () => {
    const store = makeStore();
    const unappliableOp: ReviewOpWithChapter = {
      id: 99,
      op: 'strip_tag',
      newText: 'test',
      rationale: 'test',
      chapterId: 10,
    };
    store.dispatch(
      scriptReviewActions.setReview({
        bookId: 'book-a',
        ops: [op1],
        unappliable: [{ op: unappliableOp, reason: 'anchor not found' }],
      }),
    );
    const bucket = selectReview(store.getState(), 'book-a');
    expect(bucket!.unappliable).toHaveLength(1);
    expect(bucket!.unappliable[0].op.id).toBe(99);
    expect(bucket!.unappliable[0].reason).toBe('anchor not found');
  });

  it('toggleClass isolates to the target book (cross-book test)', () => {
    const store = makeStore();
    store.dispatch(
      scriptReviewActions.setReview({
        bookId: 'book-a',
        ops: [op1, op2],
        unappliable: [],
      }),
    );
    store.dispatch(
      scriptReviewActions.setReview({
        bookId: 'book-b',
        ops: [op3],
        unappliable: [],
      }),
    );
    const bookBBefore = selectReview(store.getState(), 'book-b')!;
    const bookBSelectedBefore = { ...bookBBefore.selected };

    // Toggle strip_tag on book-a
    store.dispatch(scriptReviewActions.toggleClass({ bookId: 'book-a', op: 'strip_tag' }));

    // book-b's selected map should be identical
    const bookBAfter = selectReview(store.getState(), 'book-b')!;
    expect(bookBAfter.selected).toEqual(bookBSelectedBefore);
  });

  it('toggleOp isolates to the target book (cross-book test)', () => {
    const store = makeStore();
    store.dispatch(
      scriptReviewActions.setReview({
        bookId: 'book-a',
        ops: [op1],
        unappliable: [],
      }),
    );
    store.dispatch(
      scriptReviewActions.setReview({
        bookId: 'book-b',
        ops: [op2],
        unappliable: [],
      }),
    );
    const bookBBefore = selectReview(store.getState(), 'book-b')!;
    const bookBSelectedBefore = { ...bookBBefore.selected };

    // Toggle op on book-a
    store.dispatch(
      scriptReviewActions.toggleOp({
        bookId: 'book-a',
        key: opKey(10, 1, 'strip_tag'),
      }),
    );

    // book-b's selected map should be identical
    const bookBAfter = selectReview(store.getState(), 'book-b')!;
    expect(bookBAfter.selected).toEqual(bookBSelectedBefore);
  });

  it('toggleOp ignores an unknown key (defensive guard)', () => {
    const store = makeStore();
    store.dispatch(
      scriptReviewActions.setReview({
        bookId: 'book-a',
        ops: [op1, op2],
        unappliable: [],
      }),
    );
    const beforeToggle = selectReview(store.getState(), 'book-a')!;
    const selectedBefore = { ...beforeToggle.selected };

    // Try to toggle a key that was never in the ops
    store.dispatch(
      scriptReviewActions.toggleOp({
        bookId: 'book-a',
        key: 'nonexistent:99:strip_tag',
      }),
    );

    // The nonexistent key should NOT be created; all existing keys untouched
    const afterToggle = selectReview(store.getState(), 'book-a')!;
    expect('nonexistent:99:strip_tag' in afterToggle.selected).toBe(false);
    expect(afterToggle.selected).toEqual(selectedBefore);
  });
});
