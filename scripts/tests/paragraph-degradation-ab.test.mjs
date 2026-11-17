/* Wrapper for scripts/tests/paragraph-degradation-ab.inner.test.mts.

   The runner (server/scripts/paragraph-degradation-ab.mts) imports server
   modules whose own imports use `.js` specifiers for sibling `.ts` files, which
   plain `node --test` cannot resolve; the assertions therefore run under tsx.
   This thin adapter makes them visible to `npm run test:hooks`, exactly as
   repair-missing-book-language.test.mjs does (same shape, same reasons). */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..', '..');
/* tsx's own .mjs entrypoint via process.execPath: no Windows .cmd shim. */
const TSX_CLI = join(REPO_ROOT, 'server', 'node_modules', 'tsx', 'dist', 'cli.mjs');
const INNER_TEST = join(__dirname, 'paragraph-degradation-ab.inner.test.mts');

test('paragraph-degradation-ab: full suite (real runner via tsx)', () => {
  if (!existsSync(TSX_CLI)) {
    throw new Error(
      `tsx devDependency not installed at ${TSX_CLI} — run \`npm install\` inside server/.`,
    );
  }

  /* This process is a worker of the outer `node --test` run, so node stamped
     NODE_TEST_CONTEXT into process.env. If it reaches the child's own
     `node --test`, that run believes it is nested and SILENTLY runs zero tests
     (exit 0). Strip both vars so the child is a genuinely independent run. */
  const childEnv = { ...process.env };
  delete childEnv.NODE_TEST_CONTEXT;
  delete childEnv.NODE_TEST_WORKER_ID;

  let output;
  try {
    output = execFileSync(process.execPath, [TSX_CLI, '--test', INNER_TEST], {
      cwd: REPO_ROOT,
      env: childEnv,
      encoding: 'utf8',
      windowsHide: true,
    });
  } catch (err) {
    process.stderr.write(String(err.stdout ?? ''));
    process.stderr.write(String(err.stderr ?? ''));
    throw err;
  }
  process.stdout.write(output);

  // A run that reports zero tests must NOT read as success.
  const summary = output.match(/ℹ tests (\d+)[\s\S]*?ℹ pass (\d+)[\s\S]*?ℹ fail (\d+)/);
  assert.ok(summary, 'inner tsx --test run did not print the expected node:test summary block');
  const total = Number(summary[1]);
  const passed = Number(summary[2]);
  const failed = Number(summary[3]);
  assert.equal(failed, 0, `${failed} inner test(s) failed`);
  assert.ok(total > 0, 'inner tsx --test run reported ZERO tests — see NODE_TEST_CONTEXT note above');
  assert.equal(passed, total, `expected all ${total} inner tests to pass, only ${passed} did`);
});
