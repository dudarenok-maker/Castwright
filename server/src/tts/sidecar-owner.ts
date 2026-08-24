/* #1030 — single-owner guard for the TTS sidecar (:9000).
 *
 * Plan 43 moved sidecar ownership to the Node server, and the srv-15 supervisor
 * kills + respawns any :9000 sidecar it judges "unfit" (stale protocol, prod
 * never-adopt policy, ceiling mismatch, leak-saturated). With ONE server that's
 * correct. With TWO server stacks on DIFFERENT HTTP ports (e.g. `npm start` dev
 * on :8080 + `start:lan` on :8443) the existing EADDRINUSE guard never trips, so
 * both boot and share the one global :9000 — and each sees the OTHER's healthy,
 * in-use sidecar as unfit and replaces it, in an endless kill/respawn loop (the
 * recycle storm: generation stalls because the sidecar is killed out from under
 * an in-flight chapter).
 *
 * Fix (Option B, mirroring `listenWithAutoRebind`'s EADDRINUSE handling in
 * crash-logging.ts): the owning server drops a note (.run/tts.owner.json)
 * recording its pid + parent pid. A second server that finds a LIVE, FOREIGN
 * owner refuses to boot with an actionable message + exit(1) instead of starting
 * a rival supervisor.
 *
 * `ppid` is the lineage key: `tsx watch` (the dev `npm run dev:server` runner)
 * respawns the server child on every save under the SAME watcher parent — new
 * pid, same ppid. Keying conflict on a DIFFERENT ppid lets a reload recognise
 * itself and take over, while a genuinely separate stack is refused. Without
 * this, every dev save would kill the server.
 *
 * #2632 — port resolution: the sidecar port is now resolved from LOCAL_TTS_PORT
 * env var (default 9000), so multiple worktrees can run sidecars concurrently
 * on different ports. The port is read once at startup and passed through to
 * both spawn-sidecar.ts and sidecar-owner.ts so they coordinate on the same port.
 */
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** Last invalid LOCAL_TTS_PORT value we logged an error for. Prevents duplicate
    error messages when resolveSidecarPort() is called repeatedly with the same
    bad value (deduping pattern borrowed from srv-21 in user-settings.ts). */
let lastWarnedInvalidPort: string | null = null;

/** Resolve the sidecar port from LOCAL_TTS_PORT env var (default 9000).
    Used to support per-worktree port isolation (#2632).

    IMPORTANT: Invalid values are logged as errors and fall through to 9000.
    This is intentional but loud — a typo in LOCAL_TTS_PORT (e.g. 99999 instead
    of 9999) would silently cause cross-worktree adoption, so we warn and fail
    open to :9000 instead of silent divergence. Errors are deduplicated per
    unique invalid value so 100 calls with "99999" log once, not 100 times. */
export function resolveSidecarPort(): number {
  const raw = process.env.LOCAL_TTS_PORT;
  if (raw) {
    const parsed = Number(raw);
    if (Number.isFinite(parsed) && parsed > 0 && parsed < 65536) {
      return Math.floor(parsed);
    }
    // Invalid value — log error once per unique value, then fall back to default (N3 dedup)
    if (raw !== lastWarnedInvalidPort) {
      lastWarnedInvalidPort = raw;
      console.error(
        `[sidecar-owner] Invalid LOCAL_TTS_PORT="${raw}" (must be 1-65535). Falling back to default 9000. ` +
        `Check for typos (e.g., 99999 instead of 9999) and update server/.env.`,
      );
    }
  }
  return 9000;
}

/** The sidecar port the supervisor manages — resolved from LOCAL_TTS_PORT env var
    (default 9000). Recorded in the note for diagnostics; the guard keys on
    pid/ppid AND port (#2632) — a different port is treated as an independent
    sidecar, not a conflict. */
function sidecarPort(): number {
  return resolveSidecarPort();
}
const OWNER_FILE = 'tts.owner.json';

export interface SidecarOwnerNote {
  /** PID of the server process that owns (supervises) the sidecar. */
  pid: number;
  /** Parent PID — the lineage key that survives a `tsx watch` reload. -1 when a
      legacy/partial note omitted it (then only the pid match suppresses a
      self-conflict). */
  ppid: number;
  /** The sidecar port this owner manages (from LOCAL_TTS_PORT env var, default 9000). */
  port: number;
  /** ISO timestamp ownership was claimed (informational/diagnostic). */
  startedAt: string;
}

export function sidecarOwnerPath(runDir: string): string {
  return join(runDir, OWNER_FILE);
}

/** Read + parse the owner note, or null when absent / unreadable / malformed.
    A note without a valid positive pid is treated as absent. */
export function readSidecarOwner(runDir: string): SidecarOwnerNote | null {
  let raw: string;
  try {
    raw = readFileSync(sidecarOwnerPath(runDir), 'utf8');
  } catch {
    return null; // absent
  }
  try {
    const p = JSON.parse(raw) as Partial<SidecarOwnerNote>;
    if (typeof p.pid !== 'number' || !Number.isInteger(p.pid) || p.pid <= 0) return null;
    return {
      pid: p.pid,
      ppid: typeof p.ppid === 'number' ? p.ppid : -1,
      port: typeof p.port === 'number' ? p.port : sidecarPort(),
      startedAt: typeof p.startedAt === 'string' ? p.startedAt : '',
    };
  } catch {
    return null; // corrupt JSON
  }
}

/** True if `pid` names a live process. Uses signal 0 (no signal delivered, just
    an existence + permission probe). ESRCH ⇒ dead; EPERM ⇒ alive but owned by
    another user (treat as alive, so we err toward refusing rather than stomping
    an unknown live process). */
export function isProcessAlive(pid: number, killFn: typeof process.kill = process.kill): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    killFn(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export interface ClaimOpts {
  runDir: string;
  pid?: number;
  ppid?: number;
  port?: number;
  nowIso?: () => string;
}

/** Write the owner note, claiming sidecar ownership for this server. Creates
    `runDir` if needed. Port defaults to the resolved sidecar port. */
export function claimSidecarOwnership(opts: ClaimOpts): void {
  const {
    runDir,
    pid = process.pid,
    ppid = process.ppid,
    port = sidecarPort(),
    nowIso = () => new Date().toISOString(),
  } = opts;
  mkdirSync(runDir, { recursive: true });
  const note: SidecarOwnerNote = { pid, ppid, port, startedAt: nowIso() };
  writeFileSync(sidecarOwnerPath(runDir), JSON.stringify(note), 'utf8');
}

/** Delete the owner note iff WE still own it (pid matches). A no-op when the
    note is absent or has been taken over by another lineage — safe to call
    unconditionally on shutdown. */
export function releaseSidecarOwnership(runDir: string, pid: number = process.pid): void {
  const owner = readSidecarOwner(runDir);
  if (owner && owner.pid === pid) {
    try {
      unlinkSync(sidecarOwnerPath(runDir));
    } catch {
      /* already gone */
    }
  }
}

export interface ConflictCheckOpts {
  runDir: string;
  pid?: number;
  ppid?: number;
  port?: number;
  aliveFn?: (pid: number) => boolean;
}

/** A LIVE, FOREIGN owner, or null. Not a conflict when: there is no note; the
    note is our own pid; the note shares our lineage (a `tsx watch` reload — same
    ppid, new pid); or the recorded owner is dead (stale note). */
export function findConflictingOwner(opts: ConflictCheckOpts): SidecarOwnerNote | null {
  const { runDir, pid = process.pid, ppid = process.ppid, port, aliveFn = isProcessAlive } = opts;
  const owner = readSidecarOwner(runDir);
  if (!owner) return null;
  if (owner.pid === pid) return null; // our own note
  if (owner.ppid > 0 && owner.ppid === ppid) return null; // same stack reloading (tsx watch)
  // #2632: port must also match — different ports are independent sidecars, not conflicts
  if (port !== undefined && owner.port !== port) return null;
  return aliveFn(owner.pid) ? owner : null;
}

export interface EnforceOwnerOpts {
  runDir: string;
  pid?: number;
  ppid?: number;
  port?: number;
  aliveFn?: (pid: number) => boolean;
  log?: (msg: string) => void;
  exit?: (code: number) => void;
  nowIso?: () => string;
}

/** Enforce single-ownership of the sidecar. If another LIVE, FOREIGN
    server already owns it, log an actionable FATAL line and exit(1) (mirroring
    `listenWithAutoRebind`'s EADDRINUSE behaviour) — returning false WITHOUT
    clobbering the incumbent's note. Otherwise claim ownership for this server
    and return true. `log`/`exit` default to console.error / process.exit and
    are injectable for tests. */
export function enforceSingleSidecarOwner(opts: EnforceOwnerOpts): boolean {
  const {
    runDir,
    pid = process.pid,
    ppid = process.ppid,
    port = sidecarPort(),
    aliveFn,
    log = (m) => console.error(m),
    exit = (c) => process.exit(c),
    nowIso,
  } = opts;
  const conflict = findConflictingOwner({ runDir, pid, ppid, port, aliveFn });
  if (conflict) {
    log(
      `[server] FATAL: another Castwright server (pid ${conflict.pid}) already owns the TTS ` +
        `sidecar on :${conflict.port}. Two servers managing one sidecar fight over it ` +
        `(recycle storm — generation stalls). Stop the other instance first, then restart. ` +
        `If you are certain no other server is running, delete ${sidecarOwnerPath(runDir)} and retry.`,
    );
    exit(1);
    return false; // reached only in tests where `exit` does not terminate
  }
  claimSidecarOwnership({ runDir, pid, ppid, port, nowIso });
  return true;
}
