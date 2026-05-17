/* Unit tests for the local-cover upload pipeline (plan 40). */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  mkdtempSync,
  rmSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import {
  ACCEPTED_MIME_TYPES,
  MAX_UPLOAD_BYTES,
  UploadError,
  clampFraming,
  patchStateFraming,
  patchStateLocalCover,
  validateUpload,
  writeUploadedCover,
} from './upload.js';

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
  workspaceRoot = mkdtempSync(join(tmpdir(), 'cover-upload-test-'));
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

  it('accepts JPEG and PNG MIME types', () => {
    expect(ACCEPTED_MIME_TYPES).toContain('image/jpeg');
    expect(ACCEPTED_MIME_TYPES).toContain('image/png');
    expect(() => validateUpload(Buffer.from('xx'), 'image/jpeg')).not.toThrow();
    expect(() => validateUpload(Buffer.from('xx'), 'image/png')).not.toThrow();
  });
});

describe('writeUploadedCover', () => {
  it('writes JPEG bytes verbatim when MIME is image/jpeg', async () => {
    const dest = join(bookDir, '.audiobook', 'cover.jpg');
    const jpeg = await makeJpeg();
    const result = await writeUploadedCover(jpeg, 'image/jpeg', dest);
    expect(existsSync(dest)).toBe(true);
    expect(result.bytes).toBe(jpeg.length);
    const written = readFileSync(dest);
    expect(Buffer.compare(written, jpeg)).toBe(0);
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
