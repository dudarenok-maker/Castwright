/* Plan 43 — spawn the Python TTS sidecar as a child process of the Node
   server, owned by the user's `autoStartSidecar` preference.

   The spawn target is the existing `server/tts-sidecar/start.ps1` launcher
   (venv check, CUDA poison-code-42 supervisor loop, uvicorn bind). We just
   propagate `PRELOAD_COQUI` derived from `defaultTtsModelKey`, pipe logs,
   and write the child PID to `.run/tts.pid` so the existing
   `scripts/stop-app.ps1` reaps it the same as before.

   Three early-exit cases:
     1. autoStart === false           → log and return null.
     2. port 9000 already listening   → log "skipping spawn" and return null;
                                        a manual `npm run tts:sidecar`
                                        keeps working as before.
     3. spawn fails (no venv, etc.)   → the child exits non-zero; the
                                        sidecar-health route surfaces the
                                        failure. We never crash the parent. */

import { spawn, type ChildProcess } from 'node:child_process';
import { createWriteStream, mkdirSync, WriteStream } from 'node:fs';
import * as net from 'node:net';
import { dirname, join } from 'node:path';
import { writeFile } from 'node:fs/promises';

import type { UserSettings } from '../workspace/user-settings.js';
import { WORKSPACE_ROOT } from '../workspace/paths.js';
import { formatTimestamp } from '../logger.js';

export type TtsModelKey = UserSettings['defaultTtsModelKey'];

export interface SpawnSidecarOpts {
  autoStart: boolean;
  modelKey: TtsModelKey;
  /* When true (default), the spawned sidecar gets PRELOAD_KOKORO=1 and
     eager-loads Kokoro at startup. When false (Qwen-primary users who
     want the ~1 GB VRAM back), PRELOAD_KOKORO=0 and Kokoro warms on
     demand on first synth. */
  eagerLoadKokoro: boolean;
  repoRoot: string;
  /* Override-points for tests. */
  port?: number;
  host?: string;
  log?: (...args: unknown[]) => void;
  warn?: (...args: unknown[]) => void;
  spawnFn?: typeof spawn;
  probeFn?: typeof probeListening;
}

export interface SidecarHandle {
  pid: number;
  child: ChildProcess;
  kill: () => Promise<void>;
}

const DEFAULT_PORT = 9000;
const DEFAULT_HOST = '127.0.0.1';
const PROBE_TIMEOUT_MS = 250;

/** Resolve true iff something is already accepting TCP on host:port within
    PROBE_TIMEOUT_MS. Used to detect a manually-started sidecar before we
    try to spawn over the top of it. Resolves false on timeout, refused
    connect, or any other socket error — i.e. "port looks free". */
export function probeListening(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let settled = false;
    const finish = (listening: boolean): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(listening);
    };
    socket.setTimeout(PROBE_TIMEOUT_MS);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
    socket.connect(port, host);
  });
}

/** Open a write stream for an append-only log file. If the canonical path
    is locked (OneDrive / antivirus on Windows can hold the file open after
    a previous run rotated to a new one), fall back to a timestamped
    sibling so the server boot doesn't crash. Mirrors the `New-FreshLog`
    trick scripts/lib/log-utils.psm1 already uses. */
function openLogStream(canonicalPath: string): WriteStream {
  mkdirSync(dirname(canonicalPath), { recursive: true });
  try {
    return createWriteStream(canonicalPath, { flags: 'a' });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EBUSY') throw err;
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const fallback = canonicalPath.replace(/\.log$/, `.${stamp}.log`);
    return createWriteStream(fallback, { flags: 'a' });
  }
}

/** Resolve cross-platform process tree teardown. On Windows the child is
    `powershell.exe` running `start.ps1`, which itself spawned
    `python.exe` (uvicorn). A plain `process.kill(pid)` only reaps the
    powershell shell, orphaning the python grandchild. `taskkill /T /F`
    walks the tree. Elsewhere SIGTERM cascades naturally. The spawn
    function is injectable so tests can observe the kill call. */
function killTree(pid: number, spawnFn: typeof spawn): Promise<void> {
  return new Promise((resolve) => {
    if (process.platform === 'win32') {
      const killer = spawnFn('taskkill', ['/PID', String(pid), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true,
      });
      killer.once('exit', () => resolve());
      killer.once('error', () => resolve());
    } else {
      try {
        process.kill(pid, 'SIGTERM');
      } catch {
        /* already gone */
      }
      resolve();
    }
  });
}

/** Spawn the TTS sidecar if the user preference says so and nothing is
    already listening on its port. Returns a handle whose `kill()` reaps
    the whole process tree, or `null` when no spawn happened. Never
    throws — pre-existing TTS-down behaviour stays the contract. */
export async function spawnSidecar(opts: SpawnSidecarOpts): Promise<SidecarHandle | null> {
  const {
    autoStart,
    modelKey,
    eagerLoadKokoro,
    repoRoot,
    port = DEFAULT_PORT,
    host = DEFAULT_HOST,
    log = console.log,
    warn = console.warn,
    spawnFn = spawn,
    probeFn = probeListening,
  } = opts;

  if (!autoStart) {
    log('[sidecar] auto-start disabled (user pref or DISABLE_AUTOSTART_SIDECAR=1)');
    return null;
  }

  if (await probeFn(host, port)) {
    log(`[sidecar] already listening on :${port}, skipping spawn (manual sidecar honoured)`);
    return null;
  }

  const startScript = join(repoRoot, 'server', 'tts-sidecar', 'start.ps1');
  const logDir = join(repoRoot, 'logs');
  const runDir = join(repoRoot, '.run');

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PRELOAD_COQUI: modelKey === 'coqui-xtts-v2' ? '1' : '0',
    PRELOAD_KOKORO: eagerLoadKokoro ? '1' : '0',
    /* Park the Qwen designed-voice embedding cache in the per-workspace
       tree (sibling to voices.json), not the sidecar's __file__-relative
       dir. A sidecar restart / cwd change / workspace move can't orphan a
       designed voice (a latent ENOENT on torch.load at synth time). */
    QWEN_VOICES_DIR: join(WORKSPACE_ROOT, 'voices', 'qwen'),
  };

  let child: ChildProcess;
  try {
    child = spawnFn(
      'powershell.exe',
      ['-ExecutionPolicy', 'Bypass', '-NoProfile', '-File', startScript],
      {
        env,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
  } catch (err) {
    warn('[sidecar] spawn failed:', err);
    return null;
  }

  const pid = child.pid;
  if (typeof pid !== 'number') {
    warn('[sidecar] spawn returned no pid; child may not have started');
    return null;
  }

  /* Pipe stdout/stderr to log files, mirroring start-app.ps1's tts.log /
     tts.err.log convention. The streams stay open for the life of the
     child; on EBUSY (OneDrive lock) we fall back to a timestamped
     sibling. */
  try {
    const outStream = openLogStream(join(logDir, 'tts.log'));
    const errStream = openLogStream(join(logDir, 'tts.err.log'));
    child.stdout?.pipe(outStream);
    child.stderr?.pipe(errStream);
  } catch (err) {
    warn('[sidecar] log piping failed (non-fatal):', err);
  }

  /* Write PID to .run/tts.pid so scripts/stop-app.ps1's taskkill loop
     finds it. The .run/ dir is the same one start-app.ps1 uses. */
  try {
    mkdirSync(runDir, { recursive: true });
    await writeFile(join(runDir, 'tts.pid'), String(pid), 'utf8');
  } catch (err) {
    warn('[sidecar] pid file write failed (non-fatal):', err);
  }

  log(
    `[sidecar] spawned pid=${pid} (PRELOAD_COQUI=${env.PRELOAD_COQUI}, PRELOAD_KOKORO=${env.PRELOAD_KOKORO}, modelKey=${modelKey})`,
  );

  /* If the child exits on its own (e.g. start.ps1 venv check failed),
     surface that as a single warning so the user knows TTS won't be
     available. The supervisor loop inside start.ps1 already handles
     transient CUDA poison restarts internally; an exit here means
     start.ps1 itself terminated. */
  child.once('exit', (code, signal) => {
    const when = formatTimestamp(new Date());
    warn(`[sidecar] child exited (code=${code}, signal=${signal}) at ${when}`);
  });

  return {
    pid,
    child,
    kill: () => killTree(pid, spawnFn),
  };
}
