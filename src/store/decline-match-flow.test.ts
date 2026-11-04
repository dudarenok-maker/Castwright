import { describe, it, expect, vi, beforeEach } from 'vitest';
import { configureStore } from '@reduxjs/toolkit';
import { declineMatchFlow } from './decline-match-flow';
import { castSlice } from './cast-slice';
import { uiSlice } from './ui-slice';
import { notificationsSlice } from './notifications-slice';
import type { Character } from '../lib/types';

vi.mock('../lib/api', () => ({
  api: { declineVoiceLink: vi.fn() },
}));
import { api } from '../lib/api';

const matched = {
  id: 'wren',
  name: 'Wren',
  matchedFrom: { bookId: 'book-one', characterId: 'wren', bookTitle: 'Book One', confidence: 0.9 },
  voiceState: 'reused',
} as unknown as Character;

function makeStore(characters: Character[], stage: 'ready' | 'confirm' | 'books' = 'ready') {
  const initialUi = uiSlice.getInitialState();
  const store = configureStore({
    reducer: {
      cast: castSlice.reducer,
      ui: uiSlice.reducer,
      notifications: notificationsSlice.reducer,
      /* the slices hold ONE book at a time; `test/open` stands in for the layout
         hydrating another book's slices */
      manuscript: (s: { manuscriptId: string | null } = { manuscriptId: 'm-two' }, a: { type: string; payload?: string }) =>
        a.type === 'test/open' ? { manuscriptId: a.payload ?? null } : s,
    },
    preloadedState: {
      ui: {
        ...initialUi,
        stage:
          stage === 'ready'
            ? { kind: 'ready', bookId: 'book-two', view: 'cast' }
            : stage === 'confirm'
              ? { kind: 'confirm', bookId: 'book-two', openProfileId: 'wren' }
              : { kind: 'books' },
      } as ReturnType<typeof uiSlice.getInitialState>,
    },
  });
  store.dispatch(castSlice.actions.setCharacters(characters));
  return store;
}

beforeEach(() => {
  vi.mocked(api.declineVoiceLink).mockReset();
  vi.mocked(api.declineVoiceLink).mockResolvedValue({ declinedVoiceFrom: ['book-one'], declinedVoiceUuids: [], voiceUuid: null });
});

describe('declineMatchFlow (#3992)', () => {
  it('clears matchedFrom in redux AND records the decline against the book it was read from', async () => {
    const store = makeStore([matched]);
    await (store.dispatch as (a: unknown) => Promise<void>)(declineMatchFlow('wren'));
    expect(store.getState().cast.characters[0].matchedFrom).toBeUndefined();
    expect(api.declineVoiceLink).toHaveBeenCalledWith({
      bookId: 'book-two',
      characterId: 'wren',
      fromBookId: 'book-one',
    });
  });

  it('records the decline from the Confirm stage too (the drawer opens there)', async () => {
    const store = makeStore([matched], 'confirm');
    await (store.dispatch as (a: unknown) => Promise<void>)(declineMatchFlow('wren'));
    expect(store.getState().cast.characters[0].matchedFrom).toBeUndefined();
    expect(api.declineVoiceLink).toHaveBeenCalledWith({
      bookId: 'book-two',
      characterId: 'wren',
      fromBookId: 'book-one',
    });
  });

  it('names a link with no book id nowhere: only the reducer runs', async () => {
    const store = makeStore([{ ...matched, matchedFrom: { bookTitle: 'Book One', confidence: 1 } } as unknown as Character]);
    await (store.dispatch as (a: unknown) => Promise<void>)(declineMatchFlow('wren'));
    expect(store.getState().cast.characters[0].matchedFrom).toBeUndefined();
    expect(api.declineVoiceLink).not.toHaveBeenCalled();
  });

  it('records nothing for an unlinked or unknown character', async () => {
    const store = makeStore([{ ...matched, matchedFrom: undefined } as unknown as Character]);
    await (store.dispatch as (a: unknown) => Promise<void>)(declineMatchFlow('wren'));
    await (store.dispatch as (a: unknown) => Promise<void>)(declineMatchFlow('nobody'));
    expect(api.declineVoiceLink).not.toHaveBeenCalled();
  });

  it('a failed record reverts nothing because nothing was applied: the link stays, a toast says why (pass-2 D)', async () => {
    vi.mocked(api.declineVoiceLink).mockRejectedValue(new Error('network down'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const store = makeStore([matched]);
    await expect((store.dispatch as (a: unknown) => Promise<void>)(declineMatchFlow('wren'))).resolves.toBeUndefined();
    const row = store.getState().cast.characters[0];
    expect(row.matchedFrom?.bookId).toBe('book-one');
    expect(row.voiceState).toBe('reused');
    const toasts = (store.getState() as unknown as { notifications: { toasts: Array<{ kind: string; message: string }> } })
      .notifications.toasts;
    expect(toasts).toHaveLength(1);
    expect(toasts[0].kind).toBe('error');
    expect(toasts[0].message).toContain('network down');
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('a success applies the reducer after the request, with no toast', async () => {
    const store = makeStore([matched]);
    const order: string[] = [];
    vi.mocked(api.declineVoiceLink).mockImplementation(async () => {
      order.push(`request saw matchedFrom=${store.getState().cast.characters[0].matchedFrom?.bookId}`);
      return { declinedVoiceFrom: ['book-one'], declinedVoiceUuids: [], voiceUuid: null };
    });
    await (store.dispatch as (a: unknown) => Promise<void>)(declineMatchFlow('wren'));
    expect(order).toEqual(['request saw matchedFrom=book-one']);
    expect(store.getState().cast.characters[0].matchedFrom).toBeUndefined();
    expect((store.getState() as unknown as { notifications: { toasts: unknown[] } }).notifications.toasts).toHaveLength(0);
  });

  it('opening ANOTHER book while the request is in flight leaves that book’s row untouched (pass-3 5)', async () => {
    const store = makeStore([matched]);
    let release!: () => void;
    vi.mocked(api.declineVoiceLink).mockImplementation(
      () =>
        new Promise((resolve) => {
          release = () => resolve({ declinedVoiceFrom: ['book-one'], declinedVoiceUuids: [], voiceUuid: null });
        }),
    );
    const pending = (store.dispatch as (a: unknown) => Promise<void>)(declineMatchFlow('wren'));
    // Book Three opens: its cast hydrates, its wren is linked to Book Two
    const three = {
      ...matched,
      matchedFrom: { bookId: 'book-two', characterId: 'wren', bookTitle: 'Book Two', confidence: 0.9 },
    } as unknown as Character;
    store.dispatch({ type: 'test/open', payload: 'm-three' });
    store.dispatch(castSlice.actions.setCharacters([three]));
    release();
    await pending;
    const row = store.getState().cast.characters[0];
    expect(row.matchedFrom?.bookId).toBe('book-two');
    expect(row.voiceState).toBe('reused');
  });

  it('applies the marker the route returned, so applyVoiceMatches’ own filter works in the same session', async () => {
    vi.mocked(api.declineVoiceLink).mockResolvedValue({
      declinedVoiceFrom: ['book-one'],
      declinedVoiceUuids: ['u_shared'],
      voiceUuid: null,
    });
    const store = makeStore([matched]);
    await (store.dispatch as (a: unknown) => Promise<void>)(declineMatchFlow('wren'));
    const row = store.getState().cast.characters[0] as Character & { declinedVoiceUuids?: string[] };
    expect(row.declinedVoiceFrom).toEqual(['book-one']);
    expect(row.declinedVoiceUuids).toEqual(['u_shared']);
    store.dispatch(
      castSlice.actions.applyVoiceMatches({
        matches: [
          {
            characterId: 'wren',
            candidates: [
              { voiceId: 'v1', fromBookId: 'book-one', fromBookTitle: 'Book One', fromCharacterId: 'wren', score: 0.9 },
            ],
          },
        ],
      } as never),
    );
    expect(store.getState().cast.characters[0].matchedFrom).toBeUndefined();
  });

  it('mirrors the uuid the route moved the row onto, dropping its stale variant slots', async () => {
    vi.mocked(api.declineVoiceLink).mockResolvedValue({
      declinedVoiceFrom: ['book-one'],
      declinedVoiceUuids: ['u_shared'],
      voiceUuid: 'u_own',
    });
    const store = makeStore([
      {
        ...matched,
        voiceUuid: 'u_shared',
        overrideTtsVoices: { qwen: { name: 'qwen-u_shared', variants: { angry: { name: 'qwen-u_shared__angry' } } } },
      } as unknown as Character,
    ]);
    await (store.dispatch as (a: unknown) => Promise<void>)(declineMatchFlow('wren'));
    const row = store.getState().cast.characters[0] as Character & { voiceUuid?: string };
    expect(row.voiceUuid).toBe('u_own');
    expect(row.overrideTtsVoices?.qwen?.variants).toBeUndefined();
  });

  it('a failed record applies no marker either (the link and the row stay as they were)', async () => {
    vi.mocked(api.declineVoiceLink).mockRejectedValue(new Error('boom'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const store = makeStore([matched]);
    await (store.dispatch as (a: unknown) => Promise<void>)(declineMatchFlow('wren'));
    warn.mockRestore();
    expect((store.getState().cast.characters[0] as Character).declinedVoiceFrom).toBeUndefined();
  });

  it('the same book still open after the request: the reducer applies (control)', async () => {
    const store = makeStore([matched]);
    await (store.dispatch as (a: unknown) => Promise<void>)(declineMatchFlow('wren'));
    expect(store.getState().cast.characters[0].matchedFrom).toBeUndefined();
  });

  it('records nothing when no book is open', async () => {
    const store = makeStore([matched], 'books');
    await (store.dispatch as (a: unknown) => Promise<void>)(declineMatchFlow('wren'));
    expect(store.getState().cast.characters[0].matchedFrom).toBeUndefined();
    expect(api.declineVoiceLink).not.toHaveBeenCalled();
  });
});
