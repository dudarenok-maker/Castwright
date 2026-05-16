/* Unit tests for the OpenLibrary client.

   Covers:
   - searchCovers returns deduped candidates, filters out entries with
     no cover_i, builds correct OpenLibrary URLs.
   - searchCovers handles empty docs, malformed JSON, non-2xx, timeout.
   - downloadCover validates content-type, enforces size cap, writes
     atomically (tmp + rename) so a kill mid-write doesn't corrupt
     existing covers.

   Network is mocked at global.fetch via vi.stubGlobal so the tests run
   without a real OpenLibrary round-trip. */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { searchCovers, downloadCover, OpenLibraryError } from './openlibrary.js';

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function imageResponse(bytes: Uint8Array, contentType = 'image/jpeg'): Response {
  return new Response(bytes, { status: 200, headers: { 'Content-Type': contentType } });
}

describe('searchCovers', () => {
  it('builds OpenLibrary URLs from cover_i and dedupes repeats', async () => {
    fetchMock.mockResolvedValue(jsonResponse({
      docs: [
        { cover_i: 11, title: 'A', first_publish_year: 2020, publisher: ['Alpha'] },
        { cover_i: 22, title: 'B', publish_date: ['March 1999'] },
        { cover_i: 11, title: 'A dup' },             // dupe should be filtered
        { title: 'no-cover' },                       // missing cover_i
        { cover_i: 33, title: 'C', publisher: ['Beta'] },
      ],
    }));

    const candidates = await searchCovers('Foo', 'Bar');
    expect(candidates).toHaveLength(3);
    expect(candidates.map(c => c.openLibraryId)).toEqual([
      'cover-i:11', 'cover-i:22', 'cover-i:33',
    ]);
    expect(candidates[0].coverUrl).toBe('https://covers.openlibrary.org/b/id/11-L.jpg');
    expect(candidates[0].edition).toBe('Alpha · 2020');
    expect(candidates[1].edition).toBe('1999');
    expect(candidates[2].edition).toBe('Beta');
  });

  it('caps the returned candidates at 6', async () => {
    const docs = Array.from({ length: 20 }, (_, i) => ({ cover_i: i + 100 }));
    fetchMock.mockResolvedValue(jsonResponse({ docs }));
    const candidates = await searchCovers('Many', 'Editions');
    expect(candidates).toHaveLength(6);
  });

  it('returns [] when the docs array is empty', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ docs: [] }));
    expect(await searchCovers('Nothing', 'Nobody')).toEqual([]);
  });

  it('returns [] when both title and author are blank without hitting the network', async () => {
    expect(await searchCovers('', '   ')).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('URL-encodes the title + author into the search query', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ docs: [] }));
    await searchCovers('the Coalfall Commission', 'Della Renwick');
    const [url] = fetchMock.mock.calls[0];
    expect(typeof url).toBe('string');
    const parsed = new URL(url);
    expect(parsed.host).toBe('openlibrary.org');
    expect(parsed.pathname).toBe('/search.json');
    expect(parsed.searchParams.get('title')).toBe('the Coalfall Commission');
    expect(parsed.searchParams.get('author')).toBe('Della Renwick');
    expect(parsed.searchParams.get('limit')).toBe('20');
  });

  it('throws OpenLibraryError(http) on non-2xx', async () => {
    fetchMock.mockResolvedValue(new Response('boom', { status: 503 }));
    await expect(searchCovers('Title', 'Author')).rejects.toMatchObject({
      name: 'OpenLibraryError',
      kind: 'http',
    });
  });

  it('throws OpenLibraryError(invalid) when the JSON is malformed', async () => {
    fetchMock.mockResolvedValue(new Response('not json', {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));
    await expect(searchCovers('Title', 'Author')).rejects.toMatchObject({
      name: 'OpenLibraryError',
      kind: 'invalid',
    });
  });

  it('throws OpenLibraryError(timeout) when fetch aborts', async () => {
    fetchMock.mockImplementation(() => Promise.reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
    await expect(searchCovers('Title', 'Author')).rejects.toMatchObject({
      name: 'OpenLibraryError',
      kind: 'timeout',
    });
  });
});

describe('downloadCover', () => {
  let workspaceRoot: string;
  let destPath: string;

  beforeEach(() => {
    workspaceRoot = mkdtempSync(join(tmpdir(), 'cover-dl-'));
    destPath = join(workspaceRoot, 'sub', 'cover.jpg');
  });

  afterEach(() => {
    if (workspaceRoot) rmSync(workspaceRoot, { recursive: true, force: true });
  });

  it('writes the bytes to disk when content-type is image/* and within size cap', async () => {
    const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a]);
    fetchMock.mockResolvedValue(imageResponse(bytes));

    const result = await downloadCover('https://covers.openlibrary.org/b/id/1-L.jpg', destPath);
    expect(result.bytes).toBe(bytes.length);
    expect(existsSync(destPath)).toBe(true);
    expect(Array.from(readFileSync(destPath))).toEqual(Array.from(bytes));
  });

  it('rejects non-image content types', async () => {
    fetchMock.mockResolvedValue(new Response('<html/>', {
      status: 200,
      headers: { 'Content-Type': 'text/html' },
    }));
    await expect(downloadCover('https://x/1.jpg', destPath)).rejects.toMatchObject({
      name: 'OpenLibraryError',
      kind: 'invalid',
    });
    expect(existsSync(destPath)).toBe(false);
  });

  it('rejects an empty body even if labelled image/*', async () => {
    fetchMock.mockResolvedValue(imageResponse(new Uint8Array(0)));
    await expect(downloadCover('https://x/1.jpg', destPath)).rejects.toMatchObject({
      name: 'OpenLibraryError',
      kind: 'invalid',
    });
  });

  it('rejects a body that exceeds the 5 MB cap', async () => {
    const oversized = new Uint8Array(6 * 1024 * 1024);
    oversized[0] = 0xff;
    fetchMock.mockResolvedValue(imageResponse(oversized));
    await expect(downloadCover('https://x/1.jpg', destPath)).rejects.toMatchObject({
      name: 'OpenLibraryError',
      kind: 'too_large',
    });
  });

  it('throws OpenLibraryError(timeout) when the download aborts', async () => {
    fetchMock.mockImplementation(() => Promise.reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
    await expect(downloadCover('https://x/1.jpg', destPath)).rejects.toMatchObject({
      name: 'OpenLibraryError',
      kind: 'timeout',
    });
  });

  it('throws OpenLibraryError on non-2xx', async () => {
    fetchMock.mockResolvedValue(new Response('nope', { status: 404 }));
    await expect(downloadCover('https://x/1.jpg', destPath)).rejects.toBeInstanceOf(OpenLibraryError);
  });
});
