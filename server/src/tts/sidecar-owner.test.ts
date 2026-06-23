import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  claimSidecarOwnership,
  enforceSingleSidecarOwner,
  findConflictingOwner,
  isProcessAlive,
  readSidecarOwner,
  releaseSidecarOwnership,
  sidecarOwnerPath,
} from './sidecar-owner.js';

let runDir: string;
beforeEach(() => {
  runDir = mkdtempSync(join(tmpdir(), 'sidecar-owner-'));
});
afterEach(() => {
  rmSync(runDir, { recursive: true, force: true });
});

const writeNote = (note: Record<string, unknown>): void =>
  writeFileSync(sidecarOwnerPath(runDir), JSON.stringify(note), 'utf8');

describe('readSidecarOwner', () => {
  it('returns null when the note is absent', () => {
    expect(readSidecarOwner(runDir)).toBeNull();
  });

  it('parses a well-formed note', () => {
    writeNote({ pid: 123, ppid: 99, port: 9000, startedAt: '2026-06-23T00:00:00.000Z' });
    expect(readSidecarOwner(runDir)).toEqual({
      pid: 123,
      ppid: 99,
      port: 9000,
      startedAt: '2026-06-23T00:00:00.000Z',
    });
  });

  it('returns null on corrupt JSON', () => {
    writeFileSync(sidecarOwnerPath(runDir), '{ not json', 'utf8');
    expect(readSidecarOwner(runDir)).toBeNull();
  });

  it('returns null when pid is missing or invalid', () => {
    writeNote({ ppid: 99, port: 9000 });
    expect(readSidecarOwner(runDir)).toBeNull();
    writeNote({ pid: 0, ppid: 99 });
    expect(readSidecarOwner(runDir)).toBeNull();
  });

  it('tolerates a legacy note missing ppid/port (defaults applied)', () => {
    writeNote({ pid: 123 });
    expect(readSidecarOwner(runDir)).toEqual({ pid: 123, ppid: -1, port: 9000, startedAt: '' });
  });
});

describe('isProcessAlive', () => {
  it('returns true for the current process', () => {
    expect(isProcessAlive(process.pid)).toBe(true);
  });

  it('returns false for an obviously-dead pid', () => {
    // A huge pid that no OS will have allocated.
    expect(isProcessAlive(2_147_483_000)).toBe(false);
  });

  it('treats EPERM (exists but not ours) as alive', () => {
    const killFn = vi.fn(() => {
      throw Object.assign(new Error('not permitted'), { code: 'EPERM' });
    }) as unknown as typeof process.kill;
    expect(isProcessAlive(4242, killFn)).toBe(true);
  });

  it('treats ESRCH (no such process) as dead', () => {
    const killFn = vi.fn(() => {
      throw Object.assign(new Error('no such process'), { code: 'ESRCH' });
    }) as unknown as typeof process.kill;
    expect(isProcessAlive(4242, killFn)).toBe(false);
  });

  it('rejects non-positive / non-integer pids without probing', () => {
    const killFn = vi.fn() as unknown as typeof process.kill;
    expect(isProcessAlive(0, killFn)).toBe(false);
    expect(isProcessAlive(-1, killFn)).toBe(false);
    expect(killFn).not.toHaveBeenCalled();
  });
});

describe('claimSidecarOwnership', () => {
  it('writes a round-trippable note with the given identity', () => {
    claimSidecarOwnership({
      runDir,
      pid: 555,
      ppid: 7,
      port: 9000,
      nowIso: () => '2026-06-23T12:00:00.000Z',
    });
    expect(readSidecarOwner(runDir)).toEqual({
      pid: 555,
      ppid: 7,
      port: 9000,
      startedAt: '2026-06-23T12:00:00.000Z',
    });
  });

  it('overwrites a prior note', () => {
    writeNote({ pid: 1, ppid: 1, port: 9000, startedAt: 'old' });
    claimSidecarOwnership({ runDir, pid: 2, ppid: 2, nowIso: () => 'new' });
    expect(readSidecarOwner(runDir)?.pid).toBe(2);
  });
});

describe('releaseSidecarOwnership', () => {
  it('deletes the note when the pid matches', () => {
    claimSidecarOwnership({ runDir, pid: 555, ppid: 7 });
    releaseSidecarOwnership(runDir, 555);
    expect(readSidecarOwner(runDir)).toBeNull();
  });

  it('leaves a note owned by a different pid (lineage took over)', () => {
    claimSidecarOwnership({ runDir, pid: 999, ppid: 7 });
    releaseSidecarOwnership(runDir, 555); // an older lineage process shutting down
    expect(readSidecarOwner(runDir)?.pid).toBe(999);
  });

  it('is a no-op when no note exists', () => {
    expect(() => releaseSidecarOwnership(runDir, 555)).not.toThrow();
  });
});

describe('findConflictingOwner', () => {
  const alive = () => true;
  const dead = () => false;

  it('returns null when there is no note', () => {
    expect(findConflictingOwner({ runDir, pid: 1, ppid: 1, aliveFn: alive })).toBeNull();
  });

  it('returns null for our own pid', () => {
    claimSidecarOwnership({ runDir, pid: 100, ppid: 7 });
    expect(findConflictingOwner({ runDir, pid: 100, ppid: 8, aliveFn: alive })).toBeNull();
  });

  it('returns null for the same lineage (tsx-watch reload: new pid, same ppid)', () => {
    claimSidecarOwnership({ runDir, pid: 100, ppid: 7 });
    expect(findConflictingOwner({ runDir, pid: 200, ppid: 7, aliveFn: alive })).toBeNull();
  });

  it('returns null when the foreign owner is dead', () => {
    claimSidecarOwnership({ runDir, pid: 100, ppid: 7 });
    expect(findConflictingOwner({ runDir, pid: 200, ppid: 8, aliveFn: dead })).toBeNull();
  });

  it('returns the owner when it is live AND a foreign lineage', () => {
    claimSidecarOwnership({ runDir, pid: 100, ppid: 7 });
    const conflict = findConflictingOwner({ runDir, pid: 200, ppid: 8, aliveFn: alive });
    expect(conflict?.pid).toBe(100);
  });
});

describe('enforceSingleSidecarOwner', () => {
  it('claims ownership and returns true when no conflict', () => {
    const log = vi.fn();
    const exit = vi.fn();
    const ok = enforceSingleSidecarOwner({
      runDir,
      pid: 100,
      ppid: 7,
      aliveFn: () => false,
      log,
      exit,
      nowIso: () => 'now',
    });
    expect(ok).toBe(true);
    expect(exit).not.toHaveBeenCalled();
    expect(readSidecarOwner(runDir)).toEqual({ pid: 100, ppid: 7, port: 9000, startedAt: 'now' });
  });

  it('logs an actionable FATAL line and exits(1) on a live foreign owner, WITHOUT clobbering the note', () => {
    claimSidecarOwnership({ runDir, pid: 100, ppid: 7, nowIso: () => 'owner' });
    const log = vi.fn();
    const exit = vi.fn();
    const ok = enforceSingleSidecarOwner({
      runDir,
      pid: 200,
      ppid: 8,
      aliveFn: () => true,
      log,
      exit,
    });
    expect(ok).toBe(false);
    expect(exit).toHaveBeenCalledWith(1);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('already owns the TTS'));
    expect(log).toHaveBeenCalledWith(expect.stringContaining('pid 100'));
    // The incumbent owner's note must survive — we refused, we did not take over.
    expect(readSidecarOwner(runDir)).toEqual({
      pid: 100,
      ppid: 7,
      port: 9000,
      startedAt: 'owner',
    });
  });

  it('takes over (claims) when the existing owner is dead', () => {
    claimSidecarOwnership({ runDir, pid: 100, ppid: 7 });
    const exit = vi.fn();
    const ok = enforceSingleSidecarOwner({
      runDir,
      pid: 200,
      ppid: 8,
      aliveFn: () => false,
      log: vi.fn(),
      exit,
      nowIso: () => 'fresh',
    });
    expect(ok).toBe(true);
    expect(exit).not.toHaveBeenCalled();
    expect(readSidecarOwner(runDir)?.pid).toBe(200);
  });

  it('takes over on a same-lineage reload (tsx watch)', () => {
    claimSidecarOwnership({ runDir, pid: 100, ppid: 7 });
    const exit = vi.fn();
    const ok = enforceSingleSidecarOwner({
      runDir,
      pid: 200,
      ppid: 7, // same parent → same stack restarting
      aliveFn: () => true,
      log: vi.fn(),
      exit,
      nowIso: () => 'reload',
    });
    expect(ok).toBe(true);
    expect(exit).not.toHaveBeenCalled();
    expect(readSidecarOwner(runDir)?.pid).toBe(200);
  });
});
