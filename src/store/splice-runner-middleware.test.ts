/* fs-26 — the background splice runner: one splice SSE per chapter, sequential,
   enqueuing a pending A/B revision each, flipping it playable + refreshing the
   chapter audio on completion, and tracking batch progress. api.streamSplice is
   mocked so no backend is needed. */

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { configureStore } from '@reduxjs/toolkit';
import type { SpliceArgs, SpliceTick } from '../lib/api';

const { streamSpliceSpy } = vi.hoisted(() => ({ streamSpliceSpy: vi.fn() }));
vi.mock('../lib/api', () => ({ api: { streamSplice: streamSpliceSpy } }));

import { spliceSlice, spliceActions } from './splice-slice';
import { chaptersSlice } from './chapters-slice';
import { revisionsSlice } from './revisions-slice';
import { notificationsSlice } from './notifications-slice';
import { spliceRunnerMiddleware } from './splice-runner-middleware';
import type { Chapter } from '../lib/types';

const CHAPTERS: Chapter[] = [
  { id: 1, title: 'One', duration: '2:00', state: 'done', progress: 1, characters: { castor: 'done' }, phase: null, audioModelKey: 'kokoro-v1' },
  { id: 2, title: 'Two', duration: '2:00', state: 'done', progress: 1, characters: { castor: 'done' }, phase: null, audioModelKey: 'kokoro-v1' },
] as Chapter[];

function makeStore() {
  return configureStore({
    reducer: {
      splice: spliceSlice.reducer,
      chapters: chaptersSlice.reducer,
      revisions: revisionsSlice.reducer,
      notifications: notificationsSlice.reducer,
    },
    preloadedState: {
      chapters: { ...chaptersSlice.getInitialState(), chapters: CHAPTERS },
    },
    middleware: (getDefault) => getDefault().concat(spliceRunnerMiddleware()),
  });
}

/** Wait for the async batch loop (microtask-driven) to settle. */
async function flush() {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
}

describe('spliceRunnerMiddleware', () => {
  beforeEach(() => {
    streamSpliceSpy.mockReset();
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
});
