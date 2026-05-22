/* Unit tests for queue-io.ts pure mutators (plan 102).
 * Each mutator is pure (file in → file out); no disk I/O. */

import { describe, it, expect } from 'vitest';
import {
  cancel,
  completeEntry,
  enqueue,
  pruneByBook,
  reorder,
  setPaused,
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
