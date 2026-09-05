// scripts/tests/pre-commit-lint-e2e.test.mjs — END-TO-END coverage of
// `scripts/hooks/pre-commit-lint.mjs`, run as a real subprocess against real
// ESLint.
//
// WHY THIS FILE EXISTS. `pre-commit-lint.test.mjs` drives the exported pure
// functions, which left the script's main-module block — the part that builds
// the eslint argv and actually spawns it — with zero coverage. Both regressions
// this hook has already shipped lived in exactly that block, and every one of
// its argv tokens can be deleted without a single existing test noticing:
//
//   - drop `--format json`  → eslint emits stylish text, JSON.parse throws, the
//                             verdict becomes `{blocked:false, warning:…}` and
//                             the hook stops blocking ANYTHING;
//   - drop `--max-warnings 0` → a warnings-only file exits 0 and sails through;
//   - drop `--no-warn-ignored` → an eslint-ignored tracked file (the generated
//                             `src/lib/api-types.ts`) produces a warning, which
//                             `--max-warnings 0` turns into a blocked commit —
//                             the pass-1 finding-2 regression, reopened;
//   - drop `maxBuffer`       → a staged file with >1 MB of `--format json`
//                             findings overflows spawnSync's 1 MB default,
//                             arrives as ENOBUFS with truncated stdout, and the
//                             fail-open rule passes the commit UNLINTED.
//
// THE BUDGET PATH IS TOLERATED, NOT ASSERTED AWAY. See BUDGET_EXCEEDED_MARKER
// below: the hook's per-batch budget legitimately warns-and-passes, and these
// tests accept exactly that one stderr line in place of their expected verdict
// (still asserting the exit code is 0 on that path). Every mutation above still
// reddens through the tolerance — verified, see the mutation log at the bottom.
//
// Each test below is paired with one of those tokens and was verified RED by
// deleting it (see the mutation log at the bottom of this file).
//
// HOW IT AVOIDS THE REAL STAGED SET. Nothing here runs `git add`. The staged
// set is fabricated in a THROWAWAY INDEX: `git hash-object -w` writes a blob,
// `git update-index --cacheinfo` places it in an index file under the OS temp
// dir, and the hook is spawned with `GIT_INDEX_FILE` pointing at that file.
// `scrubGitEnv()` deliberately preserves `GIT_INDEX_FILE` (see the #2216
// correction in `scripts/git-env.mjs`), so the hook's own `git diff --cached`
// reads our scratch index and the repository's real index is never touched.
// `GIT_DIR` is NOT used for this — pointing it at a scratch location is how
// this repo previously wrote 3,979 files into the wrong tree.
//
// Every tracked file absent from a scratch index shows up as a deletion, and
// the hook's `--diff-filter=ACMR` drops deletions, so a scratch index holding
// one entry yields a staged set of exactly that one file.
//
// `repoRoot` is derived from THIS FILE's location, never `process.cwd()`:
// `node --test scripts/tests/...` from another directory otherwise silently
// exercises a different checkout.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');
const HOOK = join(repoRoot, 'scripts', 'hooks', 'pre-commit-lint.mjs');

/** An eslint-IGNORED but git-TRACKED file: `eslint.config.mjs`'s global
 *  ignores list `src/lib/api-types.ts` because it is generated. This is the
 *  only shape that exercises `--no-warn-ignored`. */
const ESLINT_IGNORED_TRACKED_FILE = 'src/lib/api-types.ts';

/** Repo-relative fixture root. Git-ignored via the `precommit-lint-tmp-` glob
 *  in `.gitignore`, but deliberately NOT eslint-ignored — the hook spawns
 *  eslint without
 *  `--no-ignore`, so an eslint-ignored fixture could never go red. */
const fixtureDirName = `precommit-lint-tmp-${process.pid}`;
const fixtureDir = join(repoRoot, fixtureDirName);

/** Scratch indexes live OUTSIDE the repo. */
const scratchDir = mkdtempSync(join(tmpdir(), 'precommit-lint-e2e-'));

after(() => {
  rmSync(fixtureDir, { recursive: true, force: true });
  rmSync(scratchDir, { recursive: true, force: true });
});

/** Run git in the repo with every repository-discovery var stripped, so an
 *  ambient `GIT_DIR`/`GIT_WORK_TREE` can't redirect these calls. */
function git(args, { indexFile, input } = {}) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (/^GIT_(DIR|WORK_TREE|OBJECT_DIRECTORY|COMMON_DIR|INDEX_FILE)$/i.test(key)) delete env[key];
  }
  if (indexFile) env.GIT_INDEX_FILE = indexFile;
  const r = spawnSync('git', args, {
    cwd: repoRoot, encoding: 'utf8', windowsHide: true, env, input,
  });
  if (r.error) throw r.error;
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} exited ${r.status}\n${r.stderr}`);
  return r.stdout.trim();
}

let indexCounter = 0;

/** Build a throwaway index containing exactly `entries` ([repoPath, content]).
 *  The blob is written to the object store (unreferenced, collectable); the
 *  real index and the working tree are untouched. */
function scratchIndexWith(entries) {
  const indexFile = join(scratchDir, `index-${indexCounter++}`);
  for (const [repoPath, content] of entries) {
    const blob = git(['hash-object', '-w', '--stdin'], { input: content });
    git(['update-index', '--add', '--cacheinfo', `100644,${blob},${repoPath}`], { indexFile });
  }
  return indexFile;
}

/** Write a fixture into the repo tree AND return its `scratchIndexWith` entry.
 *  The hook filters the staged set through `existsSync(repoRoot/f)` and eslint
 *  lints the WORKING-TREE file, so both halves have to be real. */
function fixture(name, content) {
  mkdirSync(fixtureDir, { recursive: true });
  writeFileSync(join(fixtureDir, name), content);
  return [`${fixtureDirName}/${name}`, content];
}

/** A SPAWN DETECTOR for the eslint child.
 *
 *  "The hook did not spawn eslint" is not observable from exit code or output
 *  on its own: with `--no-warn-ignored` in the argv, eslint handed a `.md`
 *  file exits 0 and prints nothing, so a hook that wrongly spawned it looks
 *  identical to one that short-circuited. (Measured — an earlier version of
 *  this file asserted empty stderr and stayed GREEN when the extension filter
 *  was deleted.)
 *
 *  This preload module is injected via `NODE_OPTIONS`, so it loads into BOTH
 *  the hook process and any node child it spawns; it discriminates on
 *  `process.argv[1]` and only fires for eslint's entry point. Firing kills
 *  that child before it produces JSON, which the hook reports as its
 *  "did not produce valid JSON output" warning — the observable. */
const spawnDetector = join(scratchDir, 'detect-eslint-spawn.cjs');
writeFileSync(
  spawnDetector,
  "if (String(process.argv[1] || '').includes('eslint')) { process.exit(99); }\n",
);

/** Spawn the hook exactly as `.husky/pre-commit` does, but pointed at a
 *  scratch index. `detectEslintSpawn` additionally injects the preload above. */
function runHook(indexFile, { detectEslintSpawn = false } = {}) {
  const env = { ...process.env, GIT_INDEX_FILE: indexFile };
  if (detectEslintSpawn) {
    env.NODE_OPTIONS = `${process.env.NODE_OPTIONS ?? ''} --require="${spawnDetector.replace(/\\/g, '/')}"`.trim();
  }
  const r = spawnSync(process.execPath, [HOOK], {
    cwd: repoRoot,
    encoding: 'utf8',
    windowsHide: true,
    // Must exceed the hook's OWN per-batch budget (BUDGET_MS, 120s) with room
    // for its git call and node startup — otherwise this harness kills the
    // hook before its budget path can run and the tolerance below is untested.
    timeout: 300_000,
    // The HARNESS needs its own ceiling for the same reason the hook does: the
    // >1 MB-of-findings case below makes the hook print >1 MB of reason to
    // stderr, and at `spawnSync`'s 1 MB default this call ENOBUFS-es before any
    // assertion runs. (Observed the first time that test was written.)
    maxBuffer: 64 * 1024 * 1024,
    env,
  });
  if (r.error) throw r.error;
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

const SPAWNED_MARKER = /did not produce valid JSON output/;

/** The ONE stderr line these tests tolerate instead of their expected verdict.
 *
 *  The hook's per-batch `BUDGET_MS` is a real code path: exceed it and eslint
 *  is killed, the verdict becomes `{blocked:false, warning:…}`, and the hook
 *  warns to stderr and exits 0 by design (principle 4's fail-open direction).
 *  On a cold tree, or a loaded box, a single-file eslint run has been measured
 *  at 73.6s and (under concurrent load, PR #2999 review) 77.4s — so asserting
 *  the findings verdict unconditionally makes these tests flake, and
 *  `test:hooks` is a leg of the required `verify.yml`.
 *
 *  Anchored to the hook's exact wording and to `^pre-commit-lint: `, so it
 *  matches ONLY that path. Every other warning the hook can emit — the missing
 *  binary, the fatal-config error, the unparseable-output one the mutation log
 *  below relies on, the ENOBUFS overflow — still falls through to the strict
 *  assertion and reddens. */
const BUDGET_EXCEEDED_MARKER = /^pre-commit-lint: eslint exceeded its \d+s local budget/m;

/** Assert the hook's verdict, accepting the budget path as the one alternative.
 *
 *  Returns `true` when the real verdict was observed (the caller may then make
 *  its findings-specific assertions) and `false` when the budget path was
 *  taken. It is NOT a blanket softening: on the budget path the exit code is
 *  still asserted — 0, because a budget breach must warn and pass, never block
 *  — so a hook that times out AND blocks still fails here. */
function assertVerdict({ status, stderr }, expectedStatus, message) {
  if (BUDGET_EXCEEDED_MARKER.test(stderr)) {
    assert.equal(status, 0, `a budget breach must warn and PASS; stderr was:\n${stderr}`);
    return false;
  }
  assert.equal(status, expectedStatus, `${message}; stderr was:\n${stderr}`);
  return true;
}

/** `stderr` must be empty — or hold nothing but the budget warning. */
function assertQuietStderr(stderr) {
  if (BUDGET_EXCEEDED_MARKER.test(stderr)) {
    assert.equal(
      stderr.split(/\r?\n/).filter((l) => l.trim() && !BUDGET_EXCEEDED_MARKER.test(l)).join('\n'),
      '',
      `stderr carried more than the budget warning:\n${stderr}`,
    );
    return;
  }
  assert.equal(stderr, '');
}

/** The scratch-index machinery is itself an instrument, so prove it reports
 *  what we think before trusting any verdict built on it. */
function assertStagedSetIs(indexFile, expected) {
  const out = git(['diff', '--cached', '--name-only', '--diff-filter=ACMR'], { indexFile });
  assert.deepEqual(out.split(/\r?\n/).filter(Boolean), expected);
}

// === The four end-to-end cases ==========================================

// Pairs with `--format json`: without it eslint's stylish text fails
// JSON.parse and the hook returns blocked:false, so this must be exit 1.
test('e2e: a staged file with real lint errors blocks the commit (exit 1)', () => {
  const dirty = 'const unusedVariable = 1;\n\nsomeUndefinedGlobalThing();\n';
  const index = scratchIndexWith([fixture('dirty.mjs', dirty)]);
  assertStagedSetIs(index, [`${fixtureDirName}/dirty.mjs`]);

  const result = runHook(index);
  if (!assertVerdict(result, 1, 'expected the hook to block')) return;
  assert.match(result.stderr, /dirty\.mjs/);
  assert.match(result.stderr, /is not defined/);
});

// Pairs with `--max-warnings 0`: this file's only finding is severity 1, so
// without that flag eslint exits 0 and the commit sails through.
test('e2e: a staged file whose only findings are WARNINGS still blocks (exit 1) — --max-warnings 0', () => {
  const warnOnly = 'const unusedVariable = 1;\n';
  const index = scratchIndexWith([fixture('warn-only.mjs', warnOnly)]);
  assertStagedSetIs(index, [`${fixtureDirName}/warn-only.mjs`]);

  const result = runHook(index);
  if (!assertVerdict(result, 1, 'expected a warnings-only file to block')) return;
  assert.match(result.stderr, /warn-only\.mjs/);
  assert.doesNotMatch(result.stderr, /is not defined/, 'fixture must carry NO error-severity finding');
});

// The healthy path. Also the control for the two tests above: it proves a
// non-zero exit there came from findings, not from the harness.
test('e2e: a clean staged JS file passes (exit 0, no output)', () => {
  const index = scratchIndexWith([fixture('clean.mjs', 'export const ok = 1;\n')]);
  assertStagedSetIs(index, [`${fixtureDirName}/clean.mjs`]);

  const { status, stdout, stderr } = runHook(index);
  assert.equal(status, 0, `expected a clean file to pass; stderr was:\n${stderr}`);
  assertQuietStderr(stderr);
  assert.equal(stdout, '');
});

// The short-circuit. Exit 0 alone proves nothing here — eslint handed a `.md`
// under `--no-warn-ignored` ALSO exits 0 silently — so the no-spawn half is
// asserted with the preload detector, and the control below proves that
// detector can actually fire.
test('e2e: staging only non-JS/TS files exits 0 without ever spawning eslint', () => {
  const index = scratchIndexWith([
    fixture('notes.md', '# notes\n'),
    fixture('data.json', '{"a":1}\n'),
  ]);
  assertStagedSetIs(index, [`${fixtureDirName}/data.json`, `${fixtureDirName}/notes.md`]);

  const { status, stdout, stderr } = runHook(index, { detectEslintSpawn: true });
  assert.equal(status, 0);
  assert.doesNotMatch(
    stderr,
    SPAWNED_MARKER,
    'eslint was spawned on a non-lintable staged set — the extension filter is gone',
  );
  assert.equal(stdout, '');
});

// CONTROL for the test above. Without this, `doesNotMatch` would pass just as
// happily against a detector that never fires under any circumstances.
test('e2e control: the spawn detector DOES fire when eslint really is spawned', () => {
  const index = scratchIndexWith([fixture('control-clean.mjs', 'export const ok = 2;\n')]);
  assertStagedSetIs(index, [`${fixtureDirName}/control-clean.mjs`]);

  const { stderr } = runHook(index, { detectEslintSpawn: true });
  assert.match(stderr, SPAWNED_MARKER, 'the detector cannot fire — the test above proves nothing');
});

// Pairs with `--no-warn-ignored`: api-types.ts is generated and globally
// ignored by eslint.config.mjs. Passed to eslint WITHOUT that flag it yields
// "File ignored because of a matching ignore pattern" as a WARNING, which
// --max-warnings 0 escalates into a blocked commit. This is pass-1 finding 2.
test('e2e: an eslint-ignored but tracked staged file passes (exit 0) — --no-warn-ignored', () => {
  assert.ok(
    existsSync(join(repoRoot, ESLINT_IGNORED_TRACKED_FILE)),
    `${ESLINT_IGNORED_TRACKED_FILE} must exist for this test to mean anything`,
  );
  // Staged content must DIFFER from HEAD, or the file shows as unmodified and
  // never reaches the staged set at all — a test that could not fail.
  const index = scratchIndexWith([[ESLINT_IGNORED_TRACKED_FILE, '// scratch modification\n']]);
  assertStagedSetIs(index, [ESLINT_IGNORED_TRACKED_FILE]);

  const { status, stdout, stderr } = runHook(index);
  assert.equal(status, 0, `an eslint-ignored file must not block; stderr was:\n${stderr}`);
  assertQuietStderr(stderr);
  assert.equal(stdout, '');
});

// Pairs with `maxBuffer` in `eslintSpawnOptions`. `spawnSync`'s DEFAULT
// maxBuffer is 1 MB; `--format json` over a heavily-dirty staged file blows
// past it, which arrives as an `ENOBUFS` spawn error with TRUNCATED stdout.
// Principle 4 turns any spawn error into warn-and-pass, so before the explicit
// ceiling this commit sailed through UNLINTED — silently, and exactly when the
// staged file carried the most findings. Verified RED by deleting `maxBuffer`
// from `eslintSpawnOptions` (see the mutation log below).
test('e2e: a staged file with MORE THAN 1 MB of findings still blocks — maxBuffer', () => {
  // ~180 bytes of `--format json` per no-undef finding; 12,000 lines is ~2 MB,
  // comfortably over the 1 MB default and far under the explicit 64 MB one.
  const huge = 'someUndefinedGlobalThing();\n'.repeat(12_000);
  const index = scratchIndexWith([fixture('huge.mjs', huge)]);
  assertStagedSetIs(index, [`${fixtureDirName}/huge.mjs`]);

  const result = runHook(index);
  assert.doesNotMatch(
    result.stderr,
    /output budget/,
    'the hook hit an output ceiling on ~2 MB: either `maxBuffer` is gone from '
      + 'eslintSpawnOptions (so the 1 MB default applies and this commit would '
      + 'pass UNLINTED), or MAX_OUTPUT_BYTES was lowered under the fixture',
  );
  if (!assertVerdict(result, 1, 'a >1 MB findings set must still block')) return;
  assert.match(result.stderr, /huge\.mjs/);
  assert.match(result.stderr, /is not defined/);
});

// === Mutation log (2026-09-05, measured in this worktree) ================
//
// Each mutation deletes ONE token from `baseArgs` in the hook's main-module
// block and reddens at least one test above:
//
//   delete '--format', 'json'          → 4 of 6 red, incl. the dirty-file test:
//     ✖ a staged file with real lint errors blocks the commit  (1 !== 0)
//     ✖ ... only findings are WARNINGS still blocks
//     ✖ a clean staged JS file passes    (stderr gained
//       "eslint did not produce valid JSON output — skipping local lint")
//     ✖ an eslint-ignored but tracked staged file passes  (same stderr)
//
//   delete '--max-warnings', '0'       → 1 red:
//     ✖ ... only findings are WARNINGS still blocks
//       AssertionError: expected a warnings-only file to block  (1 !== 0)
//
//   delete '--no-warn-ignored'         → 1 red:
//     ✖ an eslint-ignored but tracked staged file passes
//       AssertionError: an eslint-ignored file must not block; stderr was
//       "File ignored because of a matching ignore pattern..."  (0 !== 1)
//
//   delete the LINTABLE_EXTENSIONS filter (`filterLintableFiles`) → 1 red:
//     ✖ staging only non-JS/TS files exits 0 without ever spawning eslint
//       AssertionError: eslint was spawned on a non-lintable staged set
//
// === Mutation log addendum (2026-09-06, PR #2999 pass 3) ================
//
//   delete `maxBuffer` from `eslintSpawnOptions` → 1 red:
//     ✖ a staged file with MORE THAN 1 MB of findings still blocks — maxBuffer
//       AssertionError: the hook hit an output ceiling on ~2 MB ...
//       actual: 'pre-commit-lint: eslint produced more than the 64 MB output
//       budget — its output was truncated ... skipping local lint'
//
//   BUDGET_MS 120_000 → 1_000 (forces the budget path on EVERY test) → 0 red,
//     7 of 7 green. That is the tolerance working as designed, not a
//     disarmament — with the SAME 1s budget in place, deleting `--format json`
//     still reddens 5 of 7, because the budget marker is anchored to the hook's
//     exact "exceeded its Ns local budget" wording and every other warning it
//     can emit falls through to the strict assertion.
//
//   delete '--format','json' (re-run against the tolerant assertions) → 5 red:
//     ✖ real lint errors blocks the commit  ✖ warnings-only still blocks
//     ✖ a clean staged JS file passes       ✖ eslint-ignored tracked file passes
//     ✖ >1 MB of findings still blocks
//
// The extension-filter mutation is why the preload detector exists. The first cut of that test
// asserted `stderr === ''` instead, and stayed GREEN under this mutation:
// `--no-warn-ignored` suppresses the very warning it was waiting for, so
// eslint spawned on a `.md` file exits 0 in silence. It was 16-ways-a-test-
// cannot-fail coverage until the detector (and its control) replaced it.
