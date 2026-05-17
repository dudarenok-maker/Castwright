/* Local-disk cover upload pipeline (plan 40).

   - validateUpload(buffer, mimeType): throws UploadError on size/MIME.
   - writeUploadedCover(buffer, mimeType, destPath): transcodes PNG→JPEG
     via sharp (q=85), writes atomically (tmp + rename) — same pattern
     as `downloadCover` in openlibrary.ts.
   - patchStateLocalCover(bookDir, originalFilename): replaces
     state.json.coverImage with the `source: 'local'` shape, dropping
     any prior OpenLibrary fields. Resets framing — a fresh image
     deserves a fresh frame; the user reframes via the Frame tab.
   - patchStateFraming(bookDir, framing): persists pan + zoom onto the
     existing coverImage record. No-op when no cover is pinned. */

import { mkdir, unlink, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import sharp from 'sharp';
import { renameWithRetry } from '../workspace/atomic-rename.js';
import { readJson, writeJsonAtomic } from '../workspace/state-io.js';
import { stampStateSchema } from '../workspace/state-migrate.js';
import { stateJsonPath } from '../workspace/paths.js';
import type { BookStateJson } from '../workspace/scan.js';

export const ACCEPTED_MIME_TYPES = ['image/jpeg', 'image/png'] as const;
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
export const JPEG_QUALITY = 85;

export type UploadMimeType = (typeof ACCEPTED_MIME_TYPES)[number];

export type UploadErrorKind = 'oversize' | 'invalid_mime' | 'empty' | 'transcode_failed';

export class UploadError extends Error {
  constructor(public kind: UploadErrorKind, message: string) {
    super(message);
    this.name = 'UploadError';
  }
}

export interface CoverFraming {
  offsetX: number;
  offsetY: number;
  zoom: number;
}

export function validateUpload(buffer: Buffer | undefined, mimeType: string | undefined): asserts buffer is Buffer {
  if (!buffer || buffer.length === 0) {
    throw new UploadError('empty', 'Upload body is empty.');
  }
  if (buffer.length > MAX_UPLOAD_BYTES) {
    throw new UploadError('oversize', `Upload exceeds ${MAX_UPLOAD_BYTES} bytes (got ${buffer.length}).`);
  }
  if (!mimeType || !(ACCEPTED_MIME_TYPES as readonly string[]).includes(mimeType)) {
    throw new UploadError('invalid_mime', `Unsupported MIME type: ${mimeType ?? 'unknown'}`);
  }
}

export async function writeUploadedCover(
  buffer: Buffer,
  mimeType: UploadMimeType,
  destPath: string,
): Promise<{ bytes: number }> {
  let jpegBytes: Buffer;
  if (mimeType === 'image/png') {
    try {
      jpegBytes = await sharp(buffer).jpeg({ quality: JPEG_QUALITY }).toBuffer();
    } catch (e) {
      throw new UploadError('transcode_failed', `PNG → JPEG transcode failed: ${(e as Error).message}`);
    }
  } else {
    jpegBytes = buffer;
  }

  await mkdir(dirname(destPath), { recursive: true });
  const tmp = `${destPath}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tmp, jpegBytes);
  try {
    await renameWithRetry(tmp, destPath);
  } catch (e) {
    await unlink(tmp).catch(() => { /* best-effort */ });
    throw e;
  }
  return { bytes: jpegBytes.length };
}

export async function patchStateLocalCover(
  bookDir: string,
  originalFilename: string | null,
): Promise<void> {
  const path = stateJsonPath(bookDir);
  const state = await readJson<BookStateJson>(path);
  if (!state) return;
  state.coverImage = {
    source: 'local',
    originalFilename,
    uploadedAt: new Date().toISOString(),
  };
  state.updatedAt = new Date().toISOString();
  await writeJsonAtomic(path, stampStateSchema(state));
}

export function clampFraming(framing: CoverFraming): CoverFraming {
  return {
    offsetX: clamp(framing.offsetX, -100, 100),
    offsetY: clamp(framing.offsetY, -100, 100),
    zoom: clamp(framing.zoom, 1, 3),
  };
}

export async function patchStateFraming(
  bookDir: string,
  framing: CoverFraming,
): Promise<boolean> {
  const path = stateJsonPath(bookDir);
  const state = await readJson<BookStateJson>(path);
  if (!state) return false;
  if (!state.coverImage) return false;
  state.coverImage.framing = clampFraming(framing);
  state.updatedAt = new Date().toISOString();
  await writeJsonAtomic(path, stampStateSchema(state));
  return true;
}

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}
