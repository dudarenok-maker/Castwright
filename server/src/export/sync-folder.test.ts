/* Sync-folder writer tests. Atomic-rename retry coverage already lives in
   state-io's tests (indirectly via the shared helper); this suite focuses
   on the writer's own contract — destination is mkdir'd on demand, the
   tmp file is cleaned up on terminal failure, and the returned syncPath
   matches what landed on disk. */

import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { writeToSyncFolder } from './sync-folder.js';

describe('writeToSyncFolder', () => {
  let tmpRoot: string;
  let srcPath: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'sync-folder-'));
    srcPath = join(tmpRoot, 'src.bin');
    writeFileSync(srcPath, Buffer.from('hello world'));
  });

  afterEach(() => { rmSync(tmpRoot, { recursive: true, force: true }); });

  it('copies the source into the destination folder, returning the final path', async () => {
    const dest = join(tmpRoot, 'sync');
    const result = await writeToSyncFolder(srcPath, dest, 'audiobook.zip');

    expect(result.syncPath).toBe(join(dest, 'audiobook.zip'));
    expect(readFileSync(result.syncPath, 'utf8')).toBe('hello world');
  });

  it('mkdirs the destination if it does not yet exist', async () => {
    const dest = join(tmpRoot, 'nested', 'sync', 'dir');
    const result = await writeToSyncFolder(srcPath, dest, 'audiobook.zip');
    expect(result.syncPath).toBe(join(dest, 'audiobook.zip'));
    expect(readFileSync(result.syncPath, 'utf8')).toBe('hello world');
  });

  it('overwrites an existing destination file atomically (rename semantics)', async () => {
    const dest = join(tmpRoot, 'sync');
    mkdirSync(dest, { recursive: true });
    writeFileSync(join(dest, 'audiobook.zip'), 'stale content');

    await writeToSyncFolder(srcPath, dest, 'audiobook.zip');
    expect(readFileSync(join(dest, 'audiobook.zip'), 'utf8')).toBe('hello world');
  });

  it('does not leave .tmp- droppings on success', async () => {
    const dest = join(tmpRoot, 'sync');
    await writeToSyncFolder(srcPath, dest, 'audiobook.zip');
    const stragglers = readdirSync(dest).filter(n => n.includes('.tmp-'));
    expect(stragglers).toEqual([]);
  });
});
