/* #4040 (PR #4061 review pass 2) — the post-redesign variant refresh must prune
   only the redesigned book's rows on the redesigned voice key, and only the
   variants the store held when it was dispatched. */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { configureStore } from '@reduxjs/toolkit';
import { castSlice } from './cast-slice';
import { manuscriptSlice } from './manuscript-slice';
import { refreshEmotionVariants } from './emotion-variants-refresh';
import { api } from '../lib/api';
import type { Character } from '../lib/types';

vi.mock('../lib/api', () => ({ api: { getBookState: vi.fn() } }));
const getBookState = vi.mocked(api.getBookState) as unknown as ReturnType<typeof vi.fn>;

const angry = (key: string) => ({ angry: { name: `${key}__angry` } });
const row = (id: string, key: string, variants: Record<string, { name: string }> = angry(key)): Character =>
  ({
    id,
    name: id,
    role: 'role',
    color: id,
    voiceState: 'generated',
    voiceId: key,
    voiceUuid: key,
    overrideTtsVoices: { qwen: { name: `qwen-${key}`, variants } },
  }) as Character;

function makeStore(characters: Character[], manuscriptId: string | null = 'mns_y') {
  return configureStore({
    reducer: { cast: castSlice.reducer, manuscript: manuscriptSlice.reducer },
    preloadedState: {
      cast: { characters },
      manuscript: { ...manuscriptSlice.getInitialState(), manuscriptId },
    },
  });
}
const run = (s: ReturnType<typeof makeStore>, thunk: unknown) =>
  (s.dispatch as unknown as (t: unknown) => Promise<void>)(thunk);
const variantsOf =(s: ReturnType<typeof makeStore>, id: string) =>
  s.getState().cast.characters.find((c) => c.id === id)?.overrideTtsVoices?.qwen?.variants;
const read = (manuscriptId: string, rows: Array<{ id: string; variants?: object }>) => ({
  state: { manuscriptId },
  cast: {
    characters: rows.map((r) => ({
      id: r.id,
      overrideTtsVoices: { qwen: { name: 'x', ...(r.variants ? { variants: r.variants } : {}) } },
    })),
  },
});

beforeEach(() => getBookState.mockReset());
afterEach(() => vi.unstubAllEnvs());

describe('refreshEmotionVariants (#4040)', () => {
  it('prunes the redesigned voice key rows when the read is of the loaded book', async () => {
    const store = makeStore([row('a', 'k1'), row('b', 'k1')]);
    getBookState.mockResolvedValue(read('mns_y', [{ id: 'a' }, { id: 'b' }]));
    await run(store, refreshEmotionVariants('book-y', 'a'));
    expect(variantsOf(store, 'a')).toBeUndefined();
    expect(variantsOf(store, 'b')).toBeUndefined();
  });

  it('(1) leaves the loaded book untouched when the read is of a different book', async () => {
    const store = makeStore([row('a', 'k1'), row('b', 'k1')], 'mns_y');
    getBookState.mockResolvedValue(read('mns_a', [{ id: 'a' }, { id: 'b' }]));
    await run(store, refreshEmotionVariants('book-a', 'a'));
    expect(variantsOf(store, 'a')).toEqual(angry('k1'));
    expect(variantsOf(store, 'b')).toEqual(angry('k1'));
  });

  it('(2) keeps a variant on a row that is on a different voice key', async () => {
    const store = makeStore([row('a', 'k1'), row('other', 'k2')]);
    getBookState.mockResolvedValue(read('mns_y', [{ id: 'a' }, { id: 'other' }]));
    await run(store, refreshEmotionVariants('book-y', 'a'));
    expect(variantsOf(store, 'a')).toBeUndefined();
    expect(variantsOf(store, 'other')).toEqual(angry('k2'));
  });

  it('(3) keeps a variant that reached the store after the refresh was dispatched', async () => {
    const store = makeStore([row('a', 'k1', angry('k1'))]);
    getBookState.mockImplementation(async () => {
      // a concurrent persistEmotionVariant lands while the read is in flight
      store.dispatch({
        type: 'cast/hydrateCharacters',
        payload: [row('a', 'k1', { ...angry('k1'), sad: { name: 'k1__sad' } })],
      });
      return read('mns_y', [{ id: 'a' }]);
    });
    await run(store, refreshEmotionVariants('book-y', 'a'));
    expect(variantsOf(store, 'a')).toEqual({ sad: { name: 'k1__sad' } });
  });

  it('(4) mock mode never prunes (its read cannot tell stale from never-recorded)', async () => {
    vi.stubEnv('VITE_USE_MOCKS', 'true');
    const store = makeStore([row('a', 'k1')]);
    getBookState.mockResolvedValue(read('mns_y', [{ id: 'a' }]));
    await run(store, refreshEmotionVariants('book-y', 'a'));
    expect(getBookState).not.toHaveBeenCalled();
    expect(variantsOf(store, 'a')).toEqual(angry('k1'));
  });
});
