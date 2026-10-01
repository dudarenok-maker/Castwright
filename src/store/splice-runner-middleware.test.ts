/* fs-26 — the background splice runner: one splice SSE per chapter, sequential,
   enqueuing a pending A/B revision each, flipping it playable + refreshing the
   chapter audio on completion, and tracking batch progress. api.streamSplice is
   mocked so no backend is needed. */

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { configureStore } from '@reduxjs/toolkit';
import type { SpliceArgs, SpliceTick } from '../lib/api';

const { streamSpliceSpy, putBookStateSpy } = vi.hoisted(() => ({
  streamSpliceSpy: vi.fn(),
  putBookStateSpy: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../lib/api', () => ({
  api: { streamSplice: streamSpliceSpy, putBookState: putBookStateSpy },
}));

import { spliceSlice, spliceActions } from './splice-slice';
import { chaptersSlice } from './chapters-slice';
import { revisionsSlice } from './revisions-slice';
import { notificationsSlice } from './notifications-slice';
import { uiSlice, uiActions } from './ui-slice';
import { revisionsScopeMiddleware } from './revisions-scope-middleware';
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
         has already been opened (and its hydrate, real or null, has landed)
         so revisions-scope-middleware has already synced the two. */
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
      getDefault().concat(revisionsScopeMiddleware, persistenceMiddleware, spliceRunnerMiddleware()),
  });
}

/** Wait for the async batch loop (microtask-driven) to settle. */
async function flush() {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
}

describe('spliceRunnerMiddleware', () => {
  beforeEach(() => {
    streamSpliceSpy.mockReset();
    putBookStateSpy.mockClear();
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

  it('runs one splice per chapter, enqueues + flips pending revisions, refreshes audio, counts results', async () => {
    const store = makeStore();
    store.dispatch(
      spliceActions.startBatch({
        id: 'b1',
        bookId: 'bk1',
        characterId: 'castor',
        characterName: 'Castor Allred',
        mode: 'remix',
        gainDb: 6,
        chapterIds: [1, 2],
      }),
    );
    await flush();

    expect(streamSpliceSpy).toHaveBeenCalledTimes(2);
    expect(streamSpliceSpy.mock.calls.every(([a]) => a.mode === 'remix' && a.gainDb === 6)).toBe(true);

    const pending = store.getState().revisions.pending;
    expect(pending).toHaveLength(2);
    expect(pending.every((r) => r.playable)).toBe(true);

    // chapter audio refreshed (duration from the tick + a renderedAt stamp)
    const chapters = store.getState().chapters.chapters;
    expect(chapters.find((c) => c.id === 1)!.duration).toBe('03:42'); // 222s
    expect(chapters.find((c) => c.id === 1)!.audioRenderedAt).toBeTruthy();

    const batch = store.getState().splice.batches.b1;
    expect(batch).toMatchObject({ total: 2, succeeded: 2, failed: 0, status: 'done' });
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

  it('never writes a splice revision into a book the user switched to mid-batch (#3376)', async () => {
    /* Repro from PR #3395 review finding 2: start a Fix-audio batch on book
       bk1, then open bk2 before the batch finishes. Unlike the audio-stamp
       guard above (which only covers markChapterAudioUpdated), enqueuePending
       and markRevisionPlayable had NO book guard, so bk1's splice revision
       for chapter 2 would be enqueued straight into bk2's `pending` list —
       and, since `pending` is client-owned and persisted per active book,
       bk2 would keep it forever while bk1 never got it. This pins both
       call sites: (1) enqueuePending must not fire once the active book has
       moved on, and (2) markRevisionPlayable must not flip an entry that was
       enqueued before the switch either, since the slice's `pending` list no
       longer represents bk1 once the user has navigated away. */
    const resolvers: Array<() => void> = [];
    streamSpliceSpy.mockImplementation(
      (args: SpliceArgs) =>
        new Promise<void>((resolve) => {
          resolvers.push(() => {
            args.onTick({
              type: 'splice_complete',
              chapterId: args.chapterId,
              characterId: args.characterId,
              mode: args.mode,
              durationSec: 111,
              segmentCount: 1,
              hasPreviousAudio: true,
            } as SpliceTick);
            resolve();
          });
        }),
    );

    const store = makeStore('bk1');
    store.dispatch(
      spliceActions.startBatch({
        id: 'b6',
        bookId: 'bk1',
        characterId: 'castor',
        characterName: 'Castor',
        mode: 'remix',
        gainDb: 1,
        chapterIds: [1, 2],
      }),
    );
    await flush();

    /* Chapter 1's enqueue happened while bk1 was still active — it's the
       user's own book, so it should be present. */
    expect(store.getState().revisions.pending).toEqual([
      expect.objectContaining({ id: 'splice-bk1-1-castor', playable: false }),
    ]);

    /* Navigate to bk2 before chapter 1's splice resolves — the PRODUCTION
       navigation action, not the synthetic `chapters/setCurrentBookId`
       production never dispatches on navigation (chapters.currentBookId only
       moves once bk2's own hydrate lands). revisions-scope-middleware reacts
       to this and re-scopes `revisions.bookId` to bk2 immediately, which is
       what the guards below must actually key off (#3395 pass 2, N2). */
    store.dispatch(uiActions.openBook({ id: 'bk2', status: 'complete' }));

    /* Resolve chapter 1 (fires splice_complete while bk2 is active) and let
       the loop advance to chapter 2 (its enqueuePending also fires while
       bk2 is active). */
    expect(resolvers).toHaveLength(1);
    resolvers[0]();
    await flush();
    expect(resolvers).toHaveLength(2);
    resolvers[1]();
    await flush();

    /* revisions-scope-middleware resets `pending` to empty the instant
       `uiActions.openBook('bk2')` lands (before either deferred completion
       fires) — bk1's own already-enqueued entry goes with it, same as any
       other per-book field, because `pending` no longer represents bk1 once
       the user has navigated away. Neither guarded dispatch below can
       re-populate it from bk1's book. */
    const pending = store.getState().revisions.pending;
    expect(pending).toEqual([]);

    /* Belt-and-braces: no PUT for bk2 ever carries either of bk1's splice
       ids — the persistence-middleware guard refuses to persist a revisions
       patch whose `revisions.bookId` disagrees with the write's target book,
       and the enqueue/markPlayable guards above never even dispatch for
       bk2 in the first place. */
    await new Promise((resolve) => setTimeout(resolve, 600));
    const bk2RevisionsPuts = putBookStateSpy.mock.calls.filter(
      ([bookId, body]) => bookId === 'bk2' && (body as { slice?: string }).slice === 'revisions',
    );
    const leaked = bk2RevisionsPuts.some(([, body]) =>
      ((body as { patch: { pending: Array<{ id: string }> } }).patch.pending ?? []).some((r) =>
        r.id.startsWith('splice-bk1'),
      ),
    );
    expect(leaked).toBe(false);
  });
});
