/* Plan 179 — the background audio-QA repair runner: one repair SSE per
   chapter, toasting the stream's advisories and refreshing the Listen row on
   completion. api.streamQaRepair is mocked so no backend is needed.

   The `warning` frame is the reason this consumer exists at all: the route has
   emitted `voice_language_mismatch` since [#1889] and nothing in the frontend
   read the endpoint, so the advisory went nowhere. These cases pin the frame
   the ROUTE sends reaching a real toast — not enum membership. */

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { configureStore } from '@reduxjs/toolkit';
import type { QaRepairArgs, QaRepairTick } from '../lib/api';

const { streamQaRepairSpy } = vi.hoisted(() => ({ streamQaRepairSpy: vi.fn() }));
vi.mock('../lib/api', () => ({ api: { streamQaRepair: streamQaRepairSpy } }));

import { qaRepairSlice, qaRepairActions } from './qa-repair-slice';
import { chaptersSlice } from './chapters-slice';
import { notificationsSlice } from './notifications-slice';
import { qaRepairRunnerMiddleware } from './qa-repair-runner-middleware';
import type { Chapter } from '../lib/types';

const CHAPTERS: Chapter[] = [
  { id: 1, title: 'One', duration: '2:00', state: 'done', progress: 1, characters: { castor: 'done' }, phase: null, audioModelKey: 'kokoro-v1' },
] as Chapter[];

const WARN_MESSAGE =
  '1 designed voice(s) were cleared because they were designed for a different language ' +
  'than this book — re-design Eliza Carrick before generating.';

function makeStore() {
  return configureStore({
    reducer: {
      qaRepair: qaRepairSlice.reducer,
      chapters: chaptersSlice.reducer,
      notifications: notificationsSlice.reducer,
    },
    preloadedState: {
      chapters: { ...chaptersSlice.getInitialState(), chapters: CHAPTERS },
    },
    middleware: (getDefault) => getDefault().concat(qaRepairRunnerMiddleware()),
  });
}

/** Wait for the async repair loop (microtask-driven) to settle. */
async function flush() {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
}

/** The happy arc WITHOUT a warning frame — the negative-arm baseline. */
function cleanRun(args: QaRepairArgs) {
  args.onTick({ type: 'qa_scan', chapterId: args.chapterId, flaggedCount: 2 } as QaRepairTick);
  args.onTick({
    type: 'qa_repair_complete', chapterId: args.chapterId, dryRun: false,
    repaired: [3, 7], stillSuspect: [], durationSec: 222,
  } as QaRepairTick);
}

describe('qaRepairRunnerMiddleware', () => {
  beforeEach(() => {
    streamQaRepairSpy.mockReset();
    streamQaRepairSpy.mockImplementation(async (args: QaRepairArgs) => cleanRun(args));
  });

  it('drives one repair stream per start action and clears the busy flag when it ends', async () => {
    const store = makeStore();
    store.dispatch(qaRepairActions.start({ bookId: 'bk1', chapterId: 1 }));
    /* Busy synchronously — the button must disable before the stream resolves. */
    expect(store.getState().qaRepair.running['bk1:1']).toBe(true);

    await flush();

    expect(streamQaRepairSpy).toHaveBeenCalledTimes(1);
    expect(streamQaRepairSpy.mock.calls[0][0]).toMatchObject({ bookId: 'bk1', chapterId: 1 });
    expect(store.getState().qaRepair.running['bk1:1']).toBeUndefined();

    /* Listen row refreshed from the completion frame. */
    const ch = store.getState().chapters.chapters.find((c) => c.id === 1)!;
    expect(ch.duration).toBe('03:42'); // 222s
    expect(ch.audioRenderedAt).toBeTruthy();

    /* Summary toast names what was actually repaired. */
    const done = store
      .getState()
      .notifications.toasts.find((t) => t.dedupeKey === 'qa-repair-bk1-1-done');
    expect(done).toMatchObject({ kind: 'info', message: 'Chapter 1: re-recorded 2 lines.' });
  });

  it('surfaces a warning frame from the repair stream as a warn toast', async () => {
    streamQaRepairSpy.mockImplementation(async (args: QaRepairArgs) => {
      args.onTick({ type: 'qa_scan', chapterId: args.chapterId, flaggedCount: 2 } as QaRepairTick);
      args.onTick({
        type: 'warning', code: 'voice_language_mismatch', message: WARN_MESSAGE,
      } as QaRepairTick);
      args.onTick({
        type: 'qa_repair_complete', chapterId: args.chapterId, dryRun: false,
        repaired: [3], stillSuspect: [], durationSec: 222,
      } as QaRepairTick);
    });
    const store = makeStore();
    store.dispatch(qaRepairActions.start({ bookId: 'bk1', chapterId: 1 }));
    await flush();

    const warned = store
      .getState()
      .notifications.toasts.filter((t) => t.dedupeKey === 'qa-repair-warning:voice_language_mismatch');
    expect(warned).toHaveLength(1);
    expect(warned[0]).toMatchObject({ kind: 'warn', message: WARN_MESSAGE });
    /* Non-fatal — the repair still completed and still refreshed the row. */
    expect(store.getState().chapters.chapters.find((c) => c.id === 1)!.audioRenderedAt).toBeTruthy();
  });

  it('pushes no language-mismatch toast when the stream sends no warning frame', async () => {
    /* Negative arm — without this, an unconditional pushToast would pass the
       positive case above and still be wrong. */
    const store = makeStore();
    store.dispatch(qaRepairActions.start({ bookId: 'bk1', chapterId: 1 }));
    await flush();

    expect(store.getState().notifications.toasts.filter((t) => t.kind === 'warn')).toHaveLength(0);
  });

  it('reports a chapter_failed frame as an error toast and still clears the busy flag', async () => {
    streamQaRepairSpy.mockImplementation(async (args: QaRepairArgs) => {
      args.onTick({ type: 'chapter_failed', chapterId: args.chapterId, errorReason: 'boom' } as QaRepairTick);
    });
    const store = makeStore();
    store.dispatch(qaRepairActions.start({ bookId: 'bk1', chapterId: 1 }));
    await flush();

    expect(store.getState().qaRepair.running['bk1:1']).toBeUndefined();
    const done = store
      .getState()
      .notifications.toasts.find((t) => t.dedupeKey === 'qa-repair-bk1-1-done');
    expect(done).toMatchObject({ kind: 'error', message: 'Chapter 1 repair failed — boom' });
  });
});
