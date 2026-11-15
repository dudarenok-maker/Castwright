// #4054: the per-process node flags that keep the environment and the network
// interface list out of a fatal-error diagnostic report. The server's
// enableFatalErrorReports (server/src/crash-logging.ts) leaves reports off
// unless node itself parsed both.
//
// On node's command line they cover the main thread and every Worker that
// inherits execArgv. A Worker started with its own execArgv — tsx's esbuild
// runs its sync API in one with `execArgv: []` — parses its own execArgv plus
// the NODE_OPTIONS in its env instead, never the parent's command line. So the
// launchers also hand node both flags in NODE_OPTIONS.

export const REPORT_EXCLUSION_FLAGS = ['--report-exclude-env', '--report-exclude-network'];

/** A copy of `env` whose NODE_OPTIONS ends with every REPORT_EXCLUSION_FLAGS
 *  entry it did not already carry. Appends, never clobbers; idempotent. */
export function withReportExclusionNodeOptions(env) {
  const current = (env.NODE_OPTIONS ?? '').trim();
  const have = new Set(current.split(/\s+/).filter(Boolean));
  const missing = REPORT_EXCLUSION_FLAGS.filter((f) => !have.has(f));
  return { ...env, NODE_OPTIONS: [current, ...missing].filter(Boolean).join(' ') };
}
