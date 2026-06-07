/* Pairs with docs/features/NNN-design-full-cast.md.

   Pins the cast-design middleware's contract: it owns the single SSE for the
   server bulk-design job, translating stream callbacks into slice dispatches,
   mirroring each `character_designed` into the cast slice (so rows flip live),
   continuing past per-character failures, settling + clearing on idle, and
   guarding against a second concurrent run (re-entrancy). Also pins the
   cold-boot `resubscribe` path (bare subscribe, seeded by `resume_from`). */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { configureStore } from '@reduxjs/toolkit';
import type { CastDesignCallbacks } from '../lib/api';

interface StartCall {
  bookId: string;
  characterIds: string[];
  modelKey: string;
  cb: CastDesignCallbacks;
  resolve: () => void;
}
interface SubscribeCall {
  bookId: string;
  cb: CastDesignCallbacks;
  resolve: () => void;
}

const startCalls: StartCall[] = [];
const subscribeCalls: SubscribeCall[] = [];

vi.mock('../lib/api', () => ({
  api: {
    startCastDesign: (
      bookId: string,
      { characterIds, modelKey }: { characterIds: string[]; modelKey: string },
      cb: CastDesignCallbacks,
    ) =>
      new Promise<void>((resolve) => {
        startCalls.push({ bookId, characterIds, modelKey, cb, resolve });
      }),
    subscribeCastDesign: (bookId: string, cb: CastDesignCallbacks) =>
      new Promise<void>((resolve) => {
        subscribeCalls.push({ bookId, cb, resolve });
      }),
  },
}));

import { createCastDesignMiddleware } from './cast-design-stream-middleware';
import { castDesignSlice, castDesignActions } from './cast-design-slice';
import { castSlice } from './cast-slice';
import { notificationsSlice } from './notifications-slice';

function makeStore() {
  return configureStore({
    reducer: {
      castDesign: castDesignSlice.reducer,
      cast: castSlice.reducer,
      notifications: notificationsSlice.reducer,
    },
    middleware: (getDefault) => getDefault().concat(createCastDesignMiddleware()),
  });
}

beforeEach(() => {
  startCalls.length = 0;
  subscribeCalls.length = 0;
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('castDesignMiddleware', () => {
  it('start: seeds the snapshot, opens the SSE, and ticks through designs', () => {
    const store = makeStore();
    /* Seed two cast rows so the character_designed mirror has somewhere to land. */
    store.dispatch(
      castSlice.actions.setCharacters([
        { id: 'c1', name: 'Sophie' } as never,
        { id: 'c2', name: 'Keefe' } as never,
      ]),
    );

    store.dispatch(
      castDesignActions.designAllRequested({
        bookId: 'b1',
        characterIds: ['c1', 'c2'],
        modelKey: 'qwen3-tts-0.6b',
      }),
    );

    expect(startCalls).toHaveLength(1);
    expect(startCalls[0]).toMatchObject({
      bookId: 'b1',
      characterIds: ['c1', 'c2'],
      modelKey: 'qwen3-tts-0.6b',
    });
    /* Pill seeded immediately. */
    expect(store.getState().castDesign.active).toMatchObject({
      bookId: 'b1',
      total: 2,
      done: 0,
      state: 'running',
    });

    const { cb } = startCalls[0];
    cb.onProgress?.({ characterId: 'c1', name: 'Sophie', done: 0, total: 2 });
    expect(store.getState().castDesign.active?.currentName).toBe('Sophie');

    cb.onCharacterDesigned?.({ characterId: 'c1', voiceId: 'qwen-c1' });
    expect(store.getState().castDesign.active?.done).toBe(1);
    /* Mirrored into the cast slice → row flips to Designed. */
    expect(
      store.getState().cast.characters.find((c) => c.id === 'c1')?.overrideTtsVoices?.qwen?.name,
    ).toBe('qwen-c1');

    cb.onProgress?.({ characterId: 'c2', name: 'Keefe', done: 1, total: 2 });
    cb.onCharacterDesigned?.({ characterId: 'c2', voiceId: 'qwen-c2' });
    expect(store.getState().castDesign.active?.done).toBe(2);
  });

  it('idle: settles to done, toasts a summary, then clears after the linger', () => {
    const store = makeStore();
    store.dispatch(
      castDesignActions.designAllRequested({ bookId: 'b1', characterIds: ['c1'], modelKey: 'k' }),
    );
    const { cb } = startCalls[0];
    cb.onCharacterDesigned?.({ characterId: 'c1', voiceId: 'qwen-c1' });
    cb.onIdle?.({ done: 1, total: 1, skipped: 0, failures: [] });

    expect(store.getState().castDesign.active?.state).toBe('done');
    expect(store.getState().notifications.toasts.at(-1)?.message).toContain('Designed 1');

    vi.advanceTimersByTime(5001);
    expect(store.getState().castDesign.active).toBeNull();
  });

  it('continues past a per-character failure (failure recorded, done not bumped)', () => {
    const store = makeStore();
    store.dispatch(
      castDesignActions.designAllRequested({
        bookId: 'b1',
        characterIds: ['c1', 'c2'],
        modelKey: 'k',
      }),
    );
    const { cb } = startCalls[0];
    cb.onCharacterFailed?.({ characterId: 'c1', name: 'Sophie', errorReason: 'no gemini key' });
    cb.onCharacterDesigned?.({ characterId: 'c2', voiceId: 'qwen-c2' });
    cb.onIdle?.({
      done: 1,
      total: 2,
      skipped: 0,
      failures: [{ characterId: 'c1', name: 'Sophie', error: 'no gemini key' }],
    });

    const snap = store.getState().castDesign.active;
    expect(snap?.done).toBe(1);
    expect(snap?.failures).toHaveLength(1);
    expect(store.getState().notifications.toasts.at(-1)?.message).toContain('1 failed');
  });

  it('re-entrancy: a second designAllRequested while one runs is ignored', () => {
    const store = makeStore();
    store.dispatch(
      castDesignActions.designAllRequested({ bookId: 'b1', characterIds: ['c1'], modelKey: 'k' }),
    );
    store.dispatch(
      castDesignActions.designAllRequested({ bookId: 'b1', characterIds: ['c1'], modelKey: 'k' }),
    );
    expect(startCalls).toHaveLength(1);
  });

  it('skipped: charSkipped bumps skipped, surfaced in the summary', () => {
    const store = makeStore();
    store.dispatch(
      castDesignActions.designAllRequested({
        bookId: 'b1',
        characterIds: ['c1', 'c2'],
        modelKey: 'k',
      }),
    );
    const { cb } = startCalls[0];
    cb.onCharacterDesigned?.({ characterId: 'c1', voiceId: 'qwen-c1' });
    cb.onCharacterSkipped?.({ characterId: 'c2' });
    cb.onIdle?.({ done: 1, total: 2, skipped: 1, failures: [] });
    expect(store.getState().castDesign.active?.skipped).toBe(1);
    expect(store.getState().notifications.toasts.at(-1)?.message).toContain('1 skipped');
  });

  it('resubscribe: opens a bare subscribe and seeds from resume_from', () => {
    const store = makeStore();
    store.dispatch(castDesignActions.resubscribe({ bookId: 'b1' }));
    expect(subscribeCalls).toHaveLength(1);
    /* No upfront begin — the slice stays null until resume_from lands. */
    expect(store.getState().castDesign.active).toBeNull();

    const { cb } = subscribeCalls[0];
    cb.onResumeFrom?.({ total: 4, done: 2, currentName: 'Fitz' });
    expect(store.getState().castDesign.active).toMatchObject({
      bookId: 'b1',
      total: 4,
      done: 2,
      currentName: 'Fitz',
      state: 'running',
    });
  });
});
