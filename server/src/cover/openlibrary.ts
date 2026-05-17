/* OpenLibrary client used by the cover route + the import auto-fetch hook.
   Two surfaces:

   - searchCovers(title, author): up to 6 cover candidates from OpenLibrary
     Search, each carrying the cover image URL. Dedupes by cover_i.
   - downloadCover(url, destPath): fetches the image bytes, validates the
     response is actually an image and within size caps, writes atomically
     (tmp + rename) so a kill mid-write can't leave a half-cover on disk.
   - backgroundFetchCover(...): the fire-and-forget convenience the import
     route uses on first manuscript landing. Wraps the two above and
     patches state.json. Swallows all errors — OpenLibrary being slow or
     unreachable must never fail an import. */

import { mkdir, unlink, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { renameWithRetry } from '../workspace/atomic-rename.js';
import { readJson, writeJsonAtomic } from '../workspace/state-io.js';
import { stampStateSchema } from '../workspace/state-migrate.js';
import { coverImagePath, stateJsonPath } from '../workspace/paths.js';
import type { BookStateJson } from '../workspace/scan.js';

const SEARCH_TIMEOUT_MS = 6_000;
const DOWNLOAD_TIMEOUT_MS = 10_000;
const MAX_COVER_BYTES = 5 * 1024 * 1024;
const MAX_CANDIDATES = 6;

export interface CoverCandidate {
  /** Stable identifier for this cover. Format: `cover-i:<number>` — the
      OpenLibrary cover edition id. Round-trips through the POST body so
      the route can locate the same candidate on a second search. */
  openLibraryId: string;
  coverUrl: string;
  /** Best-effort display string: `<publisher> · <year>`. Optional —
      OpenLibrary's metadata is patchy. */
  edition?: string;
}

export type OpenLibraryErrorKind = 'timeout' | 'http' | 'invalid' | 'too_large';

export class OpenLibraryError extends Error {
  constructor(
    public kind: OpenLibraryErrorKind,
    message: string,
  ) {
    super(message);
    this.name = 'OpenLibraryError';
  }
}

interface SearchDoc {
  cover_i?: number;
  title?: string;
  publisher?: string[];
  publish_date?: string[];
  first_publish_year?: number;
}

export async function searchCovers(title: string, author: string): Promise<CoverCandidate[]> {
  const trimmedTitle = title.trim();
  const trimmedAuthor = author.trim();
  if (!trimmedTitle && !trimmedAuthor) return [];

  const params = new URLSearchParams();
  if (trimmedTitle) params.set('title', trimmedTitle);
  if (trimmedAuthor) params.set('author', trimmedAuthor);
  params.set('limit', '20');
  const url = `https://openlibrary.org/search.json?${params.toString()}`;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), SEARCH_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(url, {
      signal: ctrl.signal,
      headers: {
        Accept: 'application/json',
        'User-Agent':
          'audiobook-generator/1.0 (https://github.com/dudarenok-maker/audiobook-generator)',
      },
    });
  } catch (e) {
    if ((e as Error).name === 'AbortError') {
      throw new OpenLibraryError('timeout', 'OpenLibrary search timed out.');
    }
    throw new OpenLibraryError('http', `OpenLibrary search failed: ${(e as Error).message}`);
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    throw new OpenLibraryError('http', `OpenLibrary search returned HTTP ${res.status}.`);
  }

  let json: { docs?: SearchDoc[] };
  try {
    json = (await res.json()) as { docs?: SearchDoc[] };
  } catch {
    throw new OpenLibraryError('invalid', 'OpenLibrary search returned malformed JSON.');
  }

  const docs = Array.isArray(json.docs) ? json.docs : [];
  const seen = new Set<number>();
  const out: CoverCandidate[] = [];
  for (const d of docs) {
    if (typeof d.cover_i !== 'number' || !Number.isFinite(d.cover_i)) continue;
    if (seen.has(d.cover_i)) continue;
    seen.add(d.cover_i);
    out.push({
      openLibraryId: `cover-i:${d.cover_i}`,
      coverUrl: `https://covers.openlibrary.org/b/id/${d.cover_i}-L.jpg`,
      edition: formatEdition(d),
    });
    if (out.length >= MAX_CANDIDATES) break;
  }
  return out;
}

function formatEdition(d: SearchDoc): string | undefined {
  const publisher = d.publisher?.[0]?.trim();
  const year = d.first_publish_year ?? parsePubYear(d.publish_date?.[0]);
  const parts = [publisher, year ? String(year) : undefined].filter(Boolean) as string[];
  return parts.length > 0 ? parts.join(' · ') : undefined;
}

function parsePubYear(s: string | undefined): number | undefined {
  if (!s) return undefined;
  const m = s.match(/\d{4}/);
  return m ? Number(m[0]) : undefined;
}

export async function downloadCover(url: string, destPath: string): Promise<{ bytes: number }> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), DOWNLOAD_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(url, {
      signal: ctrl.signal,
      headers: {
        'User-Agent':
          'audiobook-generator/1.0 (https://github.com/dudarenok-maker/audiobook-generator)',
      },
    });
  } catch (e) {
    if ((e as Error).name === 'AbortError') {
      throw new OpenLibraryError('timeout', 'OpenLibrary download timed out.');
    }
    throw new OpenLibraryError('http', `OpenLibrary download failed: ${(e as Error).message}`);
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    throw new OpenLibraryError('http', `OpenLibrary download returned HTTP ${res.status}.`);
  }

  const ctype = res.headers.get('content-type') ?? '';
  if (!ctype.toLowerCase().startsWith('image/')) {
    throw new OpenLibraryError(
      'invalid',
      `Response is not an image (content-type: ${ctype || 'unknown'}).`,
    );
  }

  const buffer = Buffer.from(await res.arrayBuffer());
  if (buffer.length === 0) {
    throw new OpenLibraryError('invalid', 'Cover body is empty.');
  }
  if (buffer.length > MAX_COVER_BYTES) {
    throw new OpenLibraryError(
      'too_large',
      `Cover exceeds ${MAX_COVER_BYTES} bytes (got ${buffer.length}).`,
    );
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

/** Locate a candidate by its `openLibraryId` from the cached search
    results. Re-runs the search since OpenLibrary results are stable
    enough across seconds and we don't want to pay the cache complexity
    for a per-book one-shot pick. Returns null if the id isn't in the
    current result set — caller renders a 404 / "candidate expired". */
export async function findCandidateById(
  title: string,
  author: string,
  openLibraryId: string,
): Promise<CoverCandidate | null> {
  const candidates = await searchCovers(title, author);
  return candidates.find((c) => c.openLibraryId === openLibraryId) ?? null;
}

/** Fire-and-forget convenience for the import route. Picks the top
    candidate, downloads it, patches state.json with the metadata so
    subsequent library scans surface `coverImageUrl`. Logs and swallows
    every error — the import must never fail because OpenLibrary did. */
export async function backgroundFetchCover(
  bookDir: string,
  title: string,
  author: string,
  bookId: string,
): Promise<void> {
  try {
    const candidates = await searchCovers(title, author);
    if (candidates.length === 0) {
      console.log(`[cover] no OpenLibrary match for "${title}" by "${author}" (${bookId})`);
      return;
    }
    const top = candidates[0];
    await downloadCover(top.coverUrl, coverImagePath(bookDir));
    await patchStateCover(bookDir, top);
    console.log(`[cover] fetched ${top.openLibraryId} for ${bookId}`);
  } catch (e) {
    console.warn(`[cover] background fetch failed for ${bookId}: ${(e as Error).message}`);
  }
}

/** Mutate the `coverImage` field on a book's state.json. The cover
    bytes have already been written to disk by `downloadCover`; this
    just records the provenance so library-scan can surface a
    `coverImageUrl` and so the picker UI can flag the currently-selected
    candidate. */
export async function patchStateCover(
  bookDir: string,
  candidate: Pick<CoverCandidate, 'openLibraryId' | 'coverUrl'>,
): Promise<void> {
  const path = stateJsonPath(bookDir);
  const state = await readJson<BookStateJson>(path);
  if (!state) return;
  state.coverImage = {
    openLibraryId: candidate.openLibraryId,
    originalUrl: candidate.coverUrl,
    fetchedAt: new Date().toISOString(),
  };
  state.updatedAt = new Date().toISOString();
  await writeJsonAtomic(path, stampStateSchema(state));
}

/** Inverse of patchStateCover — used by DELETE to revert to the
    procedural gradient. */
export async function clearStateCover(bookDir: string): Promise<void> {
  const path = stateJsonPath(bookDir);
  const state = await readJson<BookStateJson>(path);
  if (!state) return;
  delete state.coverImage;
  state.updatedAt = new Date().toISOString();
  await writeJsonAtomic(path, stampStateSchema(state));
}
