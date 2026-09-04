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
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readdirSync } from 'node:fs';
import { computeScopes } from '../ci-scope.mjs';
import { readNormalized } from '../lib/read-normalized.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const workflowPath = resolve(repoRoot, '.github', 'workflows', 'verify.yml');
// readNormalized, not a bare readFileSync: several assertions below scan for
// a literal '\n' after a YAML key (e.g. 'if: ...\n'), which misses on a
// CRLF checkout (#2291).
const source = readNormalized(workflowPath);

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

test('leg-result check: needs.json is validated before processing', () => {
  const jobBlocks = [...source.matchAll(/^ {2}([a-z][a-z0-9-]*):\n((?: {4}.*\n|\n)*)/gm)];
  const aggregator = jobBlocks.find(([, name]) => name === 'verify');
  assert.ok(aggregator, 'aggregator job `verify` not found');
  const [, , body] = aggregator;

  const legCheckBody = body.slice(body.indexOf('- name: Check leg results'));
  assert.ok(
    legCheckBody,
    'no "Check leg results" step found in the verify aggregator job',
  );

  // Guard against jq failures inside command substitutions (set -e does not
  // catch those): the step must validate needs.json is parseable JSON before
  // trying to use it, and must guard the `for job in $(jq ...)` with an
  // explicit error check — not just relying on errexit inside $(...)
  // Extract just the JSON guard block (from `if ! jq` to matching `fi`) so
  // the assertion can't accidentally match an unrelated `exit 1` far below
  // (e.g. in the case statement).
  const jsonGuardStart = legCheckBody.indexOf('if ! jq -e . needs.json');
  const jsonGuardEnd = legCheckBody.indexOf('fi', jsonGuardStart);
  assert.ok(
    jsonGuardStart !== -1 && jsonGuardEnd !== -1,
    'JSON guard block not found (expected "if ! jq -e . needs.json ... fi")',
  );
  const jsonGuardBlock = legCheckBody.slice(jsonGuardStart, jsonGuardEnd + 2);

  assert.match(
    jsonGuardBlock,
    /exit\s+1/,
    'JSON guard block does not contain "exit 1" to fail closed on invalid JSON',
  );

  assert.match(
    legCheckBody,
    /job_list="\$\(jq\s+-r\s+'keys\[\]'\s+needs\.json\)"\s*\|\|\s*\{/,
    'step does not guard the jq "keys[]" call with explicit error checking (||)',
  );
});

test('leg-result check: case statement has default arm for unrecognized results', () => {
  const jobBlocks = [...source.matchAll(/^ {2}([a-z][a-z0-9-]*):\n((?: {4}.*\n|\n)*)/gm)];
  const aggregator = jobBlocks.find(([, name]) => name === 'verify');
  assert.ok(aggregator, 'aggregator job `verify` not found');
  const [, , body] = aggregator;

  const legCheckBody = body.slice(body.indexOf('- name: Check leg results'));
  assert.ok(
    legCheckBody,
    'no "Check leg results" step found in the verify aggregator job',
  );

  // The case statement must have an explicit `success) ;;` arm so unrecognized
  // results fall into the default `*)` arm, not the success path.
  assert.match(
    legCheckBody,
    /success\)\s*;;/,
    'case statement is missing explicit `success) ;;` arm',
  );

  // The case statement must have a default `*)` arm that treats unrecognized
  // results as failures — deny-list polarity (fail closed on unknown values).
  assert.match(
    legCheckBody,
    /\*\)\s+echo\s+"::warning::[^"]*\$result[^"]*"[^;]*;?\s*FAILED\+=\(/,
    'case statement is missing default `*)` arm that treats unrecognized results as failures',
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
    "impact-based, not zero-impact: Vitest transforms through esbuild, which DOES read tsconfig.json's compilerOptions (jsx, target, useDefineForClassFields) -- unlike Lint/tsconfig.json above, which is genuinely inert. But the root tsconfig declares no `paths`, and both Typecheck and Build already carry tsconfig.json as an input and would independently redden on the same PR if a compilerOptions edit actually changed this leg's output, so the narrowing costs no real coverage",
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
    'openapi:types (package.json: `openapi-typescript ./openapi.yaml -o ./src/lib/api-types.ts`) never invokes tsc or reads tsconfig.json -- same reasoning as Lint/tsconfig.json above',
  ],
  [
    'OpenAPI types up to date',
    'eslint.config.mjs',
    'openapi:types (package.json: `openapi-typescript ./openapi.yaml -o ./src/lib/api-types.ts`) never invokes eslint -- same reasoning as Typecheck/eslint.config.mjs above',
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

  // F1 (2026-08-06 whole-branch review) -- the meta-assertion below closes
  // the recurring "matcher/gate/corpus incomplete" class by requiring every
  // LEGACY_MATCHERS alternative to be exercised by PROBE_CORPUS. Widening the
  // corpus to satisfy it surfaces the following, each independently verified
  // (grep/read of the real source, not assumed) rather than reused on a
  // frequency argument.

  // Bucket 1: tsconfig.node.json and postcss.config.js are BOTH absent from
  // this repository (confirmed via `ls`/`git ls-files` -- not merely
  // untracked, genuinely not on disk), the same inert class as the
  // already-accepted tailwind.config.ts rows above. Lint is missing from
  // the postcss.config.js set because its glob (**/*.{ts,tsx,js,jsx,cjs,mjs})
  // already matches a `.js` path, so that pair isn't a narrowing at all.
  [
    'Lint',
    'tsconfig.node.json',
    'file does not exist in this repository -- confirmed absent from disk, not merely untracked. This literal path can never appear in a real diff',
  ],
  [
    'Typecheck',
    'tsconfig.node.json',
    'file does not exist in this repository -- same as Lint/tsconfig.node.json above',
  ],
  [
    'Typecheck',
    'postcss.config.js',
    'file does not exist in this repository -- same as Typecheck/tailwind.config.ts above',
  ],
  [
    'Frontend tests + a11y',
    'tsconfig.node.json',
    'file does not exist in this repository -- same as Lint/tsconfig.node.json above',
  ],
  [
    'Frontend tests + a11y',
    'postcss.config.js',
    'file does not exist in this repository -- same as Typecheck/tailwind.config.ts above',
  ],
  [
    'E2E (chromium)',
    'tsconfig.node.json',
    'file does not exist in this repository -- same as Lint/tsconfig.node.json above',
  ],
  [
    'E2E (chromium)',
    'postcss.config.js',
    'file does not exist in this repository -- same as Typecheck/tailwind.config.ts above',
  ],
  [
    'E2E visual baselines (chromium)',
    'tsconfig.node.json',
    'file does not exist in this repository -- same as Lint/tsconfig.node.json above',
  ],
  [
    'E2E visual baselines (chromium)',
    'postcss.config.js',
    'file does not exist in this repository -- same as Typecheck/tailwind.config.ts above',
  ],
  [
    'Build',
    'tsconfig.node.json',
    'file does not exist in this repository -- same as Lint/tsconfig.node.json above',
  ],
  [
    'Build',
    'postcss.config.js',
    'file does not exist in this repository -- same as Typecheck/tailwind.config.ts above',
  ],
  [
    'OpenAPI types up to date',
    'tsconfig.node.json',
    'file does not exist in this repository -- same as Lint/tsconfig.node.json above',
  ],
  [
    'OpenAPI types up to date',
    'postcss.config.js',
    'file does not exist in this repository -- same as Typecheck/tailwind.config.ts above',
  ],

  // Bucket 2: server/vitest.config(.slow).ts and server/scripts/sync-env-example.ts
  // are outside both tsconfigs' `include` -- verified by reading the files
  // directly: server/tsconfig.json's include is exactly ["src/**/*"], and the
  // root tsconfig.json's is exactly ["src", "vite.config.ts", "vitest.config.ts"]
  // (the ROOT vitest.config.ts, not server's). Neither `tsc` invocation
  // (`npm run typecheck` = `tsc --noEmit && npm --prefix server run
  // typecheck`, the latter `tsc --noEmit -p .`) compiles any of these three
  // files, and `npm run build` (`tsc -b && vite build && ...`) doesn't either
  // -- vite's entry graph is index.html -> src/**, server/src/** is compiled
  // separately by tsc -p ., and none of the three live under server/src/**.
  // Their real consumers keep running: server/vitest.config(.slow).ts is read
  // by the `test:server`/`test:server-slow` runner invocations directly
  // (already covered elsewhere), and sync-env-example.ts is executed
  // (not compiled) by `config:check` via `npx tsx`, whose own extraFiles
  // entry already covers it.
  [
    'Typecheck',
    'server/vitest.config.ts',
    'server/tsconfig.json\'s include is ["src/**/*"] and the root\'s is ["src","vite.config.ts","vitest.config.ts"] (the root vitest.config.ts, not server\'s) -- neither tsc invocation compiles this file',
  ],
  [
    'Typecheck',
    'server/vitest.config.slow.ts',
    'same reasoning as Typecheck/server/vitest.config.ts above',
  ],
  [
    'Typecheck',
    'server/scripts/sync-env-example.ts',
    "sits outside both tsconfigs' include (same reasoning as Typecheck/server/vitest.config.ts above); it is executed at runtime by `npx tsx` (config:check), never compiled by tsc",
  ],
  [
    'Build',
    'server/vitest.config.ts',
    "vite build's entry graph is index.html -> src/**; server/src/** is compiled separately by `tsc -p .`. server/vitest.config.ts sits outside both, same reasoning as Typecheck/server/vitest.config.ts above",
  ],
  [
    'Build',
    'server/vitest.config.slow.ts',
    'same reasoning as Build/server/vitest.config.ts above',
  ],
  [
    'Build',
    'server/scripts/sync-env-example.ts',
    'same reasoning as Build/server/vitest.config.ts above; also executed at runtime by config:check via `npx tsx`, never bundled or compiled',
  ],

  // Bucket 3: server/.env.example's only real reader is `config:check`
  // (`npx tsx server/scripts/sync-env-example.ts --check`, verified by
  // reading the script: it reads server/.env.example directly and imports
  // ../src/config/env-example.js) -- and Config check's own derived
  // condition already covers this path (it is not among the narrowings
  // below), so no coverage is actually lost by these four steps narrowing.
  // server/src/config/env-example.test.ts (the one server test with
  // ".env.example" in its describe block) was checked directly: it asserts
  // against renderManagedBlock()'s output, never reads server/.env.example
  // from disk.
  [
    'Lint',
    'server/.env.example',
    "server/.env.example's only real reader is config:check (verified: tsx server/scripts/sync-env-example.ts --check), which is unaffected by ESLint's ruleset and vice versa -- ESLint has no target for this file at all",
  ],
  [
    'Typecheck',
    'server/.env.example',
    "same reasoning as Lint/server/.env.example above; also not part of any tsconfig's include",
  ],
  [
    'Server tests (fast + slow)',
    'server/.env.example',
    "server/src/config/env-example.test.ts (the one server test referencing '.env.example') asserts against renderManagedBlock()'s output and never reads server/.env.example from disk (verified by reading the test) -- the real drift check is config:check, whose own derived condition already covers this path",
  ],
  [
    'Build',
    'server/.env.example',
    'same reasoning as Lint/server/.env.example above; the built bundle never embeds this file',
  ],

  // Bucket 4: reuses reasons already accepted verbatim elsewhere in this file
  // for the same "tool doesn't process this filetype" / "unrelated file
  // cannot affect this narrow step's outcome" shapes.
  [
    'Lint',
    'server/tsconfig.json',
    'ESLint has no JSON target in eslint.config.mjs (verified by grep) -- same reasoning as Lint/server/package.json above',
  ],
  [
    'Lint',
    'server/package-lock.json',
    'ESLint has no JSON target in eslint.config.mjs (verified by grep) -- same reasoning as Lint/server/package.json above',
  ],
  [
    'Config check',
    'server/tsconfig.json',
    'config:check validates .env.example against the config registry (server/src/config/*.ts) via server/scripts/sync-env-example.ts -- an arbitrary unrelated server file cannot affect its outcome, same shape as Config check/server/src/tts/mp3.ts above',
  ],
  [
    'Config check',
    'server/vitest.config.ts',
    'same reasoning as Config check/server/tsconfig.json above',
  ],
  [
    'Config check',
    'server/vitest.config.slow.ts',
    'same reasoning as Config check/server/tsconfig.json above',
  ],
  [
    'Config check',
    'server/package-lock.json',
    'config:check does not carry includeLockfiles and never reads package manifests -- same reasoning as Config check/server/tsconfig.json above, extended to the lockfile',
  ],
  [
    'PowerShell-helper tests (Pester)',
    'scripts/run-hooks-tests.mjs',
    'Pester covers scripts/lib/*.ps1 (+ the fixtures dir) only -- same reasoning as PowerShell-helper tests (Pester)/scripts/ci-scope.mjs above: an unrelated .mjs change cannot affect it',
  ],
  [
    'PowerShell-helper tests (Pester)',
    'scripts/validate-commit-msg.mjs',
    'same reasoning as PowerShell-helper tests (Pester)/scripts/run-hooks-tests.mjs above',
  ],
  [
    'PowerShell-helper tests (Pester)',
    'scripts/release-notes-gate.mjs',
    'same reasoning as PowerShell-helper tests (Pester)/scripts/run-hooks-tests.mjs above',
  ],
  [
    'PowerShell-helper tests (Pester)',
    'scripts/run-pinokio-tests.mjs',
    'same reasoning as PowerShell-helper tests (Pester)/scripts/run-hooks-tests.mjs above',
  ],
  [
    'Server tests (fast + slow)',
    'server/scripts/sync-env-example.ts',
    "grepped server/src for 'sync-env-example' and found no reference -- no server test imports this script. It is config:check's own entry point, whose derived condition already covers this path",
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

  // F1 (2026-08-06 whole-branch review) -- one representative path per
  // LEGACY_MATCHERS alternative the corpus above didn't already exercise.
  // The meta-assertion below fails closed on the next matcher that grows an
  // alternative this corpus doesn't probe.
  'tsconfig.node.json',
  'postcss.config.js',
  'server/tsconfig.json',
  'server/vitest.config.ts',
  'server/vitest.config.slow.ts',
  'server/.env.example',
  'server/scripts/sync-env-example.ts',
  'scripts/run-hooks-tests.mjs',
  'scripts/validate-commit-msg.mjs',
  'scripts/release-notes-gate.mjs',
  'docs/testing/onbox-acceptance-register.md',
  'docs/testing/onbox-acceptance-register-live-view.html',
  'scripts/run-pinokio-tests.mjs',
  'package.json',
  'package-lock.json',
  'server/package-lock.json',
];

// Splits a LEGACY_MATCHERS regex into its top-level alternatives -- the
// alternation immediately inside the anchored `^(...)` group, NOT any nested
// group inside an individual alternative (e.g. `eslint\.config\.(js|mjs)$`'s
// inner (js|mjs) stays one alternative; one corpus path covering either
// branch is enough). A matcher with no top-level group (e.g. `^scripts\/`) is
// itself a single alternative. A `|` inside a `[...]` character class is not
// a split point -- the splitter tracks bracket-expression nesting (honoring
// backslash-escapes and the regex rule that a `]` immediately after `[` or
// `[^` is a literal class member, not the closing bracket), so a class
// containing a literal `|` decomposes correctly instead of being cut
// mid-class.
//
// What this does NOT guarantee: splitting a string on `|` and rejoining the
// parts with `|` always reproduces the original source, no matter where the
// split landed -- that reassembly is an identity, not a check, so it can
// never by itself prove the split points were chosen correctly. The real
// self-checks are: (1) a top-level group that isn't a plain capturing group
// -- e.g. a non-capturing `(?:...)`, a lookaround, or a named group -- is
// rejected outright, since the mechanical split can't distinguish such a
// prefix from an ordinary alternative and would slice through it; and (2)
// every alternative the split produces must independently compile as its own
// regex, or this throws naming the matcher and the offending fragment.
// Either check can genuinely fail on a real input; a matcher whose shape
// defeats the split surfaces as this function's own named error, not as an
// incidental `new RegExp()` crash further downstream.
function maskCharacterClasses(str) {
  const inClass = new Array(str.length).fill(false);
  let open = false;
  let literalCloseIdx = -1;
  for (let i = 0; i < str.length; i++) {
    const c = str[i];
    if (c === '\\') {
      i++;
      continue;
    }
    if (!open && c === '[') {
      open = true;
      inClass[i] = true;
      literalCloseIdx = str[i + 1] === '^' ? i + 2 : i + 1;
      continue;
    }
    if (open) {
      inClass[i] = true;
      if (c === ']' && i !== literalCloseIdx) {
        open = false;
      }
    }
  }
  return inClass;
}

function topLevelAlternatives(matcherName, re) {
  const src = re.source;
  if (!src.startsWith('^')) {
    throw new Error(`LEGACY_MATCHERS.${matcherName} is not anchored at ^: ${src}`);
  }
  const body = src.slice(1);
  if (!body.startsWith('(')) {
    return [`^${body}`];
  }
  if (body[1] === '?') {
    throw new Error(
      `LEGACY_MATCHERS.${matcherName}: top-level group is not a plain capturing group ` +
        `(starts "(?" -- a non-capturing group, lookaround, or named group), which the ` +
        `mechanical splitter cannot decompose into top-level alternatives: ${src}`,
    );
  }
  const bodyClassMask = maskCharacterClasses(body);
  let depth = 0;
  let closeIdx = -1;
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c === '\\') {
      i++;
      continue;
    }
    if (bodyClassMask[i]) continue;
    if (c === '(') depth++;
    else if (c === ')') {
      depth--;
      if (depth === 0) {
        closeIdx = i;
        break;
      }
    }
  }
  if (closeIdx === -1) {
    throw new Error(`LEGACY_MATCHERS.${matcherName}: unbalanced group, cannot split: ${src}`);
  }
  const interior = body.slice(1, closeIdx);
  const suffix = body.slice(closeIdx + 1);

  const interiorClassMask = maskCharacterClasses(interior);
  const parts = [];
  let groupDepth = 0;
  let cur = '';
  for (let i = 0; i < interior.length; i++) {
    const c = interior[i];
    if (c === '\\') {
      cur += c + (interior[i + 1] ?? '');
      i++;
      continue;
    }
    if (interiorClassMask[i]) {
      cur += c;
      continue;
    }
    if (c === '(') groupDepth++;
    if (c === ')') groupDepth--;
    if (c === '|' && groupDepth === 0) {
      parts.push(cur);
      cur = '';
      continue;
    }
    cur += c;
  }
  parts.push(cur);

  const alternatives = parts.map((p) => `^${p}${suffix}`);
  for (const alt of alternatives) {
    try {
      new RegExp(alt);
    } catch (err) {
      throw new Error(
        `LEGACY_MATCHERS.${matcherName}: split produced "${alt}" (from "${src}"), which does ` +
          `not compile as its own regex -- this matcher's shape defeats the mechanical ` +
          `top-level split; restructure LEGACY_MATCHERS to carry its alternatives as data. ` +
          `(${err.message})`,
      );
    }
  }
  return alternatives;
}

test('topLevelAlternatives: rejects a non-capturing group with the designed error, not an incidental regex-compile crash', () => {
  assert.throws(
    () => topLevelAlternatives('nonCapturingProbe', /^(?:foo|bar)$/),
    (err) => {
      assert.match(err.message, /nonCapturingProbe/);
      assert.match(err.message, /not a plain capturing group/);
      assert.doesNotMatch(err.message, /Nothing to repeat/);
      return true;
    },
  );
});

test('topLevelAlternatives: a `|` inside a `[...]` character class is not a split point', () => {
  const alts = topLevelAlternatives('classProbe', /^(foo[a|b]bar$|baz$)/);
  assert.deepEqual(alts, ['^foo[a|b]bar$', '^baz$']);
  for (const alt of alts) {
    assert.doesNotThrow(() => new RegExp(alt));
  }
});

test('meta: every LEGACY_MATCHERS alternative is probed by at least one PROBE_CORPUS path', () => {
  const unprobed = [];
  for (const [name, re] of Object.entries(LEGACY_MATCHERS)) {
    // Throws (failing this test) rather than skipping if a matcher's shape
    // defeats the mechanical split -- see topLevelAlternatives' self-check.
    for (const altSource of topLevelAlternatives(name, re)) {
      const altRe = new RegExp(altSource);
      if (!PROBE_CORPUS.some((p) => altRe.test(p))) {
        unprobed.push(`${name}: ${altSource}`);
      }
    }
  }
  assert.deepEqual(
    unprobed,
    [],
    `LEGACY_MATCHERS alternative(s) with no PROBE_CORPUS path exercising them ` +
      `(the parity test below can never see a regression on these):\n${unprobed.join('\n')}`,
  );
});

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

test('ffmpeg install: timeout wrapping is present with correct bounds on all apt/dpkg commands', () => {
  const actionPath = resolve(repoRoot, '.github', 'actions', 'install-ffmpeg', 'action.yml');
  const actionSource = readNormalized(actionPath);

  // Mutation proof: a deliberately-hung install was caught by the 180s timeout
  // wrapper (PR #2796 mutations). Assert all three apt/dpkg calls carry the
  // timeout, so a future edit can't drop it without this test failing.
  const patterns = [
    /sudo\s+timeout\s+-k\s+10\s+180\s+dpkg\s+-i/,
    /sudo\s+timeout\s+-k\s+10\s+180\s+apt-get\s+-o\s+Acquire::Retries=3\s+update/,
    /sudo\s+timeout\s+-k\s+10\s+180\s+apt-get\s+-o\s+Dir::Cache::Archives/,
  ];

  const missing = [];
  for (const [idx, pattern] of patterns.entries()) {
    if (!pattern.test(actionSource)) {
      missing.push(`pattern ${idx}: ${pattern.source}`);
    }
  }

  assert.deepEqual(
    missing,
    [],
    `ffmpeg install action is missing timeout wrapping or has wrong bounds:\n${missing.join('\n')}`,
  );
});

test('lockfile-touched polarity: both frontend and server test steps force full run when lockfile is changed (#2853)', () => {
  // Mutation proof: a lockfile-only diff can select ZERO tests via `--changed`,
  // so both steps must force a full run when LOCKFILE_TOUCHED is true.
  // This test verifies the exact polarity: when LOCKFILE_TOUCHED != "true",
  // run with --changed; when true (or BASE unset), run full suite.
  // Reverting to the pre-fix condition (removing LOCKFILE_TOUCHED guard or
  // inverting the polarity) makes this test fail.

  // Find both test steps by their exact names.
  const frontendMatch = source.match(
    /- name: Frontend tests \+ a11y\n\s*if:[^\n]+\n\s*run: \|\n((?:\s{10}[^\n]*\n)*)/,
  );
  const serverMatch = source.match(
    /- name: Server tests \(fast \+ slow\)\n\s*if:[^\n]+\n\s*run: \|\n((?:\s{10}[^\n]*\n)*)/,
  );

  assert.ok(frontendMatch, 'Frontend tests + a11y step not found');
  assert.ok(serverMatch, 'Server tests (fast + slow) step not found');

  const frontendBody = frontendMatch[1];
  const serverBody = serverMatch[1];

  // Both steps must assign LOCKFILE_TOUCHED from the scopes output.
  assert.match(
    frontendBody,
    /LOCKFILE_TOUCHED="\$\{\{\s*fromJSON\(needs\.detect\.outputs\.scopes\)\.lockfile_touched\s*\}\}"/,
    'Frontend step does not assign LOCKFILE_TOUCHED from detect scopes',
  );
  assert.match(
    serverBody,
    /LOCKFILE_TOUCHED="\$\{\{\s*fromJSON\(needs\.detect\.outputs\.scopes\)\.lockfile_touched\s*\}\}"/,
    'Server step does not assign LOCKFILE_TOUCHED from detect scopes',
  );

  // Both steps must have the correct polarity: when LOCKFILE_TOUCHED != "true",
  // use --changed; otherwise use full run. The `if` condition checks:
  // [ -n "$BASE" ] && [ "$LOCKFILE_TOUCHED" != "true" ]
  // If this is true, run --changed; else run full.
  const correctFrontendPattern = /if\s+\[\s*-n\s+"\$BASE"\s*\]\s+&&\s+\[\s*"\$LOCKFILE_TOUCHED"\s+!=\s+"true"\s*\]\s*;\s+then\s+npx\s+vitest\s+run\s+--changed/;
  const correctServerPattern = /if\s+\[\s*-n\s+"\$BASE"\s*\]\s+&&\s+\[\s*"\$LOCKFILE_TOUCHED"\s+!=\s+"true"\s*\]\s*;\s+then/;

  assert.match(
    frontendBody,
    correctFrontendPattern,
    'Frontend step does not have correct LOCKFILE_TOUCHED polarity (should check != "true" for --changed branch)',
  );
  assert.match(
    serverBody,
    correctServerPattern,
    'Server step does not have correct LOCKFILE_TOUCHED polarity (should check != "true" for --changed branch)',
  );

  // Verify the else branch runs the full suite (no --changed).
  assert.match(
    frontendBody,
    /else\s+npx\s+vitest\s+run;/,
    'Frontend step else branch does not run full vitest suite',
  );
  assert.match(
    serverBody,
    /else\s+npx\s+vitest\s+run/,
    'Server step else branch does not run full vitest suite',
  );
});

test('ffmpeg install: no bare apt-get install ffmpeg in workflows (use install-ffmpeg action)', () => {
  // Issue #2449: unretried `sudo apt-get update && sudo apt-get install -y ffmpeg`
  // hangs on mirror timeouts and burns entire job timeouts. This regression test
  // ensures all workflows use the new cached, retried, timeout-bounded
  // install-ffmpeg composite action instead of the bare pattern.
  const workflowDir = resolve(repoRoot, '.github', 'workflows');
  const workflows = readdirSync(workflowDir).filter((f) => f.endsWith('.yml'));

  const bareInstalls = [];
  for (const workflowFile of workflows) {
    const workflowPath = resolve(workflowDir, workflowFile);
    const workflowSource = readNormalized(workflowPath);
    // Catch all forms of the bare ffmpeg-apt-get pattern: single-line with && or ;,
    // or multi-line run blocks containing apt-get update and apt-get install with ffmpeg.
    // This catches the #2449 hang pattern in all its forms.

    // Extract each step (indented at 6 spaces: "      - name: ...").
    // Each step's body continues with 8+ spaces until the next step or end.
    const steps = [...workflowSource.matchAll(/^ {6}- name: ([^\n]+)\n((?: {8}[^\n]*\n)*)/gm)];

    for (const [, , stepBody] of steps) {
      // Skip if this is the approved install-ffmpeg action
      if (/uses:\s*\.\/\.github\/actions\/install-ffmpeg/.test(stepBody)) {
        continue;
      }

      // Check if this step contains the bare pattern: apt-get update, apt-get install, and ffmpeg
      // This catches: single-line with && or ;, multi-line run blocks, and other variants
      if (/apt-get\s+update/.test(stepBody) && /apt-get\s+install/.test(stepBody) && /ffmpeg/.test(stepBody)) {
        bareInstalls.push(workflowFile);
        break;
      }
    }
  }

  assert.deepEqual(
    bareInstalls,
    [],
    `workflow(s) still contain bare \`sudo apt-get update && sudo apt-get install -y ffmpeg\` pattern. ` +
      `Replace with \`uses: ./.github/actions/install-ffmpeg\` to ensure caching, retries, and hang timeout:\n${bareInstalls.join('\n')}`,
  );
});

test('leg-result check: cancelled/failed/skipped bucketing is present and all three are checked on exit', () => {
  const jobBlocks = [...source.matchAll(/^ {2}([a-z][a-z0-9-]*):\n((?: {4}.*\n|\n)*)/gm)];
  const aggregator = jobBlocks.find(([, name]) => name === 'verify');
  assert.ok(aggregator, 'aggregator job `verify` not found');
  const [, , body] = aggregator;

  const legCheckBody = body.slice(body.indexOf('- name: Check leg results'));
  assert.ok(
    legCheckBody,
    'no "Check leg results" step found in the verify aggregator job',
  );

  // Mutation proof 1: the base `timeout 180` mechanism (SIGTERM at 180s) was
  // verified to fire via a manually-hung mutation test branch (described in PR
  // #2796's body). The source-regex test above verifies the `-k 10` (SIGKILL at
  // 10s grace-period end) flag's *presence* in the code by pattern match, but no
  // live CI run has yet verified the SIGKILL signal actually fires — that would
  // require another expensive hang-simulation branch. This assertion guards
  // against accidental removal of either the timeout or the -k flag.
  // Mutation proof 2: GitHub-cancelled jobs are bucketed distinctly from
  // FAILED/SKIPPED by separate case arms. Assert all three case arms exist so
  // the bucketing logic can't accidentally collapse them.
  const casesPresent = [
    /cancelled\)\s+CANCELLED\+=\(/,
    /failure\)\s+FAILED\+=\(/,
    /skipped\)\s+SKIPPED\+=\(/,
  ];

  const missingCases = [];
  for (const [idx, pattern] of casesPresent.entries()) {
    if (!pattern.test(legCheckBody)) {
      missingCases.push(`case ${idx}: ${pattern.source}`);
    }
  }

  assert.deepEqual(
    missingCases,
    [],
    `leg-result check is missing case arm(s) for bucketing:\n${missingCases.join('\n')}`,
  );

  // The final exit condition must gate on ALL THREE arrays, not a subset.
  // A future edit that drops one of the three (e.g. stops checking CANCELLED)
  // would fail this assertion.
  assert.match(
    legCheckBody,
    /if\s*\[\s*"\$\{#CANCELLED\[@\]\}"\s+-gt\s+0\s*\]\s+\|\|\s+\[\s*"\$\{#FAILED\[@\]\}"\s+-gt\s+0\s*\]\s+\|\|\s+\[\s*"\$\{#SKIPPED\[@\]\}"\s+-gt\s+0\s*\]/,
    'exit condition does not check all three arrays (CANCELLED, FAILED, SKIPPED)',
  );
});
