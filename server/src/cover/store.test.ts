import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import {
  mkdtempSync,
  rmSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  readdirSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let workspaceRoot: string;
let bookDir: string;

const fetchMock = vi.fn();
function imageResponse(bytes: Uint8Array, contentType = 'image/jpeg'): Response {
  return new Response(bytes, { status: 200, headers: { 'Content-Type': contentType } });
}

/* #3640 / #3535: downloadCover now re-encodes every fetched body before it
   lands as cover.jpg, so the fixture must be a real decodable image. The old
   six-byte JPEG-header stub (ff d8 ff e0 00 10) was never decodable and is
   gone. */
let SAMPLE_JPEG: Uint8Array;

beforeAll(async () => {
  const sharp = (await import('sharp')).default;
  SAMPLE_JPEG = new Uint8Array(
    await sharp({
      create: { width: 8, height: 8, channels: 3, background: { r: 10, g: 20, b: 30 } },
    })
      .jpeg({ quality: 85 })
      .toBuffer(),
  );
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

describe('downloadCover containment', () => {
  it('rejects a destPath outside the workspace before any fetch', async () => {
    const { downloadCover } = await import('./store.js');
    await expect(
      downloadCover('https://x/evil.jpg', join(workspaceRoot, '..', '..', 'evil.jpg')),
    ).rejects.toThrow();
  });
});

describe('cover state.json helpers wait on the state lock (#3625)', () => {
  const statePath = () => join(bookDir, '.audiobook', 'state.json');
  const readState = () => JSON.parse(readFileSync(statePath(), 'utf8'));

  async function holdLock(): Promise<{ release: () => void; held: Promise<void> }> {
    const { withStateLock } = await import('../workspace/state-lock.js');
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let acquired!: () => void;
    const got = new Promise<void>((r) => (acquired = r));
    const held = withStateLock(bookDir, async () => {
      acquired();
      await gate;
    });
    await got;
    return { release, held };
  }

  it('patchStateCover does not write while the lock is held, then lands', async () => {
    const { patchStateCover } = await import('./store.js');
    const before = readFileSync(statePath(), 'utf8');
    const { release, held } = await holdLock();
    const p = patchStateCover(bookDir, {
      id: 'apple:1',
      source: 'apple',
      coverUrl: 'https://x/1.jpg',
    });
    await new Promise((r) => setTimeout(r, 200));
    expect(readFileSync(statePath(), 'utf8')).toBe(before);
    release();
    await Promise.all([held, p]);
    expect(readState().coverImage.candidateId).toBe('apple:1');
  });

  it('clearStateCover does not write while the lock is held, then lands', async () => {
    const { patchStateCover, clearStateCover } = await import('./store.js');
    await patchStateCover(bookDir, { id: 'apple:2', source: 'apple', coverUrl: 'https://x/2.jpg' });
    expect(readState().coverImage).toBeDefined();
    const { release, held } = await holdLock();
    const p = clearStateCover(bookDir);
    await new Promise((r) => setTimeout(r, 200));
    expect(readState().coverImage).toBeDefined();
    release();
    await Promise.all([held, p]);
    expect(readState().coverImage).toBeUndefined();
  });
});

/* #3640 / #3535: every provider body is normalised through the shared
   re-encode helper (server/src/cover/reencode.ts) before it lands as
   cover.jpg — a GIF/WebP stored verbatim breaks the m4b export, and a JPEG
   with trailing junk defeats ffmpeg's content probing. All fixtures are
   generated in-test with sharp; no committed binaries. */
describe('downloadCover re-encodes provider bodies to JPEG (#3640)', () => {
  const fixtureDir = (name: string) => join(bookDir, 'covers', name);
  const destPath = (name: string) => join(fixtureDir(name), 'cover.jpg');
  const tmpFiles = (name: string) => {
    const dir = fixtureDir(name);
    return existsSync(dir)
      ? readdirSync(dir).filter((f) => f.startsWith('cover.jpg.tmp-'))
      : [];
  };

  async function makeFixture(format: 'gif' | 'webp' | 'png'): Promise<Buffer> {
    const sharp = (await import('sharp')).default;
    return sharp({
      create: { width: 8, height: 8, channels: 3, background: { r: 10, g: 20, b: 30 } },
    })
      [format]()
      .toBuffer();
  }

  async function assertCoverIsJpeg(written: Buffer): Promise<void> {
    expect([...written.subarray(0, 3)]).toEqual([0xff, 0xd8, 0xff]);
    const sharp = (await import('sharp')).default;
    expect((await sharp(written).metadata()).format).toBe('jpeg');
  }

  it('stores a sharp-written JPEG when the provider serves a GIF', async () => {
    fetchMock.mockResolvedValue(imageResponse(await makeFixture('gif'), 'image/gif'));
    const { downloadCover } = await import('./store.js');

    const { bytes } = await downloadCover('https://x/cover.gif', destPath('gif'));

    const written = readFileSync(destPath('gif'));
    expect(bytes).toBe(written.length);
    await assertCoverIsJpeg(written);
  });

  it('stores a sharp-written JPEG when the provider serves a WebP', async () => {
    fetchMock.mockResolvedValue(imageResponse(await makeFixture('webp'), 'image/webp'));
    const { downloadCover } = await import('./store.js');

    const { bytes } = await downloadCover('https://x/cover.webp', destPath('webp'));

    const written = readFileSync(destPath('webp'));
    expect(bytes).toBe(written.length);
    await assertCoverIsJpeg(written);
  });

  it('stores a sharp-written JPEG when the provider serves a PNG', async () => {
    fetchMock.mockResolvedValue(imageResponse(await makeFixture('png'), 'image/png'));
    const { downloadCover } = await import('./store.js');

    const { bytes } = await downloadCover('https://x/cover.png', destPath('png'));

    const written = readFileSync(destPath('png'));
    expect(bytes).toBe(written.length);
    await assertCoverIsJpeg(written);
  });

  it('drops trailing junk after a real JPEG and keeps a clean EOI', async () => {
    const sharp = (await import('sharp')).default;
    const jpeg = await sharp({
      create: { width: 8, height: 8, channels: 3, background: { r: 10, g: 20, b: 30 } },
    })
      .jpeg({ quality: 85 })
      .toBuffer();
    const junk = Buffer.concat([jpeg, Buffer.from([0x47]), Buffer.alloc(16)]);
    fetchMock.mockResolvedValue(imageResponse(junk));
    const { downloadCover } = await import('./store.js');

    const { bytes } = await downloadCover('https://x/cover.jpg', destPath('junk'));

    const written = readFileSync(destPath('junk'));
    expect(bytes).toBe(written.length);
    expect(written.length).toBeLessThan(junk.length);
    expect([...written.subarray(written.length - 2)]).toEqual([0xff, 0xd9]);
  });

  it('accepts a JPEG missing only its EOI marker and stores a whole JPEG (tolerant decode)', async () => {
    const sharp = (await import('sharp')).default;
    const jpeg = await sharp({
      create: { width: 300, height: 450, channels: 3, background: { r: 10, g: 20, b: 30 } },
    })
      .jpeg({ quality: 85 })
      .toBuffer();
    expect([...jpeg.subarray(jpeg.length - 2)]).toEqual([0xff, 0xd9]);
    const noEoi = jpeg.subarray(0, jpeg.length - 2);
    fetchMock.mockResolvedValue(imageResponse(noEoi));
    const { downloadCover } = await import('./store.js');

    const { bytes } = await downloadCover('https://x/cover.jpg', destPath('noeoi'));

    const written = readFileSync(destPath('noeoi'));
    expect(bytes).toBe(written.length);
    await assertCoverIsJpeg(written);
    expect([...written.subarray(written.length - 2)]).toEqual([0xff, 0xd9]);
  });

  it('still rejects a bare JPEG SOI header, even in tolerant mode', async () => {
    fetchMock.mockResolvedValue(imageResponse(Buffer.from([0xff, 0xd8, 0xff])));
    const { downloadCover } = await import('./store.js');
    await expect(downloadCover('https://x/cover.jpg', destPath('bare'))).rejects.toMatchObject({
      kind: 'invalid',
    });
    expect(existsSync(destPath('bare'))).toBe(false);
  });

  it('rejects a non-decodable body with kind invalid and leaves nothing at destPath', async () => {
    fetchMock.mockResolvedValue(imageResponse(Buffer.from('<html>'), 'image/png'));
    const { downloadCover, CoverDownloadError } = await import('./store.js');

    const dest = destPath('invalid');
    let caught: unknown;
    try {
      await downloadCover('https://x/cover.png', dest);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(CoverDownloadError);
    expect((caught as InstanceType<typeof CoverDownloadError>).kind).toBe('invalid');
    expect(existsSync(dest)).toBe(false);
    expect(tmpFiles('invalid')).toEqual([]);
  });
});

