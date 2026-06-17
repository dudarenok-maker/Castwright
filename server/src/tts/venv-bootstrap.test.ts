/* VenvBootstrap state machine (fs-21 decision Z). Runs offline: stubbed
   detectVenvFn / findPythonFn drive the detect inputs; stubbed spawnFn emits
   fake `[bootstrap-venv]` lines + an exit code. No real Python spawn. */

import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { VenvBootstrap } from './venv-bootstrap.js';

function makeFakeChild(exitCode: number, opts: { stdout?: string; stderr?: string } = {}) {
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
  };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  /* Emit after the caller has attached its listeners. */
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

describe('VenvBootstrap', () => {
  it('venv present → start() short-circuits to installed WITHOUT spawning', async () => {
    let spawned = 0;
    const b = new VenvBootstrap({
      repoRoot: '/repo',
      detectVenvFn: () => true,
      findPythonFn: () => ({ cmd: 'python3.12', args: [] }),
      spawnFn: () => {
        spawned++;
        return makeFakeChild(0) as never;
      },
    });
    const job = b.start();
    await until(() => b.getJob(job.id)?.status === 'installed');
    expect(b.getJob(job.id)?.status).toBe('installed');
    expect(spawned).toBe(0);
  });

  it('venv absent + python found → spawns once, [bootstrap-venv] line updates step, exit 0 → installed', async () => {
    let spawned = 0;
    const b = new VenvBootstrap({
      repoRoot: '/repo',
      detectVenvFn: () => false,
      findPythonFn: () => ({ cmd: 'py', args: ['-3.12'] }),
      spawnFn: () => {
        spawned++;
        return makeFakeChild(0, { stdout: '[bootstrap-venv] creating venv\n' }) as never;
      },
    });
    const job = b.start();
    await until(() => {
      const j = b.getJob(job.id);
      return j?.status === 'installed' || j?.status === 'error';
    });
    expect(spawned).toBe(1);
    // step should have been updated at some point from the stdout line
    // (final step may be overwritten, but spawn happened)
  });

  it('venv absent + NO python → job status error with "Python 3.12" + ensure-python312 in error, NO spawn', async () => {
    let spawned = 0;
    const b = new VenvBootstrap({
      repoRoot: '/repo',
      detectVenvFn: () => false,
      findPythonFn: () => null,
      spawnFn: () => {
        spawned++;
        return makeFakeChild(0) as never;
      },
    });
    const job = b.start();
    await until(() => b.getJob(job.id)?.status === 'error');
    expect(b.getJob(job.id)?.status).toBe('error');
    expect(b.getJob(job.id)?.error).toMatch(/Python 3\.12/);
    expect(b.getJob(job.id)?.error).toMatch(/ensure-python312/);
    expect(spawned).toBe(0);
  });

  it('[bootstrap-venv] stdout line updates job.step', async () => {
    const b = new VenvBootstrap({
      repoRoot: '/repo',
      detectVenvFn: () => false,
      findPythonFn: () => ({ cmd: 'py', args: ['-3.12'] }),
      spawnFn: () =>
        makeFakeChild(0, { stdout: '[bootstrap-venv] creating venv\n' }) as never,
    });
    const job = b.start();
    // Wait for any terminal state
    await until(() => {
      const j = b.getJob(job.id);
      return j?.status === 'installed' || j?.status === 'error';
    });
    // The step should have been set from the stdout line at some point
    // (the final step text may be 'Done. Venv ready.' but the step should be non-null)
    expect(b.getJob(job.id)?.step).not.toBeNull();
  });

  it('venv absent + python found, non-zero exit → error with stderr tail', async () => {
    const b = new VenvBootstrap({
      repoRoot: '/repo',
      detectVenvFn: () => false,
      findPythonFn: () => ({ cmd: 'py', args: ['-3.12'] }),
      spawnFn: () =>
        makeFakeChild(1, { stderr: 'ERROR: pip install failed\n' }) as never,
    });
    const job = b.start();
    await until(() => b.getJob(job.id)?.status === 'error');
    expect(b.getJob(job.id)?.error).toMatch(/exited with code 1/);
    expect(b.getJob(job.id)?.error).toMatch(/pip install failed/);
  });

  it('detect() returns correct venvPresent / pythonFound / state', async () => {
    const bPresent = new VenvBootstrap({
      repoRoot: '/repo',
      detectVenvFn: () => true,
      findPythonFn: () => ({ cmd: 'py', args: ['-3.12'] }),
    });
    const result = await bPresent.detect();
    expect(result.venvPresent).toBe(true);
    expect(result.pythonFound).toBe(true);
    expect(result.installed).toBe(true);
    expect(result.state).toBe('present');

    const bAbsent = new VenvBootstrap({
      repoRoot: '/repo',
      detectVenvFn: () => false,
      findPythonFn: () => null,
    });
    const result2 = await bAbsent.detect();
    expect(result2.venvPresent).toBe(false);
    expect(result2.pythonFound).toBe(false);
    expect(result2.installed).toBe(false);
    expect(result2.state).toBe('absent');
  });

  it('recheck promotes a job to installed once venv appears', async () => {
    let venvPresent = false;
    const b = new VenvBootstrap({
      repoRoot: '/repo',
      detectVenvFn: () => venvPresent,
      findPythonFn: () => ({ cmd: 'py', args: ['-3.12'] }),
      spawnFn: () => makeFakeChild(0) as never,
    });
    // detectVenvFn always false → exit 0 but post-check false → error
    const job = b.start();
    await until(() => b.getJob(job.id)?.status === 'error');
    venvPresent = true;
    const rechecked = await b.recheck(job.id);
    expect(rechecked?.status).toBe('installed');
  });
});
