/* In-app Kokoro install bootstrap (fs-21). Spawns
 * server/tts-sidecar/scripts/install-kokoro.mjs and surfaces its
 * `[install-kokoro]` step lines so a deployer can install the Kokoro weights
 * from Admin → Model Manager without a terminal. Progress is STEP-based (no single
 * byte total for the ONNX download).
 *
 * #2192 / #3039: the install runs with the sidecar HELD DOWN. pip cannot
 * replace a DLL a live process has memory-mapped (WinError 5), and the sidecar
 * imports onnxruntime at boot. After the installer lands, the venv's ONNX
 * runtime is restored (ort-restore.ts), still inside the hold, because that
 * swap replaces the same DLLs.
 *
 * State machine:
 *   idle → detecting → installing → installed
 *                          └─ error ↗
 *
 * Unlike Coqui/Whisper, Kokoro state is BINARY: either the weight files are
 * present on disk (`installed`) or they are not (`not-installed`). There is no
 * intermediate `weights-missing` / `model-missing` state because Kokoro has no
 * venv-package prerequisite separate from its weights — the check is purely
 * file presence.
 *
 * Dependency-injectable (`spawnFn`, `detectFn`, `holdSidecarFn`, `restoreOrtFn`)
 * so the route's vitest harness runs the whole machine offline with no real download.
 */

import { spawn as realSpawn, type ChildProcess } from 'node:child_process';
import { join } from 'node:path';
import { detectKokoroInstalledOnDisk } from './kokoro-install-detect.js';
import { resolveVenvRuntimeProfile } from './spawn-sidecar.js';
import { restoreOrtRuntime, type OrtRestoreOutcome } from './ort-restore.js';
import { resolveSidecarVenvDir } from '../diagnostics/venv.js';
import { isAnyGenerationActive } from '../gpu/active-generation-gate.js';
import {
  defaultHoldSidecar,
  runChild,
  DEFAULT_CHILD_IDLE_TIMEOUT_MS,
} from './install-bootstrap-shared.js';

export type KokoroInstallState = 'installed' | 'not-installed';

export type KokoroInstallJobStatus = 'detecting' | 'installing' | 'installed' | 'error';

export interface KokoroInstallJob {
  id: string;
  status: KokoroInstallJobStatus;
  /** Latest `[install-kokoro]` step line, surfaced to the UI as status text
      (there's no byte total to drive a percentage bar). */
  step: string | null;
  error: string | null;
  startedAt: number;
  updatedAt: number;
}

export type KokoroSpawnFn = (
  cmd: string,
  args: readonly string[],
  opts?: { cwd?: string; windowsHide?: boolean },
) => ChildProcess;

export interface KokoroInstallOptions {
  /** Repo root — used to locate install-kokoro.mjs and to probe the weight files. */
  repoRoot: string;
  spawnFn?: KokoroSpawnFn;
  /** Stubbable install-state probe (offline tests). Defaults to the on-disk
      detector against repoRoot. Returns true if installed, false otherwise. */
  detectFn?: () => boolean | Promise<boolean>;
  /** Install flags forwarded to install-kokoro.mjs. */
  installArgs?: readonly string[];
  /** Runs `fn` with the sidecar held down. Defaults to the active
      supervisor's withSidecarHeld (a plain pass-through when no supervisor
      is registered). */
  holdSidecarFn?: <T>(fn: () => Promise<T>) => Promise<T>;
  /** Restores the venv's ONNX runtime after the installer. Defaults to
      ort-restore.ts against the sidecar venv, running pip through spawnFn. */
  restoreOrtFn?: () => Promise<OrtRestoreOutcome>;
  /** "Is a render in flight" — holding the sidecar would kill it. Defaults
      to the gpu leaf gate, which fails CLOSED when routes/generation.ts has
      not registered its accessor (always registered in the real server). */
  generationActiveFn?: () => boolean;
  /** How long a child (the installer, or a pip step) may produce NO output at
      all before it is killed and reported as stalled. Idle time, not wall
      clock: the download runs for minutes but never goes quiet, whereas a
      stalled download never settles (#3043 M2). */
  childIdleTimeoutMs?: number;
}

export class KokoroInstallBootstrap {
  private jobs = new Map<string, KokoroInstallJob>();
  private active: string | null = null;
  private nextId = 1;

  private readonly repoRoot: string;
  private readonly spawnFn: KokoroSpawnFn;
  private readonly detectFn: () => boolean | Promise<boolean>;
  private readonly installArgs: readonly string[];
  private readonly holdSidecarFn: <T>(fn: () => Promise<T>) => Promise<T>;
  private readonly restoreOrtFn: () => Promise<OrtRestoreOutcome>;
  private readonly generationActiveFn: () => boolean;
  private readonly childIdleTimeoutMs: number;

  constructor(opts: KokoroInstallOptions) {
    this.repoRoot = opts.repoRoot;
    this.spawnFn = opts.spawnFn ?? (realSpawn as unknown as KokoroSpawnFn);
    this.detectFn = opts.detectFn ?? (() => detectKokoroInstalledOnDisk(this.repoRoot));
    this.installArgs = opts.installArgs ?? [];
    this.holdSidecarFn = opts.holdSidecarFn ?? defaultHoldSidecar;
    this.restoreOrtFn = opts.restoreOrtFn ?? (() => this.restoreOrtInSidecarVenv());
    this.generationActiveFn = opts.generationActiveFn ?? isAnyGenerationActive;
    this.childIdleTimeoutMs = opts.childIdleTimeoutMs ?? DEFAULT_CHILD_IDLE_TIMEOUT_MS;
  }

  /** Probe install-state without kicking off a job. Used by GET /detect. */
  async detect(): Promise<{ state: KokoroInstallState; installed: boolean }> {
    const installed = await this.detectFn();
    const state: KokoroInstallState = installed ? 'installed' : 'not-installed';
    return { state, installed };
  }

  getJob(id: string): KokoroInstallJob | null {
    return this.jobs.get(id) ?? null;
  }

  getActiveJob(): KokoroInstallJob | null {
    return this.active ? this.jobs.get(this.active) ?? null : null;
  }

  /** Kick off (or return the in-flight) install job. Returns synchronously;
      the spawn runs in the background and the caller polls GET /install/:id. */
  start(): KokoroInstallJob {
    const existing = this.getActiveJob();
    if (existing && existing.status !== 'installed' && existing.status !== 'error') {
      return existing;
    }
    const id = String(this.nextId++);
    const job: KokoroInstallJob = {
      id,
      status: 'detecting',
      step: null,
      error: null,
      startedAt: Date.now(),
      updatedAt: Date.now(),
    };
    this.jobs.set(id, job);
    this.active = id;
    void this.run(job).catch((err) => {
      this.transition(job, 'error', {
        error: err instanceof Error ? err.message : String(err),
      });
    });
    return job;
  }

  private async run(job: KokoroInstallJob): Promise<void> {
    /* Already installed? short-circuit (idempotent — the install script is also
       idempotent, but skipping the multi-minute spawn is the common path on a
       box where Kokoro weights were already pre-fetched). */
    const before = await this.detectFn();
    if (before) {
      this.transition(job, 'installed', { step: 'Already installed.' });
      return;
    }

    /* Holding the sidecar kills whatever it is rendering. Refuse up front
       rather than let the hold silently abort a chapter. */
    if (this.generationActiveFn()) {
      throw new Error(
        'Cannot install while a chapter is being generated. Wait for the generation to finish, then try again.',
      );
    }

    this.transition(job, 'installing', { step: 'Stopping the voice engine so the installer can update its files…' });
    /* Two INDEPENDENT facts come back out of the hold, and neither may be
       reported as the other (#3043 S1):

       - whether the installer script succeeded, and
       - what the ORT restore did.

       The restore must run whenever the pip step has executed — which is what
       clobbers the runtime — REGARDLESS of whether the rest of the installer
       goes on to succeed or fail, and it runs inside the hold because that is
       where the sidecar is down and the DLLs are replaceable. So neither
       outcome can be thrown past the other: both are RETURNED, and the
       reporting below picks the message for the pair. */
    const ort = await this.holdSidecarFn<{
      installerError?: Error;
      restoreError?: Error;
      restoreOutcome?: OrtRestoreOutcome;
    }>(async () => {
      this.update(job, { step: 'Starting installer…' });
      let installerError: Error | null = null;
      try {
        await this.spawnInstaller(job);
      } catch (err) {
        installerError = err instanceof Error ? err : new Error(String(err));
      }
      /* Still inside the hold: the swap replaces the DLLs the sidecar maps.
         Run the restore even if the installer failed, as the pip step may have
         already clobbered the runtime. */
      this.update(job, { step: 'Checking the ONNX runtime the voice engine needs…' });
      try {
        const outcome = await this.restoreOrtFn();
        return { installerError: installerError ?? undefined, restoreOutcome: outcome };
      } catch (err) {
        const restoreError = err instanceof Error ? err : new Error(String(err));
        return { installerError: installerError ?? undefined, restoreError };
      }
    });
    /* The hold has released here and the supervisor has already attempted
       its respawn (a failed respawn is the supervisor's to report — it is
       not an install outcome).

       Log what the restore did on EVERY path, including the installer-failure
       one — that path is the only reason the restore runs there at all, so a
       silent record of it would be no record (#3043 N2). */
    if (ort.restoreError) {
      console.warn(`[kokoro-install] onnxruntime after install: restore FAILED — ${ort.restoreError.message}`);
    } else {
      console.log(`[kokoro-install] onnxruntime after install: ${ort.restoreOutcome}`);
    }

    /* The installer's own failure is the job's error, verbatim — the restore's
       outcome is context appended to it, never a substitute for it. Reporting
       an installer failure through the restore-failed sentence told the
       operator the install had landed when it had not, blamed a step that had
       often SUCCEEDED, and named the wrong repair (#3043 S1). */
    if (ort.installerError) {
      this.transition(job, 'error', {
        error:
          `${ort.installerError.message} ` +
          (ort.restoreError
            ? `Restoring the GPU ONNX runtime afterwards also failed: ${ort.restoreError.message} ` +
              'Kokoro may run on the CPU until it is repaired — with the app closed, run ' +
              'server/tts-sidecar/scripts/install-ort.mjs against the sidecar venv python. ' +
              'Then retry the install (downloads resume).'
            : 'The GPU ONNX runtime was checked and is intact. Retry the install (downloads resume).'),
      });
      return;
    }
    if (ort.restoreError) {
      /* The install DID land; only the runtime restore after it failed. Saying
         so is the whole point of keeping the two facts apart. */
      this.transition(job, 'error', {
        error:
          `Kokoro installed, but restoring the GPU ONNX runtime afterwards failed: ${ort.restoreError.message} ` +
          'Kokoro may run on the CPU until it is repaired — with the app closed, run ' +
          'server/tts-sidecar/scripts/install-ort.mjs against the sidecar venv python.',
      });
      return;
    }

    /* Re-probe: the script exited 0, confirm the weight files actually landed. A
       0-exit with weights still missing is surfaced as an error so the UI
       doesn't claim success on a partial download. */
    const after = await this.detectFn();
    if (after) {
      this.transition(job, 'installed', { step: 'Done. Kokoro installed.' });
    } else {
      this.transition(job, 'error', {
        error:
          'Installer finished but the Kokoro weight files are still missing — the download may have been interrupted. Retry (downloads resume).',
      });
    }
  }

  /** Re-probe install-state; promote a stuck installing/error job to installed
      if the weight files are now present. */
  async recheck(id: string): Promise<KokoroInstallJob | null> {
    const job = this.jobs.get(id);
    if (!job) return null;
    const installed = await this.detectFn();
    if (installed && job.status !== 'installed') {
      this.transition(job, 'installed', { step: 'Done. Kokoro installed.' });
    }
    return this.jobs.get(id) ?? null;
  }

  private spawnInstaller(job: KokoroInstallJob): Promise<void> {
    const script = join(
      this.repoRoot,
      'server',
      'tts-sidecar',
      'scripts',
      'install-kokoro.mjs',
    );
    return runChild(
      this.spawnFn,
      this.repoRoot,
      'node',
      [script, ...this.installArgs],
      {
        onStdoutLine: (line) => {
          const m = line.match(/\[install-kokoro\]\s*(.+)/);
          if (m) this.update(job, { step: m[1].trim() });
        },
        failure: (code, detail) => `install-kokoro.mjs exited with code ${code}.${detail ? ` ${detail}` : ''}`,
      },
      { engineLabel: 'install-kokoro', childIdleTimeoutMs: this.childIdleTimeoutMs },
    );
  }

  private transition(
    job: KokoroInstallJob,
    status: KokoroInstallJobStatus,
    extra: Partial<KokoroInstallJob> = {},
  ): void {
    job.status = status;
    Object.assign(job, extra);
    job.updatedAt = Date.now();
  }

  private update(job: KokoroInstallJob, patch: Partial<KokoroInstallJob>): void {
    Object.assign(job, patch);
    job.updatedAt = Date.now();
  }

  /** Default restoreOrtFn: the sidecar venv, the profile the sidecar will
      run with, pip through the same async spawn seam as the installer. */
  private restoreOrtInSidecarVenv(): Promise<OrtRestoreOutcome> {
    const venvDir = resolveSidecarVenvDir(this.repoRoot);
    const python =
      process.platform === 'win32'
        ? join(venvDir, 'Scripts', 'python.exe')
        : join(venvDir, 'bin', 'python');
    return restoreOrtRuntime({
      venvDir,
      profile: resolveVenvRuntimeProfile(venvDir),
      platform: process.platform,
      runPip: (args) =>
        runChild(
          this.spawnFn,
          this.repoRoot,
          python,
          ['-m', 'pip', ...args],
          {
            failure: (code, detail) => `pip ${args.join(' ')} exited with code ${code}.${detail ? ` ${detail}` : ''}`,
          },
          { engineLabel: 'pip-restore', childIdleTimeoutMs: this.childIdleTimeoutMs },
        ),
      log: (m) => console.log(`[kokoro-install] ${m}`),
    });
  }

  /** Reset for tests — drops all jobs. */
  _reset(): void {
    this.jobs.clear();
    this.active = null;
    this.nextId = 1;
  }
}
