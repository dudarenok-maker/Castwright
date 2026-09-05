// PR review finding 1 (entry-point-guard convention branch): launch.mjs
// previously imported the shared direct-execution-guard helper via
// `import { isDirectlyInvoked } from './scripts/lib/is-main-module.mjs'`.
// That resolves fine in a plain dev checkout (where scripts/lib/ sits right
// next to launch.mjs) and even in a repo-link/junction (the shape
// entry-point-guards.test.mjs's other tests exercise) — but NOT at the
// documented versioned-install layout launch.mjs's own header describes:
//
//   <install>/launch.mjs            <- this file (stable, never replaced)
//   <install>/.current-version      <- pointer, e.g. "1.6.0"
//   <install>/releases/v1.6.0/...   <- a release == the contents of one zip
//
// scripts/lib/ only ever exists under <install>/releases/vX.Y.Z/, never at
// <install>/scripts/ — scripts/setup-versioned-install.mjs's own
// computeSetupPlan only copies launch.mjs itself to the install root, not
// scripts/. So the relative import used to resolve to a path that is never
// there, crashing at IMPORT TIME with ERR_MODULE_NOT_FOUND before launch.mjs
// prints anything — invisibly, since server/src/upgrade/apply.ts's
// restart-after-upgrade.mjs spawns this file detached with
// stdio: 'ignore', so the upgrade reports success and the app just never
// comes back.
//
// The fix inlines a correct both-sides-realpath guard directly in
// launch.mjs (it deliberately does NOT depend on scripts/lib/is-main-module.mjs
// — see the comment by launch.mjs's own isDirectlyInvoked for why). This
// test builds the documented install layout in a temp dir and proves
// launch.mjs boots there — not merely that a bare copy runs from the repo
// (that was never broken; see entry-point-guards.test.mjs), but that it
// runs from the split layout where scripts/lib/ is absent at the install
// root and only launch.mjs itself sits there.
//
// The release's start script is a trivial stub (not the real
// start-app-prod.mjs) — this test is only about whether launch.mjs ITSELF
// survives import + boot at this layout and correctly hands off to
// whatever the pointer names, not about the full app boot chain.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(here, '..', '..');

/**
 * Builds:
 *   <install>/launch.mjs
 *   <install>/.current-version        ("0.0.0-test")
 *   <install>/releases/v0.0.0-test/scripts/start-app-prod.mjs  (stub)
 * — exactly the split scripts/setup-versioned-install.mjs's computeSetupPlan
 * produces (copyFile of launch.mjs to the install root; the release's own
 * code, including its scripts/, only under releases/vX.Y.Z/). Critically,
 * there is NO <install>/scripts/ directory — that absence is the whole bug.
 */
function buildVersionedInstall() {
  const installRoot = mkdtempSync(join(tmpdir(), 'launch-install-layout-'));
  cpSync(join(REPO_ROOT, 'launch.mjs'), join(installRoot, 'launch.mjs'));
  writeFileSync(join(installRoot, '.current-version'), '0.0.0-test');
  const releaseDir = join(installRoot, 'releases', 'v0.0.0-test');
  mkdirSync(join(releaseDir, 'scripts'), { recursive: true });
  writeFileSync(join(releaseDir, 'scripts', 'start-app-prod.mjs'), "console.log('STUB-STARTED');\n");
  return installRoot;
}

test('launch.mjs boots at the documented versioned-install layout (scripts/lib/ absent at the install root)', () => {
  const installRoot = buildVersionedInstall();
  try {
    const r = spawnSync(process.execPath, [join(installRoot, 'launch.mjs')], { encoding: 'utf8', windowsHide: true });
    assert.doesNotMatch(
      r.stderr,
      /ERR_MODULE_NOT_FOUND/,
      `launch.mjs must not depend on a module that only ships inside releases/vX.Y.Z/ ` +
        `(it lives outside that directory) — stderr: ${r.stderr}`,
    );
    assert.equal(r.status, 0, `expected launch.mjs to boot and hand off cleanly; stdout: ${r.stdout} stderr: ${r.stderr}`);
    assert.match(r.stdout, /\[launch\] starting release v0\.0\.0-test from/);
    assert.match(r.stdout, /STUB-STARTED/, 'launch.mjs must actually spawn the pointed-at release script');
  } finally {
    rmSync(installRoot, { recursive: true, force: true });
  }
});

test('launch.mjs still runs as a plain dev-checkout no-op (unaffected by the install-layout fix)', () => {
  // Regression guard for the OTHER documented mode: no releases/ +
  // .current-version markers -> NO-OP that runs the LOCAL
  // scripts/start-app-prod.mjs unchanged. Uses its own throwaway fixture
  // (a stub scripts/start-app-prod.mjs) rather than spawning the real repo's
  // start-app-prod.mjs — that script may try to boot a real server if this
  // checkout happens to have a built dist/ (see entry-point-guards.test.mjs's
  // own comment on exactly this hazard), which this test must not risk.
  const installRoot = mkdtempSync(join(tmpdir(), 'launch-dev-mode-'));
  try {
    cpSync(join(REPO_ROOT, 'launch.mjs'), join(installRoot, 'launch.mjs'));
    mkdirSync(join(installRoot, 'scripts'), { recursive: true });
    writeFileSync(join(installRoot, 'scripts', 'start-app-prod.mjs'), "console.log('STUB-STARTED');\n");
    const r = spawnSync(process.execPath, [join(installRoot, 'launch.mjs')], { encoding: 'utf8', windowsHide: true });
    assert.doesNotMatch(r.stderr, /ERR_MODULE_NOT_FOUND/, `stderr: ${r.stderr}`);
    assert.equal(r.status, 0, `stdout: ${r.stdout} stderr: ${r.stderr}`);
    assert.match(r.stdout, /\[launch\] dev checkout \(no releases\/ \+ \.current-version\)/);
    assert.match(r.stdout, /STUB-STARTED/);
  } finally {
    rmSync(installRoot, { recursive: true, force: true });
  }
});
