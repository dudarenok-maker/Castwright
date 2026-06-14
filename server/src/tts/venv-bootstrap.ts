/* In-app venv bootstrap (fs-21 decision Z). Spawns
 * server/tts-sidecar/scripts/bootstrap-venv.mjs and surfaces its
 * `[bootstrap-venv]` step lines so a deployer can bootstrap the Python venv
 * from Account → Models without a terminal. When Python 3.12 is not found,
 * the job immediately fails with per-OS manual instructions (no spawn).
 *
 * State machine:
 *   idle → bootstrapping → installed
 *               └─ error ↗
 *
 * Venv state is BINARY: either present (`present`) or absent (`absent`).
 * Detection is two-pronged: venv presence on disk + Python 3.12 reachability.
 * No Python → immediate `error` with manual instructions; no spawn attempted.
 *
 * Phase 1 pins the sidecar to Python 3.12 (python-tag.txt = cp312). The finder
 * accepts ONLY 3.12, so a fresh install builds a cp312 venv whose stamp matches
 * — the next detect/classify returns noop, not the needs-reinstall loop a 3.11
 * venv would cause.
 *
 * Dependency-injectable (`spawnFn`, `detectVenvFn`, `findPythonFn`) so the
 * vitest harness runs the whole machine offline with no real Python spawn.
 */

import { spawn as realSpawn, type ChildProcess } from 'node:child_process';
import { join } from 'node:path';
import { sidecarVenvPresent } from '../diagnostics/venv.js';
import { findPython312 } from './python-discovery.js';

export type VenvBootstrapState = 'present' | 'absent';

export type VenvBootstrapJobStatus = 'detecting' | 'bootstrapping' | 'installed' | 'error';

export interface VenvBootstrapJob {
  id: string;
  status: VenvBootstrapJobStatus;
  /** Latest `[bootstrap-venv]` step line, surfaced to the UI as status text. */
  step: string | null;
  error: string | null;
  startedAt: number;
  updatedAt: number;
}

export type VenvSpawnFn = (
  cmd: string,
  args: readonly string[],
  opts?: { cwd?: string; windowsHide?: boolean },
) => ChildProcess;

export interface VenvBootstrapOptions {
  /** Repo root — used to locate bootstrap-venv.mjs and probe the venv. */
  repoRoot: string;
  spawnFn?: VenvSpawnFn;
  /** Stubbable venv-presence probe (offline tests). Defaults to sidecarVenvPresent. */
  detectVenvFn?: (repoRoot: string) => boolean;
  /** Stubbable Python 3.12 finder (offline tests). Defaults to findPython312. */
  findPythonFn?: () => { cmd: string; args: string[] } | null;
}

/** Canonical degrade instructions for missing Python (decision Z). Phase 1
    requires EXACTLY Python 3.12 — `node server/tts-sidecar/scripts/ensure-python312.mjs`
    auto-installs it (winget on Windows) or prints package-manager guidance. */
const NO_PYTHON_INSTRUCTIONS =
  'No Python 3.12 found (the sidecar requires exactly 3.12). The quickest path is:\n' +
  '  node server/tts-sidecar/scripts/ensure-python312.mjs\n' +
  '  (auto-installs 3.12 via winget on Windows, or prints package-manager guidance)\n' +
  'Or install Python 3.12 from https://www.python.org/downloads/ and bootstrap manually:\n' +
  '  cd server/tts-sidecar\n' +
  '  py -3.12 -m venv .venv   (Windows)  /  python3.12 -m venv .venv   (macOS/Linux)\n' +
  '  .venv/Scripts/python -m pip install -r requirements.txt   (Windows)  /  ' +
  '.venv/bin/python -m pip install -r requirements.txt   (macOS/Linux)';

export class VenvBootstrap {
  private jobs = new Map<string, VenvBootstrapJob>();
  private active: string | null = null;
  private nextId = 1;

  private readonly repoRoot: string;
  private readonly spawnFn: VenvSpawnFn;
  private readonly detectVenvFn: (repoRoot: string) => boolean;
  private readonly findPythonFn: () => { cmd: string; args: string[] } | null;

  constructor(opts: VenvBootstrapOptions) {
    this.repoRoot = opts.repoRoot;
    this.spawnFn = opts.spawnFn ?? (realSpawn as unknown as VenvSpawnFn);
    this.detectVenvFn = opts.detectVenvFn ?? sidecarVenvPresent;
    this.findPythonFn = opts.findPythonFn ?? (() => findPython312());
  }

  /** Probe state without kicking off a job. Used by GET /detect. */
  detect(): { state: VenvBootstrapState; venvPresent: boolean; pythonFound: boolean; installed: boolean } {
    const venvPresent = this.detectVenvFn(this.repoRoot);
    const pythonFound = this.findPythonFn() !== null;
    const installed = venvPresent;
    const state: VenvBootstrapState = installed ? 'present' : 'absent';
    return { state, venvPresent, pythonFound, installed };
  }

  getJob(id: string): VenvBootstrapJob | null {
    return this.jobs.get(id) ?? null;
  }

  getActiveJob(): VenvBootstrapJob | null {
    return this.active ? this.jobs.get(this.active) ?? null : null;
  }

  /** Kick off (or return the in-flight) bootstrap job. Returns synchronously;
      the spawn runs in the background and the caller polls GET /bootstrap/:id. */
  start(): VenvBootstrapJob {
    const existing = this.getActiveJob();
    if (existing && existing.status !== 'installed' && existing.status !== 'error') {
      return existing;
    }
    const id = String(this.nextId++);
    const job: VenvBootstrapJob = {
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

  private async run(job: VenvBootstrapJob): Promise<void> {
    /* Venv already present? Short-circuit (idempotent). */
    if (this.detectVenvFn(this.repoRoot)) {
      this.transition(job, 'installed', { step: 'Already installed.' });
      return;
    }

    /* Python not found? Immediate degrade — no spawn. */
    const python = this.findPythonFn();
    if (python === null) {
      this.transition(job, 'error', { error: NO_PYTHON_INSTRUCTIONS });
      return;
    }

    this.transition(job, 'bootstrapping', { step: 'Starting venv bootstrap…' });
    await this.spawnBootstrap(job, python);

    /* Re-probe: confirm venv landed. */
    if (this.detectVenvFn(this.repoRoot)) {
      this.transition(job, 'installed', { step: 'Done. Venv ready.' });
    } else {
      this.transition(job, 'error', {
        error:
          'bootstrap-venv.mjs exited successfully but the venv is still missing — the install may have been interrupted. Retry.',
      });
    }
  }

  /** Re-probe venv state; promote a stuck bootstrapping/error job to installed
      if the venv is now present. */
  recheck(id: string): VenvBootstrapJob | null {
    const job = this.jobs.get(id);
    if (!job) return null;
    if (this.detectVenvFn(this.repoRoot) && job.status !== 'installed') {
      this.transition(job, 'installed', { step: 'Done. Venv ready.' });
    }
    return this.jobs.get(id) ?? null;
  }

  private spawnBootstrap(job: VenvBootstrapJob, python: { cmd: string; args: string[] }): Promise<void> {
    const script = join(
      this.repoRoot,
      'server',
      'tts-sidecar',
      'scripts',
      'bootstrap-venv.mjs',
    );
    return new Promise((resolve, reject) => {
      let proc: ChildProcess;
      try {
        proc = this.spawnFn('node', [script, python.cmd, ...python.args], {
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
          const m = line.match(/\[bootstrap-venv\]\s*(.+)/);
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
              `bootstrap-venv.mjs exited with code ${code}.` +
                (stderrTail.trim() ? ` ${stderrTail.trim().split('\n').slice(-3).join(' ')}` : ''),
            ),
          );
        }
      });
    });
  }

  private transition(
    job: VenvBootstrapJob,
    status: VenvBootstrapJobStatus,
    extra: Partial<VenvBootstrapJob> = {},
  ): void {
    job.status = status;
    Object.assign(job, extra);
    job.updatedAt = Date.now();
  }

  private update(job: VenvBootstrapJob, patch: Partial<VenvBootstrapJob>): void {
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
