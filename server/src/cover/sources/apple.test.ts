import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { searchApple } from './apple.js';

const fetchMock = vi.fn();
beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('searchApple', () => {
  it('queries the iTunes ebook endpoint and upscales artworkUrl100 to 600x600', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        results: [
          {
            trackId: 123,
            artworkUrl100: 'https://is1.mzstatic.com/image/thumb/abc/100x100bb.jpg',
            releaseDate: '2007-04-03T07:00:00Z',
          },
        ],
      }),
    );

    const out = await searchApple('Skulduggery Pleasant', 'Derek Landy');

    const [url] = fetchMock.mock.calls[0];
    const parsed = new URL(url as string);
    expect(parsed.searchParams.get('term')).toBe('Skulduggery Pleasant Derek Landy');
    expect(parsed.searchParams.get('media')).toBe('ebook');

    expect(out[0]).toEqual({
      id: 'apple:123',
      source: 'apple',
      coverUrl: 'https://is1.mzstatic.com/image/thumb/abc/600x600bb.jpg',
      edition: '2007',
    });
  });

  it('falls back to collectionId, skips results with no artwork, dedupes', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        results: [
          { collectionId: 9, artworkUrl100: 'https://x/100x100bb.jpg' },
          { trackId: 9, artworkUrl100: 'https://x/100x100bb.jpg' }, // dup id 9
          { trackId: 10 }, // no artwork
        ],
      }),
    );
    const out = await searchApple('T', 'A');
    expect(out.map((c) => c.id)).toEqual(['apple:9']);
  });

  it('returns [] when the query is blank', async () => {
    expect(await searchApple('', '')).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
