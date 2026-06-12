/* Unit tests for queue-io.ts pure mutators (plan 102).
 * Each mutator is pure (file in → file out); no disk I/O. */

import { describe, it, expect } from 'vitest';
import {
  cancel,
  clearQueue,
  completeEntry,
  confirmFallback,
  enqueue,
  markAwaitingConfirm,
  markInProgress,
  pruneByBook,
  reorder,
  resetEntryToQueued,
  resetInProgressToQueued,
  retry,
  setPaused,
  skipFallback,
  startEntry,
  updateProgress,
  type EnqueueInput,
  type QueueFile,
} from './queue-io.js';

const emptyFile = (): QueueFile => ({ entries: [], paused: false });

const sampleEntry = (id: string, bookId = 'book-A', chapterId = 1): EnqueueInput => ({
  id,
  bookId,
  chapterId,
  scope: 'this',
  addedAt: '2026-05-23T00:00:00.000Z',
});

describe('queue-io.enqueue', () => {
  it('appends entries at the bottom and renumbers contiguously', () => {
    let f = emptyFile();
    f = enqueue(f, [sampleEntry('e1'), sampleEntry('e2')]);
    expect(f.entries.map((e) => [e.id, e.order])).toEqual([
      ['e1', 0],
      ['e2', 1],
    ]);
    f = enqueue(f, [sampleEntry('e3')]);
    expect(f.entries.map((e) => [e.id, e.order])).toEqual([
      ['e1', 0],
      ['e2', 1],
      ['e3', 2],
    ]);
  });

  it('rejects duplicate ids', () => {
    const f = enqueue(emptyFile(), [sampleEntry('e1')]);
    expect(() => enqueue(f, [sampleEntry('e1')])).toThrowError(/duplicate entry id/);
  });

  it('defaults addedAt to now() when not provided', () => {
    const before = Date.now();
    const f = enqueue(emptyFile(), [
      {
        id: 'e1',
        bookId: 'book-A',
        chapterId: 1,
        scope: 'this',
      },
    ]);
    const after = Date.now();
    const ts = Date.parse(f.entries[0].addedAt);
    expect(ts).toBeGreaterThanOrEqual(before);
    expect(ts).toBeLessThanOrEqual(after);
  });

  it('preserves cross-book interleave in arrival order', () => {
    let f = emptyFile();
    f = enqueue(f, [sampleEntry('a1', 'book-A', 1), sampleEntry('b1', 'book-B', 5)]);
    f = enqueue(f, [sampleEntry('a2', 'book-A', 2)]);
    expect(f.entries.map((e) => e.id)).toEqual(['a1', 'b1', 'a2']);
  });
});

describe('queue-io.reorder', () => {
  it('matches the desired order and renumbers', () => {
    let f = enqueue(emptyFile(), [sampleEntry('e1'), sampleEntry('e2'), sampleEntry('e3')]);
    f = reorder(f, ['e3', 'e1', 'e2']);
    expect(f.entries.map((e) => [e.id, e.order])).toEqual([
      ['e3', 0],
      ['e1', 1],
      ['e2', 2],
    ]);
  });

  it('keeps the in-flight entry pinned at order 0 (not in the desired list)', () => {
    let f = enqueue(emptyFile(), [sampleEntry('e1'), sampleEntry('e2'), sampleEntry('e3')]);
    f = startEntry(f, 'e1'); // e1 becomes in_progress, pinned at order 0
    f = reorder(f, ['e3', 'e2']); // desired list excludes the pinned entry
    expect(f.entries.map((e) => [e.id, e.order, e.status])).toEqual([
      ['e1', 0, 'in_progress'],
      ['e3', 1, 'queued'],
      ['e2', 2, 'queued'],
    ]);
  });

  it('rejects a desired list that is the wrong length', () => {
    const f = enqueue(emptyFile(), [sampleEntry('e1'), sampleEntry('e2')]);
    expect(() => reorder(f, ['e1'])).toThrowError(/order length/);
    expect(() => reorder(f, ['e1', 'e2', 'e3'])).toThrowError(/order length/);
  });

  it('rejects a desired list that names an unknown id', () => {
    const f = enqueue(emptyFile(), [sampleEntry('e1'), sampleEntry('e2')]);
    expect(() => reorder(f, ['e1', 'unknown'])).toThrowError(/not a reorderable entry/);
  });
});

describe('queue-io.cancel', () => {
  it('removes the entry and renumbers', () => {
    let f = enqueue(emptyFile(), [sampleEntry('e1'), sampleEntry('e2'), sampleEntry('e3')]);
    f = cancel(f, 'e2');
    expect(f.entries.map((e) => [e.id, e.order])).toEqual([
      ['e1', 0],
      ['e3', 1],
    ]);
  });

  it('is idempotent for missing entries (no throw)', () => {
    const f = enqueue(emptyFile(), [sampleEntry('e1')]);
    const next = cancel(f, 'missing');
    expect(next).toBe(f);
  });

  it('refuses to drop an in_progress entry', () => {
    let f = enqueue(emptyFile(), [sampleEntry('e1')]);
    f = startEntry(f, 'e1');
    expect(() => cancel(f, 'e1')).toThrowError(/in_progress/);
  });

  it('force-drops an in_progress entry (escape hatch for a stuck row)', () => {
    let f = enqueue(emptyFile(), [sampleEntry('e1'), sampleEntry('e2')]);
    f = startEntry(f, 'e1'); // e1 in_progress
    f = cancel(f, 'e1', { force: true });
    expect(f.entries.map((e) => [e.id, e.order])).toEqual([['e2', 0]]);
  });
});

describe('queue-io.setPaused', () => {
  it('flips the global paused flag', () => {
    let f = emptyFile();
    f = setPaused(f, true);
    expect(f.paused).toBe(true);
    f = setPaused(f, false);
    expect(f.paused).toBe(false);
  });
});

describe('queue-io.clearQueue', () => {
  it('drops queued + failed but keeps in_progress by default, renumbering', () => {
    let f = enqueue(emptyFile(), [sampleEntry('e1'), sampleEntry('e2'), sampleEntry('e3')]);
    f = markInProgress(f, 'e2'); // e2 in_progress
    f = completeEntry(f, 'e3', 'failed', 'sidecar 500'); // e3 failed
    const cleared = clearQueue(f);
    expect(cleared.entries.map((e) => [e.id, e.order, e.status])).toEqual([['e2', 0, 'in_progress']]);
  });

  it('drops everything with force (including in_progress)', () => {
    let f = enqueue(emptyFile(), [sampleEntry('e1'), sampleEntry('e2')]);
    f = markInProgress(f, 'e1');
    const cleared = clearQueue(f, { force: true });
    expect(cleared.entries).toEqual([]);
  });

  it('leaves the paused flag untouched', () => {
    let f = enqueue(emptyFile(), [sampleEntry('e1')]);
    f = setPaused(f, true);
    expect(clearQueue(f, { force: true }).paused).toBe(true);
    expect(clearQueue(f).paused).toBe(true);
  });

  it('is idempotent on an empty queue', () => {
    expect(clearQueue(emptyFile()).entries).toEqual([]);
    expect(clearQueue(emptyFile(), { force: true }).entries).toEqual([]);
  });
});

describe('queue-io.startEntry', () => {
  it('marks the entry in_progress and pins it to order 0', () => {
    let f = enqueue(emptyFile(), [sampleEntry('e1'), sampleEntry('e2'), sampleEntry('e3')]);
    f = startEntry(f, 'e2');
    expect(f.entries.map((e) => [e.id, e.order, e.status])).toEqual([
      ['e2', 0, 'in_progress'],
      ['e1', 1, 'queued'],
      ['e3', 2, 'queued'],
    ]);
  });

  it('refuses to start a second in_progress (FIFO invariant)', () => {
    let f = enqueue(emptyFile(), [sampleEntry('e1'), sampleEntry('e2')]);
    f = startEntry(f, 'e1');
    expect(() => startEntry(f, 'e2')).toThrowError(/in_progress/);
  });

  it('is idempotent when the same entry is already in_progress', () => {
    let f = enqueue(emptyFile(), [sampleEntry('e1'), sampleEntry('e2')]);
    f = startEntry(f, 'e1');
    f = startEntry(f, 'e1');
    expect(f.entries.find((e) => e.id === 'e1')?.status).toBe('in_progress');
  });
});

describe('queue-io.markInProgress', () => {
  it('flips the entry to in_progress WITHOUT reordering (order preserved)', () => {
    let f = enqueue(emptyFile(), [sampleEntry('e1'), sampleEntry('e2'), sampleEntry('e3')]);
    f = markInProgress(f, 'e2');
    /* e2 stays at order 1 — no pin to order 0 (unlike startEntry). */
    expect(f.entries.map((e) => [e.id, e.order, e.status])).toEqual([
      ['e1', 0, 'queued'],
      ['e2', 1, 'in_progress'],
      ['e3', 2, 'queued'],
    ]);
  });

  it('allows MULTIPLE concurrent in_progress entries (no single-in-flight throw)', () => {
    let f = enqueue(emptyFile(), [sampleEntry('e1'), sampleEntry('e2')]);
    f = markInProgress(f, 'e1');
    f = markInProgress(f, 'e2');
    expect(f.entries.filter((e) => e.status === 'in_progress').map((e) => e.id)).toEqual([
      'e1',
      'e2',
    ]);
  });

  it('is a no-op for a missing entry id', () => {
    const f = enqueue(emptyFile(), [sampleEntry('e1')]);
    const next = markInProgress(f, 'missing');
    expect(next.entries.map((e) => [e.id, e.status])).toEqual([['e1', 'queued']]);
  });

  it('is idempotent when the entry is already in_progress', () => {
    let f = enqueue(emptyFile(), [sampleEntry('e1')]);
    f = markInProgress(f, 'e1');
    f = markInProgress(f, 'e1');
    expect(f.entries[0].status).toBe('in_progress');
  });
});

describe('queue-io.resetInProgressToQueued', () => {
  it('flips every in_progress entry back to queued (boot orphan sweep)', () => {
    let f = enqueue(emptyFile(), [sampleEntry('e1'), sampleEntry('e2'), sampleEntry('e3')]);
    f = markInProgress(f, 'e1');
    f = markInProgress(f, 'e2');
    const swept = resetInProgressToQueued(f);
    expect(swept.entries.map((e) => [e.id, e.order, e.status])).toEqual([
      ['e1', 0, 'queued'],
      ['e2', 1, 'queued'],
      ['e3', 2, 'queued'],
    ]);
  });

  it('leaves queued / failed entries untouched', () => {
    let f = enqueue(emptyFile(), [sampleEntry('e1'), sampleEntry('e2')]);
    f = markInProgress(f, 'e2');
    f = completeEntry(f, 'e2', 'failed', 'sidecar 500');
    const swept = resetInProgressToQueued(f);
    /* e1 was already queued; e2 is failed (lingers for inspection) — neither
       is in_progress, so both pass through unchanged. */
    expect(swept.entries.map((e) => [e.id, e.status])).toEqual([
      ['e1', 'queued'],
      ['e2', 'failed'],
    ]);
  });

  it('is a no-op (preserves order) when nothing is in_progress', () => {
    const f = enqueue(emptyFile(), [sampleEntry('e1'), sampleEntry('e2')]);
    const swept = resetInProgressToQueued(f);
    expect(swept.entries.map((e) => [e.id, e.order, e.status])).toEqual([
      ['e1', 0, 'queued'],
      ['e2', 1, 'queued'],
    ]);
  });

  it('handles an empty queue', () => {
    expect(resetInProgressToQueued(emptyFile()).entries).toEqual([]);
  });
});

describe('queue-io.resetEntryToQueued (srv-12 single-entry orphan recovery)', () => {
  it('flips ONLY the targeted in_progress entry back to queued, leaving siblings', () => {
    let f = enqueue(emptyFile(), [sampleEntry('e1'), sampleEntry('e2'), sampleEntry('e3')]);
    f = markInProgress(f, 'e1');
    f = markInProgress(f, 'e2');
    const reset = resetEntryToQueued(f, 'e1');
    expect(reset.entries.map((e) => [e.id, e.order, e.status])).toEqual([
      ['e1', 0, 'queued'],
      ['e2', 1, 'in_progress'],
      ['e3', 2, 'queued'],
    ]);
  });

  it('is a no-op for a missing id', () => {
    const f = markInProgress(enqueue(emptyFile(), [sampleEntry('e1')]), 'e1');
    const reset = resetEntryToQueued(f, 'nope');
    expect(reset).toBe(f);
  });

  it('is a no-op for a non-in_progress entry (never resurrects done/failed/queued)', () => {
    let f = enqueue(emptyFile(), [sampleEntry('e1'), sampleEntry('e2')]);
    f = markInProgress(f, 'e2');
    f = completeEntry(f, 'e2', 'failed', 'sidecar 500');
    /* e1 is queued, e2 is failed — neither flips. */
    expect(resetEntryToQueued(f, 'e1')).toBe(f);
    expect(resetEntryToQueued(f, 'e2')).toBe(f);
  });
});

describe('queue-io.completeEntry', () => {
  it('drops done entries from the queue', () => {
    let f = enqueue(emptyFile(), [sampleEntry('e1'), sampleEntry('e2')]);
    f = startEntry(f, 'e1');
    f = completeEntry(f, 'e1', 'done');
    expect(f.entries.map((e) => [e.id, e.order])).toEqual([['e2', 0]]);
  });

  it('keeps failed entries with errorReason so the user can inspect', () => {
    let f = enqueue(emptyFile(), [sampleEntry('e1')]);
    f = startEntry(f, 'e1');
    f = completeEntry(f, 'e1', 'failed', 'sidecar 500');
    expect(f.entries[0]).toMatchObject({
      id: 'e1',
      status: 'failed',
      errorReason: 'sidecar 500',
    });
  });
});

describe('queue-io.retry', () => {
  it('flips a failed entry back to queued and clears errorReason/progress', () => {
    let f = enqueue(emptyFile(), [sampleEntry('e1'), sampleEntry('e2')]);
    f = startEntry(f, 'e1');
    f = updateProgress(f, 'e1', 0.5);
    f = completeEntry(f, 'e1', 'failed', 'sidecar 500');
    f = retry(f, 'e1');
    expect(f.entries.find((e) => e.id === 'e1')).toMatchObject({
      id: 'e1',
      status: 'queued',
      errorReason: null,
    });
    expect(f.entries.find((e) => e.id === 'e1')?.progress).toBeUndefined();
  });

  it('is a no-op for a non-failed entry (no disturbing a queued/in_progress row)', () => {
    let f = enqueue(emptyFile(), [sampleEntry('e1')]);
    f = startEntry(f, 'e1'); // in_progress
    expect(retry(f, 'e1')).toBe(f);
  });

  it('is a no-op for a missing id', () => {
    const f = enqueue(emptyFile(), [sampleEntry('e1')]);
    expect(retry(f, 'missing')).toBe(f);
  });
});

describe('queue-io.updateProgress', () => {
  it('writes progress on the named entry only', () => {
    let f = enqueue(emptyFile(), [sampleEntry('e1'), sampleEntry('e2')]);
    f = startEntry(f, 'e1');
    f = updateProgress(f, 'e1', 0.42);
    expect(f.entries.find((e) => e.id === 'e1')?.progress).toBe(0.42);
    expect(f.entries.find((e) => e.id === 'e2')?.progress).toBeUndefined();
  });
});

describe('queue-io.pruneByBook', () => {
  it('drops every entry matching the bookId and renumbers', () => {
    let f = enqueue(emptyFile(), [
      sampleEntry('a1', 'book-A', 1),
      sampleEntry('b1', 'book-B', 1),
      sampleEntry('a2', 'book-A', 2),
      sampleEntry('b2', 'book-B', 2),
    ]);
    f = pruneByBook(f, 'book-A');
    expect(f.entries.map((e) => [e.id, e.order])).toEqual([
      ['b1', 0],
      ['b2', 1],
    ]);
  });

  it('is a no-op when no entries match', () => {
    const f = enqueue(emptyFile(), [sampleEntry('a1', 'book-A')]);
    const next = pruneByBook(f, 'book-B');
    expect(next.entries).toHaveLength(1);
  });
});

describe('queue-io loud-fallback gate', () => {
  const chars = [{ id: 'oduvan', name: 'Oduvan' }];

  describe('markAwaitingConfirm', () => {
    it('parks an in_progress entry, stamping the fallback characters', () => {
      let f = enqueue(emptyFile(), [sampleEntry('e1')]);
      f = markInProgress(f, 'e1');
      f = markAwaitingConfirm(f, 'e1', chars);
      const e = f.entries.find((x) => x.id === 'e1')!;
      expect(e.status).toBe('awaiting_confirm');
      expect(e.fallbackCharacters).toEqual(chars);
    });

    it('is a no-op for a queued (not in_progress) entry', () => {
      const f = enqueue(emptyFile(), [sampleEntry('e1')]);
      expect(markAwaitingConfirm(f, 'e1', chars)).toEqual(f);
    });

    it('is a no-op for a missing id', () => {
      let f = enqueue(emptyFile(), [sampleEntry('e1')]);
      f = markInProgress(f, 'e1');
      expect(markAwaitingConfirm(f, 'nope', chars)).toEqual(f);
    });
  });

  describe('confirmFallback', () => {
    it('flips awaiting_confirm → queued with fallbackConfirmed', () => {
      let f = enqueue(emptyFile(), [sampleEntry('e1')]);
      f = markAwaitingConfirm(markInProgress(f, 'e1'), 'e1', chars);
      f = confirmFallback(f, 'e1');
      const e = f.entries.find((x) => x.id === 'e1')!;
      expect(e.status).toBe('queued');
      expect(e.fallbackConfirmed).toBe(true);
    });

    it('is a no-op unless the entry is awaiting_confirm', () => {
      const f = enqueue(emptyFile(), [sampleEntry('e1')]);
      expect(confirmFallback(f, 'e1')).toEqual(f);
      expect(confirmFallback(f, 'missing')).toEqual(f);
    });
  });

  describe('skipFallback', () => {
    it('removes a parked entry and renumbers', () => {
      let f = enqueue(emptyFile(), [sampleEntry('e1'), sampleEntry('e2')]);
      f = markAwaitingConfirm(markInProgress(f, 'e1'), 'e1', chars);
      f = skipFallback(f, 'e1');
      expect(f.entries.map((e) => [e.id, e.order])).toEqual([['e2', 0]]);
    });

    it('is a no-op unless the entry is awaiting_confirm', () => {
      let f = enqueue(emptyFile(), [sampleEntry('e1')]);
      f = markInProgress(f, 'e1');
      expect(skipFallback(f, 'e1')).toEqual(f);
    });
  });

  it('boot orphan sweep leaves awaiting_confirm untouched', () => {
    let f = enqueue(emptyFile(), [sampleEntry('e1'), sampleEntry('e2')]);
    f = markAwaitingConfirm(markInProgress(f, 'e1'), 'e1', chars);
    f = markInProgress(f, 'e2');
    const swept = resetInProgressToQueued(f);
    expect(swept.entries.find((e) => e.id === 'e1')!.status).toBe('awaiting_confirm');
    expect(swept.entries.find((e) => e.id === 'e2')!.status).toBe('queued');
  });

  it('cancel can remove an awaiting_confirm entry (not in_progress)', () => {
    let f = enqueue(emptyFile(), [sampleEntry('e1')]);
    f = markAwaitingConfirm(markInProgress(f, 'e1'), 'e1', chars);
    expect(cancel(f, 'e1').entries).toHaveLength(0);
  });
});
