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
 * (`withSidecarHeld`), which suppresses auto-respawn, holds the queue, and always
 * brings the sidecar back. After the installer lands, the venv's ONNX runtime is
 * restored (ort-restore.ts), still inside the hold, because that swap replaces
 * the same DLLs.
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
import { getActiveSupervisor } from './sidecar-supervisor.js';
import { resolveVenvRuntimeProfile } from './spawn-sidecar.js';
import { restoreOrtRuntime, type OrtRestoreOutcome } from './ort-restore.js';
import { resolveSidecarVenvDir } from '../diagnostics/venv.js';
import { configValue } from '../config/resolver.js';

/* #3039 — pull the actionable line(s) out of the installer's stderr tail.
   pip prints its own routine "[notice] A new release of pip is available…"
   line AFTER a real failure (including a WinError 5 traceback), so a naive
   "last N lines" slice can surface only that notice and hide the actual
   error the job.error field exists to report. Drop pip's own notice lines
   first, then take the tail of what's left. Windows stderr is CRLF-terminated,
   so split on both LF and CR to avoid empty strings in the lines array. */
function extractInstallErrorDetail(stderrTail: string): string {
  const lines = stderrTail
    .trim()
    .split(/[\r\n]+/)
    .filter((line) => line.length > 0 && !/^\[notice\]/i.test(line.trim()));
  return lines.slice(-5).join(' ').trim();
}

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

  constructor(opts: WhisperInstallOptions) {
    this.repoRoot = opts.repoRoot;
    this.spawnFn = opts.spawnFn ?? (realSpawn as unknown as WhisperSpawnFn);
    this.detectFn = opts.detectFn ?? (() => detectWhisperInstallStateOnDisk(this.repoRoot));
    this.installArgsOverride = opts.installArgs;
    this.holdSidecarFn = opts.holdSidecarFn ?? defaultHoldSidecar;
    this.restoreOrtFn = opts.restoreOrtFn ?? (() => this.restoreOrtInSidecarVenv());
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

    this.transition(job, 'installing', { step: 'Stopping the voice engine so the installer can update its files…' });
    /* An installer failure propagates out of the hold (the hold still
       releases and respawns) and lands as the job's error. An ORT-restore failure
       is RETURNED, not thrown: the installer had succeeded by then and the job
       must say so — thrown, it would read as a failed Whisper install.

       The ORT restore must run whenever the pip step has executed (which
       clobbers the runtime) REGARDLESS of whether the rest of the installer
       script goes on to succeed or fail. If the installer fails, we still need
       to restore/verify the GPU runtime before the hold releases. */
    const ort = await this.holdSidecarFn<{ outcome: OrtRestoreOutcome } | { failure: Error }>(async () => {
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
        if (installerError) {
          return { failure: installerError };
        }
        return { outcome };
      } catch (err) {
        if (installerError) {
          console.warn(`[whisper-install] ORT restore also failed: ${err instanceof Error ? err.message : String(err)}`);
          return { failure: installerError };
        }
        return { failure: err instanceof Error ? err : new Error(String(err)) };
      }
    });
    /* The hold has released here and the supervisor has already attempted
       its respawn (a failed respawn is the supervisor's to report — it is
       not an install outcome). */
    if ('failure' in ort) {
      this.transition(job, 'error', {
        error:
          `Whisper ASR installed, but restoring the GPU ONNX runtime afterwards failed: ${ort.failure.message} ` +
          'The CPU Whisper may run until it is repaired — with the app closed, run ' +
          'server/tts-sidecar/scripts/install-ort.mjs against the sidecar venv python.',
      });
      return;
    }
    console.log(`[whisper-install] onnxruntime after install: ${ort.outcome}`);

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
    return new Promise((resolve, reject) => {
      let proc: ChildProcess;
      try {
        proc = this.spawnFn('node', [script, ...this.resolveInstallArgs()], {
          cwd: this.repoRoot,
          windowsHide: true,
        });
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)));
        return;
      }
      let stderrTail = '';
      const onStdout = (b: Buffer): void => {
        for (const line of b.toString('utf8').split('\n')) {
          const m = line.match(/\[install-whisper\]\s*(.+)/);
          if (m) this.update(job, { step: m[1].trim() });
        }
      };
      const onStderr = (b: Buffer): void => {
        /* Keep only the tail — a pip/HF failure dump can be huge; the last
           few lines carry the actionable error. #3039: widened to 4000 chars
           so a real error isn't pushed entirely out of the window by pip's
           own routine notice line(s) printed after it — see
           extractInstallErrorDetail. */
        stderrTail = (stderrTail + b.toString('utf8')).slice(-4000);
      };
      proc.stdout?.on('data', onStdout);
      proc.stderr?.on('data', onStderr);
      proc.on('error', (err) => reject(err));
      proc.on('close', (code) => {
        if (code === 0) {
          resolve();
        } else {
          reject(
            new Error(
              `install-whisper.mjs exited with code ${code}.` +
                (stderrTail.trim() ? ` ${extractInstallErrorDetail(stderrTail)}` : ''),
            ),
          );
        }
      });
    });
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
        this.runChild(python, ['-m', 'pip', ...args], {
          failure: (code, detail) => `pip ${args.join(' ')} exited with code ${code}.${detail ? ` ${detail}` : ''}`,
        }),
      log: (m) => console.log(`[whisper-install] ${m}`),
    });
  }

  /** Spawn + await one child through spawnFn. Never blocks the event loop.
      Resolves on exit 0; rejects with `failure(code, stderrDetail)` otherwise. */
  private runChild(
    cmd: string,
    args: readonly string[],
    hooks: { onStdoutLine?: (line: string) => void; failure: (code: number | null, detail: string) => string },
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      let proc: ChildProcess;
      try {
        proc = this.spawnFn(cmd, args, { cwd: this.repoRoot, windowsHide: true });
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)));
        return;
      }
      let stderrTail = '';
      proc.stdout?.on('data', (b: Buffer): void => {
        if (!hooks.onStdoutLine) return;
        for (const line of b.toString('utf8').split('\n')) hooks.onStdoutLine(line);
      });
      proc.stderr?.on('data', (b: Buffer): void => {
        stderrTail = (stderrTail + b.toString('utf8')).slice(-4000);
      });
      proc.on('error', (err) => reject(err));
      proc.on('close', (code) => {
        if (code === 0) resolve();
        else reject(new Error(hooks.failure(code, extractInstallErrorDetail(stderrTail))));
      });
    });
  }

  /** Reset for tests — drops all jobs. */
  _reset(): void {
    this.jobs.clear();
    this.active = null;
    this.nextId = 1;
  }
}

/** Default holdSidecarFn — see WhisperInstallOptions.holdSidecarFn. */
function defaultHoldSidecar<T>(fn: () => Promise<T>): Promise<T> {
  const supervisor = getActiveSupervisor();
  return supervisor ? supervisor.withSidecarHeld(fn) : fn();
}
