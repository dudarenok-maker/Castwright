// PR review finding 2 (entry-point-guard convention branch, second pass):
// launch.mjs carries its OWN inline copy of the #2291 direct-execution
// guard (deliberately — see the comment by its own isDirectlyInvoked() for
// why it cannot import scripts/lib/is-main-module.mjs) and is the one entry
// in ALLOWLIST_EXTRA (scripts/tests/entry-point-guard-convention.test.mjs)
// excused from that scan for exactly that reason. Nothing behavioural ever
// proved the inline copy still WORKS, though:
//   - launch-install-layout.test.mjs spawns launch.mjs directly (no
//     junction anywhere in that path).
//   - launch.test.mjs is pure-unit — it imports planLaunch() etc., never
//     spawns the file at all.
//   - entry-point-guards.test.mjs's real-junction/symlink coverage is for
//     the four scripts/*.mjs sites migrated to the SHARED helper; launch.mjs
//     is explicitly out of scope there (it doesn't import that helper).
//   - ALLOWLIST_EXTRA's own "not-vacuous" check only asserts the file still
//     references both raw ingredients (import.meta.url, process.argv[1]) —
//     a naive, un-realpathed guard satisfies that just as well as a correct
//     one.
// A reviewer demonstrated the gap directly: regressing launch.mjs's inline
// isDirectlyInvoked() to the naive
// `import.meta.url === pathToFileURL(process.argv[1]).href` form (the exact
// #2291 bug) left the WHOLE suite green on Windows, while
// `node <junction>/launch.mjs` silently gave exit 0 and 0 bytes of stdout
// (main() never ran). This is not academic: restart-after-upgrade.mjs spawns
// launch.mjs detached with stdio: 'ignore', so in production this failure
// mode is invisible — the upgrade reports success and the app never comes
// back.
//
// Mirrors entry-point-guards.test.mjs's capability-probe convention: skip
// (with a NAMED reason, never silently) when this filesystem can't create a
// junction/symlink.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, rmdirSync, unlinkSync, writeFileSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const IS_WIN = process.platform === 'win32';
const here = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(here, '..', '..');

function removeLink(linkPath) {
  try {
    if (IS_WIN) rmdirSync(linkPath);
    else unlinkSync(linkPath);
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
}

function probeLinkSupport() {
  const dir = mkdtempSync(join(tmpdir(), 'launch-junction-linkcheck-'));
  const target = join(dir, 'target');
  const link = join(dir, 'link');
  try {
    mkdirSync(target);
    symlinkSync(target, link, IS_WIN ? 'junction' : 'dir');
    removeLink(link);
    return null;
  } catch (err) {
    return `cannot create a ${IS_WIN ? 'junction' : 'directory symlink'} on this filesystem (launch.mjs's junction guard is untested on this run, not confirmed passing): ${err.message}`;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const LINK_SKIP_REASON = probeLinkSupport();

// A standalone dev-mode fixture (no releases/ + .current-version markers —
// see launch-install-layout.test.mjs's own "dev-checkout no-op" test for the
// same shape) rather than junctioning this checkout directly. Node's ESM
// loader realpaths the entry module before computing import.meta.url, so
// launch.mjs's own dirname(fileURLToPath(...)) always resolves to the REAL
// fixture root regardless of the junction — junctioning only a *container*
// around the real repo can't relocate that (see entry-point-guards.test.mjs's
// start-app-prod.mjs fixture comment for the identical reasoning). A stub
// scripts/start-app-prod.mjs also avoids the hazard of this checkout's real
// one trying to boot a server when a built dist/ happens to exist.
function buildFixture() {
  const fixtureRoot = mkdtempSync(join(tmpdir(), 'launch-junction-fixture-'));
  cpSync(join(REPO_ROOT, 'launch.mjs'), join(fixtureRoot, 'launch.mjs'));
  mkdirSync(join(fixtureRoot, 'scripts'), { recursive: true });
  writeFileSync(join(fixtureRoot, 'scripts', 'start-app-prod.mjs'), "console.log('STUB-STARTED');\n");
  return fixtureRoot;
}

function runThroughJunction(nodeArgs = []) {
  const fixtureRoot = buildFixture();
  const container = mkdtempSync(join(tmpdir(), 'launch-junction-link-'));
  const linkPath = join(container, 'install-link');
  try {
    symlinkSync(fixtureRoot, linkPath, IS_WIN ? 'junction' : 'dir');
    const target = join(linkPath, 'launch.mjs');
    return spawnSync(process.execPath, [...nodeArgs, target], { encoding: 'utf8' });
  } finally {
    removeLink(linkPath);
    rmSync(container, { recursive: true, force: true });
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
}

function assertRanForReal(r) {
  // The pre-fix (naive, un-realpathed) bug through a junction was exit 0
  // with 0 bytes of stdout — main() silently never running.
  assert.equal(r.status, 0, `stdout: ${r.stdout} stderr: ${r.stderr}`);
  assert.notEqual(r.stdout.length, 0, 'expected non-empty stdout; got 0 bytes (the #2291 silent no-op)');
  assert.match(r.stdout, /\[launch\] dev checkout \(no releases\/ \+ \.current-version\)/);
  assert.match(r.stdout, /STUB-STARTED/, 'launch.mjs must actually spawn the pointed-at script');
}

test(
  'launch.mjs invoked through a junction/symlink still runs main() (#2291, inline guard)',
  { skip: LINK_SKIP_REASON ?? false },
  () => {
    assertRanForReal(runThroughJunction());
  },
);

test(
  'launch.mjs invoked through a junction/symlink under --preserve-symlinks-main still runs main() (#2291, inline guard)',
  { skip: LINK_SKIP_REASON ?? false },
  () => {
    // Per launch.mjs's own header table: with --preserve-symlinks-main,
    // BOTH process.argv[1] and import.meta.url stay unrealpathed (the link
    // path), where the default flagless invocation above only realpaths
    // import.meta.url. A correct guard realpaths both sides itself, so both
    // invocation shapes converge on the same real path either way.
    assertRanForReal(runThroughJunction(['--preserve-symlinks-main']));
  },
);
