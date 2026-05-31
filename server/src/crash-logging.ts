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
 * cryptic Node stack; `attachListenErrorHandler` below intercepts it on the
 * listener itself and prints an actionable "a server is already running" line
 * before a clean exit, so EADDRINUSE never reaches the uncaughtException path.
 *
 * console.* is already timestamp-patched (logger.installTimestamps), so the
 * messages here inherit the standard `YYYY-MM-DD HH:mm:ss.SSS [server]` stamp.
 */

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

/** A freshly-created HTTP/HTTPS listener — just the slice we attach to. */
export interface ListenErrorTarget {
  on(event: 'error', cb: (err: NodeJS.ErrnoException) => void): void;
}

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

/** Attach an `'error'` handler to a freshly-created listener so a bind failure
 *  (EADDRINUSE on a double-start, or a stale instance still holding the port)
 *  surfaces an actionable message and a clean exit, instead of bubbling to the
 *  uncaughtException handler as a cryptic stack. `onLog` / `onExit` default to
 *  console.error / process.exit and are injectable for tests, mirroring
 *  `installCrashHandlers`. */
export function attachListenErrorHandler(
  server: ListenErrorTarget,
  port: number,
  hooks: { onLog?: (msg: string) => void; onExit?: (code: number) => void } = {},
): void {
  const log = hooks.onLog ?? ((m: string) => console.error(m));
  const exit = hooks.onExit ?? ((c: number) => process.exit(c));
  server.on('error', (err) => {
    log(formatListenError(port, err));
    exit(1);
  });
}
