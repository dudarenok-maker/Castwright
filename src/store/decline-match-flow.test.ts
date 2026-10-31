import { describe, it, expect, vi, beforeEach } from 'vitest';
import { configureStore } from '@reduxjs/toolkit';
import { declineMatchFlow } from './decline-match-flow';
import { castSlice } from './cast-slice';
import { uiSlice } from './ui-slice';
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

function makeStore(characters: Character[], stage: 'ready' | 'books' = 'ready') {
  const initialUi = uiSlice.getInitialState();
  const store = configureStore({
    reducer: { cast: castSlice.reducer, ui: uiSlice.reducer },
    preloadedState: {
      ui: {
        ...initialUi,
        stage: stage === 'ready' ? { kind: 'ready', bookId: 'book-two', view: 'cast' } : { kind: 'books' },
      } as ReturnType<typeof uiSlice.getInitialState>,
    },
  });
  store.dispatch(castSlice.actions.setCharacters(characters));
  return store;
}

beforeEach(() => {
  vi.mocked(api.declineVoiceLink).mockReset();
  vi.mocked(api.declineVoiceLink).mockResolvedValue({ declinedVoiceFrom: ['book-one'] });
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

  it('a failed record is swallowed (warned): the redux decline stands and the thunk resolves', async () => {
    vi.mocked(api.declineVoiceLink).mockRejectedValue(new Error('network down'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const store = makeStore([matched]);
    await expect((store.dispatch as (a: unknown) => Promise<void>)(declineMatchFlow('wren'))).resolves.toBeUndefined();
    expect(store.getState().cast.characters[0].matchedFrom).toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('recording the decline failed'), 'network down');
    warn.mockRestore();
  });

  it('records nothing when no book is open', async () => {
    const store = makeStore([matched], 'books');
    await (store.dispatch as (a: unknown) => Promise<void>)(declineMatchFlow('wren'));
    expect(store.getState().cast.characters[0].matchedFrom).toBeUndefined();
    expect(api.declineVoiceLink).not.toHaveBeenCalled();
  });
});
