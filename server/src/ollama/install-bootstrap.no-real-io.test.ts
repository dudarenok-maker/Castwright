/* Guard (#3712): Ollama's InstallBootstrap must refuse its DEFAULT real spawn
   and real download under vitest. The default detector swallows a spawn throw
   as "not installed", so guarding spawnFn alone would let start() go on to a
   real installer download; httpFn is guarded too. child_process is mocked and
   fetch is spied so even a red run touches no process and no network. */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    spawn: vi.fn(),
    spawnSync: vi.fn(() => ({ status: 1, stdout: '', stderr: '' })),
  };
});

import { spawn } from 'node:child_process';
import { InstallBootstrap } from './install-bootstrap.js';

let dir: string;
let fetchSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  vi.mocked(spawn).mockReset();
  fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('no network in test'));
  dir = mkdtempSync(join(tmpdir(), 'ollama-no-real-io-'));
});
afterEach(() => {
  fetchSpy.mockRestore();
  rmSync(dir, { recursive: true, force: true });
});

const base = () => ({ getPlatform: () => 'linux' as const, getArch: () => 'x64', downloadDir: dir });

describe('Ollama InstallBootstrap refuses real spawn and download under vitest (#3712)', () => {
  it('O1: default detect reports not installed without spawning', async () => {
    const b = new InstallBootstrap(base());
    expect(await b.detect()).toEqual({ installed: false, version: null });
    expect(spawn).toHaveBeenCalledTimes(0);
  });

  it('O2: default install errors on the refused download, no spawn, no fetch', async () => {
    const b = new InstallBootstrap(base());
    const job = b.start();
    await vi.waitFor(() => {
      if (b.getJob(job.id)?.status !== 'error') throw new Error('not yet in error');
    });
    expect(b.getJob(job.id)!.error).toContain('real download refused under vitest');
    expect(spawn).toHaveBeenCalledTimes(0);
    expect(fetchSpy).toHaveBeenCalledTimes(0);
  });

  it('O3: an injected detectOllama still short-circuits to installed', async () => {
    const b = new InstallBootstrap({
      ...base(),
      detectOllama: () => Promise.resolve('ollama version 0.5.4'),
    });
    const job = b.start();
    await vi.waitFor(() => {
      if (b.getJob(job.id)?.status !== 'installed') throw new Error('not yet installed');
    });
    expect(spawn).toHaveBeenCalledTimes(0);
    expect(fetchSpy).toHaveBeenCalledTimes(0);
  });
});
