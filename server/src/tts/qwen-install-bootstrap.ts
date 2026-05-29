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

import { spawn as realSpawn, type ChildProcess } from 'node:child_process';
import { join } from 'node:path';
import {
  detectQwenInstallStateOnDisk,
} from './qwen-install-detect.js';
import type { QwenInstallState } from '../workspace/user-settings.js';

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
  opts?: { cwd?: string },
) => ChildProcess;

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
}

export class QwenInstallBootstrap {
  private jobs = new Map<string, QwenInstallJob>();
  private active: string | null = null;
  private nextId = 1;

  private readonly repoRoot: string;
  private readonly spawnFn: QwenSpawnFn;
  private readonly detectFn: () => QwenInstallState | Promise<QwenInstallState>;
  private readonly installArgs: readonly string[];

  constructor(opts: QwenInstallOptions) {
    this.repoRoot = opts.repoRoot;
    this.spawnFn = opts.spawnFn ?? (realSpawn as unknown as QwenSpawnFn);
    this.detectFn = opts.detectFn ?? (() => detectQwenInstallStateOnDisk(this.repoRoot));
    this.installArgs = opts.installArgs ?? [];
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

    this.transition(job, 'installing', { step: 'Starting installer…' });
    await this.spawnInstaller(job);

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
    return new Promise((resolve, reject) => {
      let proc: ChildProcess;
      try {
        /* Piped stdio (NOT inherit) so we can read the script's
           `[install-qwen3]` step lines and surface the latest to the UI. The
           script writes via process.stdout.write, so piping captures it. */
        proc = this.spawnFn('node', [script, ...this.installArgs], { cwd: this.repoRoot });
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
        /* Keep only the tail — a pip/HF failure dump can be huge; the last few
           lines carry the actionable error. */
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
              `install-qwen3.mjs exited with code ${code}.` +
                (stderrTail.trim() ? ` ${stderrTail.trim().split('\n').slice(-3).join(' ')}` : ''),
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
