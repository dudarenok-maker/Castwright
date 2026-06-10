import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { searchGoogle } from './google.js';

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

describe('searchGoogle', () => {
  it('queries the volumes endpoint and normalises the thumbnail URL (https, no edge=curl, zoom=1)', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        items: [
          {
            id: 'vol_AbC',
            volumeInfo: {
              publisher: 'HarperCollins',
              publishedDate: '2007',
              imageLinks: {
                thumbnail: 'http://books.google.com/books/content?id=AbC&zoom=5&edge=curl',
              },
            },
          },
        ],
      }),
    );

    const out = await searchGoogle('Scepter of the Ancients', 'Derek Landy');

    const [url] = fetchMock.mock.calls[0];
    const parsed = new URL(url as string);
    expect(parsed.searchParams.get('q')).toBe('Scepter of the Ancients Derek Landy');
    expect(parsed.searchParams.get('country')).toBe('US');

    expect(out[0]).toEqual({
      id: 'google:vol_AbC',
      source: 'google',
      coverUrl: 'https://books.google.com/books/content?id=AbC&zoom=1',
      edition: 'HarperCollins · 2007',
    });
  });

  it('falls back to smallThumbnail, skips items without images or id, dedupes', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        items: [
          { id: 'a', volumeInfo: { imageLinks: { smallThumbnail: 'https://x/s.jpg' } } },
          { id: 'a', volumeInfo: { imageLinks: { smallThumbnail: 'https://x/s.jpg' } } }, // dup
          { id: 'b', volumeInfo: {} }, // no image
          { volumeInfo: { imageLinks: { thumbnail: 'https://x/t.jpg' } } }, // no id
        ],
      }),
    );
    const out = await searchGoogle('T', 'A');
    expect(out.map((c) => c.id)).toEqual(['google:a']);
  });

  it('returns [] when items is missing (Google "no results" shape)', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ totalItems: 0 }));
    expect(await searchGoogle('T', 'A')).toEqual([]);
  });

  it('returns [] when the query is blank', async () => {
    expect(await searchGoogle('', '')).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
