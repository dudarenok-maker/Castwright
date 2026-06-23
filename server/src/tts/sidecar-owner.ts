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
 * Fix (Option B, mirroring `attachListenErrorHandler`'s EADDRINUSE handling in
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
 */
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** The sidecar port the supervisor manages — `DEFAULT_PORT` in spawn-sidecar.ts.
    Recorded in the note for diagnostics; the guard keys on pid/ppid, not port. */
const SIDECAR_PORT = 9000;
const OWNER_FILE = 'tts.owner.json';

export interface SidecarOwnerNote {
  /** PID of the server process that owns (supervises) the :9000 sidecar. */
  pid: number;
  /** Parent PID — the lineage key that survives a `tsx watch` reload. -1 when a
      legacy/partial note omitted it (then only the pid match suppresses a
      self-conflict). */
  ppid: number;
  /** The sidecar port this owner manages (informational; always 9000 today). */
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
      port: typeof p.port === 'number' ? p.port : SIDECAR_PORT,
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

/** Write the owner note, claiming :9000 ownership for this server. Creates
    `runDir` if needed. */
export function claimSidecarOwnership(opts: ClaimOpts): void {
  const {
    runDir,
    pid = process.pid,
    ppid = process.ppid,
    port = SIDECAR_PORT,
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
  aliveFn?: (pid: number) => boolean;
}

/** A LIVE, FOREIGN owner, or null. Not a conflict when: there is no note; the
    note is our own pid; the note shares our lineage (a `tsx watch` reload — same
    ppid, new pid); or the recorded owner is dead (stale note). */
export function findConflictingOwner(opts: ConflictCheckOpts): SidecarOwnerNote | null {
  const { runDir, pid = process.pid, ppid = process.ppid, aliveFn = isProcessAlive } = opts;
  const owner = readSidecarOwner(runDir);
  if (!owner) return null;
  if (owner.pid === pid) return null; // our own note
  if (owner.ppid > 0 && owner.ppid === ppid) return null; // same stack reloading (tsx watch)
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

/** Enforce single-ownership of the :9000 sidecar. If another LIVE, FOREIGN
    server already owns it, log an actionable FATAL line and exit(1) (mirroring
    `attachListenErrorHandler`'s EADDRINUSE behaviour) — returning false WITHOUT
    clobbering the incumbent's note. Otherwise claim ownership for this server
    and return true. `log`/`exit` default to console.error / process.exit and
    are injectable for tests. */
export function enforceSingleSidecarOwner(opts: EnforceOwnerOpts): boolean {
  const {
    runDir,
    pid = process.pid,
    ppid = process.ppid,
    port = SIDECAR_PORT,
    aliveFn,
    log = (m) => console.error(m),
    exit = (c) => process.exit(c),
    nowIso,
  } = opts;
  const conflict = findConflictingOwner({ runDir, pid, ppid, aliveFn });
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
