/* Guard (#3712): the four TTS install bootstraps must refuse their DEFAULT real
   spawn under vitest. Each case builds the class with nothing injected for
   spawnFn, drives start() to a terminal status, and asserts the job errored
   with the refusal message and the (mocked) child_process.spawn never ran. */

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
import { KokoroInstallBootstrap } from './kokoro-install-bootstrap.js';
import { QwenInstallBootstrap } from './qwen-install-bootstrap.js';
import { WhisperInstallBootstrap } from './whisper-install-bootstrap.js';
import { CoquiInstallBootstrap } from './coqui-install-bootstrap.js';

const OFFLINE = {
  generationActiveFn: () => false,
  holdSidecarFn: <T>(fn: () => Promise<T>) => fn(),
  restoreOrtFn: async () => 'not-needed' as const,
};

let dir: string;
beforeEach(() => {
  vi.mocked(spawn).mockClear();
  dir = mkdtempSync(join(tmpdir(), 'install-no-real-spawn-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

async function untilError(get: () => { status: string; error: string | null } | null) {
  await vi.waitFor(() => {
    if (get()?.status !== 'error') throw new Error('not yet in error');
  });
  return get()!;
}

describe('install bootstraps refuse their default real spawn under vitest (#3712)', () => {
  it('K1: KokoroInstallBootstrap', async () => {
    const b = new KokoroInstallBootstrap({ repoRoot: dir, detectFn: () => false, ...OFFLINE });
    const job = b.start();
    const done = await untilError(() => b.getJob(job.id));
    expect(done.error).toContain('KokoroInstallBootstrap: real spawn refused under vitest');
    expect(spawn).toHaveBeenCalledTimes(0);
  });

  it('Q1: QwenInstallBootstrap', async () => {
    const b = new QwenInstallBootstrap({ repoRoot: dir, detectFn: () => 'not-installed', ...OFFLINE });
    const job = b.start();
    const done = await untilError(() => b.getJob(job.id));
    expect(done.error).toContain('QwenInstallBootstrap: real spawn refused under vitest');
    expect(spawn).toHaveBeenCalledTimes(0);
  });

  it('W1: WhisperInstallBootstrap', async () => {
    const b = new WhisperInstallBootstrap({ repoRoot: dir, detectFn: () => 'not-installed', ...OFFLINE });
    const job = b.start();
    const done = await untilError(() => b.getJob(job.id));
    expect(done.error).toContain('WhisperInstallBootstrap: real spawn refused under vitest');
    expect(spawn).toHaveBeenCalledTimes(0);
  });

  it('C1: CoquiInstallBootstrap', async () => {
    const b = new CoquiInstallBootstrap({ repoRoot: dir, detectFn: () => 'not-installed', ...OFFLINE });
    const job = b.start();
    const done = await untilError(() => b.getJob(job.id));
    expect(done.error).toContain('CoquiInstallBootstrap: real spawn refused under vitest');
    expect(spawn).toHaveBeenCalledTimes(0);
  });
});
