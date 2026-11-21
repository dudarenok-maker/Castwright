/* Plan 285 — the mock queue carries `review` through enqueue, like the real
   server (mock-queue.ts spreads the incoming entry; this pins that a future
   whitelist there keeps `review`). */
import { describe, it, expect, beforeEach } from 'vitest';
import { mockQueueRequest, resetMockQueue } from './mock-queue';

beforeEach(() => resetMockQueue());

describe('mock queue — reorder (#4029)', () => {
  it('keeps every in-flight entry, like the real server', async () => {
    const entries = ['e1', 'e2', 'e3', 'e4'].map((id) => ({ id, bookId: 'book-A', chapterId: 1, scope: 'this' }));
    mockQueueRequest('/api/queue/enqueue', { method: 'POST', body: JSON.stringify({ entries }) });
    mockQueueRequest('/api/queue/e1/start', { method: 'POST' });
    mockQueueRequest('/api/queue/e2/start', { method: 'POST' });
    const res = mockQueueRequest('/api/queue/reorder', { method: 'POST', body: JSON.stringify({ order: ['e4', 'e3'] }) });
    const snap = (await res.json()) as { entries: Array<{ id: string }> };
    expect(snap.entries.map((e) => e.id)).toEqual(['e1', 'e2', 'e4', 'e3']);
  });
});

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

describe('mock queue — complete requeued (#3436)', () => {
  const statuses = async (outcome: string) => {
    mockQueueRequest('/api/queue/enqueue', {
      method: 'POST',
      body: JSON.stringify({ entries: [{ id: 'e1', bookId: 'book-A', chapterId: 1, scope: 'this' }, { id: 'e2', bookId: 'book-A', chapterId: 2, scope: 'this' }] }),
    });
    mockQueueRequest('/api/queue/e1/start', { method: 'POST' });
    const res = mockQueueRequest('/api/queue/e1/complete', { method: 'POST', body: JSON.stringify({ outcome }) });
    const snap = (await res.json()) as { entries: Array<{ id: string; status: string }> };
    return snap.entries.map((e) => [e.id, e.status]);
  };

  it('puts an in_progress entry back to queued, like the server (never done-pruned, never failed)', async () => {
    expect(await statuses('requeued')).toEqual([['e1', 'queued'], ['e2', 'queued']]);
  });

  it('is a no-op for an entry that is not in_progress', async () => {
    mockQueueRequest('/api/queue/enqueue', {
      method: 'POST',
      body: JSON.stringify({ entries: [{ id: 'e1', bookId: 'book-A', chapterId: 1, scope: 'this' }] }),
    });
    const res = mockQueueRequest('/api/queue/e1/complete', { method: 'POST', body: JSON.stringify({ outcome: 'requeued' }) });
    const snap = (await res.json()) as { entries: Array<{ id: string; status: string }> };
    expect(snap.entries.map((e) => [e.id, e.status])).toEqual([['e1', 'queued']]);
  });
});
