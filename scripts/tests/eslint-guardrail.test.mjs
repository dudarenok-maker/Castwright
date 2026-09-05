// scripts/tests/eslint-guardrail.test.mjs — run via node:test (test:hooks tier)
//
// Planted-violation test for the W5 ESLint guardrail (plan flaky-release-hardening).
// Proves that eslint.config.mjs's no-restricted-syntax rule REJECTS a file containing
// `it.skipIf(process.env.CI)(...)` — the canonical flake anti-pattern.
//
// CRITICAL: the planted file is written INSIDE the repo tree (guardrail-tmp-* dir
// at the repo root), NOT os.tmpdir(). ESLint flat config ignores files outside its
// base path and would exit 0 (false pass) if the file were in a system temp dir.
//
// `guardrail-tmp-*/` is ALSO in eslint.config.mjs's global `ignores` (#2482) —
// a directory this probe fails to clean up (killed process, or a Windows EBUSY
// race on rmSync) must not wedge lint on every later checkout. That means the
// probe's own `npx eslint` call now needs `--no-ignore` to see its planted
// file — without it this test would false-pass against a probe that lints
// nothing, exactly the failure mode the ignore entry's comment warns about.
import { test } from 'node:test';
import assert from 'node:assert';
import { writeFileSync, rmSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

// test:hooks runs from the repo root (scripts/run-hooks-tests.mjs uses fast-glob
// which resolves against cwd).
const repoRoot = process.cwd();

const RULE_ID = 'no-restricted-syntax';

// Runs eslint and returns { exitCode, output }. Using spawnSync (not
// execFileSync) so a non-zero exit doesn't throw — callers need the output
// on EVERY outcome, not just failure, to tell "the guardrail rule fired" apart
// from "eslint itself errored" (a bad flag, a missing binary, a config
// problem) — both exit non-zero, and only the output distinguishes them.
//
// Windows needs shell:true to run npx.cmd at all (spawnSync cannot exec a
// .cmd file directly — EINVAL). shell:true only concatenates argv without
// escaping (Node DEP0190), so every argument is quoted here — cheap
// insurance since one of them is a path built from mkdtempSync's own output
// and could contain a space in a checkout outside this repo's convention.
const IS_WIN = process.platform === 'win32';

function runEslint(args) {
  const argv = IS_WIN ? args.map((a) => `"${a}"`) : args;
  const result = spawnSync('npx', ['eslint', ...argv], {
    cwd: repoRoot,
    encoding: 'utf8',
    shell: IS_WIN,
    windowsHide: true,
  });
  if (result.error) {
    throw result.error;
  }
  return { exitCode: result.status, output: (result.stdout ?? '') + (result.stderr ?? '') };
}

test('guardrail rejects a planted it.skipIf(process.env.CI)', () => {
  // Create a temp dir inside the repo so the flat config base path applies.
  // The *.test.ts suffix routes it into the test-file override block (and its
  // TS parser) that carries the no-restricted-syntax rule.
  const dir = mkdtempSync(join(repoRoot, 'guardrail-tmp-'));
  const f = join(dir, 'planted.test.ts');
  writeFileSync(
    f,
    "import { it } from 'vitest';\nit.skipIf(process.env.CI)('x', () => {});\n",
  );
  let result;
  try {
    // --no-ignore: guardrail-tmp-*/ is ALSO in eslint.config.mjs's global
    // `ignores` (#2482 — a leftover from THIS probe must not wedge lint on a
    // later, unrelated checkout). Without --no-ignore this call would exit 0
    // regardless of the rule's presence, which is exactly the false-pass this
    // test exists to catch — so the assertion below checks for the rule ID
    // specifically, not just a non-zero exit, which a bad flag or a broken
    // eslint invocation would also produce.
    result = runEslint(['--no-ignore', f]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  assert.equal(result.exitCode, 1, `eslint should exit 1 for a lint violation (got ${result.exitCode}): ${result.output}`);
  assert.match(
    result.output,
    new RegExp(RULE_ID),
    `eslint's output should name the ${RULE_ID} rule, not merely exit non-zero: ${result.output}`,
  );
});

test('a stale guardrail-tmp-* leftover is ignored by ESLint, not merely absent of other diagnostics', () => {
  // Simulates the #2482 failure mode: a guardrail-tmp-* dir survives cleanup
  // (killed process / rmSync race) and is still sitting in the tree the next
  // time someone runs `npm run lint`. Targets the leftover directly via an
  // explicit glob rather than `eslint . --max-warnings 0` over the whole
  // repo — a whole-repo lint's exit code says nothing about THIS directory
  // specifically; it would also flip on an unrelated pre-existing warning
  // elsewhere in the tree, which is not what this test is meant to prove.
  //
  // ESLint 9 treats "every file an explicit glob pattern matches is ignored"
  // as its own outcome (exit 2, "all matched files are ignored"), distinct
  // from "the file was linted and found clean" (exit 0) — so a passing run
  // here is a config guarantee, not silence.
  const staleDir = mkdtempSync(join(repoRoot, 'guardrail-tmp-'));
  const staleFile = join(staleDir, 'planted.test.ts');
  writeFileSync(
    staleFile,
    "import { it } from 'vitest';\nit.skipIf(process.env.CI)('x', () => {});\n",
  );
  let result;
  try {
    result = runEslint([`${staleDir.replace(/\\/g, '/')}/**/*.ts`]);
  } finally {
    rmSync(staleDir, { recursive: true, force: true });
  }
  assert.equal(
    result.exitCode,
    2,
    `eslint should report every matched file as ignored (exit 2), not lint the leftover (got ${result.exitCode}): ${result.output}`,
  );
  assert.match(result.output, /ignored/i, `eslint's output should say the leftover was ignored: ${result.output}`);
  assert.doesNotMatch(
    result.output,
    new RegExp(RULE_ID),
    `the leftover must never actually be linted, i.e. never surface the ${RULE_ID} violation: ${result.output}`,
  );
});

test('the guardrail-tmp-*/budget-poll-tmp-* ignores do not swallow an ordinary tracked *.test.ts file', () => {
  // The two tests above prove the leftover dirs ARE ignored and the rule
  // fires when unignored via --no-ignore. Neither would catch the ignore
  // pattern becoming too broad (e.g. accidentally matching '**/*.test.ts'
  // instead of a specific directory prefix) — test 1 always passes
  // --no-ignore, which would blind it to that too, and test 2 asserts the
  // file IS ignored, so a broader pattern only makes it greener.
  //
  // This is the counterweight: it probes an already-TRACKED test file
  // instead of planting one. An earlier version of this test planted its
  // own file under a THIRD repo-root mkdtempSync prefix
  // ('eslint-guardrail-canary-*') that was itself not in either ignore
  // list — reintroducing the exact #2482 leftover-wedge class this file
  // exists to close if that plant ever survived a killed process. Probing
  // a tracked file instead writes nothing, so there is nothing to leak.
  const target = join(repoRoot, 'server', 'src', 'test-utils', 'quarantine.test.ts');
  const result = runEslint([target]);
  assert.doesNotMatch(
    result.output,
    /ignored/i,
    `a real tracked *.test.ts file must never be reported as ignored (got exit ${result.exitCode}): ${result.output}`,
  );
});
