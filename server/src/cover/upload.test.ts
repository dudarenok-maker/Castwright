/* Unit tests for the local-cover upload pipeline (plan 40). */

import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest';
import {
  mkdtempSync,
  rmSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  existsSync,
} from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';
import {
  ACCEPTED_MIME_TYPES,
  MAX_UPLOAD_BYTES,
  UploadError,
  clampFraming,
  patchStateFraming,
  patchStateLocalCover,
  encodeUploadedCover,
  validateUpload,
  type UploadMimeType,
} from './upload.js';
import { writeCoverFile } from './store.js';

/* writeCoverFile asserts containment in WORKSPACE_ROOT (read once at import),
   so the per-test book dirs must live under a root fixed before it loads. */
const testRoot = await vi.hoisted(async () => {
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const root = mkdtempSync(join(tmpdir(), 'cover-upload-root-'));
  process.env.WORKSPACE_DIR = root;
  return root;
});
afterAll(() => {
  rmSync(testRoot, { recursive: true, force: true });
});

let workspaceRoot: string;
let bookDir: string;
const TITLE = 'Upload Test Book';

async function makeJpeg(width = 10, height = 10): Promise<Buffer> {
  return await sharp({
    create: { width, height, channels: 3, background: { r: 200, g: 100, b: 50 } },
  })
    .jpeg({ quality: 85 })
    .toBuffer();
}

async function makePng(width = 10, height = 10): Promise<Buffer> {
  return await sharp({
    create: { width, height, channels: 4, background: { r: 50, g: 150, b: 200, alpha: 1 } },
  })
    .png()
    .toBuffer();
}

beforeEach(() => {
  workspaceRoot = mkdtempSync(join(testRoot, 'cover-upload-test-'));
  bookDir = join(workspaceRoot, 'books', 'Author', 'Series', TITLE);
  mkdirSync(join(bookDir, '.audiobook'), { recursive: true });
  writeFileSync(
    join(bookDir, '.audiobook', 'state.json'),
    JSON.stringify({
      bookId: 'test-book',
      manuscriptId: 'm_test',
      title: TITLE,
      author: 'Author',
      series: 'Series',
      seriesPosition: null,
      isStandalone: true,
      manuscriptFile: 'manuscript.txt',
      castConfirmed: false,
      chapters: [],
      coverGradient: ['#000', '#fff'],
      coverImage: {
        openLibraryId: 'cover-i:111',
        originalUrl: 'https://example.com/cover.jpg',
        fetchedAt: '2026-01-01T00:00:00.000Z',
      },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }),
  );
});

afterEach(() => {
  if (workspaceRoot) rmSync(workspaceRoot, { recursive: true, force: true });
});

describe('validateUpload', () => {
  it('throws empty when buffer is undefined', () => {
    expect(() => validateUpload(undefined, 'image/jpeg')).toThrow(UploadError);
    try {
      validateUpload(undefined, 'image/jpeg');
    } catch (e) {
      expect((e as UploadError).kind).toBe('empty');
    }
  });

  it('throws empty when buffer is zero length', () => {
    try {
      validateUpload(Buffer.alloc(0), 'image/jpeg');
    } catch (e) {
      expect((e as UploadError).kind).toBe('empty');
    }
  });

  it('throws oversize when buffer exceeds MAX_UPLOAD_BYTES', () => {
    const buf = Buffer.alloc(MAX_UPLOAD_BYTES + 1);
    try {
      validateUpload(buf, 'image/jpeg');
    } catch (e) {
      expect((e as UploadError).kind).toBe('oversize');
    }
  });

  it('throws invalid_mime on GIF', () => {
    try {
      validateUpload(Buffer.from('xx'), 'image/gif');
    } catch (e) {
      expect((e as UploadError).kind).toBe('invalid_mime');
    }
  });

  it('throws invalid_mime on undefined MIME', () => {
    try {
      validateUpload(Buffer.from('xx'), undefined);
    } catch (e) {
      expect((e as UploadError).kind).toBe('invalid_mime');
    }
  });

  /* The label allowlist is still part of the contract: real image bytes do not
     rescue a label outside it (the sniff alone would accept these). */
  it('refuses a real PNG and a real JPEG labelled image/gif', async () => {
    expect(kindOf(await makePng(), 'image/gif')).toBe('invalid_mime');
    expect(kindOf(await makeJpeg(), 'image/gif')).toBe('invalid_mime');
  });

  it('refuses a real PNG and a real JPEG with no or empty MIME type', async () => {
    const png = await makePng();
    const jpeg = await makeJpeg();
    expect(kindOf(png, undefined as unknown as string)).toBe('invalid_mime');
    expect(kindOf(jpeg, undefined as unknown as string)).toBe('invalid_mime');
    expect(kindOf(png, '')).toBe('invalid_mime');
    expect(kindOf(jpeg, '')).toBe('invalid_mime');
  });

  it('accepts JPEG and PNG MIME types', () => {
    expect(ACCEPTED_MIME_TYPES).toContain('image/jpeg');
    expect(ACCEPTED_MIME_TYPES).toContain('image/png');
  });

  /* #3533: the declared MIME is client-controlled; the bytes decide. */
  it('accepts a real JPEG and a real PNG whose bytes match the declared type', async () => {
    const jpeg = await makeJpeg();
    const png = await makePng();
    expect(() => validateUpload(jpeg, 'image/jpeg')).not.toThrow();
    expect(() => validateUpload(png, 'image/png')).not.toThrow();
  });

  function kindOf(buf: Buffer, mime: string): string | undefined {
    try {
      validateUpload(buf, mime);
    } catch (e) {
      return (e as UploadError).kind;
    }
    return undefined;
  }

  it('refuses SVG bytes labelled image/png', () => {
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><circle r="4"/></svg>');
    expect(kindOf(svg, 'image/png')).toBe('invalid_mime');
  });

  it('refuses HTML bytes labelled image/jpeg', () => {
    expect(kindOf(Buffer.from('<html><script>1</script></html>'), 'image/jpeg')).toBe(
      'invalid_mime',
    );
  });

  it('picks the branch from the bytes, not the label (valid image, wrong extension)', async () => {
    const jpeg = await makeJpeg();
    const png = await makePng();
    expect(validateUpload(jpeg, 'image/png')).toBe('image/jpeg');
    expect(validateUpload(png, 'image/jpeg')).toBe('image/png');
    expect(validateUpload(jpeg, 'image/jpeg')).toBe('image/jpeg');
    expect(validateUpload(png, 'image/png')).toBe('image/png');
  });
});

/* The production route composes these two (encode, then write under the
   state-json lock); the tests below pin that composition's on-disk result. */
async function writeUploadedCover(
  buffer: Buffer,
  mimeType: UploadMimeType,
  destPath: string,
): Promise<{ bytes: number }> {
  const jpegBytes = await encodeUploadedCover(buffer, mimeType);
  await writeCoverFile(destPath, jpegBytes);
  return { bytes: jpegBytes.length };
}

describe('encodeUploadedCover + writeCoverFile', () => {
  /* #3535 regression: a tiny valid JPEG with an MPEG-TS-looking stream
     appended used to be stored verbatim, and ffmpeg's byte-probing then
     picked the mpegts demuxer over the JPEG one, breaking the m4b export.
     The upload path must re-encode, so the stored cover is only ever a
     clean sharp-written JPEG. */
  it('re-encodes a JPEG with an appended MPEG-TS-looking tail so no trailing bytes survive (#3535)', async () => {
    const dest = join(bookDir, '.audiobook', 'cover.jpg');
    const jpeg = await sharp({
      create: { width: 2, height: 2, channels: 3, background: { r: 200, g: 100, b: 50 } },
    })
      .jpeg()
      .toBuffer();
    // A few 188-byte MPEG-TS-shaped packets (0x47 sync byte, zero-filled
    // payload) appended as trailing bytes. They are NOT a real stream and
    // this fixture does not make ffmpeg probe the file as mpegts; the test
    // only pins that trailing bytes do not survive the re-encode.
    const packets = Array.from({ length: 3 }, () => {
      const packet = Buffer.alloc(188, 0x00);
      packet[0] = 0x47;
      return packet;
    });
    const input = Buffer.concat([jpeg, ...packets]);
    const result = await writeUploadedCover(input, 'image/jpeg', dest);
    const written = readFileSync(dest);
    expect(Buffer.compare(written, input)).not.toBe(0);
    expect(written.length).toBeLessThan(input.length);
    expect(result.bytes).toBe(written.length);
    // Clean sharp-written JPEG: ends with the EOI marker and decodes as a
    // JPEG with the original pixel dimensions.
    expect([...written.subarray(written.length - 2)]).toEqual([0xff, 0xd9]);
    const meta = await sharp(written).metadata();
    expect(meta.format).toBe('jpeg');
    expect(meta.width).toBe(2);
    expect(meta.height).toBe(2);
  });

  it('re-encodes a JPEG upload to a clean sharp-written JPEG with the same dimensions', async () => {
    const dest = join(bookDir, '.audiobook', 'cover.jpg');
    /* Behaviour change (#3642 / #3535): every upload is re-encoded through
       sharp. The input is written at quality 100, so only a real re-encode
       (quality 85) can make the stored file differ from — and be smaller
       than — the input. */
    const jpeg = await sharp({
      create: { width: 10, height: 10, channels: 3, background: { r: 200, g: 100, b: 50 } },
    })
      .jpeg({ quality: 100 })
      .toBuffer();
    const result = await writeUploadedCover(jpeg, 'image/jpeg', dest);
    expect(existsSync(dest)).toBe(true);
    const written = readFileSync(dest);
    expect(result.bytes).toBe(written.length);
    expect(Buffer.compare(written, jpeg)).not.toBe(0);
    expect(written.length).toBeLessThan(jpeg.length);
    expect([...written.subarray(written.length - 2)]).toEqual([0xff, 0xd9]);
    const meta = await sharp(written).metadata();
    expect(meta.format).toBe('jpeg');
    expect(meta.width).toBe(10);
    expect(meta.height).toBe(10);
  });

  it('transcodes PNG to JPEG on disk', async () => {
    const dest = join(bookDir, '.audiobook', 'cover.jpg');
    const png = await makePng();
    await writeUploadedCover(png, 'image/png', dest);
    const written = readFileSync(dest);
    // JPEG files start with the SOI marker FF D8.
    expect(written[0]).toBe(0xff);
    expect(written[1]).toBe(0xd8);
    // The transcoded JPEG is materially different from the source PNG bytes.
    expect(Buffer.compare(written, png)).not.toBe(0);
  });

  it('re-encodes baseline, progressive and EXIF JPEGs to clean JPEGs with the same dimensions', async () => {
    const base = { create: { width: 16, height: 16, channels: 3 as const, background: '#c86432' } };
    const variants = [
      await sharp(base).jpeg().toBuffer(),
      await sharp(base).jpeg({ progressive: true }).toBuffer(),
      await sharp(base).withExif({ IFD0: { Copyright: 'x' } }).jpeg().toBuffer(),
    ];
    for (const jpeg of variants) {
      const dest = join(bookDir, '.audiobook', 'cover.jpg');
      await writeUploadedCover(jpeg, 'image/jpeg', dest);
      const written = readFileSync(dest);
      expect([...written.subarray(written.length - 2)]).toEqual([0xff, 0xd9]);
      const meta = await sharp(written).metadata();
      expect(meta.format).toBe('jpeg');
      expect(meta.width).toBe(16);
      expect(meta.height).toBe(16);
      // Only a real re-encode flattens a progressive scan and drops EXIF.
      expect(meta.isProgressive).toBe(false);
      expect(meta.exif).toBeUndefined();
    }
  });

  it('accepts a real JPEG missing only its end-of-image marker and repairs it (tolerant decode)', async () => {
    const jpeg = await makeJpeg();
    expect([...jpeg.subarray(jpeg.length - 2)]).toEqual([0xff, 0xd9]);
    const cut = jpeg.subarray(0, jpeg.length - 2);
    const dest = join(bookDir, '.audiobook', 'cover.jpg');
    const result = await writeUploadedCover(cut, 'image/jpeg', dest);
    const written = readFileSync(dest);
    /* The damaged input is re-encoded, so the stored cover is whole again. */
    expect(result.bytes).toBe(written.length);
    expect([...written.subarray(written.length - 2)]).toEqual([0xff, 0xd9]);
    const meta = await sharp(written).metadata();
    expect(meta.format).toBe('jpeg');
    expect(meta.width).toBe(10);
    expect(meta.height).toBe(10);
  });

  /* .rotate() in reencodeToJpeg applies EXIF orientation before sharp drops
     the metadata — a rotated phone photo must not land sideways (#3642). */
  it('applies EXIF orientation on re-encode so a rotated phone photo lands upright', async () => {
    const input = await sharp({
      create: { width: 32, height: 16, channels: 3, background: { r: 10, g: 200, b: 90 } },
    })
      .withMetadata({ orientation: 6 })
      .jpeg()
      .toBuffer();
    const dest = join(bookDir, '.audiobook', 'cover.jpg');
    await writeUploadedCover(input, 'image/jpeg', dest);
    const written = readFileSync(dest);
    const meta = await sharp(written).metadata();
    expect(meta.format).toBe('jpeg');
    // Orientation 6 (rotate 90 CW to display): the stored pixels are already
    // rotated, so the cover is 16x32 portrait, not the raw 32x16 landscape.
    expect(meta.width).toBe(16);
    expect(meta.height).toBe(32);
    // The orientation tag is consumed, not carried forward.
    expect(meta.orientation).toBeUndefined();
  });

  it('refuses JPEG-signature bytes that do not decode and writes nothing', async () => {
    const sig = Buffer.from([0xff, 0xd8, 0xff]);
    const bad = [sig, Buffer.concat([sig, Buffer.from('<html><script>1</script></html>')])];
    for (const buf of bad) {
      const dest = join(bookDir, '.audiobook', 'cover.jpg');
      await expect(writeUploadedCover(buf, 'image/jpeg', dest)).rejects.toMatchObject({
        kind: 'transcode_failed',
      });
      expect(existsSync(dest)).toBe(false);
      expect(readdirSync(join(bookDir, '.audiobook')).filter((f) => f.includes('.tmp-'))).toEqual(
        [],
      );
    }
  });

  it('leaves no .tmp file behind on a successful write', async () => {
    const dest = join(bookDir, '.audiobook', 'cover.jpg');
    await writeUploadedCover(await makeJpeg(), 'image/jpeg', dest);
    const files = readdirSync(join(bookDir, '.audiobook'));
    expect(files.filter((f) => f.includes('.tmp-'))).toEqual([]);
  });
});

describe('patchStateLocalCover', () => {
  it("sets source='local', originalFilename, uploadedAt and drops OpenLibrary fields", async () => {
    await patchStateLocalCover(bookDir, 'my-cover.png');
    const state = JSON.parse(readFileSync(join(bookDir, '.audiobook', 'state.json'), 'utf8'));
    expect(state.coverImage.source).toBe('local');
    expect(state.coverImage.originalFilename).toBe('my-cover.png');
    expect(typeof state.coverImage.uploadedAt).toBe('string');
    expect(state.coverImage.openLibraryId).toBeUndefined();
    expect(state.coverImage.originalUrl).toBeUndefined();
    expect(state.coverImage.fetchedAt).toBeUndefined();
  });

  it('accepts null originalFilename', async () => {
    await patchStateLocalCover(bookDir, null);
    const state = JSON.parse(readFileSync(join(bookDir, '.audiobook', 'state.json'), 'utf8'));
    expect(state.coverImage.originalFilename).toBeNull();
  });

  it('resets framing when replacing the cover (a fresh image deserves a fresh frame)', async () => {
    // Seed prior framing.
    await patchStateFraming(bookDir, { offsetX: 30, offsetY: -20, zoom: 1.5 });
    await patchStateLocalCover(bookDir, 'new.jpg');
    const state = JSON.parse(readFileSync(join(bookDir, '.audiobook', 'state.json'), 'utf8'));
    expect(state.coverImage.framing).toBeUndefined();
  });
});

describe('patchStateFraming', () => {
  it('persists framing onto an existing coverImage', async () => {
    const ok = await patchStateFraming(bookDir, { offsetX: 50, offsetY: -25, zoom: 1.5 });
    expect(ok).toBe(true);
    const state = JSON.parse(readFileSync(join(bookDir, '.audiobook', 'state.json'), 'utf8'));
    expect(state.coverImage.framing).toEqual({ offsetX: 50, offsetY: -25, zoom: 1.5 });
  });

  it('clamps out-of-range offsets and zoom on the way to disk', async () => {
    await patchStateFraming(bookDir, { offsetX: 999, offsetY: -999, zoom: 99 });
    const state = JSON.parse(readFileSync(join(bookDir, '.audiobook', 'state.json'), 'utf8'));
    expect(state.coverImage.framing).toEqual({ offsetX: 100, offsetY: -100, zoom: 3 });
  });

  it('returns false when the book has no coverImage', async () => {
    // Wipe coverImage on the seeded state.
    const path = join(bookDir, '.audiobook', 'state.json');
    const state = JSON.parse(readFileSync(path, 'utf8'));
    delete state.coverImage;
    writeFileSync(path, JSON.stringify(state));
    const ok = await patchStateFraming(bookDir, { offsetX: 0, offsetY: 0, zoom: 1 });
    expect(ok).toBe(false);
  });
});

describe('clampFraming', () => {
  it('passes through valid values', () => {
    expect(clampFraming({ offsetX: 50, offsetY: -30, zoom: 2 })).toEqual({
      offsetX: 50,
      offsetY: -30,
      zoom: 2,
    });
  });
  it('clamps to range boundaries', () => {
    expect(clampFraming({ offsetX: 500, offsetY: -500, zoom: 100 })).toEqual({
      offsetX: 100,
      offsetY: -100,
      zoom: 3,
    });
    expect(clampFraming({ offsetX: 0, offsetY: 0, zoom: 0.5 }).zoom).toBe(1);
  });
});
