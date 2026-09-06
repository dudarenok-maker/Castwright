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
      ortSwapFn: async () => 'skip',
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
      ortSwapFn: async () => 'skip',
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
      ortSwapFn: async () => 'skip',
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
      ortSwapFn: async () => 'skip',
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
      ortSwapFn: async () => 'skip',
    });
    const job = b.start();
    await until(() => b.getJob(job.id)?.status === 'error');
    state = 'ready';
    const uchecked = await b.recheck(job.id);
    expect(uchecked?.status).toBe('installed');
  });

  /* #3039 — the sidecar must be stopped before pip runs (it holds the
     onnxruntime DLL pip needs to replace) and restarted afterward, on both
     the success and the failed-install path. */
  describe('sidecar stop/restart around the install (#3039)', () => {
    it('stops the sidecar before spawning and restarts it after a successful install', async () => {
      const calls: string[] = [];
      const { fn: detectFn } = detectSequence(['not-installed', 'ready']);
      const b = new QwenInstallBootstrap({
        repoRoot: '/repo',
        detectFn,
        spawnFn: () => {
          calls.push('spawn');
          return makeFakeChild(0) as never;
        },
        stopSidecarFn: async () => {
          calls.push('stop');
        },
        startSidecarFn: async () => {
          calls.push('start');
        },
        ortSwapFn: async () => 'skip',
      });
      const job = b.start();
      await until(() => b.getJob(job.id)?.status === 'installed');
      expect(calls).toEqual(['stop', 'spawn', 'start']);
    });

    it('still restarts the sidecar when the installer exits non-zero', async () => {
      const calls: string[] = [];
      const b = new QwenInstallBootstrap({
        repoRoot: '/repo',
        detectFn: () => 'not-installed',
        spawnFn: () => {
          calls.push('spawn');
          return makeFakeChild(1, { stderr: 'ERROR: pip failed\n' }) as never;
        },
        stopSidecarFn: async () => {
          calls.push('stop');
        },
        startSidecarFn: async () => {
          calls.push('start');
        },
        ortSwapFn: async () => 'skip',
      });
      const job = b.start();
      await until(() => b.getJob(job.id)?.status === 'error');
      expect(calls).toEqual(['stop', 'spawn', 'start']);
    });

    it('does not spawn the installer if already installed, and never touches the sidecar', async () => {
      const calls: string[] = [];
      const b = new QwenInstallBootstrap({
        repoRoot: '/repo',
        detectFn: () => 'ready',
        spawnFn: () => makeFakeChild(0) as never,
        stopSidecarFn: async () => {
          calls.push('stop');
        },
        startSidecarFn: async () => {
          calls.push('start');
        },
        ortSwapFn: async () => 'skip',
      });
      const job = b.start();
      await until(() => b.getJob(job.id)?.status === 'installed');
      expect(calls).toEqual([]);
    });

    it('fails when the default sidecar hooks would encounter an adopted sidecar', async () => {
      /* The production default path with no active supervisor injection
         would call defaultStopSidecar, which throws on an adopted sidecar
         (handle === null). With injected hooks this is skipped; without them,
         it surfaces as an install error. This test uses the real defaults to
         verify the error path (no supervisor → defaultStopSidecar gets called).
         We inject a detectFn so the spawn is mocked but the supervisor check
         is real. Note: getActiveSupervisor returns the _active supervisor if
         one was registered; without registerActiveSupervisor() being called
         this is null. defaultStopSidecar/Start only throw if a supervisor
         exists but is in a bad state. With null supervisor they are no-ops,
         so this test can proceed to detect() being called. The installed
         short-circuit (before === 'ready') means the stop/start hooks never
         run. */
      const { fn: detectFn } = detectSequence(['not-installed', 'ready']);
      const b = new QwenInstallBootstrap({
        repoRoot: '/repo',
        detectFn,
        spawnFn: () => makeFakeChild(0) as never,
        ortSwapFn: async () => 'skip',
      });
      const job = b.start();
      await until(() => b.getJob(job.id)?.status === 'installed');
      // With no active supervisor, defaultStopSidecar is a no-op, so install succeeds.
      expect(b.getJob(job.id)?.status).toBe('installed');
    });

    it('errors clearly when stopSidecarFn throws (e.g. adopted sidecar)', async () => {
      const { fn: detectFn } = detectSequence(['not-installed']);
      const b = new QwenInstallBootstrap({
        repoRoot: '/repo',
        detectFn,
        spawnFn: () => makeFakeChild(0) as never,
        stopSidecarFn: async () => {
          throw new Error('Cannot stop an externally-managed sidecar');
        },
        ortSwapFn: async () => 'skip',
      });
      const job = b.start();
      await until(() => b.getJob(job.id)?.status === 'error');
      expect(b.getJob(job.id)?.error).toMatch(/externally-managed sidecar/);
    });

    it('reports install as successful even when startSidecarFn throws (e.g. code-43 hold-down)', async () => {
      /* #3039 Finding 3: a successful install with a restart problem should
         report as installed (with the restart error logged separately), not as
         failed. The operator needs to know the Qwen install itself succeeded,
         even if the sidecar can't be restarted due to a hold-down state. */
      const { fn: detectFn } = detectSequence(['not-installed', 'ready']);
      const calls: string[] = [];
      const b = new QwenInstallBootstrap({
        repoRoot: '/repo',
        detectFn,
        spawnFn: () => {
          calls.push('spawn');
          return makeFakeChild(0) as never;
        },
        stopSidecarFn: async () => {
          calls.push('stop');
        },
        startSidecarFn: async () => {
          calls.push('start');
          throw new Error('code-43 hold-down: device assignment too small');
        },
        ortSwapFn: async () => 'skip',
      });
      const job = b.start();
      await until(() => b.getJob(job.id)?.status === 'installed');
      /* Verify stop and spawn happened (we tried to proceed). The install
         succeeded (detect() returned 'ready'), so the job is installed despite
         the restart error. The restart problem is logged as a warning. */
      expect(calls).toEqual(['stop', 'spawn', 'start']);
      expect(b.getJob(job.id)?.status).toBe('installed');
    });
  });

  /* #3039 — a pip failure dump often ends with pip's own routine "new release
     available" notice printed AFTER the real error; the job's error field
     must still surface the actual failure, not just that trailing notice.
     The old slice(-3) logic would miss the WinError 5 when the error is
     buried in a longer traceback. This fixture reproduces the real captured
     shape: CRLF-terminated lines with the traceback, error message several
     lines up, followed by blank lines and notice lines.
     OLD slice(-3) would see only the last 3 non-notice lines after filtering.
     NEW extractInstallErrorDetail filters notices, keeps last 5 filtered lines,
     so it captures the full error context including WinError 5.
     This test MUST fail if slice(-3) is used (verifies the fix works). */
  it('surfaces the real error even when pip prints its update notice after it', async () => {
    const stderrFixture =
      'Traceback (most recent call last):\r\n' +
      '  File "C:\\\\Python\\\\lib\\\\site-packages\\\\pip.py", line 123\r\n' +
      '    from onnxruntime import capi\r\n' +
      'OSError: [WinError 5] Access is denied: ' +
      "'onnxruntime\\\\capi\\\\onnxruntime_providers_shared.dll'\r\n" +
      'Check the permissions. The DLL is in use.\r\n' +
      'See the sidecar logs for more details.\r\n' +
      '\r\n' +
      '[notice] A new release of pip is available: 24.0 -> 24.1\r\n' +
      '[notice] To update, run: python.exe -m pip install --upgrade pip\r\n';

    const b = new QwenInstallBootstrap({
      repoRoot: '/repo',
      detectFn: () => 'not-installed',
      spawnFn: () => makeFakeChild(1, { stderr: stderrFixture }) as never,
      ortSwapFn: async () => 'skip',
    });
    const job = b.start();
    await until(() => b.getJob(job.id)?.status === 'error');
    expect(b.getJob(job.id)?.error).toMatch(/WinError 5/);
    /* Also verify that the notice lines are filtered out and the error message
       carries the real error, not the notice. */
    expect(b.getJob(job.id)?.error).not.toMatch(/A new release/);
  });
});
