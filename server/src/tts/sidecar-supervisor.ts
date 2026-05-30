/* srv-15 — sidecar respawn supervision.
 *
 * Plan 43 moved TTS-sidecar ownership from start-app.ps1 to the Node server,
 * but the server only LOGGED the child's exit — it never respawned it. So any
 * sidecar death (crash, OS OOM-kill — see the 2026-05-30 host-RAM incident —
 * or the Python CUDA-poison self-exit with code 42) left generation permanently
 * stalled with no recovery. This supervisor owns the sidecar handle and
 * respawns a fresh process on unexpected exit, with backoff and a crash-loop
 * cap, while staying out of the way during intentional shutdown.
 *
 * The supervisor is the SOLE wirer of `spawnSidecar`'s `onExit` callback: each
 * (re)spawn registers a fresh exit handler, so supervision continues across
 * respawns. `buildOpts` is async + re-evaluated per respawn so a settings
 * change (eager-load prefs, model key) is picked up by the next process. */
import type { SidecarHandle, SpawnSidecarOpts } from './spawn-sidecar.js';
import { spawnSidecar } from './spawn-sidecar.js';

/* A child that dies faster than this counts toward the crash-loop cap; one
   that lived longer is treated as a fresh incident and resets the counter, so
   a sidecar that runs fine for an hour and then dies once still gets respawned
   even if an earlier boot had flaked. */
const QUICK_DEATH_MS = 30_000;
const DEFAULT_BACKOFFS_MS = [2_000, 5_000, 15_000];
const DEFAULT_MAX_CONSECUTIVE_FAILURES = 5;

export interface SidecarSupervisorOpts {
  /** Builds the base spawn opts for each (re)spawn. Async so it can re-read
      user settings each time. Any `onExit` it returns is overwritten — the
      supervisor owns that callback. */
  buildOpts: () => Promise<Omit<SpawnSidecarOpts, 'onExit'>>;
  log?: (...args: unknown[]) => void;
  warn?: (...args: unknown[]) => void;
  /* Test seams. */
  spawnFn?: (opts: SpawnSidecarOpts) => Promise<SidecarHandle | null>;
  delayFn?: (ms: number) => Promise<void>;
  nowFn?: () => number;
  backoffsMs?: number[];
  maxConsecutiveFailures?: number;
}

export interface SidecarSupervisor {
  /** Spawn the initial sidecar and begin supervising. */
  start: () => Promise<void>;
  /** Stop supervising and reap the current child. After this, an exit never
      triggers a respawn (so it's safe to call during server shutdown). */
  stop: () => Promise<void>;
  /** The current live handle, or null before first spawn / between respawns /
      when no spawn was needed (autoStart off, reuse). */
  current: () => SidecarHandle | null;
}

export function createSidecarSupervisor(opts: SidecarSupervisorOpts): SidecarSupervisor {
  const {
    buildOpts,
    log = console.log,
    warn = console.warn,
    spawnFn = spawnSidecar,
    delayFn = (ms) => new Promise((r) => setTimeout(r, ms)),
    nowFn = () => Date.now(),
    backoffsMs = DEFAULT_BACKOFFS_MS,
    maxConsecutiveFailures = DEFAULT_MAX_CONSECUTIVE_FAILURES,
  } = opts;

  let stopped = false;
  let handle: SidecarHandle | null = null;
  let consecutiveFailures = 0;
  let lastSpawnAt = 0;

  async function spawnOnce(): Promise<void> {
    if (stopped) return;
    lastSpawnAt = nowFn();
    const base = await buildOpts();
    /* spawnSidecar returns null for benign no-spawn (autoStart off, a healthy
       sidecar already listening) AND for a spawn error. Either way there's no
       child, so no onExit fires and supervision is dormant until something is
       actually spawned — matching the pre-supervisor contract. */
    handle = await spawnFn({ ...base, onExit: onChildExit });
  }

  function onChildExit(code: number | null, signal: NodeJS.Signals | null): void {
    if (stopped) return; // we killed it on purpose (shutdown) — don't resurrect.
    handle = null;
    const lived = nowFn() - lastSpawnAt;
    if (lived >= QUICK_DEATH_MS) consecutiveFailures = 0; // ran a while → fresh incident.
    consecutiveFailures += 1;
    if (consecutiveFailures > maxConsecutiveFailures) {
      warn(
        `[sidecar] supervisor: ${consecutiveFailures} rapid sidecar exits in a row ` +
          `(last code=${code} signal=${signal}) — giving up respawn. TTS is DOWN; ` +
          `restart the server to recover.`,
      );
      return;
    }
    const delayMs = backoffsMs[Math.min(consecutiveFailures - 1, backoffsMs.length - 1)];
    log(
      `[sidecar] supervisor: child exited (code=${code} signal=${signal}); ` +
        `respawning in ${delayMs}ms (attempt ${consecutiveFailures}/${maxConsecutiveFailures}).`,
    );
    void (async () => {
      await delayFn(delayMs);
      if (stopped) return; // stop() raced during the backoff window.
      try {
        await spawnOnce();
      } catch (err) {
        warn(`[sidecar] supervisor: respawn failed (${(err as Error).message}).`);
      }
    })();
  }

  return {
    async start() {
      stopped = false;
      consecutiveFailures = 0;
      await spawnOnce();
    },
    async stop() {
      stopped = true;
      const h = handle;
      handle = null;
      await h?.kill();
    },
    current() {
      return handle;
    },
  };
}
