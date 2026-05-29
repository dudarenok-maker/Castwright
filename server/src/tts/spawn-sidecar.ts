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
import { closeSync, mkdirSync, openSync } from 'node:fs';
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
     demand on first synth. Only honoured when Kokoro/Coqui is the default
     engine; under a Qwen default Kokoro is always the on-demand fallback. */
  eagerLoadKokoro: boolean;
  /* When true (default) AND Qwen is the default engine, the spawned sidecar
     gets PRELOAD_QWEN=1 and eager-loads Qwen Base at startup. When false,
     PRELOAD_QWEN=0 and Qwen warms on demand on first synth. No effect unless
     Qwen is the default engine. */
  eagerLoadQwen: boolean;
  repoRoot: string;
  /* Override-points for tests. */
  port?: number;
  host?: string;
  log?: (...args: unknown[]) => void;
  warn?: (...args: unknown[]) => void;
  spawnFn?: typeof spawn;
  probeFn?: typeof probeListening;
  /* Override-points for the stale-sidecar handshake (side-8) — tests stub
     these so they never touch a real port/process. */
  healthProbeFn?: (host: string, port: number) => Promise<SidecarHealthProbe>;
  findPidFn?: (port: number) => Promise<number | null>;
}

export interface SidecarHandle {
  pid: number;
  child: ChildProcess;
  kill: () => Promise<void>;
}

const DEFAULT_PORT = 9000;
const DEFAULT_HOST = '127.0.0.1';
const PROBE_TIMEOUT_MS = 250;

/* MUST equal SIDECAR_PROTOCOL_VERSION in server/tts-sidecar/main.py. Bump BOTH
   together whenever a /health or wire-protocol change makes an older sidecar
   incompatible with the current server — that's what lets the startup
   handshake below detect (and replace) a stale process instead of silently
   reusing it. (side-8 — stale-sidecar incident 2026-05-29.) */
const EXPECTED_PROTOCOL_VERSION = 1;
const HEALTH_PROBE_TIMEOUT_MS = 2_000;
const PORT_FREE_TIMEOUT_MS = 5_000;
const PORT_FREE_POLL_MS = 200;

export interface SidecarHealthProbe {
  /** TCP-reachable AND returned an HTTP 2xx. */
  reachable: boolean;
  /** Responded with OUR sidecar's /health shape (`ok` + an `engines` array),
      vs. some unrelated process that happens to hold the port. We only ever
      replace a process that positively identifies as our sidecar. */
  looksLikeSidecar: boolean;
  /** Reported `protocol_version`, or null when absent — an older (pre-side-8)
      sidecar omits it, which reads as "stale". */
  protocolVersion: number | null;
}

/** Probe a listening process's /health to decide whether it's the CURRENT
    sidecar build (safe to reuse) or a stale one (replace) or not ours at all
    (leave alone). Never throws — any failure resolves to a not-ours verdict so
    the caller errs toward leaving an unknown process untouched. */
export async function probeSidecarHealth(
  host: string,
  port: number,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = HEALTH_PROBE_TIMEOUT_MS,
): Promise<SidecarHealthProbe> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(`http://${host}:${port}/health`, { signal: controller.signal });
    if (!res.ok) return { reachable: true, looksLikeSidecar: false, protocolVersion: null };
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    const looksLikeSidecar = body.ok === true && Array.isArray(body.engines);
    const protocolVersion =
      typeof body.protocol_version === 'number' ? body.protocol_version : null;
    return { reachable: true, looksLikeSidecar, protocolVersion };
  } catch {
    return { reachable: false, looksLikeSidecar: false, protocolVersion: null };
  } finally {
    clearTimeout(timer);
  }
}

/** Best-effort cross-platform "which PID is listening on this port". Returns
    null when it can't tell (no tool, parse miss, error) — the caller then
    leaves the process in place rather than killing the wrong thing. The PID
    file (`.run/tts.pid`) is NOT used here: a stale sidecar is often a process
    we did NOT spawn (orphan across a `tsx watch` reload, or a manual launch),
    so its PID differs from the last one we recorded. */
export function findListenerPid(
  port: number,
  platform: NodeJS.Platform = process.platform,
  spawnFn: typeof spawn = spawn,
): Promise<number | null> {
  const cmd =
    platform === 'win32'
      ? {
          file: 'powershell.exe',
          args: [
            '-NoProfile',
            '-Command',
            `(Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1).OwningProcess`,
          ],
        }
      : { file: 'sh', args: ['-c', `lsof -ti tcp:${port} -sTCP:LISTEN 2>/dev/null | head -n1`] };
  return new Promise((resolve) => {
    let out = '';
    let child: ChildProcess;
    try {
      child = spawnFn(cmd.file, cmd.args, { windowsHide: true });
    } catch {
      return resolve(null);
    }
    child.stdout?.on('data', (d) => {
      out += String(d);
    });
    child.once('error', () => resolve(null));
    child.once('exit', () => {
      const pid = parseInt(out.trim().split(/\s+/)[0] ?? '', 10);
      resolve(Number.isInteger(pid) && pid > 0 ? pid : null);
    });
  });
}

/** Poll until the port stops accepting connections (the killed process let go)
    or we give up. Returns true iff the port is free. */
async function waitForPortFree(
  host: string,
  port: number,
  probeFn: typeof probeListening,
  timeoutMs = PORT_FREE_TIMEOUT_MS,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await probeFn(host, port))) return true;
    await new Promise((r) => setTimeout(r, PORT_FREE_POLL_MS));
  }
  return !(await probeFn(host, port));
}

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

/** Open an append-only log file and return its raw file descriptor.
    If the canonical path is locked (OneDrive / antivirus on Windows can
    hold the file open after a previous run rotated to a new one), fall
    back to a timestamped sibling so the server boot doesn't crash.
    Mirrors the `New-FreshLog` trick scripts/lib/log-utils.psm1 already uses.

    We hand this fd straight to the child's stdio (see spawnSidecar) instead
    of piping `child.stdout`/`stderr` through a Node WriteStream. The pipe
    approach broke the sidecar's logging the moment the Node parent died
    (e.g. a `tsx watch` dev reload that restarts the server but ORPHANS the
    long-lived sidecar): the pipe's read end belonged to the dead parent, so
    the orphaned sidecar's next stdout/stderr write — notably the
    huggingface `from_pretrained` tqdm progress bar during a model /load —
    raised `OSError: [Errno 22] Invalid argument`, surfacing as an opaque
    `/load` 500 and a TTS pill that reverts to idle. An inherited file
    descriptor is the child's OWN OS handle to the file, so it stays valid
    regardless of the parent's lifetime. */
function openLogFd(canonicalPath: string): number {
  mkdirSync(dirname(canonicalPath), { recursive: true });
  try {
    return openSync(canonicalPath, 'a');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EBUSY') throw err;
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const fallback = canonicalPath.replace(/\.log$/, `.${stamp}.log`);
    return openSync(fallback, 'a');
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
    eagerLoadQwen,
    repoRoot,
    port = DEFAULT_PORT,
    host = DEFAULT_HOST,
    log = console.log,
    warn = console.warn,
    spawnFn = spawn,
    probeFn = probeListening,
    healthProbeFn = (h, p) => probeSidecarHealth(h, p),
    findPidFn = (p) => findListenerPid(p),
  } = opts;

  if (!autoStart) {
    log('[sidecar] auto-start disabled (user pref or DISABLE_AUTOSTART_SIDECAR=1)');
    return null;
  }

  if (await probeFn(host, port)) {
    /* Something already holds :port. Before honouring it (the old behaviour),
       handshake on /health so a STALE sidecar — an older build whose protocol
       predates the current server — can't be silently reused. A stale process
       drifts the whole app's behaviour invisibly (the 2026-05-29 incident: its
       /health omitted qwen_install_state, so every Qwen book fell back to
       Kokoro). side-8: detect & replace, don't just reuse. */
    const health = await healthProbeFn(host, port);
    const fresh =
      health.looksLikeSidecar &&
      health.protocolVersion !== null &&
      health.protocolVersion >= EXPECTED_PROTOCOL_VERSION;
    if (fresh) {
      log(
        `[sidecar] already listening on :${port} (protocol v${health.protocolVersion}), skipping spawn (current sidecar honoured)`,
      );
      return null;
    }
    if (!health.looksLikeSidecar) {
      /* Reachable-but-not-ours, or hung/non-HTTP. Never kill an unknown
         process — leave it and let the health route surface TTS-down. */
      warn(
        `[sidecar] something is listening on :${port} but it does not look like our sidecar — NOT touching it. TTS may be unavailable until the port is freed.`,
      );
      return null;
    }
    /* It IS our sidecar, but stale (missing/old protocol_version). Replace it. */
    const reported =
      health.protocolVersion === null ? 'missing' : `v${health.protocolVersion}`;
    warn(
      `[sidecar] STALE sidecar on :${port} (protocol ${reported} < v${EXPECTED_PROTOCOL_VERSION}) — replacing it with the current build to stop silent capability drift (e.g. Qwen→Kokoro fallback).`,
    );
    const stalePid = await findPidFn(port);
    if (stalePid === null) {
      warn(
        `[sidecar] could not identify the PID on :${port} to replace the stale sidecar — leaving it in place. Restart the sidecar manually to pick up the current build.`,
      );
      return null;
    }
    await killTree(stalePid, spawnFn);
    if (!(await waitForPortFree(host, port, probeFn))) {
      warn(
        `[sidecar] killed stale pid=${stalePid} but :${port} is still bound — not spawning over it. Restart manually.`,
      );
      return null;
    }
    log(`[sidecar] replaced stale sidecar (killed pid=${stalePid}); spawning current build.`);
    /* fall through to the normal spawn below */
  }

  const startScript = join(repoRoot, 'server', 'tts-sidecar', 'start.ps1');
  const logDir = join(repoRoot, 'logs');
  const runDir = join(repoRoot, '.run');

  /* The default engine honours its own eager-load toggle; the non-default
     engine always stays LAZY as the on-demand fallback (it warms in ~1 s at
     the first fallback render, so eager-loading it too would just hog VRAM).
     Qwen default → PRELOAD_QWEN follows eagerLoadQwen, Kokoro forced off.
     Kokoro/Coqui default → PRELOAD_QWEN off, Kokoro follows eagerLoadKokoro. */
  const isQwenDefault = modelKey === 'qwen3-tts-0.6b';
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PRELOAD_COQUI: modelKey === 'coqui-xtts-v2' ? '1' : '0',
    PRELOAD_QWEN: isQwenDefault ? (eagerLoadQwen ? '1' : '0') : '0',
    PRELOAD_KOKORO: isQwenDefault ? '0' : eagerLoadKokoro ? '1' : '0',
    /* Park the Qwen designed-voice embedding cache in the per-workspace
       tree (sibling to voices.json), not the sidecar's __file__-relative
       dir. A sidecar restart / cwd change / workspace move can't orphan a
       designed voice (a latent ENOENT on torch.load at synth time). */
    QWEN_VOICES_DIR: join(WORKSPACE_ROOT, 'voices', 'qwen'),
  };

  /* Open the sidecar's log files (tts.log / tts.err.log, the same convention
     start-app.ps1 uses) and hand the child their raw file descriptors as
     stdout/stderr. The child inherits them as its OWN OS handles, so its
     logging survives the Node parent dying — the orphaned-sidecar [Errno 22]
     bug openLogFd documents. Logging is non-fatal: if the files can't be
     opened, fall back to discarding the child's output rather than refusing
     to spawn. */
  let outFd: number | null = null;
  let errFd: number | null = null;
  try {
    outFd = openLogFd(join(logDir, 'tts.log'));
    errFd = openLogFd(join(logDir, 'tts.err.log'));
  } catch (err) {
    warn('[sidecar] log file open failed (output discarded):', err);
    if (outFd !== null) closeSync(outFd);
    outFd = null;
    errFd = null;
  }

  let child: ChildProcess;
  try {
    child = spawnFn(
      'powershell.exe',
      ['-ExecutionPolicy', 'Bypass', '-NoProfile', '-File', startScript],
      {
        env,
        windowsHide: true,
        stdio: ['ignore', outFd ?? 'ignore', errFd ?? 'ignore'],
      },
    );
  } catch (err) {
    warn('[sidecar] spawn failed:', err);
    return null;
  } finally {
    /* The child dup'd the fds into its own process during spawn, so close
       the parent's copies — otherwise the Node server keeps the log files
       open (blocking rotation) and leaks a handle per spawn. Closing here is
       safe whether spawn succeeded or threw; the child's handles are
       independent of ours. */
    if (outFd !== null) closeSync(outFd);
    if (errFd !== null) closeSync(errFd);
  }

  const pid = child.pid;
  if (typeof pid !== 'number') {
    warn('[sidecar] spawn returned no pid; child may not have started');
    return null;
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
    `[sidecar] spawned pid=${pid} (PRELOAD_COQUI=${env.PRELOAD_COQUI}, PRELOAD_QWEN=${env.PRELOAD_QWEN}, PRELOAD_KOKORO=${env.PRELOAD_KOKORO}, modelKey=${modelKey})`,
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
