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
import { readdirSync, readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
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

// Legs are tagged explicitly rather than found by "first step whose if:
// mentions this key". That heuristic is wrong twice over: setup steps
// PRECEDE their leg in every job, so first-match returns another setup
// step; and slugs nest (step_test is a substring of step_test_hooks /
// step_test_e2e; step_test_server of step_test_server_slow), so a
// substring match binds the wrong leg entirely.
//
// The marker grammar is deliberately narrow -- lowercase letters, digits,
// `:` and `-`. A marker outside it (e.g. the ` (Windows)` suffix the first
// draft of the windows-tests job used) parses as NOTHING, silently, which
// is how both Windows leg steps came to sit outside every guard in this
// file while a `legs.size >= N` floor still passed on the Ubuntu markers
// alone (#3053 review). A leg that must exist therefore belongs in
// REQUIRED_LEGS below, not behind a count.
const parseLegs = (src) =>
  new Map(
    [...src.matchAll(/# leg: ([a-z:0-9-]+)\n\s*- name: [^\n]+\n\s*if: ([^\n]+)\n/g)].map(
      ([, leg, condition]) => [leg, condition.trim()],
    ),
  );

// Leg identifier -> the scope keys its `if:` must depend on, order-independent
// (scopeKeysOf's `|`-joined sorted form). Named, not counted: a count cannot
// see a leg whose marker stopped parsing, and cannot see a leg whose gate was
// widened or narrowed either.
//
// The two Windows legs are their OWN entries rather than aliases of the
// Ubuntu ones, because the jobs genuinely differ: Ubuntu's `test:server` runs
// the fast AND slow suites (hence step_test_server_slow), while the Windows
// job runs `npm run test:server`, which excludes the slow files -- so a PR
// touching only a slow test file must not start a Windows leg that cannot
// execute it. Ubuntu's `test` additionally carries step_test_e2e; Windows
// runs no e2e.
const REQUIRED_LEGS = {
  test: 'shared|step_test|step_test_e2e',
  'test:server': 'shared|step_test_server|step_test_server_slow',
  'test:server:ffmpeg-floor': 'shared|step_test_server|step_test_server_slow',
  'test:windows': 'shared|step_test',
  'test:server:windows': 'shared|step_test_server',
  'test:hooks:windows': 'shared|step_test_hooks',
  'check:onbox-register': 'shared|step_check_onbox_register',
};

test('every required leg is present and gated on exactly its own scope keys', () => {
  const legs = parseLegs(source);
  const problems = [];
  for (const [leg, expectedKeys] of Object.entries(REQUIRED_LEGS)) {
    const condition = legs.get(leg);
    if (condition === undefined) {
      problems.push(
        `'# leg: ${leg}' is absent or unparseable (markers found: ${[...legs.keys()].join(', ')})`,
      );
      continue;
    }
    const actual = scopeKeysOf(condition);
    if (actual !== expectedKeys) {
      problems.push(
        `# leg: ${leg}\n  has keys:      ${actual || '(none)'}\n  expected keys: ${expectedKeys}`,
      );
    }
  }
  assert.deepEqual(
    problems,
    [],
    `required leg marker(s) missing or re-gated:\n${problems.join('\n')}`,
  );
});

// The structural half of the same finding (#3053 review pass 2, N3).
// REQUIRED_LEGS above names five legs; a NAMED list cannot see a sixth one
// arriving unmarked, and neither can the `legs.size >= 11` floor below --
// measured headroom at the time was 19 markers against a floor of 11, i.e.
// 8 legs could go unparseable with every assertion in this file still
// green. That is exactly how this PR's own first draft shipped two Windows
// steps outside every guard here.
//
// So assert the INVARIANT rather than a list: every step whose `if:`
// references the derived scopes is immediately preceded by its `- name:`
// line and, above that, a marker inside the parseable grammar. 29 such
// steps today, 0 exceptions. A new leg with no marker, or with a marker
// outside the grammar (the ` (Windows)` suffix, an uppercase letter, a
// trailing comment), fails HERE, whether or not anyone remembers to add it
// to REQUIRED_LEGS.
const MARKER_LINE = /^\s*# (?:leg|supports): [a-z:0-9-]+\s*$/;

// An `if:` is YAML, not a line, and two valid Actions spellings put a derived
// condition where a line regex cannot see it -- both mutation-verified as
// ACCEPTED by the regex this replaces, i.e. a new leg written either way
// carried no marker and nothing in this file noticed (#3053 review pass 3,
// P4): a folded block scalar (`if: >-`, with the condition on the lines
// below, which is what an author reaches for once a condition passes ~110
// characters -- every existing one already does), and
// `fromJSON( needs.detect.outputs.scopes )` with spaces inside the call.
//
// So key on the condition's MEANING rather than its formatting: fold a block
// scalar back onto one line, then remove all whitespace. Widening the regex
// instead would only move the next spelling one step away. The `if:` key's
// own line index is carried through, because the marker check reads the two
// lines above it.
const ifConditions = (src) => {
  const yamlLines = src.split('\n');
  const out = [];
  yamlLines.forEach((line, i) => {
    const m = /^(\s*)if:[ \t]*(.*?)\s*$/.exec(line);
    if (!m) return;
    const [, indent, inline] = m;
    let text = inline;
    // A block scalar header (|, >, with an optional chomping/indent
    // indicator) carries no condition of its own -- gather the more-indented
    // lines that follow it.
    if (inline === '' || /^[|>][-+]?\d*$/.test(inline)) {
      text = '';
      for (let j = i + 1; j < yamlLines.length; j += 1) {
        if (yamlLines[j].trim() === '') continue;
        if (/^\s*/.exec(yamlLines[j])[0].length <= indent.length) break;
        text += ` ${yamlLines[j].trim()}`;
      }
    }
    out.push({ line: i, text: text.replace(/\s+/g, '') });
  });
  return out;
};

// A named function rather than an inlined loop so the synthetic fixture
// below can run the SAME scan the real workflow gets -- a guard whose blind
// spots are only ever exercised against a file that happens not to contain
// them is not a guard.
const scanDerivedSteps = (src, path) => {
  const yamlLines = src.split('\n');
  const derived = [];
  const unmarked = [];
  for (const { line: i, text } of ifConditions(src)) {
    if (!text.includes('fromJSON(needs.detect.outputs.scopes)')) continue;
    derived.push(i);
    const nameLine = yamlLines[i - 1] ?? '';
    const markerLine = yamlLines[i - 2] ?? '';
    if (!/^\s*- name: /.test(nameLine) || !MARKER_LINE.test(markerLine)) {
      unmarked.push(
        `${path}:${i + 1}\n  step:   ${nameLine.trim() || '(no `- name:` directly above the if:)'}\n  marker: ${markerLine.trim() || '(none)'}`,
      );
    }
  }
  return { derived, unmarked };
};

test('every derived step carries a parseable # leg:/# supports: marker', () => {
  const { derived, unmarked } = scanDerivedSteps(source, workflowPath);

  // Anti-vacuity: a scan that finds no derived steps at all would report
  // "every one is marked" while proving nothing.
  assert.ok(
    derived.length >= 25,
    `expected >= 25 derived step conditions, found ${derived.length} — the scan broke or the workflow lost its legs`,
  );
  assert.deepEqual(
    unmarked,
    [],
    `derived step(s) with no parseable '# leg:'/'# supports:' marker — they sit outside every guard in this file:\n${unmarked.join('\n')}`,
  );
});

// The scan above runs against a file that (correctly) contains none of the
// spellings it used to miss, so it cannot prove it would catch them. This
// feeds it a synthetic job carrying one properly-marked leg and two UNMARKED
// ones written the two ways a line regex could not see: spaces inside the
// fromJSON call, and a folded block scalar. Both are valid Actions YAML;
// before the normalisation above, both were accepted silently (#3053 review
// pass 3, P4).
const SYNTHETIC_JOB = [
  'jobs:',
  '  windows-tests:',
  '    steps:',
  '      # leg: test:windows',
  '      - name: Marked leg',
  '        if: ${{ fromJSON(needs.detect.outputs.scopes).step_test || fromJSON(needs.detect.outputs.scopes).shared }}',
  '        run: npm run test',
  '      - name: Spaces inside fromJSON, no marker',
  '        if: ${{ fromJSON( needs.detect.outputs.scopes ).step_test_e2e }}',
  '        run: npm run test:e2e',
  '      - name: Folded block scalar, no marker',
  '        if: >-',
  '          fromJSON(needs.detect.outputs.scopes).step_test_e2e ||',
  '          fromJSON(needs.detect.outputs.scopes).shared',
  '        run: npm run test:e2e',
].join('\n');

test('the derived-step scan reads an `if:` by meaning, not by formatting', () => {
  const { derived, unmarked } = scanDerivedSteps(SYNTHETIC_JOB, 'synthetic.yml');
  assert.equal(
    derived.length,
    3,
    `expected all three derived conditions to be seen, saw ${derived.length}`,
  );
  const flagged = unmarked.join("\n");
  assert.match(flagged, /Spaces inside fromJSON, no marker/);
  assert.match(flagged, /Folded block scalar, no marker/);
  // ... and the properly-marked leg is not flagged, so the scan is
  // discriminating rather than merely noisy.
  assert.doesNotMatch(flagged, /Marked leg/);
  assert.equal(unmarked.length, 2, flagged);
});

test('setup steps depend on the same scope keys as the leg they support', () => {
  const legs = parseLegs(source);
  const setups = [
    ...source.matchAll(/# supports: ([a-z:0-9-]+)\n\s*- name: ([^\n]+)\n\s*if: ([^\n]+)\n/g),
  ];

  // 9 setup steps (3x Install ffmpeg, 2x Cache Playwright, 2x Install
  // Playwright, plus Setup Python + Bootstrap sidecar venv for test:sidecar);
  // 13 legs (the full checklist of named leg steps, including "openapi:types"
  // and "test:sidecar" which have no LEGACY_GATES entry below but still carry
  // markers for documentation/binding purposes). These floors catch wholesale
  // deletion only -- REQUIRED_LEGS above is what catches a single leg going
  // missing or unparseable.
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

const FFMPEG_STATIC_URL =
  'https://github.com/BtbN/FFmpeg-Builds/releases/download/autobuild-2026-10-31-12-59/ffmpeg-n8.1.3-27-g8dca1586f4-linux64-gpl-8.1.tar.xz';
const FFMPEG_STATIC_SHA256 = '41e9c565594c390622cf968d82fa4135d9e9a11d06c1515644288cbc844e3380';

function readFfmpegAction() {
  return readNormalized(resolve(repoRoot, '.github', 'actions', 'install-ffmpeg', 'action.yml'));
}

// The shell body of the `Install ffmpeg` step only (comments in the header
// may legitimately mention apt; the step's executable text must not).
function ffmpegInstallRunBody() {
  const m = readFfmpegAction().match(/- name: Install ffmpeg\n\s+shell: bash\n\s+run: \|\n((?: {8}[^\n]*\n|\n)*)/);
  assert.ok(m, '`Install ffmpeg` run step not found in install-ffmpeg action');
  return m[1];
}

test('ffmpeg install (#4453): cache miss downloads the pinned static build, verified by SHA-256', () => {
  const body = ffmpegInstallRunBody();
  assert.ok(body.includes(FFMPEG_STATIC_URL), `pinned URL ${FFMPEG_STATIC_URL} missing from install step`);
  assert.ok(body.includes(FFMPEG_STATIC_SHA256), 'pinned SHA-256 missing from install step');
  assert.match(body, /sha256sum\s+-c\b/, 'install step does not verify the download with `sha256sum -c`');
  // The checksum must GATE the install: it sits inside the `if` condition and
  // nothing (`|| true`, ...) may swallow its exit status.
  const sumLine = body.split('\n').find((l) => /sha256sum\s+-c\b/.test(l));
  assert.ok(sumLine, 'no line runs `sha256sum -c`');
  assert.match(sumLine.trimEnd(), /sha256sum\s+-c\s+-;\s*then$/, '`sha256sum -c` is not the last command of the `if` condition');
  assert.doesNotMatch(sumLine, /\|\|/, '`sha256sum -c` status is neutered by `||`');
  // set -e must be on so a checksum mismatch aborts the step (no fallback).
  assert.match(body, /set -euo pipefail/, 'install step lost `set -euo pipefail`; a checksum mismatch would not fail loudly');
  // Both binaries must reach PATH: server/src/export/* shells out to ffprobe too.
  assert.match(body, /ffprobe/, 'install step does not install ffprobe');
  assert.match(body, /GITHUB_PATH/, 'install step does not put ffmpeg on PATH for later steps');
});

// BtbN/FFmpeg-Builds keeps the last build of each month for two years (its
// README), then deletes it, and the release is not immutable. Go red at 18
// months so there is ~6 months of slack to re-pin before the URL 404s and
// every cache-miss job fails `Install ffmpeg`.
const FFMPEG_PIN_MAX_AGE_MONTHS = 18;

// Returns a failure message when the `autobuild-YYYY-MM-DD` tag in `url` is
// more than FFMPEG_PIN_MAX_AGE_MONTHS before `now`, else null.
function ffmpegPinTooOld(url, now) {
  const m = url.match(/\/autobuild-(\d{4})-(\d{2})-(\d{2})-/);
  if (!m) return `no autobuild-YYYY-MM-DD tag found in ${url}`;
  const pinned = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  const limit = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - FFMPEG_PIN_MAX_AGE_MONTHS, now.getUTCDate()));
  if (pinned >= limit) return null;
  return (
    `pinned ffmpeg build ${m[1]}-${m[2]}-${m[3]} is over ${FFMPEG_PIN_MAX_AGE_MONTHS} months old; BtbN deletes ` +
    `month-end builds after two years, which would 404 the download. Re-pin to a newer month-end ` +
    `autobuild (URL, SHA-256, its prefix in the cache key, test constants) in .github/actions/install-ffmpeg/action.yml.`
  );
}

test('ffmpeg install (#4453): the pinned BtbN build is not near its two-year deletion', () => {
  const url = ffmpegInstallRunBody().match(/https:\/\/github\.com\/BtbN\/[^\s\u0022\\]+/);
  assert.ok(url, 'BtbN download URL not found in install step');
  assert.equal(ffmpegPinTooOld(url[0], new Date()), null);
  // BtbN keeps only the last 14 daily builds; only month-end builds are kept for two years.
  const d = url[0].match(/\/autobuild-(\d{4})-(\d{2})-(\d{2})-/);
  const lastDay = new Date(Date.UTC(Number(d[1]), Number(d[2]), 0)).getUTCDate();
  assert.equal(Number(d[3]), lastDay, `pinned tag ${d[0]} is not a month-end build; a daily build 404s within weeks`);
});

test('ffmpeg install (#4453): the pin-age guard flags an old pin and passes a fresh one', () => {
  const tag = (d) => `https://github.com/BtbN/FFmpeg-Builds/releases/download/autobuild-${d}-12-59/x.tar.xz`;
  const now = new Date(Date.UTC(2026, 10, 19));
  assert.match(ffmpegPinTooOld(tag('2024-01-31'), now), /over 18 months old.*action\.yml/);
  assert.equal(ffmpegPinTooOld(tag('2026-10-31'), now), null);
  assert.match(ffmpegPinTooOld('https://example.com/x.tar.xz', now), /no autobuild/);
  // threshold boundary for a 2026-10-31 pin: 18 months on, fires from 2028-05-01
  assert.equal(ffmpegPinTooOld(tag('2026-10-31'), new Date(Date.UTC(2028, 3, 30))), null);
  assert.match(ffmpegPinTooOld(tag('2026-10-31'), new Date(Date.UTC(2028, 4, 1))), /over 18 months old/);
});

test('ffmpeg install (#4453): the apt path (the #2449 hang) no longer runs on a cache miss', () => {
  const body = ffmpegInstallRunBody();
  assert.doesNotMatch(body, /apt-get/, 'install step still invokes apt-get');
  assert.doesNotMatch(body, /dpkg/, 'install step still invokes dpkg');
  const nonComment = readFfmpegAction().split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
  assert.doesNotMatch(nonComment, /apt-cache|apt-get|dpkg/, 'action still caches/installs apt packages');
});

test('ffmpeg install (#4453): the download is bounded by a timeout and retried', () => {
  const body = ffmpegInstallRunBody();
  assert.match(body, /timeout\s+-k\s+10\s+150\s+curl\b/, 'download is not wrapped in `timeout -k 10 150`');
  assert.match(body, /for attempt in 1 2 3/, 'download/verify lost its 3-attempt retry loop');
  assert.match(body, /"\$OK" != "1"/, 'install step does not fail after the retries are exhausted');
  assert.match(body, /--max-time\s+120\b/, 'curl lost --max-time 120');
});

test('ffmpeg install (#4453): cache key does not churn with the runner image', () => {
  const src = readFfmpegAction();
  const key = src.match(/key:\s*([^\n]+)/);
  assert.ok(key, 'cache key not found');
  assert.doesNotMatch(key[1], /ImageVersion|ImageOS|steps\.image/, `cache key churns with the runner image: ${key[1]}`);
  // Tied to the artifact, not a hand-kept label: a bump of URL + SHA that
  // left the key behind would serve the old binary from cache.
  assert.ok(
    key[1].includes(FFMPEG_STATIC_SHA256.slice(0, 12)),
    `cache key does not carry the pinned archive's SHA-256 prefix (${FFMPEG_STATIC_SHA256.slice(0, 12)}): ${key[1]}`,
  );
});

test('lockfile-touched polarity: both frontend and server test steps force full run when lockfile is changed (#2853)', () => {
  // Mutation proof: a lockfile-only diff can select ZERO tests via `--changed`,
  // so both steps must force a full run when LOCKFILE_TOUCHED is true.
  // This test verifies the exact polarity: when LOCKFILE_TOUCHED != "true",
  // run with --changed; when true (or BASE unset), run full suite.
  // Reverting to the pre-fix condition (removing LOCKFILE_TOUCHED guard or
  // inverting the polarity) makes this test fail. Order-guard ensures the
  // LOCKFILE_TOUCHED assignment precedes the if condition that consumes it.

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

  // Order guard: the LOCKFILE_TOUCHED assignment must come BEFORE the if
  // statement that consumes it. Moving the assignment after the if would
  // use an unset/stale variable and restore the #2853 bug.
  const frontendAssignIdx = frontendBody.indexOf('LOCKFILE_TOUCHED=');
  const frontendIfIdx = frontendBody.indexOf('[ "$LOCKFILE_TOUCHED"');
  assert.ok(
    frontendAssignIdx !== -1,
    'Frontend step: LOCKFILE_TOUCHED assignment not found',
  );
  assert.ok(
    frontendIfIdx !== -1,
    'Frontend step: if condition checking LOCKFILE_TOUCHED not found',
  );
  assert.ok(
    frontendAssignIdx < frontendIfIdx,
    `Frontend step: LOCKFILE_TOUCHED assignment (at ${frontendAssignIdx}) must precede if condition (at ${frontendIfIdx})`,
  );

  const serverAssignIdx = serverBody.indexOf('LOCKFILE_TOUCHED=');
  const serverIfIdx = serverBody.indexOf('[ "$LOCKFILE_TOUCHED"');
  assert.ok(
    serverAssignIdx !== -1,
    'Server step: LOCKFILE_TOUCHED assignment not found',
  );
  assert.ok(
    serverIfIdx !== -1,
    'Server step: if condition checking LOCKFILE_TOUCHED not found',
  );
  assert.ok(
    serverAssignIdx < serverIfIdx,
    `Server step: LOCKFILE_TOUCHED assignment (at ${serverAssignIdx}) must precede if condition (at ${serverIfIdx})`,
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

  // For the server step, we need a more structural check because it has
  // multiple lines in both then and else branches. Extract the entire
  // if/then/else/fi block and verify:
  // (1) the then branch (LOCKFILE_TOUCHED != "true") runs --changed
  // (2) the else branch (LOCKFILE_TOUCHED == "true") runs full suite
  // Mutation proof: M7 (neuter else to --changed) and M11 (swap then/else bodies)
  // must both fail this test.
  const serverIfBlock = serverBody.match(
    /if\s+\[\s*-n\s+"\$BASE"\s*\]\s+&&\s+\[\s*"\$LOCKFILE_TOUCHED"\s+!=\s+"true"\s*\]\s*;\s+then\n((?:[^\n]*\n)*?)^\s*else\n((?:[^\n]*\n)*?)^\s*fi/m,
  );
  assert.ok(
    serverIfBlock,
    'Server step: could not extract if/then/else/fi block structure',
  );

  const serverThenBranch = serverIfBlock[1];
  const serverElseBranch = serverIfBlock[2];

  // The THEN branch (when LOCKFILE_TOUCHED != "true") must contain --changed.
  assert.match(
    serverThenBranch,
    /--changed/,
    'Server step: then branch does not use --changed (should run when lockfile NOT touched)',
  );

  // The ELSE branch (when LOCKFILE_TOUCHED == "true") must NOT contain --changed.
  assert.doesNotMatch(
    serverElseBranch,
    /--changed/,
    'Server step: else branch contains --changed (should run full suite when lockfile IS touched)',
  );
});

// #4461: true only for a step that lives in verify.yml's `ffmpeg-floor` job AND
// is bounded: step-level timeout-minutes, every apt-get wrapped in
// `timeout -k 10 <N>`, and a 3-attempt retry loop.
function isBoundedFfmpegFloorAptStep(workflowSource, stepBody) {
  const job = workflowSource.match(/^ {2}ffmpeg-floor:\n((?: {4}.*\n|\n)*)/m);
  if (!job || !job[1].includes(stepBody)) return false;
  if (!/^ {8}timeout-minutes:\s*\d+\s*$/m.test(stepBody)) return false;
  const aptCmds = stepBody.match(/apt-get\s+(?:update|install)/g) ?? [];
  const wrapped = stepBody.match(/timeout -k 10 \d+ sudo apt-get\s+(?:update|install)/g) ?? [];
  if (aptCmds.length === 0 || wrapped.length !== aptCmds.length) return false;
  return /for attempt in 1 2 3/.test(stepBody);
}

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

      // #4461 exemption: verify.yml's `ffmpeg-floor` job installs the apt
      // ffmpeg (6.1.1 on ubuntu-24.04) on purpose, to test the declared floor.
      // It holds ONLY while the step is bounded (the #2449 hang guard): a
      // step-level timeout-minutes, every apt command wrapped in
      // `timeout -k 10 <N>`, and a 3-attempt retry loop.
      if (workflowFile === 'verify.yml' && isBoundedFfmpegFloorAptStep(workflowSource, stepBody)) {
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

test('register citation check: must be unconditional (no if: guard) — issue #3122', () => {
  // The register-citation checker scans the WHOLE tree for citations, so no
  // diff-scope reliably predicts whether one broke. The step MUST run on every
  // PR (including docs-only), unconditionally. A future PR that "helpfully"
  // adds `if: fromJSON(needs.detect.outputs.scopes).something || ...` to this
  // step would silently reopen #3122 (broken register citation outside test:hooks'
  // scope never caught by CI). This test goes RED if that happens.
  //
  // Mutation-robust guard: extracts the step's YAML block by indentation
  // (not by a literal substring search), then asserts:
  // 1. The step exists and its name is found
  // 2. The step contains NO `if:` line at any indentation > the step's own
  // 3. The step contains the EXACT `run: npm run check:register-citations` command
  //
  // Scenarios caught: script rename (step not found → throws), `if:` added
  // before or after `run:`, folded block scalar `if: >-`, reindentation,
  // `run: "true"` (command neutered).

  const yamlLines = source.split('\n');
  let stepStartIdx = -1;
  let stepIndent = -1;

  // Find the step by its "- name: Register citation check" line
  for (let i = 0; i < yamlLines.length; i += 1) {
    if (/^\s*- name: Register citation check\s*$/.test(yamlLines[i])) {
      stepStartIdx = i;
      const m = /^(\s*)/.exec(yamlLines[i]);
      stepIndent = m[1].length;
      break;
    }
  }

  assert.ok(
    stepStartIdx >= 0,
    'Register citation check step (- name: Register citation check) not found in workflow',
  );

  // Extract the step's YAML block: all lines from stepStartIdx until we hit
  // a line at equal or lesser indentation (next sibling step or job).
  const stepLines = [yamlLines[stepStartIdx]];
  for (let i = stepStartIdx + 1; i < yamlLines.length; i += 1) {
    const line = yamlLines[i];
    const lineIndent = /^(\s*)/.exec(line)[1].length;

    // Empty lines belong to the step
    if (line.trim() === '') {
      stepLines.push(line);
      continue;
    }

    // Stop when indentation returns to the step's level or less
    if (lineIndent <= stepIndent) {
      break;
    }

    // More indented: part of this step
    stepLines.push(line);
  }

  const stepBlock = stepLines.join('\n');

  // Assertion 1: Step must NOT contain any `if:` at any indentation.
  // Standalone regex check (not using the shared ifConditions helper, which handles
  // block scalars; this step is simple enough that a direct regex suffices).
  const ifMatches = stepBlock.match(/^\s*if:/m);
  assert.ok(
    !ifMatches,
    'Register citation check step must be unconditional (must have no `if:` guard). ' +
      'This step scans the whole tree for citations (#3122), so no diff-scope can ' +
      'reliably predict coverage. It must run on every PR, including docs-only.',
  );

  // Assertion 1b: Step must NOT contain `continue-on-error:` either.
  // If a future PR adds `continue-on-error: true`, the step will run but if it exits
  // 1 on a broken citation, the job continues anyway and reports success — silently
  // reopening #3122. This assertion catches that regression.
  const continueOnErrorMatches = stepBlock.match(/^\s*continue-on-error:\s*/mi);
  assert.ok(
    !continueOnErrorMatches,
    'Register citation check step must not have `continue-on-error:` set. ' +
      'If this step fails on a broken citation, the job must fail so it is caught by CI. ' +
      'Adding `continue-on-error: true` would silently reopen #3122.',
  );

  // Assertion 2: Step MUST contain the exact run command (as a complete value).
  // This ensures the step still executes the checker, not something like `run: "true"`
  // or a renamed script like `run: npm run check:register-citations-renamed`.
  const runMatch = /^\s*run:\s*npm run check:register-citations\s*$/m.test(stepBlock);
  assert.ok(
    runMatch,
    'Register citation check step must execute `npm run check:register-citations`, ' +
      'not a neutered or renamed command.',
  );
});

// ---------------------------------------------------------------------------
// ffmpeg-floor leg contract (#4461). package.json castwright.ffmpeg.minimum is
// a SUPPORT floor ("the oldest ffmpeg we test against"); the `ffmpeg-floor` job
// is what makes that true. Each test pins one property whose loss would turn
// the leg into something that no longer tests the floor.
// ---------------------------------------------------------------------------

function ffmpegFloorJob() {
  const blocks = [...source.matchAll(/^ {2}([a-z][a-z0-9-]*):\n((?: {4}.*\n|\n)*)/gm)];
  const job = blocks.find(([, name]) => name === 'ffmpeg-floor');
  assert.ok(job, '`ffmpeg-floor` job not found in verify.yml; the ffmpeg support floor is no longer tested (#4461)');
  const body = job[2];
  const steps = body
    .split(/^ {6}- name: /m)
    .slice(1)
    .map((s) => s.trimEnd());
  return { body, steps };
}

const ffmpegFloorValue = () => JSON.parse(readFileSync(resolve(repoRoot, 'package.json'), 'utf8')).castwright.ffmpeg.minimum;

test('ffmpeg floor leg (#4461): runs-on is exactly ubuntu-24.04', () => {
  const { body } = ffmpegFloorJob();
  const m = body.match(/^ {4}runs-on:\s*(.+?)\s*$/m);
  assert.ok(m, 'ffmpeg-floor has no runs-on:');
  assert.equal(
    m[1],
    'ubuntu-24.04',
    `ffmpeg-floor runs-on is \`${m[1]}\`; only ubuntu-24.04 apt ships ffmpeg 6.1.1, the floor build (ubuntu-latest drifts upward)`,
  );
});

test('ffmpeg floor leg (#4461): installs ffmpeg via apt, never the static install-ffmpeg action', () => {
  const { body } = ffmpegFloorJob();
  assert.doesNotMatch(
    body,
    /uses:\s*\.\/\.github\/actions\/install-ffmpeg(?=\s|$)/m,
    'ffmpeg-floor uses ./.github/actions/install-ffmpeg, which installs static 8.1.3 and defeats testing the floor',
  );
  assert.doesNotMatch(body, /actions\/install-ffmpeg/, 'ffmpeg-floor references an install-ffmpeg* action; the floor leg must use distro apt ffmpeg');
  assert.match(body, /apt-get install\b[^\n]*\bffmpeg\b/, 'ffmpeg-floor has no `apt-get install ... ffmpeg`; it would not run the distro 6.1.1 build');
});

test('ffmpeg floor leg (#4461): version assert reads the floor from package.json via preflight-ffmpeg, no literal', () => {
  const { steps } = ffmpegFloorJob();
  const step = steps.find((s) => /readFfmpegFloor/.test(s));
  assert.ok(step, 'no ffmpeg-floor step uses readFfmpegFloor(); the floor would be restated instead of read from package.json (invariant 1, docs/features/269)');
  assert.match(step, /scripts\/preflight-ffmpeg\.cjs/, 'version-assert step does not load scripts/preflight-ffmpeg.cjs');
  assert.match(step, /parseFfmpegVersion/, 'version-assert step does not use parseFfmpegVersion');
  assert.match(step, /isBelowFloor/, 'version-assert step does not use isBelowFloor');
  const violation = floorLiteralViolation(step, ffmpegFloorValue());
  assert.equal(violation, null, violation ?? undefined);
});

// A null floor is the documented rollback (docs/features/269, Reversibility): there is no
// literal to hunt for, and `step.includes(null)` would coerce to "null" and match the
// step's own "floor is null" text. Returns a failure message, or null when clean.
function floorLiteralViolation(step, floor) {
  if (typeof floor !== 'string' || !floor) return null;
  const major = floor.split('.')[0];
  if (step.includes(floor)) return `version-assert step hardcodes the floor "${floor}"; read it via readFfmpegFloor() so a package.json bump cannot drift`;
  if (new RegExp(`(["'\`])${major}\\1`).test(step)) return `version-assert step hardcodes the floor major "${major}" as a quoted literal; derive it from readFfmpegFloor()`;
  return null;
}

test('ffmpeg floor leg (#4461): the literal-floor check is skipped for a null floor (rollback)', () => {
  const { steps } = ffmpegFloorJob();
  const step = steps.find((s) => /readFfmpegFloor/.test(s));
  assert.ok(step.includes('null'), 'fixture assumption: the assert step mentions a null floor');
  assert.equal(floorLiteralViolation(step, null), null, 'null floor must not trip the literal check via includes(null)');
  assert.notEqual(floorLiteralViolation(`x = '6.1'`, '6.1'), null, 'a real literal must still be caught');
});

test('ffmpeg floor leg (#4461): a null floor warns and passes the assert step (documented rollback)', () => {
  const { steps } = ffmpegFloorJob();
  const step = steps.find((s) => /readFfmpegFloor/.test(s));
  const m = step.match(/node -e '\n([\s\S]*?)\n {10}'/);
  assert.ok(m, 'cannot extract the node -e script from the version-assert step');
  const dir = mkdtempSync(join(tmpdir(), 'ffmpeg-floor-null-'));
  try {
    mkdirSync(join(dir, 'scripts'));
    writeFileSync(join(dir, 'scripts', 'preflight-ffmpeg.cjs'), readFileSync(resolve(repoRoot, 'scripts', 'preflight-ffmpeg.cjs')));
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ castwright: { ffmpeg: { minimum: null } } }));
    const r = spawnSync(process.execPath, ['-e', m[1]], { cwd: dir, encoding: 'utf8', windowsHide: true });
    assert.equal(r.status, 0, `assert step failed on a null floor (exit ${r.status}): ${r.stdout}${r.stderr}`);
    assert.match(r.stdout, /^::warning::.*floor/m, `no ::warning:: on stdout: ${r.stdout}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// The red half of the contract: when ffmpeg DID install, a wrong version must exit
// non-zero. Runs the real `node -e` script with `ffmpeg` swapped for a node stub
// (a PATH stub would need a .cmd shim on Windows, which execFileSync cannot spawn).
function runFloorAssert(banner, floor) {
  const { steps } = ffmpegFloorJob();
  const step = steps.find((s) => /readFfmpegFloor/.test(s));
  const m = step.match(/node -e '\n([\s\S]*?)\n {10}'/);
  assert.ok(m, 'cannot extract the node -e script from the version-assert step');
  const call = 'execFileSync("ffmpeg", ["-version"]';
  assert.ok(m[1].includes(call), 'version-assert script no longer calls execFileSync("ffmpeg", ["-version"]); update the stub swap');
  const dir = mkdtempSync(join(tmpdir(), 'ffmpeg-floor-ver-'));
  try {
    mkdirSync(join(dir, 'scripts'));
    writeFileSync(join(dir, 'scripts', 'preflight-ffmpeg.cjs'), readFileSync(resolve(repoRoot, 'scripts', 'preflight-ffmpeg.cjs')));
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ castwright: { ffmpeg: { minimum: floor } } }));
    writeFileSync(join(dir, 'stub-ffmpeg.cjs'), `process.stdout.write(${JSON.stringify(banner)});\n`);
    const script = m[1].replace(call, 'execFileSync(process.execPath, ["stub-ffmpeg.cjs"]');
    return spawnSync(process.execPath, ['-e', script], { cwd: dir, encoding: 'utf8', windowsHide: true });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('ffmpeg floor leg (#4461): the version assert stays red on a wrong ffmpeg, green on the floor build', () => {
  const ok = runFloorAssert('ffmpeg version 6.1.1-3ubuntu5 Copyright (c) 2000-2023\n', '6.0');
  assert.equal(ok.status, 0, `floor-build ffmpeg must pass (exit ${ok.status}): ${ok.stdout}${ok.stderr}`);
  const cases = [
    ['ffmpeg version 5.1.2 Copyright (c) 2000-2022\n', /ffmpeg below floor/, 'below the floor'],
    ['ffmpeg version 7.1 Copyright (c) 2000-2024\n', /ffmpeg major differs from floor major/, 'a different major'],
    ['not an ffmpeg banner\n', /unparseable ffmpeg version/, 'an unparseable banner'],
  ];
  for (const [banner, message, what] of cases) {
    const r = runFloorAssert(banner, '6.0');
    assert.equal(typeof r.status, 'number', `assert step did not run to an exit code: ${r.error}`);
    assert.notEqual(r.status, 0, `assert step exited 0 on ffmpeg ${what}; a wrong ffmpeg would pass the floor leg green`);
    assert.match(r.stderr, message, `assert step failed for the wrong reason on ${what}: ${r.stderr}`);
  }
});

test('ffmpeg floor leg (#4461): the two suites are bare commands (no `|| true` that would swallow a red run)', () => {
  const { steps } = ffmpegFloorJob();
  const step = steps.find((s) => /npx vitest run/.test(s));
  assert.ok(step, 'ffmpeg-floor has no `npx vitest run` step');
  assert.match(step, /^\s*npx vitest run\s*$/m, 'plain `npx vitest run` has trailing text (e.g. `|| true`); a failing suite would stay green');
  assert.match(step, /^\s*npx vitest run --config vitest\.config\.slow\.ts\s*$/m, 'slow-suite `npx vitest run --config ...` has trailing text (e.g. `|| true`); a failing suite would stay green');
});

test('ffmpeg floor leg (#4461): test step runs the full fast and slow suites, never --changed', () => {
  const { steps } = ffmpegFloorJob();
  const step = steps.find((s) => /npx vitest run/.test(s));
  assert.ok(step, 'ffmpeg-floor has no `npx vitest run` step');
  assert.match(step, /npx vitest run(?!\S)(?! --config)/, 'test step lost the plain `npx vitest run` (fast suite)');
  assert.match(step, /npx vitest run --config vitest\.config\.slow\.ts/, 'test step lost `npx vitest run --config vitest.config.slow.ts` (slow suite)');
  assert.doesNotMatch(step, /--changed/, '`--changed` selects zero ffmpeg tests on most diffs, so the floor would go untested');
});

test('ffmpeg floor leg (#4461): ffmpeg-floor is in the verify aggregator needs:', () => {
  const blocks = [...source.matchAll(/^ {2}([a-z][a-z0-9-]*):\n((?: {4}.*\n|\n)*)/gm)];
  const aggregator = blocks.find(([, name]) => name === 'verify');
  assert.ok(aggregator, 'aggregator job `verify` not found');
  const needs = (aggregator[2].match(/needs:\s*\[([^\]]*)\]/) ?? [undefined, ''])[1]
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  assert.ok(needs.includes('ffmpeg-floor'), `ffmpeg-floor is not in the aggregator needs: (${needs.join(', ')}); a red floor leg would not block merge`);
});

test('ffmpeg floor leg (#4461): no job-level if: (gate at step level so docs-only PRs stay green)', () => {
  const { body } = ffmpegFloorJob();
  assert.doesNotMatch(body, /^ {4}if:/m, 'ffmpeg-floor has a job-level `if:`; a skipped job fails the aggregator on docs-only PRs. Gate its steps instead');
});

test('ffmpeg floor leg (#4461): install, then version assert, then tests', () => {
  const { steps } = ffmpegFloorJob();
  const install = steps.findIndex((s) => /apt-get install\b[^\n]*\bffmpeg\b/.test(s));
  const assertStep = steps.findIndex((s) => /readFfmpegFloor/.test(s));
  const tests = steps.findIndex((s) => /npx vitest run/.test(s));
  assert.ok(install >= 0 && assertStep >= 0 && tests >= 0, `ffmpeg-floor is missing a step (install=${install}, assert=${assertStep}, tests=${tests})`);
  assert.ok(install < assertStep, 'version-assert step runs before the ffmpeg install step; it would assert against the wrong binary');
  assert.ok(assertStep < tests, 'version-assert step runs after the test step; a wrong ffmpeg would be discovered only after the tests ran on it');
});

// ---------------------------------------------------------------------------
// ffmpeg-floor apt-stall contract (#4461, operator decision on PR #4490). The
// leg stays REQUIRED, but an apt infrastructure stall (mirror down) must not
// turn `npm run verify` red on a PR that changed nothing about ffmpeg: the
// install step warns, records the gap, and gates the version assert and both
// suites on a step OUTPUT. A version-assert or test failure when ffmpeg DID
// install stays red. Never `continue-on-error`: that would also swallow those.
// ---------------------------------------------------------------------------

const FFMPEG_FLOOR_WARNING =
  '::warning::ffmpeg-floor: apt install of ffmpeg failed (mirror stall?); floor NOT tested on this run';

function ffmpegFloorInstallStep() {
  const { steps } = ffmpegFloorJob();
  const step = steps.find((s) => /apt-get install\b[^\n]*\bffmpeg\b/.test(s));
  assert.ok(step, 'ffmpeg-floor has no apt install step');
  return step;
}

test('ffmpeg floor leg (#4461): apt failure warns and skips the suites instead of failing', () => {
  const { body, steps } = ffmpegFloorJob();
  const install = ffmpegFloorInstallStep();
  const id = (install.match(/^ {8}id:\s*(\S+)\s*$/m) ?? [])[1];
  assert.ok(id, 'install step has no `id:`; later steps cannot gate on its output');
  assert.ok(install.includes(FFMPEG_FLOOR_WARNING), 'install step lost the exact ::warning:: line for an apt stall');
  assert.match(install, /GITHUB_STEP_SUMMARY/, 'install step does not write the warning to $GITHUB_STEP_SUMMARY');
  assert.match(install, /installed=true[^\n]*GITHUB_OUTPUT/, 'install step never sets installed=true');
  assert.match(install, /installed=false[^\n]*GITHUB_OUTPUT/, 'install step never sets installed=false on failure');
  assert.doesNotMatch(install, /::error::|^\s*exit 1\b/m, 'install step fails the job on an apt stall; it must warn and exit 0');
  assert.doesNotMatch(body, /continue-on-error/, 'ffmpeg-floor uses continue-on-error; it would also swallow a real assert/test failure. Gate on the step output');
  for (const s of steps.filter((x) => /readFfmpegFloor|npx vitest run/.test(x))) {
    assert.match(
      s,
      new RegExp(String.raw`^ {8}if:[^\n]*steps\.${id}\.outputs\.installed == 'true'`, 'm'),
      `step \`${s.split('\n')[0]}\` is not gated on steps.${id}.outputs.installed == 'true'`,
    );
  }
});

// The install step is an ubuntu-only `run:` block (`timeout`, `sudo`, `apt-get`). The two
// behavioural cases below run it under bash with ALL THREE stubbed on PATH, so they depend on
// neither GNU `timeout` (absent on macOS runners, #4569) nor a real apt. Without bash (a bare
// Windows PowerShell box) they SKIP with a message rather than passing silently.
const HAS_BASH = spawnSync('bash', ['-c', 'true'], { windowsHide: true }).status === 0;
const NO_BASH_SKIP = HAS_BASH ? false : 'no bash on PATH; the static ffmpeg-floor pins still run';

// `timeout -k 10 120 CMD...` -> run CMD directly (drops the three leading args).
function writeFfmpegFloorStubs(bin, sudoBody) {
  writeFileSync(join(bin, 'sudo'), sudoBody, { mode: 0o755 });
  writeFileSync(join(bin, 'sleep'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  writeFileSync(join(bin, 'timeout'), '#!/bin/sh\nshift 3\nexec "$@"\n', { mode: 0o755 });
}

test('ffmpeg floor leg (#4461): the behavioural cases cannot silently do nothing on a bash platform (#4569)', () => {
  if (process.platform !== 'win32') {
    assert.ok(HAS_BASH, 'bash is missing on a POSIX runner; the two ffmpeg-floor behavioural cases would silently skip');
  }
  assert.equal(NO_BASH_SKIP === false, HAS_BASH, 'skip flag disagrees with bash availability');
});

test('ffmpeg floor leg (#4461): the install step really exits 0 with the warning when apt always fails', { skip: NO_BASH_SKIP }, () => {
  const install = ffmpegFloorInstallStep();
  const run = install.split(/^ {8}run: \|\n/m)[1];
  assert.ok(run, 'install step has no `run: |` block');
  const script = run.replace(/^ {10}/gm, '');
  const dir = mkdtempSync(join(tmpdir(), 'ffmpeg-floor-'));
  try {
    const bin = join(dir, 'bin');
    mkdirSync(bin);
    writeFfmpegFloorStubs(bin, '#!/bin/sh\nexit 100\n');
    const out = join(dir, 'output');
    const summary = join(dir, 'summary');
    writeFileSync(out, '');
    writeFileSync(summary, '');
    const r = spawnSync('bash', ['-c', script], {
      encoding: 'utf8',
      windowsHide: true,
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, GITHUB_OUTPUT: out, GITHUB_STEP_SUMMARY: summary },
    });
    assert.equal(r.status, 0, `install step failed on an apt stall (exit ${r.status}): ${r.stdout}${r.stderr}`);
    assert.ok(r.stdout.includes(FFMPEG_FLOOR_WARNING), `no ::warning:: on stdout: ${r.stdout}`);
    assert.ok(readFileSync(summary, 'utf8').includes(FFMPEG_FLOOR_WARNING.replace('::warning::', '')), 'step summary lacks the warning line');
    assert.match(readFileSync(out, 'utf8'), /^installed=false$/m, 'GITHUB_OUTPUT lacks installed=false');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('ffmpeg floor leg (#4461): the install step succeeds (installed=true, no warning) when apt works', { skip: NO_BASH_SKIP }, () => {
  const install = ffmpegFloorInstallStep();
  assert.doesNotMatch(install, /\\n/, 'install step contains a literal backslash-n; bash passes it to apt-get as a stray argument');
  const run = install.split(/^ {8}run: \|\n/m)[1];
  assert.ok(run, 'install step has no `run: |` block');
  const script = run.replace(/^ {10}/gm, '');
  const dir = mkdtempSync(join(tmpdir(), 'ffmpeg-floor-'));
  try {
    const bin = join(dir, 'bin');
    mkdirSync(bin);
    // Like real apt: `update` takes no arguments, so a stray one fails the command.
    writeFfmpegFloorStubs(bin, '#!/bin/sh\n[ "$2" = update ] && [ "$#" -gt 2 ] && exit 100\nexit 0\n');
    const out = join(dir, 'output');
    const summary = join(dir, 'summary');
    writeFileSync(out, '');
    writeFileSync(summary, '');
    const r = spawnSync('bash', ['-c', script], {
      encoding: 'utf8',
      windowsHide: true,
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, GITHUB_OUTPUT: out, GITHUB_STEP_SUMMARY: summary },
    });
    assert.equal(r.status, 0, `install step failed (exit ${r.status}): ${r.stdout}${r.stderr}`);
    assert.ok(!r.stdout.includes('::warning::'), `warned although apt works: ${r.stdout}${r.stderr}`);
    assert.match(readFileSync(out, 'utf8'), /^installed=true$/m, 'GITHUB_OUTPUT lacks installed=true when apt works');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('ffmpeg floor leg (#4461): retry budget fits inside the install step timeout (warning path reachable)', () => {
  const install = ffmpegFloorInstallStep();
  const timeoutMinutes = Number((install.match(/^ {8}timeout-minutes:\s*(\d+)\s*$/m) ?? [])[1]);
  const bounds = [...install.matchAll(/timeout -k (\d+) (\d+) sudo apt-get/g)];
  const sleeps = [...install.matchAll(/^\s*sleep (\d+)\s*$/gm)];
  const attempts = (install.match(/for attempt in ([\d ]+); do/) ?? ['', ''])[1].trim().split(/\s+/).length;
  assert.ok(timeoutMinutes > 0 && bounds.length === 2 && sleeps.length === 1, 'cannot parse the install retry budget');
  // Both commands run every attempt, so size the worst case on the larger bound.
  const bound = Math.max(...bounds.map((b) => Number(b[2])));
  const kill = Math.max(...bounds.map((b) => Number(b[1])));
  const sleep = Number(sleeps[0][1]);
  assert.equal(attempts, 3, 'retry loop is no longer 3 attempts');
  // attempts x (2 apt commands x bound + inter-attempt sleep) must fit the step
  // timeout, else the runner kills the step before the warning can be emitted.
  assert.ok(
    attempts * (2 * bound + sleep) < timeoutMinutes * 60,
    `3 x (2 x ${bound} + ${sleep}) = ${attempts * (2 * bound + sleep)}s does not fit timeout-minutes ${timeoutMinutes} (${timeoutMinutes * 60}s)`,
  );
  // Worst case also pays the -k kill grace after each command's bound.
  assert.ok(
    attempts * (2 * (bound + kill) + sleep) < timeoutMinutes * 60,
    `with the -k ${kill}s kill grace the worst case exceeds timeout-minutes ${timeoutMinutes}`,
  );
});
