/* #2015 §3a — the baseline-advance rule. The "no conflicts on an uncontended
   run" test below is the negative control the first draft of the design
   lacked: without it, a detector that fires unconditionally passes every
   other test in this file. */
import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { castJsonPath } from './paths.js';
import { readJsonWithFingerprint, fingerprintOfWrite } from './cast-fingerprint.js';
import { createCastMergeBase } from './cast-merge-base.js';

function makeBookDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'castwright-merge-base-'));
  mkdirSync(join(dir, '.audiobook'), { recursive: true });
  return dir;
}

async function captureOf(dir: string): Promise<string | null> {
  const got = await readJsonWithFingerprint(castJsonPath(dir));
  return typeof got.fingerprint === 'string' && got.value !== null ? got.fingerprint : null;
}

describe('createCastMergeBase — the negative control (design §3a)', () => {
  it('an uncontended multi-chapter run emits ZERO conflicts across many writes', async () => {
    const dir = makeBookDir();
    try {
      writeFileSync(castJsonPath(dir), JSON.stringify({ characters: [{ id: 'a' }] }, null, 2));
      const base = createCastMergeBase(dir, await captureOf(dir));
      const onConflict = vi.fn();

      /* Six writes: two per-chapter interim writes repeated, then stage1,
         then final — the shape a 3-chapter book actually produces. Two of the
         five real sites are INSIDE per-chapter loops, so a single-write test
         cannot observe a stale-baseline false positive at all. */
      for (let chapter = 1; chapter <= 3; chapter++) {
        await base.writeChecked({ characters: [{ id: 'a', chapter }] }, onConflict);
      }
      await base.writeChecked({ characters: [{ id: 'a' }, { id: 'b' }] }, onConflict);
      await base.writeChecked({ characters: [{ id: 'a' }, { id: 'b' }, { id: 'c' }] }, onConflict);
      await base.writeChecked({ characters: [{ id: 'final' }] }, onConflict);

      expect(onConflict).not.toHaveBeenCalled();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('an uncontended START-FRESH run emits ZERO conflicts (the ABSENT baseline)', async () => {
    const dir = makeBookDir();
    try {
      writeFileSync(castJsonPath(dir), JSON.stringify({ characters: [{ id: 'prior' }] }, null, 2));
      /* Capture happens BEFORE the fresh block's rm, deliberately — the rows
         must survive the delete (analysis.ts:2846-2847). */
      const base = createCastMergeBase(dir, await captureOf(dir));

      await rm(castJsonPath(dir), { force: true });
      base.markDeleted();

      const onConflict = vi.fn();
      await base.writeChecked({ characters: [{ id: 'fresh1' }] }, onConflict);
      await base.writeChecked({ characters: [{ id: 'fresh2' }] }, onConflict);

      expect(onConflict).not.toHaveBeenCalled();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a fresh run still DETECTS a foreign write — markDeleted sets ABSENT, never null', async () => {
    const dir = makeBookDir();
    try {
      writeFileSync(castJsonPath(dir), JSON.stringify({ characters: [{ id: 'prior' }] }, null, 2));
      const base = createCastMergeBase(dir, await captureOf(dir));
      await rm(castJsonPath(dir), { force: true });
      base.markDeleted();

      /* The whole point of the three-state model. `ABSENT` means "no file is
         expected right now" and detection stays LIVE; `null` means "cannot
         check" and detection is dead for the rest of the run. Both produce
         zero conflicts on an uncontended fresh run, so every other test in
         this file passes either way — this is the only one that separates
         them. */
      expect(base.enabled).toBe(true);

      // A foreign writer lands before this run's first write.
      writeFileSync(castJsonPath(dir), JSON.stringify({ characters: [{ id: 'foreign' }] }, null, 2));
      const onConflict = vi.fn();
      await base.writeChecked({ characters: [{ id: 'fresh1' }] }, onConflict);

      expect(onConflict).toHaveBeenCalledTimes(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('WITHOUT markDeleted a fresh run would false-positive — proving the reset is load-bearing', async () => {
    const dir = makeBookDir();
    try {
      writeFileSync(castJsonPath(dir), JSON.stringify({ characters: [{ id: 'prior' }] }, null, 2));
      const base = createCastMergeBase(dir, await captureOf(dir));
      await rm(castJsonPath(dir), { force: true });
      // markDeleted() deliberately NOT called.

      const onConflict = vi.fn();
      await base.writeChecked({ characters: [{ id: 'fresh1' }] }, onConflict);
      expect(onConflict).toHaveBeenCalledTimes(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('createCastMergeBase — the positive control', () => {
  it('detects a foreign write landing between two of this run\'s writes', async () => {
    const dir = makeBookDir();
    try {
      writeFileSync(castJsonPath(dir), JSON.stringify({ characters: [{ id: 'a' }] }, null, 2));
      const base = createCastMergeBase(dir, await captureOf(dir));
      const onConflict = vi.fn();

      await base.writeChecked({ characters: [{ id: 'a' }] }, onConflict);
      expect(onConflict).not.toHaveBeenCalled();

      // A foreign writer lands.
      writeFileSync(castJsonPath(dir), JSON.stringify({ characters: [{ id: 'foreign' }] }, null, 2));

      await base.writeChecked({ characters: [{ id: 'b' }] }, onConflict);
      expect(onConflict).toHaveBeenCalledTimes(1);
      const conflict = onConflict.mock.calls[0][0];
      expect(conflict.expected).not.toBe(conflict.observed);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reports a conflict ONCE, not on every subsequent write (the baseline advances through it)', async () => {
    const dir = makeBookDir();
    try {
      writeFileSync(castJsonPath(dir), JSON.stringify({ characters: [{ id: 'a' }] }, null, 2));
      const base = createCastMergeBase(dir, await captureOf(dir));
      const onConflict = vi.fn();

      writeFileSync(castJsonPath(dir), JSON.stringify({ characters: [{ id: 'foreign' }] }, null, 2));
      await base.writeChecked({ characters: [{ id: 'b' }] }, onConflict);
      await base.writeChecked({ characters: [{ id: 'c' }] }, onConflict);
      await base.writeChecked({ characters: [{ id: 'd' }] }, onConflict);

      expect(onConflict).toHaveBeenCalledTimes(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('still writes on conflict — merge behaviour is unchanged (design §4)', async () => {
    const dir = makeBookDir();
    try {
      writeFileSync(castJsonPath(dir), JSON.stringify({ characters: [{ id: 'a' }] }, null, 2));
      const base = createCastMergeBase(dir, await captureOf(dir));
      writeFileSync(castJsonPath(dir), JSON.stringify({ characters: [{ id: 'foreign' }] }, null, 2));

      await base.writeChecked({ characters: [{ id: 'ours' }] }, vi.fn());

      const after = await readJsonWithFingerprint<{ characters: Array<{ id: string }> }>(
        castJsonPath(dir),
      );
      expect(after.value?.characters.map((c) => c.id)).toEqual(['ours']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('createCastMergeBase — detection disabled (fingerprint: null)', () => {
  it('a carryover-sourced run never reports a conflict, even against a foreign write', async () => {
    const dir = makeBookDir();
    try {
      const base = createCastMergeBase(dir, null);
      expect(base.enabled).toBe(false);
      const onConflict = vi.fn();

      writeFileSync(castJsonPath(dir), JSON.stringify({ characters: [{ id: 'foreign' }] }, null, 2));
      await base.writeChecked({ characters: [{ id: 'ours' }] }, onConflict);

      expect(onConflict).not.toHaveBeenCalled();
      expect(base.value).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('markDeleted does NOT promote a disabled baseline to ABSENT', async () => {
    const dir = makeBookDir();
    try {
      const base = createCastMergeBase(dir, null);
      base.markDeleted();
      expect(base.value).toBeNull();
      expect(base.enabled).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('the write still lands with detection disabled', async () => {
    const dir = makeBookDir();
    try {
      const base = createCastMergeBase(dir, null);
      await base.writeChecked({ characters: [{ id: 'ours' }] }, vi.fn());
      expect(existsSync(castJsonPath(dir))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('createCastMergeBase — serialisation', () => {
  it('two concurrent writeChecked calls do not interleave read-compare-write', async () => {
    const dir = makeBookDir();
    try {
      writeFileSync(castJsonPath(dir), JSON.stringify({ characters: [{ id: 'a' }] }, null, 2));
      const a = createCastMergeBase(dir, await captureOf(dir));
      const b = createCastMergeBase(dir, await captureOf(dir));

      /* Both runs start from the same baseline. Serialised, exactly ONE of
         them observes the other's write and reports. If the hold did not
         cover read-compare-write, both could read the original and neither
         would report. Asserting the OUTCOME (someone noticed), never that a
         withCastLock token appears at a call site. */
      const conflicts: string[] = [];
      await Promise.all([
        a.writeChecked({ characters: [{ id: 'a2' }] }, () => conflicts.push('a')),
        b.writeChecked({ characters: [{ id: 'b2' }] }, () => conflicts.push('b')),
      ]);

      expect(conflicts).toHaveLength(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
