// Test for PR #3236 fix: verify that npm run check:onbox-register routes
// passthrough CLI flags correctly to check-onbox-register.mjs, not to
// build-register-live-view.mjs. The bug was that in a && chain within an npm
// script, appended args (via `npm run <script> -- <args>`) go to the LAST
// command, not the first.
//
// This test spawns a real `npm run` subprocess to verify the routing works.
//
// pr-review-gate pass 3 (#3138) found this file's positive-signal assertions
// were not actually discriminating: `check:onbox-register: OK` is printed by
// BOTH the `--against-published` success path AND the plain no-flag success
// path (check-onbox-register.mjs:2148 and :2175), so asserting only its
// presence passed even when `run-check-onbox-register.mjs` silently dropped
// every CLI flag it was handed. Each test now asserts the SPECIFIC suffix
// each code path actually prints, and test 2 additionally asserts on
// build-register-live-view.mjs's own `register:build --check: up to date.`
// line, so a mutation that skips invoking it (e.g. by short-circuiting the
// status check that gates the second spawn) reddens the test instead of
// passing on the vaguer "check:onbox-register:" substring both scripts share.
//
// pr-review-gate pass 3 also found this file made the REQUIRED `test:hooks`
// leg depend on live network + a reachable `origin`: `--against-published`
// resolves its baseline via a real `git fetch origin main` unless
// `ONBOX_TEST_BASELINE_FILE` is set — the repo's own hermetic seam for
// exactly this (see check-onbox-register.mjs's `ONBOX_TEST_BASELINE_FILE`
// comment, and the equivalent pattern in check-onbox-register.test.mjs's
// `withHermeticBaseline`). Both tests below now inject the REAL, currently
// in-sync register text + live-view HTML as the baseline/published pair —
// they already agree (register:build --check passes on this repo as
// shipped), so the comparison is deterministic and needs no network.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { readNormalized } from '../lib/read-normalized.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '../..');

// npm on Windows is a .cmd shim, which spawnSync can only invoke through
// shell:true (spawning 'npm.cmd' directly fails with EINVAL — confirmed on
// this box; matches the pattern already documented in scripts/start-app.mjs).
// DEP0190 fires specifically when an `args` ARRAY is combined with
// shell:true, because the array elements are joined WITHOUT shell quoting —
// a temp path containing a space would then split into two arguments. The
// fix is to build one already-quoted command STRING and pass it as the sole
// `command`, with no separate `args` array, which is what these two calls do.
function quoteArg(arg) {
  return `"${String(arg).replace(/"/g, '\\"')}"`;
}

const REAL_LIVE_VIEW_PATH = join(
  REPO_ROOT,
  'docs',
  'testing',
  'onbox-acceptance-register-live-view.html',
);
const REAL_REGISTER_PATH = join(REPO_ROOT, 'docs', 'testing', 'onbox-acceptance-register.md');

// Raw, not readNormalized — mirrors check-onbox-register.test.mjs's own
// REAL_LIVE_VIEW_HTML: every live-view parser tolerates a stray `\r`.
const REAL_LIVE_VIEW_HTML = readFileSync(REAL_LIVE_VIEW_PATH, 'utf8');
// readNormalized, not a bare readFileSync — the baseline-diffing code scans
// for literal '\n---\n' / '\n## ' delimiters, which miss on a CRLF checkout.
const REAL_REGISTER_TEXT = readNormalized(REAL_REGISTER_PATH);

function withHermeticBaseline(publishedHtml, baselineText, fn) {
  const dir = mkdtempSync(join(tmpdir(), 'npm-routing-hermetic-'));
  const publishedPath = join(dir, 'published.html');
  const baselinePath = join(dir, 'baseline.md');
  writeFileSync(publishedPath, publishedHtml, 'utf8');
  writeFileSync(baselinePath, baselineText, 'utf8');
  try {
    return fn(publishedPath);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('npm run check:onbox-register routes flags to check-onbox-register.mjs, not build-register-live-view.mjs', () => {
  withHermeticBaseline(REAL_LIVE_VIEW_HTML, REAL_REGISTER_TEXT, (publishedPath) => {
    // Spawn `npm run check:onbox-register -- --against-published <file>`,
    // with ONBOX_TEST_BASELINE_FILE pointed at the real register's own text
    // (which agrees with the real, currently-published live view) so the
    // comparison is hermetic — no `git fetch` against a live `origin`.
    //
    // If the routing is BROKEN (the pass-1 bug), the flags go to
    // build-register-live-view.mjs, which doesn't recognize
    // --against-published and exits with:
    //   "register:build: unrecognised argument(s): --against-published, ..."
    //
    // If the routing is FIXED, the flags go to check-onbox-register.mjs,
    // which recognizes --against-published and, once the comparison agrees,
    // prints the exact suffix asserted below.
    const command = `npm run check:onbox-register -- --against-published ${quoteArg(publishedPath)}`;
    const result = spawnSync(command, {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      timeout: 30000,
      shell: true,
      windowsHide: true,
      env: { ...process.env, ONBOX_TEST_BASELINE_FILE: REAL_REGISTER_PATH },
    });

    const combinedOutput = (result.stdout || '') + (result.stderr || '');

    const brokenError = 'register:build: unrecognised argument(s): --against-published';

    assert.ok(
      combinedOutput,
      `No output captured; stdout: ${result.stdout}, stderr: ${result.stderr}`,
    );

    // The test FAILS (red) if we see the broken error, which proves the bug exists.
    if (combinedOutput.includes(brokenError)) {
      throw new Error(
        `BUG DETECTED: Arguments routed to wrong command.\n` +
          `Expected --against-published to route to check-onbox-register.mjs, ` +
          `but it reached build-register-live-view.mjs instead.\n` +
          `Error: ${brokenError}\n` +
          `Full output:\n${combinedOutput}`,
      );
    }

    // POSITIVE SIGNAL, specific to the --against-published code path: this
    // exact "is not behind" phrasing is only printed once the flag was
    // actually parsed AND the comparison ran (check-onbox-register.mjs's
    // --against-published success branch), not by the plain no-flag path,
    // so it cannot be satisfied by a mutation that silently drops the flag.
    assert.match(
      combinedOutput,
      /check:onbox-register: OK.*is not behind/,
      `Expected the --against-published success line (naming "is not behind"), ` +
        `but got output:\n${combinedOutput}. This indicates the flag may have been ` +
        `dropped or routed to the wrong script.`,
    );
  });
});

test('npm run check:onbox-register with no flags still runs both commands', () => {
  // No ONBOX_TEST_BASELINE_FILE here — this invocation passes no
  // --against-published flag at all, so check-onbox-register.mjs never
  // reaches the baseline-fetching code path regardless.
  const result = spawnSync('npm run check:onbox-register', {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    timeout: 30000,
    shell: true,
    windowsHide: true,
  });

  const combinedOutput = (result.stdout || '') + (result.stderr || '');

  assert(
    result.status === 0 || result.status === 1,
    `Unexpected exit code ${result.status}; output: ${combinedOutput}`,
  );

  assert.ok(combinedOutput.length > 0, `Expected register check output, got empty output`);

  // POSITIVE SIGNAL that check-onbox-register.mjs's structural check ran
  // (not the --against-published path, which needs the flag to reach it).
  assert.ok(
    combinedOutput.includes('check:onbox-register:'),
    `Expected to see output from check-onbox-register.mjs (contains 'check:onbox-register:'), ` +
      `but got:\n${combinedOutput}`,
  );

  // POSITIVE SIGNAL, specific to build-register-live-view.mjs, that the
  // SECOND command actually ran too — this is what a mutation that
  // short-circuits before the second spawn (e.g. inverting the status check
  // that gates it) reddens, unlike the shared "check:onbox-register:"
  // substring above.
  assert.ok(
    combinedOutput.includes('register:build --check: up to date.'),
    `Expected to see build-register-live-view.mjs's own success line ` +
      `("register:build --check: up to date."), proving the second command ` +
      `actually ran, but got:\n${combinedOutput}`,
  );
});
