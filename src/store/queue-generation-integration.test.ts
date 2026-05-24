/* Integration test for the plan-111 queue-driven generation chain: both
 * middlewares + the shared runner + a stateful mock queue. Proves the override
 * replacement works end-to-end — work appears → enqueue-on-work enqueues → the
 * dispatcher claims + opens a stream — and the no-loop invariant holds. */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { configureStore } from '@reduxjs/toolkit';
import { chaptersSlice } from './chapters-slice';
import { manuscriptSlice } from './manuscript-slice';
import { uiSlice } from './ui-slice';
import { changeLogSlice } from './change-log-slice';
import { castSlice } from './cast-slice';
import { revisionsSlice } from './revisions-slice';
import { analysisSlice } from './analysis-slice';
import { queueSlice, type QueueEntry } from './queue-slice';
import { accountSlice } from './account-slice';
import { notificationsSlice } from './notifications-slice';
import { generationStreamMiddleware } from './generation-stream-middleware';
import { queueDispatcherMiddleware } from './queue-dispatcher-middleware';
import { createStreamRunner, type StreamRunner } from './generation-stream-runner';
import type { Chapter, GenerationTick } from '../lib/types';

const streamGenerationMock = vi.fn();
const cancelMock = vi.fn();
vi.mock('../lib/api', () => ({
  api: {
    streamGeneration: (args: unknown) => {
      streamGenerationMock(args);
      return cancelMock;
    },
    pauseGeneration: () => Promise.resolve(),
  },
}));

let queueEntries: QueueEntry[] = [];
let fetchMock: ReturnType<typeof vi.fn>;

function jsonResp(body: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, statusText: 'OK', json: () => Promise.resolve(body) };
}

beforeEach(() => {
  queueEntries = [];
  streamGenerationMock.mockClear();
  cancelMock.mockClear();
  fetchMock = vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
    const u = String(url);
    if (u.includes('/api/queue/enqueue')) {
      const incoming = (init?.body ? JSON.parse(init.body).entries : []) as QueueEntry[];
      const seen = new Set(queueEntries.map((e) => e.id));
      for (const e of incoming) if (seen.has(e.id)) return jsonResp({ error: 'dup' }, 409);
      queueEntries = [
        ...queueEntries,
        ...incoming.map((e, i) => ({ ...e, status: 'queued', order: queueEntries.length + i }) as QueueEntry),
      ];
    } else if (init?.method === 'DELETE') {
      const id = u.split('/').pop();
      queueEntries = queueEntries.filter((e) => e.id !== id);
    }
    return jsonResp({ entries: queueEntries, paused: false });
  });
  vi.stubGlobal('fetch', fetchMock);
});

function makeStore() {
  let runner: StreamRunner | null = null;
  const getRunner = (): StreamRunner => runner!;
  const store = configureStore({
    reducer: {
      ui: uiSlice.reducer,
      chapters: chaptersSlice.reducer,
      manuscript: manuscriptSlice.reducer,
      changeLog: changeLogSlice.reducer,
      cast: castSlice.reducer,
      revisions: revisionsSlice.reducer,
      analysis: analysisSlice.reducer,
      queue: queueSlice.reducer,
      account: accountSlice.reducer,
      notifications: notificationsSlice.reducer,
    },
    middleware: (gd) =>
      gd({ serializableCheck: false }).concat(
        generationStreamMiddleware(getRunner),
        queueDispatcherMiddleware(getRunner),
      ),
  });
  runner = createStreamRunner(store);
  return { store, getRunner };
}

const ch = (id: number, state: Chapter['state'] = 'queued'): Chapter =>
  ({ id, title: `Chapter ${id}`, duration: '00:00', state, progress: 0, characters: { narrator: 'queued' } }) as Chapter;

async function flush(): Promise<void> {
  for (let i = 0; i < 6; i++) await Promise.resolve();
}

describe('queue-driven generation integration (plan 111)', () => {
  it('work appearing on the viewed book auto-enqueues and the dispatcher opens a stream', async () => {
    const { store } = makeStore();
    /* Cold-boot: queue loaded empty. */
    store.dispatch(queueSlice.actions.setSnapshot({ entries: [], paused: false }));
    store.dispatch(uiSlice.actions.openBook({ id: 'b1', status: 'generating' }));
    store.dispatch(chaptersSlice.actions.setCurrentBookId('b1'));
    /* Analysis lands queued chapters → enqueue-on-work fires on setChapters. */
    store.dispatch(chaptersSlice.actions.setChapters([ch(1, 'done'), ch(2), ch(3)]));
    await flush();

    /* enqueue-on-work enqueued chapters 2 + 3; the dispatcher claimed them
       (one book → one stream) and opened it. */
    expect(streamGenerationMock).toHaveBeenCalledTimes(1);
    const args = streamGenerationMock.mock.calls[0][0] as { bookId: string; chapterIds: number[] };
    expect(args.bookId).toBe('b1');
    expect(args.chapterIds.sort()).toEqual([2, 3]);
  });

  it('no regen loop — completing the run drains the queue and does not reopen', async () => {
    const { store } = makeStore();
    store.dispatch(queueSlice.actions.setSnapshot({ entries: [], paused: false }));
    store.dispatch(uiSlice.actions.openBook({ id: 'b1', status: 'generating' }));
    store.dispatch(chaptersSlice.actions.setCurrentBookId('b1'));
    store.dispatch(chaptersSlice.actions.setChapters([ch(1), ch(2)]));
    await flush();
    expect(streamGenerationMock).toHaveBeenCalledTimes(1);

    /* Drive both chapters done, then idle (via the runner's per-stream onTick). */
    const onTick = (streamGenerationMock.mock.calls[0][0] as { onTick: (e: GenerationTick) => void }).onTick;
    onTick({ type: 'chapter_complete', chapterId: 1 } as GenerationTick);
    onTick({ type: 'chapter_complete', chapterId: 2 } as GenerationTick);
    onTick({ type: 'idle' } as GenerationTick);
    await flush();

    /* Entries DELETEd, queue empty, and NO re-open of the done chapters. */
    expect(queueEntries).toHaveLength(0);
    expect(streamGenerationMock).toHaveBeenCalledTimes(1);
    expect(store.getState().chapters.activeStreams).toEqual({});
  });
});
