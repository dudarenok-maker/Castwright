/* Plan 43 — pins the spawn-sidecar module contract:

   1. autoStart=false               → spawn not called, returns null.
   2. port 9000 already listening   → spawn not called, returns null.
   3. autoStart=true, modelKey=kokoro-v1 → spawn called once, env has
                                            PRELOAD_COQUI=0.
   4. autoStart=true, modelKey=coqui-xtts-v2 → spawn called once, env has
                                               PRELOAD_COQUI=1.
   5. eagerLoadKokoro=true  → env has PRELOAD_KOKORO=1.
   6. eagerLoadKokoro=false → env has PRELOAD_KOKORO=0.
   7. Qwen default + eagerLoadQwen=true  → PRELOAD_QWEN=1, Kokoro forced lazy.
   8. Qwen default + eagerLoadQwen=false → PRELOAD_QWEN=0 (warm on demand).
   9. eagerLoadQwen is ignored under a non-Qwen default (Qwen stays off).
   10. handle.kill() on win32 shells out to `taskkill /T /F /PID`. */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSidecar } from './spawn-sidecar.js';

interface FakeChild extends EventEmitter {
  pid: number;
  stdout: null;
  stderr: null;
}

function makeFakeChild(pid = 12345): FakeChild {
  const ee = new EventEmitter() as FakeChild;
  ee.pid = pid;
  ee.stdout = null;
  ee.stderr = null;
  return ee;
}

describe('spawnSidecar', () => {
  let spawnFn: ReturnType<typeof vi.fn>;
  let probeFn: ReturnType<typeof vi.fn>;
  let log: ReturnType<typeof vi.fn>;
  let warn: ReturnType<typeof vi.fn>;
  /* A real, writable temp dir per test — spawnSidecar opens the sidecar log
     files (logs/tts.log, logs/tts.err.log) and writes .run/tts.pid under
     repoRoot, so it must point at a directory we can actually create files
     in (the old '/repo' literal would EACCES on Linux CI and pollute C:\repo
     on Windows). */
  let repoRoot: string;

  beforeEach(() => {
    spawnFn = vi.fn(() => makeFakeChild());
    probeFn = vi.fn(async () => false);
    log = vi.fn();
    warn = vi.fn();
    repoRoot = mkdtempSync(join(tmpdir(), 'wt-sidecar-'));
  });

  afterEach(() => {
    rmSync(repoRoot, { recursive: true, force: true });
  });

  it('returns null and does not spawn when autoStart is false', async () => {
    const handle = await spawnSidecar({
      autoStart: false,
      modelKey: 'kokoro-v1',
      eagerLoadKokoro: true,
      eagerLoadQwen: true,
      repoRoot,
      spawnFn: spawnFn as unknown as typeof import('node:child_process').spawn,
      probeFn,
      log,
      warn,
    });

    expect(handle).toBeNull();
    expect(spawnFn).not.toHaveBeenCalled();
    expect(probeFn).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.stringContaining('auto-start disabled'));
  });

  it('returns null and does not spawn when port 9000 is already listening', async () => {
    probeFn.mockResolvedValueOnce(true);

    const handle = await spawnSidecar({
      autoStart: true,
      modelKey: 'kokoro-v1',
      eagerLoadKokoro: true,
      eagerLoadQwen: true,
      repoRoot,
      spawnFn: spawnFn as unknown as typeof import('node:child_process').spawn,
      probeFn,
      log,
      warn,
    });

    expect(handle).toBeNull();
    expect(probeFn).toHaveBeenCalledTimes(1);
    expect(spawnFn).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.stringContaining('already listening'));
  });

  it('spawns with PRELOAD_COQUI=0 when default model is kokoro-v1', async () => {
    const handle = await spawnSidecar({
      autoStart: true,
      modelKey: 'kokoro-v1',
      eagerLoadKokoro: true,
      eagerLoadQwen: true,
      repoRoot,
      spawnFn: spawnFn as unknown as typeof import('node:child_process').spawn,
      probeFn,
      log,
      warn,
    });

    expect(handle).not.toBeNull();
    expect(handle?.pid).toBe(12345);
    expect(spawnFn).toHaveBeenCalledTimes(1);
    const [cmd, args, options] = spawnFn.mock.calls[0];
    expect(cmd).toBe('powershell.exe');
    expect(args).toEqual(
      expect.arrayContaining(['-ExecutionPolicy', 'Bypass', '-NoProfile', '-File']),
    );
    expect(options.env.PRELOAD_COQUI).toBe('0');
    expect(options.env.PRELOAD_KOKORO).toBe('1');
    /* The Qwen designed-voice cache is parked in the per-workspace tree
       (sibling to voices.json), not the sidecar's __file__-relative dir,
       so a restart / cwd change can't orphan a designed voice. */
    expect(options.env.QWEN_VOICES_DIR).toMatch(/voices[\\/]qwen$/);
    expect(options.windowsHide).toBe(true);
  });

  it('spawns with PRELOAD_KOKORO=0 when eagerLoadKokoro is false', async () => {
    const handle = await spawnSidecar({
      autoStart: true,
      modelKey: 'kokoro-v1',
      eagerLoadKokoro: false,
      eagerLoadQwen: true,
      repoRoot,
      spawnFn: spawnFn as unknown as typeof import('node:child_process').spawn,
      probeFn,
      log,
      warn,
    });

    expect(handle).not.toBeNull();
    expect(spawnFn).toHaveBeenCalledTimes(1);
    const [, , options] = spawnFn.mock.calls[0];
    expect(options.env.PRELOAD_KOKORO).toBe('0');
    /* eagerLoadKokoro is orthogonal to the Coqui preload — kokoro-v1
       default still leaves Coqui lazy. */
    expect(options.env.PRELOAD_COQUI).toBe('0');
  });

  it('spawns with PRELOAD_COQUI=1 when default model is coqui-xtts-v2', async () => {
    const handle = await spawnSidecar({
      autoStart: true,
      modelKey: 'coqui-xtts-v2',
      eagerLoadKokoro: true,
      eagerLoadQwen: true,
      repoRoot,
      spawnFn: spawnFn as unknown as typeof import('node:child_process').spawn,
      probeFn,
      log,
      warn,
    });

    expect(handle).not.toBeNull();
    expect(spawnFn).toHaveBeenCalledTimes(1);
    const [, , options] = spawnFn.mock.calls[0];
    expect(options.env.PRELOAD_COQUI).toBe('1');
  });

  it('hot-preloads Qwen and keeps Kokoro lazy when the default model is qwen3-tts-0.6b', async () => {
    /* Qwen-default + eagerLoadQwen=true: PRELOAD_QWEN=1 (hot at boot) +
       PRELOAD_KOKORO=0 even though eagerLoadKokoro=true — Kokoro is the
       on-demand fallback engine (warms ~1 s at the first fallback render),
       so eager-loading it too would just hog ~1 GB. */
    const handle = await spawnSidecar({
      autoStart: true,
      modelKey: 'qwen3-tts-0.6b',
      eagerLoadKokoro: true,
      eagerLoadQwen: true,
      repoRoot,
      spawnFn: spawnFn as unknown as typeof import('node:child_process').spawn,
      probeFn,
      log,
      warn,
    });

    expect(handle).not.toBeNull();
    const [, , options] = spawnFn.mock.calls[0];
    expect(options.env.PRELOAD_QWEN).toBe('1');
    expect(options.env.PRELOAD_KOKORO).toBe('0');
    expect(options.env.PRELOAD_COQUI).toBe('0');
  });

  it('keeps Qwen lazy when the default is qwen3-tts-0.6b but eagerLoadQwen is false', async () => {
    /* Qwen-default + eagerLoadQwen=false: PRELOAD_QWEN=0 so Qwen warms on
       demand on the first synth, reclaiming that VRAM at boot. Kokoro stays
       the forced-lazy fallback regardless. */
    const handle = await spawnSidecar({
      autoStart: true,
      modelKey: 'qwen3-tts-0.6b',
      eagerLoadKokoro: true,
      eagerLoadQwen: false,
      repoRoot,
      spawnFn: spawnFn as unknown as typeof import('node:child_process').spawn,
      probeFn,
      log,
      warn,
    });

    expect(handle).not.toBeNull();
    const [, , options] = spawnFn.mock.calls[0];
    expect(options.env.PRELOAD_QWEN).toBe('0');
    expect(options.env.PRELOAD_KOKORO).toBe('0');
  });

  it('ignores eagerLoadQwen when the default engine is not Qwen', async () => {
    /* eagerLoadQwen only governs PRELOAD_QWEN under a Qwen default — a
       Kokoro default leaves Qwen off and honours eagerLoadKokoro for Kokoro. */
    await spawnSidecar({
      autoStart: true,
      modelKey: 'kokoro-v1',
      eagerLoadKokoro: true,
      eagerLoadQwen: false,
      repoRoot,
      spawnFn: spawnFn as unknown as typeof import('node:child_process').spawn,
      probeFn,
      log,
      warn,
    });
    const [, , options] = spawnFn.mock.calls[0];
    expect(options.env.PRELOAD_QWEN).toBe('0');
    expect(options.env.PRELOAD_KOKORO).toBe('1');
  });

  it('leaves PRELOAD_QWEN=0 for a non-Qwen default', async () => {
    await spawnSidecar({
      autoStart: true,
      modelKey: 'kokoro-v1',
      eagerLoadKokoro: true,
      eagerLoadQwen: true,
      repoRoot,
      spawnFn: spawnFn as unknown as typeof import('node:child_process').spawn,
      probeFn,
      log,
      warn,
    });
    const [, , options] = spawnFn.mock.calls[0];
    expect(options.env.PRELOAD_QWEN).toBe('0');
  });

  it('hands the child inherited log-file descriptors as stdout/stderr (survives parent death)', async () => {
    /* Regression for the orphaned-sidecar [Errno 22] bug: a `tsx watch` dev
       reload restarts the Node server but leaves the long-lived sidecar
       running. If the sidecar's stdout/stderr were Node PIPES owned by the
       (now-dead) parent, its next write — the huggingface from_pretrained
       tqdm progress bar during a model /load — raised
       "OSError: [Errno 22] Invalid argument", surfacing as an opaque /load
       500 and a TTS pill that reverts to idle. Handing the child raw FILE
       descriptors (its own OS handles) instead keeps logging alive
       regardless of the parent's lifetime. */
    const handle = await spawnSidecar({
      autoStart: true,
      modelKey: 'kokoro-v1',
      eagerLoadKokoro: true,
      eagerLoadQwen: true,
      repoRoot,
      spawnFn: spawnFn as unknown as typeof import('node:child_process').spawn,
      probeFn,
      log,
      warn,
    });

    expect(handle).not.toBeNull();
    const [, , options] = spawnFn.mock.calls[0];
    expect(options.stdio[0]).toBe('ignore');
    /* stdout + stderr are raw integer fds, NOT the string 'pipe' the old
       WriteStream-piping path used. */
    expect(typeof options.stdio[1]).toBe('number');
    expect(typeof options.stdio[2]).toBe('number');
    /* The log files were actually created under repoRoot/logs ... */
    expect(readdirSync(join(repoRoot, 'logs')).sort()).toEqual(['tts.err.log', 'tts.log']);
    /* ... with no "log file open failed" fallback-to-discard warning. */
    expect(warn).not.toHaveBeenCalledWith(expect.stringContaining('log file open failed'));
  });

  it('logs a warning when the spawned child exits unexpectedly', async () => {
    const child = makeFakeChild(54321);
    spawnFn.mockReturnValueOnce(child);

    const handle = await spawnSidecar({
      autoStart: true,
      modelKey: 'kokoro-v1',
      eagerLoadKokoro: true,
      eagerLoadQwen: true,
      repoRoot,
      spawnFn: spawnFn as unknown as typeof import('node:child_process').spawn,
      probeFn,
      log,
      warn,
    });

    expect(handle).not.toBeNull();
    child.emit('exit', 1, null);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('child exited (code=1, signal=null)'),
    );
  });

  it('handle.kill() on win32 shells out to taskkill /T /F /PID', async () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });

    /* Two spawn calls: the first launches the sidecar, the second is the
       taskkill the handle's kill() fires. Replace the mock with a tracker
       that captures all calls so we can introspect both. */
    const calls: Array<{ cmd: string; args: string[] }> = [];
    const trackingSpawn = vi.fn((cmd: string, args: string[]) => {
      calls.push({ cmd, args });
      const child = makeFakeChild();
      /* The taskkill child needs to emit 'exit' so the kill() Promise
         resolves; trigger it synchronously on the next tick. */
      if (cmd === 'taskkill') {
        setImmediate(() => child.emit('exit', 0, null));
      }
      return child;
    });

    try {
      const handle = await spawnSidecar({
        autoStart: true,
        modelKey: 'kokoro-v1',
        eagerLoadKokoro: true,
        eagerLoadQwen: true,
        repoRoot,
        spawnFn: trackingSpawn as unknown as typeof import('node:child_process').spawn,
        probeFn,
        log,
        warn,
      });

      expect(handle).not.toBeNull();
      await handle!.kill();

      expect(calls).toHaveLength(2);
      expect(calls[0].cmd).toBe('powershell.exe');
      expect(calls[1].cmd).toBe('taskkill');
      expect(calls[1].args).toEqual(['/PID', '12345', '/T', '/F']);
    } finally {
      Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
    }
  });
});
