import { defineConfig } from 'vitest/config';
import type { Reporter, TestCase } from 'vitest/node';
import { isAgent } from 'std-env';

/* Server-side test harness. Node environment (no jsdom) — most suites are
   pure helpers + supertest against Express routers. Tests that shell out
   to ffmpeg (e.g. mp3.test.ts) need a generous timeout because the encoder
   subprocess spawn + libmp3lame init costs a few hundred ms cold.

   Pool concurrency is capped (maxForks=2) and one retry is allowed: see
   docs/features/archive/45-vitest-pool-tuning.md for the rationale. The default
   forks pool grows to N=logical-CPUs (16+ on dev boxes); with subprocess-
   spawning tests (ffmpeg, supertest servers, sidecar mocks) that exhausts
   pipe/handle budgets and one worker dies mid-suite ("Worker exited
   unexpectedly"), failing the whole verify. Cap + retry absorbs both the
   root cause and the residual transients without forcing a full re-push.

   Plan 45 (vitest pool tuning, 2026-05-22) — dropped maxForks 4 → 2 and added
   explicit hookTimeout: 30_000 after 4 routes test files (book-state,
   chapters-restructure, generation, plus analyzer/gemini for the timer-
   based abort race) repeatedly timed out across full-suite load. The
   common shape: mkdtempSync + module imports in beforeAll racing on
   Windows tmpdir under maxForks=4. Halving parallel tmpdir pressure
   eliminates the race; the 30s hook budget covers a slow first import
   under pool contention (testTimeout: 15_000 doesn't extend hook budgets
   on its own, so a hook can timeout while the test's per-test override
   sits unused). The 4 hot files now also run in a separate serial
   `test:server-slow` step (root package.json) so even when this main
   parallel run trips, the slow files are independently green. */

/* Mirror invariant: each entry here MUST also appear in
   vitest.config.slow.ts's SLOW_FILES array. The slow config runs these
   files serially (maxForks=1) and the main config excludes them so we
   never double-run. */
export const SLOW_FILES_TO_EXCLUDE = [
  'src/analyzer/gemini.test.ts',
  'src/routes/analysis-pipelining.test.ts',
  'src/routes/book-state.test.ts',
  'src/routes/chapters-restructure.test.ts',
  'src/routes/generation.test.ts',
  'src/routes/generation-boundary-recycle.test.ts',
  /* Loads the real pdf-parse 2 / bundled pdfjs; destabilises the parallel
     fork pool ("Worker exited unexpectedly"). Serialised, not slow. */
  'src/parsers/pdf-real.test.ts',
  /* Integration test: makes a real 2s-timeout network probe to the sidecar.
     Slow/flaky under the parallel fast pool — serialised here (fs-21). */
  'src/routes/setup-readiness.route.test.ts',
  /* Integration route test: supertest against a live Express instance
     (kokoro install bootstrap, offline-stubbed). Serialised (fs-21). */
  'src/routes/kokoro-install.route.test.ts',
  /* Integration route test: supertest against a live Express instance
     (venv bootstrap, offline-stubbed). Serialised (fs-21). */
  'src/routes/venv-bootstrap.route.test.ts',
  /* mkdtempSync + five sequential dynamic imports in beforeAll; same
     contention class as the other route e2e tests above (#2947). */
  'src/routes/analysis.interim-prune-prohibition.e2e.test.ts',
];

/* Contention throttle (plan 156). LOW_CONCURRENCY (set manually, or
   automatically by scripts/verify-cache.mjs on a busy GPU) drops maxForks
   2 → 1 so a co-running generation can't tip this subprocess-heavy suite into
   "Worker exited unexpectedly". Mirrors serverMaxForks() in
   scripts/test-concurrency.mjs (the unit-tested copy); can't import it here
   (tsconfig allowJs:false). */
const lowConcurrency =
  process.env.LOW_CONCURRENCY === '1' || process.env.LOW_CONCURRENCY === 'true';
const maxWorkers = lowConcurrency ? 1 : 2;

/* ops-46 (#2028) — retry:1 below can turn a genuine red-phase test green: for
   a test asserting on module-level mutable state keyed by a fixed string
   (a Map/Set/counter at module scope, or fixture state on disk keyed by a
   fixed path), attempt 1 fails and leaks its mutation; attempt 2 reads state
   attempt 1 already touched and passes for the wrong reason. See
   CONTRIBUTING.md's "When you ship a change" section (the "#2028" note) for
   the full writeup and the `--retry=0` verification convention this
   reporter exists to surface.

   #2028's Acceptance offered two deliberate options, Narrow or Global — this
   PR ships **Narrow**, not neither:
   - Narrow: server/src/workspace/file-lock.test.ts's `describe('withKeyLock',
     { retry: 0 }, ...)` — withKeyLock's module-level `chains` Map is exactly
     the shape #2028 describes, and that file is where the hazard was found
     landing #2001. A red-phase test against that state is never silently
     rescued by the suite-wide retry.
   - Global was surveyed rather than assumed, and rejected on the evidence
     AS OF 2026-08-01: surveyed via `npx vitest run --retry=0` against this
     exact suite on unmodified `main` — it reddened `src/routes/voices.test.ts`
     ("writes ONLY to the anchor book's series..."), deterministically, on
     the FIRST attempt, every time. That test was green in every gating run
     purely because retry:1 papered over it, so dropping retry suite-wide
     would have reddened every lane's CI on that file.
     **That specific blocker is now discharged**: #2046 root-caused it as
     test-fixture pollution (three describes cleaned two of the three books
     their workspace-wide writes touched — NOT a production scope leak) and
     fixed it, so that file is green under `--retry=0`. This does not by
     itself make Global safe: the 2026-08-01 survey named one red file, and
     nothing has re-surveyed the suite since. Re-run the survey before
     re-opening the Narrow-vs-Global call — do not read the discharged
     blocker as a green light.
   retryHazardReporter below is additive on top of Narrow, not a replacement
   for it: Narrow covers file-lock.test.ts specifically; every OTHER file
   still runs under the suite-wide retry:1, and for those, any test that
   fails on attempt 1 and only passes after a retry prints a `[retry-hazard]`
   line below, naming the file and test, so it can no longer pass silently
   there either. A human then re-runs it with `--retry=0` to judge whether
   it's a genuine transient (route through quarantinedIt,
   docs/testing/flaky-register.md) or a red-phase test the retry hid (this
   issue's failure mode) — exactly the survey the "drop retry globally"
   option needed, now running on every CI invocation instead of once by
   hand. */
export const retryHazardReporter: Reporter = {
  onTestCaseResult(testCase: TestCase) {
    const diagnostic = testCase.diagnostic();
    if (diagnostic && diagnostic.retryCount > 0 && testCase.result().state === 'passed') {
      console.warn(
        `[retry-hazard] ${testCase.module.moduleId} :: "${testCase.fullName}" failed on its ` +
          `first attempt and only passed after ${diagnostic.retryCount} retry(ies). If this test ` +
          'asserts on module-level mutable state, retry:1 may be hiding a genuine red-phase ' +
          'failure (#2028) — re-run with --retry=0 to check. See CONTRIBUTING.md "When you ' +
          'ship a change" (the "#2028" note).',
      );
    }
  },
};

export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    /* Redirect user-settings to a temp file before any module loads (plan
       122) so suites never touch the real ~/.audiobook-generator file. */
    setupFiles: ['src/test-setup.ts'],
    include: ['src/**/*.{test,spec}.ts'],
    /* `*.golden.test.ts` is the opt-in GPU-free assembly golden (ops-11,
       Suite B) — run only via `npm run test:golden-audio` through
       vitest.config.golden.ts, never in the default `test:server` tier. */
    exclude: [
      'node_modules/**',
      'dist/**',
      'src/test-setup.ts',
      'src/**/*.golden.test.ts',
      /* PR #2049 review, Finding 6 — vitest-retry-hazard-reporter.test.ts's
         runVitestOnFixture() writes throwaway wire-test fixtures under this
         directory and deletes them in a `finally` block; a kill between
         write and cleanup could leave one behind. Excluding it here means a
         surviving `__wire-fixtures__/*.test.ts` is structurally invisible to
         THIS suite regardless — `vitest.config.wire-fixtures.ts` is the only
         config that ever includes it, and only that config is what
         runVitestOnFixture() spawns against. */
      'src/__wire-fixtures__/**',
      ...SLOW_FILES_TO_EXCLUDE,
    ],
    testTimeout: 15_000,
    hookTimeout: 30_000,
    /* Setting this key REPLACES vitest's defaults rather than extending them,
       so the first two entries re-list them — same note the root
       vitest.config.ts has always carried. Every entry is a brace
       alternation of two halves, each guarding a different picomatch
       failure; the full write-up lives in the root vitest.config.ts. In
       short: the pinned `.ts` with no trailing globstar suffix is
       ops-30/#1848 (a wildcard inside a path segment kills the
       trailing-globstar-also-matches-the-file behaviour, so vitest's own
       documented default matches NOTHING), and the second alternative — the
       one naming a dot segment explicitly — is ops-33/#1868 (picomatch's
       globstar will not cross a dot-prefixed segment without `{ dot: true }`,
       which vitest never passes, so every entry dies when the suite runs
       from a `.claude/worktrees/…` checkout). This is load-bearing,
       measured on a clean tree: with them stripped, a root-manifest diff
       makes `cd server && vitest run --changed` report "No test files found"
       and exit 0 — a release-cut version bump would run ZERO server tests
       and show green. With them restored the same diff selects 5389. (An
       earlier run here appeared to contradict that; it was measuring a
       dirty tree whose other modified files matched the openapi trigger
       below.)
       openapi.yaml: voice-library.test.ts pins MAX_CLONE_TRANSCRIPT_CHARS
       against it by reading the file at RUNTIME — no module-graph edge, so
       `--changed` would otherwise skip the pin on the openapi-only diff it
       exists to catch.
       scripts/** (covers server/tts-sidecar/scripts/** too — see that
       entry's own comment), pinokio-scripts/**, e2e/global-teardown.ts,
       launch.mjs (#2567 review round 3): the same
       runtime-read gap as openapi.yaml, one level up. spawn-windows-hide.
       test.ts (server/src, so IN this suite) reads every one of these trees
       as TEXT via readFileSync to scan for a missing windowsHide — no
       module-graph edge to any of them. `verify.yml`'s CI job runs `vitest
       run --changed` (not this repo's own local verify-cache.mjs, which has
       its own separate glob-based fix for the same gap — see test:server's
       inputs in scripts/verify-cache.mjs); without these triggers a diff
       confined to any of these trees selected ZERO tests here (measured:
       `npx vitest related scripts/wt-new.mjs --run` → "No test files found,
       exiting with code 0"), so CI's required check ran and reported green
       while never re-executing the very guard the diff could have broken. */
    forceRerunTriggers: [
      '{**/package.json,**/.*/**/package.json}',
      '{**/{vitest,vite}.config.ts,**/.*/**/{vitest,vite}.config.ts}',
      /* vitest.config.slow.ts needs its OWN entry: the brace above matches
         `vitest.config.ts`, not `vitest.config.slow.ts`. Without this, a
         slow-config-only diff selects zero tests from THIS suite — which is
         where force-rerun-triggers.test.ts lives, so the guard protecting the
         slow config could itself be reverted with CI green. (The slow config's
         own trigger does fire, but it selects only the 10 slow files, and the
         guard is not one of them. Nothing creates a module-graph edge either:
         SLOW_FILES has no importers, and the guard reaches both configs via a
         runtime-computed dynamic import that vite cannot record as a dep.) */
      '{**/vitest.config.slow.ts,**/.*/**/vitest.config.slow.ts}',
      '{**/openapi.yaml,**/.*/**/openapi.yaml}',
      /* Covers server/tts-sidecar/scripts/** too — the pattern below already
         matches any path with a 'scripts' segment anywhere, verified live
         against server/tts-sidecar/scripts/install-ort.mjs at all three root
         shapes; a separate entry for that subtree would be a dead, vacuous
         trigger (force-rerun-triggers.test.ts's own NOT_COVERED cases exist
         to catch exactly this kind of thing going the other way — a trigger
         that matches nothing it claims to). NOTE: don't write the glob text
         itself (globstar-slash) inline in a block comment — that sequence
         closes the comment early, exactly the bug this note replaced. */
      '{**/scripts/**,**/.*/**/scripts/**}',
      '{**/pinokio-scripts/**,**/.*/**/pinokio-scripts/**}',
      '{**/e2e/global-teardown.ts,**/.*/**/e2e/global-teardown.ts}',
      '{**/launch.mjs,**/.*/**/launch.mjs}',
      /* .gitattributes, server/tts-sidecar/requirements/** (#2588 pass-2 review):
         venv-migration.test.ts (this suite) reads BOTH at RUNTIME — the requirements
         files to hash reqHash oracles and assert the CRLF pin materialised (#2586),
         .gitattributes to assert the pin RULE is actually declared. No module-graph
         edge reaches either, so under `vitest run --changed` a diff confined to
         either selected zero tests here before these triggers existed — the same
         consequence spelled out above for openapi.yaml/scripts/**. */
      '{**/.gitattributes,**/.*/**/.gitattributes}',
      '{**/server/tts-sidecar/requirements/**,**/.*/**/server/tts-sidecar/requirements/**}',
      /* coqui-residency-policy.guard.test.ts (#1932 side-18): reads three files at
         RUNTIME to catch cross-reference rot across the two Coqui eviction mechanisms
         and their policy doc. The sidecar main.py and docs file have no module-graph
         edges (same #1847 runtime-read trap); synthesise-chapter.ts IS importable
         but is included here for consistency with the guard's uniform readFileSync
         approach rather than being split into two separate tracking mechanisms. */
      '{**/server/src/tts/synthesise-chapter.ts,**/.*/**/server/src/tts/synthesise-chapter.ts}',
      '{**/server/tts-sidecar/main.py,**/.*/**/server/tts-sidecar/main.py}',
      '{**/docs/features/264-vram-aware-gpu-placement.md,**/.*/**/docs/features/264-vram-aware-gpu-placement.md}',
    ],
    pool: 'forks',
    /* Vitest 4 removed `poolOptions`; `poolOptions.forks.maxForks` is now the
       top-level `maxWorkers` (and `minForks` was dropped). `pool: 'forks'`
       stays — this subprocess-heavy suite still needs fork isolation. */
    maxWorkers,
    retry: 1,
    // ops-46 (#2028) — see retryHazardReporter above for why retry:1 stays
    // and what this adds on top of it. Vitest only auto-selects its OWN
    // built-in reporters when the resolved `reporters` array is EMPTY —
    // setting one explicitly, unconditionally, silently overrode TWO
    // separate auto-selections (PR #2049 review, Findings 1 and 4):
    //   1. The base reporter: vitest's own resolver pushes
    //      `[isAgent ? 'agent' : 'default', {}]` — 'agent' under an AI
    //      coding agent (std-env's isAgent, true here under CLAUDECODE —
    //      also Cursor, Replit, Codex, etc.), 'default' otherwise.
    //      Hardcoding 'default' in both ternary arms below silently
    //      downgraded every agent-driven local run.
    //   2. 'github-actions' (inline PR annotations + the "Flaky Tests"
    //      $GITHUB_STEP_SUMMARY panel), appended only when GITHUB_ACTIONS
    //      is 'true'; verify.yml runs `vitest run` directly in server/, so
    //      suppressing it silenced that panel on every CI run of this
    //      suite. Reproduced against installed vitest 4.1.9: with an empty
    //      `reporters` config and GITHUB_ACTIONS=true, both an inline
    //      `::error file=…,line=…::…` annotation and a rendered "Flaky
    //      Tests" summary appear; with the old unconditional
    //      `['default', retryHazardReporter]`, neither did.
    // Mirroring both selections below keeps this config's behaviour
    // identical to what an EMPTY `reporters` array would already do, plus
    // retryHazardReporter layered on top — never a downgrade from it. No
    // sibling config has this bug: vitest.config.slow.ts,
    // vitest.config.golden.ts and the root frontend config all leave
    // `reporters` unset.
    reporters:
      process.env.GITHUB_ACTIONS === 'true'
        ? [isAgent ? 'agent' : 'default', 'github-actions', retryHazardReporter]
        : [isAgent ? 'agent' : 'default', retryHazardReporter],
  },
});
