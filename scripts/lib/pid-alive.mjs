// scripts/lib/pid-alive.mjs — shared fail-safe pid liveness probe.
//
// `process.kill(pid, 0)` sends no signal; it only asks the OS whether `pid`
// exists and is reachable. It throws ESRCH once the pid is truly gone, and
// EPERM when the pid is alive but owned by someone else (a protected/other-
// user process) — EPERM must read as alive, not gone. Anything else
// (ERR_INVALID_ARG_TYPE, an unexpected errno, …) is treated as alive too:
// this probe is a gate for "is it safe to report a kill succeeded", so a
// probe that fails OPEN (defaults to "gone" on an unrecognised error) can
// silently report a kill that never happened, while one that fails CLOSED
// (defaults to "alive") only ever produces an over-cautious false negative.
// Only ESRCH is a confirmed-gone signal.
export function pidIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code !== 'ESRCH';
  }
}
