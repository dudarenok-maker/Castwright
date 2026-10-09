/* fs-26 — the background splice runner: one splice SSE per chapter, sequential,
   refreshing the chapter audio and refetching the active book's server-owned
   revisions on completion, and tracking batch progress + inFlightChapters.
   Plan 286 (#3400) — the client never writes pending; the server records it
   and the runner refetches instead. api.streamSplice/pollRevisions are
   mocked so no backend is needed. */

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { configureStore } from '@reduxjs/toolkit';
import type { SpliceArgs, SpliceTick } from '../lib/api';

const { streamSpliceSpy, putBookStateSpy, pollRevisionsSpy } = vi.hoisted(() => ({
  streamSpliceSpy: vi.fn(),
  putBookStateSpy: vi.fn().mockResolvedValue(undefined),
  pollRevisionsSpy: vi.fn(),
}));
vi.mock('../lib/api', () => ({
  api: { streamSplice: streamSpliceSpy, putBookState: putBookStateSpy, pollRevisions: pollRevisionsSpy },
}));

import { spliceSlice, spliceActions } from './splice-slice';
import { chaptersSlice } from './chapters-slice';
import { revisionsSlice } from './revisions-slice';
import { notificationsSlice } from './notifications-slice';
import { uiSlice, uiActions } from './ui-slice';
import { persistenceMiddleware } from './persistence-middleware';
import { spliceRunnerMiddleware } from './splice-runner-middleware';
import type { Chapter } from '../lib/types';

const CHAPTERS: Chapter[] = [
  { id: 1, title: 'One', duration: '2:00', state: 'done', progress: 1, characters: { castor: 'done' }, phase: null, audioModelKey: 'kokoro-v1' },
  { id: 2, title: 'Two', duration: '2:00', state: 'done', progress: 1, characters: { castor: 'done' }, phase: null, audioModelKey: 'kokoro-v1' },
] as Chapter[];

function makeStore(currentBookId = 'bk1') {
  return configureStore({
    reducer: {
      splice: spliceSlice.reducer,
      chapters: chaptersSlice.reducer,
      revisions: revisionsSlice.reducer,
      notifications: notificationsSlice.reducer,
      ui: uiSlice.reducer,
    },
    preloadedState: {
      chapters: { ...chaptersSlice.getInitialState(), chapters: CHAPTERS, currentBookId },
      /* `revisions.bookId` starts already scoped to `currentBookId`, matching
         the real app: by the time a splice batch can start, the active book
         has already been opened and its hydrate (real or null) has landed,
         scoping the two together. */
      revisions: { ...revisionsSlice.getInitialState(), bookId: currentBookId },
      ui: {
        ...uiSlice.getInitialState(),
        stage: {
          kind: 'ready' as const,
          bookId: currentBookId,
          view: 'cast' as const,
          currentChapterId: 3,
          openProfileId: null,
        },
      },
    },
    middleware: (getDefault) =>
      getDefault().concat(persistenceMiddleware, spliceRunnerMiddleware()),
  });
}

/** Wait for the async batch loop (microtask-driven) to settle. */
async function flush() {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
}

/* Action-type recorder — a store built via `makeStoreWithRecorder` below
   appends every dispatched action's type here, cleared in `beforeEach`. The
   `pending` assertion alone can't prove "never writes pending": the refetch's
   `applyPoll` adopts the mocked empty server state and would wipe a stray
   client enqueue before any assertion runs, so the plan 286 tests check the
   action stream itself. */
const dispatched: string[] = [];

function makeStoreWithRecorder(currentBookId = 'bk1') {
  return configureStore({
    reducer: {
      splice: spliceSlice.reducer,
      chapters: chaptersSlice.reducer,
      revisions: revisionsSlice.reducer,
      notifications: notificationsSlice.reducer,
      ui: uiSlice.reducer,
    },
    preloadedState: {
      chapters: { ...chaptersSlice.getInitialState(), chapters: CHAPTERS, currentBookId },
      revisions: { ...revisionsSlice.getInitialState(), bookId: currentBookId },
      ui: {
        ...uiSlice.getInitialState(),
        stage: {
          kind: 'ready' as const,
          bookId: currentBookId,
          view: 'cast' as const,
          currentChapterId: 3,
          openProfileId: null,
        },
      },
    },
    middleware: (getDefault) =>
      getDefault().concat(
        persistenceMiddleware,
        spliceRunnerMiddleware(),
        () => (next: (a: unknown) => unknown) => (a: unknown) => {
          dispatched.push((a as { type: string }).type);
          return next(a);
        },
      ),
  });
}

describe('spliceRunnerMiddleware', () => {
  beforeEach(() => {
    streamSpliceSpy.mockReset();
    putBookStateSpy.mockClear();
    pollRevisionsSpy.mockReset().mockResolvedValue({ drift: [] });
    dispatched.length = 0;
    streamSpliceSpy.mockImplementation(async (args: SpliceArgs) => {
      args.onTick({
        type: 'splice_complete',
        chapterId: args.chapterId,
        characterId: args.characterId,
        mode: args.mode,
        durationSec: 222,
        segmentCount: 1,
        hasPreviousAudio: true,
      } as SpliceTick);
    });
  });

  it('plan 286 — runs one splice per chapter, never writes pending, refetches the active book, refreshes audio, counts results', async () => {
    const store = makeStoreWithRecorder();
    store.dispatch(spliceActions.startBatch({ id: 'b1', bookId: 'bk1', characterId: 'castor', characterName: 'Castor Allred', mode: 'remix', gainDb: 6, chapterIds: [1, 2] }));
    await flush();
    expect(streamSpliceSpy).toHaveBeenCalledTimes(2);
    expect(pollRevisionsSpy).toHaveBeenCalledWith({ bookId: 'bk1' });
    expect(dispatched.filter((t) => t.startsWith('revisions/') && t !== 'revisions/applyPoll')).toEqual([]);
    expect(store.getState().revisions.pending).toEqual([]);
    expect(putBookStateSpy.mock.calls.some((c) => (c[1] as { slice: string }).slice === 'revisions')).toBe(false);
    expect(store.getState().chapters.chapters.find((c) => c.id === 1)!.duration).toBe('03:42');
    expect(store.getState().splice.batches.b1).toMatchObject({ total: 2, succeeded: 2, failed: 0, status: 'done' });
  });

  it('plan 286 — a splice that finishes while the user is on another book does not refetch', async () => {
    const store = makeStoreWithRecorder();
    streamSpliceSpy.mockImplementation(async (args: SpliceArgs) => {
      store.dispatch(uiActions.openBook({ id: 'other', status: 'complete' } as never));
      args.onTick({ type: 'splice_complete', chapterId: args.chapterId, characterId: args.characterId, mode: args.mode, durationSec: 222, segmentCount: 1, hasPreviousAudio: true } as SpliceTick);
    });
    store.dispatch(spliceActions.startBatch({ id: 'b2', bookId: 'bk1', characterId: 'castor', characterName: 'Castor', mode: 'remix', gainDb: 6, chapterIds: [1] }));
    await flush();
    expect(pollRevisionsSpy).not.toHaveBeenCalled();
  });

  it('plan 286 — inFlightChapters tracks the running chapter per book and clears on completion or failure', async () => {
    /* Failure is driven through a chapter_failed tick, as 'counts a failed chapter
       without aborting the rest' (~:119-121) does — NOT a throwing streamSplice:
       the middleware launches the batch with `void runBatch(...)`, so a throw
       would surface as an unhandled rejection rather than a counted failure. */
    let release!: () => void;
    streamSpliceSpy
      .mockImplementationOnce((args: SpliceArgs) => new Promise<void>((r) => (release = () => {
        args.onTick({ type: 'splice_complete', chapterId: args.chapterId, characterId: args.characterId, mode: args.mode, durationSec: 120, segmentCount: 1, hasPreviousAudio: true } as SpliceTick);
        r();
      })))
      .mockImplementationOnce(async (args: SpliceArgs) => { args.onTick({ type: 'chapter_failed', chapterId: args.chapterId, errorReason: 'boom' }); });
    const store = makeStoreWithRecorder();
    store.dispatch(spliceActions.startBatch({ id: 'b3', bookId: 'bk1', characterId: 'castor', characterName: 'Castor', mode: 'remix', gainDb: 6, chapterIds: [1, 2] }));
    await flush();
    expect(store.getState().splice.inFlightChapters).toEqual([{ bookId: 'bk1', chapterId: 1 }]);
    release(); await flush();
    expect(store.getState().splice.batches.b3).toMatchObject({ succeeded: 1, failed: 1, status: 'done' });
    expect(store.getState().splice.inFlightChapters).toEqual([]); // chapter 2 failed and still settled
  });

  it("plan 286 — reviewOutcome:'failed' toasts once", async () => {
    streamSpliceSpy.mockImplementation(async (args: SpliceArgs) => {
      args.onTick({ type: 'splice_complete', chapterId: args.chapterId, characterId: args.characterId, mode: args.mode, durationSec: 222, segmentCount: 1, hasPreviousAudio: true, reviewOutcome: 'failed' } as SpliceTick);
    });
    const store = makeStoreWithRecorder();
    store.dispatch(spliceActions.startBatch({ id: 'b4', bookId: 'bk1', characterId: 'castor', characterName: 'Castor', mode: 'remix', gainDb: 6, chapterIds: [1, 2] }));
    await flush();
    expect(store.getState().notifications.toasts.filter((t) => t.message === "The new take is live, but its A/B review couldn't be saved")).toHaveLength(1);
  });

  it('counts a failed chapter without aborting the rest', async () => {
    streamSpliceSpy.mockImplementation(async (args: SpliceArgs) => {
      if (args.chapterId === 1) {
        args.onTick({ type: 'chapter_failed', chapterId: 1, errorReason: 'boom' });
      } else {
        args.onTick({
          type: 'splice_complete', chapterId: args.chapterId, characterId: args.characterId,
          mode: args.mode, durationSec: 120, segmentCount: 1, hasPreviousAudio: true,
        } as SpliceTick);
      }
    });
    const store = makeStore();
    store.dispatch(
      spliceActions.startBatch({
        id: 'b2', bookId: 'bk1', characterId: 'castor', characterName: 'Castor', mode: 'remix', gainDb: 3, chapterIds: [1, 2],
      }),
    );
    await flush();
    expect(streamSpliceSpy).toHaveBeenCalledTimes(2);
    expect(store.getState().splice.batches.b2).toMatchObject({ succeeded: 1, failed: 1, status: 'done' });
  });

  /* [#1889 follow-up] chapter-splice.ts has always sent a `warning` frame when
     clearMismatchedDesignedVoices drops a reused designed voice, but the frame
     was in neither the splice openapi enum nor SpliceTick, so onTick parsed it
     and dropped it on the floor. These two cases pin the frame the ROUTE sends
     reaching a real toast — not enum membership. */
  const WARN_MESSAGE =
    '1 designed voice(s) were cleared because they were designed for a different language ' +
    'than this book — re-design Castor Allred before generating.';

  it('surfaces a warning frame from the splice stream as a warn toast', async () => {
    streamSpliceSpy.mockImplementation(async (args: SpliceArgs) => {
      args.onTick({
        type: 'warning',
        code: 'voice_language_mismatch',
        message: WARN_MESSAGE,
      } as SpliceTick);
      args.onTick({
        type: 'splice_complete', chapterId: args.chapterId, characterId: args.characterId,
        mode: args.mode, durationSec: 120, segmentCount: 1, hasPreviousAudio: true,
      } as SpliceTick);
    });
    const store = makeStore();
    store.dispatch(
      spliceActions.startBatch({
        id: 'b3', bookId: 'bk1', characterId: 'castor', characterName: 'Castor', mode: 'rerecord',
        modelKey: 'kokoro-v1', chapterIds: [1, 2],
      }),
    );
    await flush();

    const warned = store
      .getState()
      .notifications.toasts.filter((t) => t.dedupeKey === 'splice-warning:voice_language_mismatch');
    /* Exactly one despite TWO chapters each emitting the frame — the dedupeKey
       collapses the batch into a single advisory. */
    expect(warned).toHaveLength(1);
    expect(warned[0]).toMatchObject({ kind: 'warn', message: WARN_MESSAGE });
    /* The batch itself still succeeded — the advisory is non-fatal. */
    expect(store.getState().splice.batches.b3).toMatchObject({ succeeded: 2, failed: 0 });
  });

  it('pushes no language-mismatch toast when the stream sends no warning frame', async () => {
    /* Negative arm — without this, an unconditional pushToast would pass the
       positive case above and still be wrong. */
    const store = makeStore();
    store.dispatch(
      spliceActions.startBatch({
        id: 'b4', bookId: 'bk1', characterId: 'castor', characterName: 'Castor', mode: 'remix',
        gainDb: 2, chapterIds: [1, 2],
      }),
    );
    await flush();

    expect(
      store.getState().notifications.toasts.filter((t) => t.kind === 'warn'),
    ).toHaveLength(0);
  });

  it('does not stamp audio update when splice completes for a different book than current', async () => {
    /* Guard on currentBookId: a splice for book bk1 should not mark chapter
       audio as updated if the user has since navigated to book bk2. Without
       the guard, it would stamp bk2's chapter 1 with bk1's audio duration,
       confusing the user. This test verifies the guard by starting a splice
       for bk1, switching to bk2 before completion, and asserting bk2's
       chapter 1 is NOT updated. */
    const completionCallbackHolder: { fn: (() => void) | null } = { fn: null };
    streamSpliceSpy.mockImplementation(async (args: SpliceArgs) => {
      /* Defer the completion callback so we can switch books before it fires. */
      completionCallbackHolder.fn = () => {
        args.onTick({
          type: 'splice_complete',
          chapterId: args.chapterId,
          characterId: args.characterId,
          mode: args.mode,
          durationSec: 333,
          segmentCount: 1,
          hasPreviousAudio: true,
        } as SpliceTick);
      };
    });

    const store = makeStore('bk1');
    store.dispatch(
      spliceActions.startBatch({
        id: 'b5', bookId: 'bk1', characterId: 'castor', characterName: 'Castor', mode: 'remix',
        gainDb: 2, chapterIds: [1],
      }),
    );
    /* Let the splice start (mock is called but completion deferred). */
    await flush();

    /* Now switch to a different book before completion fires. */
    store.dispatch({ type: 'chapters/setCurrentBookId', payload: 'bk2' });

    /* Now fire the completion callback — the middleware should NOT update
       chapter 1 because currentBookId is now bk2, not bk1. Verify the mock
       actually set the callback; if not, the test would pass vacuously. */
    expect(completionCallbackHolder.fn).not.toBeNull();
    completionCallbackHolder.fn?.();
    await flush();

    /* Verify: chapter 1 should NOT have been stamped with the new audio time. */
    const chapter1 = store.getState().chapters.chapters.find((c) => c.id === 1)!;
    expect(chapter1.audioRenderedAt).toBeUndefined();
    expect(chapter1.duration).toBe('2:00'); /* Original duration, unchanged. */
  });

  /* The pre-286 '#3376' regression test ('never writes a splice revision into
     a book the user switched to mid-batch') asserted `revisions.pending`
     changes driven by the runner's own `enqueuePending`/`markRevisionPlayable`
     dispatches. Plan 286 Task 20 removes both — the runner never writes
     pending, it refetches — so that test no longer has anything to pin and is
     deleted; the 'plan 286' tests above (particularly 'never writes pending'
     and 'does not refetch' for a book the user has left) cover the same
     cross-book-safety property the server-owned way. */
});
