/* QwenInstallBootstrap state machine (qwen-default phase 3). Runs the whole
   install offline: stubbed detectFn drives the install-state, stubbed spawnFn
   emits fake `[install-qwen3]` progress + an exit code. No real pip/download. */

import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { QwenInstallBootstrap } from './qwen-install-bootstrap.js';
import type { QwenInstallState } from '../workspace/user-settings.js';

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
function detectSequence(states: QwenInstallState[]) {
  let i = 0;
  const calls = { count: 0 };
  const fn = (): QwenInstallState => {
    calls.count++;
    const s = states[Math.min(i, states.length - 1)];
    i++;
    return s;
  };
  return { fn, calls };
}

describe('QwenInstallBootstrap', () => {
  it('detect() reports installed only for ready/loaded', async () => {
    for (const [state, installed] of [
      ['not-installed', false],
      ['weights-missing', false],
      ['ready', true],
      ['loaded', true],
    ] as const) {
      const b = new QwenInstallBootstrap({ repoRoot: '/repo', detectFn: () => state });
      expect((await b.detect()).installed).toBe(installed);
    }
  });

  it('installs: detect not-installed → installing → installed on exit 0', async () => {
    let spawned = 0;
    const { fn: detectFn } = detectSequence(['not-installed', 'ready']);
    const b = new QwenInstallBootstrap({
      repoRoot: '/repo',
      detectFn,
      spawnFn: () => {
        spawned++;
        return makeFakeChild(0, { stdout: '[install-qwen3] Pre-fetching models\n' }) as never;
      },
    });
    const job = b.start();
    await until(() => b.getJob(job.id)?.status === 'installed');
    expect(spawned).toBe(1);
    expect(b.getJob(job.id)?.step).toContain('installed');
  });

  it('short-circuits to installed without spawning when already ready', async () => {
    let spawned = 0;
    const b = new QwenInstallBootstrap({
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
    const b = new QwenInstallBootstrap({
      repoRoot: '/repo',
      detectFn: () => 'not-installed',
      spawnFn: () => makeFakeChild(1, { stderr: 'ERROR: pip failed to resolve qwen-tts\n' }) as never,
    });
    const job = b.start();
    await until(() => b.getJob(job.id)?.status === 'error');
    expect(b.getJob(job.id)?.error).toMatch(/exited with code 1/);
    expect(b.getJob(job.id)?.error).toMatch(/pip failed/);
  });

  it('errors when the installer exits 0 but weights are still missing', async () => {
    const { fn: detectFn } = detectSequence(['not-installed', 'weights-missing']);
    const b = new QwenInstallBootstrap({
      repoRoot: '/repo',
      detectFn,
      spawnFn: () => makeFakeChild(0) as never,
    });
    const job = b.start();
    await until(() => b.getJob(job.id)?.status === 'error');
    expect(b.getJob(job.id)?.error).toMatch(/weights are still missing/i);
  });

  it('recheck promotes a job to installed once the weights are present', async () => {
    /* Spawn that exits 0 but detect still weights-missing → job errors; then
       a later recheck sees 'ready' and promotes. */
    let state: QwenInstallState = 'not-installed';
    const b = new QwenInstallBootstrap({
      repoRoot: '/repo',
      detectFn: () => state,
      spawnFn: () => makeFakeChild(0) as never,
    });
    const job = b.start();
    await until(() => b.getJob(job.id)?.status === 'error');
    state = 'ready';
    const uchecked = await b.recheck(job.id);
    expect(uchecked?.status).toBe('installed');
  });
});
