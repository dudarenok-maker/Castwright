// scripts/tests/eslint-guardrail.test.mjs — run via node:test (test:hooks tier)
//
// Planted-violation test for the W5 ESLint guardrail (plan flaky-release-hardening).
// Proves that eslint.config.js's no-restricted-syntax rule REJECTS a file containing
// `it.skipIf(process.env.CI)(...)` — the canonical flake anti-pattern.
//
// CRITICAL: the planted file is written INSIDE the repo tree (guardrail-tmp-* dir
// at the repo root), NOT os.tmpdir(). ESLint flat config ignores files outside its
// base path and would exit 0 (false pass) if the file were in a system temp dir.
import { test } from 'node:test';
import assert from 'node:assert';
import { writeFileSync, rmSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

// test:hooks runs from the repo root (scripts/run-hooks-tests.mjs uses fast-glob
// which resolves against cwd).
const repoRoot = process.cwd();

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
  let failed = false;
  try {
    execFileSync('npx', ['eslint', f], {
      cwd: repoRoot,
      stdio: 'pipe',
      shell: process.platform === 'win32',
    });
  } catch {
    // eslint exits non-zero when it finds an error-level violation — that is the
    // expected outcome for the planted violation.
    failed = true;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  assert.equal(failed, true, 'eslint should exit non-zero for the planted it.skipIf(process.env.CI) violation');
});
