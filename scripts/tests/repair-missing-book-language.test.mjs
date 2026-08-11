/* Wrapper for scripts/tests/repair-missing-book-language.inner.test.mts.

   scripts/repair-missing-book-language.mts calls the REAL
   detectManuscriptLanguage / writeStateJsonAtomic / paths.ts (per #2246 —
   no re-implementing them), all real server/src/*.ts modules whose OWN
   imports use `.js` specifiers for sibling `.ts` files (this repo's
   server/tsconfig.json moduleResolution). Plain `node --test` (what
   run-hooks-tests.mjs spawns for every other *.test.mjs here) cannot
   resolve that without a TS-aware loader — confirmed by hand: importing
   detect-language.ts directly from a plain node process works (Node 24
   strips ITS types), but detect-language.ts's own `./language-registry.js`
   import then 404s, because plain node's resolver never remaps a `.js`
   specifier onto a sibling `.ts` file — only a TS-aware loader (tsx) does
   that remapping.

   So the actual assertions live in the sibling .inner.test.mts file and run
   under `server/node_modules/.bin/tsx --test` (the tsx devDependency this
   repo already pins for its other TS-importing repair scripts — see
   scripts/repair-missing-speakers.mts). This file is the thin adapter that
   makes that suite visible to `npm run test:hooks` / `npm run test:fast` /
   `npm run test:all`: it shells out to tsx and fails loudly (with the full
   inner-suite output) if any of those tests go red. */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..', '..');
/* The tsx CLI's own .mjs entrypoint, invoked via `process.execPath` — avoids
   the platform-specific `.bin/tsx(.cmd)` shim entirely (a Windows `.cmd`
   needs `shell: true` under execFileSync, which drags in cmd.exe quoting
   rules for no benefit here). */
const TSX_CLI = join(REPO_ROOT, 'server', 'node_modules', 'tsx', 'dist', 'cli.mjs');
const INNER_TEST = join(__dirname, 'repair-missing-book-language.inner.test.mts');

test('repair-missing-book-language: full suite (real detect-language/state-migrate via tsx)', () => {
  if (!existsSync(TSX_CLI)) {
    throw new Error(
      `tsx devDependency not installed at ${TSX_CLI} — run \`npm install\` inside server/ ` +
        '(or in a fresh worktree, junction server/node_modules from the primary checkout).',
    );
  }

  /* THIS process is itself a worker of the outer `node --test` run (spawned
     by run-hooks-tests.mjs / npm run test:hooks), so node stamped
     NODE_TEST_CONTEXT=child-v8 into process.env before we ever got here.
     execFileSync inherits process.env by default — if that var reaches the
     child, ITS OWN `node --test` (inside tsx) reads it, decides it must be a
     nested/recursive test run, and SILENTLY SKIPS running any files at all
     (a real observed failure mode here: the child then exits 0 having run
     ZERO tests, which would make this wrapper falsely green). Strip both
     NODE_TEST_* vars so the child boots a genuinely independent run. */
  const childEnv = { ...process.env };
  delete childEnv.NODE_TEST_CONTEXT;
  delete childEnv.NODE_TEST_WORKER_ID;

  let output;
  try {
    output = execFileSync(process.execPath, [TSX_CLI, '--test', INNER_TEST], {
      cwd: REPO_ROOT,
      env: childEnv,
      encoding: 'utf8',
    });
  } catch (err) {
    // Surface the full inner-suite output (which test(s) failed) rather than
    // just "process exited 1".
    process.stderr.write(String(err.stdout ?? ''));
    process.stderr.write(String(err.stderr ?? ''));
    throw err;
  }
  process.stdout.write(output);

  // Guard against the exact silent-skip failure mode above: a run that
  // reports zero tests must NOT read as success.
  const summary = output.match(/ℹ tests (\d+)[\s\S]*?ℹ pass (\d+)[\s\S]*?ℹ fail (\d+)/);
  assert.ok(summary, 'inner tsx --test run did not print the expected node:test summary block');
  const total = Number(summary[1]);
  const passed = Number(summary[2]);
  const failed = Number(summary[3]);
  assert.equal(failed, 0, `${failed} inner test(s) failed`);
  assert.ok(total > 0, 'inner tsx --test run reported ZERO tests — see NODE_TEST_CONTEXT note above');
  assert.equal(passed, total, `expected all ${total} inner tests to pass, only ${passed} did`);
});
