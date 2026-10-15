/* Shared sharp JPEG re-encode for cover images (#3535).

   Every cover that passes through the upload path (and, per the operator
   decision on #3535, the download path as well) is re-encoded through sharp,
   so `cover.jpg` on disk is always a clean sharp-written JPEG: trailing junk
   cannot survive (a tiny valid JPEG with an MPEG-TS stream appended used to
   be kept verbatim, and ffmpeg's byte-probing then picked the mpegts
   demuxer, breaking the m4b export), and EXIF orientation is applied before
   the metadata is dropped (.rotate()), so a rotated phone photo never lands
   sideways. */

import sharp from 'sharp';

export const JPEG_QUALITY = 85;

/**
 * Re-encode an image buffer to a clean sharp-written JPEG (quality
 * JPEG_QUALITY). `tolerant` keeps a damaged-but-real JPEG (e.g. one missing
 * only its EOI marker) decodable — the same lenience the old upload path had.
 */
export async function reencodeToJpeg(
  buffer: Buffer,
  opts?: { tolerant?: boolean },
): Promise<Buffer> {
  return sharp(buffer, opts?.tolerant ? { failOn: 'none' } : undefined)
    .rotate()
    .jpeg({ quality: JPEG_QUALITY })
    .toBuffer();
}
