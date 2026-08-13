// Pairs with docs/features/archive/18-listen-view.md

import { describe, expect, it } from 'vitest';
import {
  bookMetaSlice,
  bookMetaActions,
  selectEffectiveMeta,
  selectIsDirty,
  DEFAULT_NARRATOR_CREDIT,
  type BookMetaState,
  type EditableBookMeta,
} from './book-meta-slice';
import type { RootState } from './index';

const initial = (): BookMetaState => ({ draft: null, saved: {}, prosodyEnabled: {} });

const fullMeta = (over: Partial<EditableBookMeta> = {}): EditableBookMeta => ({
  title: 'The Northern Star',
  author: 'Marin Vale',
  series: 'Northern Coast Trilogy · Book 2',
  narratorCredit: 'Anders Vale',
  genre: 'Literary fiction',
  publicationDate: '2026-05-09',
  description: null,
  notes: null,
  ...over,
});

const reducer = bookMetaSlice.reducer;

describe('bookMetaSlice — hydrateFromBookState', () => {
  it('seeds saved[bookId] from BookStateJson and wipes any draft', () => {
    const start: BookMetaState = { draft: { title: 'stale draft' }, saved: {}, prosodyEnabled: {} };
    const next = reducer(
      start,
      bookMetaActions.hydrateFromBookState({
        bookId: 'ns',
        state: {
          title: 'The Northern Star',
          author: 'Marin Vale',
          series: 'NCT · Book 2',
          narratorCredit: 'Anders Vale',
          genre: 'Literary fiction',
          publicationDate: '2026-05-09',
        },
      }),
    );
    expect(next.draft).toBeNull();
    expect(next.saved.ns).toEqual({
      title: 'The Northern Star',
      author: 'Marin Vale',
      series: 'NCT · Book 2',
      narratorCredit: 'Anders Vale',
      genre: 'Literary fiction',
      publicationDate: '2026-05-09',
      description: null,
      notes: null,
    });
  });

  it('defaults to DEFAULT_NARRATOR_CREDIT when state.narratorCredit is missing', () => {
    const next = reducer(
      initial(),
      bookMetaActions.hydrateFromBookState({
        bookId: 'ns',
        state: { title: 'X', author: 'A', series: 'S' },
      }),
    );
    expect(next.saved.ns.narratorCredit).toBe('Castwright');
    expect(next.saved.ns.narratorCredit).toBe(DEFAULT_NARRATOR_CREDIT);
    expect(next.saved.ns.genre).toBeNull();
    expect(next.saved.ns.publicationDate).toBeNull();
  });

  it('defaults to Castwright when both state.narratorCredit and any fallback are missing', () => {
    const next = reducer(
      initial(),
      bookMetaActions.hydrateFromBookState({
        bookId: 'ns',
        state: { title: 'X', author: 'A', series: 'S' },
      }),
    );
    expect(next.saved.ns.narratorCredit).toBe('Castwright');
  });
});

describe('bookMetaSlice — setDraftField + cancelDraft', () => {
  it('stages a single-field edit into a new draft buffer', () => {
    const next = reducer(
      initial(),
      bookMetaActions.setDraftField({ field: 'title', value: 'New Title' }),
    );
    expect(next.draft).toEqual({ title: 'New Title' });
  });

  it('accumulates multiple field edits in the same draft', () => {
    let s = reducer(initial(), bookMetaActions.setDraftField({ field: 'title', value: 'A' }));
    s = reducer(s, bookMetaActions.setDraftField({ field: 'author', value: 'B' }));
    s = reducer(s, bookMetaActions.setDraftField({ field: 'genre', value: null }));
    expect(s.draft).toEqual({ title: 'A', author: 'B', genre: null });
  });

  it('cancelDraft clears the draft buffer', () => {
    const dirty: BookMetaState = { draft: { title: 'X' }, saved: { ns: fullMeta() }, prosodyEnabled: {} };
    const next = reducer(dirty, bookMetaActions.cancelDraft());
    expect(next.draft).toBeNull();
    expect(next.saved.ns).toEqual(fullMeta());
  });
});

describe('bookMetaSlice — commitDraft', () => {
  it('folds draft into saved[bookId] and clears draft', () => {
    const start: BookMetaState = {
      draft: { title: 'Renamed', genre: 'Sci-fi' },
      saved: { ns: fullMeta() },
      prosodyEnabled: {},
    };
    const next = reducer(start, bookMetaActions.commitDraft({ bookId: 'ns' }));
    expect(next.draft).toBeNull();
    expect(next.saved.ns).toEqual(fullMeta({ title: 'Renamed', genre: 'Sci-fi' }));
  });

  it('is a no-op when no saved baseline exists (refuses to corrupt state)', () => {
    const start: BookMetaState = { draft: { title: 'X' }, saved: {}, prosodyEnabled: {} };
    const next = reducer(start, bookMetaActions.commitDraft({ bookId: 'unknown' }));
    expect(next.saved.unknown).toBeUndefined();
    /* Draft is still cleared — the user's intent (commit & close) is honoured
       even if nothing was written. */
    expect(next.draft).toBeNull();
  });

  it('clears the draft even when it is empty (so the middleware fires once)', () => {
    const start: BookMetaState = { draft: null, saved: { ns: fullMeta() }, prosodyEnabled: {} };
    const next = reducer(start, bookMetaActions.commitDraft({ bookId: 'ns' }));
    expect(next.saved.ns).toEqual(fullMeta());
    expect(next.draft).toBeNull();
  });

  /* Plan 67 — editorial notes round-trip via the same draft → saved
     fold that other nullable fields use. Preserves embedded line breaks
     verbatim (the textarea editor surfaces them with whitespace-pre-wrap). */
  it('folds a notes edit (with line breaks) into saved[bookId]', () => {
    const start: BookMetaState = {
      draft: { notes: 'First line.\nSecond line.\n\nThird paragraph.' },
      saved: { ns: fullMeta() },
      prosodyEnabled: {},
    };
    const next = reducer(start, bookMetaActions.commitDraft({ bookId: 'ns' }));
    expect(next.draft).toBeNull();
    expect(next.saved.ns.notes).toBe('First line.\nSecond line.\n\nThird paragraph.');
  });

  /* #2230 — the optimistic fold keeps a `{ saved, draft }` snapshot so a refused
     409 PUT can revert `saved` to the last server-accepted baseline AND restore
     the user's typed draft (a failed save must not erase their edits). */
  it('captures the server-accepted baseline and the staged draft on commit', () => {
    const start: BookMetaState = {
      draft: { title: 'Renamed', genre: 'Sci-fi' },
      saved: { ns: fullMeta() },
      prosodyEnabled: {},
    };
    const next = reducer(start, bookMetaActions.commitDraft({ bookId: 'ns' }));
    expect(next.saved.ns.title).toBe('Renamed');
    /* Snapshot pins the ORIGINAL saved baseline — NOT the optimistic result. */
    expect(next.lastCommitted?.['ns']?.saved).toEqual(fullMeta());
    /* …and keeps the staged draft so a failed save can put it back in the editor. */
    expect(next.lastCommitted?.['ns']?.draft).toEqual({ title: 'Renamed', genre: 'Sci-fi' });
  });

  it('pins the baseline on the first commit and merges drafts on later commits in the window', () => {
    /* Two saves inside one debounce window: the snapshot baseline must remain
       the truly-accepted value, and the draft must accumulate both edits so a
       single refused PUT never reverts to an unpersisted intermediate. */
    let s: BookMetaState = {
      draft: { title: 'Renamed' },
      saved: { ns: fullMeta() },
      prosodyEnabled: {},
    };
    s = reducer(s, bookMetaActions.commitDraft({ bookId: 'ns' }));
    s = reducer(s, bookMetaActions.setDraftField({ field: 'title', value: 'Renamed Twice' }));
    s = reducer(s, bookMetaActions.commitDraft({ bookId: 'ns' }));

    expect(s.saved.ns.title).toBe('Renamed Twice');
    expect(s.lastCommitted?.['ns']?.saved.title).toBe('The Northern Star'); // baseline never moves
    expect(s.lastCommitted?.['ns']?.draft).toEqual({ title: 'Renamed Twice' }); // both edits preserved
  });

  it('does not snapshot on an empty draft (nothing to roll back)', () => {
    const start: BookMetaState = {
      draft: null,
      saved: { ns: fullMeta({ title: 'Bumped' }) },
      prosodyEnabled: {},
    };
    const next = reducer(start, bookMetaActions.commitDraft({ bookId: 'ns' }));
    expect(next.lastCommitted?.['ns']).toBeUndefined();
  });

  it('commitDraftSucceeded prunes the snapshot so the next window snaps a fresh baseline', () => {
    const start: BookMetaState = {
      draft: null,
      saved: { ns: fullMeta({ title: 'Renamed' }) },
      lastCommitted: { ns: { saved: fullMeta(), draft: { title: 'Renamed' } } },
      prosodyEnabled: {},
    };
    const next = reducer(start, bookMetaActions.commitDraftSucceeded({ bookId: 'ns' }));
    expect(next.saved.ns.title).toBe('Renamed'); // unaffected
    expect(next.lastCommitted?.['ns']).toBeUndefined();
  });
});

describe('bookMetaSlice — rollbackCommitDraft (#2230)', () => {
  it('reverts saved[bookId] to the accepted baseline AND restores the user draft', () => {
    const start: BookMetaState = {
      draft: null,
      saved: { ns: fullMeta({ title: 'Renamed' }) },
      lastCommitted: { ns: { saved: fullMeta(), draft: { title: 'Renamed' } } },
      prosodyEnabled: {},
    };
    const next = reducer(start, bookMetaActions.rollbackCommitDraft({ bookId: 'ns' }));
    expect(next.saved.ns).toEqual(fullMeta());
    expect(next.saved.ns.title).toBe('The Northern Star');
    /* The user's typed text survives in the editor for retry. */
    expect(next.draft).toEqual({ title: 'Renamed' });
    expect(next.lastCommitted?.['ns']).toBeUndefined();
  });

  it('merges the accumulated draft from a multi-commit window back into the editor', () => {
    const start: BookMetaState = {
      draft: null,
      saved: { ns: fullMeta({ title: 'Renamed Twice' }) },
      lastCommitted: {
        ns: { saved: fullMeta(), draft: { title: 'Renamed Twice', genre: 'Sci-fi' } },
      },
      prosodyEnabled: {},
    };
    const next = reducer(start, bookMetaActions.rollbackCommitDraft({ bookId: 'ns' }));
    expect(next.saved.ns.title).toBe('The Northern Star');
    expect(next.draft).toEqual({ title: 'Renamed Twice', genre: 'Sci-fi' });
  });

  it('is a no-op (and clears the snapshot) when nothing was captured', () => {
    const start: BookMetaState = {
      draft: null,
      saved: { ns: fullMeta() },
      lastCommitted: {},
      prosodyEnabled: {},
    };
    const next = reducer(start, bookMetaActions.rollbackCommitDraft({ bookId: 'ns' }));
    expect(next.saved.ns).toEqual(fullMeta());
    expect(next.lastCommitted).toEqual({});
  });

  it('hydrateFromBookState clears the stale snapshot for the refreshed book', () => {
    const start: BookMetaState = {
      draft: null,
      saved: { ns: fullMeta() },
      lastCommitted: { ns: { saved: fullMeta({ title: 'Old' }), draft: { title: 'Old' } } },
      prosodyEnabled: {},
    };
    const next = reducer(
      start,
      bookMetaActions.hydrateFromBookState({
        bookId: 'ns',
        state: { title: 'Authoritative', author: 'A', series: 'S' },
      }),
    );
    expect(next.saved.ns.title).toBe('Authoritative');
    expect(next.lastCommitted?.['ns']).toBeUndefined();
  });
});

describe('selectors', () => {
  const baseState = (sliceState: BookMetaState): RootState =>
    ({ bookMeta: sliceState }) as unknown as RootState;

  it('selectEffectiveMeta returns null when no saved baseline', () => {
    expect(selectEffectiveMeta(baseState(initial()), 'ns')).toBeNull();
  });

  it('selectEffectiveMeta returns saved snapshot when draft is empty', () => {
    const s = baseState({ draft: null, saved: { ns: fullMeta() }, prosodyEnabled: {} });
    expect(selectEffectiveMeta(s, 'ns')).toEqual(fullMeta());
  });

  it('selectEffectiveMeta overlays the draft on top of saved for live preview', () => {
    const s = baseState({
      draft: { title: 'Live Edit', genre: null },
      saved: { ns: fullMeta() },
      prosodyEnabled: {},
    });
    expect(selectEffectiveMeta(s, 'ns')).toEqual(fullMeta({ title: 'Live Edit', genre: null }));
  });

  it('selectEffectiveMeta returns a stable reference across calls with an unchanged draft (#1308)', () => {
    const s = baseState({
      draft: { title: 'Live Edit' },
      saved: { ns: fullMeta() },
      prosodyEnabled: {},
    });
    expect(selectEffectiveMeta(s, 'ns')).toBe(selectEffectiveMeta(s, 'ns'));
  });

  it('selectIsDirty is false on a pristine slice', () => {
    expect(selectIsDirty(baseState(initial()))).toBe(false);
  });

  it('selectIsDirty is true once the draft has any keys', () => {
    const s = baseState({ draft: { title: 'X' }, saved: { ns: fullMeta() }, prosodyEnabled: {} });
    expect(selectIsDirty(s)).toBe(true);
  });

  it('selectIsDirty is false for an empty-object draft', () => {
    /* Defensive — setDraftField always seeds at least one key, but a stray
       reducer that left {} behind shouldn't mark the form dirty. */
    const s = baseState({ draft: {}, saved: { ns: fullMeta() }, prosodyEnabled: {} });
    expect(selectIsDirty(s)).toBe(false);
  });
});

// fs-65 Phase 3 (replaces fs-57) — per-book prosodyEnabled flag
import { bookMetaReducer, selectProsodyEnabled } from './book-meta-slice';
import type { RootState as RS } from './index';

describe('bookMetaSlice — prosodyEnabled (fs-65 Phase-3, replaces fs-57 liveInstruct)', () => {
  it('defaults to empty map (no books hydrated)', () => {
    const s0 = bookMetaReducer(undefined, { type: '@@init' });
    expect(s0.prosodyEnabled).toEqual({});
  });

  it('setProsodyEnabled scopes the flag to the given bookId', () => {
    const s0 = bookMetaReducer(undefined, { type: '@@init' });
    const s1 = bookMetaReducer(s0, bookMetaActions.setProsodyEnabled({ bookId: 'book-A', value: true }));
    expect(s1.prosodyEnabled['book-A']).toBe(true);
  });

  it('setProsodyEnabled for Book A does not affect Book B', () => {
    let s = bookMetaReducer(undefined, { type: '@@init' });
    s = bookMetaReducer(s, bookMetaActions.setProsodyEnabled({ bookId: 'book-A', value: true }));
    expect(s.prosodyEnabled['book-B']).toBeUndefined();
  });

  it('hydrateFromBookState with prosodyEnabled:true sets the flag for that book', () => {
    const s = bookMetaReducer(
      undefined,
      bookMetaActions.hydrateFromBookState({
        bookId: 'book-A',
        state: { title: 'T', author: 'A', series: '', prosodyEnabled: true },
      }),
    );
    expect(s.prosodyEnabled['book-A']).toBe(true);
  });

  it('hydrateFromBookState without prosodyEnabled leaves it undefined (eager-default semantics)', () => {
    const s = bookMetaReducer(
      undefined,
      bookMetaActions.hydrateFromBookState({
        bookId: 'book-A',
        state: { title: 'T', author: 'A', series: '' },
      }),
    );
    expect(s.prosodyEnabled['book-A']).toBeUndefined();
  });

  it('hydrateFromBookState with prosodyEnabled:undefined (explicit) leaves it undefined — not coerced to false', () => {
    const s = bookMetaReducer(
      undefined,
      bookMetaActions.hydrateFromBookState({
        bookId: 'book-A',
        state: { title: 'T', author: 'A', series: '', prosodyEnabled: undefined },
      }),
    );
    expect(s.prosodyEnabled['book-A']).toBeUndefined();
  });

  it('setProsodyEnabled(false) stores false (explicit opt-out)', () => {
    const s0 = bookMetaReducer(undefined, { type: '@@init' });
    const s1 = bookMetaReducer(s0, bookMetaActions.setProsodyEnabled({ bookId: 'book-A', value: false }));
    expect(s1.prosodyEnabled['book-A']).toBe(false);
  });

  it('opening Book B (prosodyEnabled absent) does not inherit Book A prosodyEnabled:true', () => {
    let s = bookMetaReducer(
      undefined,
      bookMetaActions.hydrateFromBookState({
        bookId: 'book-A',
        state: { title: 'TA', author: 'AA', series: '', prosodyEnabled: true },
      }),
    );
    s = bookMetaReducer(
      s,
      bookMetaActions.hydrateFromBookState({
        bookId: 'book-B',
        state: { title: 'TB', author: 'AB', series: '' },
      }),
    );
    expect(s.prosodyEnabled['book-A']).toBe(true);
    expect(s.prosodyEnabled['book-B']).toBeUndefined();
  });

  it('selectProsodyEnabled returns undefined for an unknown bookId', () => {
    const rootState = ({ bookMeta: bookMetaReducer(undefined, { type: '@@init' }) }) as unknown as RS;
    expect(selectProsodyEnabled('unknown-book')(rootState)).toBeUndefined();
  });

  it('selectProsodyEnabled returns true after hydrateFromBookState with prosodyEnabled:true', () => {
    const s = bookMetaReducer(
      undefined,
      bookMetaActions.hydrateFromBookState({
        bookId: 'book-A',
        state: { title: 'T', author: 'A', series: '', prosodyEnabled: true },
      }),
    );
    const rootState = ({ bookMeta: s }) as unknown as RS;
    expect(selectProsodyEnabled('book-A')(rootState)).toBe(true);
  });

  it('selectProsodyEnabled returns undefined for null bookId', () => {
    const rootState = ({ bookMeta: bookMetaReducer(undefined, { type: '@@init' }) }) as unknown as RS;
    expect(selectProsodyEnabled(null)(rootState)).toBeUndefined();
  });
});



