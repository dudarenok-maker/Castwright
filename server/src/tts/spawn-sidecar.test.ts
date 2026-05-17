/* Plan 43 — pins the spawn-sidecar module contract:

   1. autoStart=false               → spawn not called, returns null.
   2. port 9000 already listening   → spawn not called, returns null.
   3. autoStart=true, modelKey=kokoro-v1 → spawn called once, env has
                                            PRELOAD_COQUI=0.
   4. autoStart=true, modelKey=coqui-xtts-v2 → spawn called once, env has
                                               PRELOAD_COQUI=1.
   5. handle.kill() on win32 shells out to `taskkill /T /F /PID`. */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';
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

  beforeEach(() => {
    spawnFn = vi.fn(() => makeFakeChild());
    probeFn = vi.fn(async () => false);
    log = vi.fn();
    warn = vi.fn();
  });

  it('returns null and does not spawn when autoStart is false', async () => {
    const handle = await spawnSidecar({
      autoStart: false,
      modelKey: 'kokoro-v1',
      repoRoot: '/repo',
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
      repoRoot: '/repo',
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
      repoRoot: '/repo',
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
    expect(options.windowsHide).toBe(true);
  });

  it('spawns with PRELOAD_COQUI=1 when default model is coqui-xtts-v2', async () => {
    const handle = await spawnSidecar({
      autoStart: true,
      modelKey: 'coqui-xtts-v2',
      repoRoot: '/repo',
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

  it('logs a warning when the spawned child exits unexpectedly', async () => {
    const child = makeFakeChild(54321);
    spawnFn.mockReturnValueOnce(child);

    const handle = await spawnSidecar({
      autoStart: true,
      modelKey: 'kokoro-v1',
      repoRoot: '/repo',
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
        repoRoot: '/repo',
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
