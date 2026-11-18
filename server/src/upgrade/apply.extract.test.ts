/* #4322 — extractRelease must REJECT when mkdir fails, not throw inside a yauzl
   callback (an uncaughtException the server answers with exit(1), leaving
   state.json at phase 'applying'). releaseDir sits under a regular file, so
   mkdirSync throws ENOTDIR for both entry kinds. */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createWriteStream, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { finished } from 'node:stream/promises';
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
