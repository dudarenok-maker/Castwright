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
import { coverImagePath, stateJsonPath, WORKSPACE_ROOT } from '../workspace/paths.js';
import { assertContained } from '../util/safe-path.js';
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
  assertContained(WORKSPACE_ROOT, destPath);
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
