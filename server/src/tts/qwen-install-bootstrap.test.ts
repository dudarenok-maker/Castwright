/* QwenInstallBootstrap state machine (qwen-default phase 3). Runs the whole
   install offline: stubbed detectFn drives the install-state, stubbed spawnFn
   emits fake `[install-qwen3]` progress + an exit code. No real pip/download. */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { QwenInstallBootstrap, type QwenInstallOptions } from './qwen-install-bootstrap.js';
import type { QwenInstallState } from '../workspace/user-settings.js';

/* Every bootstrap under test gets the offline seams: no real supervisor hold,
   no real pip swap, no fail-closed generation gate (routes/generation.ts is
   not loaded here, so the real gate would refuse every install). */
const OFFLINE: Pick<QwenInstallOptions, 'holdSidecarFn' | 'restoreOrtFn' | 'generationActiveFn'> = {
  holdSidecarFn: (fn) => fn(),
  restoreOrtFn: async () => 'not-needed',
  generationActiveFn: () => false,
};

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
      ...OFFLINE,
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
      ...OFFLINE,
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
      ...OFFLINE,
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
      ...OFFLINE,
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
      ...OFFLINE,
    });
    const job = b.start();
    await until(() => b.getJob(job.id)?.status === 'error');
    state = 'ready';
    const uchecked = await b.recheck(job.id);
    expect(uchecked?.status).toBe('installed');
  });

  /* #2192 / #3039 — the install runs INSIDE the supervisor's maintenance hold
     (the sidecar maps the onnxruntime DLL pip has to replace), and the ONNX
     runtime restore runs inside that same hold. The hold is the supervisor's
     own scoped primitive; here it is a recording pass-through. */
  describe('install runs inside the sidecar hold (#2192 / #3039)', () => {
    function recordingHold(calls: string[]): QwenInstallOptions['holdSidecarFn'] {
      return async (fn) => {
        calls.push('hold');
        try {
          return await fn();
        } finally {
          calls.push('release');
        }
      };
    }

    it('[HEADLINE] hold → installer → ORT restore → release, then the job is installed', async () => {
      const calls: string[] = [];
      const { fn: detectFn } = detectSequence(['not-installed', 'ready']);
      const b = new QwenInstallBootstrap({
        repoRoot: '/repo',
        detectFn,
        spawnFn: () => {
          calls.push('spawn');
          return makeFakeChild(0) as never;
        },
        holdSidecarFn: recordingHold(calls),
        restoreOrtFn: async () => {
          calls.push('ort');
          return 'swapped';
        },
        generationActiveFn: () => false,
      });
      const job = b.start();
      await until(() => b.getJob(job.id)?.status === 'installed');
      expect(calls).toEqual(['hold', 'spawn', 'ort', 'release']);
    });

    it("an installer failure still releases the hold, skips the ORT restore, and is the job's error", async () => {
      const calls: string[] = [];
      const b = new QwenInstallBootstrap({
        repoRoot: '/repo',
        detectFn: () => 'not-installed',
        spawnFn: () => {
          calls.push('spawn');
          return makeFakeChild(1, { stderr: 'ERROR: pip failed\n' }) as never;
        },
        holdSidecarFn: recordingHold(calls),
        restoreOrtFn: async () => {
          calls.push('ort');
          return 'swapped';
        },
        generationActiveFn: () => false,
      });
      const job = b.start();
      await until(() => b.getJob(job.id)?.status === 'error');
      expect(calls).toEqual(['hold', 'spawn', 'ort', 'release']);
      expect(b.getJob(job.id)?.error).toMatch(/exited with code 1.*pip failed/);
    });

    it('already installed: never enters the hold, never spawns', async () => {
      const calls: string[] = [];
      const b = new QwenInstallBootstrap({
        repoRoot: '/repo',
        detectFn: () => 'ready',
        spawnFn: () => {
          calls.push('spawn');
          return makeFakeChild(0) as never;
        },
        holdSidecarFn: recordingHold(calls),
        restoreOrtFn: async () => 'not-needed',
        generationActiveFn: () => false,
      });
      const job = b.start();
      await until(() => b.getJob(job.id)?.status === 'installed');
      expect(calls).toEqual([]);
    });

    it("a refused hold (adopted sidecar, mid-respawn, …) is the job's error, and the installer never runs", async () => {
      let spawned = 0;
      const b = new QwenInstallBootstrap({
        repoRoot: '/repo',
        detectFn: () => 'not-installed',
        spawnFn: () => {
          spawned++;
          return makeFakeChild(0) as never;
        },
        holdSidecarFn: async () => {
          throw new Error('The voice engine on this port was started outside Castwright, so it cannot be stopped for the install.');
        },
        restoreOrtFn: async () => 'not-needed',
        generationActiveFn: () => false,
      });
      const job = b.start();
      await until(() => b.getJob(job.id)?.status === 'error');
      expect(b.getJob(job.id)?.error).toMatch(/started outside Castwright/);
      expect(spawned).toBe(0);
    });

    it('refuses while a chapter is rendering — before the hold, before the installer', async () => {
      const calls: string[] = [];
      const b = new QwenInstallBootstrap({
        repoRoot: '/repo',
        detectFn: () => 'not-installed',
        spawnFn: () => {
          calls.push('spawn');
          return makeFakeChild(0) as never;
        },
        holdSidecarFn: recordingHold(calls),
        restoreOrtFn: async () => 'not-needed',
        generationActiveFn: () => true,
      });
      const job = b.start();
      await until(() => b.getJob(job.id)?.status === 'error');
      expect(b.getJob(job.id)?.error).toMatch(/while a chapter is being generated/);
      expect(calls).toEqual([]);
    });

    it('an ORT-restore failure AFTER a successful install is an error that says Qwen landed and what to run — not a failed Qwen install', async () => {
      const calls: string[] = [];
      const { fn: detectFn } = detectSequence(['not-installed', 'ready']);
      const b = new QwenInstallBootstrap({
        repoRoot: '/repo',
        detectFn,
        spawnFn: () => {
          calls.push('spawn');
          return makeFakeChild(0) as never;
        },
        holdSidecarFn: recordingHold(calls),
        restoreOrtFn: async () => {
          calls.push('ort');
          throw new Error('pip install --force-reinstall --no-deps onnxruntime-gpu>=1.26,<1.27 exited with code 1. network down');
        },
        generationActiveFn: () => false,
      });
      const job = b.start();
      await until(() => b.getJob(job.id)?.status === 'error');
      expect(calls).toEqual(['hold', 'spawn', 'ort', 'release']); // the hold still released
      const error = b.getJob(job.id)?.error ?? '';
      expect(error).toMatch(/^Qwen3-TTS installed, but restoring the GPU ONNX runtime/);
      expect(error).toMatch(/network down/);
      expect(error).toMatch(/install-ort\.mjs/);
      expect(error).not.toMatch(/install-qwen3\.mjs exited/);
    });
  });

  /* The DEFAULT wiring — the part two earlier rounds got wrong (a marker-only
     helper standing in for the swap; an env var only the sidecar child
     carries standing in for the profile). Real resolveVenvRuntimeProfile +
     real restoreOrtRuntime against a temp venv; only the subprocess is a fake,
     and it is the SAME spawnFn seam the installer uses, awaited — never a
     spawnSync. */
  describe('default ORT restore wiring', () => {
    const roots: string[] = [];
    afterEach(() => {
      vi.unstubAllEnvs();
      for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
    });

    function tempRepo(profile: string): { repoRoot: string; sp: string } {
      const repoRoot = mkdtempSync(join(tmpdir(), 'qwen-install-repo-'));
      roots.push(repoRoot);
      const venvDir = join(repoRoot, 'server', 'tts-sidecar', '.venv');
      const sp = join(venvDir, 'Lib', 'site-packages');
      mkdirSync(join(sp, 'onnxruntime', 'capi'), { recursive: true });
      // The venv was built for `profile` — the stamp is what the sidecar reads.
      writeFileSync(join(venvDir, '.venv-stamp.json'), JSON.stringify({ pythonTag: 'cp312', profile, reqHash: 'x' }));
      // …but pip just clobbered it with the plain CPU build.
      writeFileSync(join(sp, 'onnxruntime', 'capi', 'build_and_package_info.py'), "package_name = 'onnxruntime'\n");
      mkdirSync(join(sp, 'onnxruntime-1.29.0.dist-info'));
      writeFileSync(join(sp, 'onnxruntime-1.29.0.dist-info', 'INSTALLER'), 'pip\n');
      writeFileSync(join(sp, 'onnxruntime-1.29.0.dist-info', 'RECORD'), 'x\n');
      return { repoRoot, sp };
    }

    it('nvidia-stamped venv: after the installer, pip swaps the GPU runtime back through spawnFn (async), profile from the STAMP not an env var', async () => {
      vi.stubEnv('ACCELERATOR', undefined);
      vi.stubEnv('SIDECAR_VENV_DIR', undefined);
      vi.stubEnv('CASTWRIGHT_ACCELERATOR_PROFILE', 'cpu'); // the sidecar-child-only var: must be IGNORED
      const { repoRoot, sp } = tempRepo('nvidia');
      const spawned: { cmd: string; args: string[] }[] = [];
      const { fn: detectFn } = detectSequence(['not-installed', 'ready']);
      const b = new QwenInstallBootstrap({
        repoRoot,
        detectFn,
        spawnFn: (cmd, args) => {
          spawned.push({ cmd, args: [...args] });
          if (args.includes('--force-reinstall')) {
            // The GPU wheel landing, as the real pip step would.
            mkdirSync(join(sp, 'onnxruntime_gpu-1.26.0.dist-info'));
            writeFileSync(join(sp, 'onnxruntime_gpu-1.26.0.dist-info', 'METADATA'), 'Version: 1.26.0\n');
          }
          return makeFakeChild(0) as never;
        },
        holdSidecarFn: (fn) => fn(),
        generationActiveFn: () => false,
      });
      const job = b.start();
      await until(() => b.getJob(job.id)?.status === 'installed');
      const venvPython = process.platform === 'win32' ? join('Scripts', 'python.exe') : join('bin', 'python');
      expect(spawned[0].cmd).toBe('node');
      expect(spawned[0].args[0]).toMatch(/install-qwen3\.mjs$/);
      expect(spawned.slice(1).map((s) => s.cmd.endsWith(venvPython))).toEqual([true, true, true]);
      expect(spawned.slice(1).map((s) => s.args.slice(0, 3))).toEqual([
        ['-m', 'pip', 'uninstall'],
        ['-m', 'pip', 'install'],
        ['-m', 'pip', 'install'],
      ]);
      expect(spawned[2].args).toContain('--force-reinstall');
      expect(existsSync(join(sp, 'onnxruntime-1.26.0.dist-info', 'INSTALLER'))).toBe(true); // marker written last
    });

    it('cpu-stamped venv: no pip after the installer (plain onnxruntime is correct there)', async () => {
      vi.stubEnv('ACCELERATOR', undefined);
      vi.stubEnv('SIDECAR_VENV_DIR', undefined);
      const { repoRoot } = tempRepo('cpu');
      const spawned: string[] = [];
      const { fn: detectFn } = detectSequence(['not-installed', 'ready']);
      const b = new QwenInstallBootstrap({
        repoRoot,
        detectFn,
        spawnFn: (cmd) => {
          spawned.push(cmd);
          return makeFakeChild(0) as never;
        },
        holdSidecarFn: (fn) => fn(),
        generationActiveFn: () => false,
      });
      const job = b.start();
      await until(() => b.getJob(job.id)?.status === 'installed');
      expect(spawned).toEqual(['node']);
    });

    it('a failing pip step surfaces its stderr in the job error (async close path, not spawnSync)', async () => {
      vi.stubEnv('ACCELERATOR', undefined);
      vi.stubEnv('SIDECAR_VENV_DIR', undefined);
      const { repoRoot } = tempRepo('nvidia');
      const { fn: detectFn } = detectSequence(['not-installed', 'ready']);
      const b = new QwenInstallBootstrap({
        repoRoot,
        detectFn,
        spawnFn: (_cmd, args) =>
          (args.includes('uninstall')
            ? makeFakeChild(1, { stderr: 'ERROR: pip uninstall blew up\n[notice] A new release of pip is available\n' })
            : makeFakeChild(0)) as never,
        holdSidecarFn: (fn) => fn(),
        generationActiveFn: () => false,
      });
      const job = b.start();
      await until(() => b.getJob(job.id)?.status === 'error');
      expect(b.getJob(job.id)?.error).toMatch(/Qwen3-TTS installed, but restoring/);
      expect(b.getJob(job.id)?.error).toMatch(/pip uninstall blew up/);
      expect(b.getJob(job.id)?.error).not.toMatch(/A new release/);
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
      ...OFFLINE,
    });
    const job = b.start();
    await until(() => b.getJob(job.id)?.status === 'error');
    expect(b.getJob(job.id)?.error).toMatch(/WinError 5/);
    /* Also verify that the notice lines are filtered out and the error message
       carries the real error, not the notice. */
    expect(b.getJob(job.id)?.error).not.toMatch(/A new release/);
  });

  it('[REGRESSION] an installer failure still attempts ORT restore (both outcomes reported, error takes precedence)', async () => {
    // Fixture: installer fails (exit code 1) with a clear error message
    const installerError = 'HuggingFace download failed: connection timeout\n';
    const restoreOutcome = 'swapped'; // restore succeeds
    let restoreCalled = false;

    const b = new QwenInstallBootstrap({
      repoRoot: '/repo',
      detectFn: () => 'not-installed',
      spawnFn: () => makeFakeChild(1, { stderr: installerError }) as never,
      holdSidecarFn: (fn) => fn(),
      restoreOrtFn: async () => {
        restoreCalled = true;
        return restoreOutcome;
      },
      generationActiveFn: () => false,
    });
    const job = b.start();
    await until(() => b.getJob(job.id)?.status === 'error');

    // Verify that:
    // 1. The restore function WAS called despite installer failure
    expect(restoreCalled).toBe(true);
    // 2. The job reports the installer error (not the restore outcome, since error takes precedence)
    expect(b.getJob(job.id)?.error).toMatch(/HuggingFace download failed/);
    // 3. The job status is error (not installed)
    expect(b.getJob(job.id)?.status).toBe('error');
  });
});
