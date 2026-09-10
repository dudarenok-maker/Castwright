/** The real scan scope of cast-lock.guard.test.ts: every non-test `.ts` file
    under `server/src` is read at runtime (readFileSync via
    `collectSourceFiles`) and scanned for `writeJsonAtomic(castJsonPath(` /
    `rm(castJsonPath(` call sites. No module-graph edge exists to any of
    these files, so vitest's `--changed` cannot select this guard on their
    diff — this constant, expressed relative to the repo root in the same
    brace-glob style `server/vitest.config.ts`'s other `forceRerunTriggers`
    entries use, is the single source of truth `force-rerun-triggers.test.ts`
    checks against, so the two can never independently drift (#3085). */
export const CAST_LOCK_GUARD_SCAN_GLOB = 'server/src/**';
