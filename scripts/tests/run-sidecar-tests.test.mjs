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

function findRealPython() {
  const candidates = IS_WIN
    ? [['python', []], ['py', ['-3']]]
    : [['python3', []], ['python', []]];
  for (const [cmd, baseArgs] of candidates) {
    const probe = spawnSync(cmd, [...baseArgs, '-c', 'import sys; print(sys.executable)'], {
      encoding: 'utf8',
    });
    const exe = probe.status === 0 ? probe.stdout.trim() : null;
    if (exe && worksWhenRelocated(exe)) return exe;
  }
  throw new Error(
    'No python interpreter on PATH (python / py -3 / python3) survives being relocated via ' +
      'hardlink/copy — cannot build the test fixture. A portable/embeddable Python install ' +
      "resolves its stdlib relative to its own exe path and won't work here; a traditional " +
      'installer-based CPython is required.',
  );
}
const REAL_PYTHON = findRealPython();

// Builds <tmp>/scripts/run-sidecar-tests.mjs as a byte-for-byte copy of the
// real script. Its own SIDECAR_DIR resolution then lands on
// <tmp>/server/tts-sidecar, matching what makeFakeVenv() below builds there.
function makeFixtureRoot() {
  const root = mkdtempSync(join(tmpdir(), 'sidecar-e2e-'));
  mkdirSync(join(root, 'scripts'), { recursive: true });
  writeFileSync(join(root, 'scripts', 'run-sidecar-tests.mjs'), readFileSync(runnerScript, 'utf8'));
  return root;
}

function runEntryPoint(root, args, env = {}) {
  return spawnSync(process.execPath, [join(root, 'scripts', 'run-sidecar-tests.mjs'), ...args], {
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

test('run-sidecar-tests.mjs (real CLI): --require-venv + absent venv -> exit 1 (fail-closed guard)', () => {
  const root = makeFixtureRoot();
  try {
    const out = runEntryPoint(root, ['--require-venv']);
    assert.equal(out.status, 1);
    assert.match(out.stderr, /ERROR: sidecar pytest -- venv not found/);
  } finally {
    cleanup(root);
  }
});

test('run-sidecar-tests.mjs (real CLI): absent venv, no flag -> exit 0 with the SKIP banner', () => {
  const root = makeFixtureRoot();
  try {
    const out = runEntryPoint(root, []);
    assert.equal(out.status, 0);
    assert.match(out.stdout, /SKIP: sidecar pytest -- venv not found/);
  } finally {
    cleanup(root);
  }
});

test('run-sidecar-tests.mjs (real CLI): venv present, pytest not usable, no flag -> exit 0 with the SKIP banner', () => {
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

test('run-sidecar-tests.mjs (real CLI): venv present, pytest not usable, --require-venv -> exit 1', () => {
  const root = makeFixtureRoot();
  const { pythonPathDir } = makeFakeVenv(root, BROKEN_PYTEST);
  try {
    const out = runEntryPoint(root, ['--require-venv'], { PYTHONPATH: pythonPathDir });
    assert.equal(out.status, 1);
  } finally {
    cleanup(root, pythonPathDir);
  }
});

test("run-sidecar-tests.mjs (real CLI): pytest exit 0 propagates as the CLI's exit code 0 (pass)", () => {
  const root = makeFixtureRoot();
  const { pythonPathDir } = makeFakeVenv(root, CONTROLLABLE_PYTEST);
  try {
    const out = runEntryPoint(root, [], { PYTHONPATH: pythonPathDir, STUB_PYTEST_EXIT_CODE: '0' });
    assert.equal(out.status, 0);
  } finally {
    cleanup(root, pythonPathDir);
  }
});

test("run-sidecar-tests.mjs (real CLI): pytest's non-zero exit code propagates as the CLI's exit code (fail)", () => {
  const root = makeFixtureRoot();
  const { pythonPathDir } = makeFakeVenv(root, CONTROLLABLE_PYTEST);
  try {
    const out = runEntryPoint(root, [], { PYTHONPATH: pythonPathDir, STUB_PYTEST_EXIT_CODE: '7' });
    assert.equal(out.status, 7);
  } finally {
    cleanup(root, pythonPathDir);
  }
});

test('run-sidecar-tests.mjs (real CLI): a python.exe that exists but is not a valid executable never reports exit 0', () => {
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
