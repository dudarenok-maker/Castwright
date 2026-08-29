/* #1030 — single-owner guard for the TTS sidecar (LOCAL_TTS_PORT, default :9000).
 *
 * Plan 43 moved sidecar ownership to the Node server, and the srv-15 supervisor
 * kills + respawns any sidecar on that port it judges "unfit" (stale protocol,
 * prod never-adopt policy, ceiling mismatch, leak-saturated). With ONE server
 * that's correct. With TWO server stacks on DIFFERENT HTTP ports (e.g. `npm
 * start` dev on :8080 + `start:lan` on :8443) the existing EADDRINUSE guard
 * never trips, so both boot and share the one sidecar port — and each sees
 * the OTHER's healthy, in-use sidecar as unfit and replaces it, in an
 * endless kill/respawn loop (the recycle storm: generation stalls because
 * the sidecar is killed out from under an in-flight chapter).
 *
 * Fix (Option B, mirroring `listenWithAutoRebind`'s EADDRINUSE handling in
 * crash-logging.ts): the owning server drops a note (.run/tts.owner.<port>.json)
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
import { mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
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
    // #2632 N28 — require a plain decimal-integer spelling before coercing.
    // Number() silently ACCEPTS non-integer/non-decimal spellings Node
    // parses fine but the shell launchers (start.ps1/.sh, which take the raw
    // string as --port) do not: "9010.9" floors to 9010, "0x2386" parses as
    // 9094, "1e4" as 10000 — all pass the finite/range gate below with NO
    // log line, unlike "99999". The accepted trade (pass 2, srv-21-style
    // dedup) is that a Node-vs-launcher divergence is safe because it is
    // ANNOUNCED at the moment it is created; a silent coercion breaks that
    // premise. Gating on /^\d+$/ first routes every non-plain-integer
    // spelling through the same loud invalid-value path "99999" already
    // takes, restoring the premise without touching the accepted trade.
    const parsed = /^\d+$/.test(raw) ? Number(raw) : NaN;
    if (Number.isFinite(parsed) && parsed > 0 && parsed < 65536) {
      return parsed;
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

export function sidecarOwnerPath(runDir: string, port: number): string {
  return join(runDir, `tts.owner.${port}.json`);
}

/** Legacy fixed-name path (pre-#2641): `.run/tts.owner.json`. Used for
    cross-version conflict detection — when upgrading from an old version to
    a port-keyed one, the legacy note must not be missed. */
function legacySidecarOwnerPath(runDir: string): string {
  return join(runDir, 'tts.owner.json');
}

/** Read + parse the owner note, or null when absent / unreadable / malformed.
    A note without a valid positive pid is treated as absent. */
export function readSidecarOwner(runDir: string, port: number): SidecarOwnerNote | null {
  let raw: string;
  try {
    raw = readFileSync(sidecarOwnerPath(runDir, port), 'utf8');
  } catch {
    return null; // absent
  }
  try {
    const p = JSON.parse(raw) as Partial<SidecarOwnerNote>;
    if (typeof p.pid !== 'number' || !Number.isInteger(p.pid) || p.pid <= 0) return null;
    return {
      pid: p.pid,
      ppid: typeof p.ppid === 'number' ? p.ppid : -1,
      port: typeof p.port === 'number' ? p.port : port,
      startedAt: typeof p.startedAt === 'string' ? p.startedAt : '',
    };
  } catch {
    return null; // corrupt JSON
  }
}

/** Read the legacy fixed-name owner note (pre-#2641), or null when absent /
    unreadable / malformed. Used for cross-version conflict detection. */
function readLegacySidecarOwner(runDir: string): SidecarOwnerNote | null {
  let raw: string;
  try {
    raw = readFileSync(legacySidecarOwnerPath(runDir), 'utf8');
  } catch {
    return null; // absent
  }
  try {
    const p = JSON.parse(raw) as Partial<SidecarOwnerNote>;
    if (typeof p.pid !== 'number' || !Number.isInteger(p.pid) || p.pid <= 0) return null;
    return {
      pid: p.pid,
      ppid: typeof p.ppid === 'number' ? p.ppid : -1,
      port: typeof p.port === 'number' ? p.port : 9000,
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
  aliveFn?: (pid: number) => boolean;
}

/** Prune stale owner notes from OTHER ports (those whose recorded pid is no longer alive).
    This runs as part of the write path so a new server startup cleans up litter from
    crashed/hard-killed servers without weakening the read-side sweep's conservative logic.
    Does NOT delete the note for the port currently being claimed (it's about to be
    overwritten anyway). `aliveFn` is injectable for testing. */
function pruneStaleNotes(runDir: string, currentPort: number, aliveFn: (pid: number) => boolean = isProcessAlive): void {
  let entries: string[];
  try {
    entries = readdirSync(runDir);
  } catch {
    // runDir doesn't exist yet — nothing to prune
    return;
  }

  const noteFiles = entries.filter((name) => /^tts\.owner\.\d+\.json$/.test(name));
  for (const fileName of noteFiles) {
    const portMatch = fileName.match(/^tts\.owner\.(\d+)\.json$/);
    if (!portMatch) continue;

    const port = Number(portMatch[1]);
    // Skip the port currently being claimed (it's about to be overwritten).
    if (port === currentPort) continue;

    const owner = readSidecarOwner(runDir, port);
    // Delete the note if the recorded owner is no longer alive.
    if (owner && !aliveFn(owner.pid)) {
      try {
        unlinkSync(sidecarOwnerPath(runDir, port));
      } catch {
        /* already gone or inaccessible — best-effort prune, not fatal */
      }
    }
  }
}

/** Write the owner note, claiming sidecar ownership for this server. Creates
    `runDir` if needed. Port defaults to the resolved sidecar port.

    As part of the write path, also prunes stale notes from OTHER ports whose
    recorded pid is no longer alive (#2754). This cleans up litter from
    crashed/hard-killed servers at the moment a NEW, legitimate server starts,
    without weakening the read-side sweep's conservative, liveness-agnostic logic.
    `aliveFn` is injectable for testing (defaults to isProcessAlive). */
export function claimSidecarOwnership(opts: ClaimOpts): void {
  const {
    runDir,
    pid = process.pid,
    ppid = process.ppid,
    port = sidecarPort(),
    nowIso = () => new Date().toISOString(),
    aliveFn = isProcessAlive,
  } = opts;
  mkdirSync(runDir, { recursive: true });
  pruneStaleNotes(runDir, port, aliveFn);
  const note: SidecarOwnerNote = { pid, ppid, port, startedAt: nowIso() };
  writeFileSync(sidecarOwnerPath(runDir, port), JSON.stringify(note), 'utf8');
}

/** Delete the owner note iff WE still own it (pid matches). A no-op when the
    note is absent or has been taken over by another lineage — safe to call
    unconditionally on shutdown. */
export function releaseSidecarOwnership(
  runDir: string,
  pid: number = process.pid,
  port: number = sidecarPort(),
): void {
  const owner = readSidecarOwner(runDir, port);
  if (owner && owner.pid === pid) {
    try {
      unlinkSync(sidecarOwnerPath(runDir, port));
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
    ppid, new pid); or the recorded owner is dead (stale note).

    Checks both the port-keyed note and the legacy fixed-name note (pre-#2641)
    to detect conflicts across version upgrades. A legacy note is only a conflict
    if its recorded port matches the current port. */
export function findConflictingOwner(opts: ConflictCheckOpts): SidecarOwnerNote | null {
  const {
    runDir,
    pid = process.pid,
    ppid = process.ppid,
    port = sidecarPort(),
    aliveFn = isProcessAlive,
  } = opts;

  // Check the port-keyed note (current version)
  const owner = readSidecarOwner(runDir, port);
  if (owner) {
    if (owner.pid === pid) return null; // our own note
    if (owner.ppid > 0 && owner.ppid === ppid) return null; // same stack reloading (tsx watch)
    if (aliveFn(owner.pid)) return owner;
  }

  // Check the legacy fixed-name note (pre-#2641 versions) for cross-version conflict detection.
  // A legacy note is only a conflict if (a) its port field matches our port, and (b) it names
  // a live process. This handles the upgrade scenario: old server running on port 9000 with
  // legacy .run/tts.owner.json, new server starting on port 9000 with port-keyed filename.
  const legacyOwner = readLegacySidecarOwner(runDir);
  if (legacyOwner && legacyOwner.port === port) {
    if (legacyOwner.pid === pid) return null; // our own legacy note
    if (legacyOwner.ppid > 0 && legacyOwner.ppid === ppid) return null; // same stack reloading
    if (aliveFn(legacyOwner.pid)) return legacyOwner;
  }

  return null;
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
        `If you are certain no other server is running, delete ${sidecarOwnerPath(runDir, port)} and retry.`,
    );
    exit(1);
    return false; // reached only in tests where `exit` does not terminate
  }
  claimSidecarOwnership({ runDir, pid, ppid, port, nowIso });
  return true;
}
