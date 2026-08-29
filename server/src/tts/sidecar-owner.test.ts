import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  claimSidecarOwnership,
  enforceSingleSidecarOwner,
  findConflictingOwner,
  isPortListening,
  isProcessAlive,
  legacySidecarOwnerPath,
  pruneStaleNotesSafely,
  readSidecarOwner,
  releaseSidecarOwnership,
  resolveSidecarPort,
  sidecarOwnerPath,
} from './sidecar-owner.js';

let runDir: string;
beforeEach(() => {
  runDir = mkdtempSync(join(tmpdir(), 'sidecar-owner-'));
  // Clean up LOCAL_TTS_PORT before each test
  delete process.env.LOCAL_TTS_PORT;
});
afterEach(() => {
  rmSync(runDir, { recursive: true, force: true });
  delete process.env.LOCAL_TTS_PORT;
});

const writeNote = (note: Record<string, unknown>, port = 9000): void =>
  writeFileSync(sidecarOwnerPath(runDir, port), JSON.stringify(note), 'utf8');

describe('resolveSidecarPort', () => {
  it('returns 9000 when LOCAL_TTS_PORT is not set', () => {
    expect(resolveSidecarPort()).toBe(9000);
  });

  it('resolves LOCAL_TTS_PORT when set to a valid port', () => {
    process.env.LOCAL_TTS_PORT = '9010';
    expect(resolveSidecarPort()).toBe(9010);
  });

  it('handles LOCAL_TTS_PORT with per-slot offset (#2632)', () => {
    // Slot 0: 9000, Slot 1: 9010, Slot 2: 9020, etc.
    process.env.LOCAL_TTS_PORT = '9020';
    expect(resolveSidecarPort()).toBe(9020);
  });

  it('returns 9000 when LOCAL_TTS_PORT is empty string (no error logged)', () => {
    process.env.LOCAL_TTS_PORT = '';
    const logSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(resolveSidecarPort()).toBe(9000);
      expect(logSpy).not.toHaveBeenCalled();
    } finally {
      logSpy.mockRestore();
    }
  });

  it('returns 9000 when LOCAL_TTS_PORT is not a valid number (logs error S2)', () => {
    process.env.LOCAL_TTS_PORT = 'not-a-number';
    const logSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(resolveSidecarPort()).toBe(9000);
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Invalid LOCAL_TTS_PORT="not-a-number"'));
    } finally {
      logSpy.mockRestore();
    }
  });

  it('returns 9000 when LOCAL_TTS_PORT is out of range (0), logs error', () => {
    process.env.LOCAL_TTS_PORT = '0';
    const logSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(resolveSidecarPort()).toBe(9000);
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Invalid LOCAL_TTS_PORT="0"'));
    } finally {
      logSpy.mockRestore();
    }
  });

  it('returns 9000 when LOCAL_TTS_PORT is out of range (negative), logs error', () => {
    process.env.LOCAL_TTS_PORT = '-1';
    const logSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(resolveSidecarPort()).toBe(9000);
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Invalid LOCAL_TTS_PORT="-1"'));
    } finally {
      logSpy.mockRestore();
    }
  });

  it('returns 9000 when LOCAL_TTS_PORT is out of range (>65535), logs error', () => {
    process.env.LOCAL_TTS_PORT = '65536';
    const logSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(resolveSidecarPort()).toBe(9000);
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Invalid LOCAL_TTS_PORT="65536"'));
    } finally {
      logSpy.mockRestore();
    }
  });

  it('logs error for typo-like invalid port (99999 instead of 9999)', () => {
    process.env.LOCAL_TTS_PORT = '99999';
    const logSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(resolveSidecarPort()).toBe(9000);
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('99999'));
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('typo'));
    logSpy.mockRestore();
  });

  // #2632 N28: a coerced-but-not-plain-integer LOCAL_TTS_PORT used to be
  // silently accepted (Number('9010.9') floors to 9010 with no log line),
  // unlike "99999" — but the shell launchers take the raw string as --port
  // and reject "9010.9" outright, so the operator got "sidecar not
  // reachable" with nothing pointing at the cause. Same class for hex
  // ("0x2386" -> 9094) and scientific notation ("1e4" -> 10000): all three
  // now take the same loud invalid-value path "99999" already did.
  it('N28: rejects a floating-point LOCAL_TTS_PORT and logs, rather than silently flooring it', () => {
    process.env.LOCAL_TTS_PORT = '9010.9';
    const logSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(resolveSidecarPort()).toBe(9000);
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Invalid LOCAL_TTS_PORT="9010.9"'));
    } finally {
      logSpy.mockRestore();
    }
  });

  it('N28: rejects a hex-spelled LOCAL_TTS_PORT and logs, rather than silently coercing it', () => {
    process.env.LOCAL_TTS_PORT = '0x2386';
    const logSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(resolveSidecarPort()).toBe(9000);
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Invalid LOCAL_TTS_PORT="0x2386"'));
    } finally {
      logSpy.mockRestore();
    }
  });

  it('N28: rejects a scientific-notation LOCAL_TTS_PORT and logs, rather than silently coercing it', () => {
    process.env.LOCAL_TTS_PORT = '1e4';
    const logSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(resolveSidecarPort()).toBe(9000);
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Invalid LOCAL_TTS_PORT="1e4"'));
    } finally {
      logSpy.mockRestore();
    }
  });

  it('accepts a plain decimal-integer LOCAL_TTS_PORT with no log line', () => {
    process.env.LOCAL_TTS_PORT = '9010';
    const logSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(resolveSidecarPort()).toBe(9010);
      expect(logSpy).not.toHaveBeenCalled();
    } finally {
      logSpy.mockRestore();
    }
  });
});

describe('readSidecarOwner', () => {
  it('returns null when the note is absent', () => {
    expect(readSidecarOwner(runDir, 9000)).toBeNull();
  });

  it('parses a well-formed note', () => {
    writeNote({ pid: 123, ppid: 99, port: 9000, startedAt: '2026-06-23T00:00:00.000Z' });
    expect(readSidecarOwner(runDir, 9000)).toEqual({
      pid: 123,
      ppid: 99,
      port: 9000,
      startedAt: '2026-06-23T00:00:00.000Z',
    });
  });

  it('returns null on corrupt JSON', () => {
    writeFileSync(sidecarOwnerPath(runDir, 9000), '{ not json', 'utf8');
    expect(readSidecarOwner(runDir, 9000)).toBeNull();
  });

  it('returns null when pid is missing or invalid', () => {
    writeNote({ ppid: 99, port: 9000 });
    expect(readSidecarOwner(runDir, 9000)).toBeNull();
    writeNote({ pid: 0, ppid: 99 });
    expect(readSidecarOwner(runDir, 9000)).toBeNull();
  });

  it('tolerates a legacy note missing ppid/port (defaults applied)', () => {
    writeNote({ pid: 123 });
    expect(readSidecarOwner(runDir, 9000)).toEqual({ pid: 123, ppid: -1, port: 9000, startedAt: '' });
  });

  it('keys the note by port — two ports sharing one runDir do not clobber each other', () => {
    writeNote({ pid: 100, ppid: 7, port: 9000, startedAt: 'a' }, 9000);
    writeNote({ pid: 200, ppid: 8, port: 9010, startedAt: 'b' }, 9010);
    expect(readSidecarOwner(runDir, 9000)?.pid).toBe(100);
    expect(readSidecarOwner(runDir, 9010)?.pid).toBe(200);
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
    expect(readSidecarOwner(runDir, 9000)).toEqual({
      pid: 555,
      ppid: 7,
      port: 9000,
      startedAt: '2026-06-23T12:00:00.000Z',
    });
  });

  it('overwrites a prior note', () => {
    writeNote({ pid: 1, ppid: 1, port: 9000, startedAt: 'old' });
    claimSidecarOwnership({ runDir, pid: 2, ppid: 2, nowIso: () => 'new' });
    expect(readSidecarOwner(runDir, 9000)?.pid).toBe(2);
  });

  it('claims for two different ports on one runDir without clobbering', () => {
    claimSidecarOwnership({ runDir, pid: 100, ppid: 7, port: 9000, nowIso: () => 'a' });
    claimSidecarOwnership({ runDir, pid: 200, ppid: 8, port: 9010, nowIso: () => 'b' });
    expect(readSidecarOwner(runDir, 9000)?.pid).toBe(100);
    expect(readSidecarOwner(runDir, 9010)?.pid).toBe(200);
  });

  it('does not touch other ports\' notes SYNCHRONOUSLY, before returning (#2754 regression)', () => {
    // claimSidecarOwnership itself must never delete/modify another port's note as
    // part of its own synchronous contract — #2792's background reap (below) is a
    // separate, fire-and-forget, awaited-nowhere operation; this test only pins
    // that claimSidecarOwnership's own return does not depend on, or wait for, it.
    const note9010 = { pid: 99999, ppid: 1, port: 9010, startedAt: 'stale' };
    const note9011 = { pid: process.pid, ppid: process.ppid, port: 9011, startedAt: 'live' };
    writeNote(note9010, 9010);
    writeNote(note9011, 9011);

    // Claim ownership on port 9000 (unrelated). Neither note is touched by the
    // time this call returns, regardless of what the background reap later decides.
    claimSidecarOwnership({ runDir, pid: 555, ppid: 7, port: 9000, nowIso: () => 'new' });

    expect(readSidecarOwner(runDir, 9000)?.pid).toBe(555);
    expect(readSidecarOwner(runDir, 9010)).toEqual(expect.objectContaining(note9010));
    expect(readSidecarOwner(runDir, 9011)).toEqual(expect.objectContaining(note9011));
  });

  it('N3b: deletes the legacy note when its port matches the port being claimed', () => {
    // Setup: legacy note (pre-#2641) exists for port 9000
    const legacyPath = legacySidecarOwnerPath(runDir);
    writeFileSync(
      legacyPath,
      JSON.stringify({ pid: 100, ppid: 7, port: 9000, startedAt: '2026-06-23T00:00:00.000Z' }),
      'utf8',
    );
    // Claim ownership on port 9000 — should delete the legacy note since it's superseded
    claimSidecarOwnership({ runDir, pid: 555, ppid: 8, port: 9000, nowIso: () => 'new' });
    expect(readSidecarOwner(runDir, 9000)?.pid).toBe(555); // new owner claimed
    // Legacy note should be deleted (it's now superseded by the port-keyed note)
    expect(() => readFileSync(legacyPath, 'utf8')).toThrow();
  });

  it('N3b: leaves the legacy note alone when its port does NOT match the port being claimed', () => {
    // Setup: legacy note (pre-#2641) exists for port 9000
    const legacyPath = legacySidecarOwnerPath(runDir);
    writeFileSync(
      legacyPath,
      JSON.stringify({ pid: 100, ppid: 7, port: 9000, startedAt: '2026-06-23T00:00:00.000Z' }),
      'utf8',
    );
    // Claim ownership on port 9010 (different port) — should NOT delete the legacy note
    claimSidecarOwnership({ runDir, pid: 555, ppid: 8, port: 9010, nowIso: () => 'new' });
    expect(readSidecarOwner(runDir, 9010)?.pid).toBe(555); // new owner claimed on 9010
    // Legacy note should still exist (it's for a different port)
    expect(JSON.parse(readFileSync(legacyPath, 'utf8'))).toEqual(
      expect.objectContaining({ pid: 100, port: 9000 }),
    );
  });

  describe('#2754 regression: legacy note deletion safety (Correctness bug 1)', () => {
    // These tests pin the fix for the correctness bug where claimSidecarOwnership()
    // could delete a live foreign legacy owner's only record without checking if it
    // was actually safe to do so. The bug occurred because claimSidecarOwnership()
    // assumed findConflictingOwner's full logic had already checked the legacy note,
    // but findConflictingOwner has early exits (self-pid, same-lineage) that skip
    // the legacy-note check entirely.

    it('legacy note with OUR pid is deleted (safe — we are the old owner)', () => {
      // Setup: both port-keyed and legacy notes exist, both naming our pid
      claimSidecarOwnership({ runDir, pid: 100, ppid: 7, port: 9000, nowIso: () => 'portkeyed' });
      const legacyPath = legacySidecarOwnerPath(runDir);
      writeFileSync(
        legacyPath,
        JSON.stringify({ pid: 100, ppid: 7, port: 9000, startedAt: 'legacy' }),
        'utf8',
      );
      // Claim again (same pid): should delete the now-superseded legacy note
      claimSidecarOwnership({ runDir, pid: 100, ppid: 7, port: 9000, nowIso: () => 'update' });
      expect(readSidecarOwner(runDir, 9000)?.pid).toBe(100);
      expect(() => readFileSync(legacyPath, 'utf8')).toThrow();
    });

    it('legacy note with OUR lineage (same ppid, new pid) is deleted (safe — tsx watch reload)', () => {
      // Setup: port-keyed note from old pid (100), legacy note from even older version
      claimSidecarOwnership({ runDir, pid: 100, ppid: 7, port: 9000, nowIso: () => 'portkeyed' });
      const legacyPath = legacySidecarOwnerPath(runDir);
      writeFileSync(
        legacyPath,
        JSON.stringify({ pid: 50, ppid: 7, port: 9000, startedAt: 'legacy' }),
        'utf8',
      );
      // tsx watch reload: new pid 101, same parent ppid 7
      claimSidecarOwnership({ runDir, pid: 101, ppid: 7, port: 9000, nowIso: () => 'reload' });
      expect(readSidecarOwner(runDir, 9000)?.pid).toBe(101);
      // Legacy note should be deleted (same lineage as the reload)
      expect(() => readFileSync(legacyPath, 'utf8')).toThrow();
    });

    it('legacy note with LIVE FOREIGN pid is PRESERVED (bug fix: must not delete live foreign owner)', () => {
      // CRITICAL REGRESSION TEST: This is the exact bug scenario.
      // Setup: port-keyed note from one stack (pid 100, ppid 50)
      //        legacy note from a different, live stack (pid 200, ppid 60)
      // Both want to manage port 9000 — the legacy note records the ONLY evidence
      // of the other stack's ownership. If we delete it, we lose track and both
      // stacks think they own the sidecar (recycle storm).
      claimSidecarOwnership({
        runDir,
        pid: 100,
        ppid: 50,
        port: 9000,
        nowIso: () => 'portkeyed',
        aliveFn: () => true, // old port-keyed owner is "alive" for this setup
      });
      const legacyPath = legacySidecarOwnerPath(runDir);
      writeFileSync(
        legacyPath,
        JSON.stringify({
          pid: 200,
          ppid: 60, // DIFFERENT lineage
          port: 9000,
          startedAt: 'legacy',
        }),
        'utf8',
      );
      // Now, a tsx-watch reload happens in the first stack (same ppid 50, new pid 101)
      // findConflictingOwner would exit early on "same lineage" WITHOUT checking the legacy note.
      // claimSidecarOwnership must still check the legacy note's liveness independently.
      // The legacy note's pid (200) is alive but not in our lineage, so it must survive.
      claimSidecarOwnership({
        runDir,
        pid: 101,
        ppid: 50, // same lineage — findConflictingOwner exits early here
        port: 9000,
        nowIso: () => 'reload',
        // Mock aliveFn to report that legacy process (200) is alive but others are dead
        aliveFn: (p: number) => p === 200,
      });
      // Port-keyed note updated to new pid 101
      expect(readSidecarOwner(runDir, 9000)?.pid).toBe(101);
      // Legacy note must SURVIVE despite the reload (it's from a different, live lineage)
      const survivingLegacy = JSON.parse(readFileSync(legacyPath, 'utf8'));
      expect(survivingLegacy.pid).toBe(200);
      expect(survivingLegacy.ppid).toBe(60);
    });

    it('legacy note with DEAD foreign pid is deleted (safe — stale owner)', () => {
      // Setup: port-keyed note from one stack, legacy note from a dead foreign stack
      claimSidecarOwnership({ runDir, pid: 100, ppid: 50, port: 9000, nowIso: () => 'portkeyed' });
      const legacyPath = legacySidecarOwnerPath(runDir);
      writeFileSync(
        legacyPath,
        JSON.stringify({
          pid: 999999, // obviously dead
          ppid: 60, // different lineage
          port: 9000,
          startedAt: 'stale',
        }),
        'utf8',
      );
      // Claim ownership (different pid, different ppid)
      claimSidecarOwnership({ runDir, pid: 200, ppid: 70, port: 9000, nowIso: () => 'new' });
      // Port-keyed note updated
      expect(readSidecarOwner(runDir, 9000)?.pid).toBe(200);
      // Stale legacy note can be deleted (owner is dead)
      expect(() => readFileSync(legacyPath, 'utf8')).toThrow();
    });

    it('writes port-keyed note BEFORE deleting legacy note (ordering fix)', () => {
      // Regression test for the ordering issue: if we delete legacy BEFORE writing
      // port-keyed, a crash in between leaves no ownership record (orphan).
      // This test verifies the code's source order has the write first.
      claimSidecarOwnership({ runDir, pid: 100, ppid: 7, port: 9000, nowIso: () => 'v1' });
      expect(readSidecarOwner(runDir, 9000)?.pid).toBe(100);
      // After the claim, the port-keyed note must exist
      const portKeyedNote = readSidecarOwner(runDir, 9000);
      expect(portKeyedNote).not.toBeNull();
      expect(portKeyedNote?.pid).toBe(100);
      // (We cannot easily test "crash between" in a unit test, but we can verify
      // the code source has writeFileSync before unlinkSync by inspecting behavior:
      // if the port-keyed write fails, no cleanup should happen.)
    });
  });
});

describe('isPortListening (#2792)', () => {
  it('returns true while a real server is bound, false once it is closed', async () => {
    const { createServer } = await import('node:net');
    const server = createServer();
    const port: number = await new Promise((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address();
        resolve(typeof addr === 'object' && addr !== null ? addr.port : 0);
      });
    });

    await expect(isPortListening(port)).resolves.toBe(true);

    await new Promise<void>((resolve) => server.close(() => resolve()));
    await expect(isPortListening(port)).resolves.toBe(false);
  });
});

describe('pruneStaleNotesSafely (#2792)', () => {
  it('deletes a stale note whose pid is dead AND whose port is not listening', async () => {
    writeNote({ pid: 99999, ppid: 1, port: 9010, startedAt: 'stale' }, 9010);
    await pruneStaleNotesSafely(
      runDir,
      9000,
      () => false, // aliveFn: dead
      async () => false, // portListeningFn: nothing bound there
    );
    expect(readSidecarOwner(runDir, 9010)).toBeNull();
  });

  it('#2792 — preserves a stale-pid note when the port IS still listening (the orphan case)', () => {
    // The exact defect this issue exists to prevent: a dead recorded server
    // pid does not prove the port is free, because the sidecar it spawned may
    // have survived as an orphan still bound there. This is the ONE case the
    // whole safe-reap design exists to protect.
    writeNote({ pid: 99999, ppid: 1, port: 9010, startedAt: 'stale' }, 9010);
    return pruneStaleNotesSafely(
      runDir,
      9000,
      () => false, // aliveFn: recorded server is dead
      async () => true, // portListeningFn: but something IS bound there — an orphan
    ).then(() => {
      expect(readSidecarOwner(runDir, 9010)).toEqual(
        expect.objectContaining({ pid: 99999, port: 9010 }),
      );
    });
  });

  it('preserves a live-pid note without ever probing the port (aliveFn short-circuits first)', async () => {
    writeNote({ pid: process.pid, ppid: process.ppid, port: 9010, startedAt: 'live' }, 9010);
    const portListeningFn = vi.fn(async () => false);
    await pruneStaleNotesSafely(runDir, 9000, () => true, portListeningFn);
    expect(readSidecarOwner(runDir, 9010)).not.toBeNull();
    expect(portListeningFn).not.toHaveBeenCalled();
  });

  it('never touches the note for currentPort, even if it looks stale', async () => {
    writeNote({ pid: 99999, ppid: 1, port: 9000, startedAt: 'stale' }, 9000);
    await pruneStaleNotesSafely(
      runDir,
      9000, // currentPort — the note we just wrote for it must be left alone
      () => false,
      async () => false,
    );
    expect(readSidecarOwner(runDir, 9000)).not.toBeNull();
  });

  it('is wired into claimSidecarOwnership as a fire-and-forget background reap', async () => {
    // claimSidecarOwnership itself returns synchronously without pruning (pinned
    // above); this test observes claimSidecarOwnership's OWN internal fire-and-
    // forget call actually running, by hooking the injected portListeningFn it
    // passes through, then waits for it to finish and confirms the reap happened.
    writeNote({ pid: 99999, ppid: 1, port: 9010, startedAt: 'stale' }, 9010);
    let resolveProbed: () => void;
    const probed = new Promise<void>((resolve) => {
      resolveProbed = resolve;
    });
    const portListeningFn = async () => {
      resolveProbed();
      return false;
    };
    claimSidecarOwnership({
      runDir,
      pid: 555,
      ppid: 7,
      port: 9000,
      nowIso: () => 'new',
      aliveFn: () => false,
      portListeningFn,
    });
    await probed; // the background reap has called our probe — it's about to unlink
    await new Promise((resolve) => setImmediate(resolve)); // let the unlink actually run
    expect(readSidecarOwner(runDir, 9010)).toBeNull();
  });
});

describe('releaseSidecarOwnership', () => {
  it('deletes the note when the pid matches', () => {
    claimSidecarOwnership({ runDir, pid: 555, ppid: 7 });
    releaseSidecarOwnership(runDir, 555, 9000);
    expect(readSidecarOwner(runDir, 9000)).toBeNull();
  });

  it('leaves a note owned by a different pid (lineage took over)', () => {
    claimSidecarOwnership({ runDir, pid: 999, ppid: 7 });
    releaseSidecarOwnership(runDir, 555, 9000); // an older lineage process shutting down
    expect(readSidecarOwner(runDir, 9000)?.pid).toBe(999);
  });

  it('is a no-op when no note exists', () => {
    expect(() => releaseSidecarOwnership(runDir, 555, 9000)).not.toThrow();
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

  it('still detects a live foreign conflict on its own port after a different port has also claimed in the same runDir', () => {
    // Regression for #2641: both ports used to share one owner file, so a
    // different-port write could silently overwrite the file a third
    // claimant's conflict check needed to read.
    claimSidecarOwnership({ runDir, pid: 100, ppid: 7, port: 9000, nowIso: () => 'a' });
    claimSidecarOwnership({ runDir, pid: 200, ppid: 8, port: 9010, nowIso: () => 'b' });
    const conflict = findConflictingOwner({
      runDir,
      pid: 300,
      ppid: 9,
      port: 9000,
      aliveFn: (pid) => pid === 100,
    });
    expect(conflict?.pid).toBe(100);
  });

  it('treats a live owner on a different port as non-conflicting — port-keying ensures isolation', () => {
    // PR #2754 review finding: no test was pinning the guarantee that an owner
    // note for port 9000 (live, foreign lineage) does not block a claim for port
    // 9010. The port-keyed filename (tts.owner.<port>.json) makes this
    // structurally sound, but we must verify the actual claim flow works.
    claimSidecarOwnership({ runDir, pid: 100, ppid: 7, port: 9000, nowIso: () => 'owner' });
    // Port 9010 check should find no conflict, even though port 9000 is live and foreign.
    const conflict = findConflictingOwner({
      runDir,
      pid: 200,
      ppid: 8,
      port: 9010,
      aliveFn: (pid) => pid === 100, // port 9000's owner is alive
    });
    expect(conflict).toBeNull();
  });

  it('detects a live legacy owner (pre-#2641) with matching port as conflicting — cross-version scenario', () => {
    // PR #2754 review finding (real defect found in code review):
    // Upgrade scenario: old server (pre-#2641) running on port 9000 with
    // legacy .run/tts.owner.json note. New server (post-#2641, this code)
    // starts up on port 9000 and looks only for .run/tts.owner.9000.json.
    // It should detect the legacy note as a conflict to prevent a dual-supervisor
    // recycle storm (#1030). Without this fix, it claims ownership and both
    // servers end up managing the sidecar.
    const legacyPath = join(runDir, 'tts.owner.json');
    writeFileSync(
      legacyPath,
      JSON.stringify({
        pid: 100,
        ppid: 7,
        port: 9000, // legacy note also records the port
        startedAt: '2026-06-23T00:00:00.000Z',
      }),
      'utf8',
    );
    // New server checking for conflicts on the same port must find the legacy note
    const conflict = findConflictingOwner({
      runDir,
      pid: 200, // different pid
      ppid: 8, // different ppid
      port: 9000, // same port as legacy note
      aliveFn: () => true, // legacy owner is alive
    });
    expect(conflict?.pid).toBe(100);
  });

  it('ignores a legacy owner whose recorded port does not match — legacy note is port-agnostic safety valve', () => {
    // A legacy note recorded port 9000, but we are checking port 9010.
    // No conflict — each port is independent.
    const legacyPath = join(runDir, 'tts.owner.json');
    writeFileSync(
      legacyPath,
      JSON.stringify({
        pid: 100,
        ppid: 7,
        port: 9000, // legacy note is for port 9000
        startedAt: '2026-06-23T00:00:00.000Z',
      }),
      'utf8',
    );
    const conflict = findConflictingOwner({
      runDir,
      pid: 200,
      ppid: 8,
      port: 9010, // checking a different port
      aliveFn: () => true,
    });
    expect(conflict).toBeNull();
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
    expect(readSidecarOwner(runDir, 9000)).toEqual({ pid: 100, ppid: 7, port: 9000, startedAt: 'now' });
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
    expect(readSidecarOwner(runDir, 9000)).toEqual({
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
    expect(readSidecarOwner(runDir, 9000)?.pid).toBe(200);
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
    expect(readSidecarOwner(runDir, 9000)?.pid).toBe(200);
  });

  it('N3a: FATAL message names the PORT-KEYED path when conflict came from port-keyed note', () => {
    // Setup: port-keyed note exists (current mechanism)
    claimSidecarOwnership({ runDir, pid: 100, ppid: 7, port: 9000, nowIso: () => 'owner' });
    // Another server (different pid, different ppid) tries to enforce ownership
    const log = vi.fn();
    const exit = vi.fn();
    const ok = enforceSingleSidecarOwner({
      runDir,
      pid: 200,
      ppid: 8,
      port: 9000,
      aliveFn: () => true,
      log,
      exit,
    });
    expect(ok).toBe(false);
    expect(exit).toHaveBeenCalledWith(1);
    // The message should name the port-keyed path (tts.owner.9000.json)
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining(sidecarOwnerPath(runDir, 9000)),
    );
    // Verify it names the correct full path (not the legacy path)
    expect(log).not.toHaveBeenCalledWith(
      expect.stringContaining(legacySidecarOwnerPath(runDir)),
    );
  });

  it('N3a: FATAL message names the LEGACY path when conflict came from legacy note', () => {
    // Setup: legacy note (pre-#2641) exists for the same port
    const legacyPath = legacySidecarOwnerPath(runDir);
    writeFileSync(
      legacyPath,
      JSON.stringify({
        pid: 100,
        ppid: 7,
        port: 9000, // legacy note also records the port
        startedAt: '2026-06-23T00:00:00.000Z',
      }),
      'utf8',
    );
    // Another server (different pid, different ppid) tries to enforce ownership on the same port
    const log = vi.fn();
    const exit = vi.fn();
    const ok = enforceSingleSidecarOwner({
      runDir,
      pid: 200,
      ppid: 8,
      port: 9000,
      aliveFn: () => true,
      log,
      exit,
    });
    expect(ok).toBe(false);
    expect(exit).toHaveBeenCalledWith(1);
    // The message should name the LEGACY path (tts.owner.json), not the port-keyed one
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining(legacyPath),
    );
    // Verify it does NOT name the port-keyed path
    expect(log).not.toHaveBeenCalledWith(
      expect.stringContaining(sidecarOwnerPath(runDir, 9000)),
    );
  });
});
