# fs-38 Free-Voice-Catalog Curation Pipeline — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the automated curation pipeline from `docs/superpowers/specs/2026-07-08-fs38-free-voice-catalog-design.md` §3 — a tool that crawls LibriVox for candidate readers/books, classifies each reader's gender/age-range (local acoustic heuristic always, Gemini multimodal upgrade when configured), and writes a confidence-tagged catalog data file. No manual per-entry tagging.

**Architecture:** Two-stage pipeline as plain, independently-testable functions under `server/src/voice-catalog/`, driven by a thin CLI entry point (`server/scripts/voice-catalog-build.ts`, run via `npx tsx`). Stage 1 (discovery) is a pure HTTP-paginating crawler with no LLM involvement. Stage 2 (classification) fetches one representative audio clip per candidate reader, runs a deterministic pitch-based classifier unconditionally, and upgrades the result via Gemini's multimodal audio input when `GEMINI_API_KEY` is configured. All network-touching functions take an injectable fetch/client so unit tests stay hermetic — no live network calls in the test suite.

**Tech Stack:** TypeScript (server workspace conventions), Vitest (`npm run test:server`), Node's built-in `fetch`, `@google/genai` (already a `server/` dependency), ffmpeg via `child_process.spawn` (existing pattern in `server/src/tts/loudnorm.ts`).

## Global Constraints

- This plan covers **only** spec §3 (the curation pipeline). Spec §4 (wizard integration) and §5 (wiki page) are explicitly **out of scope** here — §4 depends on fs-38 Wave 1-3 infrastructure (the `voice-library` routes, `sourceAttestation` schema, the clone wizard) that has not been implemented yet, and §5's phasing was decided to ship together with Wave 3, not standalone. Both get absorbed into the actual Wave 3 plan later, per the spec's own §6.
- All new files live under `server/` (TypeScript, `server/package.json` deps) — **not** root `scripts/` (plain `.mjs`, root deps) — because `@google/genai` is only a `server/` dependency (confirmed: absent from root `package.json`/`node_modules`).
- No live network calls in any automated test. Every function that hits LibriVox, archive.org, or Gemini takes its client/fetch implementation as a parameter with a real default, so tests inject a fake.
- LibriVox's audiobooks feed has **no server-side language filter** (confirmed by reading the actual API source `LibriVox/librivox-public`'s `Librivox_API.php`: only `id`/`title`/`author`/`genre`/`offset`/`limit`/`since`/`extended`/`fields` are recognized) — language filtering happens **client-side** against each record's `language` field, which the source confirms is always present.
- The book→reader link is **forwards-only**: `?id=<bookId>&extended=1` returns `sections[].readers[].{reader_id, display_name}` for a *known* book; there is no reverse "books by reader" query (confirmed via source). Discovery therefore accumulates `{readerId, bookIds}` pairs by crawling every book and reading its readers, not by querying per reader.
- Archive.org's identifier for a LibriVox book comes from the feed's `url_iarchive` field (confirmed present in the extended API response, e.g. `https://raw.githubusercontent.com/LibriVox/librivox-catalog/master/application/libraries/Librivox_API.php`: `$project['url_iarchive'] = $row['url_iarchive'];`) — parse the archive.org identifier out of that URL rather than guessing one from the title.
- **One detail could not be verified during spec review and must be confirmed by whoever runs Task 1**: the exact top-level JSON key wrapping the array of book records in `https://librivox.org/api/feed/audiobooks/?format=json`. Every direct fetch attempt during review returned HTTP 403 (consistent with bot-blocking on the request signature, not confirmed evidence the API is down). Community documentation snippets consistently reference a `books` array key; Task 1 Step 1 has the implementer confirm this against a real response before trusting the parser.

---

## File Structure

```
server/src/voice-catalog/
  types.ts                 — shared types: DiscoveredBook, DiscoveredReader, CatalogEntry, Gender, AgeRange
  librivox-client.ts        — fetch + parse one page of LibriVox's audiobooks feed
  librivox-client.test.ts
  crawl-readers.ts          — Stage 1: paginate the full feed, filter by language, accumulate reader→books index
  crawl-readers.test.ts
  fetch-sample-clip.ts      — resolve a book's archive.org identifier → one representative audio file → decoded PCM
  fetch-sample-clip.test.ts
  classify-pitch.ts         — local F0/pitch estimator over PCM → {gender, ageRange: 'child'|'adult', confidence: 'coarse'}
  classify-pitch.test.ts
  classify-gemini.ts        — Gemini multimodal audio classification → {gender, ageRange, confidence: 'refined'}
  classify-gemini.test.ts
  build-catalog.ts          — Stage 2 orchestrator: discovery → fetch clip → classify (tiered) → tagged entries
  build-catalog.test.ts
server/scripts/
  voice-catalog-build.ts    — thin CLI entry point (reads env, calls build-catalog, writes output file)
server/data/voice-catalog/
  free-voice-catalog.json   — output artifact (generated by running the tool; not written by any test)
```

---

### Task 1: Types + LibriVox feed client

**Files:**
- Create: `server/src/voice-catalog/types.ts`
- Create: `server/src/voice-catalog/librivox-client.ts`
- Test: `server/src/voice-catalog/librivox-client.test.ts`

**Interfaces:**
- Produces: `type Gender = 'male' | 'female' | 'neutral'`, `type AgeRange = 'child' | 'teen' | 'adult' | 'elderly'` (these two reuse the exact string unions already defined for `characterHint` in `openapi.yaml` — do not rename), `interface DiscoveredBook { id: string; title: string; language: string; urlIarchive: string | null; readers: { readerId: string; displayName: string }[] }`, `function fetchAudiobooksPage(opts: { offset: number; limit: number; since?: number; fetchImpl?: typeof fetch }): Promise<unknown>`, `function parseAudiobooksPage(raw: unknown): DiscoveredBook[]`.

- [ ] **Step 1: Manually verify the live response shape before writing the parser**

  Run this from a normal terminal (not this tool — WebFetch was blocked with 403 on every attempt during spec review, consistent with bot-blocking rather than an outage, but unconfirmed either way):

  ```bash
  curl -s "https://librivox.org/api/feed/audiobooks/?format=json&limit=2&offset=0&extended=1" | head -c 2000
  ```

  Confirm: (a) the top-level key wrapping the array of book objects (community documentation consistently points to `books`; if it's different, update the `RESPONSE_KEY` constant in Step 3 below to match), (b) that each book object has `language`, `url_iarchive`, and (with `extended=1`) a `sections` array whose entries have a `readers` array of `{reader_id, display_name}`. If any of this differs from what Step 3's parser expects, adjust the parser to match the real shape — the field names below are sourced from reading the LibriVox API's actual PHP source, not guessed, but the wrapping envelope key was never confirmed live.

- [ ] **Step 2: Write the failing test**

  ```typescript
  // server/src/voice-catalog/librivox-client.test.ts
  import { describe, expect, it } from 'vitest';
  import { parseAudiobooksPage } from './librivox-client.js';

  const FIXTURE_PAGE = {
    books: [
      {
        id: '52',
        title: "Alice's Adventures in Wonderland",
        language: 'English',
        url_iarchive: 'https://archive.org/details/alice_in_wonderland_librivox',
        sections: [
          { readers: [{ reader_id: '1001', display_name: 'Kristen McQuillin' }] },
          { readers: [{ reader_id: '1001', display_name: 'Kristen McQuillin' }] },
        ],
      },
      {
        id: '99',
        title: 'A Book With No Archive Link Yet',
        language: 'Russian',
        url_iarchive: null,
        sections: [{ readers: [{ reader_id: '2002', display_name: 'Иван Иванов' }] }],
      },
    ],
  };

  describe('parseAudiobooksPage', () => {
    it('extracts book id, title, language, archive identifier, and deduped readers', () => {
      const books = parseAudiobooksPage(FIXTURE_PAGE);
      expect(books).toHaveLength(2);
      expect(books[0]).toEqual({
        id: '52',
        title: "Alice's Adventures in Wonderland",
        language: 'English',
        urlIarchive: 'https://archive.org/details/alice_in_wonderland_librivox',
        readers: [{ readerId: '1001', displayName: 'Kristen McQuillin' }],
      });
      expect(books[1].urlIarchive).toBeNull();
      expect(books[1].readers).toEqual([{ readerId: '2002', displayName: 'Иван Иванов' }]);
    });

    it('throws a clear error when the response has no books array', () => {
      expect(() => parseAudiobooksPage({ nope: [] })).toThrow(/books/i);
    });

    it('skips a section with no readers rather than throwing', () => {
      const page = { books: [{ id: '1', title: 'T', language: 'English', url_iarchive: null, sections: [{ readers: [] }] }] };
      expect(parseAudiobooksPage(page)[0].readers).toEqual([]);
    });
  });
  ```

- [ ] **Step 3: Run test to verify it fails**

  Run: `cd server && npx vitest run src/voice-catalog/librivox-client.test.ts`
  Expected: FAIL — `librivox-client.ts` does not exist yet.

- [ ] **Step 4: Write the implementation**

  ```typescript
  // server/src/voice-catalog/types.ts
  export type Gender = 'male' | 'female' | 'neutral';
  export type AgeRange = 'child' | 'teen' | 'adult' | 'elderly';

  export interface DiscoveredReader {
    readerId: string;
    displayName: string;
  }

  export interface DiscoveredBook {
    id: string;
    title: string;
    language: string;
    urlIarchive: string | null;
    readers: DiscoveredReader[];
  }

  export interface CatalogEntry {
    readerId: string;
    displayName: string;
    language: string;
    gender: Gender;
    ageRange: AgeRange;
    confidence: 'coarse' | 'refined';
    bookIds: string[];
  }
  ```

  ```typescript
  // server/src/voice-catalog/librivox-client.ts
  import type { DiscoveredBook } from './types.js';

  const FEED_BASE = 'https://librivox.org/api/feed/audiobooks/';

  /* Confirmed via LibriVox/librivox-public's Librivox_API.php: only id, title,
     author, genre, offset, limit, since, extended, fields are recognized —
     there is NO language query param. Callers must filter by the per-book
     `language` field client-side (crawl-readers.ts does this). */
  export interface FetchAudiobooksPageOptions {
    offset: number;
    limit: number;
    /** Unix seconds; only books catalogued since this time. Confirmed real
     *  param — used for incremental re-crawls in crawl-readers.ts. */
    since?: number;
    fetchImpl?: typeof fetch;
  }

  export async function fetchAudiobooksPage(opts: FetchAudiobooksPageOptions): Promise<unknown> {
    const doFetch = opts.fetchImpl ?? fetch;
    const params = new URLSearchParams({
      format: 'json',
      extended: '1',
      offset: String(opts.offset),
      limit: String(opts.limit),
    });
    if (opts.since !== undefined) params.set('since', String(opts.since));
    const url = `${FEED_BASE}?${params.toString()}`;
    const res = await doFetch(url);
    if (!res.ok) {
      throw new Error(`LibriVox feed request failed: ${res.status} ${res.statusText} (${url})`);
    }
    return res.json();
  }

  /* Response envelope key per community-documented convention — confirmed
     against the API's actual field names (language, url_iarchive, sections[].
     readers[].{reader_id,display_name}) by reading the PHP source, but the
     wrapping key itself was never confirmed against a live response (every
     direct fetch during spec review 403'd). Adjust here if Task 1 Step 1's
     manual curl shows a different key. */
  const RESPONSE_KEY = 'books';

  export function parseAudiobooksPage(raw: unknown): DiscoveredBook[] {
    if (typeof raw !== 'object' || raw === null || !(RESPONSE_KEY in raw)) {
      throw new Error(
        `LibriVox feed response missing expected "${RESPONSE_KEY}" array — ` +
          `re-check the live response shape (Task 1 Step 1) and update RESPONSE_KEY.`,
      );
    }
    const rawBooks = (raw as Record<string, unknown>)[RESPONSE_KEY];
    if (!Array.isArray(rawBooks)) {
      throw new Error(`LibriVox feed "${RESPONSE_KEY}" field is not an array.`);
    }
    return rawBooks.map((b) => parseOneBook(b as Record<string, unknown>));
  }

  function parseOneBook(b: Record<string, unknown>): DiscoveredBook {
    const sections = Array.isArray(b.sections) ? (b.sections as Record<string, unknown>[]) : [];
    const readerMap = new Map<string, string>();
    for (const section of sections) {
      const readers = Array.isArray(section.readers)
        ? (section.readers as Record<string, unknown>[])
        : [];
      for (const r of readers) {
        const readerId = String(r.reader_id ?? '');
        const displayName = String(r.display_name ?? '');
        if (readerId) readerMap.set(readerId, displayName);
      }
    }
    return {
      id: String(b.id ?? ''),
      title: String(b.title ?? ''),
      language: String(b.language ?? ''),
      urlIarchive: typeof b.url_iarchive === 'string' && b.url_iarchive.length > 0 ? b.url_iarchive : null,
      readers: Array.from(readerMap, ([readerId, displayName]) => ({ readerId, displayName })),
    };
  }
  ```

- [ ] **Step 5: Run test to verify it passes**

  Run: `cd server && npx vitest run src/voice-catalog/librivox-client.test.ts`
  Expected: PASS (3 tests)

- [ ] **Step 6: Commit**

  ```bash
  git add server/src/voice-catalog/types.ts server/src/voice-catalog/librivox-client.ts server/src/voice-catalog/librivox-client.test.ts
  git commit -m "feat(server): fs-38 voice-catalog LibriVox feed client + types"
  ```

---

### Task 2: Reader/book discovery crawler (Stage 1)

**Files:**
- Create: `server/src/voice-catalog/crawl-readers.ts`
- Test: `server/src/voice-catalog/crawl-readers.test.ts`

**Interfaces:**
- Consumes: `fetchAudiobooksPage`, `parseAudiobooksPage`, `DiscoveredBook` from Task 1.
- Produces: `interface ReaderIndexEntry { readerId: string; displayName: string; language: string; bookIds: string[] }`, `function crawlReaders(opts: { targetLanguages: string[]; pageSize?: number; since?: number; fetchImpl?: typeof fetch; maxPages?: number }): Promise<ReaderIndexEntry[]>`.

- [ ] **Step 1: Write the failing test**

  ```typescript
  // server/src/voice-catalog/crawl-readers.test.ts
  import { describe, expect, it, vi } from 'vitest';
  import { crawlReaders } from './crawl-readers.js';

  function fakeResponse(books: unknown[]) {
    return { ok: true, status: 200, statusText: 'OK', json: async () => ({ books }) };
  }

  describe('crawlReaders', () => {
    it('pages until an empty page, filters by target language, and accumulates bookIds per reader', async () => {
      const page1 = fakeResponse([
        { id: '1', title: 'A', language: 'English', url_iarchive: null, sections: [{ readers: [{ reader_id: 'r1', display_name: 'Reader One' }] }] },
        { id: '2', title: 'B', language: 'Russian', url_iarchive: null, sections: [{ readers: [{ reader_id: 'r2', display_name: 'Reader Two' }] }] },
      ]);
      const page2 = fakeResponse([
        { id: '3', title: 'C', language: 'English', url_iarchive: null, sections: [{ readers: [{ reader_id: 'r1', display_name: 'Reader One' }] }] },
        { id: '4', title: 'D', language: 'French', url_iarchive: null, sections: [{ readers: [{ reader_id: 'r3', display_name: 'Reader Three' }] }] },
      ]);
      const page3 = fakeResponse([]);
      const fetchImpl = vi
        .fn()
        .mockResolvedValueOnce(page1)
        .mockResolvedValueOnce(page2)
        .mockResolvedValueOnce(page3);

      const index = await crawlReaders({
        targetLanguages: ['English', 'Russian'],
        pageSize: 2,
        fetchImpl: fetchImpl as unknown as typeof fetch,
      });

      expect(fetchImpl).toHaveBeenCalledTimes(3);
      expect(index).toEqual(
        expect.arrayContaining([
          { readerId: 'r1', displayName: 'Reader One', language: 'English', bookIds: ['1', '3'] },
          { readerId: 'r2', displayName: 'Reader Two', language: 'Russian', bookIds: ['2'] },
        ]),
      );
      // French reader excluded — not a target language.
      expect(index.find((r) => r.readerId === 'r3')).toBeUndefined();
    });

    it('stops early at maxPages even if more pages would follow', async () => {
      const page = fakeResponse([
        { id: '1', title: 'A', language: 'English', url_iarchive: null, sections: [{ readers: [{ reader_id: 'r1', display_name: 'R' }] }] },
      ]);
      const fetchImpl = vi.fn().mockResolvedValue(page);
      await crawlReaders({ targetLanguages: ['English'], pageSize: 1, maxPages: 2, fetchImpl: fetchImpl as unknown as typeof fetch });
      expect(fetchImpl).toHaveBeenCalledTimes(2);
    });
  });
  ```

- [ ] **Step 2: Run test to verify it fails**

  Run: `cd server && npx vitest run src/voice-catalog/crawl-readers.test.ts`
  Expected: FAIL — module doesn't exist.

- [ ] **Step 3: Write the implementation**

  ```typescript
  // server/src/voice-catalog/crawl-readers.ts
  import { fetchAudiobooksPage, parseAudiobooksPage } from './librivox-client.js';

  export interface ReaderIndexEntry {
    readerId: string;
    displayName: string;
    language: string;
    bookIds: string[];
  }

  export interface CrawlReadersOptions {
    targetLanguages: string[];
    pageSize?: number;
    since?: number;
    fetchImpl?: typeof fetch;
    /** Safety cap so a bug in the empty-page termination check can't loop
     *  forever against the live API. */
    maxPages?: number;
  }

  export async function crawlReaders(opts: CrawlReadersOptions): Promise<ReaderIndexEntry[]> {
    const pageSize = opts.pageSize ?? 50;
    const maxPages = opts.maxPages ?? 10_000;
    const targetSet = new Set(opts.targetLanguages);
    // readerId -> entry (bookIds accumulate as a Set to naturally dedupe
    // across pages before the final array conversion).
    const byReader = new Map<string, { displayName: string; language: string; bookIds: Set<string> }>();

    let offset = 0;
    for (let page = 0; page < maxPages; page += 1) {
      const raw = await fetchAudiobooksPage({
        offset,
        limit: pageSize,
        since: opts.since,
        fetchImpl: opts.fetchImpl,
      });
      const books = parseAudiobooksPage(raw);
      if (books.length === 0) break;

      for (const book of books) {
        if (!targetSet.has(book.language)) continue;
        for (const reader of book.readers) {
          const existing = byReader.get(reader.readerId);
          if (existing) {
            existing.bookIds.add(book.id);
          } else {
            byReader.set(reader.readerId, {
              displayName: reader.displayName,
              language: book.language,
              bookIds: new Set([book.id]),
            });
          }
        }
      }

      offset += pageSize;
    }

    return Array.from(byReader, ([readerId, entry]) => ({
      readerId,
      displayName: entry.displayName,
      language: entry.language,
      bookIds: Array.from(entry.bookIds),
    }));
  }
  ```

- [ ] **Step 4: Run test to verify it passes**

  Run: `cd server && npx vitest run src/voice-catalog/crawl-readers.test.ts`
  Expected: PASS (2 tests)

- [ ] **Step 5: Commit**

  ```bash
  git add server/src/voice-catalog/crawl-readers.ts server/src/voice-catalog/crawl-readers.test.ts
  git commit -m "feat(server): fs-38 voice-catalog reader discovery crawler"
  ```

---

### Task 3: Archive.org clip resolution + ffmpeg PCM decode

**Files:**
- Create: `server/src/voice-catalog/fetch-sample-clip.ts`
- Test: `server/src/voice-catalog/fetch-sample-clip.test.ts`

**Interfaces:**
- Produces: `function extractArchiveIdentifier(urlIarchive: string): string | null`, `function pickRepresentativeFile(files: { name: string; format?: string }[]): string | null`, `async function fetchSampleClipPcm(opts: { urlIarchive: string; fetchImpl?: typeof fetch; spawnImpl?: typeof spawn; sampleRate?: number }): Promise<Int16Array>`.

- [ ] **Step 1: Write the failing test**

  ```typescript
  // server/src/voice-catalog/fetch-sample-clip.test.ts
  import { describe, expect, it, vi } from 'vitest';
  import { EventEmitter } from 'node:events';
  import { extractArchiveIdentifier, pickRepresentativeFile, fetchSampleClipPcm } from './fetch-sample-clip.js';

  describe('extractArchiveIdentifier', () => {
    it('parses the identifier out of an archive.org details URL', () => {
      expect(extractArchiveIdentifier('https://archive.org/details/alice_in_wonderland_librivox')).toBe(
        'alice_in_wonderland_librivox',
      );
    });
    it('returns null for a non-archive.org URL', () => {
      expect(extractArchiveIdentifier('https://example.com/whatever')).toBeNull();
    });
  });

  describe('pickRepresentativeFile', () => {
    it('prefers the first original 128kbps mp3 over derivative/ogg files', () => {
      const files = [
        { name: 'wonderland_ch_01_64kb.mp3', format: '64Kbps MP3' },
        { name: 'wonderland_ch_01.ogg', format: 'Ogg Vorbis' },
        { name: 'wonderland_ch_01.mp3', format: '128Kbps MP3' },
      ];
      expect(pickRepresentativeFile(files)).toBe('wonderland_ch_01.mp3');
    });
    it('falls back to any .mp3 if no 128Kbps entry is tagged', () => {
      const files = [{ name: 'ch01.ogg', format: 'Ogg Vorbis' }, { name: 'ch01.mp3', format: 'MP3' }];
      expect(pickRepresentativeFile(files)).toBe('ch01.mp3');
    });
    it('returns null when no mp3 file exists', () => {
      expect(pickRepresentativeFile([{ name: 'ch01.ogg', format: 'Ogg Vorbis' }])).toBeNull();
    });
  });

  describe('fetchSampleClipPcm', () => {
    it('resolves metadata, downloads the picked file, decodes via ffmpeg, and returns PCM samples', async () => {
      const metadataResponse = {
        ok: true,
        json: async () => ({ files: [{ name: 'ch01.mp3', format: '128Kbps MP3' }] }),
      };
      const mp3Bytes = new Uint8Array([1, 2, 3, 4]);
      const audioResponse = { ok: true, arrayBuffer: async () => mp3Bytes.buffer };
      const fetchImpl = vi
        .fn()
        .mockResolvedValueOnce(metadataResponse)
        .mockResolvedValueOnce(audioResponse);

      const fakeChild = new EventEmitter() as unknown as import('node:child_process').ChildProcessWithoutNullStreams;
      // @ts-expect-error test double
      fakeChild.stdin = { end: vi.fn(), on: vi.fn() };
      const stdoutChunks: Buffer[] = [Buffer.from(new Int16Array([100, -100, 200]).buffer)];
      // @ts-expect-error test double
      fakeChild.stdout = { on: (event: string, cb: (c: Buffer) => void) => { if (event === 'data') stdoutChunks.forEach(cb); } };
      // @ts-expect-error test double
      fakeChild.stderr = { on: vi.fn() };
      const spawnImpl = vi.fn().mockImplementation(() => {
        queueMicrotask(() => fakeChild.emit('close', 0));
        return fakeChild;
      });

      const pcm = await fetchSampleClipPcm({
        urlIarchive: 'https://archive.org/details/alice_in_wonderland_librivox',
        fetchImpl: fetchImpl as unknown as typeof fetch,
        spawnImpl: spawnImpl as unknown as typeof import('node:child_process').spawn,
      });

      expect(fetchImpl).toHaveBeenNthCalledWith(1, 'https://archive.org/metadata/alice_in_wonderland_librivox');
      expect(fetchImpl).toHaveBeenNthCalledWith(
        2,
        'https://archive.org/download/alice_in_wonderland_librivox/ch01.mp3',
      );
      expect(Array.from(pcm)).toEqual([100, -100, 200]);
    });

    it('throws when the book has no archive.org link', async () => {
      await expect(fetchSampleClipPcm({ urlIarchive: '' })).rejects.toThrow(/archive/i);
    });
  });
  ```

- [ ] **Step 2: Run test to verify it fails**

  Run: `cd server && npx vitest run src/voice-catalog/fetch-sample-clip.test.ts`
  Expected: FAIL — module doesn't exist.

- [ ] **Step 3: Write the implementation**

  ```typescript
  // server/src/voice-catalog/fetch-sample-clip.ts
  import { spawn as nodeSpawn } from 'node:child_process';

  export function extractArchiveIdentifier(urlIarchive: string): string | null {
    const m = urlIarchive.match(/archive\.org\/details\/([^/?#]+)/);
    return m ? m[1] : null;
  }

  interface ArchiveFile {
    name: string;
    format?: string;
  }

  /* Prefers an original 128Kbps MP3 (the LibriVox-standard master bitrate)
     over 64Kbps derivatives or Ogg — a clean, single-format choice keeps the
     pitch estimator (Task 4) working from consistent input. Falls back to
     any .mp3 if no 128Kbps entry is explicitly tagged (some older items omit
     the format string). */
  export function pickRepresentativeFile(files: ArchiveFile[]): string | null {
    const byBestFormat = files.find((f) => f.format?.toLowerCase().includes('128kbps mp3'));
    if (byBestFormat) return byBestFormat.name;
    const anyMp3 = files.find((f) => f.name.toLowerCase().endsWith('.mp3'));
    return anyMp3 ? anyMp3.name : null;
  }

  export interface FetchSampleClipOptions {
    urlIarchive: string;
    fetchImpl?: typeof fetch;
    spawnImpl?: typeof nodeSpawn;
    /** PCM output sample rate for the decode step. 16 kHz matches the pitch
     *  estimator's expected human-voice-range Nyquist headroom (Task 4). */
    sampleRate?: number;
  }

  export async function fetchSampleClipPcm(opts: FetchSampleClipOptions): Promise<Int16Array> {
    const identifier = opts.urlIarchive ? extractArchiveIdentifier(opts.urlIarchive) : null;
    if (!identifier) {
      throw new Error(`fetchSampleClipPcm: no usable archive.org identifier in "${opts.urlIarchive}"`);
    }
    const doFetch = opts.fetchImpl ?? fetch;
    const doSpawn = opts.spawnImpl ?? nodeSpawn;
    const sampleRate = opts.sampleRate ?? 16_000;

    const metaRes = await doFetch(`https://archive.org/metadata/${identifier}`);
    if (!metaRes.ok) throw new Error(`archive.org metadata request failed for "${identifier}"`);
    const meta = (await metaRes.json()) as { files?: ArchiveFile[] };
    const fileName = pickRepresentativeFile(meta.files ?? []);
    if (!fileName) throw new Error(`No mp3 file found in archive.org item "${identifier}"`);

    const audioRes = await doFetch(`https://archive.org/download/${identifier}/${fileName}`);
    if (!audioRes.ok) throw new Error(`archive.org download failed for "${identifier}/${fileName}"`);
    const mp3Bytes = Buffer.from(await audioRes.arrayBuffer());

    return decodeMp3ToPcm(mp3Bytes, sampleRate, doSpawn);
  }

  /* Same spawn/pipe/windowsHide convention as runLoudnormFirstPass
     (server/src/tts/loudnorm.ts) — ffmpeg auto-detects the compressed input
     format and decodes to raw mono 16-bit PCM on stdout. */
  function decodeMp3ToPcm(mp3: Buffer, sampleRate: number, spawnImpl: typeof nodeSpawn): Promise<Int16Array> {
    const args = ['-hide_banner', '-loglevel', 'error', '-i', 'pipe:0', '-f', 's16le', '-ar', String(sampleRate), '-ac', '1', 'pipe:1'];
    return new Promise((resolve, reject) => {
      const child = spawnImpl('ffmpeg', args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];

      child.stdout.on('data', (chunk: Buffer) => stdoutChunks.push(chunk));
      child.stderr.on('data', (chunk: Buffer) => stderrChunks.push(chunk));
      child.on('error', (err) => {
        reject(new Error(`Failed to spawn ffmpeg: ${err.message}. Install ffmpeg and ensure it is on PATH.`));
      });
      child.on('close', (code) => {
        if (code !== 0) {
          reject(new Error(`ffmpeg decode exited with code ${code}: ${Buffer.concat(stderrChunks).toString('utf8')}`));
          return;
        }
        const pcmBuffer = Buffer.concat(stdoutChunks);
        resolve(new Int16Array(pcmBuffer.buffer, pcmBuffer.byteOffset, pcmBuffer.length / 2));
      });
      child.stdin.on('error', (err: NodeJS.ErrnoException) => {
        if (err.code !== 'EPIPE') reject(err);
      });
      child.stdin.end(mp3);
    });
  }
  ```

- [ ] **Step 4: Run test to verify it passes**

  Run: `cd server && npx vitest run src/voice-catalog/fetch-sample-clip.test.ts`
  Expected: PASS (6 tests)

- [ ] **Step 5: Commit**

  ```bash
  git add server/src/voice-catalog/fetch-sample-clip.ts server/src/voice-catalog/fetch-sample-clip.test.ts
  git commit -m "feat(server): fs-38 voice-catalog archive.org clip fetch + ffmpeg decode"
  ```

---

### Task 4: Local pitch/F0 classifier

**Files:**
- Create: `server/src/voice-catalog/classify-pitch.ts`
- Test: `server/src/voice-catalog/classify-pitch.test.ts`

**Interfaces:**
- Consumes: `Gender`, `AgeRange` from Task 1's `types.ts`.
- Produces: `interface PitchClassification { gender: Gender; ageRange: AgeRange; confidence: 'coarse'; averageHz: number }`, `function classifyByPitch(pcm: Int16Array, sampleRate: number): PitchClassification`.

- [ ] **Step 1: Write the failing test**

  Synthetic sine waves at known frequencies stand in for real speech — this keeps the test deterministic and fast, and pins the classifier's frequency-band boundaries precisely.

  ```typescript
  // server/src/voice-catalog/classify-pitch.test.ts
  import { describe, expect, it } from 'vitest';
  import { classifyByPitch } from './classify-pitch.js';

  const SAMPLE_RATE = 16_000;

  function sineWave(hz: number, seconds: number): Int16Array {
    const n = Math.floor(SAMPLE_RATE * seconds);
    const samples = new Int16Array(n);
    for (let i = 0; i < n; i += 1) {
      samples[i] = Math.round(Math.sin((2 * Math.PI * hz * i) / SAMPLE_RATE) * 20_000);
    }
    return samples;
  }

  describe('classifyByPitch', () => {
    it('classifies a low ~120Hz tone as male/adult', () => {
      const result = classifyByPitch(sineWave(120, 1.5), SAMPLE_RATE);
      expect(result.gender).toBe('male');
      expect(result.ageRange).toBe('adult');
      expect(result.confidence).toBe('coarse');
      expect(result.averageHz).toBeGreaterThan(100);
      expect(result.averageHz).toBeLessThan(140);
    });

    it('classifies a ~200Hz tone as female/adult', () => {
      const result = classifyByPitch(sineWave(200, 1.5), SAMPLE_RATE);
      expect(result.gender).toBe('female');
      expect(result.ageRange).toBe('adult');
    });

    it('classifies a notably elevated ~300Hz tone as child, gender neutral', () => {
      const result = classifyByPitch(sineWave(300, 1.5), SAMPLE_RATE);
      expect(result.ageRange).toBe('child');
      expect(result.gender).toBe('neutral');
    });

    it('throws on a silent (all-zero) clip rather than returning a bogus classification', () => {
      expect(() => classifyByPitch(new Int16Array(SAMPLE_RATE), SAMPLE_RATE)).toThrow(/voiced/i);
    });
  });
  ```

- [ ] **Step 2: Run test to verify it fails**

  Run: `cd server && npx vitest run src/voice-catalog/classify-pitch.test.ts`
  Expected: FAIL — module doesn't exist.

- [ ] **Step 3: Write the implementation**

  ```typescript
  // server/src/voice-catalog/classify-pitch.ts
  import type { AgeRange, Gender } from './types.js';

  export interface PitchClassification {
    gender: Gender;
    ageRange: AgeRange;
    confidence: 'coarse';
    averageHz: number;
  }

  /* Frame-by-frame autocorrelation F0 estimate. Human voice F0 lies roughly
     60-500Hz; we search lags corresponding to that band and take the lag
     with the strongest normalised autocorrelation peak per frame, then
     average F0 across "voiced" frames (peak strength above a threshold —
     this is what lets a silent/noise clip fail loudly instead of returning
     a meaningless average). This is a coarse, deterministic proxy — good
     for gender (male/female F0 bands are well separated) and for spotting
     a notably child-like elevated pitch, but NOT capable of distinguishing
     teen/adult/elderly, which default to 'adult' here (spec §3: local tier
     is honestly coarse; Gemini's multimodal pass, Task 5, is the upgrade
     path for finer age-bracket precision). */
  const MIN_HZ = 60;
  const MAX_HZ = 500;
  const FRAME_MS = 40;
  const VOICING_THRESHOLD = 0.3;
  const CHILD_HZ_FLOOR = 260;
  const FEMALE_HZ_FLOOR = 165;

  export function classifyByPitch(pcm: Int16Array, sampleRate: number): PitchClassification {
    const frameSize = Math.floor((sampleRate * FRAME_MS) / 1000);
    const minLag = Math.floor(sampleRate / MAX_HZ);
    const maxLag = Math.floor(sampleRate / MIN_HZ);

    const voicedHz: number[] = [];
    for (let start = 0; start + frameSize <= pcm.length; start += frameSize) {
      const frame = pcm.subarray(start, start + frameSize);
      const { bestLag, strength } = autocorrelationPeak(frame, minLag, maxLag);
      if (strength >= VOICING_THRESHOLD && bestLag > 0) {
        voicedHz.push(sampleRate / bestLag);
      }
    }

    if (voicedHz.length === 0) {
      throw new Error('classifyByPitch: no voiced frames detected — clip may be silent or non-speech.');
    }

    const averageHz = voicedHz.reduce((a, b) => a + b, 0) / voicedHz.length;

    if (averageHz >= CHILD_HZ_FLOOR) {
      return { gender: 'neutral', ageRange: 'child', confidence: 'coarse', averageHz };
    }
    if (averageHz >= FEMALE_HZ_FLOOR) {
      return { gender: 'female', ageRange: 'adult', confidence: 'coarse', averageHz };
    }
    return { gender: 'male', ageRange: 'adult', confidence: 'coarse', averageHz };
  }

  function autocorrelationPeak(
    frame: Int16Array,
    minLag: number,
    maxLag: number,
  ): { bestLag: number; strength: number } {
    const floats = new Float64Array(frame.length);
    for (let i = 0; i < frame.length; i += 1) floats[i] = frame[i] / 32_768;

    const zeroLagEnergy = dot(floats, floats, 0);
    if (zeroLagEnergy === 0) return { bestLag: 0, strength: 0 };

    let bestLag = 0;
    let bestValue = 0;
    for (let lag = minLag; lag <= maxLag && lag < floats.length; lag += 1) {
      const value = dot(floats, floats, lag);
      if (value > bestValue) {
        bestValue = value;
        bestLag = lag;
      }
    }
    return { bestLag, strength: bestValue / zeroLagEnergy };
  }

  function dot(a: Float64Array, b: Float64Array, lag: number): number {
    let sum = 0;
    for (let i = 0; i + lag < a.length; i += 1) sum += a[i] * b[i + lag];
    return sum;
  }
  ```

- [ ] **Step 4: Run test to verify it passes**

  Run: `cd server && npx vitest run src/voice-catalog/classify-pitch.test.ts`
  Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

  ```bash
  git add server/src/voice-catalog/classify-pitch.ts server/src/voice-catalog/classify-pitch.test.ts
  git commit -m "feat(server): fs-38 voice-catalog local pitch/F0 classifier"
  ```

---

### Task 5: Gemini multimodal classifier (upgrade tier)

**Files:**
- Create: `server/src/voice-catalog/classify-gemini.ts`
- Test: `server/src/voice-catalog/classify-gemini.test.ts`

**Interfaces:**
- Consumes: `Gender`, `AgeRange` from `types.ts`.
- Produces: `interface GeminiClassification { gender: Gender; ageRange: AgeRange; confidence: 'refined' }`, `async function classifyByGemini(opts: { pcm: Int16Array; sampleRate: number; apiKey: string; modelId?: string; clientFactory?: (apiKey: string) => { models: { generateContent: (args: unknown) => Promise<unknown> } } }): Promise<GeminiClassification>`.

- [ ] **Step 1: Write the failing test**

  ```typescript
  // server/src/voice-catalog/classify-gemini.test.ts
  import { describe, expect, it, vi } from 'vitest';
  import { classifyByGemini } from './classify-gemini.js';

  function fakeClientFactory(responseText: string) {
    const generateContent = vi.fn().mockResolvedValue({
      candidates: [{ content: { parts: [{ text: responseText }] } }],
    });
    return { generateContent, factory: () => ({ models: { generateContent } }) };
  }

  describe('classifyByGemini', () => {
    it('sends the PCM as inline audio with a classification prompt and parses the JSON reply', async () => {
      const { generateContent, factory } = fakeClientFactory(
        '{"gender": "female", "ageRange": "elderly"}',
      );
      const pcm = new Int16Array([1, 2, 3]);

      const result = await classifyByGemini({ pcm, sampleRate: 16_000, apiKey: 'test-key', clientFactory: factory });

      expect(result).toEqual({ gender: 'female', ageRange: 'elderly', confidence: 'refined' });
      const call = generateContent.mock.calls[0][0];
      expect(call.contents[0].parts[0].inlineData.mimeType).toBe('audio/l16;rate=16000');
      expect(call.contents[0].parts[1].text).toMatch(/gender/i);
    });

    it('throws a clear error when Gemini returns text that is not valid classification JSON', async () => {
      const { factory } = fakeClientFactory('sorry, I cannot help with that');
      await expect(
        classifyByGemini({ pcm: new Int16Array([1]), sampleRate: 16_000, apiKey: 'k', clientFactory: factory }),
      ).rejects.toThrow(/parse/i);
    });

    it('throws when the parsed gender/ageRange values are outside the known enums', async () => {
      const { factory } = fakeClientFactory('{"gender": "robot", "ageRange": "adult"}');
      await expect(
        classifyByGemini({ pcm: new Int16Array([1]), sampleRate: 16_000, apiKey: 'k', clientFactory: factory }),
      ).rejects.toThrow(/gender/i);
    });
  });
  ```

- [ ] **Step 2: Run test to verify it fails**

  Run: `cd server && npx vitest run src/voice-catalog/classify-gemini.test.ts`
  Expected: FAIL — module doesn't exist.

- [ ] **Step 3: Write the implementation**

  ```typescript
  // server/src/voice-catalog/classify-gemini.ts
  import { GoogleGenAI } from '@google/genai';
  import type { AgeRange, Gender } from './types.js';

  export interface GeminiClassification {
    gender: Gender;
    ageRange: AgeRange;
    confidence: 'refined';
  }

  const VALID_GENDERS: Gender[] = ['male', 'female', 'neutral'];
  const VALID_AGE_RANGES: AgeRange[] = ['child', 'teen', 'adult', 'elderly'];

  const CLASSIFICATION_PROMPT =
    'Listen to this voice recording. Classify the speaker\'s apparent gender and age range. ' +
    'Respond with ONLY a JSON object, no other text, in exactly this shape: ' +
    '{"gender": "male" | "female" | "neutral", "ageRange": "child" | "teen" | "adult" | "elderly"}.';

  interface GenerateContentClient {
    models: { generateContent: (args: unknown) => Promise<unknown> };
  }

  export interface ClassifyByGeminiOptions {
    pcm: Int16Array;
    sampleRate: number;
    apiKey: string;
    modelId?: string;
    /** Injectable so tests never construct a real GoogleGenAI client. */
    clientFactory?: (apiKey: string) => GenerateContentClient;
  }

  export async function classifyByGemini(opts: ClassifyByGeminiOptions): Promise<GeminiClassification> {
    const client = (opts.clientFactory ?? ((apiKey: string) => new GoogleGenAI({ apiKey })))(opts.apiKey);
    const model = opts.modelId ?? 'gemini-3.1-flash';

    const pcmBuffer = Buffer.from(opts.pcm.buffer, opts.pcm.byteOffset, opts.pcm.byteLength);
    const response = (await client.models.generateContent({
      model,
      contents: [
        {
          role: 'user',
          parts: [
            { inlineData: { mimeType: `audio/l16;rate=${opts.sampleRate}`, data: pcmBuffer.toString('base64') } },
            { text: CLASSIFICATION_PROMPT },
          ],
        },
      ],
    })) as { candidates?: { content?: { parts?: { text?: string }[] } }[] };

    const text = response.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) throw new Error('classifyByGemini: response had no text part to parse.');

    let parsed: unknown;
    try {
      parsed = JSON.parse(text.trim());
    } catch {
      throw new Error(`classifyByGemini: could not parse response as JSON: ${text}`);
    }

    const { gender, ageRange } = parsed as { gender?: string; ageRange?: string };
    if (!VALID_GENDERS.includes(gender as Gender)) {
      throw new Error(`classifyByGemini: unrecognized gender "${gender}" in response: ${text}`);
    }
    if (!VALID_AGE_RANGES.includes(ageRange as AgeRange)) {
      throw new Error(`classifyByGemini: unrecognized ageRange "${ageRange}" in response: ${text}`);
    }

    return { gender: gender as Gender, ageRange: ageRange as AgeRange, confidence: 'refined' };
  }
  ```

- [ ] **Step 4: Run test to verify it passes**

  Run: `cd server && npx vitest run src/voice-catalog/classify-gemini.test.ts`
  Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

  ```bash
  git add server/src/voice-catalog/classify-gemini.ts server/src/voice-catalog/classify-gemini.test.ts
  git commit -m "feat(server): fs-38 voice-catalog Gemini multimodal classification upgrade"
  ```

---

### Task 6: Stage 2 orchestrator (build the tagged catalog)

**Files:**
- Create: `server/src/voice-catalog/build-catalog.ts`
- Test: `server/src/voice-catalog/build-catalog.test.ts`

**Interfaces:**
- Consumes: `ReaderIndexEntry` (Task 2), `fetchSampleClipPcm` (Task 3), `classifyByPitch` (Task 4), `classifyByGemini` (Task 5), `CatalogEntry` (Task 1's `types.ts`). Note `fetchSampleClipPcm` needs a `urlIarchive`, but `ReaderIndexEntry` only carries `bookIds` — the orchestrator needs each reader's first book's `urlIarchive`, so it takes a small lookup function rather than re-deriving it.
- Produces: `async function buildCatalog(opts: { readers: ReaderIndexEntry[]; resolveBookArchiveUrl: (bookId: string) => string | null; geminiApiKey?: string; fetchSampleClipPcmImpl?: typeof fetchSampleClipPcm; classifyByGeminiImpl?: typeof classifyByGemini }): Promise<CatalogEntry[]>`.

- [ ] **Step 1: Write the failing test**

  ```typescript
  // server/src/voice-catalog/build-catalog.test.ts
  import { describe, expect, it, vi } from 'vitest';
  import { buildCatalog } from './build-catalog.js';
  import type { ReaderIndexEntry } from './crawl-readers.js';

  vi.mock('./fetch-sample-clip.js', () => ({
    fetchSampleClipPcm: vi.fn().mockResolvedValue(new Int16Array([1, 2, 3])),
  }));
  vi.mock('./classify-pitch.js', () => ({
    classifyByPitch: vi.fn().mockReturnValue({ gender: 'male', ageRange: 'adult', confidence: 'coarse', averageHz: 110 }),
  }));

  const READERS: ReaderIndexEntry[] = [
    { readerId: 'r1', displayName: 'Reader One', language: 'English', bookIds: ['1', '2'] },
    { readerId: 'r2', displayName: 'Reader Two', language: 'Russian', bookIds: ['3'] },
  ];

  describe('buildCatalog', () => {
    it('classifies every reader via the local pitch tier when no Gemini key is configured', async () => {
      const entries = await buildCatalog({
        readers: READERS,
        resolveBookArchiveUrl: (bookId) => `https://archive.org/details/book-${bookId}`,
      });

      expect(entries).toHaveLength(2);
      expect(entries[0]).toEqual({
        readerId: 'r1',
        displayName: 'Reader One',
        language: 'English',
        gender: 'male',
        ageRange: 'adult',
        confidence: 'coarse',
        bookIds: ['1', '2'],
      });
    });

    it('upgrades to the Gemini classification when an API key is configured', async () => {
      const classifyByGeminiImpl = vi.fn().mockResolvedValue({ gender: 'female', ageRange: 'elderly', confidence: 'refined' });
      const entries = await buildCatalog({
        readers: [READERS[0]],
        resolveBookArchiveUrl: () => 'https://archive.org/details/whatever',
        geminiApiKey: 'test-key',
        classifyByGeminiImpl,
      });
      expect(classifyByGeminiImpl).toHaveBeenCalledOnce();
      expect(entries[0].gender).toBe('female');
      expect(entries[0].ageRange).toBe('elderly');
      expect(entries[0].confidence).toBe('refined');
    });

    it('falls back to the coarse pitch tier for a reader whose clip fetch fails, without aborting the whole run', async () => {
      const fetchSampleClipPcmImpl = vi
        .fn()
        .mockResolvedValueOnce(new Int16Array([1]))
        .mockRejectedValueOnce(new Error('archive.org unreachable'));
      const entries = await buildCatalog({
        readers: READERS,
        resolveBookArchiveUrl: (bookId) => `https://archive.org/details/book-${bookId}`,
        fetchSampleClipPcmImpl,
      });
      expect(entries).toHaveLength(1); // second reader dropped, not thrown
    });

    it('skips a reader with no resolvable archive URL for any of their books', async () => {
      const entries = await buildCatalog({
        readers: [READERS[0]],
        resolveBookArchiveUrl: () => null,
      });
      expect(entries).toHaveLength(0);
    });
  });
  ```

- [ ] **Step 2: Run test to verify it fails**

  Run: `cd server && npx vitest run src/voice-catalog/build-catalog.test.ts`
  Expected: FAIL — module doesn't exist.

- [ ] **Step 3: Write the implementation**

  ```typescript
  // server/src/voice-catalog/build-catalog.ts
  import type { ReaderIndexEntry } from './crawl-readers.js';
  import { fetchSampleClipPcm } from './fetch-sample-clip.js';
  import { classifyByPitch } from './classify-pitch.js';
  import { classifyByGemini } from './classify-gemini.js';
  import type { CatalogEntry } from './types.js';

  export interface BuildCatalogOptions {
    readers: ReaderIndexEntry[];
    /** Given a bookId, resolve its archive.org details URL — the caller
     *  looks this up from the DiscoveredBook records the crawl (Task 2)
     *  read, keyed by id. Returns null if unresolvable. */
    resolveBookArchiveUrl: (bookId: string) => string | null;
    geminiApiKey?: string;
    sampleRate?: number;
    fetchSampleClipPcmImpl?: typeof fetchSampleClipPcm;
    classifyByGeminiImpl?: typeof classifyByGemini;
  }

  export async function buildCatalog(opts: BuildCatalogOptions): Promise<CatalogEntry[]> {
    const sampleRate = opts.sampleRate ?? 16_000;
    const doFetchClip = opts.fetchSampleClipPcmImpl ?? fetchSampleClipPcm;
    const doClassifyGemini = opts.classifyByGeminiImpl ?? classifyByGemini;

    const entries: CatalogEntry[] = [];
    for (const reader of opts.readers) {
      const archiveUrl = reader.bookIds.map(opts.resolveBookArchiveUrl).find((u) => u !== null);
      if (!archiveUrl) continue; // no book with a resolvable archive.org link — nothing to sample

      let pcm: Int16Array;
      try {
        pcm = await doFetchClip({ urlIarchive: archiveUrl, sampleRate });
      } catch {
        continue; // one reader's clip failing shouldn't abort the whole crawl-classify run
      }

      const coarse = classifyByPitch(pcm, sampleRate);
      let gender = coarse.gender;
      let ageRange = coarse.ageRange;
      let confidence: 'coarse' | 'refined' = 'coarse';

      if (opts.geminiApiKey) {
        try {
          const refined = await doClassifyGemini({ pcm, sampleRate, apiKey: opts.geminiApiKey });
          gender = refined.gender;
          ageRange = refined.ageRange;
          confidence = 'refined';
        } catch {
          // Gemini upgrade is best-effort — the coarse pitch classification
          // already computed above stands if it fails.
        }
      }

      entries.push({
        readerId: reader.readerId,
        displayName: reader.displayName,
        language: reader.language,
        gender,
        ageRange,
        confidence,
        bookIds: reader.bookIds,
      });
    }

    return entries;
  }
  ```

- [ ] **Step 4: Run test to verify it passes**

  Run: `cd server && npx vitest run src/voice-catalog/build-catalog.test.ts`
  Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

  ```bash
  git add server/src/voice-catalog/build-catalog.ts server/src/voice-catalog/build-catalog.test.ts
  git commit -m "feat(server): fs-38 voice-catalog build-catalog Stage 2 orchestrator"
  ```

---

### Task 7: CLI entry point + npm script wiring

**Files:**
- Create: `server/scripts/voice-catalog-build.ts`
- Modify: `package.json` (root — add npm script)
- Modify: `.gitignore` (if `server/data/voice-catalog/` should be generated, not hand-edited — see step 3)

**Interfaces:**
- Consumes: `crawlReaders` (Task 2), `buildCatalog` (Task 1's `types.ts` + Task 6), `DiscoveredBook`/`fetchAudiobooksPage`/`parseAudiobooksPage` (Task 1) — the CLI needs `resolveBookArchiveUrl`, which means it must ALSO retain the full `DiscoveredBook` records from the crawl (not just the reader index) to look up each `bookId`'s `urlIarchive`.

This task's `crawlReaders` call signature from Task 2 only returns `ReaderIndexEntry[]`, which drops `urlIarchive`. Rather than changing Task 2's tested contract, the CLI does its own lightweight second pass: build a `bookId -> urlIarchive` map from the same crawl by calling `parseAudiobooksPage` results directly (the CLI is the one caller who needs both views of the same crawl data, so this composition lives here, not in the shared library functions).

- [ ] **Step 1: Write the CLI script**

  No test for this file — it is a thin composition root (reads env, calls already-tested library functions, writes a file); the same convention as `server/scripts/sync-env-example.ts`, which also has no dedicated test.

  ```typescript
  // server/scripts/voice-catalog-build.ts
  import { writeFile, mkdir } from 'node:fs/promises';
  import { dirname, join } from 'node:path';
  import { fetchAudiobooksPage, parseAudiobooksPage } from '../src/voice-catalog/librivox-client.js';
  import { crawlReaders } from '../src/voice-catalog/crawl-readers.js';
  import { buildCatalog } from '../src/voice-catalog/build-catalog.js';

  const TARGET_LANGUAGES = ['English', 'Spanish', 'French', 'German', 'Russian'];
  const OUTPUT_PATH = join(import.meta.dirname, '..', 'data', 'voice-catalog', 'free-voice-catalog.json');

  async function main() {
    console.log(`[voice-catalog] Crawling LibriVox for languages: ${TARGET_LANGUAGES.join(', ')}...`);

    // Two passes over the same pagination range: crawlReaders (Task 2) builds
    // the deduped reader->bookIds index; this second, cheap pass over the
    // same pages builds bookId->urlIarchive purely from already-parsed data
    // (no extra network calls — same fetchAudiobooksPage/parseAudiobooksPage
    // primitives, run once more since crawlReaders doesn't expose per-book
    // archive URLs as part of its tested contract).
    const bookArchiveUrls = new Map<string, string | null>();
    let offset = 0;
    const pageSize = 50;
    for (;;) {
      const raw = await fetchAudiobooksPage({ offset, limit: pageSize });
      const books = parseAudiobooksPage(raw);
      if (books.length === 0) break;
      for (const book of books) {
        if (TARGET_LANGUAGES.includes(book.language)) bookArchiveUrls.set(book.id, book.urlIarchive);
      }
      offset += pageSize;
    }

    const readers = await crawlReaders({ targetLanguages: TARGET_LANGUAGES, pageSize });
    console.log(`[voice-catalog] Discovered ${readers.length} candidate readers.`);

    const geminiApiKey = process.env.GEMINI_API_KEY;
    if (!geminiApiKey) {
      console.log('[voice-catalog] GEMINI_API_KEY not set — classifying with the local pitch tier only (coarse age precision).');
    }

    const catalog = await buildCatalog({
      readers,
      resolveBookArchiveUrl: (bookId) => bookArchiveUrls.get(bookId) ?? null,
      geminiApiKey,
    });
    console.log(`[voice-catalog] Classified ${catalog.length} readers (${catalog.filter((c) => c.confidence === 'refined').length} refined via Gemini).`);

    await mkdir(dirname(OUTPUT_PATH), { recursive: true });
    await writeFile(OUTPUT_PATH, JSON.stringify(catalog, null, 2) + '\n', 'utf8');
    console.log(`[voice-catalog] Wrote ${OUTPUT_PATH}`);
  }

  main().catch((err) => {
    console.error('[voice-catalog] Failed:', err);
    process.exitCode = 1;
  });
  ```

- [ ] **Step 2: Wire the npm script**

  Add to root `package.json`'s `"scripts"` block (alongside the existing `config:sync`/`config:check` entries that use the same `npx tsx server/scripts/...` convention):

  ```json
  "voice-catalog:build": "npx tsx server/scripts/voice-catalog-build.ts",
  ```

- [ ] **Step 3: Decide whether the output file is committed or generated-only**

  `server/data/voice-catalog/free-voice-catalog.json` is a data artifact this tool produces — it should be committed once generated (Wave 3's future wizard reads it as a static shipped file, per the base spec's framing of this as a checked-in curated artifact, not a per-user runtime file). Create the directory now with a placeholder so the path exists in git history:

  ```bash
  mkdir -p server/data/voice-catalog
  ```

  ```json
  // server/data/voice-catalog/free-voice-catalog.json (placeholder until Step 4 is run for real)
  []
  ```

- [ ] **Step 4: Commit the tool**

  ```bash
  git add server/scripts/voice-catalog-build.ts package.json server/data/voice-catalog/free-voice-catalog.json
  git commit -m "feat(server): fs-38 voice-catalog build CLI + npm script wiring"
  ```

- [ ] **Step 5 (manual, not part of the automated task loop): run it for real**

  This requires live network access to LibriVox/archive.org and takes real wall-clock time (potentially long — the crawl pages through the full multi-hundred-thousand-record catalog once). Optionally set `GEMINI_API_KEY` first for refined classification:

  ```bash
  npm run voice-catalog:build
  ```

  Before trusting the result: confirm Task 1 Step 1's live-shape verification actually happened (the `RESPONSE_KEY` constant matches reality), and spot-check a handful of entries in the output file against LibriVox's own site (does "Reader One" really sound like what got tagged?) — this is the "optional spot-check" QA the spec (§3) describes, not a blocking gate.

---

## Self-Review

**1. Spec coverage:** §3's two-stage pipeline (deterministic discovery, no LLM; tiered classification, local-always + Gemini-upgrade) is fully covered by Tasks 1-6, with Task 7 as the composition root. §3's "confidence tagging" (`'coarse'` vs `'refined'`) is threaded through `CatalogEntry` and both classifiers. §3's "Wave 3 owns the exact endpoint/caching contract" is respected — this plan stops at producing the data file; no wizard-facing endpoint is built here. §4 (wizard) and §5 (wiki) are explicitly out of scope per the Global Constraints section, consistent with spec §6's phasing. §2's rejected-sources rationale and §7's out-of-scope list require no code.

**2. Placeholder scan:** No TBD/TODO markers. Task 1's "detail that couldn't be verified" is handled as a concrete manual verification step with a real command and a named constant to adjust, not a vague placeholder. Task 7 Step 5 is explicitly marked as manual/outside the TDD loop rather than pretending an automated step ran against live data.

**3. Type consistency:** `Gender`/`AgeRange` defined once in Task 1's `types.ts`, imported (never redefined) by Tasks 4, 5, 6. `ReaderIndexEntry` defined in Task 2, consumed by Task 6 without renaming fields. `CatalogEntry` defined in Task 1, produced by Task 6, consumed by Task 7 — field names (`readerId`, `displayName`, `language`, `gender`, `ageRange`, `confidence`, `bookIds`) match exactly across all three. `fetchSampleClipPcm`'s options shape (`urlIarchive`, `fetchImpl`, `spawnImpl`, `sampleRate`) matches between Task 3's definition and Task 6's/Task 7's call sites.
