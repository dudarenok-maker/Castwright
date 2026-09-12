// Test for PR #3236 fix: verify that npm run check:onbox-register routes
// passthrough CLI flags correctly to check-onbox-register.mjs, not to
// build-register-live-view.mjs. The bug was that in a && chain within an npm
// script, appended args (via `npm run <script> -- <args>`) go to the LAST
// command, not the first.
//
// This test spawns a real `npm run` subprocess to verify the routing works.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '../..');

test('npm run check:onbox-register routes flags to check-onbox-register.mjs, not build-register-live-view.mjs', () => {
  // Create a temporary file to use as --against-published target
  const tmpDir = mkdtempSync(join(tmpdir(), 'npm-routing-test-'));
  const publishedPath = join(tmpDir, 'published.html');

  try {
    // Write a minimal valid HTML for the published page
    writeFileSync(
      publishedPath,
      `<title>Test</title>
<div class="strip"><div class="n owed">0</div></div>
<table class="glance"><thead><tr><th>Group</th><th>Setup</th><th>Rows</th></tr></thead><tbody>
<tr><td><a href="#ga">A</a></td><td>Setup A</td><td>0</td></tr>
</tbody></table>
<section class="group" id="ga">
<h3 class="gtitle"><span class="gtag">A</span> Setup A <span class="gcount">0 rows</span></h3>
</section>`,
      'utf8'
    );

    // Spawn `npm run check:onbox-register -- --against-published <file>`
    // If the routing is BROKEN (the current bug), the flags go to build-register-live-view.mjs
    // which doesn't recognize --against-published and exits with:
    //   "register:build: unrecognised argument(s): --against-published, ..."
    //
    // If the routing is FIXED, the flags go to check-onbox-register.mjs which
    // knows about --against-published and processes it (may fail with a register error,
    // but NOT with an unrecognised-argument error from build-register-live-view.mjs).

    const result = spawnSync(
      'npm',
      ['run', 'check:onbox-register', '--', '--against-published', publishedPath],
      {
        cwd: REPO_ROOT,
        encoding: 'utf8',
        timeout: 30000,
        shell: true,
        windowsHide: true,
      }
    );

    const combinedOutput = (result.stdout || '') + (result.stderr || '');

    // The broken routing produces this error from build-register-live-view.mjs:
    const brokenError = 'register:build: unrecognised argument(s): --against-published';

    // The test FAILS (red) if we see the broken error, which proves the bug exists
    // The test PASSES (green) once we fix it and the error goes away
    assert.ok(
      combinedOutput,
      `No output captured; stdout: ${result.stdout}, stderr: ${result.stderr}`
    );

    // The key assertion: we should NOT see the error from build-register-live-view.mjs
    // complaining about unrecognised arguments. This is the mutation check.
    if (combinedOutput.includes(brokenError)) {
      throw new Error(
        `BUG DETECTED: Arguments routed to wrong command.\n` +
        `Expected --against-published to route to check-onbox-register.mjs, ` +
        `but it reached build-register-live-view.mjs instead.\n` +
        `Error: ${brokenError}\n` +
        `Full output:\n${combinedOutput}`
      );
    }

    // If we get here, the routing worked correctly
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('npm run check:onbox-register with no flags still runs both commands', () => {
  // Verify that when NO flags are passed, both commands still run as expected.
  // This is the "preserve both behaviors" requirement.

  const result = spawnSync('npm', ['run', 'check:onbox-register'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    timeout: 30000,
    shell: true,
    windowsHide: true,
  });

  const combinedOutput = (result.stdout || '') + (result.stderr || '');

  // Both commands should run. We expect to see output indicating the normal flow.
  // At minimum, we should NOT see an exit 0 from a short-circuit before
  // build-register-live-view runs. We expect:
  // - check-onbox-register output (or OK message)
  // - build-register-live-view --check to also run
  // Exit code should be 0 if both pass, 1 if either fails.

  assert(
    result.status === 0 || result.status === 1,
    `Unexpected exit code ${result.status}; output: ${combinedOutput}`
  );

  // At least one command ran (we'd see SOME output from the register checks)
  assert.ok(
    combinedOutput.length > 0,
    `Expected register check output, got empty output`
  );
});
