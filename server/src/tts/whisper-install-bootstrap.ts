/* In-app Whisper ASR install bootstrap (srv-31, plan 186). Mirrors
 * qwen-install-bootstrap.ts: spawns server/tts-sidecar/scripts/install-whisper.mjs
 * and surfaces its `[install-whisper]` step lines so a deployer can install the
 * ASR engine from Account → Models without a terminal. Progress is STEP-based
 * (no single byte total for the HF download).
 *
 * Unlike Qwen there is no resolver-cache sync — ASR is never an auto-selected
 * synth engine; it's enabled explicitly via SEG_ASR_ENABLED.
 *
 * State machine: idle → detecting → installing → installed (└─ error ↗).
 * Dependency-injectable (spawnFn, detectFn) so the route's vitest harness runs
 * the whole machine offline with no real pip/download.
 */

import { spawn as realSpawn, type ChildProcess } from 'node:child_process';
import { join } from 'node:path';
import {
  detectWhisperInstallStateOnDisk,
  type WhisperInstallState,
} from './whisper-install-detect.js';

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
  /** Install flags forwarded to install-whisper.mjs (e.g. ['--model', 'base']). */
  installArgs?: readonly string[];
}

export class WhisperInstallBootstrap {
  private jobs = new Map<string, WhisperInstallJob>();
  private active: string | null = null;
  private nextId = 1;

  private readonly repoRoot: string;
  private readonly spawnFn: WhisperSpawnFn;
  private readonly detectFn: () => WhisperInstallState | Promise<WhisperInstallState>;
  private readonly installArgs: readonly string[];

  constructor(opts: WhisperInstallOptions) {
    this.repoRoot = opts.repoRoot;
    this.spawnFn = opts.spawnFn ?? (realSpawn as unknown as WhisperSpawnFn);
    this.detectFn = opts.detectFn ?? (() => detectWhisperInstallStateOnDisk(this.repoRoot));
    this.installArgs = opts.installArgs ?? [];
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

    this.transition(job, 'installing', { step: 'Starting installer…' });
    await this.spawnInstaller(job);

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
          const m = line.match(/\[install-whisper\]\s*(.+)/);
          if (m) this.update(job, { step: m[1].trim() });
        }
      };
      const onStderr = (b: Buffer): void => {
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
              `install-whisper.mjs exited with code ${code}.` +
                (stderrTail.trim() ? ` ${stderrTail.trim().split('\n').slice(-3).join(' ')}` : ''),
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

  /** Reset for tests — drops all jobs. */
  _reset(): void {
    this.jobs.clear();
    this.active = null;
    this.nextId = 1;
  }
}
