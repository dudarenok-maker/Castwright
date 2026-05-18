// Pairs with docs/features/18-listen-view.md

import { describe, expect, it } from 'vitest';
import {
  bookMetaSlice,
  bookMetaActions,
  selectEffectiveMeta,
  selectIsDirty,
  narratorNameFromCast,
  type BookMetaState,
  type EditableBookMeta,
} from './book-meta-slice';
import type { Character } from '../lib/types';
import type { RootState } from './index';

const initial = (): BookMetaState => ({ draft: null, saved: {} });

const fullMeta = (over: Partial<EditableBookMeta> = {}): EditableBookMeta => ({
  title: 'The Northern Star',
  author: 'Mike Dudarenok',
  series: 'Northern Coast Trilogy · Book 2',
  narratorCredit: 'Anders Vale',
  genre: 'Literary fiction',
  publicationDate: '2026-05-09',
  description: null,
  ...over,
});

const reducer = bookMetaSlice.reducer;

describe('bookMetaSlice — hydrateFromBookState', () => {
  it('seeds saved[bookId] from BookStateJson and wipes any draft', () => {
    const start: BookMetaState = { draft: { title: 'stale draft' }, saved: {} };
    const next = reducer(
      start,
      bookMetaActions.hydrateFromBookState({
        bookId: 'ns',
        state: {
          title: 'The Northern Star',
          author: 'Mike Dudarenok',
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
      author: 'Mike Dudarenok',
      series: 'NCT · Book 2',
      narratorCredit: 'Anders Vale',
      genre: 'Literary fiction',
      publicationDate: '2026-05-09',
      description: null,
    });
  });

  it('falls back to narratorFallback when state.narratorCredit is missing', () => {
    const next = reducer(
      initial(),
      bookMetaActions.hydrateFromBookState({
        bookId: 'ns',
        state: { title: 'X', author: 'A', series: 'S' },
        narratorFallback: 'Narrator',
      }),
    );
    expect(next.saved.ns.narratorCredit).toBe('Narrator');
    expect(next.saved.ns.genre).toBeNull();
    expect(next.saved.ns.publicationDate).toBeNull();
  });

  it('uses null when both state.narratorCredit and fallback are missing', () => {
    const next = reducer(
      initial(),
      bookMetaActions.hydrateFromBookState({
        bookId: 'ns',
        state: { title: 'X', author: 'A', series: 'S' },
      }),
    );
    expect(next.saved.ns.narratorCredit).toBeNull();
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
    const dirty: BookMetaState = { draft: { title: 'X' }, saved: { ns: fullMeta() } };
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
    };
    const next = reducer(start, bookMetaActions.commitDraft({ bookId: 'ns' }));
    expect(next.draft).toBeNull();
    expect(next.saved.ns).toEqual(fullMeta({ title: 'Renamed', genre: 'Sci-fi' }));
  });

  it('is a no-op when no saved baseline exists (refuses to corrupt state)', () => {
    const start: BookMetaState = { draft: { title: 'X' }, saved: {} };
    const next = reducer(start, bookMetaActions.commitDraft({ bookId: 'unknown' }));
    expect(next.saved.unknown).toBeUndefined();
    /* Draft is still cleared — the user's intent (commit & close) is honoured
       even if nothing was written. */
    expect(next.draft).toBeNull();
  });

  it('clears the draft even when it is empty (so the middleware fires once)', () => {
    const start: BookMetaState = { draft: null, saved: { ns: fullMeta() } };
    const next = reducer(start, bookMetaActions.commitDraft({ bookId: 'ns' }));
    expect(next.saved.ns).toEqual(fullMeta());
    expect(next.draft).toBeNull();
  });
});

describe('selectors', () => {
  const baseState = (sliceState: BookMetaState): RootState =>
    ({ bookMeta: sliceState }) as unknown as RootState;

  it('selectEffectiveMeta returns null when no saved baseline', () => {
    expect(selectEffectiveMeta('ns')(baseState(initial()))).toBeNull();
  });

  it('selectEffectiveMeta returns saved snapshot when draft is empty', () => {
    const s = baseState({ draft: null, saved: { ns: fullMeta() } });
    expect(selectEffectiveMeta('ns')(s)).toEqual(fullMeta());
  });

  it('selectEffectiveMeta overlays the draft on top of saved for live preview', () => {
    const s = baseState({
      draft: { title: 'Live Edit', genre: null },
      saved: { ns: fullMeta() },
    });
    expect(selectEffectiveMeta('ns')(s)).toEqual(fullMeta({ title: 'Live Edit', genre: null }));
  });

  it('selectIsDirty is false on a pristine slice', () => {
    expect(selectIsDirty(baseState(initial()))).toBe(false);
  });

  it('selectIsDirty is true once the draft has any keys', () => {
    const s = baseState({ draft: { title: 'X' }, saved: { ns: fullMeta() } });
    expect(selectIsDirty(s)).toBe(true);
  });

  it('selectIsDirty is false for an empty-object draft', () => {
    /* Defensive — setDraftField always seeds at least one key, but a stray
       reducer that left {} behind shouldn't mark the form dirty. */
    const s = baseState({ draft: {}, saved: { ns: fullMeta() } });
    expect(selectIsDirty(s)).toBe(false);
  });
});

describe('narratorNameFromCast', () => {
  const ch = (id: string, name: string): Character =>
    ({ id, name, role: '', color: 'narrator' }) as Character;

  it('returns null when the cast is empty', () => {
    expect(narratorNameFromCast([])).toBeNull();
  });

  it("returns the explicit narrator character's name when present", () => {
    expect(
      narratorNameFromCast([
        ch('halloran', 'Halloran'),
        ch('narrator', 'Narrator'),
        ch('eliza', 'Eliza'),
      ]),
    ).toBe('Narrator');
  });

  it('falls back to the first character when there is no narrator id', () => {
    expect(
      narratorNameFromCast([ch('halloran', 'Captain Halloran'), ch('eliza', 'Eliza Gray')]),
    ).toBe('Captain Halloran');
  });
});
