/** The real scan scope of version.guard.test.ts (#3837, M17): it reads
    `server/src/routes/book-state.ts` at runtime (readFileSync + a tokenizer
    pass) to look for a real `checkParseHintsPairing(` call, rather than
    importing it. No module-graph edge exists to that file for that reason, so
    vitest's `--changed` cannot select this guard on its diff — this constant,
    expressed relative to the repo root in the same brace-glob style
    `server/vitest.config.ts`'s other `forceRerunTriggers` entries use, is
    the single source of truth `force-rerun-triggers.test.ts` checks against,
    so the two can never independently drift (#3085). */
export const PARSER_VERSION_GUARD_SCAN_GLOB = 'server/src/routes/book-state.ts';
