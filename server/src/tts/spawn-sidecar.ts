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
import { resolveLogDir, resolveRunDir } from '../app-dirs.js';
import { formatTimestamp } from '../logger.js';
import { allKnobs } from '../config/registry.js';
import { resolveKnob } from '../config/resolver.js';

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
  /** Defaults to `process.platform`; injectable so tests can exercise the
      POSIX spawn branch without actually running on macOS/Linux. */
  platform?: NodeJS.Platform;
  /* Override-points for the stale-sidecar handshake (side-8) — tests stub
     these so they never touch a real port/process. */
  healthProbeFn?: (host: string, port: number) => Promise<SidecarHealthProbe>;
  findPidFn?: (port: number) => Promise<number | null>;
  /* srv-15 — invoked when the spawned child EXITS on its own (crash, OS
     OOM-kill, or the Python poison self-exit code 42), AFTER the exit is
     logged. The supervisor (createSidecarSupervisor) passes a callback that
     respawns a fresh sidecar with backoff, so a sidecar death no longer
     stalls generation with no recovery. Not called when the child is never
     spawned (autoStart off / reuse / spawn failure returns null). */
  onExit?: (code: number | null, signal: NodeJS.Signals | null) => void;
  /* srv-15 (adopt-supervision) — invoked when an already-listening FRESH
     sidecar is honoured instead of spawning. We don't own that process, so
     `onExit` can never fire for it; the supervisor passes a callback that
     watches the port and respawns an OWNED child once the adopted sidecar
     disappears. Without it, a self-recycle of an adopted sidecar — e.g. after
     a `tsx watch` dev reload re-adopted the orphan (the 2026-06-01 stall) — is
     never recovered and generation wedges on "sidecar not reachable". Only the
     fresh-reuse branch calls this; the not-ours / stale / disabled paths don't,
     so the supervisor never respawns over a process we deliberately left alone. */
  onAdoptExisting?: (info: { host: string; port: number }) => void;
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

/* Committed-private ceiling (MB) above which an otherwise-fresh sidecar is too
   leak-saturated to ADOPT — we kill+respawn a clean process instead of bolting
   a fresh server onto it. The 2026-06-02 "stuck after restart" was exactly this:
   the restart adopted an orphan sitting at ~26 GB committed (a fresh load is
   ~10 GB) and the new server wedged driving it. Default 20 GB — well above a
   fresh load + a light run, well below the deep-leak zone. Override
   SIDECAR_ADOPT_MAX_COMMITTED_MB; `0` disables the committed check (recycle
   _pending still gates). */
export function adoptCommittedCeilingMb(): number {
  const raw = Number(process.env.SIDECAR_ADOPT_MAX_COMMITTED_MB);
  return Number.isFinite(raw) && raw >= 0 ? Math.floor(raw) : 20_000;
}

/* The hard recycle ceilings (committed RAM / reserved VRAM, MB) THIS server
   would configure for a sidecar it spawns — resolved from the SAME registry
   knobs buildSidecarEnv injects (so an explicit .env / config override is the
   expectation, while an auto/default knob means "no fixed expectation": both
   sides auto-compute the same value on the same box). null = no expectation. */
export function expectedSidecarCeilings(): {
  memRestartMb: number | null;
  vramRestartMb: number | null;
} {
  const resolve = (key: string): number | null => {
    const knob = allKnobs().find((k) => k.key === key);
    if (!knob) return null;
    const st = resolveKnob(knob);
    /* Only a NON-default (env / override) value is a real expectation; a knob
       left at its 0=auto default is injected nowhere, so the sidecar
       auto-computes and we don't second-guess it. */
    if (st.source === 'default') return null;
    const n = Number(st.effective);
    return Number.isFinite(n) && n > 0 ? n : null;
  };
  return {
    memRestartMb: resolve('sidecar.restartMb'),
    vramRestartMb: resolve('sidecar.vramRestartMb'),
  };
}

/* True when the live sidecar's effective ceiling disagrees with what this
   server would configure (beyond a 1 MB float-rounding tolerance). Only
   compares dimensions where BOTH an expectation and a reported value exist —
   a missing field (older sidecar) or an auto/default config is never a
   mismatch, so the guard can't false-fire. */
export function sidecarCeilingMismatch(health: SidecarHealthProbe): string | null {
  const expected = expectedSidecarCeilings();
  const off = (exp: number | null, got: number | null | undefined): boolean =>
    exp !== null && typeof got === 'number' && Math.abs(got - exp) > 1;
  if (off(expected.memRestartMb, health.memRestartMb)) {
    return `committed-RAM recycle ceiling ${Math.round(health.memRestartMb!)}MB != configured ${expected.memRestartMb}MB`;
  }
  if (off(expected.vramRestartMb, health.vramRestartMb)) {
    return `reserved-VRAM recycle ceiling ${Math.round(health.vramRestartMb!)}MB != configured ${expected.vramRestartMb}MB`;
  }
  return null;
}

/* Prod never adopts a pre-existing sidecar: at boot there is no in-flight synth,
   so a clean owned process (governed by the graceful soft/hard recycle path) is
   strictly safer than bolting onto an orphan of unknown leak/build. Dev keeps
   adopt-if-healthy so `tsx watch` HMR doesn't reload the model every save.
   Override with SIDECAR_NEVER_ADOPT=1/0. */
export function neverAdoptSidecar(): boolean {
  const raw = process.env.SIDECAR_NEVER_ADOPT;
  if (raw === '1' || raw === 'true') return true;
  if (raw === '0' || raw === 'false') return false;
  return process.env.NODE_ENV === 'production';
}

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
  /** Committed-private memory (MB) the sidecar reports in /health, or null when
      absent/unparseable. Drives the adopt-fitness gate (don't inherit a
      leak-saturated orphan). */
  committedMb: number | null;
  /** The sidecar's SOFT recycle signal — true once it has crossed the soft
      committed/VRAM ceiling and intends to recycle at the next boundary. An
      adopt target reporting this is about to self-exit, so we replace it. */
  recyclePending: boolean;
  /** The sidecar's EFFECTIVE hard recycle ceilings (committed RAM / reserved
      VRAM, MB) — what it will actually self-exit at, after resolving its env +
      auto defaults. Optional: an older sidecar omits them (→ undefined). The
      adopt gate compares these against the server's configured ceilings to
      detect a sidecar started under a DIFFERENT config (e.g. a dev launch with
      no .env → auto ceiling) that must not silently serve this server. */
  memRestartMb?: number | null;
  vramRestartMb?: number | null;
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
    if (!res.ok)
      return {
        reachable: true,
        looksLikeSidecar: false,
        protocolVersion: null,
        committedMb: null,
        recyclePending: false,
      };
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    const looksLikeSidecar = body.ok === true && Array.isArray(body.engines);
    const protocolVersion =
      typeof body.protocol_version === 'number' ? body.protocol_version : null;
    const committedMb = typeof body.committed_mb === 'number' ? body.committed_mb : null;
    const recyclePending = body.recycle_pending === true;
    const memRestartMb = typeof body.mem_restart_mb === 'number' ? body.mem_restart_mb : null;
    const vramRestartMb = typeof body.vram_restart_mb === 'number' ? body.vram_restart_mb : null;
    return {
      reachable: true,
      looksLikeSidecar,
      protocolVersion,
      committedMb,
      recyclePending,
      memRestartMb,
      vramRestartMb,
    };
  } catch {
    return {
      reachable: false,
      looksLikeSidecar: false,
      protocolVersion: null,
      committedMb: null,
      recyclePending: false,
    };
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
    walks the tree. On POSIX, `bash start.sh` spawns a uvicorn grandchild in
    the same process group; when `ownGroup=true` (our own detached child is
    the group leader) we send SIGTERM to `-pid` (negative = whole group) so
    both bash and its uvicorn grandchild are reaped. For foreign PIDs
    (stale-sidecar replace) `ownGroup` is false and we send to the PID
    directly. The spawn function is injectable so tests can observe the kill
    call. */
function killTree(pid: number, spawnFn: typeof spawn, ownGroup = false): Promise<void> {
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
        // Negative pid = the whole process group (our child is spawned detached,
        // so it leads its own group) — reaps bash start.sh AND its uvicorn child.
        if (ownGroup) process.kill(-pid, 'SIGTERM');
        else process.kill(pid, 'SIGTERM');
      } catch {
        try { process.kill(pid, 'SIGTERM'); } catch { /* already gone */ }
      }
      resolve();
    }
  });
}

/** Options for {@link buildSidecarEnv}. Mirrors the subset of
    {@link SpawnSidecarOpts} that the env construction actually needs,
    separated so callers and tests can invoke it without an `autoStart`
    flag or async probe helpers. */
export interface BuildSidecarEnvOpts {
  modelKey: TtsModelKey;
  eagerLoadKokoro: boolean;
  eagerLoadQwen: boolean;
  repoRoot: string;
}

/** Build the child-process env object for a sidecar spawn. Extracted as
    a pure (synchronous) function so it can be unit-tested independently of
    the async spawn logic and used by POST /api/sidecar/restart without
    duplicating the env assembly.

    Construction is two layers:
      1. `...process.env` — parent env pass-through (fs-1 weight-path vars,
         PYTORCH_CUDA_ALLOC_CONF default, etc.).
      2. PRELOAD vars + QWEN_VOICES_DIR derived from modelKey + eager-load toggles.
      3. Registry override loop — any restart-sidecar knob whose effective
         source is NOT 'default' (i.e. an explicit env var or an app override)
         is injected as a string. An explicit registry override for a PRELOAD_QWEN
         or PRELOAD_KOKORO knob WINS over the modelKey/eagerLoad-derived value — that
         is the intended precedence so advanced users can pin preloads via the config
         UI without touching code. */
export function buildSidecarEnv(opts: BuildSidecarEnvOpts): NodeJS.ProcessEnv {
  const { modelKey, eagerLoadKokoro, eagerLoadQwen, repoRoot: _repoRoot } = opts;

  /* The default engine honours its own eager-load toggle; the non-default
     engine always stays LAZY as the on-demand fallback.
     Qwen default → PRELOAD_QWEN follows eagerLoadQwen, Kokoro forced off.
     Kokoro/Coqui default → PRELOAD_QWEN off, Kokoro follows eagerLoadKokoro. */
  const isQwenDefault = modelKey === 'qwen3-tts-0.6b';
  /* The `...process.env` spread carries the parent's full environment —
     including KOKORO_MODEL_PATH / KOKORO_VOICES_PATH for fs-1 shared weights.
     Keep that spread: replacing it with an allowlist would orphan the weights
     inside the per-release tree on every upgrade. */
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
    /* Fight CUDA allocator fragmentation. PyTorch's default caching allocator
       uses fixed cudaMalloc blocks; over a long run the variable-length Qwen
       batches fragment VRAM until a wide (e.g. 32-item) batch can't find a
       contiguous block and 500s with `CUDA error: out of memory` even though
       total usage is modest — the 2026-05-30 mid-run sidecar OOM. */
    PYTORCH_CUDA_ALLOC_CONF:
      process.env.PYTORCH_CUDA_ALLOC_CONF ??
      'expandable_segments:True,max_split_size_mb:256,garbage_collection_threshold:0.8',
  };

  /* Layer 2: inject any restart-sidecar knob whose value is NOT the registry
     default (source==='env' or source==='override'). Knobs still at their
     default are intentionally left unset — the sidecar applies its own Python
     default, avoiding double-defaulting drift.

     Precedence note: this loop runs AFTER the PRELOAD_* block above, so an
     explicit registry override for tts.preload.coqui / .kokoro / .qwen WINS
     over the modelKey/eagerLoad-derived '0'/'1'. That is the intended
     behaviour: a user who pins PRELOAD_QWEN via the config UI should get their
     override respected even when modelKey logic would say otherwise. */
  for (const knob of allKnobs()) {
    if (knob.apply !== 'restart-sidecar' || !knob.env) continue;
    const st = resolveKnob(knob);
    if (st.source === 'default') continue;
    // Emit booleans as '1'/'0' — the canonical form every sidecar env reader
    // accepts. Some main.py reads use a bare `== "1"` check that would reject
    // the string 'true' (e.g. PRELOAD_COQUI), silently dropping the override.
    env[knob.env] = knob.type === 'boolean' ? (st.effective ? '1' : '0') : String(st.effective);
  }

  return env;
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
    onExit,
    onAdoptExisting,
    platform = process.platform,
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
    const freshProtocol =
      health.looksLikeSidecar &&
      health.protocolVersion !== null &&
      health.protocolVersion >= EXPECTED_PROTOCOL_VERSION;
    /* Even a protocol-fresh sidecar is UNFIT to adopt if it is leak-saturated or
       already intends to recycle: inheriting it bolts a fresh server onto a
       dying process (the 2026-06-02 "stuck after restart" — adopted a ~26 GB
       orphan). Replace it with a clean process instead. */
    const adoptCeiling = adoptCommittedCeilingMb();
    /* A sidecar whose effective recycle ceiling disagrees with this server's
       config was started under a DIFFERENT config (a dev launch / stale-worktree
       process with no .env → auto ceiling). Adopting it lets it recycle at the
       wrong threshold and silently serve us — the exact "dev sidecar adopted by
       prod" trigger behind the bulk-design failures. Treat it as unfit (A1). */
    const ceilingMismatch = health.looksLikeSidecar ? sidecarCeilingMismatch(health) : null;
    const unfitReason = !health.looksLikeSidecar
      ? null // not-ours is handled separately below
      : health.recyclePending
        ? 'reports recycle_pending (about to self-recycle)'
        : adoptCeiling > 0 && health.committedMb !== null && health.committedMb >= adoptCeiling
          ? `committed ${Math.round(health.committedMb)}MB ≥ the ${adoptCeiling}MB adopt ceiling (leak-saturated)`
          : ceilingMismatch
            ? `config mismatch: ${ceilingMismatch} — started under a different config (likely a dev/stale sidecar)`
            : null;
    const policyReplace = neverAdoptSidecar() && freshProtocol && unfitReason === null;
    const fresh = freshProtocol && unfitReason === null && !policyReplace;
    if (fresh) {
      log(
        `[sidecar] already listening on :${port} (protocol v${health.protocolVersion}), skipping spawn (current sidecar honoured)`,
      );
      onAdoptExisting?.({ host, port });
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
    /* It IS our sidecar, but unfit to adopt — stale protocol OR leak-saturated /
       recycle-pending OR prod policy. Replace it with a fresh process. */
    const reason = policyReplace
      ? 'prod policy: spawning a fresh owned sidecar instead of adopting a pre-existing one'
      : !freshProtocol
        ? `protocol ${health.protocolVersion === null ? 'missing' : `v${health.protocolVersion}`} < v${EXPECTED_PROTOCOL_VERSION}`
        : (unfitReason ?? 'unfit');
    warn(
      `[sidecar] UNFIT sidecar on :${port} (${reason}) — replacing it with a fresh process to avoid inheriting a stale build or a leak-saturated/recycling one.`,
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

  const isWindows = platform === 'win32';
  const startScript = join(
    repoRoot, 'server', 'tts-sidecar', isWindows ? 'start.ps1' : 'start.sh',
  );
  /* logs/ + .run/ default to repoRoot but honour APP_LOG_DIR / APP_RUN_DIR so
     a versioned-dir install (fs-1) parks them in a shared sibling — otherwise
     tts.pid lands inside the per-release tree that an upgrade swaps out. */
  const logDir = resolveLogDir(repoRoot);
  const runDir = resolveRunDir(repoRoot);

  /* Build the child env via the shared pure function so registry overrides
     for restart-sidecar knobs are injected here too (Task B). The spawn-sidecar
     tests pin the produced env values; sidecar-env.test.ts pins the override-
     injection contract. */
  const env = buildSidecarEnv({ modelKey, eagerLoadKokoro, eagerLoadQwen, repoRoot });

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
    child = isWindows
      ? spawnFn('powershell.exe',
          ['-ExecutionPolicy', 'Bypass', '-NoProfile', '-File', startScript],
          { env, windowsHide: true, stdio: ['ignore', outFd ?? 'ignore', errFd ?? 'ignore'] })
      : spawnFn('bash', [startScript],
          // detached → new process group so killTree can reap the uvicorn grandchild
          // that `bash start.sh` spawns (a plain SIGTERM to bash would orphan it).
          { env, windowsHide: true, stdio: ['ignore', outFd ?? 'ignore', errFd ?? 'ignore'], detached: true });
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

  /* If the child exits on its own (e.g. start.ps1/start.sh venv check failed),
     surface that as a single warning so the user knows TTS won't be
     available. The supervisor loop inside start.ps1/start.sh already handles
     transient CUDA poison restarts internally; an exit here means
     the launcher itself terminated. Use a once-guard so an 'error' event
     followed by a synthetic 'exit' (or vice-versa) only fires onExit once. */
  let exitNotified = false;
  const notifyExit = (code: number | null, signal: NodeJS.Signals | null): void => {
    if (exitNotified) return;
    exitNotified = true;
    onExit?.(code, signal);
  };
  /* An async spawn failure (ENOENT: bash/powershell missing) emits 'error', NOT a
     thrown exception — without this handler it crashes the Node server (the macOS
     boot crash). Swallow, log once, and route to the supervisor as an exit so it
     can apply its backoff/respawn policy. */
  child.once('error', (err) => {
    warn('[sidecar] spawn error — TTS will be unavailable:', err);
    notifyExit(null, null);
  });
  child.once('exit', (code, signal) => {
    warn(`[sidecar] child exited (code=${code}, signal=${signal}) at ${formatTimestamp(new Date())}`);
    /* srv-15 — hand the exit to the supervisor so it can respawn. Plan 43
       moved sidecar ownership to the Node server and start-app.ps1 no longer
       supervises it, so without this a crash / OOM-kill / poison-exit (code
       42) would leave generation permanently stalled. */
    notifyExit(code, signal);
  });

  return {
    pid,
    child,
    kill: () => killTree(pid, spawnFn, true),
  };
}
