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
  scope?: string;
  variantTasks?: { characterId: string; emotions: string[] }[];
  cb: CastDesignCallbacks;
  resolve: () => void;
}
interface SubscribeCall {
  bookId: string;
  cb: CastDesignCallbacks;
  resolve: () => void;
}
interface SingleStartCall {
  bookId: string;
  args: {
    characterId: string;
    persona: string;
    sampleVoiceId: string;
    modelKey: string;
    preview: boolean;
  };
  cb: CastDesignCallbacks;
  resolve: () => void;
}

const startCalls: StartCall[] = [];
const subscribeCalls: SubscribeCall[] = [];
const singleStartCalls: SingleStartCall[] = [];

vi.mock('../lib/api', () => ({
  api: {
    startCastDesign: (
      bookId: string,
      {
        characterIds,
        modelKey,
        scope,
        variantTasks,
      }: {
        characterIds: string[];
        modelKey: string;
        scope?: string;
        variantTasks?: { characterId: string; emotions: string[] }[];
      },
      cb: CastDesignCallbacks,
    ) =>
      new Promise<void>((resolve) => {
        startCalls.push({ bookId, characterIds, modelKey, scope, variantTasks, cb, resolve });
      }),
    subscribeCastDesign: (bookId: string, cb: CastDesignCallbacks) =>
      new Promise<void>((resolve) => {
        subscribeCalls.push({ bookId, cb, resolve });
      }),
    startSingleDesign: (
      bookId: string,
      args: SingleStartCall['args'],
      cb: CastDesignCallbacks,
    ) =>
      new Promise<void>((resolve) => {
        singleStartCalls.push({ bookId, args, cb, resolve });
      }),
    subscribeSingleDesign: (bookId: string, cb: CastDesignCallbacks) =>
      new Promise<void>((resolve) => {
        subscribeCalls.push({ bookId, cb, resolve });
      }),
  },
}));

import { createCastDesignMiddleware } from './cast-design-stream-middleware';
import { castDesignSlice, castDesignActions } from './cast-design-slice';
import { castSlice } from './cast-slice';
import { notificationsSlice } from './notifications-slice';

function makeStore(recorded?: { type: string }[]) {
  const recorder: import('@reduxjs/toolkit').Middleware = () => (next) => (action) => {
    if (recorded) recorded.push(action as { type: string });
    return next(action);
  };
  return configureStore({
    reducer: {
      castDesign: castDesignSlice.reducer,
      cast: castSlice.reducer,
      notifications: notificationsSlice.reducer,
    },
    middleware: (getDefault) =>
      getDefault().prepend(recorder).concat(createCastDesignMiddleware()),
  });
}

beforeEach(() => {
  startCalls.length = 0;
  subscribeCalls.length = 0;
  singleStartCalls.length = 0;
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
        { id: 'c1', name: 'Wren' } as never,
        { id: 'c2', name: 'Marlow' } as never,
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
    cb.onProgress?.({ characterId: 'c1', name: 'Wren', done: 0, total: 2 });
    expect(store.getState().castDesign.active?.currentName).toBe('Wren');

    cb.onCharacterDesigned?.({ characterId: 'c1', voiceId: 'qwen-c1' });
    expect(store.getState().castDesign.active?.done).toBe(1);
    /* Mirrored into the cast slice → row flips to Designed. */
    expect(
      store.getState().cast.characters.find((c) => c.id === 'c1')?.overrideTtsVoices?.qwen?.name,
    ).toBe('qwen-c1');

    cb.onProgress?.({ characterId: 'c2', name: 'Marlow', done: 1, total: 2 });
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
    cb.onCharacterFailed?.({ characterId: 'c1', name: 'Wren', errorReason: 'no gemini key' });
    cb.onCharacterDesigned?.({ characterId: 'c2', voiceId: 'qwen-c2' });
    cb.onIdle?.({
      done: 1,
      total: 2,
      skipped: 0,
      failures: [{ characterId: 'c1', name: 'Wren', error: 'no gemini key' }],
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
    cb.onResumeFrom?.({ total: 4, done: 2, currentName: 'Brann' });
    expect(store.getState().castDesign.active).toMatchObject({
      bookId: 'b1',
      total: 4,
      done: 2,
      currentName: 'Brann',
      state: 'running',
    });
  });

  it('designSingleRequested → phases, mirrors designed into cast, toasts', () => {
    const recorded: { type: string }[] = [];
    const store = makeStore(recorded);
    store.dispatch(
      castSlice.actions.setCharacters([{ id: 'c1', name: 'Aria' } as never]),
    );
    store.dispatch(
      castDesignActions.designSingleRequested({
        bookId: 'b1',
        characterId: 'c1',
        name: 'Aria',
        persona: 'warm',
        sampleVoiceId: 'char-c1',
        modelKey: 'qwen3-tts',
        mode: 'first',
      }),
    );

    expect(singleStartCalls).toHaveLength(1);
    expect(singleStartCalls[0].args).toMatchObject({
      characterId: 'c1',
      persona: 'warm',
      sampleVoiceId: 'char-c1',
      modelKey: 'qwen3-tts',
      preview: false,
    });

    const { cb } = singleStartCalls[0];
    cb.onPhase?.({ characterId: 'c1', phase: 'designing' });
    cb.onPhase?.({ characterId: 'c1', phase: 'rendering' });
    cb.onCharacterDesigned?.({ characterId: 'c1', voiceId: 'qwen-c1' });
    cb.onIdle?.({ done: 1, total: 1, skipped: 0, failures: [] });

    expect(recorded.map((a) => a.type)).toEqual(
      expect.arrayContaining([
        'castDesign/setPhase',
        'cast/setQwenOverrideName',
        'notifications/pushToast',
        'castDesign/settle',
      ]),
    );
    /* Mirrored into the cast slice → row flips to Designed. */
    expect(
      store.getState().cast.characters.find((c) => c.id === 'c1')?.overrideTtsVoices?.qwen?.name,
    ).toBe('qwen-c1');
  });

  it('preview_ready → ready-to-compare + a "ready to compare" toast', () => {
    const recorded: { type: string }[] = [];
    const store = makeStore(recorded);
    store.dispatch(
      castDesignActions.designSingleRequested({
        bookId: 'b1',
        characterId: 'c1',
        name: 'Aria',
        persona: 'warm',
        sampleVoiceId: 'char-c1',
        modelKey: 'qwen3-tts',
        mode: 'redesign',
      }),
    );

    expect(singleStartCalls).toHaveLength(1);
    expect(singleStartCalls[0].args.preview).toBe(true);

    const { cb } = singleStartCalls[0];
    cb.onPreviewReady?.({
      characterId: 'c1',
      name: 'Aria',
      previewVoiceId: 'qwen-c1-preview',
      previewUrl: '/x.mp3',
      persona: 'warm',
    });
    cb.onIdle?.({ done: 0, total: 1, skipped: 0, failures: [] });

    const types = recorded.map((a) => a.type);
    expect(types).toContain('castDesign/previewReady');
    expect(types).toContain('notifications/pushToast');
    /* Re-design stays staged for the drawer to resolve — NOT auto-cleared. */
    expect(store.getState().castDesign.active?.state).toBe('ready-to-compare');
  });

  /* ── fe-32 variant wiring ─────────────────────────────────────────────── */

  it('passes scope + variantTasks through to api.startCastDesign', () => {
    const store = makeStore();
    store.dispatch(
      castDesignActions.designAllRequested({
        bookId: 'b',
        characterIds: ['a'],
        modelKey: 'qwen3-tts-0.6b',
        scope: 'both',
        variantTasks: [{ characterId: 'a', emotions: ['angry'] }],
      }),
    );

    expect(startCalls).toHaveLength(1);
    expect(startCalls[0]).toMatchObject({
      bookId: 'b',
      scope: 'both',
      variantTasks: [{ characterId: 'a', emotions: ['angry'] }],
    });
  });

  it('onVariantDesigned mirrors the variant into the cast slice and bumps done', () => {
    const store = makeStore();
    /* Seed character 'a' so setCharacterEmotionVariant has somewhere to land. */
    store.dispatch(
      castSlice.actions.setCharacters([{ id: 'a', name: 'Alice' } as never]),
    );
    store.dispatch(
      castDesignActions.designAllRequested({
        bookId: 'b',
        characterIds: [],
        modelKey: 'qwen3-tts-0.6b',
        scope: 'variants',
        variantTasks: [{ characterId: 'a', emotions: ['angry'] }],
      }),
    );

    expect(startCalls).toHaveLength(1);
    const { cb } = startCalls[0];
    const doneBefore = store.getState().castDesign.active?.done ?? 0;
    cb.onVariantDesigned?.({ characterId: 'a', emotion: 'angry', voiceId: 'qwen-a__angry' });

    expect(store.getState().castDesign.active?.done).toBe(doneBefore + 1);
    expect(
      store.getState().cast.characters.find((c) => c.id === 'a')?.overrideTtsVoices?.qwen?.variants?.angry,
    ).toEqual({ name: 'qwen-a__angry' });
  });
});
