/** The real scan scope of spawn-windows-hide.test.ts (#3085): unlike
    state-language.guard.test.ts / cast-lock.guard.test.ts, this guard reads
    from SEVERAL independent trees, not one — see the file's own header for
    the three-scan breakdown. Each entry below is a repo-root-relative glob
    or literal path, in the same brace-glob style
    `server/vitest.config.ts`'s other `forceRerunTriggers` entries use, so
    `force-rerun-triggers.test.ts` can check the real `forceRerunTriggers`
    array against the SAME constant the guard itself declares, instead of a
    second, independently-maintained literal.

      - 'server/src/**'                — direct + indirect spawn scans, AND
        the dev-machine *.test.ts invariant (all three read this tree).
      - 'scripts/**'                   — recursive, includes scripts/tests/.
      - 'server/tts-sidecar/scripts/**'
      - 'pinokio-scripts/lib/**'
      - 'e2e/global-teardown.ts'       — EXTERNAL_FILES_MANUAL's one entry.
      - 'vite.config.ts', 'launch.mjs' — two of the concrete files
        externalFilesFloor()'s REPO_ROOT non-recursive .mjs/.ts scan finds
        today, named individually because each already carries its own
        forceRerunTriggers entry for an unrelated reason (the vite/vitest
        config brace, the launcher trigger) that this guard's coverage can
        reuse rather than duplicate.

    NOT total coverage of the guard's real scan: externalFilesFloor() ALSO
    walks REPO_ROOT non-recursively for ANY `.mjs`/`.ts` file there (today
    that additionally includes eslint.config.mjs, playwright.config.ts,
    playwright.marketing.config.ts, vitest.config.wire-fixtures.ts), and a
    brand-new root file joins that scan automatically. A `**` prefix cannot
    express "root-level only, not nested" without also matching every `.ts`
    file anywhere in the repo, which would defeat `--changed` outright — the
    exact failure `force-rerun-triggers.test.ts`'s MAIN_NOT_COVERED cases
    guard against. This gap is pre-existing (it predates #3085) and is
    named here rather than silently implied closed. */
export const SPAWN_WINDOWS_HIDE_GUARD_SCAN_GLOBS = [
  'server/src/**',
  'scripts/**',
  'server/tts-sidecar/scripts/**',
  'pinokio-scripts/lib/**',
  'e2e/global-teardown.ts',
  'vite.config.ts',
  'launch.mjs',
] as const;
