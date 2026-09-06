/* In-app Qwen3-TTS install bootstrap (qwen-default phase 3).
 *
 * Mirrors server/src/ollama/install-bootstrap.ts (the in-app Ollama installer)
 * so a deployer can install the Qwen engine from Account → Models without a
 * terminal. Differences from the Ollama flow:
 *
 *   - There is no vendor binary to download. `server/tts-sidecar/scripts/
 *     install-qwen3.mjs` already does pip-install qwen-tts + prefetch the Base
 *     and VoiceDesign weights itself; we just spawn it and surface its
 *     `[install-qwen3]` step lines. Progress is therefore STEP-based (no byte
 *     total — the multi-GB HF download has no single content-length).
 *   - `detect()` is the filesystem install-state probe (package in the sidecar
 *     venv + Base weights in the HF cache), NOT a PATH check.
 *   - #2192 / #3039: the install runs with the sidecar HELD DOWN. pip cannot
 *     replace a DLL a live process has memory-mapped (WinError 5 on
 *     onnxruntime_providers_shared.dll — reproduced on real hardware in
 *     docs/testing/onbox-a29-results/step-2-genuine-install.md), and the
 *     sidecar imports onnxruntime at boot. The hold is the supervisor's own
 *     scoped primitive (`withSidecarHeld`), which suppresses auto-respawn,
 *     holds the queue, and always brings the sidecar back — this file never
 *     touches `stop()`/`start()`. After the installer lands, the venv's ONNX
 *     runtime is restored for the profile the sidecar runs with (ort-restore.ts),
 *     still inside the hold, because that swap replaces the same DLLs.
 *
 * State machine:
 *   idle → detecting → installing → installed
 *                          └─ error ↗
 *
 * Dependency-injectable (`spawnFn`, `detectFn`, `holdSidecarFn`,
 * `restoreOrtFn`, `generationActiveFn`) so the route's vitest harness runs the
 * whole machine offline with no real pip/download/sidecar.
 */

import { spawn as realSpawn, type ChildProcess } from 'node:child_process';
import { join } from 'node:path';
import { detectQwenInstallStateOnDisk } from './qwen-install-detect.js';
import { getActiveSupervisor } from './sidecar-supervisor.js';
import { resolveVenvRuntimeProfile } from './spawn-sidecar.js';
import { restoreOrtRuntime, type OrtRestoreOutcome } from './ort-restore.js';
import { isAnyGenerationActive } from '../gpu/active-generation-gate.js';
import { resolveSidecarVenvDir } from '../diagnostics/venv.js';
import type { QwenInstallState } from '../workspace/user-settings.js';

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

export type QwenInstallJobStatus = 'detecting' | 'installing' | 'installed' | 'error';

export interface QwenInstallJob {
  id: string;
  status: QwenInstallJobStatus;
  /** Latest `[install-qwen3]` step line, surfaced to the UI as status text
      (there's no byte total to drive a percentage bar). */
  step: string | null;
  error: string | null;
  startedAt: number;
  updatedAt: number;
}

export type QwenSpawnFn = (
  cmd: string,
  args: readonly string[],
  opts?: { cwd?: string; windowsHide?: boolean },
) => ChildProcess;

export interface QwenInstallOptions {
  /** Repo root — used to locate install-qwen3.mjs and to probe the venv. */
  repoRoot: string;
  /** Spawns BOTH the installer script and the post-install pip steps. */
  spawnFn?: QwenSpawnFn;
  /** Stubbable install-state probe (offline tests). Defaults to the on-disk
      detector against repoRoot. */
  detectFn?: () => QwenInstallState | Promise<QwenInstallState>;
  /** Install flags forwarded to install-qwen3.mjs (e.g. ['--cpu']). The full
      install (Base + VoiceDesign) is the default — bespoke voices need the
      VoiceDesign model, so we do NOT pass --skip-design. */
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
}

export class QwenInstallBootstrap {
  private jobs = new Map<string, QwenInstallJob>();
  private active: string | null = null;
  private nextId = 1;

  private readonly repoRoot: string;
  private readonly spawnFn: QwenSpawnFn;
  private readonly detectFn: () => QwenInstallState | Promise<QwenInstallState>;
  private readonly installArgs: readonly string[];
  private readonly holdSidecarFn: <T>(fn: () => Promise<T>) => Promise<T>;
  private readonly restoreOrtFn: () => Promise<OrtRestoreOutcome>;
  private readonly generationActiveFn: () => boolean;

  constructor(opts: QwenInstallOptions) {
    this.repoRoot = opts.repoRoot;
    this.spawnFn = opts.spawnFn ?? (realSpawn as unknown as QwenSpawnFn);
    this.detectFn = opts.detectFn ?? (() => detectQwenInstallStateOnDisk(this.repoRoot));
    this.installArgs = opts.installArgs ?? [];
    this.holdSidecarFn = opts.holdSidecarFn ?? defaultHoldSidecar;
    this.restoreOrtFn = opts.restoreOrtFn ?? (() => this.restoreOrtInSidecarVenv());
    this.generationActiveFn = opts.generationActiveFn ?? isAnyGenerationActive;
  }

  /** Probe install-state without kicking off a job. Used by GET /detect. */
  async detect(): Promise<{ state: QwenInstallState; installed: boolean }> {
    const state = await this.detectFn();
    return { state, installed: state === 'ready' || state === 'loaded' };
  }

  getJob(id: string): QwenInstallJob | null {
    return this.jobs.get(id) ?? null;
  }

  getActiveJob(): QwenInstallJob | null {
    return this.active ? this.jobs.get(this.active) ?? null : null;
  }

  /** Kick off (or return the in-flight) install job. Returns synchronously;
      the spawn runs in the background and the caller polls GET /install/:id. */
  start(): QwenInstallJob {
    const existing = this.getActiveJob();
    if (existing && existing.status !== 'installed' && existing.status !== 'error') {
      return existing;
    }
    const id = String(this.nextId++);
    const job: QwenInstallJob = {
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

  private async run(job: QwenInstallJob): Promise<void> {
    /* Already installed? short-circuit (idempotent — the install script is
       also idempotent, but skipping the multi-minute spawn is the common
       upgrade-flow path). */
    const before = await this.detectFn();
    if (before === 'ready' || before === 'loaded') {
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
    /* An installer failure propagates out of the hold (the hold still
       releases and respawns) and lands as the job's error via start()'s
       catch. An ORT-restore failure is RETURNED, not thrown: the installer
       had succeeded by then and the job must say so — thrown, it would read
       as a failed Qwen install, the misreport the split exists to prevent.

       The ORT restore must run whenever the pip step has executed (which
       clobbers the runtime) REGARDLESS of whether the rest of the installer
       script goes on to succeed or fail. If the installer fails, we still need
       to restore/verify the GPU runtime before the hold releases. */
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
        return {
          installerError: installerError ?? undefined,
          restoreOutcome: outcome,
        };
      } catch (err) {
        const restoreError = err instanceof Error ? err : new Error(String(err));
        if (installerError) {
          /* Both installer and restore failed. Report the installer error as
             primary, but log the restore failure at the console for diagnostics. */
          console.warn(`[qwen-install] ORT restore also failed: ${restoreError.message}`);
        }
        return {
          installerError: installerError ?? undefined,
          restoreError: restoreError,
        };
      }
    });
    /* The hold has released here and the supervisor has already attempted
       its respawn (a failed respawn is the supervisor's to report — it is
       not an install outcome). */
    if (ort.installerError) {
      // Installer failed — report that as the primary error
      const msg = `Qwen3-TTS installer failed: ${ort.installerError.message}`;
      if (ort.restoreError) {
        // Both failed
        this.transition(job, 'error', {
          error: `${msg} The ORT runtime restore also failed, so GPU acceleration will be lost. ` +
            'Retry the install or contact support.',
        });
      } else if (ort.restoreOutcome) {
        // Installer failed but restore succeeded — that's good news
        this.transition(job, 'error', {
          error: `${msg} (The GPU ONNX runtime was successfully verified and is still in place.)`,
        });
      } else {
        // Just the installer error
        this.transition(job, 'error', { error: msg });
      }
      return;
    }
    if (ort.restoreError) {
      // Installer succeeded but restore failed
      this.transition(job, 'error', {
        error:
          `Qwen3-TTS installed, but restoring the GPU ONNX runtime afterwards failed: ${ort.restoreError.message} ` +
          'Kokoro may run on the CPU until it is repaired — with the app closed, run ' +
          'server/tts-sidecar/scripts/install-ort.mjs against the sidecar venv python.',
      });
      return;
    }
    // Both installer and restore succeeded
    if (ort.restoreOutcome) {
      console.log(`[qwen-install] onnxruntime after install: ${ort.restoreOutcome}`);
    }

    /* Re-probe: the script exited 0, confirm the package + weights actually
       landed. A 0-exit with weights still missing is surfaced as an error so
       the UI doesn't claim success on a partial install. */
    const after = await this.detectFn();
    if (after === 'ready' || after === 'loaded') {
      this.transition(job, 'installed', { step: 'Done. Qwen3-TTS installed.' });
    } else {
      this.transition(job, 'error', {
        error:
          after === 'weights-missing'
            ? 'Installer finished but the Base weights are still missing — the download may have been interrupted. Retry (downloads resume).'
            : 'Installer finished but qwen-tts is still not importable in the sidecar venv. Check the sidecar venv bootstrap.',
      });
    }
  }

  /** Re-probe install-state; promote a stuck installing/error job to
      installed if the weights are now present. */
  async recheck(id: string): Promise<QwenInstallJob | null> {
    const job = this.jobs.get(id);
    if (!job) return null;
    const state = await this.detectFn();
    if ((state === 'ready' || state === 'loaded') && job.status !== 'installed') {
      this.transition(job, 'installed', { step: 'Done. Qwen3-TTS installed.' });
    }
    return this.jobs.get(id) ?? null;
  }

  private spawnInstaller(job: QwenInstallJob): Promise<void> {
    const script = join(this.repoRoot, 'server', 'tts-sidecar', 'scripts', 'install-qwen3.mjs');
    return this.runChild('node', [script, ...this.installArgs], {
      onStdoutLine: (line) => {
        const m = line.match(/\[install-qwen3\]\s*(.+)/);
        if (m) this.update(job, { step: m[1].trim() });
      },
      failure: (code, detail) => `install-qwen3.mjs exited with code ${code}.${detail ? ` ${detail}` : ''}`,
    });
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
      log: (m) => console.log(`[qwen-install] ${m}`),
    });
  }

  /** Spawn + await one child through spawnFn. Never blocks the event loop —
      the installer and the pip swap both run for minutes. Resolves on exit 0;
      rejects with `failure(code, stderrDetail)` otherwise. */
  private runChild(
    cmd: string,
    args: readonly string[],
    hooks: { onStdoutLine?: (line: string) => void; failure: (code: number | null, detail: string) => string },
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      let proc: ChildProcess;
      try {
        /* Piped stdio (NOT inherit) so the installer's `[install-qwen3]`
           step lines and pip's stderr can be read. */
        proc = this.spawnFn(cmd, args, { cwd: this.repoRoot, windowsHide: true });
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)));
        return;
      }
      let stderrTail = '';
      proc.stdout?.on('data', (b: Buffer) => {
        if (!hooks.onStdoutLine) return;
        for (const line of b.toString('utf8').split('\n')) hooks.onStdoutLine(line);
      });
      proc.stderr?.on('data', (b: Buffer) => {
        /* Keep only the tail — a pip/HF failure dump can be huge; the last
           few lines carry the actionable error. #3039: widened from 2000 to
           4000 chars so a real error isn't pushed entirely out of the window
           by pip's own routine notice line(s) printed after it — see
           extractInstallErrorDetail, which then filters those notice lines
           back out. */
        stderrTail = (stderrTail + b.toString('utf8')).slice(-4000);
      });
      proc.on('error', (err) => reject(err));
      proc.on('close', (code) => {
        if (code === 0) resolve();
        else reject(new Error(hooks.failure(code, extractInstallErrorDetail(stderrTail))));
      });
    });
  }

  private transition(
    job: QwenInstallJob,
    status: QwenInstallJobStatus,
    extra: Partial<QwenInstallJob> = {},
  ): void {
    job.status = status;
    Object.assign(job, extra);
    job.updatedAt = Date.now();
  }

  private update(job: QwenInstallJob, patch: Partial<QwenInstallJob>): void {
    Object.assign(job, patch);
    job.updatedAt = Date.now();
  }

  /** Reset for tests — drops all jobs. */
  _reset(): void {
    this.jobs.clear();
    this.active = null;
    this.nextId = 1;
  }
}

/** Default holdSidecarFn — see QwenInstallOptions.holdSidecarFn. */
function defaultHoldSidecar<T>(fn: () => Promise<T>): Promise<T> {
  const supervisor = getActiveSupervisor();
  return supervisor ? supervisor.withSidecarHeld(fn) : fn();
}
