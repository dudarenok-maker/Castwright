/* #3713 / PR #4004 pass 4, finding 6 -- the SSE design streams carry `skippedBooks` (a repaired series-mate the
   design's voice write left alone), and the client shows the SAME toast handler as a plain series write. Drives
   the real `readCastDesignStream` and the real handler (`installRepairedBookHandler`). */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { configureStore } from '@reduxjs/toolkit';

vi.mock('./api', async (orig) => ({ ...(await orig<typeof import('./api')>()) }));

import { readCastDesignStream } from './api';
import { __resetBookReadTokensForTest } from './book-read-token';
import { installRepairedBookHandler } from '../store/repaired-book-handler';
import { notificationsSlice } from '../store/notifications-slice';

const skipped = [{ bookId: 'b9', bookTitle: 'Kept Twin', reason: 'Reopen "Kept Twin" to apply this change there.' }];

function stream(frames: unknown[]): Response {
  const enc = new TextEncoder();
  return {
    ok: true,
    status: 200,
    body: new ReadableStream<Uint8Array>({
      start(c) {
        for (const f of frames) c.enqueue(enc.encode(`data: ${JSON.stringify(f)}\n\n`));
        c.close();
      },
    }),
    json: async () => ({}),
  } as unknown as Response;
}

function makeStore() {
  const store = configureStore({ reducer: { notifications: notificationsSlice.reducer } as never });
  installRepairedBookHandler({ dispatch: store.dispatch, getState: store.getState } as never);
  return store;
}
const toasts = (s: ReturnType<typeof makeStore>) =>
  (s.getState() as unknown as { notifications: { toasts: Array<{ kind: string; message: string }> } }).notifications.toasts;

beforeEach(() => __resetBookReadTokensForTest());

describe('design streams report a skipped repaired series-mate', () => {
  it('a single design\'s `designed` event shows the toast naming the book', async () => {
    const store = makeStore();
    const onCharacterDesigned = vi.fn();
    await readCastDesignStream(
      stream([{ type: 'designed', characterId: 'c0', voiceId: 'qwen-c0', skippedBooks: skipped }]),
      { onCharacterDesigned } as never,
    );
    expect(onCharacterDesigned).toHaveBeenCalledWith({ characterId: 'c0', voiceId: 'qwen-c0', voiceUuid: undefined });
    expect(toasts(store)).toHaveLength(1);
    expect(toasts(store)[0]).toMatchObject({ kind: 'info' });
    expect(toasts(store)[0].message).toContain('Kept Twin');
    expect(toasts(store)[0].message).toMatch(/reopen/i);
  });

  it('a bulk job reports it once across character_designed and the terminal idle (same dedupe key)', async () => {
    const store = makeStore();
    await readCastDesignStream(
      stream([
        { type: 'character_designed', characterId: 'c0', voiceId: 'qwen-c0', skippedBooks: skipped },
        { type: 'idle', done: 1, total: 1, skipped: 0, failures: [], skippedBooks: skipped },
      ]),
      {} as never,
    );
    expect(toasts(store)).toHaveLength(1);
  });

  it('a stream with no skippedBooks shows no toast', async () => {
    const store = makeStore();
    await readCastDesignStream(
      stream([{ type: 'designed', characterId: 'c0', voiceId: 'qwen-c0' }, { type: 'idle', done: 1, total: 1, skipped: 0, failures: [] }]),
      {} as never,
    );
    expect(toasts(store)).toEqual([]);
  });

  it('a malformed skippedBooks is ignored and the event still reaches its callback', async () => {
    const store = makeStore();
    const onCharacterDesigned = vi.fn();
    await readCastDesignStream(
      stream([{ type: 'designed', characterId: 'c0', voiceId: 'qwen-c0', skippedBooks: 'nope' }]),
      { onCharacterDesigned } as never,
    );
    expect(onCharacterDesigned).toHaveBeenCalled();
    expect(toasts(store)).toEqual([]);
  });
});
