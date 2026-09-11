/** The real scan scope of engine-language-coverage.guard.test.ts's third
    assertion: it reads `server/src/routes/generation.ts` at runtime
    (readFileSync + a TypeScript parse) to scan for the
    `resolveEligibleEngines(...)` call site, rather than importing it. No
    module-graph edge exists to that file for that reason, so vitest's
    `--changed` cannot select this guard on its diff — this constant,
    expressed relative to the repo root in the same brace-glob style
    `server/vitest.config.ts`'s other `forceRerunTriggers` entries use, is
    the single source of truth `force-rerun-triggers.test.ts` checks against,
    so the two can never independently drift (#3085). */
export const ENGINE_LANGUAGE_COVERAGE_GUARD_SCAN_GLOB = 'server/src/routes/generation.ts';
