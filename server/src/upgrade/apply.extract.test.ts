/* #4322 — extractRelease must REJECT when mkdir fails, not throw inside a yauzl
   callback (an uncaughtException the server answers with exit(1), leaving
   state.json at phase 'applying'). releaseDir sits under a regular file, so
   mkdirSync throws ENOTDIR for both entry kinds. */

import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { createWriteStream, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { finished } from 'node:stream/promises';
import yauzl from 'yauzl';
import yazl from 'yazl';
import { extractRelease } from './apply.js';

let root: string;
let blocker: string;

async function makeZip(name: string, build: (z: yazl.ZipFile) => void): Promise<string> {
  const zipPath = join(root, name);
  const z = new yazl.ZipFile();
  build(z);
  z.end();
  const out = createWriteStream(zipPath);
  z.outputStream.pipe(out);
  await finished(out);
  return zipPath;
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'extract-4322-'));
  blocker = join(root, 'blocker');
  writeFileSync(blocker, 'a regular file, so mkdir under it throws ENOTDIR');
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('extractRelease mkdir failure (#4322)', () => {
  it('rejects for a directory entry', async () => {
    const zip = await makeZip('dir.zip', (z) => z.addEmptyDirectory('top/sub/'));
    await expect(extractRelease(zip, join(blocker, 'v9.9.9'), 'top')).rejects.toMatchObject({ code: 'ENOTDIR' });
  });

  it('rejects for a file entry', async () => {
    const zip = await makeZip('file.zip', (z) => z.addBuffer(Buffer.from('x'), 'top/sub/file.txt'));
    await expect(extractRelease(zip, join(blocker, 'v9.9.9'), 'top')).rejects.toMatchObject({ code: 'ENOTDIR' });
  });
});

/* A reject must also release the zip's file handle: autoClose only fires on
   'end' / yauzl's own error path, and on Windows a held handle blocks renaming
   any directory containing the zip. yauzl's RefUnrefFilter keeps its own ref
   until the entry's read stream is destroyed, so zip.close() alone is not
   enough for a file entry; the entry is large enough (4 MB, incompressible)
   that the read stream is still open when the mkdir rejection lands. */
describe('extractRelease releases the zip handle on reject (#4322)', () => {
  let opened: yauzl.ZipFile | undefined;

  function captureOpen(): void {
    const realOpen = yauzl.open.bind(yauzl) as (...a: unknown[]) => void;
    vi.spyOn(yauzl, 'open').mockImplementation(((...args: unknown[]) => {
      const cb = args[args.length - 1] as (err: Error | null, zip?: yauzl.ZipFile) => void;
      args[args.length - 1] = (err: Error | null, zip?: yauzl.ZipFile) => {
        opened = zip;
        cb(err, zip);
      };
      realOpen(...args);
    }) as unknown as typeof yauzl.open);
  }

  afterEach(() => {
    vi.restoreAllMocks();
    opened = undefined;
  });

  const refCount = () => (opened as unknown as { reader: { refCount: number } }).reader.refCount;

  it('for a directory entry', async () => {
    captureOpen();
    const zip = await makeZip('dir-ref.zip', (z) => z.addEmptyDirectory('top/sub/'));
    await expect(extractRelease(zip, join(blocker, 'v9.9.9'), 'top')).rejects.toMatchObject({ code: 'ENOTDIR' });
    expect(opened).toBeDefined();
    expect(refCount()).toBe(0);
  });

  it('for a file entry', async () => {
    captureOpen();
    const zip = await makeZip('file-ref.zip', (z) =>
      z.addBuffer(randomBytes(4 * 1024 * 1024), 'top/sub/big.bin', { compress: false }),
    );
    await expect(extractRelease(zip, join(blocker, 'v9.9.9'), 'top')).rejects.toMatchObject({ code: 'ENOTDIR' });
    expect(opened).toBeDefined();
    expect(refCount()).toBe(0);
  });
});
