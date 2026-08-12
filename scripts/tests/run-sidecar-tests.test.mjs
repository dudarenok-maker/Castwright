import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  linkSync,
  copyFileSync,
  rmSync,
  symlinkSync,
  rmdirSync,
  unlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { resolveVenvPython } from '../run-sidecar-tests.mjs';

function fixture(relPath) {
  const dir = mkdtempSync(join(tmpdir(), 'sidecar-'));
  const abs = join(dir, ...relPath.split('/'));
  mkdirSync(join(abs, '..'), { recursive: true });
  writeFileSync(abs, '', 'utf8');
  return dir;
}

test('resolveVenvPython finds the POSIX venv layout', () => {
  const dir = fixture('.venv/bin/python');
  assert.equal(resolveVenvPython(dir, 'linux'), join(dir, '.venv', 'bin', 'python'));
});

test('resolveVenvPython finds the Windows venv layout', () => {
  const dir = fixture('.venv/Scripts/python.exe');
  assert.equal(resolveVenvPython(dir, 'win32'), join(dir, '.venv', 'Scripts', 'python.exe'));
});

test('resolveVenvPython returns null when no venv exists', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sidecar-'));
  assert.equal(resolveVenvPython(dir, 'linux'), null);
});

// A POSIX venv must not be found by the Windows probe and vice versa —
// otherwise the runner would report a venv it cannot execute.
test('resolveVenvPython does not cross platforms', () => {
  const posix = fixture('.venv/bin/python');
  assert.equal(resolveVenvPython(posix, 'win32'), null);
});

// --- main()'s exit-code contract, exercised via the real CLI ---
//
// The tests above only cover resolveVenvPython's layout detection. Nothing
// exercised the actual --require-venv fail-closed guard, the SKIP/exit-0
// fresh-clone path, or pytest's exit code propagating through main(). Per
// review: "No automated regression coverage for main()'s exit-code
// contract... a later edit could silently flip it fail-open and no suite
// would notice."
//
// SIDECAR_DIR inside run-sidecar-tests.mjs is computed relative to the
// script's OWN file location (import.meta.url), not cwd or an argument, so
// there is no existing lever to point a spawned real invocation at a fixture
// directory. Rather than add one (a new production interface solely for
// test convenience), this mirrors the exact technique already used in this
// same directory by bump-version.test.mjs's setupRepo(): copy the real
// script, byte for byte, into a throwaway tree with the SAME relative
// scripts/ -> server/tts-sidecar/ layout the real repo has, then spawn
// `node <fixture>/scripts/run-sidecar-tests.mjs` for real. This is the
// literal shipped entry point running end to end — argv parsing, the
// direct-execution guard, process.exit(), real spawnSync calls to a real
// interpreter — against a controlled, hermetic fixture. No mock stands in
// for any part of the thing under test.
const here = dirname(fileURLToPath(import.meta.url));
const runnerScript = resolve(here, '..', 'run-sidecar-tests.mjs');

const IS_WIN = process.platform === 'win32';
const VENV_PY_REL = IS_WIN ? ['.venv', 'Scripts', 'python.exe'] : ['.venv', 'bin', 'python'];

// A stub "python" must be a real, launchable OS executable — a plain text
// file cannot be exec'd directly (proven directly by the "not a valid
// executable" test below, which deliberately exploits that on purpose).
// Rather than invent one, hardlink (falling back to a copy, e.g. across
// volumes) the real interpreter already on PATH into the fake venv layout,
// then steer its behaviour via a `pytest.py` placed on PYTHONPATH. Python
// inserts PYTHONPATH entries ahead of site-packages, so this shadows a REAL
// installed pytest reliably — verified directly: this box's system Python
// already has pytest 9.1.1 installed globally, so a test relying on pytest
// being merely *absent* would have been non-deterministic across boxes.
//
// Discovery self-verifies each candidate rather than trusting the first one
// found: on this box, `py -3` resolves to a portable/embeddable Python 3.14
// install (AppData/Local/Python/pythoncore-3.14-64) whose startup bootstrap
// locates its own stdlib (python3XX.zip/DLLs/Lib) RELATIVE TO its own exe
// path — hardlinking it into a fixture directory silently breaks that
// lookup (the interpreter fails to start at all, which surfaced as an
// always-fails probe, not an exception). A traditional installer-based
// CPython (found via the plain `python` command here) resolves its stdlib
// via a fixed prefix instead, so relocation via hardlink/copy is safe. Since
// which interpreter a given box's PATH resolves first cannot be assumed,
// each candidate is proven by actually relocating it and running it before
// it's trusted, rather than just reordering the candidate list.
function worksWhenRelocated(pythonExe) {
  const dir = mkdtempSync(join(tmpdir(), 'sidecar-pycheck-'));
  const rel = IS_WIN ? ['relocated.exe'] : ['relocated'];
  const target = join(dir, ...rel);
  try {
    try {
      linkSync(pythonExe, target);
    } catch {
      copyFileSync(pythonExe, target);
    }
    const probe = spawnSync(target, ['--version'], { encoding: 'utf8' });
    return probe.status === 0;
  } catch {
    return false;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// Returns { exe, attempts } rather than throwing: this runs at module scope,
// and node:test treats an uncaught module-load error as the WHOLE FILE
// failing as one unit — which would take the four resolveVenvPython layout
// tests above down with it, even though they need no Python at all. `attempts`
// records exactly which candidate was tried and how each one failed, so a
// caller can print a specific, non-silent reason rather than just "skipped".
function findRealPython() {
  const candidates = IS_WIN
    ? [['python', []], ['py', ['-3']]]
    : [['python3', []], ['python', []]];
  const attempts = [];
  for (const [cmd, baseArgs] of candidates) {
    const label = [cmd, ...baseArgs].join(' ');
    const probe = spawnSync(cmd, [...baseArgs, '-c', 'import sys; print(sys.executable)'], {
      encoding: 'utf8',
    });
    if (probe.error) {
      attempts.push(`${label}: not found on PATH (${probe.error.code ?? probe.error.message})`);
      continue;
    }
    if (probe.status !== 0 || !probe.stdout.trim()) {
      attempts.push(`${label}: ran but did not report an interpreter (exit code ${probe.status})`);
      continue;
    }
    const exe = probe.stdout.trim();
    if (!worksWhenRelocated(exe)) {
      attempts.push(
        `${label} -> ${exe}: found, but does not survive being relocated via hardlink/copy ` +
          '(likely a portable/embeddable install that resolves its stdlib relative to its own exe path)',
      );
      continue;
    }
    return { exe, attempts: [] };
  }
  return { exe: null, attempts };
}

// Computed once at module load (a couple of cheap spawnSync probes) and
// shared by all 7 CLI-level tests below rather than rebuilt per test.
// PYTHON_SKIP_REASON is null (falsy) whenever a usable interpreter WAS
// found, so `{ skip: PYTHON_SKIP_REASON ?? false }` only ever skips for the
// real, reproducible cause — never unconditionally.
const PYTHON_DISCOVERY = findRealPython();
const REAL_PYTHON = PYTHON_DISCOVERY.exe;
const PYTHON_SKIP_REASON = REAL_PYTHON
  ? null
  : [
      'no relocatable Python interpreter available to build the CLI-level fixture (main()\'s',
      'exit-code contract is untested on this run, not confirmed passing). Tried:',
      ...PYTHON_DISCOVERY.attempts.map((a) => `  - ${a}`),
    ].join('\n');

// --- symlink/junction capability probe (#2291), mirrors PYTHON_SKIP_REASON's
// shape immediately above ---
//
// Node's ESM loader realpaths the main entry point before deriving
// import.meta.url, but process.argv[1] keeps the path exactly as invoked. So
// when the invocation path runs through a symlink (POSIX) or a junction
// (Windows — the admin-rights-free equivalent, used here so this runs on a
// stock CI box), the two hrefs differ, the direct-execution guard in
// run-sidecar-tests.mjs misses, and main() silently never runs — exit 0,
// empty stdout/stderr. The test below reproduces that locally.
//
// Probed once at module load rather than assumed: a filesystem that can't
// create a symlink/junction (e.g. some FAT-formatted mounts, or a POSIX box
// without symlink privilege) must SKIP with a specific, named reason —
// never silently pass because the repro itself couldn't be built.
function removeLink(linkPath) {
  // A junction reports as a directory to Windows (FILE_ATTRIBUTE_REPARSE_POINT
  // | FILE_ATTRIBUTE_DIRECTORY) and must be removed with rmdir, not unlink, or
  // the delete fails outright. rmdir on a reparse point removes only the link,
  // never the target's contents — the POSIX unlink of a directory symlink has
  // the identical link-only property.
  //
  // Tolerate ENOENT (link does not exist) so callers can safely call this in
  // a finally block without masking the real error if symlinkSync threw before
  // creating the link. A genuine removal failure (EACCES, etc.) still surfaces.
  try {
    if (IS_WIN) {
      rmdirSync(linkPath);
    } else {
      unlinkSync(linkPath);
    }
  } catch (err) {
    if (err.code !== 'ENOENT') {
      throw err;
    }
  }
}

function probeLinkSupport() {
  const dir = mkdtempSync(join(tmpdir(), 'sidecar-linkcheck-'));
  const target = join(dir, 'target');
  const link = join(dir, 'link');
  try {
    mkdirSync(target);
    symlinkSync(target, link, IS_WIN ? 'junction' : 'dir');
    removeLink(link);
    return null;
  } catch (err) {
    return [
      `cannot create a ${IS_WIN ? 'junction' : 'directory symlink'} on this filesystem `
        + "(main()'s realpath-mismatch guard from #2291 is untested on this run, not confirmed",
      `passing): ${err.message}`,
    ].join('\n');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const LINK_SKIP_REASON = probeLinkSupport();

// Builds <tmp>/scripts/run-sidecar-tests.mjs as a byte-for-byte copy of the
// real script. Its own SIDECAR_DIR resolution then lands on
// <tmp>/server/tts-sidecar, matching what makeFakeVenv() below builds there.
//
// #2291 — run-sidecar-tests.mjs now imports ./lib/is-main-module.mjs (the
// shared direct-execution guard); mirror it too, or the throwaway script
// crashes on module resolution (same technique bump-version.test.mjs's
// setupRepo() uses for the same reason).
function makeFixtureRoot() {
  const root = mkdtempSync(join(tmpdir(), 'sidecar-e2e-'));
  mkdirSync(join(root, 'scripts'), { recursive: true });
  writeFileSync(join(root, 'scripts', 'run-sidecar-tests.mjs'), readFileSync(runnerScript, 'utf8'));
  mkdirSync(join(root, 'scripts', 'lib'), { recursive: true });
  writeFileSync(
    join(root, 'scripts', 'lib', 'is-main-module.mjs'),
    readFileSync(resolve(here, '..', 'lib', 'is-main-module.mjs'), 'utf8'),
  );
  return root;
}

function runEntryPoint(root, args, env = {}, execArgv = []) {
  return spawnSync(process.execPath, [...execArgv, join(root, 'scripts', 'run-sidecar-tests.mjs'), ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
}

// pytestSource is written to <pythonPathDir>/pytest.py; omit it to build a
// venv with no PYTHONPATH shim at all (used by the "not a valid executable"
// test, which never gets far enough to import anything).
function makeFakeVenv(root, pytestSource) {
  const sidecarDir = join(root, 'server', 'tts-sidecar');
  const pyPath = join(sidecarDir, ...VENV_PY_REL);
  mkdirSync(dirname(pyPath), { recursive: true });
  try {
    linkSync(REAL_PYTHON, pyPath);
  } catch {
    copyFileSync(REAL_PYTHON, pyPath);
  }
  mkdirSync(join(sidecarDir, 'tests'), { recursive: true });
  let pythonPathDir = null;
  if (pytestSource !== undefined) {
    pythonPathDir = mkdtempSync(join(tmpdir(), 'sidecar-pypath-'));
    writeFileSync(join(pythonPathDir, 'pytest.py'), pytestSource, 'utf8');
  }
  return { sidecarDir, pythonPathDir };
}

function cleanup(...dirs) {
  for (const dir of dirs) {
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
}

// A fake pytest.py that behaves like real pytest closely enough for main()'s
// two spawnSync calls to be told apart: succeeds (and prints a version
// string) for `--version`, otherwise exits with a controlled code from an
// env var.
const CONTROLLABLE_PYTEST = `
import sys, os
if '--version' in sys.argv:
    print('pytest 9.1.1 (stub)')
    sys.exit(0)
else:
    sys.exit(int(os.environ.get('STUB_PYTEST_EXIT_CODE', '0')))
`;

// A fake pytest.py that is importable but always fails --version — this is
// how "pytest present in the venv but not usable" is simulated, since
// main()'s code does not distinguish "not installed" from "installed but
// broken": both hit the identical `(probe.status ?? 1) !== 0` branch.
const BROKEN_PYTEST = 'import sys\nsys.exit(1)\n';

test('run-sidecar-tests.mjs (real CLI): --require-venv + absent venv -> exit 1 (fail-closed guard)', { skip: PYTHON_SKIP_REASON ?? false }, () => {
  const root = makeFixtureRoot();
  try {
    const out = runEntryPoint(root, ['--require-venv']);
    assert.equal(out.status, 1);
    assert.match(out.stderr, /ERROR: sidecar pytest -- venv not found/);
  } finally {
    cleanup(root);
  }
});

test('run-sidecar-tests.mjs (real CLI): absent venv, no flag -> exit 0 with the SKIP banner', { skip: PYTHON_SKIP_REASON ?? false }, () => {
  const root = makeFixtureRoot();
  try {
    const out = runEntryPoint(root, []);
    assert.equal(out.status, 0);
    assert.match(out.stdout, /SKIP: sidecar pytest -- venv not found/);
  } finally {
    cleanup(root);
  }
});

test('run-sidecar-tests.mjs (real CLI): venv present, pytest not usable, no flag -> exit 0 with the SKIP banner', { skip: PYTHON_SKIP_REASON ?? false }, () => {
  const root = makeFixtureRoot();
  const { pythonPathDir } = makeFakeVenv(root, BROKEN_PYTEST);
  try {
    const out = runEntryPoint(root, [], { PYTHONPATH: pythonPathDir });
    assert.equal(out.status, 0);
    assert.match(out.stdout, /SKIP: sidecar pytest -- venv present but pytest is not installed/);
  } finally {
    cleanup(root, pythonPathDir);
  }
});

test('run-sidecar-tests.mjs (real CLI): venv present, pytest not usable, --require-venv -> exit 1', { skip: PYTHON_SKIP_REASON ?? false }, () => {
  const root = makeFixtureRoot();
  const { pythonPathDir } = makeFakeVenv(root, BROKEN_PYTEST);
  try {
    const out = runEntryPoint(root, ['--require-venv'], { PYTHONPATH: pythonPathDir });
    assert.equal(out.status, 1);
  } finally {
    cleanup(root, pythonPathDir);
  }
});

test("run-sidecar-tests.mjs (real CLI): pytest exit 0 propagates as the CLI's exit code 0 (pass)", { skip: PYTHON_SKIP_REASON ?? false }, () => {
  const root = makeFixtureRoot();
  const { pythonPathDir } = makeFakeVenv(root, CONTROLLABLE_PYTEST);
  try {
    const out = runEntryPoint(root, [], { PYTHONPATH: pythonPathDir, STUB_PYTEST_EXIT_CODE: '0' });
    assert.equal(out.status, 0);
  } finally {
    cleanup(root, pythonPathDir);
  }
});

test("run-sidecar-tests.mjs (real CLI): pytest's non-zero exit code propagates as the CLI's exit code (fail)", { skip: PYTHON_SKIP_REASON ?? false }, () => {
  const root = makeFixtureRoot();
  const { pythonPathDir } = makeFakeVenv(root, CONTROLLABLE_PYTEST);
  try {
    const out = runEntryPoint(root, [], { PYTHONPATH: pythonPathDir, STUB_PYTEST_EXIT_CODE: '7' });
    assert.equal(out.status, 7);
  } finally {
    cleanup(root, pythonPathDir);
  }
});

test('run-sidecar-tests.mjs (real CLI): a python.exe that exists but is not a valid executable never reports exit 0', { skip: PYTHON_SKIP_REASON ?? false }, () => {
  // Exploits a real OS-level failure mode directly: on Windows, a file named
  // *.exe that is not a valid PE image cannot be launched at all (spawnSync
  // sets .error); on POSIX, a non-executable file fails the same way. This
  // is a genuine, hermetic spawn failure — not a mock standing in for one.
  const root = makeFixtureRoot();
  const sidecarDir = join(root, 'server', 'tts-sidecar');
  const pyPath = join(sidecarDir, ...VENV_PY_REL);
  mkdirSync(dirname(pyPath), { recursive: true });
  writeFileSync(pyPath, 'not a real executable', 'utf8');
  try {
    const out = runEntryPoint(root, ['--require-venv']);
    assert.notEqual(out.status, 0);
  } finally {
    cleanup(root);
  }
});

test('run-sidecar-tests.mjs (real CLI): invoked through a symlink/junction still runs main() (#2291)', { skip: LINK_SKIP_REASON ?? false }, () => {
  // Reproduces the macOS-runner bug directly: `root` holds the real fixture
  // (scripts/run-sidecar-tests.mjs + server/tts-sidecar/...); `linkDir` is a
  // symlink/junction pointing AT root. Invoking the script via
  // <linkDir>/scripts/run-sidecar-tests.mjs gives argv[1] the linked path
  // while Node's ESM loader realpaths it for import.meta.url — the exact
  // mismatch that made the entry-point guard miss on GitHub's macos-latest
  // runner (tmpdir() under /var, itself a symlink to /private/var).
  //
  // No venv is created, so this is the SAME assertion as the very first CLI
  // test above (--require-venv + absent venv -> exit 1 with the ERROR
  // banner) — proving main() actually ran, not just that the process exited
  // non-zero for some unspecified reason. Before the fix this fails with
  // exit 0 and empty stderr: the guard missed and main() never ran at all.
  const root = makeFixtureRoot();
  const linkContainer = mkdtempSync(join(tmpdir(), 'sidecar-e2e-link-'));
  const linkDir = join(linkContainer, 'link');
  try {
    symlinkSync(root, linkDir, IS_WIN ? 'junction' : 'dir');
    const out = runEntryPoint(linkDir, ['--require-venv']);
    assert.equal(out.status, 1);
    assert.match(out.stderr, /ERROR: sidecar pytest -- venv not found/);
  } finally {
    removeLink(linkDir);
    rmSync(linkContainer, { recursive: true, force: true });
    cleanup(root);
  }
});

test('run-sidecar-tests.mjs (real CLI): invoked through a symlink/junction with --preserve-symlinks-main still runs main() (#2291)', { skip: LINK_SKIP_REASON ?? false }, () => {
  // Node's --preserve-symlinks-main flag inverts the loader's behaviour: it
  // keeps the invoked path (argv[1]) as-is instead of realpath'ing it, while
  // import.meta.url still derives from the realpath'd entry. Without a
  // symmetric comparison (realpath'ing BOTH sides), the guard misses again and
  // main() silently never runs — exit 0 and empty stderr, the same failure mode
  // as without the fix. This test ensures the fix handles both cases.
  const root = makeFixtureRoot();
  const linkContainer = mkdtempSync(join(tmpdir(), 'sidecar-e2e-link-'));
  const linkDir = join(linkContainer, 'link');
  try {
    symlinkSync(root, linkDir, IS_WIN ? 'junction' : 'dir');
    const out = runEntryPoint(linkDir, ['--require-venv'], {}, ['--preserve-symlinks-main']);
    assert.equal(out.status, 1);
    assert.match(out.stderr, /ERROR: sidecar pytest -- venv not found/);
  } finally {
    removeLink(linkDir);
    rmSync(linkContainer, { recursive: true, force: true });
    cleanup(root);
  }
});
