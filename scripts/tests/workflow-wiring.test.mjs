// Five wiring assertions + one coverage-parity assertion for
// .github/workflows/verify.yml's derived scope conditions (Task 7/Task 8 of
// the 2026-08-05 verify-scope-map-unification plan). The first four check
// *wiring* (keys exist, are referenced, live in gated jobs, setup steps match
// their leg) — none of them can see a coverage regression. The fifth
// (coverage parity) is the one that matters most: it replays the
// PRE-derivation legacy scope matchers against the POST-derivation
// conditions over a fixed corpus, so a narrowing introduced by the
// derivation doesn't slip through silently. See task-7-report.md's
// "Fix round 1"/"Fix round 2" sections (git-ignored scratch, not durable) for
// the full history of how ACCEPTED_NARROWINGS below was assembled — this
// array is the durable artifact; that report is not.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { computeScopes } from '../ci-scope.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const workflowPath = resolve(repoRoot, '.github', 'workflows', 'verify.yml');
const source = readFileSync(workflowPath, 'utf8');

// Every key ci-scope.mjs can emit.
const emitted = new Set(Object.keys(computeScopes([], { eventName: 'pull_request' })));

// Every key the workflow references. Pinned to the dotted fromJSON form the
// workflow actually uses; a bracket or contains() form would slip this regex,
// so the anti-vacuity floor below is what catches a syntax change.
const referenced = [
  ...source.matchAll(/fromJSON\(needs\.detect\.outputs\.scopes\)\.([A-Za-z0-9_]+)/g),
].map((m) => m[1]);

test('anti-vacuity: the workflow scan finds references', () => {
  // UNITS: this counts REFERENCES, not `if:` sites — and the two are not
  // convertible. Measured against the REAL post-Task-7 workflow (22 `if:`
  // sites, 48 references — every derived site is 2 keys, 3 for the "Server
  // tests (fast + slow)" and "Frontend tests + a11y" union sites, all plus
  // `shared`), not guessed pre-implementation the way the floor's history
  // below was. Floor 35 gives ~27% headroom under 48.
  //
  // History (kept for context, not to be trusted over a re-measure): this
  // floor was wrong twice before Task 7 landed — 20 (reasoned from "~20 if:
  // sites"), then 50 (reasoned as 55 pre-derivation refs + 6 for A1's sidecar
  // job, assuming conversion preserves refs-per-site, which it does not:
  // legacy scope names were broader than the derived ones).
  assert.ok(
    referenced.length >= 35,
    `expected >= 35 fromJSON references, found ${referenced.length} — either the regex broke or the workflow lost wiring`,
  );
});

// -> direction: no reference to a key that is never emitted. GitHub resolves
// an unknown reference to the empty string, so a typo'd key silently disables
// a leg on the REQUIRED check while everything reports green.
test('-> every referenced scope key is emitted by ci-scope.mjs', () => {
  const unknown = [...new Set(referenced)].filter((k) => !emitted.has(k));
  assert.deepEqual(
    unknown,
    [],
    `workflow references key(s) ci-scope.mjs never emits:\n${unknown.join('\n')}`,
  );
});

// <- direction: no emitted key is orphaned. This is defect C's shape — a
// verify-cache STEP with no CI home at all.
test('<- every emitted scope key is referenced by the workflow', () => {
  const refSet = new Set(referenced);
  const orphaned = [...emitted].filter((k) => !refSet.has(k));
  assert.deepEqual(
    orphaned,
    [],
    `emitted key(s) no workflow condition uses:\n${orphaned.join('\n')}`,
  );
});

// ^ direction: a job carrying a derived if: but absent from the aggregator's
// needs: can run, FAIL, and not block merge — main's ruleset pins only the
// aggregator's context ('npm run verify'). The <- direction would still
// certify its key as wired.
test('^ every job with a derived condition is in the aggregator needs:', () => {
  const jobBlocks = [...source.matchAll(/^ {2}([a-z][a-z0-9-]*):\n((?: {4}.*\n|\n)*)/gm)];
  const aggregator = jobBlocks.find(([, name]) => name === 'verify');
  assert.ok(aggregator, 'aggregator job `verify` not found');
  const needs = (aggregator[2].match(/needs:\s*\[([^\]]*)\]/) ?? [undefined, ''])[1]
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  const missing = [];
  for (const [, name, body] of jobBlocks) {
    if (name === 'verify' || name === 'detect') continue;
    if (!/fromJSON\(needs\.detect\.outputs\.scopes\)/.test(body)) continue;
    if (!needs.includes(name)) missing.push(name);
  }
  assert.deepEqual(
    missing,
    [],
    `job(s) with derived conditions missing from the aggregator's needs:\n${missing.join('\n')}`,
  );
});

// The aggregator's fail-safe (#2119): ci-scope.mjs's own fallback writes to
// the SAME $GITHUB_OUTPUT handle it's guarding, so a handle that's
// unwritable — or a `detect` that exits 0 having written nothing — leaves
// every leg job's steps skipped-but-the-JOB-green, which the 'skipped' check
// above cannot see (no job skips; only steps do). This is a step-shaped gap
// the two structural checks above can't catch by construction, so it needs
// its own assertion. Static scan on purpose, matching this file's style —
// not a live GitHub Actions run — so this is a wiring guard against the YAML
// regressing, not proof the check fires correctly in CI (that needs a hand
// inspection of the PR's own run, per the task brief).
test('aggregator sentinel: detect is in needs: and its result/ok are checked first', () => {
  const jobBlocks = [...source.matchAll(/^ {2}([a-z][a-z0-9-]*):\n((?: {4}.*\n|\n)*)/gm)];
  const aggregator = jobBlocks.find(([, name]) => name === 'verify');
  assert.ok(aggregator, 'aggregator job `verify` not found');
  const [, , body] = aggregator;

  const needs = (body.match(/needs:\s*\[([^\]]*)\]/) ?? [undefined, ''])[1]
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  assert.ok(
    needs.includes('detect'),
    `aggregator needs: is missing 'detect' — needs.detect.outputs.ok would be the ` +
      `empty string and the sentinel below would fail on every PR:\n${needs.join(', ')}`,
  );

  const stepNames = [...body.matchAll(/^ {6}- name: (.+)$/gm)].map((m) => m[1]);
  assert.equal(
    stepNames[0],
    'Scope detection ran',
    `the sentinel must be the FIRST step of the aggregator job, found order:\n${stepNames.join('\n')}`,
  );

  const sentinelBody = body.slice(body.indexOf('- name: Scope detection ran'));
  assert.match(
    sentinelBody,
    /needs\.detect\.result[^\n]*!=\s*"success"/,
    'sentinel does not gate on needs.detect.result != "success"',
  );
  assert.match(
    sentinelBody,
    /needs\.detect\.outputs\.ok[^\n]*!=\s*"true"/,
    'sentinel does not gate on needs.detect.outputs.ok != "true"',
  );
});

// Setup steps (ffmpeg, Playwright cache/install) are not legs. Each declares
// the leg it supports; its condition must be identical to that leg's, or e2e
// runs without a browser.
// The set of scope keys a condition depends on, order-independent. Compared
// instead of the raw string because a setup step legitimately carries extra
// NON-scope conjuncts: verify.yml's two "Install Playwright chromium" steps
// are `(...scopes...) && steps.playwright-cache.outputs.cache-hit != 'true'`,
// which can never be string-identical to the leg's condition. An earlier
// draft compared whole strings and would have instructed the implementer to
// delete a correct cache guard.
const scopeKeysOf = (condition) =>
  [...condition.matchAll(/fromJSON\(needs\.detect\.outputs\.scopes\)\.([A-Za-z0-9_]+)/g)]
    .map((m) => m[1])
    .sort()
    .join('|');

test('setup steps depend on the same scope keys as the leg they support', () => {
  // Legs are tagged explicitly rather than found by "first step whose if:
  // mentions this key". That heuristic is wrong twice over: setup steps
  // PRECEDE their leg in every job, so first-match returns another setup
  // step; and slugs nest (step_test is a substring of step_test_hooks /
  // step_test_e2e; step_test_server of step_test_server_slow), so a
  // substring match binds the wrong leg entirely.
  const legs = new Map(
    [...source.matchAll(/# leg: ([a-z:0-9-]+)\n\s*- name: [^\n]+\n\s*if: ([^\n]+)\n/g)].map(
      ([, leg, condition]) => [leg, condition.trim()],
    ),
  );
  const setups = [
    ...source.matchAll(/# supports: ([a-z:0-9-]+)\n\s*- name: ([^\n]+)\n\s*if: ([^\n]+)\n/g),
  ];

  // 9 setup steps (3x Install ffmpeg, 2x Cache Playwright, 2x Install
  // Playwright, plus Setup Python + Bootstrap sidecar venv for test:sidecar);
  // 13 legs (the full checklist of named leg steps, including "openapi:types"
  // and "test:sidecar" which have no LEGACY_GATES entry below but still carry
  // markers for documentation/binding purposes).
  assert.ok(setups.length >= 9, `expected >= 9 '# supports:' declarations, found ${setups.length}`);
  assert.ok(legs.size >= 11, `expected >= 11 '# leg:' declarations, found ${legs.size}`);

  const mismatched = [];
  for (const [, leg, stepName, condition] of setups) {
    const expected = legs.get(leg);
    if (!expected) {
      mismatched.push(`${stepName}: no '# leg: ${leg}' declaration found`);
      continue;
    }
    if (scopeKeysOf(condition) !== scopeKeysOf(expected)) {
      mismatched.push(
        `${stepName}\n  supports: ${leg}\n  has keys:      ${scopeKeysOf(condition) || '(none)'}\n  leg has keys:  ${scopeKeysOf(expected) || '(none)'}`,
      );
    }
  }
  assert.deepEqual(
    mismatched,
    [],
    `setup step(s) diverged from their leg:\n${mismatched.join('\n')}`,
  );
});

// --- Coverage parity ---------------------------------------------------
// Replays the PRE-derivation scope matchers against the POST-derivation
// conditions over a fixed corpus. Every path that used to run a leg must
// still run it, unless the narrowing is listed and justified below.
//
// This is the only assertion that can see a coverage regression; the other
// four are blind to it by construction.
const LEGACY_MATCHERS = {
  frontend:
    /^(src\/|index\.html$|vite\.config\.ts$|tailwind\.config\.ts$|tsconfig\.json$|tsconfig\.node\.json$|postcss\.config\.js$|eslint\.config\.(js|mjs)$)/,
  server:
    /^(server\/src\/|server\/package(-lock)?\.json$|server\/tsconfig\.json$|server\/vitest\.config(\.slow)?\.ts$|openapi\.yaml$|server\/\.env\.example$|server\/scripts\/sync-env-example\.ts$|scripts\/tests\/fixtures\/|scripts\/repair-cast-id-drift\.mjs$)/,
  sidecar: /^server\/tts-sidecar\//,
  e2e: /^(e2e\/|playwright\.config\.ts$)/,
  scripts: /^scripts\//,
  hooks:
    /^(\.husky\/|\.github\/workflows\/|\.github\/actions\/|scripts\/run-hooks-tests\.mjs$|scripts\/validate-commit-msg\.mjs$|RELEASE_NOTES\.md$|docs\/release-notes-next\.md$|scripts\/release-notes-gate\.mjs$|docs\/testing\/onbox-acceptance-register\.md$|docs\/testing\/onbox-acceptance-register-live-view\.html$)/,
  pinokio: /^(pinokio\.js$|pinokio-scripts\/|scripts\/run-pinokio-tests\.mjs$)/,
  openapi: /^openapi\.yaml$/,
  // `shared` = a root dependency-manifest change, treated as global in the
  // legacy workflow (git show a1e4b70e:.github/workflows/verify.yml:184-186:
  // `match '^(package\.json|package-lock\.json)$' && shared=true`). Added
  // for Gap 2 (workflow-wiring review): needed because the two LEGACY_GATES
  // rows added for Gap 1 ('OpenAPI types up to date', 'Sidecar tests') both
  // had `|| shared` as a real disjunct in their pre-derivation `if:` — a
  // faithful legacy-scope list for those two rows can't omit it. The
  // existing 11 LEGACY_GATES rows also had `|| shared` in their real legacy
  // conditions but predate this key and are left as-is (out of this gap's
  // scope; every derived condition already includes `shared` as its own
  // disjunct per this branch's constraints, so omitting it from those rows'
  // legacy list costs no coverage — `shared` is on both sides of the
  // comparison for them regardless).
  shared: /^(package\.json|package-lock\.json)$/,
};

// Legacy step name -> the scopes that used to gate it, from git history of
// verify.yml immediately before the scope-derivation refactor.
const LEGACY_GATES = {
  Lint: ['frontend', 'server', 'scripts'],
  Typecheck: ['frontend', 'server'],
  'Config check': ['server'],
  'Hooks tests': ['hooks', 'scripts'],
  'PowerShell-helper tests (Pester)': ['scripts'],
  'Pinokio tests': ['pinokio'],
  'Frontend tests + a11y': ['frontend', 'e2e', 'openapi'],
  'Server tests (fast + slow)': ['server', 'sidecar'],
  'E2E (chromium)': ['frontend', 'e2e'],
  'E2E visual baselines (chromium)': ['frontend', 'e2e'],
  Build: ['frontend', 'server'],
  // Gap 1 (workflow-wiring review Finding — two reviewers, independently):
  // these two rows were missing entirely, so the coverage-parity loop below
  // never iterated them and neither leg had ANY guard against a silent
  // narrowing. Read verbatim from the real pre-derivation file (git show
  // a1e4b70e:.github/workflows/verify.yml), not inferred:
  //   OpenAPI types up to date: `openapi || frontend || shared` (line 228)
  //   Sidecar tests:            `sidecar || shared`              (line 371)
  'OpenAPI types up to date': ['openapi', 'frontend', 'shared'],
  'Sidecar tests': ['sidecar', 'shared'],
};

// Narrowings judged CORRECT. Each needs a reason — an unexplained entry here
// is how a real regression gets waved through. Assembled across two fix
// rounds (task-7-report.md "Fix round 1"/"Fix round 2"): every entry below
// was independently verified (grep/read of the actual source, not assumed)
// before being accepted, and every leftover that didn't fit an existing
// reason was surfaced for an explicit ruling rather than self-folded in.
const ACCEPTED_NARROWINGS = [
  // [step name, path, why it is right to stop running]
  [
    'PowerShell-helper tests (Pester)',
    'scripts/ci-scope.mjs',
    'Pester covers scripts/lib/*.ps1 (+ the golden-tests fixtures dir, now widened) only; an unrelated .mjs change cannot affect it',
  ],
  [
    'Server tests (fast + slow)',
    'server/tts-sidecar/main.py',
    'server TS suite mocks the sidecar; a sidecar-only diff runs pytest instead',
  ],

  // G2 blanket (frontend-infra configs: index.html, tailwind.config.ts,
  // tsconfig.json, eslint.config.mjs) -------------------------------------
  [
    'Lint',
    'index.html',
    'ESLint has no HTML target in eslint.config.mjs (verified by grep); index.html content cannot affect lint output',
  ],
  [
    'Lint',
    'tsconfig.json',
    "eslint.config.mjs uses tseslint.configs.recommended, not recommendedTypeChecked, and sets no parserOptions.project anywhere (verified by grep) -- no type-aware linting is configured, so tsconfig.json plays no role in lint's parsing or rules",
  ],
  [
    'Typecheck',
    'index.html',
    'tsc does not compile HTML; index.html is not part of any tsconfig `include`',
  ],
  [
    'Typecheck',
    'tailwind.config.ts',
    "file does not exist in this repository -- deleted when the codebase migrated to Tailwind v4's @tailwindcss/vite plugin (vite.config.ts:119-120); the live config lives in src/styles.css's @theme block, already covered by every step's src/** glob. This literal path can never appear in a real diff",
  ],
  [
    'Typecheck',
    'eslint.config.mjs',
    "eslint.config.mjs only affects `npm run lint`'s own ruleset and is already covered by lint + test:hooks (whose eslint-guardrail.test.mjs spawns real eslint against this exact file) -- no other step's output depends on it",
  ],
  [
    'Frontend tests + a11y',
    'tsconfig.json',
    'same reasoning as Lint/tsconfig.json above: no type-aware tooling in this leg reads tsconfig.json content',
  ],
  [
    'Frontend tests + a11y',
    'eslint.config.mjs',
    'same reasoning as Typecheck/eslint.config.mjs above',
  ],
  [
    'E2E (chromium)',
    'tailwind.config.ts',
    'file does not exist in this repository -- same as Typecheck/tailwind.config.ts above',
  ],
  ['E2E (chromium)', 'tsconfig.json', 'same reasoning as Lint/tsconfig.json above'],
  ['E2E (chromium)', 'eslint.config.mjs', 'same reasoning as Typecheck/eslint.config.mjs above'],
  [
    'E2E visual baselines (chromium)',
    'tailwind.config.ts',
    'file does not exist in this repository -- same as Typecheck/tailwind.config.ts above',
  ],
  [
    'E2E visual baselines (chromium)',
    'tsconfig.json',
    'same reasoning as Lint/tsconfig.json above',
  ],
  [
    'E2E visual baselines (chromium)',
    'eslint.config.mjs',
    'same reasoning as Typecheck/eslint.config.mjs above',
  ],
  [
    'Build',
    'tailwind.config.ts',
    'file does not exist in this repository -- same as Typecheck/tailwind.config.ts above; the originally-planned fix (add it to build + test:e2e:visual extraFiles) was verified wrong and dropped',
  ],
  ['Build', 'eslint.config.mjs', 'same reasoning as Typecheck/eslint.config.mjs above'],

  // G3 (openapi.yaml not compiled by typecheck/config:check/build) --------
  [
    'Typecheck',
    'openapi.yaml',
    'openapi.yaml is not compiled; the generated src/lib/api-types.ts is (already an input via the src/**/server/src/** glob), and the dedicated "OpenAPI types up to date" check catches regeneration drift, including a prose-only edit (openapi-typescript emits each schema description into api-types.ts as JSDoc)',
  ],
  [
    'Config check',
    'openapi.yaml',
    'same reasoning as Typecheck/openapi.yaml above -- config:check has nothing to do with the API contract',
  ],
  ['Build', 'openapi.yaml', 'same reasoning as Typecheck/openapi.yaml above'],

  // G4 (fixtures/repair-script inert to lint/typecheck/build) -------------
  [
    'Lint',
    'scripts/tests/fixtures/x.json',
    'fixtures are inert test data with no code-path relevance to lint output',
  ],
  [
    'Typecheck',
    'scripts/tests/fixtures/x.json',
    'fixtures are inert test data with no code-path relevance to typecheck output',
  ],
  [
    'Build',
    'scripts/tests/fixtures/x.json',
    'fixtures are inert test data with no code-path relevance to the production build',
  ],

  // Verified-unambiguous extras: same "this tool cannot parse this filetype"
  // shape as the G2 entries above, just not originally named under that group.
  [
    'Lint',
    'openapi.yaml',
    'ESLint has no YAML target in eslint.config.mjs (verified by grep); openapi.yaml content cannot affect lint output',
  ],
  [
    'Lint',
    'server/package.json',
    'ESLint has no JSON target in eslint.config.mjs (verified by grep); package.json content cannot affect lint output',
  ],
  [
    'Lint',
    'scripts/lib/log.ps1',
    "ESLint's glob (**/*.{ts,tsx,js,jsx,cjs,mjs}) excludes .ps1, and ESLint cannot parse PowerShell; only test:scripts (Pester) and test:hooks care about this extension",
  ],

  // Fix round 2 -- the five leftovers Fix round 1 explicitly declined to
  // self-accept, now ruled on by the branch owner.
  [
    'Config check',
    'server/src/tts/mp3.ts',
    'config:check validates the config registry (server/src/config/*.ts + .env.example); an arbitrary unrelated server source file cannot affect its outcome. Same shape as G4 -- an over-broad legacy bucket bundling files a narrow, purpose-built step never needed',
  ],
  [
    'Config check',
    'scripts/tests/fixtures/x.json',
    'same reasoning as Config check/server/src/tts/mp3.ts above',
  ],
  [
    'Server tests (fast + slow)',
    'scripts/tests/fixtures/x.json',
    "test:server already pins the one fixture its own tests read at runtime by exact filename (scripts/tests/fixtures/ffmpeg-version-cases.json, read by server/src/diagnostics/ffmpeg.test.ts:29); the directory's only other contents are run-golden-tests-stub-modules*, which the server suite never touches, so widening to scripts/tests/fixtures/** would add spurious re-runs of the whole server suite for golden-test stubs. KNOWN RESIDUAL BRITTLENESS, accepted not overlooked: this pin is BY FILENAME, not by directory -- a future fixture read by a NEW server test would be undeclared here and would silently stale-green until someone adds it",
  ],
  [
    'Server tests (fast + slow)',
    'server/tts-sidecar/scripts/install-qwen3.mjs',
    'server TS suite mocks the sidecar; a sidecar-only diff runs pytest instead (same reason as Server tests (fast + slow)/server/tts-sidecar/main.py above, carried verbatim to a second file in the same directory)',
  ],
  [
    'Hooks tests',
    'scripts/lib/log.ps1',
    "PowerShell library files are Pester's domain (test:scripts). Grepped scripts/run-hooks-tests.mjs and every scripts/tests/*.test.mjs for a runtime read of anything under scripts/lib/ and found none -- the one scripts/lib reference in the whole suite is a code comment, not a read",
  ],

  // LEGACY_MATCHERS repair (workflow-wiring review Finding 2) -- the `server`
  // matcher was missing the scripts/repair-cast-id-drift.mjs$ alternative
  // present in the real pre-derivation verify.yml (git show
  // a1e4b70e:.github/workflows/verify.yml), so the corpus never exercised it.
  // Adding it surfaces these four -- each a `.mjs` script inert to a
  // tool/step that never reads .mjs source at all, the same G4 shape as
  // scripts/tests/fixtures/x.json above, just for this one file.
  [
    'Typecheck',
    'scripts/repair-cast-id-drift.mjs',
    'tsc only compiles files reachable from tsconfig.json `include` (src/**, server/src/**); scripts/repair-cast-id-drift.mjs sits outside both, so its content cannot change tsc output',
  ],
  [
    'Config check',
    'scripts/repair-cast-id-drift.mjs',
    'config:check validates the config registry (server/src/config/*.ts + .env.example) -- same reasoning as Config check/server/src/tts/mp3.ts above: an arbitrary unrelated .mjs script cannot affect its outcome',
  ],
  [
    'PowerShell-helper tests (Pester)',
    'scripts/repair-cast-id-drift.mjs',
    'Pester covers scripts/lib/*.ps1 (+ the golden-tests fixtures dir) only -- same reasoning as PowerShell-helper tests (Pester)/scripts/ci-scope.mjs above: an unrelated .mjs change cannot affect it',
  ],
  [
    'Build',
    'scripts/repair-cast-id-drift.mjs',
    "vite build's entry graph is index.html -> src/**; server/src/** is compiled separately by tsc. scripts/repair-cast-id-drift.mjs is a standalone script under scripts/, outside both, so it is not bundled or compiled by `npm run build`",
  ],

  // Gap 1 (workflow-wiring review) -- adding the two missing LEGACY_GATES
  // rows above surfaces these two. `openapi:types` (package.json:73) is
  // literally `openapi-typescript ./openapi.yaml -o ./src/lib/api-types.ts`
  // -- verified by reading the script, not assumed -- a single codegen
  // invocation that reads only openapi.yaml and writes api-types.ts. It
  // never invokes tsc or eslint, so neither tsconfig.json nor
  // eslint.config.mjs can change its output; same "tool doesn't read this
  // file" shape as the G2 entries above, just for a step that predates this
  // test's LEGACY_GATES coverage.
  [
    'OpenAPI types up to date',
    'tsconfig.json',
    "openapi:types (package.json: `openapi-typescript ./openapi.yaml -o ./src/lib/api-types.ts`) never invokes tsc or reads tsconfig.json -- same reasoning as Lint/tsconfig.json above",
  ],
  [
    'OpenAPI types up to date',
    'eslint.config.mjs',
    "openapi:types (package.json: `openapi-typescript ./openapi.yaml -o ./src/lib/api-types.ts`) never invokes eslint -- same reasoning as Typecheck/eslint.config.mjs above",
  ],

  // F3 (2026-08-06 whole-branch review) -- verify-cache.mjs's `test` cache
  // step carried two dead extraFiles entries, tailwind.config.ts and
  // postcss.config.js, both leftover from a pre-Tailwind-v4 config that no
  // longer exists in this repo (see the Typecheck/tailwind.config.ts entry
  // above for the same fact, verified independently here by directory
  // listing + `git ls-files`). Removing them surfaces these two: both steps
  // key off `step_test` (this cache step's derived scope), which no longer
  // trips on a path that was never a real input to begin with.
  [
    'Frontend tests + a11y',
    'tailwind.config.ts',
    "file does not exist in this repository -- same as Typecheck/tailwind.config.ts above; this step's derived condition includes step_test, which no longer carries the dead tailwind.config.ts/postcss.config.js extraFiles entries removed from the `test` cache step (F3)",
  ],
  [
    'OpenAPI types up to date',
    'tailwind.config.ts',
    "file does not exist in this repository -- same as Typecheck/tailwind.config.ts above; openapi:types's own condition includes step_test for the same reason as the Frontend tests + a11y entry directly above, and openapi-typescript never reads tailwind.config.ts regardless",
  ],
];

const PROBE_CORPUS = [
  'src/app.tsx',
  'index.html',
  'tailwind.config.ts',
  'tsconfig.json',
  'eslint.config.mjs',
  'vite.config.ts',
  'openapi.yaml',
  'server/src/tts/mp3.ts',
  'server/package.json',
  'server/tts-sidecar/main.py',
  'e2e/smoke.spec.ts',
  'playwright.config.ts',
  'scripts/ci-scope.mjs',
  'scripts/lib/log.ps1',
  'scripts/tests/fixtures/x.json',
  '.husky/pre-commit',
  '.github/workflows/verify.yml',
  '.github/actions/setup/action.yml',
  'pinokio.js',
  'pinokio-scripts/lib/menu.js',
  'launch.mjs',
  'server/tts-sidecar/scripts/install-qwen3.mjs',
  'scripts/repair-cast-id-drift.mjs',
  'RELEASE_NOTES.md',
  'docs/release-notes-next.md',
];

test('every ACCEPTED_NARROWINGS entry carries a non-empty reason', () => {
  const blank = ACCEPTED_NARROWINGS.filter(
    ([, , reason]) => typeof reason !== 'string' || reason.trim().length === 0,
  );
  assert.deepEqual(
    blank,
    [],
    `entry(ies) with a blank/placeholder reason:\n${JSON.stringify(blank)}`,
  );
});

test('coverage parity: no derived condition silently narrows a leg', () => {
  const accepted = new Set(ACCEPTED_NARROWINGS.map(([s, p]) => `${s}\u0000${p}`));
  const regressions = [];

  for (const [stepName, legacyScopes] of Object.entries(LEGACY_GATES)) {
    // The derived condition now attached to this step, by exact step name.
    const m = source.match(
      new RegExp(
        `- name: ${stepName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\n\\s*if: ([^\\n]+)\\n`,
      ),
    );
    assert.ok(m, `no if: found for step '${stepName}' — did it get renamed?`);
    const derivedKeys = [
      ...m[1].matchAll(/fromJSON\(needs\.detect\.outputs\.scopes\)\.([A-Za-z0-9_]+)/g),
    ].map((x) => x[1]);

    for (const path of PROBE_CORPUS) {
      const ranBefore = legacyScopes.some((s) => LEGACY_MATCHERS[s].test(path));
      const scopes = computeScopes([path], { eventName: 'pull_request' });
      const runsNow = derivedKeys.some((k) => scopes[k]);
      if (ranBefore && !runsNow && !accepted.has(`${stepName}\u0000${path}`)) {
        regressions.push(`${stepName} no longer runs for ${path}`);
      }
    }
  }

  assert.deepEqual(
    regressions,
    [],
    `derivation silently narrowed coverage:\n${regressions.join('\n')}\n\n` +
      `Either widen the step's inputs in verify-cache.mjs, or add an entry to ` +
      `ACCEPTED_NARROWINGS with a reason.`,
  );
});
