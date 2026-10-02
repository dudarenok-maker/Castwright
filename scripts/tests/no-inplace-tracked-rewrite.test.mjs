// #3413 — verify-cache's stat-identity guard (statIdentity: size:mtimeMs:
// ctimeMs:ino at step start vs end) makes a step uncacheable when any of its
// input files was REWRITTEN during the step. A test that mutates a tracked
// file in place and restores it leaves the content identical but moves ctime
// (and, on some editors/filesystems, ino), so test:hooks would re-run on
// every verify and never print [cached]. check-register-citations.test.mjs and
// check-register-row-citations.test.mjs used to do exactly that to their
// checker's own source (and a docs file); their mutations now run against a
// scratch copy (lib/scratch-repo.mjs). This pins that: run both test files as
// a child process and assert the real files' stat identity is unchanged.
//
// Scope: this watches the files those two tests are known to mutate. A NEW
// in-place writer elsewhere in test:hooks is not seen here — it shows up as
// test:hooks never printing [cached] (see the measurement in #3413).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { statIdentity } from '../verify-cache.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..');

const WATCHED = [
  'scripts/check-register-citations.mjs',
  'scripts/check-register-row-citations.mjs',
  'docs/testing/onbox-sitting-plan.md',
];

// Overridable (comma-separated) so a paired RED proof can point at pre-fix
// copies of the test files; defaults to the real ones.
const TARGET_TESTS = process.env.NO_INPLACE_REWRITE_TARGETS
  ? process.env.NO_INPLACE_REWRITE_TARGETS.split(',')
  : [join(HERE, 'check-register-citations.test.mjs'), join(HERE, 'check-register-row-citations.test.mjs')];

test('the register-citation CLI tests do not rewrite tracked files in place (stat identity unchanged)', () => {
  const before = WATCHED.map((rel) => statIdentity(join(REPO, rel)));
  assert.ok(
    before.every((id) => id !== null),
    'fixture assumption: every watched file exists',
  );

  // A parent `node --test` exports NODE_TEST_CONTEXT=child-v8, which makes a
  // nested `node --test` run ZERO tests and exit 0 (see
  // repair-missing-book-language.test.mjs) — scrub it, then assert tests ran.
  const childEnv = { ...process.env };
  delete childEnv.NODE_TEST_CONTEXT;
  const run = spawnSync(process.execPath, ['--test', ...TARGET_TESTS], {
    cwd: REPO,
    env: childEnv,
    encoding: 'utf8',
    timeout: 900000, // the targets spawn the full-corpus CLI a dozen-plus times (~2-3 min)
    windowsHide: true,
  });
  assert.equal(run.status, 0, `child test run must pass:\n${run.stdout}\n${run.stderr}`);
  assert.match(run.stdout, /^ℹ tests [1-9]\d*$/m, 'child run must actually execute tests');

  const after = WATCHED.map((rel) => statIdentity(join(REPO, rel)));
  assert.deepEqual(after, before, 'a tracked file was rewritten (size/mtime/ctime/ino moved) during the test run');
});
