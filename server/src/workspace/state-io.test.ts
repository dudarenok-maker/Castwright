/* writeJsonAtomic / renameWithRetry — the rename-retry surface that
   absorbs OneDrive / AV / indexer race conditions on Windows. The
   2026-05-15 ENOENT crash on library-cast-override prompted adding ENOENT
   to the retry list; this file pins that contract. */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, readFile, rm, stat, readdir, writeFile } from 'node:fs/promises';
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
    rename: (src: string, dest: string): Promise<void> => (renameImpl ?? actual.rename)(src, dest),
  };
});

function setRenameImpl(fn: ((src: string, dest: string) => Promise<void>) | null): void {
  renameImpl = fn;
}

/* Import AFTER vi.mock so state-io.ts picks up the mocked rename. */
const { writeJsonAtomic, readJsonWithRecovery } = await import('./state-io.js');
const { jitteredDelayMs } = await import('./atomic-rename.js');

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

  it('survives concurrent writes to the same target without ENOENT on rename', async () => {
    /* Plan 88 regression — Phase 0 and Phase 1 of the pipelined analyzer
       both save to `${manuscriptId}.json` from inside the same tick. The
       previous temp-file naming (`${path}.tmp-${pid}-${Date.now()}`)
       collided on millisecond-equal Date.now() values: both calls picked
       the same temp path, one renamed it away, the other's rename then
       failed with ENOENT. The unique-suffix temp names defend against
       that race. CI Linux saw it consistently; Windows mostly hid the
       race behind slower fs latency. Fire many parallel writes and
       assert all complete + the final on-disk file is one of the
       payloads (last-writer-wins is acceptable; ANY rename failure is
       not). */
    const target = join(workdir, 'state.json');
    const N = 20;
    const writes = Array.from({ length: N }, (_, i) =>
      writeJsonAtomic(target, { writer: i }),
    );
    await Promise.all(writes);

    /* Every promise resolved — no ENOENT escape. */
    const final = JSON.parse(await readFile(target, 'utf8')) as { writer: number };
    expect(final).toHaveProperty('writer');
    expect(typeof final.writer).toBe('number');
    expect(final.writer).toBeGreaterThanOrEqual(0);
    expect(final.writer).toBeLessThan(N);

    /* Every tmp dropping is reaped. */
    const droppings = (await readdir(workdir)).filter((n) => n.includes('.tmp-'));
    expect(droppings).toEqual([]);
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

  it('survives 5 consecutive transient EPERM failures (extended budget #915)', async () => {
    /* #915 — 20-way same-target contention on a loaded Windows CI runner
       exhausted the prior 4-delay (~800ms) budget. The tail was extended to
       5 delays (6 attempts total), so a writer that loses the rename race up
       to 5 times in a row still lands. This fails on the pre-#915 budget
       (only 5 attempts → all 5 throw → surfaces EPERM) and passes after. */
    const target = join(workdir, 'state.json');
    let attempts = 0;
    const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    setRenameImpl(async (src: string, dest: string) => {
      attempts++;
      if (attempts <= 5) throw Object.assign(new Error('EPERM: simulated'), { code: 'EPERM' });
      return actual.rename(src, dest);
    });

    await writeJsonAtomic(target, { ok: true });

    expect(attempts).toBe(6);
    expect(JSON.parse(await readFile(target, 'utf8'))).toEqual({ ok: true });
  });

  it('does NOT retry past EROFS (read-only filesystem) — surfaces immediately', async () => {
    /* Plan 79 widened the retry list to cover EACCES + EIO because Drive
       for Desktop surfaces those transiently during cache flushes. EROFS
       (write to a genuinely read-only mount) is the unchanged
       "stop pretending, this won't work" code — keep the no-retry
       guarantee asserted via that code so the contract stays explicit. */
    const target = join(workdir, 'state.json');
    let attempts = 0;
    setRenameImpl(async () => {
      attempts++;
      throw Object.assign(new Error('EROFS: read-only file system'), { code: 'EROFS' });
    });

    await expect(writeJsonAtomic(target, { ok: true })).rejects.toThrow(/EROFS/);
    /* Exactly one attempt — non-transient errors must NOT spam retries
       and waste the full retry budget on backoff before failing. */
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
    const droppings = (await readdir(workdir)).filter((n) => n.includes('.tmp-'));
    expect(droppings).toEqual([]);

    /* And the target was never created (no partial state). */
    await expect(stat(target)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

describe('writeJsonAtomic with rotating backups (opt-in)', () => {
  it('skips rotation on the first write (no existing file to rotate)', async () => {
    const target = join(workdir, 'state.json');
    await writeJsonAtomic(target, { v: 1 }, { rotate: { keep: 3 } });

    const names = (await readdir(workdir)).sort();
    /* Only the target file exists — no .bak.1 yet, no .tmp droppings. */
    expect(names).toEqual(['state.json']);
  });

  it('shifts existing file -> .bak.1 on the second write', async () => {
    const target = join(workdir, 'state.json');
    await writeJsonAtomic(target, { v: 1 }, { rotate: { keep: 3 } });
    await writeJsonAtomic(target, { v: 2 }, { rotate: { keep: 3 } });

    expect(JSON.parse(await readFile(target, 'utf8'))).toEqual({ v: 2 });
    expect(JSON.parse(await readFile(`${target}.bak.1`, 'utf8'))).toEqual({ v: 1 });
    /* No bak.2/.bak.3 yet — only one prior write to shift. */
    const names = (await readdir(workdir)).filter((n) => n.startsWith('state.json'));
    expect(names.sort()).toEqual(['state.json', 'state.json.bak.1']);
  });

  it('keeps the newest N versions and drops the oldest on rotation past the keep limit', async () => {
    const target = join(workdir, 'state.json');
    /* Five sequential writes -> only target + bak.1 + bak.2 + bak.3 survive
       (keep=3). The bak.4/bak.5 slots that would otherwise materialise
       must NOT be on disk — the rotation drops what walks off the end. */
    for (let v = 1; v <= 5; v += 1) {
      await writeJsonAtomic(target, { v }, { rotate: { keep: 3 } });
    }

    expect(JSON.parse(await readFile(target, 'utf8'))).toEqual({ v: 5 });
    expect(JSON.parse(await readFile(`${target}.bak.1`, 'utf8'))).toEqual({ v: 4 });
    expect(JSON.parse(await readFile(`${target}.bak.2`, 'utf8'))).toEqual({ v: 3 });
    expect(JSON.parse(await readFile(`${target}.bak.3`, 'utf8'))).toEqual({ v: 2 });

    const names = (await readdir(workdir)).filter((n) => n.startsWith('state.json')).sort();
    expect(names).toEqual([
      'state.json',
      'state.json.bak.1',
      'state.json.bak.2',
      'state.json.bak.3',
    ]);
  });

  it('rotation is opt-in: no { rotate } option means no backup is created', async () => {
    const target = join(workdir, 'state.json');
    /* Cast/manuscript/revisions writers stay on the single-file shape so the
       opt-out is the SAME writeJsonAtomic call site they have today. */
    await writeJsonAtomic(target, { v: 1 });
    await writeJsonAtomic(target, { v: 2 });

    const names = (await readdir(workdir)).filter((n) => n.startsWith('state.json')).sort();
    expect(names).toEqual(['state.json']);
  });
});

describe('readJsonWithRecovery — fallback to .bak.N on corrupt JSON', () => {
  it('returns the value when the main file is healthy (no warning, no fallback)', async () => {
    const target = join(workdir, 'state.json');
    await writeJsonAtomic(target, { v: 1 }, { rotate: { keep: 3 } });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const value = await readJsonWithRecovery<{ v: number }>(target, { keep: 3 });

    expect(value).toEqual({ v: 1 });
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('returns null when the main file is absent (no recovery — same as readJson)', async () => {
    const target = join(workdir, 'state.json');
    const value = await readJsonWithRecovery<{ v: number }>(target, { keep: 3 });
    expect(value).toBeNull();
  });

  it('falls back to .bak.1 when the main file is unparseable + logs a single warning', async () => {
    const target = join(workdir, 'state.json');
    await writeJsonAtomic(target, { v: 1 }, { rotate: { keep: 3 } });
    await writeJsonAtomic(target, { v: 2 }, { rotate: { keep: 3 } });
    /* Corrupt the main file post-write — simulates a half-flushed write
       or a OneDrive sync that left a torn payload. */
    await writeFile(target, '{ not valid json', 'utf8');

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const value = await readJsonWithRecovery<{ v: number }>(target, { keep: 3 });

    expect(value).toEqual({ v: 1 }); // .bak.1 holds the v1 write (v2 went into target)
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toMatch(/recovered from .*state\.json\.bak\.1/);
    warn.mockRestore();
  });

  it('falls back further to .bak.2 when both main AND .bak.1 are unparseable', async () => {
    const target = join(workdir, 'state.json');
    await writeJsonAtomic(target, { v: 1 }, { rotate: { keep: 3 } });
    await writeJsonAtomic(target, { v: 2 }, { rotate: { keep: 3 } });
    await writeJsonAtomic(target, { v: 3 }, { rotate: { keep: 3 } });
    await writeFile(target, '{ broken', 'utf8');
    await writeFile(`${target}.bak.1`, 'also broken', 'utf8');

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const value = await readJsonWithRecovery<{ v: number }>(target, { keep: 3 });

    expect(value).toEqual({ v: 1 }); // .bak.2 holds the v1 write
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toMatch(/recovered from .*state\.json\.bak\.2/);
    warn.mockRestore();
  });

  it('re-throws the original parse error when every backup is also unreadable', async () => {
    const target = join(workdir, 'state.json');
    await writeJsonAtomic(target, { v: 1 }, { rotate: { keep: 3 } });
    await writeJsonAtomic(target, { v: 2 }, { rotate: { keep: 3 } });
    await writeFile(target, '{ broken', 'utf8');
    await writeFile(`${target}.bak.1`, '{ also broken', 'utf8');

    /* No further backups exist (only one prior write to .bak.1). The
       recovery walker must surface the ORIGINAL main-file error so the
       caller's diagnostics text matches what they'd see without
       recovery — not the bak.1 parse error. Both are JSON.parse
       errors with V8's "Expected property name" wording; the assertion
       only needs to confirm a JSON parse error bubbles out (no silent
       null when nothing was recoverable). */
    await expect(readJsonWithRecovery<{ v: number }>(target, { keep: 3 })).rejects.toThrow(
      /json|expected|unexpected/i,
    );
  });
});

describe('jitteredDelayMs (#915 thundering-herd decorrelation)', () => {
  it('returns the base delay when rand() is 0 (lower bound)', () => {
    expect(jitteredDelayMs(200, () => 0)).toBe(200);
  });

  it('adds up to ~100% jitter as rand() approaches 1 (upper bound)', () => {
    expect(jitteredDelayMs(200, () => 0.5)).toBe(300);
    /* floor(0.999 * 200) = 199 → 399, strictly below 2× so the bound is [base, 2*base). */
    expect(jitteredDelayMs(200, () => 0.999)).toBe(399);
  });

  it('decorrelates equal base delays — two writers on the same schedule get different waits', () => {
    /* The whole point: concurrent retriers must NOT wake in lockstep. Same
       base, different rand() draws → different sleeps → no re-collision. */
    const a = jitteredDelayMs(500, () => 0.1);
    const b = jitteredDelayMs(500, () => 0.8);
    expect(a).not.toBe(b);
    for (const d of [a, b]) {
      expect(d).toBeGreaterThanOrEqual(500);
      expect(d).toBeLessThan(1000);
    }
  });
})
