/* Unit tests for the Windows sleep-prevention helper wrapper. The real
   Win32 call lives in scripts/lib/prevent-sleep.ps1 (exercised by Pester,
   scripts/tests/prevent-sleep.Tests.ps1) — this file only pins the Node-side
   spawn/kill lifecycle, with spawnFn always injected so no real
   powershell.exe is ever launched in CI (which also runs on macOS/Linux). */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';

function fakeChild() {
  const emitter = new EventEmitter() as EventEmitter & { kill: ReturnType<typeof vi.fn> };
  emitter.kill = vi.fn();
  return emitter;
}

describe('prevent-sleep', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('spawns the PowerShell helper on win32 when enabled', async () => {
    const { preventSleep, isSleepPrevented } = await import('./prevent-sleep.js');
    const child = fakeChild();
    const spawnFn = vi.fn().mockReturnValue(child);

    preventSleep({ platform: 'win32', enabled: true, spawnFn });

    expect(spawnFn).toHaveBeenCalledTimes(1);
    const [cmd, args, opts] = spawnFn.mock.calls[0];
    expect(cmd).toBe('powershell.exe');
    expect(args).toEqual(
      expect.arrayContaining([
        '-ExecutionPolicy',
        'Bypass',
        '-NoProfile',
        '-File',
        expect.stringContaining('prevent-sleep.ps1'),
      ]),
    );
    expect(opts).toMatchObject({ windowsHide: true });
    expect(isSleepPrevented()).toBe(true);
  });

  it('is a no-op on a non-Windows platform', async () => {
    const { preventSleep, isSleepPrevented } = await import('./prevent-sleep.js');
    const spawnFn = vi.fn();

    preventSleep({ platform: 'darwin', enabled: true, spawnFn });

    expect(spawnFn).not.toHaveBeenCalled();
    expect(isSleepPrevented()).toBe(false);
  });

  it('is a no-op when explicitly disabled', async () => {
    const { preventSleep, isSleepPrevented } = await import('./prevent-sleep.js');
    const spawnFn = vi.fn();

    preventSleep({ platform: 'win32', enabled: false, spawnFn });

    expect(spawnFn).not.toHaveBeenCalled();
    expect(isSleepPrevented()).toBe(false);
  });

  it('defaults to enabled on win32 when PREVENT_SLEEP_DURING_GENERATION is unset', async () => {
    const prior = process.env.PREVENT_SLEEP_DURING_GENERATION;
    delete process.env.PREVENT_SLEEP_DURING_GENERATION;
    try {
      const { preventSleep, isSleepPrevented } = await import('./prevent-sleep.js');
      const spawnFn = vi.fn().mockReturnValue(fakeChild());

      preventSleep({ platform: 'win32', spawnFn });

      expect(spawnFn).toHaveBeenCalledTimes(1);
      expect(isSleepPrevented()).toBe(true);
    } finally {
      if (prior === undefined) delete process.env.PREVENT_SLEEP_DURING_GENERATION;
      else process.env.PREVENT_SLEEP_DURING_GENERATION = prior;
    }
  });

  it('honours PREVENT_SLEEP_DURING_GENERATION=false when no explicit override is passed', async () => {
    const prior = process.env.PREVENT_SLEEP_DURING_GENERATION;
    process.env.PREVENT_SLEEP_DURING_GENERATION = 'false';
    try {
      const { preventSleep, isSleepPrevented } = await import('./prevent-sleep.js');
      const spawnFn = vi.fn();

      preventSleep({ platform: 'win32', spawnFn });

      expect(spawnFn).not.toHaveBeenCalled();
      expect(isSleepPrevented()).toBe(false);
    } finally {
      if (prior === undefined) delete process.env.PREVENT_SLEEP_DURING_GENERATION;
      else process.env.PREVENT_SLEEP_DURING_GENERATION = prior;
    }
  });

  it('does not spawn a second helper while one is already active', async () => {
    const { preventSleep } = await import('./prevent-sleep.js');
    const spawnFn = vi.fn().mockReturnValue(fakeChild());

    preventSleep({ platform: 'win32', enabled: true, spawnFn });
    preventSleep({ platform: 'win32', enabled: true, spawnFn });

    expect(spawnFn).toHaveBeenCalledTimes(1);
  });

  it('allowSleep kills the active helper and clears state', async () => {
    const { preventSleep, allowSleep, isSleepPrevented } = await import('./prevent-sleep.js');
    const child = fakeChild();
    const spawnFn = vi.fn().mockReturnValue(child);
    preventSleep({ platform: 'win32', enabled: true, spawnFn });

    allowSleep();

    expect(child.kill).toHaveBeenCalledTimes(1);
    expect(isSleepPrevented()).toBe(false);
  });

  it('allowSleep is a no-op when nothing is active', async () => {
    const { allowSleep } = await import('./prevent-sleep.js');
    expect(() => allowSleep()).not.toThrow();
  });

  it('clears state when the helper exits on its own', async () => {
    const { preventSleep, isSleepPrevented } = await import('./prevent-sleep.js');
    const child = fakeChild();
    const spawnFn = vi.fn().mockReturnValue(child);
    preventSleep({ platform: 'win32', enabled: true, spawnFn });
    expect(isSleepPrevented()).toBe(true);

    child.emit('exit', 1, null);

    expect(isSleepPrevented()).toBe(false);
  });

  it('allows a fresh preventSleep call after the previous helper exited', async () => {
    const { preventSleep } = await import('./prevent-sleep.js');
    const child1 = fakeChild();
    const spawnFn = vi.fn().mockReturnValueOnce(child1).mockReturnValueOnce(fakeChild());

    preventSleep({ platform: 'win32', enabled: true, spawnFn });
    child1.emit('exit', 1, null);
    preventSleep({ platform: 'win32', enabled: true, spawnFn });

    expect(spawnFn).toHaveBeenCalledTimes(2);
  });
});
