/* writeJsonAtomic / renameWithRetry — the rename-retry surface that
   absorbs OneDrive / AV / indexer race conditions on Windows. The
   2026-05-15 ENOENT crash on library-cast-override prompted adding ENOENT
   to the retry list; this file pins that contract. */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, readFile, rm, stat, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/* Mock fs/promises so we can intercept `rename` while leaving every
   other call (mkdir, writeFile, unlink) pointing at the real impl. The
   intercept is a module-scoped swap so each test can install its own
   failure pattern via setRenameImpl(). */
let renameImpl: ((src: string, dest: string) => Promise<void>) | null = null;

vi.mock('node:fs/promises', async () => {
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  return {
    ...actual,
    /* Default: pass-through. Tests override via setRenameImpl(). */
    rename: (src: string, dest: string): Promise<void> =>
      (renameImpl ?? actual.rename)(src, dest),
  };
});

function setRenameImpl(fn: ((src: string, dest: string) => Promise<void>) | null): void {
  renameImpl = fn;
}

/* Import AFTER vi.mock so state-io.ts picks up the mocked rename. */
const { writeJsonAtomic } = await import('./state-io.js');

let workdir: string;

beforeEach(async () => {
  workdir = await mkdtemp(join(tmpdir(), 'state-io-test-'));
});

afterEach(async () => {
  setRenameImpl(null);
  await rm(workdir, { recursive: true, force: true });
});

describe('writeJsonAtomic happy path', () => {
  it('writes JSON to the target path with stable 2-space indent', async () => {
    const target = join(workdir, 'state.json');
    await writeJsonAtomic(target, { hello: 'world', nested: { value: 1 } });
    const onDisk = await readFile(target, 'utf8');
    /* Two-space indent matches what every other .audiobook/*.json author
       in the codebase emits. Drifting on this would generate noisy diffs
       when state files round-trip through Node + manual edits. */
    expect(onDisk).toBe('{\n  "hello": "world",\n  "nested": {\n    "value": 1\n  }\n}');
  });

  it('overwrites an existing file in place', async () => {
    const target = join(workdir, 'state.json');
    await writeJsonAtomic(target, { v: 1 });
    await writeJsonAtomic(target, { v: 2 });
    const onDisk = JSON.parse(await readFile(target, 'utf8'));
    expect(onDisk).toEqual({ v: 2 });
  });
});

describe('renameWithRetry transient-error handling', () => {
  async function exerciseTransient(code: 'EPERM' | 'EBUSY' | 'ENOENT'): Promise<void> {
    const target = join(workdir, 'state.json');
    let attempts = 0;
    const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    setRenameImpl(async (src: string, dest: string) => {
      attempts++;
      if (attempts <= 2) {
        throw Object.assign(new Error(`${code}: simulated`), { code });
      }
      return actual.rename(src, dest);
    });

    await writeJsonAtomic(target, { ok: true });

    expect(attempts).toBeGreaterThan(1);
    const onDisk = JSON.parse(await readFile(target, 'utf8'));
    expect(onDisk).toEqual({ ok: true });
  }

  it('retries past EPERM (AV / indexer brief lock)', async () => {
    await exerciseTransient('EPERM');
  });

  it('retries past EBUSY (file handle still held)', async () => {
    await exerciseTransient('EBUSY');
  });

  it('retries past ENOENT (OneDrive moved the tmp file mid-rename)', async () => {
    /* This is the case the 2026-05-15 library-cast-override crash hit.
       OneDrive briefly pulls the just-created tmp file into its sync
       staging area; the rename arrives during that move and sees the
       src as missing. Treat it like the other transient codes. */
    await exerciseTransient('ENOENT');
  });

  it('does NOT retry past EACCES (real permission fault) — surfaces immediately', async () => {
    const target = join(workdir, 'state.json');
    let attempts = 0;
    setRenameImpl(async () => {
      attempts++;
      throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
    });

    await expect(writeJsonAtomic(target, { ok: true })).rejects.toThrow(/EACCES/);
    /* Exactly one attempt — non-transient errors must NOT spam retries
       and waste 800ms of backoff before failing. */
    expect(attempts).toBe(1);
  });

  it('cleans up the tmp file when all retries are exhausted', async () => {
    const target = join(workdir, 'state.json');
    setRenameImpl(async () => {
      throw Object.assign(new Error('EPERM: always'), { code: 'EPERM' });
    });

    await expect(writeJsonAtomic(target, { ok: true })).rejects.toThrow(/EPERM/);

    /* The tmp file should be gone — leaking .tmp-<pid>-<ts> droppings
       across crashed writes pollutes .audiobook/ over time. */
    const droppings = (await readdir(workdir)).filter(n => n.includes('.tmp-'));
    expect(droppings).toEqual([]);

    /* And the target was never created (no partial state). */
    await expect(stat(target)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
