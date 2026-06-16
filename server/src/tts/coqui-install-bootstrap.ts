/* In-app Coqui XTTS v2 install bootstrap. Mirrors qwen-install-bootstrap.ts so
 * a deployer can pre-fetch the XTTS v2 weights from Account → Models without a
 * terminal. Differences from the Qwen flow:
 *
 *   - `coqui-tts` is opt-in (not in base.txt); `install-coqui.mjs` pip-installs
 *     it first, then triggers the TTS lib's auto-downloader for XTTS v2, and
 *     streams `[install-coqui]` step lines. Progress is STEP-based (the
 *     multi-GB download has no single content-length).
 *   - `detect()` is the on-disk install-state probe (TTS package in the venv +
 *     XTTS v2 weights in the lib's user-data dir).
 *
 * State machine:
 *   idle → detecting → installing → installed
 *                          └─ error ↗
 *
 * Dependency-injectable (`spawnFn`, `detectFn`) so the route's vitest harness
 * runs the whole machine offline with no real download.
 */

import { spawn as realSpawn, type ChildProcess } from 'node:child_process';
import { join } from 'node:path';
import {
  detectCoquiInstallStateOnDisk,
  type CoquiInstallState,
} from './coqui-install-detect.js';

export type CoquiInstallJobStatus = 'detecting' | 'installing' | 'installed' | 'error';

export interface CoquiInstallJob {
  id: string;
  status: CoquiInstallJobStatus;
  /** Latest `[install-coqui]` step line, surfaced to the UI as status text
      (there's no byte total to drive a percentage bar). */
  step: string | null;
  error: string | null;
  startedAt: number;
  updatedAt: number;
}

export type CoquiSpawnFn = (
  cmd: string,
  args: readonly string[],
  opts?: { cwd?: string; windowsHide?: boolean },
) => ChildProcess;

export interface CoquiInstallOptions {
  /** Repo root — used to locate install-coqui.mjs and to probe the venv. */
  repoRoot: string;
  spawnFn?: CoquiSpawnFn;
  /** Stubbable install-state probe (offline tests). Defaults to the on-disk
      detector against repoRoot. */
  detectFn?: () => CoquiInstallState | Promise<CoquiInstallState>;
  /** Install flags forwarded to install-coqui.mjs. */
  installArgs?: readonly string[];
}

export class CoquiInstallBootstrap {
  private jobs = new Map<string, CoquiInstallJob>();
  private active: string | null = null;
  private nextId = 1;

  private readonly repoRoot: string;
  private readonly spawnFn: CoquiSpawnFn;
  private readonly detectFn: () => CoquiInstallState | Promise<CoquiInstallState>;
  private readonly installArgs: readonly string[];

  constructor(opts: CoquiInstallOptions) {
    this.repoRoot = opts.repoRoot;
    this.spawnFn = opts.spawnFn ?? (realSpawn as unknown as CoquiSpawnFn);
    this.detectFn = opts.detectFn ?? (() => detectCoquiInstallStateOnDisk(this.repoRoot));
    this.installArgs = opts.installArgs ?? [];
  }

  /** Probe install-state without kicking off a job. Used by GET /detect. */
  async detect(): Promise<{ state: CoquiInstallState; installed: boolean }> {
    const state = await this.detectFn();
    return { state, installed: state === 'ready' || state === 'loaded' };
  }

  getJob(id: string): CoquiInstallJob | null {
    return this.jobs.get(id) ?? null;
  }

  getActiveJob(): CoquiInstallJob | null {
    return this.active ? this.jobs.get(this.active) ?? null : null;
  }

  /** Kick off (or return the in-flight) install job. Returns synchronously;
      the spawn runs in the background and the caller polls GET /install/:id. */
  start(): CoquiInstallJob {
    const existing = this.getActiveJob();
    if (existing && existing.status !== 'installed' && existing.status !== 'error') {
      return existing;
    }
    const id = String(this.nextId++);
    const job: CoquiInstallJob = {
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

  private async run(job: CoquiInstallJob): Promise<void> {
    /* Already installed? short-circuit (idempotent — the install script is also
       idempotent, but skipping the multi-minute spawn is the common path on a
       box where XTTS was already pre-fetched or auto-downloaded). */
    const before = await this.detectFn();
    if (before === 'ready' || before === 'loaded') {
      this.transition(job, 'installed', { step: 'Already installed.' });
      return;
    }

    this.transition(job, 'installing', { step: 'Starting installer…' });
    await this.spawnInstaller(job);

    /* Re-probe: the script exited 0, confirm the weights actually landed. A
       0-exit with weights still missing is surfaced as an error so the UI
       doesn't claim success on a partial download. */
    const after = await this.detectFn();
    if (after === 'ready' || after === 'loaded') {
      this.transition(job, 'installed', { step: 'Done. Coqui XTTS v2 installed.' });
    } else {
      this.transition(job, 'error', {
        error:
          after === 'weights-missing'
            ? 'Installer finished but the XTTS v2 weights are still missing — the download may have been interrupted. Retry (downloads resume).'
            : 'Installer finished but the coqui-tts (TTS) package is still not importable. Retry the install, or repair the sidecar venv.',
      });
    }
  }

  /** Re-probe install-state; promote a stuck installing/error job to installed
      if the weights are now present. */
  async recheck(id: string): Promise<CoquiInstallJob | null> {
    const job = this.jobs.get(id);
    if (!job) return null;
    const state = await this.detectFn();
    if ((state === 'ready' || state === 'loaded') && job.status !== 'installed') {
      this.transition(job, 'installed', { step: 'Done. Coqui XTTS v2 installed.' });
    }
    return this.jobs.get(id) ?? null;
  }

  private spawnInstaller(job: CoquiInstallJob): Promise<void> {
    const script = join(this.repoRoot, 'server', 'tts-sidecar', 'scripts', 'install-coqui.mjs');
    return new Promise((resolve, reject) => {
      let proc: ChildProcess;
      try {
        /* Piped stdio (NOT inherit) so we can read the script's
           `[install-coqui]` step lines and surface the latest to the UI. */
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
          const m = line.match(/\[install-coqui\]\s*(.+)/);
          if (m) this.update(job, { step: m[1].trim() });
        }
      };
      const onStderr = (b: Buffer): void => {
        /* Keep only the tail — a download failure dump can be huge; the last
           few lines carry the actionable error. */
        stderrTail = (stderrTail + b.toString('utf8')).slice(-2000);
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
              `install-coqui.mjs exited with code ${code}.` +
                (stderrTail.trim() ? ` ${stderrTail.trim().split('\n').slice(-3).join(' ')}` : ''),
            ),
          );
        }
      });
    });
  }

  private transition(
    job: CoquiInstallJob,
    status: CoquiInstallJobStatus,
    extra: Partial<CoquiInstallJob> = {},
  ): void {
    job.status = status;
    Object.assign(job, extra);
    job.updatedAt = Date.now();
  }

  private update(job: CoquiInstallJob, patch: Partial<CoquiInstallJob>): void {
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
