/* #4067 — "Don't reuse" through the REAL persistence middleware. The decline
   route renames the declined row's qwen slot to `qwen-<newUuid>` on disk; the
   client must mirror it, or the NEXT whole-roster cast PUT (same uuid, so the
   server's preserve guard lets the incoming slot win) writes `qwen-<oldUuid>`
   back. Also the legacy-row variants write-back: a row with no prior uuid
   keeps its `variants` unless the decline path drops them regardless. */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { configureStore } from '@reduxjs/toolkit';
import type { PutStateRequest } from '../lib/types';

const { putBookState, declineVoiceLink } = vi.hoisted(() => ({
  putBookState: vi.fn(async (_bookId: string, _req: PutStateRequest) => {}),
  declineVoiceLink: vi.fn(),
}));
vi.mock('../lib/api', async (orig) => ({
  ...(await orig<typeof import('../lib/api')>()),
  api: { putBookState, declineVoiceLink },
}));

import { persistenceMiddleware, flushBookPersistence } from './persistence-middleware';
import { declineMatchFlow } from './decline-match-flow';
import { castSlice, castActions } from './cast-slice';
import { uiSlice } from './ui-slice';
import { notificationsSlice } from './notifications-slice';
import type { Character } from '../lib/types';

const row = (extra: Record<string, unknown>) =>
  ({
    id: 'wren',
    name: 'Wren',
    matchedFrom: { bookId: 'book-one', characterId: 'wren', bookTitle: 'Book One', confidence: 0.9 },
    voiceState: 'reused',
    ...extra,
  }) as unknown as Character;

function makeStore(characters: Character[]) {
  const initialUi = uiSlice.getInitialState();
  const store = configureStore({
    reducer: {
      cast: castSlice.reducer,
      ui: uiSlice.reducer,
      notifications: notificationsSlice.reducer,
      manuscript: (s: { manuscriptId: string | null } = { manuscriptId: 'm-two' }) => s,
    },
    preloadedState: {
      ui: { ...initialUi, stage: { kind: 'ready', bookId: 'book-two', view: 'cast' } } as ReturnType<typeof uiSlice.getInitialState>,
    },
    middleware: (g) => g({ serializableCheck: false }).concat(persistenceMiddleware),
  });
  store.dispatch(castSlice.actions.setCharacters(characters));
  return store;
}

/* the declined row as the LAST whole-roster cast PUT carried it */
async function declineThenEdit(store: ReturnType<typeof makeStore>, newUuid: string, separated = true) {
  declineVoiceLink.mockResolvedValue({
    declinedVoiceFrom: ['book-one'],
    declinedVoiceUuids: ['u_shared'],
    voiceUuid: newUuid,
    separated,
    movedCharacterIds: [],
  });
  await (store.dispatch as (a: unknown) => Promise<void>)(declineMatchFlow('wren'));
  putBookState.mockClear();
  store.dispatch(castActions.lockVoice('wren'));
  await store.dispatch(flushBookPersistence('book-two') as never);
  const castPuts = putBookState.mock.calls.filter((c) => (c[1] as { slice: string }).slice === 'cast');
  expect(castPuts.length).toBeGreaterThan(0);
  const patch = castPuts[castPuts.length - 1][1].patch as { characters: Array<Character & { voiceUuid?: string }> };
  return patch.characters.find((c) => c.id === 'wren')!;
}

beforeEach(() => {
  putBookState.mockClear();
  declineVoiceLink.mockReset();
});

describe('"Don\'t reuse" then a later cast save (#4067)', () => {
  it('the next whole-roster PUT carries qwen-<newUuid>, not the earlier book’s name', async () => {
    const store = makeStore([
      row({ voiceUuid: 'u_shared', overrideTtsVoices: { qwen: { name: 'qwen-u_shared' } } }),
    ]);
    const sent = await declineThenEdit(store, 'u_fresh');
    expect(sent.voiceUuid).toBe('u_fresh');
    expect(sent.overrideTtsVoices?.qwen?.name).toBe('qwen-u_fresh');
  });

  it('a library-assigned slot keeps its name (its key is the libraryUuid)', async () => {
    const store = makeStore([
      row({
        voiceUuid: 'u_shared',
        overrideTtsVoices: { qwen: { name: 'qwen-lib_1', libraryUuid: 'lib_1' } },
      }),
    ]);
    const sent = await declineThenEdit(store, 'u_fresh');
    expect(sent.voiceUuid).toBe('u_fresh');
    expect(sent.overrideTtsVoices?.qwen?.name).toBe('qwen-lib_1');
  });

  it('a LEGACY row (no prior uuid) loses its variants too, and is renamed', async () => {
    const store = makeStore([
      row({
        overrideTtsVoices: { qwen: { name: 'qwen-v_wren', variants: { angry: { name: 'qwen-v_wren__angry' } } } },
      }),
    ]);
    const sent = await declineThenEdit(store, 'u_fresh');
    expect(sent.voiceUuid).toBe('u_fresh');
    expect(sent.overrideTtsVoices?.qwen?.variants).toBeUndefined();
    expect(sent.overrideTtsVoices?.qwen?.name).toBe('qwen-u_fresh');
  });

  it('a decline that did NOT move the row keeps its name and its emotion variants', async () => {
    const store = makeStore([
      row({
        voiceUuid: 'u_own',
        overrideTtsVoices: { qwen: { name: 'qwen-u_own', variants: { angry: { name: 'qwen-u_own__angry' } } } },
      }),
    ]);
    const sent = await declineThenEdit(store, 'u_own', false);
    expect(sent.voiceUuid).toBe('u_own');
    expect(sent.overrideTtsVoices?.qwen?.name).toBe('qwen-u_own');
    expect(sent.overrideTtsVoices?.qwen?.variants?.angry?.name).toBe('qwen-u_own__angry');
  });
});
