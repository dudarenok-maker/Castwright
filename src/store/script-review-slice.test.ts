import { describe, it, expect } from 'vitest';
import { configureStore } from '@reduxjs/toolkit';
import {
  scriptReviewSlice,
  scriptReviewActions,
  selectActiveReview,
  selectVisibleReview,
  opKey,
  type ReviewOpWithChapter,
} from './script-review-slice';
import type { RootState } from './index';
import type { SubstageEntry } from './prosody-slice';

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
  // selector reads. Cast to satisfy the full RootState type param without
  // pulling in the real store (which has side-effects).
  return selectActiveReview(state as never, bookId);
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

  it('seeds reattribute + flag_nonstory deselected, others selected (fs-58 Unit B)', () => {
    const ops = [
      { chapterId: 1, id: 1, op: 'strip_tag', rationale: 'r' },
      { chapterId: 1, id: 2, op: 'reattribute', characterId: 'ferra', rationale: 'r' },
      { chapterId: 1, id: 3, op: 'flag_nonstory', rationale: 'r' },
    ] as any;
    const s = scriptReviewSlice.reducer(
      { byBook: {}, activeStreams: {} },
      scriptReviewActions.setReview({ bookId: 'b1', ops, unappliable: [] }),
    );
    const b = s.byBook['b1']!;
    expect(b.selected['1:1:strip_tag']).toBe(true);
    expect(b.selected['1:2:reattribute']).toBe(false);
    expect(b.selected['1:3:flag_nonstory']).toBe(false);
  });

  it('validate_instruct toggles via opKey/toggleClass like any other class (fs-58, #1041)', () => {
    // Characterization: the slice is op-agnostic — toggleClass/opKey key on op.op,
    // so a 6th class `validate_instruct` behaves identically to the existing five
    // with no slice change. This locks that behaviour.
    const viOp: ReviewOpWithChapter = {
      id: 7,
      op: 'validate_instruct',
      newInstruct: 'a calm tone',
      rationale: 'contradicts the line',
      chapterId: 12,
    };
    const store = makeStore();
    // Seed alongside a strip_tag op so we can assert class isolation too.
    store.dispatch(
      scriptReviewActions.setReview({
        bookId: 'book-a',
        ops: [op1, viOp],
        unappliable: [],
      }),
    );
    const key = opKey(12, 7, 'validate_instruct');
    // setReview defaults the validate_instruct op selected ON.
    expect(selectReview(store.getState(), 'book-a')!.selected[key]).toBe(true);

    // toggleClass flips ONLY validate_instruct off; strip_tag stays on.
    store.dispatch(
      scriptReviewActions.toggleClass({ bookId: 'book-a', op: 'validate_instruct' }),
    );
    const after1 = selectReview(store.getState(), 'book-a')!;
    expect(after1.selected[key]).toBe(false);
    expect(after1.selected[opKey(10, 1, 'strip_tag')]).toBe(true);

    // toggleClass again flips it back on.
    store.dispatch(
      scriptReviewActions.toggleClass({ bookId: 'book-a', op: 'validate_instruct' }),
    );
    expect(selectReview(store.getState(), 'book-a')!.selected[key]).toBe(true);

    // toggleOp flips the single validate_instruct op by key.
    store.dispatch(scriptReviewActions.toggleOp({ bookId: 'book-a', key }));
    expect(selectReview(store.getState(), 'book-a')!.selected[key]).toBe(false);
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

describe('script-review-slice activeStreams', () => {
  const reduceR = (actions: { type: string; payload?: unknown }[]) =>
    actions.reduce((s, a) => scriptReviewSlice.reducer(s, a), scriptReviewSlice.getInitialState());

  it('setActive/updateProgress/clear are per-book', () => {
    const s = reduceR([
      scriptReviewActions.setActive({ bookId: 'b1', progress: 0, label: 'Reviewing' }),
      scriptReviewActions.setActive({ bookId: 'b2', progress: 0, label: 'Reviewing' }),
      scriptReviewActions.updateProgress({ bookId: 'b1', progress: 0.6 }),
      scriptReviewActions.clear({ bookId: 'b2' }),
    ]);
    expect(s.activeStreams.b1).toEqual<SubstageEntry>({ progress: 60, label: 'Reviewing' });
    expect(s.activeStreams.b2).toBeUndefined();
  });

  it('applyExternalSet/applyExternalClear touch only the named key', () => {
    const s1 = reduceR([scriptReviewActions.applyExternalSet({ bookId: 'bX', entry: { progress: 10, label: 'Reviewing' } })]);
    expect(s1.activeStreams.bX).toEqual({ progress: 10, label: 'Reviewing' });
    const s2 = scriptReviewSlice.reducer(s1, scriptReviewActions.applyExternalClear({ bookId: 'bX' }));
    expect(s2.activeStreams.bX).toBeUndefined();
  });

  it('setActive/updateProgress store and update chapterIndex/totalChapters/estRemainingMs', () => {
    const s = reduceR([
      scriptReviewActions.setActive({
        bookId: 'b1',
        progress: 0,
        label: 'Reviewing script',
        chapterIndex: 1,
        totalChapters: 3,
      }),
      scriptReviewActions.updateProgress({
        bookId: 'b1',
        progress: 0.5,
        chapterIndex: 2,
        totalChapters: 3,
        estRemainingMs: 20_000,
      }),
    ]);
    expect(s.activeStreams.b1).toEqual<SubstageEntry>({
      progress: 50,
      label: 'Reviewing script',
      chapterIndex: 2,
      totalChapters: 3,
      estRemainingMs: 20_000,
    });
  });
});

function makeOp(id: number, op: string, chapterId = 1) {
  return { id, op, chapterId, rationale: 'r' } as never;
}

describe('script-review-slice — hide vs discard', () => {
  it('setReview always sets visible:true and stores manuscriptId/version', () => {
    const state = scriptReviewSlice.reducer(
      undefined,
      scriptReviewActions.setReview({ bookId: 'b1', ops: [makeOp(1, 'strip_tag')], unappliable: [], manuscriptId: 'ms-1', versionByChapter: { 1: 3 } }),
    );
    expect(state.byBook['b1']?.visible).toBe(true);
    expect(state.byBook['b1']?.manuscriptId).toBe('ms-1');
    expect(state.byBook['b1']?.versionByChapter).toEqual({ 1: 3 });
  });

  it('hideReview flips visible to false without touching ops/selected', () => {
    let state = scriptReviewSlice.reducer(
      undefined,
      scriptReviewActions.setReview({ bookId: 'b1', ops: [makeOp(1, 'strip_tag')], unappliable: [], manuscriptId: 'ms-1', versionByChapter: { 1: 1 } }),
    );
    state = scriptReviewSlice.reducer(state, scriptReviewActions.hideReview({ bookId: 'b1' }));
    expect(state.byBook['b1']?.visible).toBe(false);
    expect(state.byBook['b1']?.ops).toHaveLength(1);
  });

  it('showReview flips visible back to true', () => {
    let state = scriptReviewSlice.reducer(
      undefined,
      scriptReviewActions.setReview({ bookId: 'b1', ops: [], unappliable: [], manuscriptId: 'ms-1', versionByChapter: { 1: 1 } }),
    );
    state = scriptReviewSlice.reducer(state, scriptReviewActions.hideReview({ bookId: 'b1' }));
    state = scriptReviewSlice.reducer(state, scriptReviewActions.showReview({ bookId: 'b1' }));
    expect(state.byBook['b1']?.visible).toBe(true);
  });

  it('resolveOpsLocally removes named ops and deletes the bucket once empty', () => {
    let state = scriptReviewSlice.reducer(
      undefined,
      scriptReviewActions.setReview({
        bookId: 'b1',
        ops: [makeOp(1, 'strip_tag'), makeOp(2, 'fix_emotion')],
        unappliable: [],
        manuscriptId: 'ms-1',
        versionByChapter: { 1: 1 },
      }),
    );
    state = scriptReviewSlice.reducer(state, scriptReviewActions.resolveOpsLocally({ bookId: 'b1', opKeys: [opKey(1, 1, 'strip_tag')] }));
    expect(state.byBook['b1']?.ops).toHaveLength(1);
    state = scriptReviewSlice.reducer(state, scriptReviewActions.resolveOpsLocally({ bookId: 'b1', opKeys: [opKey(1, 2, 'fix_emotion')] }));
    expect(state.byBook['b1']).toBeUndefined();
  });

  /* Round-3 review Important Finding 4 — resolveOpsLocally only checked
     `bucket.ops.length === 0` before deleting the whole bucket, ignoring
     `bucket.unappliable` — which can still have genuinely-pending findings
     (e.g. a reattribute whose target is currently invalid) that were never
     included in appliedOpKeys and are still sitting unresolved in the
     server ledger too. The bucket must survive until BOTH are empty. */
  it('resolveOpsLocally does NOT delete the bucket when unappliable findings remain, even once ops empties', () => {
    const staleOp = makeOp(99, 'reattribute');
    let state = scriptReviewSlice.reducer(
      undefined,
      scriptReviewActions.setReview({
        bookId: 'b1',
        ops: [makeOp(1, 'strip_tag')],
        unappliable: [{ op: staleOp, reason: 'stale id' }],
        manuscriptId: 'ms-1',
        versionByChapter: { 1: 1 },
      }),
    );
    expect(state.byBook['b1']?.ops).toHaveLength(1);
    expect(state.byBook['b1']?.unappliable).toHaveLength(1);

    // Resolve the ONLY appliable op — ops empties, but the unappliable
    // finding is still genuinely pending.
    state = scriptReviewSlice.reducer(state, scriptReviewActions.resolveOpsLocally({ bookId: 'b1', opKeys: [opKey(1, 1, 'strip_tag')] }));

    expect(state.byBook['b1']).toBeDefined();
    expect(state.byBook['b1']?.ops).toHaveLength(0);
    expect(state.byBook['b1']?.unappliable).toHaveLength(1);
    expect(state.byBook['b1']?.unappliable[0].op.id).toBe(99);
  });

  it('selectVisibleReview returns undefined when the bucket is hidden, selectActiveReview still returns it', () => {
    let state = scriptReviewSlice.reducer(
      undefined,
      scriptReviewActions.setReview({ bookId: 'b1', ops: [], unappliable: [], manuscriptId: 'ms-1', versionByChapter: { 1: 1 } }),
    );
    state = scriptReviewSlice.reducer(state, scriptReviewActions.hideReview({ bookId: 'b1' }));
    const root = { scriptReview: state } as unknown as RootState;
    expect(selectVisibleReview(root, 'b1')).toBeUndefined();
    expect(selectActiveReview(root, 'b1')).toBeDefined();
  });
});

/* Whole-branch review Critical Finding 1 + Important Finding 2 regression
   tests. Persistence (Tasks 8/10) turned the per-book bucket into a
   multi-chapter aggregate of every unresolved chapter — setReview and
   hydrateBucket both used to do a whole-bucket replace, which was correct
   under the pre-persistence "one review's worth of chapters" model but
   silently destroyed data once the bucket started spanning many chapters. */
describe('script-review-slice — bucket merge preserves other chapters (Finding 1)', () => {
  it('a single-chapter setReview run does not wipe other chapters still sitting in the bucket', () => {
    // Seed the bucket as if an earlier whole-book run left chapters 1 and 2
    // with unresolved findings.
    let state = scriptReviewSlice.reducer(
      undefined,
      scriptReviewActions.setReview({
        bookId: 'b1',
        ops: [makeOp(1, 'strip_tag', 1), makeOp(2, 'strip_tag', 2)],
        unappliable: [],
        manuscriptId: 'ms-1',
        versionByChapter: { 1: 1, 2: 1 },
      }),
    );
    expect(state.byBook['b1']!.ops.map((o) => o.chapterId).sort()).toEqual([1, 2]);

    // The user reviews chapter 3 only — this is the exact scenario from the
    // whole-branch review: the gate saw 0 unresolved for [3] and proceeded,
    // and the run's completion must not blow away chapters 1/2.
    state = scriptReviewSlice.reducer(
      state,
      scriptReviewActions.setReview({
        bookId: 'b1',
        ops: [makeOp(3, 'strip_tag', 3)],
        unappliable: [],
        manuscriptId: 'ms-1',
        versionByChapter: { 3: 1 },
      }),
    );

    const bucket = state.byBook['b1']!;
    expect(bucket.ops.map((o) => o.chapterId).sort()).toEqual([1, 2, 3]);
    expect(bucket.versionByChapter).toEqual({ 1: 1, 2: 1, 3: 1 });
  });

  it('re-running a chapter that already had ops supersedes only that chapter, leaving other chapters untouched', () => {
    let state = scriptReviewSlice.reducer(
      undefined,
      scriptReviewActions.setReview({
        bookId: 'b1',
        ops: [makeOp(1, 'strip_tag', 1), makeOp(2, 'strip_tag', 2)],
        unappliable: [],
        manuscriptId: 'ms-1',
        versionByChapter: { 1: 1, 2: 1 },
      }),
    );
    // Re-run chapter 1 only, producing a new op set and a bumped version.
    state = scriptReviewSlice.reducer(
      state,
      scriptReviewActions.setReview({
        bookId: 'b1',
        ops: [makeOp(9, 'fix_emotion', 1)],
        unappliable: [],
        manuscriptId: 'ms-1',
        versionByChapter: { 1: 2 },
      }),
    );
    const bucket = state.byBook['b1']!;
    // Chapter 1's old op (id 1) is superseded by the new one (id 9);
    // chapter 2's op (id 2) survives untouched.
    expect(bucket.ops.map((o) => o.id).sort()).toEqual([2, 9]);
    expect(bucket.versionByChapter).toEqual({ 1: 2, 2: 1 });
  });

  it('setReview drops the whole prior bucket when manuscriptId changes (reparse mid-session)', () => {
    let state = scriptReviewSlice.reducer(
      undefined,
      scriptReviewActions.setReview({
        bookId: 'b1',
        ops: [makeOp(1, 'strip_tag', 1), makeOp(2, 'strip_tag', 2)],
        unappliable: [],
        manuscriptId: 'ms-old',
        versionByChapter: { 1: 1, 2: 1 },
      }),
    );
    state = scriptReviewSlice.reducer(
      state,
      scriptReviewActions.setReview({
        bookId: 'b1',
        ops: [makeOp(9, 'strip_tag', 3)],
        unappliable: [],
        manuscriptId: 'ms-new',
        versionByChapter: { 3: 1 },
      }),
    );
    const bucket = state.byBook['b1']!;
    // The old manuscript's chapters (1, 2) are NOT preserved — a reparse
    // invalidates every sentence id they referenced.
    expect(bucket.ops.map((o) => o.id)).toEqual([9]);
    expect(bucket.manuscriptId).toBe('ms-new');
  });
});

describe('script-review-slice — hydrateBucket preserves visibility (Finding 2)', () => {
  it('hydrateBucket does not force a hidden bucket back to visible on remount', () => {
    let state = scriptReviewSlice.reducer(
      undefined,
      scriptReviewActions.setReview({
        bookId: 'b1',
        ops: [makeOp(1, 'strip_tag')],
        unappliable: [],
        manuscriptId: 'ms-1',
        versionByChapter: { 1: 1 },
      }),
    );
    // User closes the modal via the X / backdrop.
    state = scriptReviewSlice.reducer(state, scriptReviewActions.hideReview({ bookId: 'b1' }));
    expect(state.byBook['b1']!.visible).toBe(false);

    // Navigate away and back — ManuscriptView remounts and re-hydrates from
    // the still-unresolved ledger entries.
    state = scriptReviewSlice.reducer(
      state,
      scriptReviewActions.hydrateBucket({
        bookId: 'b1',
        ops: [makeOp(1, 'strip_tag')],
        unappliable: [],
        manuscriptId: 'ms-1',
        versionByChapter: { 1: 1 },
        selected: { '1:1:strip_tag': true },
      }),
    );
    expect(state.byBook['b1']!.visible).toBe(false);
  });

  it('hydrateBucket defaults visible:true when no bucket previously existed', () => {
    const state = scriptReviewSlice.reducer(
      undefined,
      scriptReviewActions.hydrateBucket({
        bookId: 'b1',
        ops: [makeOp(1, 'strip_tag')],
        unappliable: [],
        manuscriptId: 'ms-1',
        versionByChapter: { 1: 1 },
        selected: { '1:1:strip_tag': true },
      }),
    );
    expect(state.byBook['b1']!.visible).toBe(true);
  });
});

/* Round-2 review Critical Finding 1 regression test. discardReview's scoped
   server call (only the named chapters' ledger entries) was previously
   paired with a whole-bucket removeBucket dispatch — a partial-chapter
   discard (e.g. the re-run confirm gate discarding just one chapter of a
   whole-book review) wiped every OTHER chapter's still-server-persisted
   findings out of the client view. removeChaptersLocally is the scoped
   client-side mirror of the scoped server /discard call. */
describe('script-review-slice — removeChaptersLocally scopes to the given chapters (round-2 Finding 1)', () => {
  it('removes only the named chapter, leaving other chapters (ops/selected/versionByChapter) intact', () => {
    let state = scriptReviewSlice.reducer(
      undefined,
      scriptReviewActions.setReview({
        bookId: 'b1',
        ops: [makeOp(1, 'strip_tag', 1), makeOp(2, 'fix_emotion', 2)],
        unappliable: [{ op: makeOp(3, 'strip_tag', 1), reason: 'stale id' }],
        manuscriptId: 'ms-1',
        versionByChapter: { 1: 1, 2: 5 },
      }),
    );
    // Deselect chapter 2's op so we can also assert `selected` survives with
    // its actual (non-default) value, not just its presence.
    state = scriptReviewSlice.reducer(state, scriptReviewActions.toggleOp({ bookId: 'b1', key: opKey(2, 2, 'fix_emotion') }));
    expect(state.byBook['b1']!.selected[opKey(2, 2, 'fix_emotion')]).toBe(false);

    state = scriptReviewSlice.reducer(
      state,
      scriptReviewActions.removeChaptersLocally({ bookId: 'b1', chapterIds: [1] }),
    );

    const bucket = state.byBook['b1'];
    expect(bucket).toBeDefined();
    // Chapter 1's op and unappliable entry are gone.
    expect(bucket!.ops.map((o) => o.chapterId)).toEqual([2]);
    expect(bucket!.unappliable).toHaveLength(0);
    expect(bucket!.versionByChapter).toEqual({ 2: 5 });
    // Chapter 1's selected key is gone; chapter 2's survives with its value.
    expect(opKey(1, 1, 'strip_tag') in bucket!.selected).toBe(false);
    expect(bucket!.selected[opKey(2, 2, 'fix_emotion')]).toBe(false);
  });

  it('deletes the whole bucket once every remaining chapter is removed', () => {
    let state = scriptReviewSlice.reducer(
      undefined,
      scriptReviewActions.setReview({
        bookId: 'b1',
        ops: [makeOp(1, 'strip_tag', 1), makeOp(2, 'fix_emotion', 2)],
        unappliable: [],
        manuscriptId: 'ms-1',
        versionByChapter: { 1: 1, 2: 5 },
      }),
    );
    state = scriptReviewSlice.reducer(
      state,
      scriptReviewActions.removeChaptersLocally({ bookId: 'b1', chapterIds: [1, 2] }),
    );
    expect(state.byBook['b1']).toBeUndefined();
  });

  it('is a no-op when the bucket does not exist', () => {
    const state = scriptReviewSlice.reducer(
      undefined,
      scriptReviewActions.removeChaptersLocally({ bookId: 'b1', chapterIds: [1] }),
    );
    expect(state.byBook['b1']).toBeUndefined();
  });

  /* Round-4 review Finding 1 — removeChaptersLocally's bucket-deletion
     condition only checked `bucket.ops.length === 0`, unlike its sibling
     resolveOpsLocally (fixed in round 3, see the test above) which
     correctly requires BOTH arrays empty. A chapter left with only an
     unappliable finding (e.g. a stale-id reattribute) after removing OTHER
     chapters would incorrectly delete the whole bucket, silently hiding a
     still-server-persisted finding from the client. */
  it('does NOT delete the bucket when unappliable findings remain for a surviving chapter, even once ops empties', () => {
    const staleOp = makeOp(99, 'reattribute', 2);
    let state = scriptReviewSlice.reducer(
      undefined,
      scriptReviewActions.setReview({
        bookId: 'b1',
        ops: [makeOp(1, 'strip_tag', 1)],
        unappliable: [{ op: staleOp, reason: 'stale id' }],
        manuscriptId: 'ms-1',
        versionByChapter: { 1: 1, 2: 3 },
      }),
    );
    expect(state.byBook['b1']?.ops).toHaveLength(1);
    expect(state.byBook['b1']?.unappliable).toHaveLength(1);

    // Remove chapter 1 (the only chapter with an appliable op) — ops
    // empties, but chapter 2's unappliable finding is still genuinely
    // pending server-side.
    state = scriptReviewSlice.reducer(
      state,
      scriptReviewActions.removeChaptersLocally({ bookId: 'b1', chapterIds: [1] }),
    );

    expect(state.byBook['b1']).toBeDefined();
    expect(state.byBook['b1']?.ops).toHaveLength(0);
    expect(state.byBook['b1']?.unappliable).toHaveLength(1);
    expect(state.byBook['b1']?.unappliable[0].op.id).toBe(99);
  });
});
