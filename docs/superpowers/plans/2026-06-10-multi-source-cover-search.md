# Multi-source Cover Search Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Search OpenLibrary + Apple Books + Google Books (free-text queries) for book covers, merging results into one interleaved source-badged picker grid and a priority-order auto-fetch, so known books like *Scepter of the Ancients* find a cover instead of "No covers found."

**Architecture:** Split today's monolithic `server/src/cover/openlibrary.ts` into three pure per-source adapters under `cover/sources/`, an aggregation layer (`cover/search.ts`) that fans out with `Promise.allSettled` and round-robin-interleaves, and a `cover/store.ts` that owns byte download + `state.json` patching. The picker calls `aggregateCovers`; the import auto-fetch calls `firstAvailableCover` (sequential priority). `CoverCandidate` gains `id` (composite `<source>:<localId>`) + `source`; the POST body field `openLibraryId` becomes `candidateId`.

**Tech Stack:** TypeScript, Node 20 (native `fetch`/`AbortController`), Vitest (node + jsdom), Express 5, React 18, Playwright. Spec: `docs/superpowers/specs/2026-06-10-multi-source-cover-search-design.md`.

---

## File Structure

**Create**
- `server/src/cover/sources/types.ts` — `CoverSource`, `CoverCandidate`, `CoverSourceError`, `fetchSourceJson`, `formatEdition`, `parseYear`, shared constants.
- `server/src/cover/sources/openlibrary.ts` — `searchOpenLibrary(title, author)`.
- `server/src/cover/sources/apple.ts` — `searchApple(title, author)`.
- `server/src/cover/sources/google.ts` — `searchGoogle(title, author)`.
- `server/src/cover/search.ts` — `aggregateCovers`, `firstAvailableCover`, `findCandidateById`.
- `server/src/cover/store.ts` — `downloadCover`, `CoverDownloadError`, `patchStateCover`, `clearStateCover`, `backgroundFetchCover`.
- Tests: `server/src/cover/sources/{types,openlibrary,apple,google}.test.ts`, `server/src/cover/search.test.ts`, `server/src/cover/store.test.ts`.

**Modify**
- `server/src/cover/openlibrary.ts` — **delete** (split into the above).
- `server/src/routes/cover.ts` — import from `search.js`/`store.js`; `candidateId` body field.
- `server/src/routes/cover.test.ts` — `candidateId` + multi-source assertions.
- `server/src/routes/import.ts:41` — import `backgroundFetchCover` from `../cover/store.js`.
- `server/src/workspace/scan.ts:154-160` — `coverImage` type gains `candidateId` + extended `source` union.
- `openapi.yaml` — `CoverCandidate` schema (`id`, `source`) + POST body (`candidateId`).
- `src/lib/api-types.ts` — regenerate from openapi.
- `src/lib/api.ts` — mock candidates + `setCover` param rename to `candidateId`.
- `src/modals/cover-picker.tsx` — source badge, `candidate.id`, reworded copy.
- `src/modals/cover-picker.test.tsx` — updated testids/badges/copy.
- `e2e/cover-picker.spec.ts` — **create** (badges + empty-state).

---

## Task 1: Shared source types + fetch helper

**Files:**
- Create: `server/src/cover/sources/types.ts`
- Test: `server/src/cover/sources/types.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// server/src/cover/sources/types.test.ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx vitest run src/cover/sources/types.test.ts`
Expected: FAIL — cannot find module `./types.js`.

- [ ] **Step 3: Write minimal implementation**

```ts
// server/src/cover/sources/types.ts
/* Shared contract + helpers for the per-source cover adapters. Each
   adapter (openlibrary/apple/google) is a pure search(title, author) →
   CoverCandidate[] that knows only its own API. Failures surface as a
   typed CoverSourceError so the aggregation layer can swallow a single
   source without losing the others. */

export type CoverSource = 'openlibrary' | 'apple' | 'google';

export interface CoverCandidate {
  /** Composite, source-agnostic id: `<source>:<localId>` — round-trips
      through POST /cover so the route re-locates the same candidate. */
  id: string;
  source: CoverSource;
  coverUrl: string;
  /** Best-effort `<publisher> · <year>` (or just one). Optional. */
  edition?: string;
}

export type CoverSourceErrorKind = 'timeout' | 'http' | 'invalid';

export class CoverSourceError extends Error {
  constructor(
    public source: CoverSource,
    public kind: CoverSourceErrorKind,
    message: string,
  ) {
    super(message);
    this.name = 'CoverSourceError';
  }
}

export const SEARCH_TIMEOUT_MS = 6_000;
export const MAX_PER_SOURCE = 6;

const USER_AGENT = 'castwright/1.0 (https://github.com/dudarenok-maker/Castwright)';

/** Fetch JSON with a per-source AbortController timeout, mapping every
    failure mode to a CoverSourceError tagged with the source. */
export async function fetchSourceJson<T>(
  source: CoverSource,
  url: string,
  timeoutMs: number,
): Promise<T> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  let res: Response;
  try {
    res = await fetch(url, {
      signal: ctrl.signal,
      headers: { Accept: 'application/json', 'User-Agent': USER_AGENT },
    });
  } catch (e) {
    if ((e as Error).name === 'AbortError') {
      throw new CoverSourceError(source, 'timeout', `${source} search timed out.`);
    }
    throw new CoverSourceError(source, 'http', `${source} search failed: ${(e as Error).message}`);
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    throw new CoverSourceError(source, 'http', `${source} search returned HTTP ${res.status}.`);
  }
  try {
    return (await res.json()) as T;
  } catch {
    throw new CoverSourceError(source, 'invalid', `${source} search returned malformed JSON.`);
  }
}

export function parseYear(s: string | undefined): number | undefined {
  if (!s) return undefined;
  const m = s.match(/\d{4}/);
  return m ? Number(m[0]) : undefined;
}

export function formatEdition(
  publisher: string | undefined,
  year: number | undefined,
): string | undefined {
  const parts = [publisher?.trim(), year ? String(year) : undefined].filter(Boolean) as string[];
  return parts.length > 0 ? parts.join(' · ') : undefined;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && npx vitest run src/cover/sources/types.test.ts`
Expected: PASS (all cases green).

- [ ] **Step 5: Commit**

```bash
git add server/src/cover/sources/types.ts server/src/cover/sources/types.test.ts
git commit -m "feat(server): shared cover-source contract + fetch helper"
```

---

## Task 2: OpenLibrary adapter

**Files:**
- Create: `server/src/cover/sources/openlibrary.ts`
- Test: `server/src/cover/sources/openlibrary.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// server/src/cover/sources/openlibrary.test.ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx vitest run src/cover/sources/openlibrary.test.ts`
Expected: FAIL — cannot find module `./openlibrary.js`.

- [ ] **Step 3: Write minimal implementation**

```ts
// server/src/cover/sources/openlibrary.ts
/* OpenLibrary cover source. Free-text `q=` query (the strict
   title=/author= query missed catalogued-under-a-different-title books
   like Skulduggery Pleasant / "Scepter of the Ancients"). */

import {
  type CoverCandidate,
  MAX_PER_SOURCE,
  SEARCH_TIMEOUT_MS,
  fetchSourceJson,
  formatEdition,
  parseYear,
} from './types.js';

interface OpenLibraryDoc {
  cover_i?: number;
  publisher?: string[];
  publish_date?: string[];
  first_publish_year?: number;
}

export async function searchOpenLibrary(title: string, author: string): Promise<CoverCandidate[]> {
  const q = [title.trim(), author.trim()].filter(Boolean).join(' ');
  if (!q) return [];

  const params = new URLSearchParams({ q, limit: '20' });
  const url = `https://openlibrary.org/search.json?${params.toString()}`;
  const json = await fetchSourceJson<{ docs?: OpenLibraryDoc[] }>(
    'openlibrary',
    url,
    SEARCH_TIMEOUT_MS,
  );

  const docs = Array.isArray(json.docs) ? json.docs : [];
  const seen = new Set<number>();
  const out: CoverCandidate[] = [];
  for (const d of docs) {
    if (typeof d.cover_i !== 'number' || !Number.isFinite(d.cover_i)) continue;
    if (seen.has(d.cover_i)) continue;
    seen.add(d.cover_i);
    out.push({
      id: `openlibrary:${d.cover_i}`,
      source: 'openlibrary',
      coverUrl: `https://covers.openlibrary.org/b/id/${d.cover_i}-L.jpg`,
      edition: formatEdition(d.publisher?.[0], d.first_publish_year ?? parseYear(d.publish_date?.[0])),
    });
    if (out.length >= MAX_PER_SOURCE) break;
  }
  return out;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && npx vitest run src/cover/sources/openlibrary.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/cover/sources/openlibrary.ts server/src/cover/sources/openlibrary.test.ts
git commit -m "feat(server): OpenLibrary cover adapter with free-text query"
```

---

## Task 3: Apple Books (iTunes) adapter

**Files:**
- Create: `server/src/cover/sources/apple.ts`
- Test: `server/src/cover/sources/apple.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// server/src/cover/sources/apple.test.ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx vitest run src/cover/sources/apple.test.ts`
Expected: FAIL — cannot find module `./apple.js`.

- [ ] **Step 3: Write minimal implementation**

```ts
// server/src/cover/sources/apple.ts
/* Apple Books cover source via the keyless iTunes Search API.
   artworkUrl100 ends in a `100x100bb` size token we swap for a larger
   one to get a usable cover. */

import {
  type CoverCandidate,
  MAX_PER_SOURCE,
  SEARCH_TIMEOUT_MS,
  fetchSourceJson,
  formatEdition,
  parseYear,
} from './types.js';

interface ItunesResult {
  trackId?: number;
  collectionId?: number;
  artworkUrl100?: string;
  releaseDate?: string;
}

export async function searchApple(title: string, author: string): Promise<CoverCandidate[]> {
  const term = [title.trim(), author.trim()].filter(Boolean).join(' ');
  if (!term) return [];

  const params = new URLSearchParams({ term, media: 'ebook', limit: '10' });
  const url = `https://itunes.apple.com/search?${params.toString()}`;
  const json = await fetchSourceJson<{ results?: ItunesResult[] }>('apple', url, SEARCH_TIMEOUT_MS);

  const results = Array.isArray(json.results) ? json.results : [];
  const seen = new Set<number>();
  const out: CoverCandidate[] = [];
  for (const r of results) {
    const localId = r.trackId ?? r.collectionId;
    if (typeof localId !== 'number' || !Number.isFinite(localId)) continue;
    if (!r.artworkUrl100) continue;
    if (seen.has(localId)) continue;
    seen.add(localId);
    out.push({
      id: `apple:${localId}`,
      source: 'apple',
      coverUrl: r.artworkUrl100.replace('100x100bb', '600x600bb'),
      edition: formatEdition(undefined, parseYear(r.releaseDate)),
    });
    if (out.length >= MAX_PER_SOURCE) break;
  }
  return out;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && npx vitest run src/cover/sources/apple.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/cover/sources/apple.ts server/src/cover/sources/apple.test.ts
git commit -m "feat(server): Apple Books (iTunes) cover adapter"
```

---

## Task 4: Google Books adapter

**Files:**
- Create: `server/src/cover/sources/google.ts`
- Test: `server/src/cover/sources/google.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// server/src/cover/sources/google.test.ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx vitest run src/cover/sources/google.test.ts`
Expected: FAIL — cannot find module `./google.js`.

- [ ] **Step 3: Write minimal implementation**

```ts
// server/src/cover/sources/google.ts
/* Google Books cover source — keyless, best-effort. Lowest-resolution
   of the three; the aggregation layer simply drops it when it errors or
   returns nothing. Thumbnails come back http with an `edge=curl` page-curl
   overlay and a small zoom; normalise to a clean https image. */

import {
  type CoverCandidate,
  MAX_PER_SOURCE,
  SEARCH_TIMEOUT_MS,
  fetchSourceJson,
  formatEdition,
  parseYear,
} from './types.js';

interface GoogleVolume {
  id?: string;
  volumeInfo?: {
    publisher?: string;
    publishedDate?: string;
    imageLinks?: { thumbnail?: string; smallThumbnail?: string };
  };
}

function normaliseImage(u: string): string {
  return u
    .replace(/^http:/, 'https:')
    .replace(/&edge=curl/, '')
    .replace(/zoom=\d/, 'zoom=1');
}

export async function searchGoogle(title: string, author: string): Promise<CoverCandidate[]> {
  const q = [title.trim(), author.trim()].filter(Boolean).join(' ');
  if (!q) return [];

  const params = new URLSearchParams({ q, country: 'US', maxResults: '10' });
  const url = `https://www.googleapis.com/books/v1/volumes?${params.toString()}`;
  const json = await fetchSourceJson<{ items?: GoogleVolume[] }>('google', url, SEARCH_TIMEOUT_MS);

  const items = Array.isArray(json.items) ? json.items : [];
  const seen = new Set<string>();
  const out: CoverCandidate[] = [];
  for (const v of items) {
    const id = v.id;
    const thumb = v.volumeInfo?.imageLinks?.thumbnail ?? v.volumeInfo?.imageLinks?.smallThumbnail;
    if (!id || !thumb) continue;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({
      id: `google:${id}`,
      source: 'google',
      coverUrl: normaliseImage(thumb),
      edition: formatEdition(v.volumeInfo?.publisher, parseYear(v.volumeInfo?.publishedDate)),
    });
    if (out.length >= MAX_PER_SOURCE) break;
  }
  return out;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && npx vitest run src/cover/sources/google.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/cover/sources/google.ts server/src/cover/sources/google.test.ts
git commit -m "feat(server): Google Books cover adapter (keyless, best-effort)"
```

---

## Task 5: Aggregation layer (`search.ts`)

**Files:**
- Create: `server/src/cover/search.ts`
- Test: `server/src/cover/search.test.ts`

This task mocks the three adapters (not `fetch`) so it tests orchestration in isolation: round-robin interleave, `allSettled` resilience, priority-order first-hit, and single-source `findCandidateById`.

- [ ] **Step 1: Write the failing test**

```ts
// server/src/cover/search.test.ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx vitest run src/cover/search.test.ts`
Expected: FAIL — cannot find module `./search.js`.

- [ ] **Step 3: Write minimal implementation**

```ts
// server/src/cover/search.ts
/* Aggregation over the per-source adapters.
   - aggregateCovers: parallel fan-out (allSettled) → round-robin
     interleave for the picker grid; a slow/failed source never blocks
     the others.
   - firstAvailableCover: sequential priority order for the silent
     import auto-fetch; returns the first source's top hit.
   - findCandidateById: re-derives a single candidate's URL on POST,
     querying ONLY that candidate's own source (cheaper + isolates POST
     from unrelated-source outages). Never trusts a client-supplied URL. */

import { type CoverCandidate, type CoverSource } from './sources/types.js';
import { searchOpenLibrary } from './sources/openlibrary.js';
import { searchApple } from './sources/apple.js';
import { searchGoogle } from './sources/google.js';

const MAX_TOTAL = 12;

type Adapter = (title: string, author: string) => Promise<CoverCandidate[]>;

/** Source order = picker fan-out order = auto-fetch priority/fallback order. */
const SOURCES: { source: CoverSource; search: Adapter }[] = [
  { source: 'openlibrary', search: searchOpenLibrary },
  { source: 'apple', search: searchApple },
  { source: 'google', search: searchGoogle },
];

export async function aggregateCovers(title: string, author: string): Promise<CoverCandidate[]> {
  const settled = await Promise.allSettled(SOURCES.map((s) => s.search(title, author)));
  const lists = settled.map((r, i) => {
    if (r.status === 'fulfilled') return r.value;
    console.warn(`[cover] ${SOURCES[i].source} search failed: ${(r.reason as Error)?.message}`);
    return [];
  });
  return interleave(lists, MAX_TOTAL);
}

function interleave(lists: CoverCandidate[][], cap: number): CoverCandidate[] {
  const out: CoverCandidate[] = [];
  for (let rank = 0; out.length < cap; rank++) {
    let added = false;
    for (const list of lists) {
      const c = list[rank];
      if (c) {
        out.push(c);
        added = true;
        if (out.length >= cap) break;
      }
    }
    if (!added) break;
  }
  return out;
}

export async function firstAvailableCover(
  title: string,
  author: string,
): Promise<CoverCandidate | null> {
  for (const { source, search } of SOURCES) {
    try {
      const list = await search(title, author);
      if (list.length > 0) return list[0];
    } catch (e) {
      console.warn(`[cover] ${source} search failed: ${(e as Error).message}`);
    }
  }
  return null;
}

export async function findCandidateById(
  title: string,
  author: string,
  candidateId: string,
): Promise<CoverCandidate | null> {
  const sep = candidateId.indexOf(':');
  if (sep <= 0) return null;
  const source = candidateId.slice(0, sep) as CoverSource;
  const entry = SOURCES.find((s) => s.source === source);
  if (!entry) return null;
  const list = await entry.search(title, author);
  return list.find((c) => c.id === candidateId) ?? null;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && npx vitest run src/cover/search.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/cover/search.ts server/src/cover/search.test.ts
git commit -m "feat(server): cover aggregation, priority auto-fetch, single-source lookup"
```

---

## Task 6: Store layer (`store.ts`) + delete `openlibrary.ts` + rewire import

**Files:**
- Create: `server/src/cover/store.ts`
- Test: `server/src/cover/store.test.ts`
- Delete: `server/src/cover/openlibrary.ts`
- Modify: `server/src/routes/import.ts:41`
- Modify: `server/src/workspace/scan.ts` (coverImage type)

- [ ] **Step 1: Write the failing test** (covers `backgroundFetchCover` priority-order + `state.json` patch shape)

```ts
// server/src/cover/store.test.ts
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let workspaceRoot: string;
let bookDir: string;

const fetchMock = vi.fn();
function imageResponse(bytes: Uint8Array): Response {
  return new Response(bytes, { status: 200, headers: { 'Content-Type': 'image/jpeg' } });
}
const SAMPLE_JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);

beforeAll(() => {
  workspaceRoot = mkdtempSync(join(tmpdir(), 'audiobook-store-test-'));
  process.env.WORKSPACE_DIR = workspaceRoot;
  bookDir = join(workspaceRoot, 'books', 'A', 'S', 'T');
  mkdirSync(join(bookDir, '.audiobook'), { recursive: true });
  writeFileSync(
    join(bookDir, '.audiobook', 'state.json'),
    JSON.stringify({ bookId: 'bk1', title: 'T', author: 'A', updatedAt: '2020-01-01' }),
  );
});
afterAll(() => {
  if (workspaceRoot) rmSync(workspaceRoot, { recursive: true, force: true });
  delete process.env.WORKSPACE_DIR;
});
beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  vi.resetModules();
});
afterEach(() => vi.unstubAllGlobals());

describe('backgroundFetchCover', () => {
  it('downloads the first-available candidate and patches state.json with candidateId + source', async () => {
    vi.doMock('./search.js', () => ({
      firstAvailableCover: vi.fn().mockResolvedValue({
        id: 'apple:42',
        source: 'apple',
        coverUrl: 'https://x/apple/42.jpg',
      }),
    }));
    fetchMock.mockResolvedValue(imageResponse(SAMPLE_JPEG));
    const { backgroundFetchCover } = await import('./store.js');

    await backgroundFetchCover(bookDir, 'T', 'A', 'bk1');

    expect(existsSync(join(bookDir, '.audiobook', 'cover.jpg'))).toBe(true);
    const state = JSON.parse(readFileSync(join(bookDir, '.audiobook', 'state.json'), 'utf8'));
    expect(state.coverImage.candidateId).toBe('apple:42');
    expect(state.coverImage.source).toBe('apple');
    expect(state.coverImage.originalUrl).toBe('https://x/apple/42.jpg');
    expect(typeof state.coverImage.fetchedAt).toBe('string');
  });

  it('no-ops (no throw) when every source is empty', async () => {
    vi.doMock('./search.js', () => ({
      firstAvailableCover: vi.fn().mockResolvedValue(null),
    }));
    const { backgroundFetchCover } = await import('./store.js');
    await expect(backgroundFetchCover(bookDir, 'T', 'A', 'bk1')).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx vitest run src/cover/store.test.ts`
Expected: FAIL — cannot find module `./store.js`.

- [ ] **Step 3: Write `store.ts`** (downloadCover/patch/clear lifted verbatim from `openlibrary.ts`; `backgroundFetchCover` now uses `firstAvailableCover`; `patchStateCover` writes `candidateId` + `source`)

```ts
// server/src/cover/store.ts
/* Cover byte download + state.json provenance patching. Source-agnostic:
   downloadCover fetches any candidate URL (always re-derived server-side
   via findCandidateById — never a client-supplied URL, preserving the
   no-SSRF property), validates it is an image within caps, and writes
   atomically. backgroundFetchCover is the fire-and-forget import hook. */

import { mkdir, unlink, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { renameWithRetry } from '../workspace/atomic-rename.js';
import { readJson, writeJsonAtomic } from '../workspace/state-io.js';
import { stampStateSchema } from '../workspace/state-migrate.js';
import { coverImagePath, stateJsonPath } from '../workspace/paths.js';
import type { BookStateJson } from '../workspace/scan.js';
import type { CoverCandidate } from './sources/types.js';
import { firstAvailableCover } from './search.js';

const DOWNLOAD_TIMEOUT_MS = 10_000;
const MAX_COVER_BYTES = 5 * 1024 * 1024;

export type CoverDownloadErrorKind = 'timeout' | 'http' | 'invalid' | 'too_large';

export class CoverDownloadError extends Error {
  constructor(
    public kind: CoverDownloadErrorKind,
    message: string,
  ) {
    super(message);
    this.name = 'CoverDownloadError';
  }
}

export async function downloadCover(url: string, destPath: string): Promise<{ bytes: number }> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), DOWNLOAD_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(url, {
      signal: ctrl.signal,
      headers: {
        'User-Agent': 'castwright/1.0 (https://github.com/dudarenok-maker/Castwright)',
      },
    });
  } catch (e) {
    if ((e as Error).name === 'AbortError') {
      throw new CoverDownloadError('timeout', 'Cover download timed out.');
    }
    throw new CoverDownloadError('http', `Cover download failed: ${(e as Error).message}`);
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    throw new CoverDownloadError('http', `Cover download returned HTTP ${res.status}.`);
  }
  const ctype = res.headers.get('content-type') ?? '';
  if (!ctype.toLowerCase().startsWith('image/')) {
    throw new CoverDownloadError('invalid', `Response is not an image (content-type: ${ctype || 'unknown'}).`);
  }
  const buffer = Buffer.from(await res.arrayBuffer());
  if (buffer.length === 0) throw new CoverDownloadError('invalid', 'Cover body is empty.');
  if (buffer.length > MAX_COVER_BYTES) {
    throw new CoverDownloadError('too_large', `Cover exceeds ${MAX_COVER_BYTES} bytes (got ${buffer.length}).`);
  }

  await mkdir(dirname(destPath), { recursive: true });
  const tmp = `${destPath}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tmp, buffer);
  try {
    await renameWithRetry(tmp, destPath);
  } catch (e) {
    await unlink(tmp).catch(() => {
      /* best-effort */
    });
    throw e;
  }
  return { bytes: buffer.length };
}

/** Record provenance of the just-downloaded cover onto state.json so a
    library scan surfaces `coverImageUrl`. */
export async function patchStateCover(
  bookDir: string,
  candidate: Pick<CoverCandidate, 'id' | 'source' | 'coverUrl'>,
): Promise<void> {
  const path = stateJsonPath(bookDir);
  const state = await readJson<BookStateJson>(path);
  if (!state) return;
  state.coverImage = {
    source: candidate.source,
    candidateId: candidate.id,
    originalUrl: candidate.coverUrl,
    fetchedAt: new Date().toISOString(),
  };
  state.updatedAt = new Date().toISOString();
  await writeJsonAtomic(path, stampStateSchema(state));
}

/** Inverse of patchStateCover — DELETE reverts to the procedural gradient. */
export async function clearStateCover(bookDir: string): Promise<void> {
  const path = stateJsonPath(bookDir);
  const state = await readJson<BookStateJson>(path);
  if (!state) return;
  delete state.coverImage;
  state.updatedAt = new Date().toISOString();
  await writeJsonAtomic(path, stampStateSchema(state));
}

/** Fire-and-forget import hook. Priority-order first hit across all
    sources; downloads it and patches state.json. Swallows every error —
    a cover-source outage must never fail an import. */
export async function backgroundFetchCover(
  bookDir: string,
  title: string,
  author: string,
  bookId: string,
): Promise<void> {
  try {
    const top = await firstAvailableCover(title, author);
    if (!top) {
      console.log(`[cover] no match for "${title}" by "${author}" (${bookId})`);
      return;
    }
    await downloadCover(top.coverUrl, coverImagePath(bookDir));
    await patchStateCover(bookDir, top);
    console.log(`[cover] fetched ${top.id} (${top.source}) for ${bookId}`);
  } catch (e) {
    console.warn(`[cover] background fetch failed for ${bookId}: ${(e as Error).message}`);
  }
}
```

- [ ] **Step 4: Update `scan.ts` coverImage type**

In `server/src/workspace/scan.ts`, change the `coverImage` shape (currently lines ~154-160). Replace the `source` union and add `candidateId`, keeping `openLibraryId` for legacy reads:

```ts
  coverImage?: {
    /** Discriminator. Legacy records (pre-multi-source) may carry
        `openLibraryId` instead of `candidateId`; both are unused at read
        time (the scan only checks presence + the bytes on disk). */
    source?: 'openlibrary' | 'apple' | 'google' | 'local';
    /** Composite `<source>:<localId>` written by the multi-source fetch. */
    candidateId?: string;
    /** Legacy (plan 36) — OpenLibrary-only id. Read-tolerated, not written. */
    openLibraryId?: string;
    originalUrl?: string;
    fetchedAt?: string;
```

(Leave the remaining fields — `originalFilename`, `uploadedAt`, `framing` — untouched.)

- [ ] **Step 5: Delete `openlibrary.ts` and rewire the import route**

```bash
git rm server/src/cover/openlibrary.ts
```

In `server/src/routes/import.ts`, change line 41:

```ts
import { backgroundFetchCover } from '../cover/store.js';
```

- [ ] **Step 6: Run store + import-adjacent tests + typecheck**

Run: `cd server && npx vitest run src/cover/store.test.ts && npm run --prefix .. typecheck`
Expected: store tests PASS. Typecheck will still FAIL on `routes/cover.ts` (it imports from the deleted `openlibrary.js`) — that's fixed in Task 7. Confirm the ONLY remaining typecheck errors are in `routes/cover.ts` / `routes/cover.test.ts`.

- [ ] **Step 7: Commit**

```bash
git add server/src/cover/store.ts server/src/cover/store.test.ts server/src/workspace/scan.ts server/src/routes/import.ts
git rm server/src/cover/openlibrary.ts
git commit -m "feat(server): cover store layer + priority-order auto-fetch, drop openlibrary.ts"
```

---

## Task 7: Cover route + OpenAPI + regenerated types

**Files:**
- Modify: `server/src/routes/cover.ts`
- Modify: `server/src/routes/cover.test.ts`
- Modify: `openapi.yaml`
- Modify: `src/lib/api-types.ts` (regenerated)

- [ ] **Step 1: Update the route imports + `candidateId` field**

In `server/src/routes/cover.ts`:

Replace the cover-module import block (lines ~28-35) with:

```ts
import { findCandidateById, aggregateCovers } from '../cover/search.js';
import {
  CoverDownloadError,
  clearStateCover,
  downloadCover,
  patchStateCover,
} from '../cover/store.js';
```

In the `GET /:bookId/cover/candidates` handler, replace `searchCovers(state.title, state.author)` with `aggregateCovers(state.title, state.author)`, and replace the `catch` branch's `OpenLibraryError` handling — `aggregateCovers` never throws a source error (it swallows per-source), so remove the `instanceof OpenLibraryError` branch and keep only the generic 500 catch:

```ts
coverRouter.get('/:bookId/cover/candidates', async (req: Request, res: Response) => {
  try {
    const located = await findBookByBookId(req.params.bookId);
    if (!located) return res.status(404).json({ error: 'Book not found.' });
    const candidates = await aggregateCovers(located.state.title, located.state.author);
    res.json({ candidates });
  } catch (e) {
    console.error('[cover] candidates failed', e);
    res.status(500).json({ error: (e as Error).message || 'Cover lookup failed.' });
  }
});
```

In the `POST /:bookId/cover` handler, rename the body field and map both error classes to 502:

```ts
coverRouter.post('/:bookId/cover', async (req: Request, res: Response) => {
  try {
    const candidateId = (req.body as { candidateId?: unknown })?.candidateId;
    if (typeof candidateId !== 'string' || !candidateId.trim()) {
      return res.status(400).json({ error: '`candidateId` is required.' });
    }

    const located = await findBookByBookId(req.params.bookId);
    if (!located) return res.status(404).json({ error: 'Book not found.' });
    const { bookDir, state } = located;

    const candidate = await findCandidateById(state.title, state.author, candidateId);
    if (!candidate) {
      return res
        .status(404)
        .json({ error: 'Selected cover is no longer available — try a fresh search.' });
    }

    await downloadCover(candidate.coverUrl, coverImagePath(bookDir));
    await patchStateCover(bookDir, candidate);

    res.json({ coverImageUrl: `/api/books/${state.bookId}/cover` });
  } catch (e) {
    if (e instanceof CoverSourceError || e instanceof CoverDownloadError) {
      console.warn('[cover] POST failed', e);
      return res.status(502).json({ error: e.message, kind: e.kind });
    }
    console.error('[cover] POST failed', e);
    res.status(500).json({ error: (e as Error).message || 'Cover save failed.' });
  }
});
```

Add `CoverSourceError` to the imports (from `../cover/sources/types.js`):

```ts
import { CoverSourceError } from '../cover/sources/types.js';
```

(The other handlers — GET bytes, DELETE, upload, framing — are unchanged except `clearStateCover` now comes from `store.js`, already handled by the import block above.)

- [ ] **Step 2: Update the route test** (`server/src/routes/cover.test.ts`)

Update the three affected cases. Replace the candidates happy-path assertions (lines ~100-121) to expect the free-text `q=` query and composite ids:

```ts
  it('GET /candidates aggregates sources and returns composite-id candidates', async () => {
    // Only OpenLibrary returns docs here; apple + google resolve empty.
    fetchMock.mockImplementation((url: string) => {
      if (url.includes('openlibrary.org')) {
        return Promise.resolve(jsonResponse({ docs: [{ cover_i: 111 }, { cover_i: 222 }] }));
      }
      if (url.includes('itunes.apple.com')) return Promise.resolve(jsonResponse({ results: [] }));
      return Promise.resolve(jsonResponse({ items: [] })); // google
    });

    const res = await request(app).get(`/api/books/${bookId}/cover/candidates`);
    expect(res.status).toBe(200);
    expect(res.body.candidates).toHaveLength(2);
    expect(res.body.candidates[0].id).toBe('openlibrary:111');
    expect(res.body.candidates[0].source).toBe('openlibrary');
    expect(res.body.candidates[0].coverUrl).toContain('covers.openlibrary.org/b/id/111-L.jpg');

    const olCall = fetchMock.mock.calls.find(([u]) => String(u).includes('openlibrary.org/search'));
    const parsed = new URL(olCall![0] as string);
    expect(parsed.searchParams.get('q')).toBe(`${TITLE} ${AUTHOR}`);
    expect(parsed.searchParams.get('title')).toBeNull();
  });
```

Update the POST happy-path (lines ~123-145): the body field is `candidateId`, and the re-locate search only hits OpenLibrary (single-source `findCandidateById`):

```ts
  it('POST downloads the picked candidate, writes cover.jpg, patches state.json, returns the public URL', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ docs: [{ cover_i: 555 }] })) // re-locate (openlibrary only)
      .mockResolvedValueOnce(imageResponse(SAMPLE_JPEG)); // download

    const res = await request(app)
      .post(`/api/books/${bookId}/cover`)
      .set('Content-Type', 'application/json')
      .send({ candidateId: 'openlibrary:555' });
    expect(res.status).toBe(200);
    expect(res.body.coverImageUrl).toBe(`/api/books/${bookId}/cover`);

    const onDisk = join(bookDir, '.audiobook', 'cover.jpg');
    expect(existsSync(onDisk)).toBe(true);
    expect(Array.from(readFileSync(onDisk))).toEqual(Array.from(SAMPLE_JPEG));

    const state = JSON.parse(readFileSync(join(bookDir, '.audiobook', 'state.json'), 'utf8'));
    expect(state.coverImage.candidateId).toBe('openlibrary:555');
    expect(state.coverImage.source).toBe('openlibrary');
    expect(state.coverImage.originalUrl).toBe('https://covers.openlibrary.org/b/id/555-L.jpg');
  });
```

Update the error-path cases (lines ~174-199): `openLibraryId` → `candidateId`; the missing-field 400, the candidate-404 (search returns a different cover_i), and the 502 (re-locate search throws):

```ts
  it('POST 400s when candidateId is missing', async () => {
    const res = await request(app)
      .post(`/api/books/${bookId}/cover`)
      .set('Content-Type', 'application/json')
      .send({});
    expect(res.status).toBe(400);
  });

  it('POST 404s when the candidate id is no longer in the live result set', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ docs: [{ cover_i: 999 }] }));
    const res = await request(app)
      .post(`/api/books/${bookId}/cover`)
      .set('Content-Type', 'application/json')
      .send({ candidateId: 'openlibrary:doesnotexist' });
    expect(res.status).toBe(404);
  });

  it('POST 502s when the re-locate search throws CoverSourceError', async () => {
    fetchMock.mockResolvedValueOnce(new Response('boom', { status: 503 }));
    const res = await request(app)
      .post(`/api/books/${bookId}/cover`)
      .set('Content-Type', 'application/json')
      .send({ candidateId: 'openlibrary:111' });
    expect(res.status).toBe(502);
    expect(res.body.kind).toBe('http');
  });
```

In the "all four endpoints 404 for unknown bookId" case, change the POST body `{ openLibraryId: 'cover-i:1' }` → `{ candidateId: 'openlibrary:1' }`.

- [ ] **Step 3: Update `openapi.yaml`**

Replace the `CoverCandidate` schema (lines ~2729-2744):

```yaml
    CoverCandidate:
      type: object
      required: [id, source, coverUrl]
      properties:
        id:
          type: string
          description: |
            Composite, source-agnostic identifier carried back to
            POST /api/books/{bookId}/cover as `candidateId`
            (`<source>:<localId>`, e.g. `openlibrary:48006`, `apple:123`,
            `google:vol_AbC`).
        source:
          type: string
          enum: [openlibrary, apple, google]
          description: Which catalogue this candidate came from. Drives the picker source badge.
        coverUrl:
          type: string
          format: uri
          description: Direct cover image URL for this source.
        edition:
          type: string
          description: 'Optional display string — `<publisher> · <year>` (best-effort).'
```

Update the POST `/api/books/{bookId}/cover` request body (lines ~817-823):

```yaml
            schema:
              type: object
              required: [candidateId]
              properties:
                candidateId:
                  type: string
                  description: 'Composite id from `CoverCandidate.id` (e.g. `openlibrary:48006`).'
```

Update the two cover endpoint descriptions/summaries (lines ~760-763 and ~806-808 and ~823, ~834) that say "OpenLibrary" to reflect multi-source: change the candidates `summary` to `List cover candidates (OpenLibrary + Apple Books + Google Books)` and the POST description's "Re-runs the OpenLibrary search" to "Re-runs the candidate's source search to re-locate it by `candidateId`". Change the `'400'` description to `Missing or malformed candidateId` and the candidates `'502'` description can be dropped (aggregate no longer 502s) — leave only `'404'` and `'200'` on the candidates endpoint.

- [ ] **Step 4: Regenerate API types + typecheck + run server tests**

Run: `npm run openapi:types && npm run typecheck`
Expected: `src/lib/api-types.ts` regenerates with the new `CoverCandidate` shape; typecheck PASSES (server `routes/cover.ts` resolved). `src/lib/types.ts:557` (`CoverCandidate = components['schemas']['CoverCandidate']`) picks up `id`/`source` automatically.

Run: `cd server && npx vitest run src/routes/cover.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/routes/cover.ts server/src/routes/cover.test.ts openapi.yaml src/lib/api-types.ts
git commit -m "feat(server): cover route serves aggregated candidates via candidateId"
```

---

## Task 8: Frontend API layer (mock + setCover rename)

**Files:**
- Modify: `src/lib/api.ts` (lines ~1807-1814 real, ~1886-1921 mock)

- [ ] **Step 1: Update `realSetCover` to send `candidateId`**

In `src/lib/api.ts`, change `realSetCover` (lines ~1807-1814):

```ts
async function realSetCover(
  bookId: string,
  candidateId: string,
): Promise<{ coverImageUrl: string }> {
  const res = await fetch(`/api/books/${encodeURIComponent(bookId)}/cover`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ candidateId }),
  });
  if (!res.ok)
    throw new Error(`Cover save failed (${res.status}): ${(await res.text()) || res.statusText}`);
  return res.json();
}
```

- [ ] **Step 2: Update the mock candidates to span all three sources**

Replace `MOCK_COVER_CANDIDATES` + `mockSetCover` (lines ~1886-1921). Update the doc comment above (line ~1882) from "OpenLibrary" to "the three sources":

```ts
const MOCK_COVER_CANDIDATES: CoverCandidate[] = [
  {
    id: 'openlibrary:8739161',
    source: 'openlibrary',
    coverUrl: 'https://covers.openlibrary.org/b/id/8739161-L.jpg',
    edition: 'Aladdin · 2012',
  },
  {
    id: 'apple:1444008227',
    source: 'apple',
    coverUrl: 'https://covers.openlibrary.org/b/id/13035811-L.jpg',
    edition: '2013',
  },
  {
    id: 'google:zNFuDwAAQBAJ',
    source: 'google',
    coverUrl: 'https://covers.openlibrary.org/b/id/14625765-L.jpg',
    edition: 'HarperCollins · 2014',
  },
  {
    id: 'openlibrary:11193889',
    source: 'openlibrary',
    coverUrl: 'https://covers.openlibrary.org/b/id/11193889-L.jpg',
    edition: 'Aladdin · 2015',
  },
];

async function mockFindCoverCandidates(_bookId: string): Promise<{ candidates: CoverCandidate[] }> {
  await wait(180);
  return { candidates: MOCK_COVER_CANDIDATES };
}

async function mockSetCover(
  _bookId: string,
  candidateId: string,
): Promise<{ coverImageUrl: string }> {
  await wait(80);
  const hit = MOCK_COVER_CANDIDATES.find((c) => c.id === candidateId);
  return { coverImageUrl: hit?.coverUrl ?? MOCK_COVER_CANDIDATES[0].coverUrl };
}
```

(The mock coverUrls intentionally reuse real OpenLibrary image URLs so the picker renders real thumbnails under `VITE_USE_MOCKS=true`; only the `id`/`source` differ to exercise badges.)

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: PASS (the `api` object's `setCover` type now takes `candidateId`; `cover-picker.tsx` still references `candidate.openLibraryId` and will be fixed in Task 9 — if typecheck flags `cover-picker.tsx` here, that's expected and resolved next).

- [ ] **Step 4: Commit**

```bash
git add src/lib/api.ts
git commit -m "feat(frontend): multi-source mock covers + candidateId in setCover"
```

---

## Task 9: Picker source badges + reworded copy

**Files:**
- Modify: `src/modals/cover-picker.tsx`
- Modify: `src/modals/cover-picker.test.tsx`

- [ ] **Step 1: Update the test first** (badges render; copy reworded; pick uses `id`)

In `src/modals/cover-picker.test.tsx`, replace `TWO_CANDIDATES` (lines ~42-45) and the affected assertions:

```ts
const TWO_CANDIDATES: CoverCandidate[] = [
  { id: 'openlibrary:11', source: 'openlibrary', coverUrl: 'https://covers/11-L.jpg', edition: 'Alpha · 2020' },
  { id: 'apple:22', source: 'apple', coverUrl: 'https://covers/22-L.jpg', edition: 'Beta · 2021' },
];
```

Update the testid-based lookups: `cover-candidate-cover-i:11` → `cover-candidate-openlibrary:11`, `cover-candidate-cover-i:22` → `cover-candidate-apple:22` (rendering-states + pick-flow describe blocks). Update the pick-flow assertion `setCover` arg:

```ts
    await waitFor(() => expect(setCover).toHaveBeenCalledWith('bk_test', 'apple:22'));
```

Update the empty-state assertion (line ~105-110) to the new copy and add a badge test in the "rendering states" block:

```ts
  it('renders the empty-state copy naming all three sources', async () => {
    findCoverCandidates.mockResolvedValue({ candidates: [] });
    renderPicker();
    await screen.findByText(/across openlibrary, apple books, and google books/i);
    expect(screen.queryByTestId('cover-grid')).not.toBeInTheDocument();
  });

  it('renders a source badge on each candidate', async () => {
    findCoverCandidates.mockResolvedValue({ candidates: TWO_CANDIDATES });
    renderPicker();
    await screen.findByTestId('cover-grid');
    expect(screen.getByTestId('cover-source-openlibrary:11')).toHaveTextContent(/openlibrary/i);
    expect(screen.getByTestId('cover-source-apple:22')).toHaveTextContent(/apple/i);
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/modals/cover-picker.test.tsx`
Expected: FAIL — `candidate.openLibraryId` no longer exists (testids are `undefined`), badge testids missing, empty-state copy mismatch.

- [ ] **Step 3: Update `cover-picker.tsx`**

Add a source-label map near the top of the file (after the constants, ~line 63):

```tsx
const SOURCE_LABEL: Record<CoverCandidate['source'], string> = {
  openlibrary: 'OpenLibrary',
  apple: 'Apple',
  google: 'Google',
};
```

In `pickFromSearch` (lines ~149-159), `submitting` keys off the candidate id — replace `candidate.openLibraryId` with `candidate.id`:

```tsx
  async function pickFromSearch(candidate: CoverCandidate) {
    setSubmitting(candidate.id);
    try {
      const { coverImageUrl } = await api.setCover(bookId, candidate.id);
      onPicked(coverImageUrl);
      onClose();
    } catch (e) {
      setSubmitting(null);
      setState({ kind: 'error', message: (e as Error).message || 'Failed to save cover.' });
    }
  }
```

In `SearchPanel`, update the empty-state copy (lines ~424-435):

```tsx
      {state.kind === 'ready' && state.candidates.length === 0 && (
        <p className="py-10 text-center text-sm text-ink/60">
          No covers found for <span className="font-semibold text-ink">{bookTitle}</span>
          {bookAuthor ? (
            <>
              {' '}
              by <span className="font-semibold text-ink">{bookAuthor}</span>
            </>
          ) : null}{' '}
          across OpenLibrary, Apple Books, and Google Books.
        </p>
      )}
```

Update the candidate grid cell (lines ~436-459): key/testid off `c.id`, add the source badge:

```tsx
      {state.kind === 'ready' && state.candidates.length > 0 && (
        <div data-testid="cover-grid" className="grid grid-cols-2 sm:grid-cols-3 gap-3">
          {state.candidates.map((c) => (
            <button
              key={c.id}
              data-testid={`cover-candidate-${c.id}`}
              onClick={() => onPick(c)}
              disabled={busy}
              className={`group relative rounded-2xl overflow-hidden border bg-canvas aspect-2/3 focus:outline-hidden transition-shadow ${submitting === c.id ? 'border-magenta ring-2 ring-magenta/30' : 'border-ink/10 hover:shadow-card hover:border-ink/20'} disabled:cursor-not-allowed disabled:opacity-50`}
            >
              <img
                src={c.coverUrl}
                alt={c.edition ? `${bookTitle} — ${c.edition}` : bookTitle}
                className="absolute inset-0 w-full h-full object-cover"
                loading="lazy"
              />
              <span
                data-testid={`cover-source-${c.id}`}
                className="absolute top-1.5 left-1.5 px-1.5 py-0.5 rounded-md bg-ink/70 text-white text-[9px] font-semibold uppercase tracking-wide"
              >
                {SOURCE_LABEL[c.source]}
              </span>
              {c.edition && (
                <span className="absolute bottom-0 inset-x-0 px-2 py-1 bg-ink/70 text-white text-[10px] leading-tight truncate">
                  {c.edition}
                </span>
              )}
            </button>
          ))}
        </div>
      )}
```

Update the footer attribution (lines ~320-334) for the search tab:

```tsx
              {tab === 'search' && (
                <>
                  Covers from{' '}
                  <a
                    className="underline"
                    href="https://openlibrary.org"
                    target="_blank"
                    rel="noreferrer"
                  >
                    OpenLibrary
                  </a>
                  , Apple Books &amp; Google Books. Click a cover to use it.
                </>
              )}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/modals/cover-picker.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/modals/cover-picker.tsx src/modals/cover-picker.test.tsx
git commit -m "feat(frontend): source-badged interleaved cover picker grid"
```

---

## Task 10: E2E + docs + full verify

**Files:**
- Create: `e2e/cover-picker.spec.ts`
- Modify: `docs/features/archive/36-book-covers.md` (note the multi-source extension) — OR a short new plan doc; see Step 3.

- [ ] **Step 1: Add an e2e spec (mock mode)**

First confirm how the picker is opened in mock mode (library card "..." menu). Mirror the existing pattern in `e2e/` — check `e2e/responsive/coverage.spec.ts` for the library navigation helper. Create:

```ts
// e2e/cover-picker.spec.ts
import { test, expect } from '@playwright/test';

/* Mock-mode smoke: the cover picker renders interleaved candidates from
   multiple sources, each carrying a source badge. Guards the multi-source
   aggregation UI (badges + grid) against router/redux/layout regressions. */

test('cover picker shows source-badged candidates from multiple sources', async ({ page }) => {
  await page.goto('/');
  // Open the first library card's overflow menu → "Find cover image".
  // (Selectors: align with the existing library-card menu pattern — the
  //  book-library view renders a per-card "..." button; the menu item text
  //  is "Find cover image" / "Change cover".)
  await page.getByTestId('book-card-menu').first().click();
  await page.getByRole('menuitem', { name: /cover image|change cover/i }).click();

  await expect(page.getByTestId('cover-grid')).toBeVisible();
  // Mock data spans openlibrary + apple + google — at least two distinct badges.
  await expect(page.getByText('OpenLibrary', { exact: false }).first()).toBeVisible();
  await expect(page.getByText('Apple', { exact: false }).first()).toBeVisible();
});
```

> If the exact card-menu selectors differ, adjust to the real testids found in `src/views/book-library.tsx` / `src/components/library/`. The assertion that matters: `cover-grid` visible + ≥2 source badges.

- [ ] **Step 2: Run the e2e spec**

Run: `npm run test:e2e -- cover-picker`
Expected: PASS (chromium, mock mode). Fix selectors against the real library-card menu if the open step fails.

- [ ] **Step 3: Document the change**

The original cover feature is archived at `docs/features/archive/36-book-covers.md`. Append a short "Multi-source extension (2026-06-10)" note there summarising: three sources, free-text queries, interleaved badged grid, priority-order auto-fetch, `candidateId` contract. Reference the spec `docs/superpowers/specs/2026-06-10-multi-source-cover-search-design.md`. (No new INDEX.md entry needed — it extends an archived plan.)

```bash
git add docs/features/archive/36-book-covers.md
git commit -m "docs(docs): note multi-source cover extension on plan 36"
```

- [ ] **Step 4: Full verify**

Run: `npm run verify`
Expected: typecheck + all tests + e2e + build PASS. Investigate and fix any failure before proceeding (do not `--no-verify`).

- [ ] **Step 5: Live acceptance** (real server, GPU box not required)

Start the app (`npm start`), open the library, and on a book whose OpenLibrary exact-title match previously failed (*Scepter of the Ancients* by Derek Landy), open the Cover Image picker → Search tab. Confirm:
- At least one real cover renders with a visible source badge.
- The empty state (if forced, e.g. a nonsense title) reads "across OpenLibrary, Apple Books, and Google Books."

- [ ] **Step 6: Final commit (if any live fixes)**

```bash
git add -A
git commit -m "fix(server): multi-source cover live-acceptance tweaks"
```

---

## Self-Review Notes

- **Spec coverage:** §Architecture (Tasks 1-6), per-source query/image handling (Tasks 2-4), data model/contract (Tasks 7-8), frontend badges/copy (Task 9), testing (every task + Task 10), acceptance (Task 10 Step 5). ✅
- **Deviation from spec, intentional:** `findCandidateById` queries **only the candidate's own source** (parsed from the composite id) rather than re-running the full aggregate — cheaper and isolates POST from unrelated-source outages, while preserving the no-SSRF property (URL still re-derived server-side, never client-supplied). Noted in the `search.ts` doc comment.
- **Type consistency:** `CoverCandidate` = `{ id, source, coverUrl, edition? }` everywhere (types.ts → openapi → api-types → picker). POST field is `candidateId` in route, openapi, `realSetCover`, and tests. `state.json.coverImage` uses `candidateId` + extended `source` union. `CoverSourceError` (adapters/`search.ts`) vs `CoverDownloadError` (`store.ts`) are distinct classes, both mapped to 502 in the POST handler.
- **No placeholders:** every code step contains full code; the only deliberately under-specified bit is the e2e card-menu selector (Task 10 Step 1), flagged explicitly with the real-file lookup instruction because the exact testid must be read from the current `book-library.tsx`.
