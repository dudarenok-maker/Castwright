/* Plan 285 — the mock queue carries `review` through enqueue, like the real
   server (mock-queue.ts spreads the incoming entry; this pins that a future
   whitelist there keeps `review`). */
import { describe, it, expect, beforeEach } from 'vitest';
import { mockQueueRequest, resetMockQueue } from './mock-queue';

beforeEach(() => resetMockQueue());

describe('mock queue — review', () => {
  it('keeps review on the enqueued entry', async () => {
    const review = { characterId: 'amy', triggeredBy: 'Amy voice change' };
    const res = mockQueueRequest('/api/queue/enqueue', {
      method: 'POST',
      body: JSON.stringify({ entries: [{ id: 'e1', bookId: 'book-A', chapterId: 1, scope: 'this', review }] }),
    });
    const snap = (await res.json()) as { entries: Array<{ id: string; review?: unknown }> };
    expect(snap.entries[0].review).toEqual(review);
  });
});
