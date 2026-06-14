import { describe, it, expect } from 'vitest';
import { MOCK_LIBRARY } from './library';

const allBooks = MOCK_LIBRARY.authors.flatMap((a) => a.series.flatMap((s) => s.books));

describe('MOCK_LIBRARY voice totals', () => {
  it('every book carries voiceIds (else the library VOICES total renders 0)', () => {
    for (const b of allBooks) expect(Array.isArray(b.voiceIds)).toBe(true);
  });

  it('per-book voiceIds length matches voiceCount', () => {
    for (const b of allBooks) expect(b.voiceIds!.length).toBe(b.voiceCount);
  });

  it('distinct voices is non-zero and counts series-reused voices once', () => {
    // Mirrors book-library.tsx: new Set(flatMap(voiceIds)).size.
    const distinct = new Set(allBooks.flatMap((b) => b.voiceIds ?? [])).size;
    // 5 in Solway Bay + 1 new in The Northern Star (narrator/Carrick/Mara reused;
    // Carrick's Compass reuses only existing ids) = 6.
    expect(distinct).toBe(6);
    // Strictly fewer than the naive sum, proving reuse is collapsed.
    const summed = allBooks.reduce((s, b) => s + b.voiceCount, 0);
    expect(distinct).toBeLessThan(summed);
  });
});
