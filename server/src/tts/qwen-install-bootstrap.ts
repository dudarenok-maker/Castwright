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
 *
 * State machine:
 *   idle → detecting → installing → installed
 *                          └─ error ↗
 *
 * Dependency-injectable (`spawnFn`, `detectFn`) so the route's vitest harness
 * runs the whole machine offline with no real pip/download.
 */

import { spawn as realSpawn, type ChildProcess, spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import {
  detectQwenInstallStateOnDisk,
} from './qwen-install-detect.js';
import { getActiveSupervisor } from './sidecar-supervisor.js';
import { isAnyGenerationActive } from '../gpu/active-generation-gate.js';
import type { QwenInstallState } from '../workspace/user-settings.js';
import { resolveSidecarVenvDir } from '../diagnostics/venv.js';
// @ts-expect-error — standalone install script ships no .d.ts; helpers are plain JS.
import { planOrtSwap, applyOrtMarkerWrite } from '../../tts-sidecar/scripts/install-ort.mjs';

/* #3039 — stop the supervised sidecar before running pip, restart it after.
   `install-qwen3.mjs` runs `pip install qwen-tts`, which pulls a fresh
   `onnxruntime` wheel as a transitive dependency; the live sidecar has that
   package's DLL memory-mapped (`onnxruntime_providers_shared.dll` on
   Windows), so pip's DLL replace fails with WinError 5 / Access is denied
   whenever the sidecar is still running. Stopping supervision first (not
   just killing the child — must also suppress auto-respawn) frees
   the lock for the identical `pip` command that already works once the
   sidecar is down (confirmed by the manual A/B in
   docs/testing/onbox-a29-results/step-2-genuine-install.md).

   Four critical pieces:
   1. Stop must suppress the queue dispatcher so in-flight renders don't drain
      into the stopped sidecar. This is the supervisor's `recycling()` flag.
   2. The pip install pulls a fresh, plain CPU `onnxruntime` (since install-
      qwen3.mjs never invokes install-ort.mjs). On a GPU box this silently
      clobbers the GPU runtime. After install, re-run the ORT swap to restore it.
   3. Stop must detect and reject a genuinely adopted sidecar, but not fail on
      "not yet started" cases (autoStart off, or still booting).
   4. Restart must respect the code-43 hold-down state, not clear it.

   Finally is unconditional (success or failure) so a failed install never
   leaves TTS down, BUT a throwing stop/start must be guarded against masking
   the original install error and leaving the supervisor stranded. */
async function defaultStopSidecar(): Promise<void> {
  const supervisor = getActiveSupervisor();
  if (!supervisor) return; // no autoStart or not yet booted — nothing to stop.

  /* Distinguish genuinely adopted (recycling=false, current=null, meaning a
     healthy sidecar is already running that we didn't spawn) from "not yet
     started" (current=null but recycling=true or no spawn was needed). The
     adopted case cannot be stopped via the supervisor — we don't own it. */
  const isAdopted = supervisor.current() === null && !supervisor.recycling();
  if (isAdopted) {
    throw new Error(
      'Cannot stop an externally-managed sidecar (handle is null). ' +
      'Install Qwen3-TTS with the sidecar stopped externally first, ' +
      'then restart it manually.',
    );
  }
  /* Set isRecycling before killing so the queue dispatcher pauses immediately.
     For non-adopted cases, current() === null is benign (not started yet) and
     stop() is a no-op on the handle side. For an owned child, stop() kills it. */
  await supervisor.stop();
}

async function defaultStartSidecar(): Promise<void> {
  const supervisor = getActiveSupervisor();
  if (!supervisor) return; // no autoStart or not yet booted — nothing to start.

  /* Respect both hold-down states: code-43 trips and plain exhaustion.
     Both are deliberate give-up conditions that auto-respawn should not clear. */
  if (supervisor.tripEvent() !== null) {
    throw new Error(
      'Sidecar is held down due to repeated code-43 exits ' +
      '(device assignment too small). ' +
      'Restart the server with a corrected device assignment to recover.',
    );
  }
  if (supervisor.exhaustedEvent()) {
    throw new Error(
      'Sidecar gave up respawning after repeated rapid failures. ' +
      'Restart the server to reset the backoff counter and try again.',
    );
  }

  await supervisor.start();
}

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

/* #3039 — apply the onnxruntime-gpu swap after qwen install, restoring the GPU
   runtime if pip clobbered it with the plain CPU build. Pure fs call path if the
   venv is not present (benign no-op); throws on any pip error. Returns the plan
   action ('skip' or 'swap') so the caller can log it. */
async function applyOrtSwapAfterQwenInstall(
  venvDir: string,
  repoRoot: string,
): Promise<'skip' | 'swap'> {
  // Resolve the accelerator profile (env override, or detect from hardware)
  const profile = process.env.CASTWRIGHT_ACCELERATOR_PROFILE || 'nvidia'; // default to nvidia for production
  const platform = process.platform as 'win32' | 'linux' | 'darwin';

  // Get the plan: whether to skip or swap, and which steps to run
  const plan = planOrtSwap(profile, platform);
  if (plan.action === 'skip') {
    return 'skip';
  }

  // A swap plan: run the pip steps to put the GPU runtime in place
  const pythonExe = resolve(
    venvDir,
    platform === 'win32' ? 'Scripts' : 'bin',
    platform === 'win32' ? 'python.exe' : 'python',
  );

  for (const step of plan.steps) {
    const result = spawnSync(pythonExe, ['-m', 'pip', ...step], {
      cwd: repoRoot,
      windowsHide: true,
    });
    if (result.status !== 0) {
      const stderr = result.stderr?.toString('utf8') ?? '';
      const stdout = result.stdout?.toString('utf8') ?? '';
      throw new Error(
        `ORT swap pip step failed (${step[0]}): ${stderr || stdout || result.error?.message || 'unknown error'}`,
      );
    }
  }

  // Marker: record which package now owns the onnxruntime namespace
  applyOrtMarkerWrite(venvDir, plan);

  return 'swap';
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

export type QwenOrtSwapFn = (
  venvDir: string,
  repoRoot: string,
) => Promise<'skip' | 'swap'>;

export interface QwenInstallOptions {
  /** Repo root — used to locate install-qwen3.mjs and to probe the venv. */
  repoRoot: string;
  spawnFn?: QwenSpawnFn;
  /** Stubbable install-state probe (offline tests). Defaults to the on-disk
      detector against repoRoot. */
  detectFn?: () => QwenInstallState | Promise<QwenInstallState>;
  /** Install flags forwarded to install-qwen3.mjs (e.g. ['--cpu']). The full
      install (Base + VoiceDesign) is the default — bespoke voices need the
      VoiceDesign model, so we do NOT pass --skip-design. */
  installArgs?: readonly string[];
  /** Stubbable sidecar stop/start hooks (offline tests). Default to the real
      supervisor via getActiveSupervisor() — see the #3039 comment above. */
  stopSidecarFn?: () => Promise<void>;
  startSidecarFn?: () => Promise<void>;
  /** Stubbable ORT swap (pip re-install of GPU onnxruntime after qwen install).
      Defaults to applyOrtSwapAfterQwenInstall (real pip execution). Tests can
      inject a no-op. */
  ortSwapFn?: QwenOrtSwapFn;
}

export class QwenInstallBootstrap {
  private jobs = new Map<string, QwenInstallJob>();
  private active: string | null = null;
  private nextId = 1;

  private readonly repoRoot: string;
  private readonly spawnFn: QwenSpawnFn;
  private readonly detectFn: () => QwenInstallState | Promise<QwenInstallState>;
  private readonly installArgs: readonly string[];
  private readonly stopSidecarFn: () => Promise<void>;
  private readonly startSidecarFn: () => Promise<void>;
  private readonly ortSwapFn: QwenOrtSwapFn;

  constructor(opts: QwenInstallOptions) {
    this.repoRoot = opts.repoRoot;
    this.spawnFn = opts.spawnFn ?? (realSpawn as unknown as QwenSpawnFn);
    this.detectFn = opts.detectFn ?? (() => detectQwenInstallStateOnDisk(this.repoRoot));
    this.installArgs = opts.installArgs ?? [];
    this.stopSidecarFn = opts.stopSidecarFn ?? defaultStopSidecar;
    this.startSidecarFn = opts.startSidecarFn ?? defaultStartSidecar;
    this.ortSwapFn = opts.ortSwapFn ?? applyOrtSwapAfterQwenInstall;
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

    /* Check whether a render is in-flight, but only if we have an active
       supervisor (there's something to stop). If no supervisor, the sidecar
       is already down or we're in a test. */
    const supervisor = getActiveSupervisor();
    if (supervisor && isAnyGenerationActive()) {
      throw new Error(
        'Cannot install while a chapter is being generated. ' +
        'Wait for the generation to finish, then try again.',
      );
    }

    /* #3039 — stop the supervised sidecar before pip runs. This requires four
       pieces: (1) suppress the queue dispatcher via the recycling() flag;
       (2) actually run the ORT swap steps to restore the GPU onnxruntime after
       pip installs the plain CPU build; (3) detect and reject the genuinely
       adopted-sidecar case, but allow "not yet started" paths; (4) respect
       code-43 and exhaustion hold-downs on restart. Exception handling: stop/
       install/restart can all throw. Capture errors separately so a successful
       install is not masked by a restart failure, and a throwing stop doesn't
       prevent the finally block restart. */
    this.transition(job, 'installing', { step: 'Stopping the sidecar…' });
    let stopError: Error | null = null;
    let restartError: Error | null = null;
    let installError: Error | null = null;

    try {
      await this.stopSidecarFn();
    } catch (err) {
      stopError = err instanceof Error ? err : new Error(String(err));
    }

    if (!stopError) {
      try {
        this.update(job, { step: 'Starting installer…' });
        await this.spawnInstaller(job);

        /* Pip installed successfully. The pip call pulled a fresh, plain CPU
           `onnxruntime` (install-qwen3.mjs never invokes install-ort.mjs, and
           base.txt has no pin). On a GPU box this silently clobbers the GPU
           runtime. Run the actual ORT swap steps to restore it. */
        this.update(job, { step: 'Verifying GPU runtime…' });
        const venvDir = resolveSidecarVenvDir(this.repoRoot);
        const action = await this.ortSwapFn(venvDir, this.repoRoot);
        console.log(`[qwen-install] ORT swap result: ${action}`);
      } catch (err) {
        installError = err instanceof Error ? err : new Error(String(err));
      }
    }

    // Always restart the sidecar, even if stop or install failed, so TTS isn't
    // left down. Capture restart error separately so it doesn't mask the install
    // outcome — a successful install with a restart problem reports as installed
    // (with a warning logged), not as a failure.
    this.update(job, { step: 'Restarting the sidecar…' });
    try {
      await this.startSidecarFn();
    } catch (err) {
      restartError = err instanceof Error ? err : new Error(String(err));
      const msg = (err instanceof Error ? err.message : String(err));
      console.error(`[qwen-install] sidecar restart failed: ${msg}`);
    }

    // Report the stop error if present (stop failure prevents install from running).
    if (stopError) throw stopError;
    // Report the install error if present (install failure means no progress).
    if (installError) throw installError;

    /* Re-probe: the script exited 0, confirm the package + weights actually
       landed. A 0-exit with weights still missing is surfaced as an error so
       the UI doesn't claim success on a partial install. Restart error is
       reported as a log warning but does not block a successful install. */
    const after = await this.detectFn();
    if (after === 'ready' || after === 'loaded') {
      this.transition(job, 'installed', { step: 'Done. Qwen3-TTS installed.' });
      // Log restart error as a secondary warning, not a failure
      if (restartError) {
        console.warn(`[qwen-install] installed successfully but restart had an issue: ${restartError.message}`);
      }
    } else {
      this.transition(job, 'error', {
        error:
          after === 'weights-missing'
            ? 'Installer finished but the Base weights are still missing — the download may have been interrupted. Retry (downloads resume).'
            : 'Installer finished but qwen-tts is still not importable in the sidecar venv. Check the sidecar venv bootstrap.',
      });
    }

    // If we got here without throwing, but restart failed, throw it now after
    // recording the install success. This ensures the UI at least sees the install succeeded.
    if (restartError && (after !== 'ready' && after !== 'loaded')) {
      throw restartError;
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
    return new Promise((resolve, reject) => {
      let proc: ChildProcess;
      try {
        /* Piped stdio (NOT inherit) so we can read the script's
           `[install-qwen3]` step lines and surface the latest to the UI. The
           script writes via process.stdout.write, so piping captures it. */
        proc = this.spawnFn('node', [script, ...this.installArgs], {
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
          const m = line.match(/\[install-qwen3\]\s*(.+)/);
          if (m) this.update(job, { step: m[1].trim() });
        }
      };
      const onStderr = (b: Buffer): void => {
        /* Keep only the tail — a pip/HF failure dump can be huge; the last
           few lines carry the actionable error. #3039: widened from 2000 to
           4000 chars so a real error isn't pushed entirely out of the window
           by pip's own routine notice line(s) printed after it — see
           extractInstallErrorDetail, which then filters those notice lines
           back out. */
        stderrTail = (stderrTail + b.toString('utf8')).slice(-4000);
      };
      proc.stdout?.on('data', onStdout);
      proc.stderr?.on('data', onStderr);
      proc.on('error', (err) => reject(err));
      proc.on('close', (code) => {
        if (code === 0) {
          resolve();
        } else {
          const detail = extractInstallErrorDetail(stderrTail);
          reject(
            new Error(
              `install-qwen3.mjs exited with code ${code}.${detail ? ` ${detail}` : ''}`,
            ),
          );
        }
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
