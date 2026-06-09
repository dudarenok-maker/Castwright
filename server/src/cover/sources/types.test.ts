import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  CoverSourceError,
  fetchSourceJson,
  formatEdition,
  parseYear,
} from './types.js';

const fetchMock = vi.fn();
beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('fetchSourceJson', () => {
  it('returns parsed JSON on 200', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ hello: 'world' }));
    const out = await fetchSourceJson<{ hello: string }>('openlibrary', 'https://x', 1000);
    expect(out.hello).toBe('world');
  });

  it('throws CoverSourceError(kind="http") on a non-ok response, carrying the source', async () => {
    fetchMock.mockResolvedValue(new Response('boom', { status: 503 }));
    await expect(fetchSourceJson('apple', 'https://x', 1000)).rejects.toMatchObject({
      name: 'CoverSourceError',
      source: 'apple',
      kind: 'http',
    });
  });

  it('throws CoverSourceError(kind="invalid") on malformed JSON', async () => {
    fetchMock.mockResolvedValue(new Response('not json', { status: 200 }));
    await expect(fetchSourceJson('google', 'https://x', 1000)).rejects.toMatchObject({
      kind: 'invalid',
    });
  });

  it('throws CoverSourceError(kind="timeout") when fetch aborts', async () => {
    fetchMock.mockRejectedValue(Object.assign(new Error('aborted'), { name: 'AbortError' }));
    await expect(fetchSourceJson('openlibrary', 'https://x', 1000)).rejects.toMatchObject({
      kind: 'timeout',
    });
  });
});

describe('formatEdition / parseYear', () => {
  it('joins publisher and year', () => {
    expect(formatEdition('Aladdin', 2012)).toBe('Aladdin · 2012');
  });
  it('returns just the year when publisher is absent', () => {
    expect(formatEdition(undefined, 2007)).toBe('2007');
  });
  it('returns undefined when both are absent', () => {
    expect(formatEdition(undefined, undefined)).toBeUndefined();
  });
  it('extracts a 4-digit year from a date string', () => {
    expect(parseYear('2007-04-03')).toBe(2007);
    expect(parseYear('April 2007')).toBe(2007);
    expect(parseYear(undefined)).toBeUndefined();
  });
});
