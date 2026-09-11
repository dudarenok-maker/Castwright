/* In-app Whisper ASR install bootstrap (srv-31, plan 186). Mirrors
 * qwen-install-bootstrap.ts: spawns server/tts-sidecar/scripts/install-whisper.mjs
 * and surfaces its `[install-whisper]` step lines so a deployer can install the
 * ASR engine from Account → Models without a terminal. Progress is STEP-based
 * (no single byte total for the HF download).
 *
 * Unlike Qwen there is no resolver-cache sync — ASR is never an auto-selected
 * synth engine; it's enabled explicitly via SEG_ASR_ENABLED.
 *
 * #2192 / #3039: the install runs with the sidecar HELD DOWN. pip cannot
 * replace a DLL a live process has memory-mapped (WinError 5), and the sidecar
 * imports onnxruntime at boot. The hold is the supervisor's own scoped primitive
 * (`withSidecarHeld`), which suppresses auto-respawn and holds the queue. An idle
 * watchdog kills a stalled installer (one producing no output for 30 minutes) and
 * releases the hold, so a stuck install does not permanently lock the sidecar down.
 * After the installer lands, the venv's ONNX runtime is restored (ort-restore.ts),
 * still inside the hold, because that swap replaces the same DLLs.
 *
 * State machine: idle → detecting → installing → installed (└─ error ↗).
 * Dependency-injectable (spawnFn, detectFn, holdSidecarFn, restoreOrtFn) so the
 * route's vitest harness runs the whole machine offline with no real pip/download.
 */

import { spawn as realSpawn, type ChildProcess } from 'node:child_process';
import { join } from 'node:path';
import {
  detectWhisperInstallStateOnDisk,
  type WhisperInstallState,
} from './whisper-install-detect.js';
import { resolveVenvRuntimeProfile } from './spawn-sidecar.js';
import { restoreOrtRuntime, type OrtRestoreOutcome } from './ort-restore.js';
import { resolveSidecarVenvDir } from '../diagnostics/venv.js';
import { configValue } from '../config/resolver.js';
import { isAnyGenerationActive } from '../gpu/active-generation-gate.js';
import {
  defaultHoldSidecar,
  runChild,
  DEFAULT_CHILD_IDLE_TIMEOUT_MS,
} from './install-bootstrap-shared.js';

export type WhisperInstallJobStatus = 'detecting' | 'installing' | 'installed' | 'error';

export interface WhisperInstallJob {
  id: string;
  status: WhisperInstallJobStatus;
  /** Latest `[install-whisper]` step line, surfaced to the UI as status text. */
  step: string | null;
  error: string | null;
  startedAt: number;
  updatedAt: number;
}

export type WhisperSpawnFn = (
  cmd: string,
  args: readonly string[],
  opts?: { cwd?: string; windowsHide?: boolean },
) => ChildProcess;

export interface WhisperInstallOptions {
  repoRoot: string;
  spawnFn?: WhisperSpawnFn;
  /** Stubbable install-state probe (offline tests). */
  detectFn?: () => WhisperInstallState | Promise<WhisperInstallState>;
  /** Install flags forwarded to install-whisper.mjs (e.g. ['--model', 'base']).
      Explicit override for tests; production leaves this unset so the model
      flag is resolved fresh at spawn time — see resolveInstallArgs(). */
  installArgs?: readonly string[];
  /** Runs `fn` with the sidecar held down. Defaults to the active
      supervisor's withSidecarHeld (a plain pass-through when no supervisor
      is registered — the server has not finished booting, so nothing holds
      the venv's DLLs). */
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
      clock: the HF prefetch legitimately runs for many minutes but never goes
      quiet for long, whereas a stalled download never settles at all — and a
      child that never settles holds the sidecar down and the queue held with
      it, with POST /api/sidecar/restart inert behind the hold (#3043 M2). */
  childIdleTimeoutMs?: number;
}

export class WhisperInstallBootstrap {
  private jobs = new Map<string, WhisperInstallJob>();
  private active: string | null = null;
  private nextId = 1;

  private readonly repoRoot: string;
  private readonly spawnFn: WhisperSpawnFn;
  private readonly detectFn: () => WhisperInstallState | Promise<WhisperInstallState>;
  private readonly installArgsOverride: readonly string[] | undefined;
  private readonly holdSidecarFn: <T>(fn: () => Promise<T>) => Promise<T>;
  private readonly restoreOrtFn: () => Promise<OrtRestoreOutcome>;
  private readonly generationActiveFn: () => boolean;
  private readonly childIdleTimeoutMs: number;

  constructor(opts: WhisperInstallOptions) {
    this.repoRoot = opts.repoRoot;
    this.spawnFn = opts.spawnFn ?? (realSpawn as unknown as WhisperSpawnFn);
    this.detectFn = opts.detectFn ?? (() => detectWhisperInstallStateOnDisk(this.repoRoot));
    this.installArgsOverride = opts.installArgs;
    this.holdSidecarFn = opts.holdSidecarFn ?? defaultHoldSidecar;
    this.restoreOrtFn = opts.restoreOrtFn ?? (() => this.restoreOrtInSidecarVenv());
    this.generationActiveFn = opts.generationActiveFn ?? isAnyGenerationActive;
    this.childIdleTimeoutMs = opts.childIdleTimeoutMs ?? DEFAULT_CHILD_IDLE_TIMEOUT_MS;
  }

  /* PR #2008 review (Major 1): the constructor runs once at server boot
     (whisper-install.ts's `defaultBootstrap`), while `qa.asr.model` can
     change at any time via Advanced Configuration with no restart of the
     SERVER (only the sidecar restarts). Freezing `--model` at construction
     would just move the same module-load-time-const bug here, so the flag
     is resolved fresh on every install run instead. Tests can still pin an
     explicit installArgs to bypass config resolution entirely. */
  private resolveInstallArgs(): readonly string[] {
    return this.installArgsOverride ?? ['--model', configValue<string>('qa.asr.model')];
  }

  /** Probe install-state without kicking off a job. Used by GET /detect. */
  async detect(): Promise<{ state: WhisperInstallState; installed: boolean }> {
    const state = await this.detectFn();
    return { state, installed: state === 'ready' };
  }

  getJob(id: string): WhisperInstallJob | null {
    return this.jobs.get(id) ?? null;
  }

  getActiveJob(): WhisperInstallJob | null {
    return this.active ? this.jobs.get(this.active) ?? null : null;
  }

  /** Kick off (or return the in-flight) install job. */
  start(): WhisperInstallJob {
    const existing = this.getActiveJob();
    if (existing && existing.status !== 'installed' && existing.status !== 'error') {
      return existing;
    }
    const id = String(this.nextId++);
    const job: WhisperInstallJob = {
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

  private async run(job: WhisperInstallJob): Promise<void> {
    const before = await this.detectFn();
    if (before === 'ready') {
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
      console.warn(`[whisper-install] onnxruntime after install: restore FAILED — ${ort.restoreError.message}`);
    } else {
      console.log(`[whisper-install] onnxruntime after install: ${ort.restoreOutcome}`);
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
              'The CPU Whisper may run until it is repaired — with the app closed, run ' +
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
          `Whisper ASR installed, but restoring the GPU ONNX runtime afterwards failed: ${ort.restoreError.message} ` +
          'The CPU Whisper may run until it is repaired — with the app closed, run ' +
          'server/tts-sidecar/scripts/install-ort.mjs against the sidecar venv python.',
      });
      return;
    }

    const after = await this.detectFn();
    if (after === 'ready') {
      this.transition(job, 'installed', { step: 'Done. Whisper ASR installed.' });
    } else {
      this.transition(job, 'error', {
        error:
          after === 'model-missing'
            ? 'Installer finished but the Whisper model is still missing — the download may have been interrupted. Retry (downloads resume).'
            : 'Installer finished but faster-whisper is still not importable in the sidecar venv. Check the sidecar venv bootstrap.',
      });
    }
  }

  /** Re-probe install-state; promote a stuck job to installed if the model is
      now present. */
  async recheck(id: string): Promise<WhisperInstallJob | null> {
    const job = this.jobs.get(id);
    if (!job) return null;
    const state = await this.detectFn();
    if (state === 'ready' && job.status !== 'installed') {
      this.transition(job, 'installed', { step: 'Done. Whisper ASR installed.' });
    }
    return this.jobs.get(id) ?? null;
  }

  private spawnInstaller(job: WhisperInstallJob): Promise<void> {
    const script = join(this.repoRoot, 'server', 'tts-sidecar', 'scripts', 'install-whisper.mjs');
    return runChild(
      this.spawnFn,
      this.repoRoot,
      'node',
      [script, ...this.resolveInstallArgs()],
      {
        onStdoutLine: (line) => {
          const m = line.match(/\[install-whisper\]\s*(.+)/);
          if (m) this.update(job, { step: m[1].trim() });
        },
        failure: (code, detail) => `install-whisper.mjs exited with code ${code}.${detail ? ` ${detail}` : ''}`,
      },
      { engineLabel: 'install-whisper', childIdleTimeoutMs: this.childIdleTimeoutMs },
    );
  }

  private transition(
    job: WhisperInstallJob,
    status: WhisperInstallJobStatus,
    extra: Partial<WhisperInstallJob> = {},
  ): void {
    job.status = status;
    Object.assign(job, extra);
    job.updatedAt = Date.now();
  }

  private update(job: WhisperInstallJob, patch: Partial<WhisperInstallJob>): void {
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
      log: (m) => console.log(`[whisper-install] ${m}`),
    });
  }

  /** Reset for tests — drops all jobs. */
  _reset(): void {
    this.jobs.clear();
    this.active = null;
    this.nextId = 1;
  }
}
