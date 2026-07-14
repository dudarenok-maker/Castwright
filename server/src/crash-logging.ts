/* Crash diagnostics + resilience for the generation server.
 *
 * The server died silently twice on 2026-05-30 — `:8080` went down with NO
 * trace in logs/server.err.log, no heap-OOM, RAM fine — leaving the run stalled
 * and the cause un-diagnosable. Node terminates on an uncaught exception /
 * unhandled rejection, but the default output wasn't landing in our captured
 * stderr. These handlers make a crash visible (and a transient rejection
 * survivable):
 *
 *   - uncaughtException → LOG the stack, then exit(1). Process state is
 *     undefined after an uncaught throw (Node docs), so we must let it die and
 *     be restarted, not limp on — but now it dies WITH a logged cause.
 *   - unhandledRejection → LOG the reason and SURVIVE (do NOT exit). A stray
 *     rejection — e.g. a transient sidecar-fetch error on a path that forgot to
 *     await/catch — shouldn't take down a long unattended generation run. This
 *     intentionally overrides Node's terminate-on-rejection default: the log
 *     surfaces the source so it can be fixed at the root, while the run keeps
 *     serving. (If a future crash STILL leaves no log, it's native/external —
 *     itself a diagnostic clue.)
 *
 * srv-17 — once the plan-145 handlers above were live they captured the actual
 * crash, and it was NOT the hypothesised mid-run silent death: both FATALs were
 * `listen EADDRINUSE` at startup (a double-start while a prior instance still
 * held the port). A raw bind failure bubbling to uncaughtException prints a
 * cryptic Node stack; `formatListenError` below turns it into an actionable
 * "a server is already running" line instead.
 *
 * srv-60 — `listenWithAutoRebind` now owns the whole listen loop. In dev it
 * keeps the srv-17 behavior (actionable message, clean exit) on EADDRINUSE;
 * in production it instead walks upward to the next free port and retries,
 * so a stale process holding the port no longer takes the whole server down.
 *
 * console.* is already timestamp-patched (logger.installTimestamps), so the
 * messages here inherit the standard `YYYY-MM-DD HH:mm:ss.SSS [server]` stamp.
 */

import type { AddressInfo } from 'node:net';

export type CrashKind = 'uncaughtException' | 'unhandledRejection';

/** Format a fatal/loud crash line: kind + the error's stack (or its stringified
 *  value for a non-Error rejection reason). No timestamp — the console patch
 *  adds it. */
export function formatCrash(kind: CrashKind, err: unknown): string {
  const detail =
    err instanceof Error ? (err.stack ?? `${err.name}: ${err.message}`) : String(err);
  return `[server] FATAL ${kind} — ${detail}`;
}

export interface CrashHandlerHooks {
  /** Where to write the crash line (default console.error → server.err.log). */
  onLog?: (msg: string) => void;
  /** How to exit on an uncaught exception (default process.exit). */
  onExit?: (code: number) => void;
  /** Emitter to attach to (default `process`; injected in tests). */
  target?: NodeJS.EventEmitter;
}

/** Install the process-level crash handlers. Idempotent enough for a single
 *  startup call; the `target` seam lets tests drive it without touching the
 *  real process. */
export function installCrashHandlers(hooks: CrashHandlerHooks = {}): void {
  const log = hooks.onLog ?? ((m: string) => console.error(m));
  const exit = hooks.onExit ?? ((c: number) => process.exit(c));
  const target = hooks.target ?? process;

  target.on('uncaughtException', (err: unknown) => {
    log(formatCrash('uncaughtException', err));
    exit(1);
  });

  target.on('unhandledRejection', (reason: unknown) => {
    log(`${formatCrash('unhandledRejection', reason)} (survived — server continues)`);
  });
}

/* ---- srv-17: actionable listen-error handling ---------------------------- */

/** Format a listen-error line. EADDRINUSE — the only one we've actually seen
 *  (a double-start) — gets an actionable hint pointing at the likely cause;
 *  any other bind error gets the generic FATAL form with the stack. No
 *  timestamp — the console patch adds it. */
export function formatListenError(port: number, err: NodeJS.ErrnoException): string {
  if (err.code === 'EADDRINUSE') {
    return (
      `[server] Port ${port} is already in use — another server instance is likely ` +
      `already running. Stop it first (stop-app, or Ctrl+C the existing run) or set ` +
      `PORT to a free port, then retry.`
    );
  }
  return `[server] FATAL listen error on port ${port} — ${err.stack ?? `${err.name}: ${err.message}`}`;
}

/** Minimal surface of a freshly-created (not-yet-listening) HTTP/HTTPS server
 *  that listenWithAutoRebind drives. net/http/https `.Server` all satisfy it;
 *  a fake stands in for tests. */
export interface RebindServer {
  on(event: 'error', cb: (err: NodeJS.ErrnoException) => void): void;
  once(event: 'listening', cb: () => void): void;
  listen(port: number, host?: string): void;
  address(): AddressInfo | string | null;
}

export interface AutoRebindOptions {
  /** First port to try; auto-shift walks upward from here. */
  startPort: number;
  /** Bind host (loopback vs 0.0.0.0). Omitted → Node default. */
  host?: string;
  /** Called ONCE, on the final successful bind, with the ACTUAL bound port. */
  onListening: (port: number) => void;
  /** Auto-shift on EADDRINUSE (production) vs actionable fatal-exit (dev). */
  autoRebind: boolean;
  /** Total bind attempts incl. the first. Default 20 (startPort..startPort+19). */
  maxAttempts?: number;
  onLog?: (msg: string) => void;
  onExit?: (code: number) => void;
}

/** Format the "scanned the whole range, gave up" fatal line. */
export function formatRebindExhausted(startPort: number, maxAttempts: number): string {
  const last = startPort + maxAttempts - 1;
  return (
    `[server] Ports ${startPort}–${last} are all in use — could not bind after ` +
    `${maxAttempts} attempts. Stop the conflicting server(s), then retry.`
  );
}

/** Own the listen loop: bind `startPort`, and on EADDRINUSE (when `autoRebind`)
 *  walk upward to the next port, up to `maxAttempts` total binds, then
 *  fatal-exit. The success handler is attached ONCE via `once('listening')` — a
 *  re-passed listen callback would accumulate (a failed bind emits 'error', not
 *  'listening') and fire once PER attempt, double-spawning everything the
 *  success handler wires up (#1030 recycle-storm). `onListening` receives the
 *  real bound port from `server.address()`. In dev (`autoRebind:false`) an
 *  EADDRINUSE keeps the pre-srv-60 behavior: actionable message + exit(1). */
export function listenWithAutoRebind(server: RebindServer, opts: AutoRebindOptions): void {
  const maxAttempts = opts.maxAttempts ?? 20;
  const log = opts.onLog ?? ((m: string) => console.error(m));
  const exit = opts.onExit ?? ((c: number) => process.exit(c));

  let attempt = 0; // 0-based; attempt 0 is the initial bind
  let port = opts.startPort;

  const listen = () => {
    if (opts.host !== undefined) server.listen(port, opts.host);
    else server.listen(port);
  };

  server.once('listening', () => {
    const addr = server.address();
    const bound = typeof addr === 'object' && addr !== null ? addr.port : port;
    opts.onListening(bound);
  });

  server.on('error', (err) => {
    const inUse = err.code === 'EADDRINUSE';
    if (inUse && opts.autoRebind && attempt < maxAttempts - 1) {
      log(`[server] Port ${port} is in use — trying ${port + 1}…`);
      attempt += 1;
      port += 1;
      listen();
      return;
    }
    if (inUse && opts.autoRebind) {
      log(formatRebindExhausted(opts.startPort, maxAttempts));
      exit(1);
      return;
    }
    // dev EADDRINUSE, or any non-EADDRINUSE error → unchanged actionable/fatal exit
    log(formatListenError(port, err));
    exit(1);
  });

  listen();
}
