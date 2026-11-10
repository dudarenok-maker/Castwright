/* Pairs with docs/features/NNN-design-full-cast.md.

   Pins the cast-design middleware's contract: it owns the single SSE for the
   server bulk-design job, translating stream callbacks into slice dispatches,
   mirroring each `character_designed` into the cast slice (so rows flip live),
   continuing past per-character failures, settling + clearing on idle, and
   guarding against a second concurrent run (re-entrancy). Also pins the
   cold-boot `resubscribe` path (bare subscribe, seeded by `resume_from`). */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { configureStore } from '@reduxjs/toolkit';
import { render, screen } from '@testing-library/react';
import { Provider } from 'react-redux';
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

const { putBookState } = vi.hoisted(() => ({ putBookState: vi.fn(async () => {}) }));

vi.mock('../lib/api', () => ({
  api: {
    putBookState,
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
import { manuscriptSlice } from './manuscript-slice';
import { notificationsSlice } from './notifications-slice';
import { ToastStack } from '../components/toast-stack';

function makeStore(recorded?: { type: string }[]) {
  const recorder: import('@reduxjs/toolkit').Middleware = () => (next) => (action) => {
    if (recorded) recorded.push(action as { type: string });
    return next(action);
  };
  return configureStore({
    reducer: {
      castDesign: castDesignSlice.reducer,
      cast: castSlice.reducer,
      manuscript: manuscriptSlice.reducer,
      notifications: notificationsSlice.reducer,
    },
    middleware: (getDefault) =>
      getDefault().prepend(recorder).concat(createCastDesignMiddleware()),
  });
}

/* The slices hold ONE book at a time (open-book.ts); a single-design result lands in
   them only when they hold the book the design ran for. */
function openBook(store: ReturnType<typeof makeStore>, bookId: string): void {
  store.dispatch(
    manuscriptSlice.actions.hydrateFromBookState({
      state: { bookId, manuscriptId: `m_${bookId}`, title: bookId } as never,
      sentences: null,
    }),
  );
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
    openBook(store, 'b1');
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
    cb.onIdle?.({ done: 1, total: 1, skipped: 0, clonedSkips: [], failures: [] });

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
      clonedSkips: [],
      failures: [{ characterId: 'c1', name: 'Wren', error: 'no gemini key' }],
    });

    const snap = store.getState().castDesign.active;
    expect(snap?.done).toBe(1);
    expect(snap?.failures).toHaveLength(1);
    const message = store.getState().notifications.toasts.at(-1)?.message;
    expect(message).toContain('1 failed');
    /* #3027 review finding #2 — a bare count regressed the original
       acceptance criteria (a config problem like a missing GEMINI_API_KEY
       used to produce one clear, actionable toast). The actual error reason
       must reach the summary toast, not just feed the count. */
    expect(message).toContain('no gemini key');
  });

  it('multiple DIFFERENT failure reasons: toast uses the FIRST failure, not the last', () => {
    /* N4 (PR #3161 review pass 2) — with only one failure, or several sharing
       the same reason, the two branches of the sameReason ternary produce
       output that overlaps: swapping "First failure: X" for "X" is invisible
       when every failure's error is identical. This test forces at least two
       DIFFERENT reasons across characters so only the "first failure" branch
       can pass, and pins WHICH failure's error the toast surfaces. */
    const store = makeStore();
    store.dispatch(
      castDesignActions.designAllRequested({
        bookId: 'b1',
        characterIds: ['c1', 'c2', 'c3'],
        modelKey: 'k',
      }),
    );
    const { cb } = startCalls[0];
    cb.onCharacterFailed?.({ characterId: 'c1', name: 'Wren', errorReason: 'no gemini key' });
    cb.onCharacterFailed?.({ characterId: 'c2', name: 'Marlow', errorReason: 'rate limited' });
    cb.onIdle?.({
      done: 0,
      total: 3,
      skipped: 0,
      clonedSkips: [],
      failures: [
        { characterId: 'c1', name: 'Wren', error: 'no gemini key' },
        { characterId: 'c2', name: 'Marlow', error: 'rate limited' },
      ],
    });

    const message = store.getState().notifications.toasts.at(-1)?.message;
    expect(message).toContain('First failure: no gemini key');
    expect(message).not.toContain('rate limited');
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
    cb.onIdle?.({ done: 1, total: 2, skipped: 1, clonedSkips: [], failures: [] });
    expect(store.getState().castDesign.active?.skipped).toBe(1);
    expect(store.getState().notifications.toasts.at(-1)?.message).toContain('1 skipped');
  });

  /* GATE 2 C-6 — server/src/routes/cast-design.ts's `job.clonedSkips` names
     the characters a bulk sweep protected from being silently retargeted
     off a clone. "Design full cast" quietly designing fewer characters than
     asked is exactly the silence this exists to remove, so the names must
     reach the terminal summary — not just fold into the anonymous `skipped`
     count. Renders the real `ToastStack` off the SAME store the middleware
     dispatched into, so this proves the names land in the DOM, not merely
     that the field was parsed off the SSE frame. */
  it('[C-6] names the clone-protected skips in the terminal summary toast, and it reaches the DOM', () => {
    const store = makeStore();
    store.dispatch(
      castDesignActions.designAllRequested({
        bookId: 'b1',
        characterIds: ['c1', 'c2', 'c3'],
        modelKey: 'k',
      }),
    );
    const { cb } = startCalls[0];
    cb.onCharacterDesigned?.({ characterId: 'c1', voiceId: 'qwen-c1' });
    cb.onIdle?.({
      done: 1,
      total: 3,
      skipped: 2,
      clonedSkips: [
        { characterId: 'c2', name: 'Anna' },
        { characterId: 'c3', name: 'Viktor' },
      ],
      failures: [],
    });

    const toastMessage = store.getState().notifications.toasts.at(-1)?.message;
    expect(toastMessage).toContain('already cloned: Anna, Viktor');

    render(
      <Provider store={store}>
        <ToastStack />
      </Provider>,
    );
    /* THE discriminator: pre-fix `clonedSkips` is parsed nowhere — this
       text never reaches a toast, so it never reaches the DOM either. */
    expect(screen.getByText(/already cloned: Anna, Viktor/)).toBeInTheDocument();
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
    openBook(store, 'b1');
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
    cb.onIdle?.({ done: 1, total: 1, skipped: 0, clonedSkips: [], failures: [] });

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

  it('a design the server refused as shared (#3992) toasts its message and changes nothing in the cast', () => {
    const recorded: { type: string }[] = [];
    const store = makeStore(recorded);
    openBook(store, 'b1');
    store.dispatch(
      castSlice.actions.setCharacters([
        { id: 'c1', name: 'Aria', voiceUuid: 'u_shared', overrideTtsVoices: { qwen: { name: 'qwen-u_shared' } } } as never,
      ]),
    );
    const castBefore = store.getState().cast;
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
    const message = 'Redesign "Book Two" first. This voice is shared with it.';
    singleStartCalls[0].cb.onError?.({ code: 'design_failed', message });

    const toasts = store.getState().notifications.toasts as Array<{ kind: string; message: string }>;
    expect(toasts.some((t) => t.kind === 'error' && t.message === message)).toBe(true);
    expect(store.getState().cast).toBe(castBefore);
    expect(recorded.map((a) => a.type).filter((t) => t.startsWith('cast/'))).toEqual(['cast/setCharacters']);
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
    cb.onIdle?.({ done: 0, total: 1, skipped: 0, clonedSkips: [], failures: [] });

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

  /* srv-43: previewReady voiceUuid threading — the middleware must pass the
     uuid from the SSE event through to the castDesign/previewReady action so
     the drawer can resolve the uuid-keyed cache entry before a cast refetch. */
  it('onPreviewReady threads voiceUuid into the previewReady slice action', () => {
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
        mode: 'redesign',
      }),
    );

    const { cb } = singleStartCalls[0];
    cb.onPreviewReady?.({
      characterId: 'c1',
      name: 'Aria',
      previewVoiceId: 'qwen-c1-preview',
      previewUrl: '/x.mp3',
      persona: 'warm',
      voiceUuid: 'uuid-c1-abc',
    });

    expect(store.getState().castDesign.active?.preview?.voiceUuid).toBe('uuid-c1-abc');
  });

  /* srv-43: first-design voiceUuid mirroring — onCharacterDesigned with a voiceUuid
     must dispatch setCharacterVoiceUuid so the character's uuid lands in Redux
     before a cast refetch, letting the drawer resolve the sample-cache entry. */
  it('onCharacterDesigned mirrors voiceUuid into the cast slice when present', () => {
    const store = makeStore();
    openBook(store, 'b1');
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

    const { cb } = singleStartCalls[0];
    cb.onCharacterDesigned?.({ characterId: 'c1', voiceId: 'qwen-c1', voiceUuid: 'uuid-c1-xyz' });

    expect(
      store.getState().cast.characters.find((c) => c.id === 'c1')?.voiceUuid,
    ).toBe('uuid-c1-xyz');
  });

  /* #3992 pass 3: a re-design's preview runs AFTER the server forked a declined
     row's uuid and dropped its variants; the Cancel path never approves, so the
     preview is where redux has to learn the new uuid (and drop the stale slots)
     before an autosave writes them back. */
  it('onPreviewReady mirrors a forked voiceUuid and drops the variants that went with it', () => {
    const store = makeStore();
    openBook(store, 'b1');
    store.dispatch(
      castSlice.actions.setCharacters([
        {
          id: 'c1',
          name: 'Aria',
          voiceUuid: 'u_shared',
          overrideTtsVoices: {
            qwen: { name: 'qwen-u_shared', variants: { angry: { name: 'qwen-u_shared__angry' } } },
          },
        } as never,
      ]),
    );
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
    singleStartCalls[0].cb.onPreviewReady?.({
      characterId: 'c1',
      name: 'Aria',
      previewVoiceId: 'qwen-u_forked-preview',
      previewUrl: '/x.mp3',
      persona: 'warm',
      voiceUuid: 'u_forked',
    });
    const row = store.getState().cast.characters.find((c) => c.id === 'c1')!;
    expect(row.voiceUuid).toBe('u_forked');
    expect(row.overrideTtsVoices?.qwen?.variants).toBeUndefined();
  });

  /* #4074: the design's uuid step separated the row, then the landing refused on a clone;
     the separation persists, so the error event carries it and the tab mirrors the fork. */
  it('a clone_protected error that carries a separation mirrors the fork and drops the variants', () => {
    const store = makeStore();
    openBook(store, 'b1');
    store.dispatch(
      castSlice.actions.setCharacters([
        {
          id: 'c1',
          name: 'Aria',
          voiceUuid: 'u_shared',
          overrideTtsVoices: {
            qwen: { name: 'qwen-u_shared', variants: { angry: { name: 'qwen-u_shared__angry' } } },
          },
        } as never,
      ]),
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
    singleStartCalls[0].cb.onError?.({
      code: 'clone_protected',
      message: 'refused',
      characterId: 'c1',
      voiceUuid: 'u_forked',
      separated: true,
    });
    const row = store.getState().cast.characters.find((c) => c.id === 'c1')!;
    expect(row.voiceUuid).toBe('u_forked');
    expect(row.overrideTtsVoices?.qwen?.variants).toBeUndefined();
  });

  it('onPreviewReady without a voiceUuid leaves the row alone', () => {
    const store = makeStore();
    store.dispatch(
      castSlice.actions.setCharacters([{ id: 'c1', name: 'Aria', voiceUuid: 'u_keep' } as never]),
    );
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
    singleStartCalls[0].cb.onPreviewReady?.({
      characterId: 'c1',
      name: 'Aria',
      previewVoiceId: 'p',
      previewUrl: '/x.mp3',
      persona: 'warm',
    });
    expect(store.getState().cast.characters.find((c) => c.id === 'c1')?.voiceUuid).toBe('u_keep');
  });

  /* #3992 pass 4: the slices hold ONE book. A result for a book that is no longer
     the open one must not write its uuid into another book's rows (series books
     share character ids): the server already persisted it, and the next open of
     that book reads it. */
  describe('a single design for a book that is not the open one', () => {
    const seed = () => {
      const store = makeStore();
      openBook(store, 'b3'); // Book Three is open ...
      store.dispatch(
        castSlice.actions.setCharacters([
          {
            id: 'c1',
            name: 'Aria',
            voiceUuid: 'u_three',
            overrideTtsVoices: {
              qwen: { name: 'qwen-u_three', variants: { angry: { name: 'qwen-u_three__angry' } } },
            },
          } as never,
        ]),
      );
      store.dispatch(
        castDesignActions.designSingleRequested({
          bookId: 'b2', // ... but the design ran for Book Two
          characterId: 'c1',
          name: 'Aria',
          persona: 'warm',
          sampleVoiceId: 'char-c1',
          modelKey: 'qwen3-tts',
          mode: 'redesign',
        }),
      );
      return store;
    };
    const rowOf = (store: ReturnType<typeof makeStore>) =>
      store.getState().cast.characters.find((c) => c.id === 'c1')!;

    it('onPreviewReady leaves the open book’s row, uuid and variants alone, but still stages the compare', () => {
      const store = seed();
      singleStartCalls[0].cb.onPreviewReady?.({
        characterId: 'c1',
        name: 'Aria',
        previewVoiceId: 'qwen-u_two2-preview',
        previewUrl: '/x.mp3',
        persona: 'warm',
        voiceUuid: 'u_two2',
      });
      expect(rowOf(store).voiceUuid).toBe('u_three');
      expect(rowOf(store).overrideTtsVoices?.qwen?.variants).toBeDefined();
      expect(store.getState().castDesign.active?.state).toBe('ready-to-compare');
    });

    it('onCharacterDesigned leaves the open book’s row alone, but still settles and toasts', () => {
      const store = seed();
      singleStartCalls[0].cb.onCharacterDesigned?.({
        characterId: 'c1',
        voiceId: 'qwen-u_two2',
        voiceUuid: 'u_two2',
      });
      expect(rowOf(store).voiceUuid).toBe('u_three');
      expect(rowOf(store).overrideTtsVoices?.qwen?.name).toBe('qwen-u_three');
      expect(store.getState().castDesign.active?.state).toBe('done');
      expect(store.getState().notifications.toasts.length).toBeGreaterThan(0);
    });

    it('failure path: with no book open at all nothing is written either', () => {
      const store = makeStore(); // manuscript slice holds no book
      store.dispatch(castSlice.actions.setCharacters([{ id: 'c1', name: 'Aria', voiceUuid: 'u_keep' } as never]));
      store.dispatch(
        castDesignActions.designSingleRequested({
          bookId: 'b2',
          characterId: 'c1',
          name: 'Aria',
          persona: 'warm',
          sampleVoiceId: 'char-c1',
          modelKey: 'qwen3-tts',
          mode: 'first',
        }),
      );
      singleStartCalls[0].cb.onCharacterDesigned?.({ characterId: 'c1', voiceId: 'qwen-x', voiceUuid: 'u_new' });
      expect(store.getState().cast.characters.find((c) => c.id === 'c1')?.voiceUuid).toBe('u_keep');
    });
  });

  /* #3992 pass 5: the bulk job mirrors into the slices under the same rule. */
  describe('a bulk design for a book that is not the open one', () => {
    const seed = (open: string | null) => {
      const store = makeStore();
      if (open) openBook(store, open);
      store.dispatch(
        castSlice.actions.setCharacters([
          {
            id: 'c1',
            name: 'Aria',
            overrideTtsVoices: { qwen: { name: 'qwen-u_three' } },
          } as never,
        ]),
      );
      store.dispatch(
        castDesignActions.designAllRequested({
          bookId: 'b2', // the job ran for Book Two
          characterIds: ['c1'],
          modelKey: 'qwen3-tts-0.6b',
          scope: 'both',
          variantTasks: [{ characterId: 'c1', emotions: ['angry'] }],
        }),
      );
      return store;
    };
    const rowOf = (store: ReturnType<typeof makeStore>) =>
      store.getState().cast.characters.find((c) => c.id === 'c1')!;

    for (const [label, open] of [
      ['a different book open', 'b3'],
      ['no book open', null],
    ] as const) {
      it(`${label}: onCharacterDesigned leaves the cast slice alone but still counts progress`, () => {
        const store = seed(open);
        startCalls[0].cb.onCharacterDesigned?.({ characterId: 'c1', voiceId: 'qwen-u_two' });
        expect(rowOf(store).overrideTtsVoices?.qwen?.name).toBe('qwen-u_three');
        expect(store.getState().castDesign.active?.done).toBe(1);
      });

      it(`${label}: onVariantDesigned leaves the cast slice alone but still counts progress and the fallback`, () => {
        const store = seed(open);
        startCalls[0].cb.onVariantDesigned?.({
          characterId: 'c1',
          emotion: 'angry',
          voiceId: 'qwen-u_two__angry',
          viaFallback: true,
        });
        expect(rowOf(store).overrideTtsVoices?.qwen?.variants).toBeUndefined();
        expect(store.getState().castDesign.active?.done).toBe(1);
        expect(store.getState().castDesign.active?.fallbacks).toEqual([{ characterId: 'c1', emotion: 'angry' }]);
      });
    }

    it('the open book still mirrors', () => {
      const store = seed('b2');
      startCalls[0].cb.onCharacterDesigned?.({ characterId: 'c1', voiceId: 'qwen-u_two' });
      startCalls[0].cb.onVariantDesigned?.({ characterId: 'c1', emotion: 'angry', voiceId: 'qwen-u_two__angry' });
      expect(rowOf(store).overrideTtsVoices?.qwen?.name).toBe('qwen-u_two');
      expect(rowOf(store).overrideTtsVoices?.qwen?.variants?.angry).toEqual({ name: 'qwen-u_two__angry' });
    });
  });

  it('onVariantDesigned mirrors the variant into the cast slice and bumps done', () => {
    const store = makeStore();
    openBook(store, 'b');
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

  it('onVariantDesigned with viaFallback dispatches variantFellBack', () => {
    const recorded: { type: string }[] = [];
    const store = makeStore(recorded);
    store.dispatch(
      castSlice.actions.setCharacters([{ id: 'c', name: 'Carol' } as never]),
    );
    store.dispatch(
      castDesignActions.designAllRequested({
        bookId: 'b',
        characterIds: [],
        modelKey: 'qwen3-tts-0.6b',
        scope: 'variants',
        variantTasks: [{ characterId: 'c', emotions: ['angry'] }],
      }),
    );

    const { cb } = startCalls[0];
    cb.onVariantDesigned?.({ characterId: 'c', emotion: 'angry', voiceId: 'qwen-c__angry', viaFallback: true });

    expect(recorded.map((a) => a.type)).toContain('castDesign/variantFellBack');
    expect(store.getState().castDesign.active?.fallbacks).toEqual([{ characterId: 'c', emotion: 'angry' }]);
  });

  it('includes a fallback count in the completion toast', () => {
    const store = makeStore();
    store.dispatch(
      castSlice.actions.setCharacters([{ id: 'c', name: 'Carol' } as never]),
    );
    store.dispatch(
      castDesignActions.designAllRequested({
        bookId: 'b',
        characterIds: [],
        modelKey: 'qwen3-tts-0.6b',
        scope: 'variants',
        variantTasks: [{ characterId: 'c', emotions: ['angry'] }],
      }),
    );

    const { cb } = startCalls[0];
    // Record one fallback via the viaFallback path, then call onIdle.
    cb.onVariantDesigned?.({ characterId: 'c', emotion: 'angry', voiceId: 'qwen-c__angry', viaFallback: true });
    cb.onIdle?.({ done: 1, total: 1, skipped: 0, clonedSkips: [], failures: [] });

    const toasts = (store.getState() as { notifications: { toasts: { message: string }[] } }).notifications.toasts;
    expect(toasts.at(-1)?.message).toMatch(/1 via fallback/);
  });

  it('dispatches an error toast when a single design request arrives while a bulk job is running', () => {
    const recorded: { type: string }[] = [];
    const store = makeStore(recorded);
    store.dispatch(
      castSlice.actions.setCharacters([{ id: 'c1', name: 'Aria' } as never]),
    );

    // Start a bulk design that never resolves — handle stays occupied.
    store.dispatch(
      castDesignActions.designAllRequested({
        bookId: 'b1',
        characterIds: ['c1'],
        modelKey: 'qwen3-tts-0.6b',
        scope: 'bases',
      }),
    );
    expect(startCalls).toHaveLength(1);

    // Fire a single design request while handle is busy.
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

    // No second API call should have been made.
    expect(singleStartCalls).toHaveLength(0);

    // An error toast naming the busy state should have been dispatched.
    const toastActions = recorded.filter(
      (a): a is { type: string; payload: { kind: string; message: string } } =>
        a.type === 'notifications/pushToast',
    );
    expect(toastActions).toHaveLength(1);
    expect(toastActions[0].payload.kind).toBe('error');
    expect(toastActions[0].payload.message).toMatch(/already running/);
  });

  it('dispatches an error toast when a bulk design request arrives while another job is running', () => {
    const recorded: { type: string }[] = [];
    const store = makeStore(recorded);
    store.dispatch(
      castSlice.actions.setCharacters([{ id: 'c1', name: 'Aria' } as never]),
    );

    // Start a bulk design that never resolves — handle stays occupied.
    store.dispatch(
      castDesignActions.designAllRequested({
        bookId: 'b1',
        characterIds: ['c1'],
        modelKey: 'qwen3-tts-0.6b',
        scope: 'bases',
      }),
    );
    expect(startCalls).toHaveLength(1);

    // Fire a second bulk design request while handle is busy.
    store.dispatch(
      castDesignActions.designAllRequested({
        bookId: 'b1',
        characterIds: ['c1'],
        modelKey: 'qwen3-tts-0.6b',
        scope: 'bases',
      }),
    );

    // Only one API call should have been made.
    expect(startCalls).toHaveLength(1);

    // An error toast naming the busy state should have been dispatched.
    const toastActions = recorded.filter(
      (a): a is { type: string; payload: { kind: string; message: string } } =>
        a.type === 'notifications/pushToast',
    );
    expect(toastActions).toHaveLength(1);
    expect(toastActions[0].payload.kind).toBe('error');
    expect(toastActions[0].payload.message).toMatch(/already running/);
  });
});

/* #4067 — the design-time separation of a declined row renames its qwen slot on
   disk; through the REAL persistence middleware, the next whole-roster cast PUT
   must carry the new name, not `qwen-<old>` (the server's preserve guard lets an
   incoming slot win when the uuid matches). */
describe('a design that separates a declined row, then a later cast save (#4067)', () => {
  const declined = () =>
    ({
      id: 'c1',
      name: 'Aria',
      voiceUuid: 'u_shared',
      overrideTtsVoices: {
        qwen: { name: 'qwen-u_shared', variants: { angry: { name: 'qwen-u_shared__angry' } } },
      },
    }) as never;

  type PreviewEvent = Parameters<NonNullable<CastDesignCallbacks['onPreviewReady']>>[0];
  async function designThenSave(
    row: unknown = declined(),
    event: Partial<PreviewEvent> = {},
    via: 'preview' | 'designed' = 'preview',
  ) {
    const { persistenceMiddleware, flushBookPersistence } = await import('./persistence-middleware');
    const { uiSlice } = await import('./ui-slice');
    const initialUi = uiSlice.getInitialState();
    const store = configureStore({
      reducer: {
        castDesign: castDesignSlice.reducer,
        cast: castSlice.reducer,
        manuscript: manuscriptSlice.reducer,
        notifications: notificationsSlice.reducer,
        ui: uiSlice.reducer,
      },
      preloadedState: {
        ui: { ...initialUi, stage: { kind: 'ready', bookId: 'b1', view: 'cast' } } as ReturnType<
          typeof uiSlice.getInitialState
        >,
      },
      middleware: (g) =>
        g({ serializableCheck: false }).concat(persistenceMiddleware, createCastDesignMiddleware()),
    });
    openBook(store as never, 'b1');
    store.dispatch(castSlice.actions.setCharacters([row as never]));
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
    const { cb } = singleStartCalls[0];
    /* A re-design job ends in `preview_ready` alone (single-design.ts); the
       server never sends `designed` for it. */
    if (via === 'designed') {
      /* A first design persists on the server and ends in `designed`, carrying the
         post-separation `voiceId`. */
      cb.onCharacterDesigned?.({
        characterId: 'c1',
        voiceId: 'qwen-u_forked',
        voiceUuid: 'u_forked',
        separated: event.separated,
      });
    } else {
      cb.onPreviewReady?.({
        characterId: 'c1',
        name: 'Aria',
        previewVoiceId: 'qwen-u_forked-preview',
        previewUrl: '/x.mp3',
        persona: 'warm',
        voiceUuid: 'u_forked',
        ...event,
      });
    }
    putBookState.mockClear();
    store.dispatch(castSlice.actions.lockVoice('c1'));
    await store.dispatch(flushBookPersistence('b1') as never);
    const puts = (putBookState.mock.calls as unknown as [string, { slice: string; patch: unknown }][]).filter(
      (c) => c[1].slice === 'cast',
    );
    expect(puts.length).toBeGreaterThan(0);
    const patch = puts[puts.length - 1][1].patch as {
      characters: { id: string; voiceUuid?: string; overrideTtsVoices?: { qwen?: { name: string; variants?: unknown } } }[];
    };
    return patch.characters.find((c) => c.id === 'c1')!;
  }

  it('preview cancelled: the next PUT carries qwen-<new> and no stale variants', async () => {
    vi.useRealTimers();
    const sent = await designThenSave();
    expect(sent.voiceUuid).toBe('u_forked');
    expect(sent.overrideTtsVoices?.qwen?.name).toBe('qwen-u_forked');
    expect(sent.overrideTtsVoices?.qwen?.variants).toBeUndefined();
  });

  /* A declined row the merge left with NO voiceUuid (#4067): its first design is a
     separation on the server (rename + variants dropped), but `undefined -> uuid`
     reads as a first mint on the client, which keeps the legacy name. Only the
     server's `separated` tells the two apart. */
  const legacy = () =>
    ({
      id: 'c1',
      name: 'Aria',
      overrideTtsVoices: {
        qwen: { name: 'qwen-v_aria', variants: { angry: { name: 'qwen-v_aria__angry' } } },
      },
    }) as never;

  it('a row with no uuid the server separated: the next PUT carries qwen-<new> and no variants', async () => {
    vi.useRealTimers();
    const sent = await designThenSave(legacy(), { separated: true });
    expect(sent.voiceUuid).toBe('u_forked');
    expect(sent.overrideTtsVoices?.qwen?.name).toBe('qwen-u_forked');
    expect(sent.overrideTtsVoices?.qwen?.variants).toBeUndefined();
  });

  it('a row with no uuid that was only minted one (separated false): the legacy name stays', async () => {
    vi.useRealTimers();
    const sent = await designThenSave(legacy(), { separated: false });
    expect(sent.voiceUuid).toBe('u_forked');
    expect(sent.overrideTtsVoices?.qwen?.name).toBe('qwen-v_aria');
  });

  /* The `designed` path: its `voiceId` (`qwen-<new>`) already sets the name, but a row
     with NO uuid keeps its variants under a first mint, so the flag still decides
     whether they are dropped. (A row that had a uuid drops them on any changed
     uuid, so only the no-uuid row can tell the flag from its absence.) */
  it('designed, a row with no uuid the server separated: the next PUT carries no variants', async () => {
    vi.useRealTimers();
    const sent = await designThenSave(legacy(), { separated: true }, 'designed');
    expect(sent.voiceUuid).toBe('u_forked');
    expect(sent.overrideTtsVoices?.qwen?.name).toBe('qwen-u_forked');
    expect(sent.overrideTtsVoices?.qwen?.variants).toBeUndefined();
  });
});
