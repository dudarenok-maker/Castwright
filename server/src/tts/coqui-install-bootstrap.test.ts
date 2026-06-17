/* CoquiInstallBootstrap state machine. Runs the whole install offline: stubbed
   detectFn drives the install-state, stubbed spawnFn emits fake
   `[install-coqui]` progress + an exit code. No real download. */

import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { CoquiInstallBootstrap } from './coqui-install-bootstrap.js';
import type { CoquiInstallState } from './coqui-install-detect.js';

function makeFakeChild(exitCode: number, opts: { stdout?: string; stderr?: string } = {}) {
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
  };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  /* Emit after the caller has attached its listeners (run() awaits the close). */
  queueMicrotask(() => {
    if (opts.stdout) child.stdout.emit('data', Buffer.from(opts.stdout));
    if (opts.stderr) child.stderr.emit('data', Buffer.from(opts.stderr));
    child.emit('close', exitCode);
  });
  return child;
}

/** Wait for a predicate using vi.waitFor (event-driven retries, no clock budget). */
async function until(pred: () => boolean): Promise<void> {
  await vi.waitFor(() => {
    if (!pred()) throw new Error('condition not met yet');
  });
}

/* detectFn that returns each queued state in order (last one repeats). */
function detectSequence(states: CoquiInstallState[]) {
  let i = 0;
  const calls = { count: 0 };
  const fn = (): CoquiInstallState => {
    calls.count++;
    const s = states[Math.min(i, states.length - 1)];
    i++;
    return s;
  };
  return { fn, calls };
}

describe('CoquiInstallBootstrap', () => {
  it('detect() reports installed only for ready/loaded', async () => {
    for (const [state, installed] of [
      ['not-installed', false],
      ['weights-missing', false],
      ['ready', true],
      ['loaded', true],
    ] as const) {
      const b = new CoquiInstallBootstrap({ repoRoot: '/repo', detectFn: () => state });
      expect((await b.detect()).installed).toBe(installed);
    }
  });

  it('installs: detect weights-missing → installing → installed on exit 0', async () => {
    let spawned = 0;
    const { fn: detectFn } = detectSequence(['weights-missing', 'ready']);
    const b = new CoquiInstallBootstrap({
      repoRoot: '/repo',
      detectFn,
      spawnFn: () => {
        spawned++;
        return makeFakeChild(0, { stdout: '[install-coqui] Pre-fetching XTTS v2\n' }) as never;
      },
    });
    const job = b.start();
    await until(() => b.getJob(job.id)?.status === 'installed');
    expect(spawned).toBe(1);
    expect(b.getJob(job.id)?.step).toContain('installed');
  });

  it('short-circuits to installed without spawning when already ready', async () => {
    let spawned = 0;
    const b = new CoquiInstallBootstrap({
      repoRoot: '/repo',
      detectFn: () => 'ready',
      spawnFn: () => {
        spawned++;
        return makeFakeChild(0) as never;
      },
    });
    const job = b.start();
    await until(() => b.getJob(job.id)?.status === 'installed');
    expect(spawned).toBe(0);
  });

  it('errors with the stderr tail when the installer exits non-zero', async () => {
    const b = new CoquiInstallBootstrap({
      repoRoot: '/repo',
      detectFn: () => 'weights-missing',
      spawnFn: () =>
        makeFakeChild(1, { stderr: 'ERROR: XTTS v2 pre-fetch failed\n' }) as never,
    });
    const job = b.start();
    await until(() => b.getJob(job.id)?.status === 'error');
    expect(b.getJob(job.id)?.error).toMatch(/exited with code 1/);
    expect(b.getJob(job.id)?.error).toMatch(/pre-fetch failed/);
  });

  it('errors when the installer exits 0 but weights are still missing', async () => {
    const { fn: detectFn } = detectSequence(['weights-missing', 'weights-missing']);
    const b = new CoquiInstallBootstrap({
      repoRoot: '/repo',
      detectFn,
      spawnFn: () => makeFakeChild(0) as never,
    });
    const job = b.start();
    await until(() => b.getJob(job.id)?.status === 'error');
    expect(b.getJob(job.id)?.error).toMatch(/weights are still missing/i);
  });

  it('recheck promotes a job to installed once the weights are present', async () => {
    let state: CoquiInstallState = 'weights-missing';
    const b = new CoquiInstallBootstrap({
      repoRoot: '/repo',
      detectFn: () => state,
      spawnFn: () => makeFakeChild(0) as never,
    });
    const job = b.start();
    await until(() => b.getJob(job.id)?.status === 'error');
    state = 'ready';
    const rechecked = await b.recheck(job.id);
    expect(rechecked?.status).toBe('installed');
  });

  it('installs coqui-tts then weights when starting from not-installed', async () => {
    let spawned = 0;
    const { fn: detectFn } = detectSequence(['not-installed', 'ready']);
    const boot = new CoquiInstallBootstrap({
      repoRoot: '/repo',
      detectFn,
      spawnFn: () => {
        spawned++;
        return makeFakeChild(0, {
          stdout: '[install-coqui] Installing coqui-tts (opt-in)\n',
        }) as never;
      },
    });
    const job = boot.start();
    await until(() => boot.getJob(job.id)?.status === 'installed');
    expect(spawned).toBe(1);
  });
});
