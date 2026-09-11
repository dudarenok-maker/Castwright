/** The real scan scope of coqui-residency-policy.guard.test.ts (#1932,
    side-18): it `readFileSync`s these three files at RUNTIME to check a
    cross-reference token/heading survives, rather than importing them —
    `main.py` and the policy doc have no module-graph edge for that reason
    (the same #1847 runtime-read trap), and `synthesise-chapter.ts` is
    included here too for consistency with the guard's uniform readFileSync
    approach rather than being split into two separate tracking mechanisms.
    Each entry is a repo-root-relative path, in the same brace-glob style
    `server/vitest.config.ts`'s other `forceRerunTriggers` entries use, so
    this constant is the single source of truth both
    `server/vitest.config.ts` and `force-rerun-triggers.test.ts` check
    against, instead of two independently-maintained literal copies (#3085,
    #3151 follow-up). */
export const COQUI_RESIDENCY_POLICY_GUARD_SCAN_GLOBS = [
  'server/src/tts/synthesise-chapter.ts',
  'server/tts-sidecar/main.py',
  'docs/features/264-vram-aware-gpu-placement.md',
] as const;
