/* Cover byte download + state.json provenance patching. Source-agnostic:
   fetchCoverJpeg fetches any candidate URL (always re-derived server-side
   via findCandidateById — never a client-supplied URL, preserving the
   no-SSRF property), checks it against the size caps, and re-encodes it to a
   clean sharp-written JPEG (so every provider body — GIF, WebP, PNG, JPEG
   with trailing junk — lands as a decodable cover.jpg). It writes nothing:
   callers pass the bytes to writeCoverFile (atomic tmp + rename) from inside
   patchStateCover's state-json lock (#3700). backgroundFetchCover is the
   fire-and-forget import hook. */

import { mkdir, unlink, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { renameWithRetry } from '../workspace/atomic-rename.js';
import { withStateJsonLock } from '../workspace/file-lock.js';
import { readStateJsonWithRecovery, writeStateJsonAtomic } from '../workspace/state-migrate.js';
import { coverImagePath, stateJsonPath, WORKSPACE_ROOT } from '../workspace/paths.js';
import { assertContained } from '../util/safe-path.js';
import type { CoverCandidate } from './sources/types.js';
import { firstAvailableCover } from './search.js';
import { reencodeToJpeg } from './reencode.js';

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

/** Atomically write already-encoded cover JPEG bytes to `destPath`. The single
    cover-write chokepoint, so it owns the workspace-containment guard. */
export async function writeCoverFile(destPath: string, jpegBytes: Buffer): Promise<void> {
  assertContained(WORKSPACE_ROOT, destPath);
  await mkdir(dirname(destPath), { recursive: true });
  const tmp = `${destPath}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tmp, jpegBytes);
  try {
    await renameWithRetry(tmp, destPath);
  } catch (e) {
    await unlink(tmp).catch(() => {
      /* best-effort */
    });
    throw e;
  }
}

/** Fetch a candidate URL and return it as a clean JPEG - NO disk write, so a
    caller can defer the write until it has confirmed (under the state-json
    lock) that the book still exists. */
export async function fetchCoverJpeg(url: string): Promise<Buffer> {
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

  /* #3535 (operator decision, option a): normalise every provider body to a
     clean sharp-written JPEG before it lands as cover.jpg — a GIF/WebP stored
     verbatim fails the m4b export's content probing, and a JPEG with trailing
     bytes defeats it the same way. Tolerant: a provider JPEG that is merely
     damaged (e.g. missing its EOI) still decodes, so it is kept; a body
     sharp cannot decode at all is an invalid cover. */
  let reencoded: Buffer;
  try {
    reencoded = await reencodeToJpeg(buffer, { tolerant: true });
  } catch (e) {
    throw new CoverDownloadError('invalid', `Cover is not a decodable image: ${(e as Error).message}`);
  }

  return reencoded;
}

/** Record provenance of the just-downloaded cover onto state.json so a
    library scan surfaces `coverImageUrl`. */
export async function patchStateCover(
  bookDir: string,
  candidate: Pick<CoverCandidate, 'id' | 'source' | 'coverUrl'>,
  /** Runs inside the lock once state.json is confirmed present - the cover
      file write, so nothing lands in a book folder that moved or was deleted. */
  beforeWrite?: () => Promise<void>,
): Promise<boolean> {
  const path = stateJsonPath(bookDir);
  /* #3700 — read-modify-write under the per-book state-json lock. `false` =
     state.json absent (deleted/moved while queued): nothing was written. */
  return withStateJsonLock(path, async () => {
    const state = await readStateJsonWithRecovery(path);
    if (!state) return false;
    if (beforeWrite) await beforeWrite();
    state.coverImage = {
      source: candidate.source,
      candidateId: candidate.id,
      originalUrl: candidate.coverUrl,
      fetchedAt: new Date().toISOString(),
    };
    state.updatedAt = new Date().toISOString();
    await writeStateJsonAtomic(path, { ...state, language: state.language ?? null });
    return true;
  });
}

/** Inverse of patchStateCover — DELETE reverts to the procedural gradient.
    `beforeWrite` (the cover-file removal) runs inside the lock once state.json
    is confirmed present; `false` = absent, nothing was removed or written. */
export async function clearStateCover(
  bookDir: string,
  beforeWrite?: () => Promise<void>,
): Promise<boolean> {
  const path = stateJsonPath(bookDir);
  return withStateJsonLock(path, async () => {
    const state = await readStateJsonWithRecovery(path);
    if (!state) return false;
    if (beforeWrite) await beforeWrite();
    delete state.coverImage;
    state.updatedAt = new Date().toISOString();
    await writeStateJsonAtomic(path, { ...state, language: state.language ?? null });
    return true;
  });
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
    const jpeg = await fetchCoverJpeg(top.coverUrl);
    const dest = coverImagePath(bookDir);
    if (!(await patchStateCover(bookDir, top, () => writeCoverFile(dest, jpeg)))) return;
    console.log(`[cover] fetched ${top.id} (${top.source}) for ${bookId}`);
  } catch (e) {
    console.warn(`[cover] background fetch failed for ${bookId}: ${(e as Error).message}`);
  }
}
