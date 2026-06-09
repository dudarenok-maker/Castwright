import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { searchOpenLibrary } from './openlibrary.js';

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

describe('searchOpenLibrary', () => {
  it('uses a free-text q= query (NOT strict title=/author=) and maps cover_i to candidates', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        docs: [
          { cover_i: 48006, publisher: ['HarperCollins'], first_publish_year: 2007 },
          { cover_i: 222 },
        ],
      }),
    );

    const out = await searchOpenLibrary('Scepter of the Ancients', 'Derek Landy');

    const [url] = fetchMock.mock.calls[0];
    const parsed = new URL(url as string);
    expect(parsed.searchParams.get('q')).toBe('Scepter of the Ancients Derek Landy');
    expect(parsed.searchParams.get('title')).toBeNull();

    expect(out[0]).toEqual({
      id: 'openlibrary:48006',
      source: 'openlibrary',
      coverUrl: 'https://covers.openlibrary.org/b/id/48006-L.jpg',
      edition: 'HarperCollins · 2007',
    });
    expect(out[1].edition).toBeUndefined();
  });

  it('skips docs with no cover_i and dedupes repeated cover_i', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ docs: [{ title: 'no cover' }, { cover_i: 5 }, { cover_i: 5 }] }),
    );
    const out = await searchOpenLibrary('T', 'A');
    expect(out).toHaveLength(1);
    expect(out[0].id).toBe('openlibrary:5');
  });

  it('returns [] when title and author are both blank (no network call)', async () => {
    const out = await searchOpenLibrary('  ', '');
    expect(out).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
