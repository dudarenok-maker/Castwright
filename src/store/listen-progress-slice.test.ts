// Pairs with docs/features/archive/47-listen-progress.md
// Extended by plan 53 (playbackRate + markers).

import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PLAYBACK_RATE,
  LISTEN_MARKER_KINDS,
  getPlaybackRate,
  listenProgressSlice,
  listenProgressActions,
  selectListenProgress,
  type ListenMarker,
  type ListenProgressRecord,
  type ListenProgressState,
} from './listen-progress-slice';

const empty = (): ListenProgressState => ({ byBook: {}, pendingSeek: null });

const sample: ListenProgressRecord = {
  chapterId: 3,
  currentSec: 83.5,
  updatedAt: '2026-05-18T01:30:00.000Z',
};

const marker = (over: Partial<ListenMarker> = {}): ListenMarker => ({
  id: 'mk_1',
  chapterId: 3,
  sec: 83.5,
  label: 're-record this',
  kind: 'rerecord',
  createdAt: '2026-05-19T10:00:00.000Z',
  ...over,
});

describe('listenProgressSlice — hydrate', () => {
  it('seeds byBook[bookId] from a non-null record', () => {
    const next = listenProgressSlice.reducer(
      empty(),
      listenProgressActions.hydrate({ bookId: 'b1', progress: sample }),
    );
    expect(next.byBook).toEqual({ b1: sample });
  });

  it('null progress clears any existing entry for the book without touching others', () => {
    const start: ListenProgressState = {
      byBook: { b1: sample, b2: { ...sample, chapterId: 5 } },
      pendingSeek: null,
    };
    const next = listenProgressSlice.reducer(
      start,
      listenProgressActions.hydrate({ bookId: 'b1', progress: null }),
    );
    expect(next.byBook.b1).toBeUndefined();
    expect(next.byBook.b2?.chapterId).toBe(5);
  });
});

describe('listenProgressSlice — update', () => {
  it('writes a fresh record for a book that had none', () => {
    const next = listenProgressSlice.reducer(
      empty(),
      listenProgressActions.update({ bookId: 'b1', chapterId: 7, currentSec: 12 }),
    );
    expect(next.byBook.b1?.chapterId).toBe(7);
    expect(next.byBook.b1?.currentSec).toBe(12);
    expect(typeof next.byBook.b1?.updatedAt).toBe('string');
  });

  it('overwrites the prior chapterId / currentSec for the same book', () => {
    const start: ListenProgressState = { byBook: { b1: sample }, pendingSeek: null };
    const next = listenProgressSlice.reducer(
      start,
      listenProgressActions.update({ bookId: 'b1', chapterId: 9, currentSec: 99 }),
    );
    expect(next.byBook.b1?.chapterId).toBe(9);
    expect(next.byBook.b1?.currentSec).toBe(99);
  });

  it('respects an explicit updatedAt payload (server echo path)', () => {
    const next = listenProgressSlice.reducer(
      empty(),
      listenProgressActions.update({
        bookId: 'b1',
        chapterId: 2,
        currentSec: 4,
        updatedAt: '2026-05-18T02:00:00.000Z',
      }),
    );
    expect(next.byBook.b1?.updatedAt).toBe('2026-05-18T02:00:00.000Z');
  });

  it('leaves entries for other books intact', () => {
    const start: ListenProgressState = { byBook: { b1: sample }, pendingSeek: null };
    const next = listenProgressSlice.reducer(
      start,
      listenProgressActions.update({ bookId: 'b2', chapterId: 1, currentSec: 2 }),
    );
    expect(next.byBook.b1).toEqual(sample);
    expect(next.byBook.b2?.chapterId).toBe(1);
  });
});

describe('listenProgressSlice — clear', () => {
  it('removes one book without touching others', () => {
    const start: ListenProgressState = {
      byBook: { b1: sample, b2: { ...sample, chapterId: 11 } },
      pendingSeek: null,
    };
    const next = listenProgressSlice.reducer(start, listenProgressActions.clear({ bookId: 'b1' }));
    expect(next.byBook.b1).toBeUndefined();
    expect(next.byBook.b2?.chapterId).toBe(11);
  });
});

describe('selectListenProgress', () => {
  it('returns the record for the given book when present', () => {
    const state = { listenProgress: { byBook: { b1: sample }, pendingSeek: null } };
    expect(selectListenProgress('b1')(state)).toEqual(sample);
  });

  it('returns null when the book has no entry', () => {
    const state = { listenProgress: { byBook: {}, pendingSeek: null } };
    expect(selectListenProgress('b1')(state)).toBeNull();
  });

  it('returns null when bookId is null (pre-ready stages have no active book)', () => {
    const state = { listenProgress: { byBook: { b1: sample }, pendingSeek: null } };
    expect(selectListenProgress(null)(state)).toBeNull();
  });

  it('returns null defensively when the slice is absent from the store', () => {
    const state: { listenProgress?: ListenProgressState } = {};
    expect(selectListenProgress('b1')(state)).toBeNull();
  });
});

describe('listenProgressSlice — plan 53 playbackRate', () => {
  it('hydrate round-trips a playbackRate field', () => {
    const next = listenProgressSlice.reducer(
      empty(),
      listenProgressActions.hydrate({
        bookId: 'b1',
        progress: { ...sample, playbackRate: 1.5 },
      }),
    );
    expect(next.byBook.b1?.playbackRate).toBe(1.5);
  });

  it('getPlaybackRate falls back to 1.0 when the field is absent', () => {
    expect(getPlaybackRate(sample)).toBe(DEFAULT_PLAYBACK_RATE);
    expect(DEFAULT_PLAYBACK_RATE).toBe(1.0);
  });

  it('getPlaybackRate ignores non-finite values defensively', () => {
    expect(getPlaybackRate({ ...sample, playbackRate: Number.NaN })).toBe(1.0);
    expect(getPlaybackRate({ ...sample, playbackRate: Number.POSITIVE_INFINITY })).toBe(1.0);
    expect(getPlaybackRate(null)).toBe(1.0);
  });

  it('setPlaybackRate writes onto an existing record without losing position', () => {
    const start: ListenProgressState = { byBook: { b1: sample }, pendingSeek: null };
    const next = listenProgressSlice.reducer(
      start,
      listenProgressActions.setPlaybackRate({ bookId: 'b1', playbackRate: 1.75 }),
    );
    expect(next.byBook.b1?.playbackRate).toBe(1.75);
    expect(next.byBook.b1?.chapterId).toBe(sample.chapterId);
    expect(next.byBook.b1?.currentSec).toBe(sample.currentSec);
  });

  it('setPlaybackRate seeds a minimal record when none exists', () => {
    const next = listenProgressSlice.reducer(
      empty(),
      listenProgressActions.setPlaybackRate({ bookId: 'b1', playbackRate: 1.25 }),
    );
    expect(next.byBook.b1?.playbackRate).toBe(1.25);
    expect(next.byBook.b1?.chapterId).toBe(0);
    expect(next.byBook.b1?.currentSec).toBe(0);
  });

  it('update preserves a previously-set playbackRate across position updates', () => {
    const start: ListenProgressState = {
      byBook: { b1: { ...sample, playbackRate: 1.5 } },
      pendingSeek: null,
    };
    const next = listenProgressSlice.reducer(
      start,
      listenProgressActions.update({ bookId: 'b1', chapterId: 4, currentSec: 200 }),
    );
    expect(next.byBook.b1?.playbackRate).toBe(1.5);
    expect(next.byBook.b1?.chapterId).toBe(4);
    expect(next.byBook.b1?.currentSec).toBe(200);
  });
});

describe('listenProgressSlice — plan 53 markers', () => {
  it('addMarker appends to the markers array', () => {
    const start: ListenProgressState = { byBook: { b1: sample }, pendingSeek: null };
    const next = listenProgressSlice.reducer(
      start,
      listenProgressActions.addMarker({ bookId: 'b1', marker: marker() }),
    );
    expect(next.byBook.b1?.markers).toEqual([marker()]);
  });

  it('addMarker preserves existing markers', () => {
    const start: ListenProgressState = {
      byBook: { b1: { ...sample, markers: [marker({ id: 'mk_a' })] } },
      pendingSeek: null,
    };
    const next = listenProgressSlice.reducer(
      start,
      listenProgressActions.addMarker({ bookId: 'b1', marker: marker({ id: 'mk_b' }) }),
    );
    expect(next.byBook.b1?.markers?.map((m) => m.id)).toEqual(['mk_a', 'mk_b']);
  });

  it('addMarker seeds a record when none exists yet (user marks before first save)', () => {
    const next = listenProgressSlice.reducer(
      empty(),
      listenProgressActions.addMarker({
        bookId: 'b1',
        marker: marker({ chapterId: 5, sec: 12 }),
      }),
    );
    expect(next.byBook.b1?.markers).toHaveLength(1);
    expect(next.byBook.b1?.chapterId).toBe(5);
    expect(next.byBook.b1?.currentSec).toBe(12);
  });

  it('editMarker patches label + kind in place; leaves siblings alone', () => {
    const start: ListenProgressState = {
      byBook: {
        b1: {
          ...sample,
          markers: [marker({ id: 'mk_a' }), marker({ id: 'mk_b', label: 'untouched', kind: 'note' })],
        },
      },
      pendingSeek: null,
    };
    const next = listenProgressSlice.reducer(
      start,
      listenProgressActions.editMarker({
        bookId: 'b1',
        markerId: 'mk_a',
        patch: { label: 'updated', kind: 'note' },
      }),
    );
    const ms = next.byBook.b1?.markers ?? [];
    expect(ms.find((m) => m.id === 'mk_a')?.label).toBe('updated');
    expect(ms.find((m) => m.id === 'mk_a')?.kind).toBe('note');
    expect(ms.find((m) => m.id === 'mk_b')?.label).toBe('untouched');
  });

  it('editMarker missing markerId is a silent no-op', () => {
    const start: ListenProgressState = {
      byBook: { b1: { ...sample, markers: [marker({ id: 'mk_a' })] } },
      pendingSeek: null,
    };
    const next = listenProgressSlice.reducer(
      start,
      listenProgressActions.editMarker({
        bookId: 'b1',
        markerId: 'mk_ghost',
        patch: { label: 'no-op' },
      }),
    );
    expect(next.byBook.b1?.markers?.[0].label).toBe('re-record this');
  });

  it('deleteMarker removes the matching marker only', () => {
    const start: ListenProgressState = {
      byBook: {
        b1: { ...sample, markers: [marker({ id: 'mk_a' }), marker({ id: 'mk_b' })] },
      },
      pendingSeek: null,
    };
    const next = listenProgressSlice.reducer(
      start,
      listenProgressActions.deleteMarker({ bookId: 'b1', markerId: 'mk_a' }),
    );
    expect(next.byBook.b1?.markers?.map((m) => m.id)).toEqual(['mk_b']);
  });

  it('update preserves markers across position updates', () => {
    const start: ListenProgressState = {
      byBook: { b1: { ...sample, markers: [marker()] } },
      pendingSeek: null,
    };
    const next = listenProgressSlice.reducer(
      start,
      listenProgressActions.update({ bookId: 'b1', chapterId: 4, currentSec: 200 }),
    );
    expect(next.byBook.b1?.markers).toEqual([marker()]);
  });

  it('exposes the documented marker-kind enum (note / rerecord)', () => {
    expect(LISTEN_MARKER_KINDS).toEqual(['note', 'rerecord']);
  });
});

describe('listenProgressSlice — plan 53 pendingSeek (marker-click → mini-player)', () => {
  it('requestSeek stamps a fresh pendingSeek with an incrementing requestId', () => {
    const first = listenProgressSlice.reducer(
      empty(),
      listenProgressActions.requestSeek({ bookId: 'b1', chapterId: 3, sec: 12 }),
    );
    expect(first.pendingSeek).toEqual({ bookId: 'b1', chapterId: 3, sec: 12, requestId: 1 });
    const second = listenProgressSlice.reducer(
      first,
      listenProgressActions.requestSeek({ bookId: 'b1', chapterId: 3, sec: 12 }),
    );
    expect(second.pendingSeek?.requestId).toBe(2);
  });

  it('consumeSeek clears the matching requestId; stale ids are ignored', () => {
    const after = listenProgressSlice.reducer(
      empty(),
      listenProgressActions.requestSeek({ bookId: 'b1', chapterId: 3, sec: 12 }),
    );
    const id = after.pendingSeek!.requestId;
    /* Stale id — no-op. */
    const stale = listenProgressSlice.reducer(
      after,
      listenProgressActions.consumeSeek({ requestId: id + 99 }),
    );
    expect(stale.pendingSeek?.requestId).toBe(id);
    /* Real id — cleared. */
    const cleared = listenProgressSlice.reducer(
      after,
      listenProgressActions.consumeSeek({ requestId: id }),
    );
    expect(cleared.pendingSeek).toBeNull();
  });
});
