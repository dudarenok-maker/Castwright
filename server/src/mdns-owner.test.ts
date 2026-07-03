import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { shouldSpawnMdnsResponder, spawnMdnsResponder } from './mdns-owner.js';

interface FakeChild extends EventEmitter {
  pid: number;
}

function makeFakeChild(pid = 4242): FakeChild {
  const ee = new EventEmitter() as FakeChild;
  ee.pid = pid;
  return ee;
}

describe('shouldSpawnMdnsResponder (ops — castwright-local-hostnames)', () => {
  it('is false when lanHttps is false, regardless of NODE_ENV', () => {
    expect(shouldSpawnMdnsResponder(false, { NODE_ENV: 'production' })).toBe(false);
  });

  it('is true for the start:lan shape: lanHttps=true AND NODE_ENV=production', () => {
    expect(shouldSpawnMdnsResponder(true, { NODE_ENV: 'production' })).toBe(true);
  });

  it('is false for the dev:lan server-leg shape: lanHttps=true but NODE_ENV unset — the exact double-spawn bug round-2 review caught', () => {
    expect(shouldSpawnMdnsResponder(true, {})).toBe(false);
  });

  it('is false when NODE_ENV is set but not production', () => {
    expect(shouldSpawnMdnsResponder(true, { NODE_ENV: 'development' })).toBe(false);
  });
});

describe('spawnMdnsResponder', () => {
  it('spawns node with the script path and --name flag', () => {
    const spawnFn = vi.fn(() => makeFakeChild());
    spawnMdnsResponder('castwright.local', '/repo', {
      spawnFn: spawnFn as unknown as typeof import('node:child_process').spawn,
      warn: vi.fn(),
    });
    expect(spawnFn).toHaveBeenCalledTimes(1);
    const [cmd, args] = spawnFn.mock.calls[0] as [string, string[]];
    expect(cmd).toBe(process.execPath);
    expect(args).toContain('--name');
    expect(args).toContain('castwright.local');
    expect(args[0]).toContain('mdns-responder.mjs');
  });

  it('returns null and warns when spawning throws', () => {
    const spawnFn = vi.fn(() => {
      throw new Error('ENOENT');
    });
    const warn = vi.fn();
    const handle = spawnMdnsResponder('castwright.local', '/repo', {
      spawnFn: spawnFn as unknown as typeof import('node:child_process').spawn,
      warn,
    });
    expect(handle).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('warns when the child exits nonzero shortly after spawn (e.g. a missing/broken script) instead of leaking a dead handle silently', () => {
    const child = makeFakeChild(4242);
    const spawnFn = vi.fn(() => child);
    const warn = vi.fn();
    const handle = spawnMdnsResponder('castwright.local', '/repo', {
      spawnFn: spawnFn as unknown as typeof import('node:child_process').spawn,
      warn,
    });
    expect(handle).not.toBeNull();
    child.emit('exit', 1, null);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toContain('castwright.local');
  });

  it("does NOT warn on a clean exit(0) (the responder's own graceful bind-failure path)", () => {
    const child = makeFakeChild(4242);
    const spawnFn = vi.fn(() => child);
    const warn = vi.fn();
    spawnMdnsResponder('castwright.local', '/repo', {
      spawnFn: spawnFn as unknown as typeof import('node:child_process').spawn,
      warn,
    });
    child.emit('exit', 0, null);
    expect(warn).not.toHaveBeenCalled();
  });

  it('kill() on win32 shells out to taskkill /T /F /PID', () => {
    const child = makeFakeChild(4242);
    const spawnFn = vi.fn(() => child);
    const handle = spawnMdnsResponder('castwright.local', '/repo', {
      spawnFn: spawnFn as unknown as typeof import('node:child_process').spawn,
      warn: vi.fn(),
      platform: 'win32',
    });
    expect(handle).not.toBeNull();
    spawnFn.mockClear();
    handle!.kill();
    expect(spawnFn).toHaveBeenCalledWith(
      'taskkill',
      ['/PID', '4242', '/T', '/F'],
      expect.objectContaining({ stdio: 'ignore' }),
    );
  });

  it('kill() on non-win32 sends SIGTERM directly to the child', () => {
    const child = makeFakeChild(4242);
    const killSpy = vi.fn();
    (child as unknown as { kill: typeof killSpy }).kill = killSpy;
    const spawnFn = vi.fn(() => child);
    const handle = spawnMdnsResponder('castwright.local', '/repo', {
      spawnFn: spawnFn as unknown as typeof import('node:child_process').spawn,
      warn: vi.fn(),
      platform: 'linux',
    });
    expect(handle).not.toBeNull();
    handle!.kill();
    expect(killSpy).toHaveBeenCalledWith('SIGTERM');
  });

  it('does NOT warn when the exit after kill() reports a nonzero code (Windows taskkill /F reports code=1, not null)', () => {
    const child = makeFakeChild(4242);
    const spawnFn = vi.fn(() => child);
    const warn = vi.fn();
    const handle = spawnMdnsResponder('castwright.local', '/repo', {
      spawnFn: spawnFn as unknown as typeof import('node:child_process').spawn,
      warn,
      platform: 'win32',
    });
    expect(handle).not.toBeNull();
    handle!.kill();
    child.emit('exit', 1, null);
    expect(warn).not.toHaveBeenCalled();
  });
});
