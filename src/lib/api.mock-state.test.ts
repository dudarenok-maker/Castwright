/* Pairs with docs/features/archive/27-book-state-persistence.md.

   Covers the in-memory mock backing store for book state — the round-trip
   contract that lets jsdom tests and design fixtures exercise the persist
   path without a Node backend. Imports the mock pair directly because the
   api module locks USE_MOCKS at import time; flipping the env in a test
   file is too late to swap api.* over to the mock branch. */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  mockGetBookState,
  mockPutBookState,
  mockAnalyseManuscript,
  mockReparseBook,
  mockReplaceManuscript,
  _resetMockBookStates,
} from './api';
import type { Character } from './types';

beforeEach(() => {
  _resetMockBookStates();
});

describe('mock book-state round-trip', () => {
  it('returns null for a never-touched book', async () => {
    const res = await mockGetBookState('never-seen');
    expect(res).toBeNull();
  });

  it('round-trips a cast PUT into a subsequent GET', async () => {
    const characters: Character[] = [
      { id: 'narrator', displayName: 'Narrator' } as unknown as Character,
      { id: 'halloran', displayName: 'Halloran' } as unknown as Character,
    ];
    await mockPutBookState('book-x', { slice: 'cast', patch: { characters } });

    const res = await mockGetBookState('book-x');
    expect(res).not.toBeNull();
    expect(res!.cast).toEqual({ characters });
    /* Sibling slices that were never written stay null. */
    expect(res!.manuscriptEdits).toBeNull();
    expect(res!.revisions).toBeNull();
    expect(res!.changeLog).toBeNull();
  });

  it('patch-merges sequential state-slice PUTs (matches real route)', async () => {
    await mockPutBookState('book-y', { slice: 'state', patch: { title: 'My Book' } });
    await mockPutBookState('book-y', { slice: 'state', patch: { castConfirmed: true } });

    const res = await mockGetBookState('book-y');
    expect(res).not.toBeNull();
    expect(res!.state.title).toBe('My Book');
    expect(res!.state.castConfirmed).toBe(true);
    expect(res!.state.bookId).toBe('book-y');
  });

  it('full-replaces sequential cast PUTs (matches real route writeJsonAtomic)', async () => {
    const first: Character[] = [{ id: 'a' } as unknown as Character];
    const second: Character[] = [
      { id: 'b' } as unknown as Character,
      { id: 'c' } as unknown as Character,
    ];

    await mockPutBookState('book-z', { slice: 'cast', patch: { characters: first } });
    await mockPutBookState('book-z', { slice: 'cast', patch: { characters: second } });

    const res = await mockGetBookState('book-z');
    expect(res!.cast).toEqual({ characters: second });
  });

  it('isolates state per bookId', async () => {
    await mockPutBookState('book-a', { slice: 'state', patch: { title: 'A' } });
    await mockPutBookState('book-b', { slice: 'state', patch: { title: 'B' } });

    const a = await mockGetBookState('book-a');
    const b = await mockGetBookState('book-b');
    expect(a!.state.title).toBe('A');
    expect(b!.state.title).toBe('B');
  });

  it('preserves a previously-null nullable field when the patch omits it', async () => {
    await mockPutBookState('book-n', { slice: 'state', patch: { title: 'Init' } });
    /* genre stays null after a write that doesn't touch it. */
    const res = await mockGetBookState('book-n');
    expect(res!.state.genre).toBeNull();
  });
});

describe('mock e2e seam: __SEED_PROSODY_ANNOTATED__', () => {
  const seed = globalThis as unknown as { __SEED_PROSODY_ANNOTATED__?: Record<string, boolean> };
  afterEach(() => {
    delete seed.__SEED_PROSODY_ANNOTATED__;
  });

  it('overlays the seeded watermark on a book that has state, and only that book', async () => {
    seed.__SEED_PROSODY_ANNOTATED__ = { sb: false };
    expect((await mockGetBookState('sb'))!.state.prosodyAnnotated).toBe(false);
    expect((await mockGetBookState('ns'))!.state.prosodyAnnotated).toBeUndefined();
  });

  it('leaves the watermark unset when nothing is seeded', async () => {
    expect((await mockGetBookState('sb'))!.state.prosodyAnnotated).toBeUndefined();
  });
});

describe('mock analyse keeps book state in step with the manuscript id', () => {
  it('reports the analysed manuscript id from getBookState, like the real server', async () => {
    vi.useFakeTimers();
    try {
      const pending = mockAnalyseManuscript('mns_confirmed1');
      await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
      const analysed = await pending;
      const res = mockGetBookState(analysed.bookId);
      await vi.advanceTimersByTimeAsync(1000);
      expect((await res)?.state.manuscriptId).toBe('mns_confirmed1');
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('mock book-state revision tokens (plan 289)', () => {
  it('GET returns sliceRevisions for all four slices, and null for an unknown book', async () => {
    expect(await mockGetBookState('never-seen')).toBeNull();
    await mockPutBookState('rev-a', { slice: 'state', patch: { title: 'T' } });
    const res = await mockGetBookState('rev-a');
    expect(Object.keys(res!.sliceRevisions!).sort()).toEqual(['cast', 'changeLog', 'manuscript', 'state']);
    expect(res!.sliceRevisions!.state.title).toEqual(expect.any(String));
  });

  it('PUT returns the slice revision, equal to the next GET value', async () => {
    const { revision } = await mockPutBookState('rev-b', { slice: 'state', patch: { title: 'T1' } });
    const res = await mockGetBookState('rev-b');
    expect(revision).toEqual(res!.sliceRevisions!.state);
  });

  it('refuses a stale base with code stale_revision and writes nothing', async () => {
    await mockPutBookState('rev-c', { slice: 'state', patch: { title: 'T0' } });
    const base = (await mockGetBookState('rev-c'))!.sliceRevisions!.state;
    await mockPutBookState('rev-c', { slice: 'state', patch: { title: 'T2' } });
    const err = await mockPutBookState('rev-c', {
      slice: 'state',
      patch: { title: 'T1' },
      baseRevision: base,
    }).catch((e: Error & { code?: string }) => e);
    expect((err as Error).message).toContain('409');
    expect((err as Error & { code?: string }).code).toBe('stale_revision');
    expect((await mockGetBookState('rev-c'))!.state.title).toBe('T2');
  });

  it('names the stale fields on the refusal, and only those', async () => {
    await mockPutBookState('rev-c2', { slice: 'state', patch: { title: 'T0', notes: 'N0' } });
    const base = (await mockGetBookState('rev-c2'))!.sliceRevisions!.state;
    await mockPutBookState('rev-c2', { slice: 'state', patch: { title: 'T2' } });
    const err = await mockPutBookState('rev-c2', {
      slice: 'state',
      patch: { title: 'T1', notes: 'N1' },
      baseRevision: base,
    }).catch((e: Error & { fields?: string[] }) => e);
    expect((err as Error & { fields?: string[] }).fields).toEqual(['title']);
  });

  it('accepts a base for a field another writer did not change (disjoint fields)', async () => {
    await mockPutBookState('rev-d', { slice: 'state', patch: { title: 'T0' } });
    const base = (await mockGetBookState('rev-d'))!.sliceRevisions!.state;
    await mockPutBookState('rev-d', { slice: 'state', patch: { title: 'T2' } });
    await mockPutBookState('rev-d', {
      slice: 'state',
      patch: { castConfirmed: true },
      baseRevision: base,
    });
    const res = await mockGetBookState('rev-d');
    expect(res!.state.castConfirmed).toBe(true);
    expect(res!.state.title).toBe('T2');
  });

  it('accepts a no-op retry of an already-landed write at its old base', async () => {
    await mockPutBookState('rev-e', { slice: 'state', patch: { title: 'T0' } });
    const base = (await mockGetBookState('rev-e'))!.sliceRevisions!.state;
    await mockPutBookState('rev-e', { slice: 'state', patch: { title: 'T1' } });
    const { revision } = await mockPutBookState('rev-e', {
      slice: 'state',
      patch: { title: 'T1' },
      baseRevision: base,
    });
    expect(revision).toEqual((await mockGetBookState('rev-e'))!.sliceRevisions!.state);
  });

  it('treats a missing base as unconditional', async () => {
    await mockPutBookState('rev-f', { slice: 'state', patch: { title: 'T0' } });
    await mockPutBookState('rev-f', { slice: 'state', patch: { title: 'T1' } });
    expect((await mockGetBookState('rev-f'))!.state.title).toBe('T1');
  });

  it.each([
    ['reparse', mockReparseBook],
    ['replace', (id: string) => mockReplaceManuscript(id, new File([''], 'x.txt'))],
  ])('a mock %s rotates the epoch, so every token moves and an old base is refused', async (_n, wipe) => {
    await mockPutBookState('rev-g', { slice: 'state', patch: { castConfirmed: false } });
    const base = (await mockGetBookState('rev-g'))!.sliceRevisions!.state;
    await wipe('rev-g');
    const after = (await mockGetBookState('rev-g'))!.sliceRevisions!.state;
    expect(after.castConfirmed).not.toEqual(base.castConfirmed);
    const err = await mockPutBookState('rev-g', {
      slice: 'state',
      patch: { castConfirmed: true },
      baseRevision: base,
    }).catch((e: Error & { code?: string }) => e);
    expect((err as Error & { code?: string }).code).toBe('stale_revision');
  });
});
