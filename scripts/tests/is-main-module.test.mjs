// Tests for scripts/lib/is-main-module.mjs (#2291) — the shared
// direct-execution guard used by every dual-purpose scripts/*.mjs CLI.
//
// Two tiers:
//  - In-process unit tests exercise isDirectlyInvoked's return-value logic
//    directly, including the realpath-throws fallback, by monkeypatching
//    process.argv[1] and passing a constructed import.meta.url. This never
//    needs a real symlink/junction because the two sides are just compared
//    as strings.
//  - Real-subprocess tests are the ones that actually prove the fix: they
//    build a tiny fixture module that imports the REAL helper, then spawn it
//    through a genuine symlink (POSIX) / junction (Windows) so Node's own
//    ESM loader produces the argv[1]-vs-import.meta.url mismatch this guard
//    exists to survive — an in-process call can't reproduce that, since
//    argv[1] would just be the test runner's own path. They skip loudly,
//    with a named reason, on a filesystem that cannot create a link — never
//    silently pass.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  copyFileSync,
  rmSync,
  symlinkSync,
  rmdirSync,
  unlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { isDirectlyInvoked } from '../lib/is-main-module.mjs';

const IS_WIN = process.platform === 'win32';
const here = dirname(fileURLToPath(import.meta.url));
const helperSource = resolve(here, '..', 'lib', 'is-main-module.mjs');

// --- in-process unit tests ---

test('isDirectlyInvoked returns false when process.argv[1] is absent', () => {
  const saved = process.argv[1];
  try {
    process.argv[1] = undefined;
    assert.equal(isDirectlyInvoked(import.meta.url), false);
  } finally {
    process.argv[1] = saved;
  }
});

test('isDirectlyInvoked returns true when argv[1] and importMetaUrl name the same path', () => {
  const saved = process.argv[1];
  try {
    process.argv[1] = fileURLToPath(import.meta.url);
    assert.equal(isDirectlyInvoked(import.meta.url), true);
  } finally {
    process.argv[1] = saved;
  }
});

test('isDirectlyInvoked returns false when argv[1] names a different path', () => {
  const saved = process.argv[1];
  try {
    process.argv[1] = fileURLToPath(new URL('./is-main-module.test.other.mjs', import.meta.url));
    assert.equal(isDirectlyInvoked(import.meta.url), false);
  } finally {
    process.argv[1] = saved;
  }
});

// realpathSync throws ENOENT for a path that doesn't exist. Both sides here
// point at the SAME nonexistent path, so both realpaths fail and both fall
// back to the raw (identical) string — the guard must not throw, and must
// still resolve true.
test('isDirectlyInvoked falls back to the raw path (does not throw) when realpath fails, and still compares correctly', () => {
  const saved = process.argv[1];
  const fakeDir = join(tmpdir(), 'is-main-module-nonexistent-' + process.pid);
  const fakePath = join(fakeDir, 'ghost.mjs');
  try {
    process.argv[1] = fakePath;
    assert.doesNotThrow(() => isDirectlyInvoked(pathToFileURL(fakePath).href));
    assert.equal(isDirectlyInvoked(pathToFileURL(fakePath).href), true);
  } finally {
    process.argv[1] = saved;
  }
});

test('isDirectlyInvoked resolves false for two DIFFERENT nonexistent paths (fallback path is still a real comparison, not a wildcard)', () => {
  const saved = process.argv[1];
  const dir = join(tmpdir(), 'is-main-module-nonexistent-' + process.pid);
  try {
    process.argv[1] = join(dir, 'ghost-a.mjs');
    assert.equal(isDirectlyInvoked(pathToFileURL(join(dir, 'ghost-b.mjs')).href), false);
  } finally {
    process.argv[1] = saved;
  }
});

// --- real-subprocess symlink/junction tests ---

function removeLink(linkPath) {
  // A junction reports as a directory to Windows and must be removed with
  // rmdir, not unlink, or the delete fails outright. rmdir on a reparse
  // point removes only the link, never the target's contents — the POSIX
  // unlink of a directory symlink has the identical link-only property.
  try {
    if (IS_WIN) rmdirSync(linkPath);
    else unlinkSync(linkPath);
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
}

function probeLinkSupport() {
  const dir = mkdtempSync(join(tmpdir(), 'is-main-module-linkcheck-'));
  const target = join(dir, 'target');
  const link = join(dir, 'link');
  try {
    mkdirSync(target);
    symlinkSync(target, link, IS_WIN ? 'junction' : 'dir');
    removeLink(link);
    return null;
  } catch (err) {
    return `cannot create a ${IS_WIN ? 'junction' : 'directory symlink'} on this filesystem (the #2291 realpath-mismatch guard is untested on this run, not confirmed passing): ${err.message}`;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const LINK_SKIP_REASON = probeLinkSupport();

// Builds <root>/scripts/lib/is-main-module.mjs (byte-for-byte copy of the
// real helper) + <root>/scripts/probe.mjs, a fixture CLI that imports the
// real helper and prints DIRECT/NOT-DIRECT based on its verdict — mirroring
// the real usage shape (`if (isDirectlyInvoked(import.meta.url)) { ... }`).
function makeFixtureRoot() {
  const root = mkdtempSync(join(tmpdir(), 'is-main-module-e2e-'));
  mkdirSync(join(root, 'scripts', 'lib'), { recursive: true });
  copyFileSync(helperSource, join(root, 'scripts', 'lib', 'is-main-module.mjs'));
  writeFileSync(
    join(root, 'scripts', 'probe.mjs'),
    [
      "import { isDirectlyInvoked } from './lib/is-main-module.mjs';",
      'if (isDirectlyInvoked(import.meta.url)) {',
      "  console.log('DIRECT');",
      '} else {',
      "  console.log('NOT-DIRECT');",
      '}',
      '',
    ].join('\n'),
  );
  return root;
}

test('probe.mjs invoked through a symlink/junction still resolves DIRECT (#2291)', { skip: LINK_SKIP_REASON ?? false }, () => {
  const root = makeFixtureRoot();
  const linkContainer = mkdtempSync(join(tmpdir(), 'is-main-module-e2e-link-'));
  const linkDir = join(linkContainer, 'link');
  try {
    symlinkSync(root, linkDir, IS_WIN ? 'junction' : 'dir');
    const r = spawnSync(process.execPath, [join(linkDir, 'scripts', 'probe.mjs')], { encoding: 'utf8', windowsHide: true });
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.match(r.stdout, /^DIRECT/, `expected DIRECT through the link; got: ${JSON.stringify(r.stdout)}`);
  } finally {
    removeLink(linkDir);
    rmSync(linkContainer, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

// --preserve-symlinks-main inverts the loader: argv[1] is unchanged but
// import.meta.url now ALSO keeps the link path (instead of being realpathed)
// — the row a one-sided realpath(argv[1]) fix gets backwards. Realpathing
// BOTH sides collapses this case to the same comparison as the default one.
test('probe.mjs invoked through a symlink/junction with --preserve-symlinks-main still resolves DIRECT (#2291)', { skip: LINK_SKIP_REASON ?? false }, () => {
  const root = makeFixtureRoot();
  const linkContainer = mkdtempSync(join(tmpdir(), 'is-main-module-e2e-link-'));
  const linkDir = join(linkContainer, 'link');
  try {
    symlinkSync(root, linkDir, IS_WIN ? 'junction' : 'dir');
    const r = spawnSync(
      process.execPath,
      ['--preserve-symlinks-main', join(linkDir, 'scripts', 'probe.mjs')],
      { encoding: 'utf8', windowsHide: true },
    );
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.match(r.stdout, /^DIRECT/, `expected DIRECT through the link; got: ${JSON.stringify(r.stdout)}`);
  } finally {
    removeLink(linkDir);
    rmSync(linkContainer, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test('probe.mjs invoked with an unrelated script as argv[1] resolves NOT-DIRECT (no link needed)', () => {
  const root = makeFixtureRoot();
  try {
    // Import probe.mjs from a second, unrelated entry file so argv[1] names
    // that file rather than probe.mjs itself.
    writeFileSync(join(root, 'scripts', 'other-entry.mjs'), "import './probe.mjs';\n");
    const r = spawnSync(process.execPath, [join(root, 'scripts', 'other-entry.mjs')], { encoding: 'utf8', windowsHide: true });
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.match(r.stdout, /^NOT-DIRECT/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
