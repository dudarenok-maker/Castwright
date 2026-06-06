/* Plan 61 — in-app Ollama install bootstrap.
 *
 * Background:
 *   `feat(frontend,server,sidecar,scripts): in-app multi-model management UX`
 *   adds an "Install Ollama" affordance to the Account → Models pane so a
 *   fresh deployer who shipped via the plan-49 release zip can go from
 *   Kokoro-only → local-Ollama analyzer without touching a terminal.
 *
 * This module owns the asynchronous job state machine for the install:
 *
 *   idle → detecting → downloading → installing → installed
 *                                      └─ error  ↗
 *
 *   detecting   — probe `ollama -v` on PATH; if found, jump straight to
 *                 `installed`.
 *   downloading — pull the vendor installer for the host platform from
 *                 https://ollama.com/download/<asset>. Tracks bytes seen.
 *   installing  — spawn the installer in non-interactive mode (or guide
 *                 the user to run it). On macOS/Linux the installer is a
 *                 script; on Windows it's an .exe that requires a GUI
 *                 click — we surface a "downloaded, please double-click"
 *                 state in that case (see WINDOWS_NOTE).
 *   installed   — re-probe `ollama -v`; on success, terminal state.
 *   error       — surface .error for the UI; the job is removed on the
 *                 next POST /install kick.
 *
 * Dependency-injectable. `httpFn` and `spawnFn` are constructor params so
 * the route's vitest harness can run the full state machine offline. The
 * default exports use real `fetch` + `child_process.spawn`.
 *
 * IMPORTANT: we never auto-pull a model after install. That's a separate
 * user click. See plan 61's "Out of scope" — auto-pull would silently
 * burn GB of disk on first-run UX. Always explicit.
 */

import { createWriteStream } from 'node:fs';
import { mkdir, stat, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { spawn as realSpawn, type ChildProcess } from 'node:child_process';

export type InstallJobStatus =
  | 'idle'
  | 'detecting'
  | 'downloading'
  | 'installing'
  | 'installed'
  | 'error';

export interface InstallJob {
  id: string;
  status: InstallJobStatus;
  platform: NodeJS.Platform;
  arch: string;
  bytesReceived: number;
  bytesTotal: number | null;
  /* When platform === 'win32', the installer is a GUI .exe that we
     can't drive headlessly. After download we set
     `manualInstallerPath` so the UI can render "double-click this file
     to finish the install." */
  manualInstallerPath: string | null;
  error: string | null;
  startedAt: number;
  updatedAt: number;
}

export interface HttpResponse {
  ok: boolean;
  status: number;
  contentLength: number | null;
  body: NodeJS.ReadableStream | null;
}

export type HttpFn = (url: string) => Promise<HttpResponse>;

export type SpawnFn = (
  cmd: string,
  args: readonly string[],
  opts?: { env?: NodeJS.ProcessEnv; windowsHide?: boolean },
) => ChildProcess;

export interface InstallBootstrapOptions {
  /* Override the asset URL builder. Tests stub this to point at a local
     mock so no real download happens. */
  resolveAssetUrl?: (platform: NodeJS.Platform, arch: string) => string;
  httpFn?: HttpFn;
  spawnFn?: SpawnFn;
  /* Stubbable platform/arch lookup so tests can simulate macOS from a
     Windows CI runner and vice versa. Defaults to process.platform /
     process.arch. */
  getPlatform?: () => NodeJS.Platform;
  getArch?: () => string;
  /* Stubbable Ollama detection. Returns the version string if found,
     or null if `ollama -v` is not on PATH. */
  detectOllama?: () => Promise<string | null>;
  /* Directory the installer downloads to. Defaults to OS temp.
     Tests pass an isolated dir. */
  downloadDir?: string;
}

/** Default vendor URL builder. Mirrors https://ollama.com/download. */
export function defaultResolveAssetUrl(platform: NodeJS.Platform, arch: string): string {
  /* Vendor naming convention as of 2026-05.
     - macOS: Ollama-darwin.zip (universal arm64+x64 in the same archive).
     - Linux: install.sh (the canonical curl|sh path).
     - Windows: OllamaSetup.exe (GUI installer; user must click).
  */
  if (platform === 'darwin') return 'https://ollama.com/download/Ollama-darwin.zip';
  if (platform === 'linux') {
    const arm = arch === 'arm64' || arch === 'aarch64';
    return arm
      ? 'https://ollama.com/download/ollama-linux-arm64.tgz'
      : 'https://ollama.com/download/ollama-linux-amd64.tgz';
  }
  if (platform === 'win32') return 'https://ollama.com/download/OllamaSetup.exe';
  throw new Error(`Ollama installer is not available for platform '${platform}'.`);
}

/** Default detector: spawn `ollama -v` and read its first line. */
async function defaultDetectOllama(spawnFn: SpawnFn): Promise<string | null> {
  return new Promise((resolve) => {
    let proc: ChildProcess;
    try {
      proc = spawnFn('ollama', ['-v'], { windowsHide: true });
    } catch {
      resolve(null);
      return;
    }
    let stdout = '';
    proc.stdout?.on('data', (b: Buffer) => {
      stdout += b.toString('utf8');
    });
    proc.on('error', () => resolve(null));
    proc.on('close', (code) => {
      if (code === 0 && stdout.trim().length > 0) {
        resolve(stdout.trim().split('\n')[0]);
      } else {
        resolve(null);
      }
    });
  });
}

/** Default HTTP fetcher — adapts global fetch to our HttpResponse shape. */
async function defaultHttpFn(url: string): Promise<HttpResponse> {
  const res = await fetch(url, { method: 'GET', redirect: 'follow' });
  const cl = res.headers.get('content-length');
  const total = cl ? Number(cl) : null;
  return {
    ok: res.ok,
    status: res.status,
    contentLength: Number.isFinite(total) ? total : null,
    body: res.body ? (Readable.fromWeb(res.body as unknown as ReadableStream) as Readable) : null,
  };
}

/**
 * In-memory job registry. We keep at most one active install job; the
 * registry is keyed by job id so the UI can re-fetch status by id.
 *
 * Singleton pattern matches the existing `runCatalogAudit` cache (one
 * cache key per kind of operation) — install is rare enough that
 * supporting concurrent installs would be a YAGNI win for the user.
 */
export class InstallBootstrap {
  private jobs = new Map<string, InstallJob>();
  private active: string | null = null;
  private nextId = 1;

  private readonly resolveAssetUrl: (platform: NodeJS.Platform, arch: string) => string;
  private readonly httpFn: HttpFn;
  private readonly spawnFn: SpawnFn;
  private readonly getPlatform: () => NodeJS.Platform;
  private readonly getArch: () => string;
  private readonly detectOllamaFn: () => Promise<string | null>;
  private readonly downloadDir: string;

  constructor(opts: InstallBootstrapOptions = {}) {
    this.resolveAssetUrl = opts.resolveAssetUrl ?? defaultResolveAssetUrl;
    this.httpFn = opts.httpFn ?? defaultHttpFn;
    this.spawnFn = opts.spawnFn ?? (realSpawn as unknown as SpawnFn);
    this.getPlatform = opts.getPlatform ?? (() => process.platform);
    this.getArch = opts.getArch ?? (() => process.arch);
    this.detectOllamaFn = opts.detectOllama ?? (() => defaultDetectOllama(this.spawnFn));
    this.downloadDir = opts.downloadDir ?? tmpdir();
  }

  /** Detect Ollama without kicking off a job. Used by GET /detect. */
  async detect(): Promise<{ installed: boolean; version: string | null }> {
    const version = await this.detectOllamaFn();
    return { installed: version !== null, version };
  }

  /** Get the current job snapshot (or null if no install kicked yet). */
  getJob(id: string): InstallJob | null {
    return this.jobs.get(id) ?? null;
  }

  /** Get the most-recent / active job, or null. */
  getActiveJob(): InstallJob | null {
    return this.active ? this.jobs.get(this.active) ?? null : null;
  }

  /**
   * Kick off (or resume) an install job. Returns the job snapshot
   * synchronously — the actual work runs in the background and the
   * caller polls GET /install/:id for status.
   */
  start(): InstallJob {
    /* If a job is already active (not terminal), return it as-is rather
       than spawning a parallel install. Last writer wins on terminal
       states; the UI is expected to remove a finished job before
       starting a new one. */
    const existing = this.getActiveJob();
    if (existing && existing.status !== 'installed' && existing.status !== 'error') {
      return existing;
    }
    const id = String(this.nextId++);
    const platform = this.getPlatform();
    const arch = this.getArch();
    const job: InstallJob = {
      id,
      status: 'detecting',
      platform,
      arch,
      bytesReceived: 0,
      bytesTotal: null,
      manualInstallerPath: null,
      error: null,
      startedAt: Date.now(),
      updatedAt: Date.now(),
    };
    this.jobs.set(id, job);
    this.active = id;
    /* Fire-and-forget the state machine. The catch is the safety net —
       any throw inside `run` lands in the job's error state. */
    void this.run(job).catch((err) => {
      this.transition(job, 'error', {
        error: err instanceof Error ? err.message : String(err),
      });
    });
    return job;
  }

  /** Drive the job through its states. Pure side-effect; mutates the
      job in the registry as it progresses. */
  private async run(job: InstallJob): Promise<void> {
    /* Step 1: detect. If Ollama is already on PATH, short-circuit
       straight to installed without touching the network. This is the
       common case for upgrade-flow users who already have Ollama from
       a prior install. */
    const existing = await this.detectOllamaFn();
    if (existing !== null) {
      this.transition(job, 'installed');
      return;
    }

    /* Step 2: resolve + download. We refuse to spawn before the bytes
       are on disk so a half-download doesn't leave a corrupt
       installer in the temp dir. */
    const url = this.resolveAssetUrl(job.platform, job.arch);
    this.transition(job, 'downloading');
    const destPath = await this.download(job, url);

    /* Step 3: install. Windows uses a GUI .exe — we surface the path
       and stop, letting the user double-click. macOS/Linux use a
       headless install script or tarball, which we can run directly. */
    if (job.platform === 'win32') {
      this.transition(job, 'installing', { manualInstallerPath: destPath });
      /* Mark installed only after the user finishes; the UI re-probes
         via POST /install/:id/recheck. */
      return;
    }

    this.transition(job, 'installing');
    await this.runInstaller(destPath, job.platform);

    /* Step 4: re-probe. The installer succeeded — confirm Ollama is
       now on PATH. */
    const post = await this.detectOllamaFn();
    if (post === null) {
      this.transition(job, 'error', {
        error: 'Installer ran but `ollama -v` still failed. Restart your shell or check the install logs.',
      });
      return;
    }
    this.transition(job, 'installed');
  }

  /** Manually re-probe Ollama (used for the Windows GUI install path
      and any "Refresh" affordance). Promotes the job to installed if
      the probe succeeds, leaves it in installing otherwise. */
  async recheck(id: string): Promise<InstallJob | null> {
    const job = this.jobs.get(id);
    if (!job) return null;
    const v = await this.detectOllamaFn();
    if (v !== null && (job.status === 'installing' || job.status === 'error')) {
      this.transition(job, 'installed');
    }
    return this.jobs.get(id) ?? null;
  }

  private async download(job: InstallJob, url: string): Promise<string> {
    const res = await this.httpFn(url);
    if (!res.ok) {
      throw new Error(`Failed to fetch installer from ${url} (HTTP ${res.status})`);
    }
    if (!res.body) {
      throw new Error(`Installer response from ${url} had no body.`);
    }
    if (res.contentLength) {
      this.update(job, { bytesTotal: res.contentLength });
    }
    await mkdir(this.downloadDir, { recursive: true });
    const filename = url.split('/').pop() ?? 'ollama-installer.bin';
    const destPath = join(this.downloadDir, filename);
    const out = createWriteStream(destPath);
    let received = 0;
    const stream = res.body;
    await new Promise<void>((resolve, reject) => {
      stream.on('data', (chunk: Buffer) => {
        received += chunk.length;
        /* Throttle update writes — every 256 KB is enough for a smooth
           progress bar without thrashing the job-poll layer. */
        if (received - job.bytesReceived >= 256 * 1024) {
          this.update(job, { bytesReceived: received });
        }
      });
      stream.on('end', () => {
        this.update(job, { bytesReceived: received });
        out.end(resolve);
      });
      stream.on('error', reject);
      stream.pipe(out);
    });
    /* Sanity check: a < 1 KB "download" is almost certainly an error
       page, not the real binary. */
    const s = await stat(destPath);
    if (s.size < 1024) {
      throw new Error(
        `Downloaded installer from ${url} is only ${s.size} bytes — likely an error page, not the real binary.`,
      );
    }
    return destPath;
  }

  private async runInstaller(path: string, platform: NodeJS.Platform): Promise<void> {
    if (platform === 'darwin') {
      /* macOS: the zip drops Ollama.app — we extract via `unzip` (BSD
         system tool) into /Applications/. We don't auto-launch the
         app — the user kicks it manually after the install completes,
         keeping the GUI-app contract honest. */
      await this.spawnAndWait('unzip', ['-o', path, '-d', '/Applications/']);
      return;
    }
    if (platform === 'linux') {
      /* Linux: chmod +x then run the bash installer script that
         downloaded earlier. The vendor script wraps tarball-extract +
         systemd unit + PATH update. */
      await chmod(path, 0o755);
      await this.spawnAndWait('bash', [path]);
      return;
    }
    throw new Error(`runInstaller does not support platform '${platform}'.`);
  }

  private spawnAndWait(cmd: string, args: readonly string[]): Promise<void> {
    return new Promise((resolve, reject) => {
      const proc = this.spawnFn(cmd, args, { windowsHide: true });
      proc.on('error', reject);
      proc.on('close', (code) => {
        if (code === 0) resolve();
        else reject(new Error(`${cmd} exited with code ${code}`));
      });
    });
  }

  /** Atomically transition + update job state. Mutates in place +
      bumps updatedAt so the UI can sense progress. */
  private transition(
    job: InstallJob,
    status: InstallJobStatus,
    extra: Partial<InstallJob> = {},
  ): void {
    job.status = status;
    Object.assign(job, extra);
    job.updatedAt = Date.now();
  }

  private update(job: InstallJob, patch: Partial<InstallJob>): void {
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

/** Module-level singleton. The route layer imports this; tests
    construct their own InstallBootstrap with stubs. */
export const installBootstrap = new InstallBootstrap();
