import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('./sources/openlibrary.js', () => ({ searchOpenLibrary: vi.fn() }));
vi.mock('./sources/apple.js', () => ({ searchApple: vi.fn() }));
vi.mock('./sources/google.js', () => ({ searchGoogle: vi.fn() }));

import { searchOpenLibrary } from './sources/openlibrary.js';
import { searchApple } from './sources/apple.js';
import { searchGoogle } from './sources/google.js';
import { CoverSourceError, type CoverCandidate } from './sources/types.js';
import { aggregateCovers, firstAvailableCover, findCandidateById } from './search.js';

const ol = searchOpenLibrary as unknown as ReturnType<typeof vi.fn>;
const apple = searchApple as unknown as ReturnType<typeof vi.fn>;
const google = searchGoogle as unknown as ReturnType<typeof vi.fn>;

function cand(source: 'openlibrary' | 'apple' | 'google', n: number): CoverCandidate {
  return { id: `${source}:${n}`, source, coverUrl: `https://x/${source}/${n}.jpg` };
}

beforeEach(() => {
  ol.mockReset();
  apple.mockReset();
  google.mockReset();
});

describe('aggregateCovers', () => {
  it('interleaves round-robin: each source #1 before any source #2', async () => {
    ol.mockResolvedValue([cand('openlibrary', 1), cand('openlibrary', 2)]);
    apple.mockResolvedValue([cand('apple', 1), cand('apple', 2)]);
    google.mockResolvedValue([cand('google', 1)]);

    const out = await aggregateCovers('T', 'A');
    expect(out.map((c) => c.id)).toEqual([
      'openlibrary:1',
      'apple:1',
      'google:1',
      'openlibrary:2',
      'apple:2',
    ]);
  });

  it('drops a source that throws and keeps the others (allSettled)', async () => {
    ol.mockRejectedValue(new CoverSourceError('openlibrary', 'http', 'down'));
    apple.mockResolvedValue([cand('apple', 1)]);
    google.mockResolvedValue([cand('google', 1)]);

    const out = await aggregateCovers('T', 'A');
    expect(out.map((c) => c.id)).toEqual(['apple:1', 'google:1']);
  });

  it('caps the total at 12', async () => {
    ol.mockResolvedValue(Array.from({ length: 6 }, (_, i) => cand('openlibrary', i)));
    apple.mockResolvedValue(Array.from({ length: 6 }, (_, i) => cand('apple', i)));
    google.mockResolvedValue(Array.from({ length: 6 }, (_, i) => cand('google', i)));
    const out = await aggregateCovers('T', 'A');
    expect(out).toHaveLength(12);
  });
});

describe('firstAvailableCover', () => {
  it('returns OpenLibrary top when present (priority order)', async () => {
    ol.mockResolvedValue([cand('openlibrary', 1)]);
    apple.mockResolvedValue([cand('apple', 1)]);
    const top = await firstAvailableCover('T', 'A');
    expect(top?.id).toBe('openlibrary:1');
    expect(apple).not.toHaveBeenCalled(); // short-circuits on first hit
  });

  it('falls through an empty source to the next', async () => {
    ol.mockResolvedValue([]);
    apple.mockResolvedValue([cand('apple', 1)]);
    const top = await firstAvailableCover('T', 'A');
    expect(top?.id).toBe('apple:1');
  });

  it('falls through a throwing source to the next', async () => {
    ol.mockRejectedValue(new CoverSourceError('openlibrary', 'timeout', 'slow'));
    apple.mockResolvedValue([]);
    google.mockResolvedValue([cand('google', 1)]);
    const top = await firstAvailableCover('T', 'A');
    expect(top?.id).toBe('google:1');
  });

  it('returns null when every source is empty', async () => {
    ol.mockResolvedValue([]);
    apple.mockResolvedValue([]);
    google.mockResolvedValue([]);
    expect(await firstAvailableCover('T', 'A')).toBeNull();
  });
});

describe('findCandidateById', () => {
  it('dispatches to the candidate\'s own source only and matches by id', async () => {
    apple.mockResolvedValue([cand('apple', 7), cand('apple', 8)]);
    const hit = await findCandidateById('T', 'A', 'apple:8');
    expect(hit?.id).toBe('apple:8');
    expect(ol).not.toHaveBeenCalled();
    expect(google).not.toHaveBeenCalled();
  });

  it('returns null for an unknown id within the source', async () => {
    apple.mockResolvedValue([cand('apple', 7)]);
    expect(await findCandidateById('T', 'A', 'apple:999')).toBeNull();
  });

  it('returns null for an unparseable / unknown source prefix', async () => {
    expect(await findCandidateById('T', 'A', 'bogus:1')).toBeNull();
    expect(await findCandidateById('T', 'A', 'noprefix')).toBeNull();
  });

  it('propagates a CoverSourceError so the route can 502', async () => {
    ol.mockRejectedValue(new CoverSourceError('openlibrary', 'http', 'down'));
    await expect(findCandidateById('T', 'A', 'openlibrary:1')).rejects.toMatchObject({
      name: 'CoverSourceError',
    });
  });
});
