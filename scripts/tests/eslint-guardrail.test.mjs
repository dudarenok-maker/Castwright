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
import { writeFileSync, rmSync, mkdtempSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

// test:hooks runs from the repo root (scripts/run-hooks-tests.mjs uses fast-glob
// which resolves against cwd).
const repoRoot = process.cwd();

function lintPlantedFile(f) {
  try {
    execFileSync('npx', ['eslint', '--no-ignore', f], {
      cwd: repoRoot,
      stdio: 'pipe',
      shell: process.platform === 'win32',
    });
    return false;
  } catch {
    // eslint exits non-zero when it finds an error-level violation — that is the
    // expected outcome for the planted violation.
    return true;
  }
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
  let failed;
  try {
    failed = lintPlantedFile(f);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  assert.equal(failed, true, 'eslint should exit non-zero for the planted it.skipIf(process.env.CI) violation');
});

test('a stale guardrail-tmp-* leftover does not wedge npm run lint', () => {
  // Simulates the #2482 failure mode: a guardrail-tmp-* dir survives cleanup
  // (killed process / rmSync race) and is still sitting in the tree the next
  // time someone runs `npm run lint`. Invoked the same way that script does
  // (`eslint . --max-warnings 0`, a directory walk — NOT an explicit glob
  // naming the leftover, which ESLint 9 treats as an unmatched-pattern error
  // regardless of ignores and would make this test assert the wrong thing)
  // it must be silently skipped by eslint.config.mjs's global ignore.
  const staleDir = join(repoRoot, 'guardrail-tmp-stale-2482-test');
  rmSync(staleDir, { recursive: true, force: true });
  mkdirSync(staleDir);
  const staleFile = join(staleDir, 'planted.test.ts');
  writeFileSync(
    staleFile,
    "import { it } from 'vitest';\nit.skipIf(process.env.CI)('x', () => {});\n",
  );
  let failed = false;
  try {
    execFileSync('npx', ['eslint', '.', '--max-warnings', '0'], {
      cwd: repoRoot,
      stdio: 'pipe',
      shell: process.platform === 'win32',
    });
  } catch {
    failed = true;
  } finally {
    rmSync(staleDir, { recursive: true, force: true });
  }
  assert.equal(
    failed,
    false,
    'npm run lint should skip a stale guardrail-tmp-* leftover (global ignore) rather than flag its planted violation',
  );
});
