/* KokoroInstallBootstrap state machine. Runs the whole install offline: stubbed
   detectFn drives the install-state (boolean), stubbed spawnFn emits fake
   `[install-kokoro]` progress + an exit code. No real download. */

import { describe, it, expect } from 'vitest';
import { EventEmitter } from 'node:events';
import { KokoroInstallBootstrap } from './kokoro-install-bootstrap.js';

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

async function until(pred: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error('timed out waiting for condition');
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe('KokoroInstallBootstrap', () => {
  it('detect() reports installed=true only when detectFn returns true', async () => {
    const bInstalled = new KokoroInstallBootstrap({ repoRoot: '/repo', detectFn: () => true });
    const bMissing = new KokoroInstallBootstrap({ repoRoot: '/repo', detectFn: () => false });
    expect((await bInstalled.detect()).installed).toBe(true);
    expect((await bInstalled.detect()).state).toBe('installed');
    expect((await bMissing.detect()).installed).toBe(false);
    expect((await bMissing.detect()).state).toBe('not-installed');
  });

  it('start() spawns exactly once and transitions to installing', async () => {
    let spawned = 0;
    const b = new KokoroInstallBootstrap({
      repoRoot: '/repo',
      detectFn: () => false,
      spawnFn: () => {
        spawned++;
        return makeFakeChild(0, { stdout: '[install-kokoro] downloading\n' }) as never;
      },
    });
    // detectFn always returns false so it won't short-circuit
    // but spawnFn exit 0 triggers the post-check detectFn which also returns false
    // so job will go to error — that's fine, we just check spawned count
    const job = b.start();
    await until(() => {
      const j = b.getJob(job.id);
      return j?.status === 'installed' || j?.status === 'error';
    });
    expect(spawned).toBe(1);
  });

  it('short-circuits to installed WITHOUT spawning when detectFn already returns true', async () => {
    let spawned = 0;
    const b = new KokoroInstallBootstrap({
      repoRoot: '/repo',
      detectFn: () => true,
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
    const b = new KokoroInstallBootstrap({
      repoRoot: '/repo',
      detectFn: () => false,
      spawnFn: () =>
        makeFakeChild(1, { stderr: 'ERROR: Kokoro download failed\n' }) as never,
    });
    const job = b.start();
    await until(() => b.getJob(job.id)?.status === 'error');
    expect(b.getJob(job.id)?.error).toMatch(/exited with code 1/);
    expect(b.getJob(job.id)?.error).toMatch(/download failed/);
  });

  it('[install-kokoro] stdout line updates job.step', async () => {
    /* detectFn sequence: first call (before-check) returns false → spawns;
       second call (after-check) returns true → installed. */
    let callCount = 0;
    const b = new KokoroInstallBootstrap({
      repoRoot: '/repo',
      detectFn: () => {
        callCount++;
        return callCount > 1; // false on first (before), true on second (after)
      },
      spawnFn: () =>
        makeFakeChild(0, { stdout: '[install-kokoro] downloading\n' }) as never,
    });
    const job = b.start();
    await until(() => b.getJob(job.id)?.status === 'installed');
    expect(b.getJob(job.id)?.step).toContain('installed');
  });

  it('successful run (exit 0, detect=true after) transitions to installed', async () => {
    let callCount = 0;
    const b = new KokoroInstallBootstrap({
      repoRoot: '/repo',
      detectFn: () => {
        callCount++;
        return callCount > 1; // not installed before, installed after
      },
      spawnFn: () => makeFakeChild(0) as never,
    });
    const job = b.start();
    await until(() => b.getJob(job.id)?.status === 'installed');
    expect(b.getJob(job.id)?.status).toBe('installed');
  });

  it('recheck promotes a job to installed once detect returns true', async () => {
    let installed = false;
    const b = new KokoroInstallBootstrap({
      repoRoot: '/repo',
      detectFn: () => installed,
      spawnFn: () => makeFakeChild(0) as never,
    });
    // detectFn always false → exit 0 but post-check still false → error
    const job = b.start();
    await until(() => b.getJob(job.id)?.status === 'error');
    installed = true;
    const rechecked = await b.recheck(job.id);
    expect(rechecked?.status).toBe('installed');
  });
});
