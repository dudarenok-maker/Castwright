/* Local-disk cover upload pipeline (plan 40).

   - validateUpload(buffer, mimeType): throws UploadError on size/MIME unless
     the magic bytes are a PNG or JPEG; returns the sniffed type (the label
     only gates the allowlist, so a real JPEG named .png still uploads).
   - encodeUploadedCover(buffer, mimeType): re-encodes every upload (PNG and
     JPEG) to a clean sharp-written JPEG (q=85, EXIF orientation applied) so
     trailing bytes never survive into cover.jpg (#3535). It writes nothing:
     the route hands the bytes to `writeCoverFile` (store.ts, atomic tmp +
     rename) from inside the state-json lock, once state.json is confirmed
     present (#3700).
   - patchStateLocalCover(bookDir, originalFilename, beforeWrite?): replaces
     state.json.coverImage with the `source: 'local'` shape, dropping
     any prior OpenLibrary fields. Resets framing — a fresh image
     deserves a fresh frame; the user reframes via the Frame tab.
   - patchStateFraming(bookDir, framing): persists pan + zoom onto the
     existing coverImage record. No-op when no cover is pinned. */

import { readJson } from '../workspace/state-io.js';
import { withStateJsonLock } from '../workspace/file-lock.js';
import { writeStateJsonAtomic } from '../workspace/state-migrate.js';
import { stateJsonPath } from '../workspace/paths.js';
import type { BookStateJson } from '../workspace/scan.js';
import { reencodeToJpeg } from './reencode.js';

export const ACCEPTED_MIME_TYPES = ['image/jpeg', 'image/png'] as const;
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

export type UploadMimeType = (typeof ACCEPTED_MIME_TYPES)[number];

export type UploadErrorKind = 'oversize' | 'invalid_mime' | 'empty' | 'transcode_failed';

export class UploadError extends Error {
  constructor(
    public kind: UploadErrorKind,
    message: string,
  ) {
    super(message);
    this.name = 'UploadError';
  }
}

export interface CoverFraming {
  offsetX: number;
  offsetY: number;
  zoom: number;
}

export function validateUpload(
  buffer: Buffer | undefined,
  mimeType: string | undefined,
): UploadMimeType {
  if (!buffer || buffer.length === 0) {
    throw new UploadError('empty', 'Upload body is empty.');
  }
  if (buffer.length > MAX_UPLOAD_BYTES) {
    throw new UploadError(
      'oversize',
      `Upload exceeds ${MAX_UPLOAD_BYTES} bytes (got ${buffer.length}).`,
    );
  }
  if (!mimeType || !(ACCEPTED_MIME_TYPES as readonly string[]).includes(mimeType)) {
    throw new UploadError('invalid_mime', `Unsupported MIME type: ${mimeType ?? 'unknown'}`);
  }
  // The declared type is client-controlled (browsers take it from the file
  // extension) and sharp picks its loader from the bytes, so the bytes choose the
  // branch. A valid PNG/JPEG with the wrong label is still accepted (#3533).
  const sniffed = sniffMime(buffer);
  if (!sniffed) {
    throw new UploadError('invalid_mime', 'Upload is not a PNG or JPEG image.');
  }
  return sniffed;
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPEG_SIGNATURE = Buffer.from([0xff, 0xd8, 0xff]);

function sniffMime(buffer: Buffer): UploadMimeType | undefined {
  if (buffer.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) return 'image/png';
  if (buffer.subarray(0, JPEG_SIGNATURE.length).equals(JPEG_SIGNATURE)) return 'image/jpeg';
  return undefined;
}

/** Re-encode an upload to a clean JPEG with NO disk write, so the caller can
    defer the write until it has confirmed (under the state-json lock) that the
    book still exists. */
export async function encodeUploadedCover(
  buffer: Buffer,
  mimeType: UploadMimeType,
): Promise<Buffer> {
  // Both branches re-encode through the shared sharp helper (reencode.ts) so
  // cover.jpg on disk is always a clean sharp-written JPEG and trailing junk
  // can never survive (#3535). PNG keeps the strict decode; JPEG stays
  // tolerant so a damaged-but-real JPEG missing only its EOI marker is still
  // accepted, as before.
  const tolerant = mimeType === 'image/jpeg';
  const prefix =
    mimeType === 'image/png' ? 'PNG → JPEG transcode failed:' : 'JPEG decode failed:';
  let jpegBytes: Buffer;
  try {
    jpegBytes = await reencodeToJpeg(buffer, { tolerant });
  } catch (e) {
    throw new UploadError('transcode_failed', `${prefix} ${(e as Error).message}`);
  }
  return jpegBytes;
}

export async function patchStateLocalCover(
  bookDir: string,
  originalFilename: string | null,
  /** Runs inside the lock once state.json is confirmed present — the cover
      file write, so nothing lands in a book folder that moved or was deleted. */
  beforeWrite?: () => Promise<void>,
): Promise<boolean> {
  const path = stateJsonPath(bookDir);
  /* #3700 — read-modify-write under the per-book state-json lock. `false` =
     state.json absent (deleted/moved while queued): nothing was written. */
  return withStateJsonLock(path, async () => {
    const state = await readJson<BookStateJson>(path);
    if (!state) return false;
    if (beforeWrite) await beforeWrite();
    state.coverImage = {
      source: 'local',
      originalFilename,
      uploadedAt: new Date().toISOString(),
    };
    state.updatedAt = new Date().toISOString();
    await writeStateJsonAtomic(path, { ...state, language: state.language ?? null });
    return true;
  });
}

export function clampFraming(framing: CoverFraming): CoverFraming {
  return {
    offsetX: clamp(framing.offsetX, -100, 100),
    offsetY: clamp(framing.offsetY, -100, 100),
    zoom: clamp(framing.zoom, 1, 3),
  };
}

export async function patchStateFraming(bookDir: string, framing: CoverFraming): Promise<boolean> {
  const path = stateJsonPath(bookDir);
  return withStateJsonLock(path, async () => {
    const state = await readJson<BookStateJson>(path);
    if (!state) return false;
    if (!state.coverImage) return false;
    state.coverImage.framing = clampFraming(framing);
    state.updatedAt = new Date().toISOString();
    await writeStateJsonAtomic(path, { ...state, language: state.language ?? null });
    return true;
  });
}

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}
