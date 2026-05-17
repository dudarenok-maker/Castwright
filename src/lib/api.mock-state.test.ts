/* Pairs with docs/features/27-book-state-persistence.md.

   Covers the in-memory mock backing store for book state — the round-trip
   contract that lets jsdom tests and design fixtures exercise the persist
   path without a Node backend. Imports the mock pair directly because the
   api module locks USE_MOCKS at import time; flipping the env in a test
   file is too late to swap api.* over to the mock branch. */

import { describe, it, expect, beforeEach } from 'vitest';
import { mockGetBookState, mockPutBookState, _resetMockBookStates } from './api';
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
