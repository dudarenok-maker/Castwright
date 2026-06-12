/* In-app Kokoro install bootstrap (fs-21). Spawns
 * server/tts-sidecar/scripts/install-kokoro.mjs and surfaces its
 * `[install-kokoro]` step lines so a deployer can install the Kokoro weights
 * from Account → Models without a terminal. Progress is STEP-based (no single
 * byte total for the ONNX download).
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
 * Dependency-injectable (`spawnFn`, `detectFn`) so the route's vitest harness
 * runs the whole machine offline with no real download.
 */

import { spawn as realSpawn, type ChildProcess } from 'node:child_process';
import { join } from 'node:path';
import { detectKokoroInstalledOnDisk } from './kokoro-install-detect.js';

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
}

export class KokoroInstallBootstrap {
  private jobs = new Map<string, KokoroInstallJob>();
  private active: string | null = null;
  private nextId = 1;

  private readonly repoRoot: string;
  private readonly spawnFn: KokoroSpawnFn;
  private readonly detectFn: () => boolean | Promise<boolean>;
  private readonly installArgs: readonly string[];

  constructor(opts: KokoroInstallOptions) {
    this.repoRoot = opts.repoRoot;
    this.spawnFn = opts.spawnFn ?? (realSpawn as unknown as KokoroSpawnFn);
    this.detectFn = opts.detectFn ?? (() => detectKokoroInstalledOnDisk(this.repoRoot));
    this.installArgs = opts.installArgs ?? [];
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

    this.transition(job, 'installing', { step: 'Starting installer…' });
    await this.spawnInstaller(job);

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
    return new Promise((resolve, reject) => {
      let proc: ChildProcess;
      try {
        /* Piped stdio (NOT inherit) so we can read the script's
           `[install-kokoro]` step lines and surface the latest to the UI. */
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
          const m = line.match(/\[install-kokoro\]\s*(.+)/);
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
              `install-kokoro.mjs exited with code ${code}.` +
                (stderrTail.trim() ? ` ${stderrTail.trim().split('\n').slice(-3).join(' ')}` : ''),
            ),
          );
        }
      });
    });
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

  /** Reset for tests — drops all jobs. */
  _reset(): void {
    this.jobs.clear();
    this.active = null;
    this.nextId = 1;
  }
}
