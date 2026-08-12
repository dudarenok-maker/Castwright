#!/usr/bin/env node
// Cross-platform pytest entry point for the TTS sidecar.
//
// Replaces the PowerShell-only path for CI: run-tests.ps1 hardcodes
// .venv\Scripts\python.exe, a Windows layout that can never exist on
// ubuntu-latest — so a CI leg calling it would take the SKIP branch and exit
// 0 forever, i.e. be vacuously green (#2119 review, defect C).
//
// Local behaviour is unchanged: no venv still means SKIP + exit 0, so a
// fresh clone doesn't fail the gate. CI passes --require-venv to turn that
// same condition into a hard failure, because on CI a missing venv means the
// bootstrap broke, not that the developer hasn't run it yet.

import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDirectlyInvoked } from './lib/is-main-module.mjs';

const SIDECAR_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'server', 'tts-sidecar');

// platform is injected rather than read from process.platform so the layout
// probe is testable on either OS.
export function resolveVenvPython(sidecarDir, platform = process.platform) {
  const rel = platform === 'win32'
    ? ['.venv', 'Scripts', 'python.exe']
    : ['.venv', 'bin', 'python'];
  const candidate = join(sidecarDir, ...rel);
  return existsSync(candidate) ? candidate : null;
}

export function main(argv = process.argv.slice(2), sidecarDir = SIDECAR_DIR) {
  const requireVenv = argv.includes('--require-venv');
  const python = resolveVenvPython(sidecarDir);

  if (!python) {
    const msg = `sidecar pytest -- venv not found under ${sidecarDir}`;
    if (requireVenv) {
      process.stderr.write(`ERROR: ${msg}\n`);
      process.stderr.write('CI runs with --require-venv: a missing venv means the bootstrap step failed.\n');
      return 1;
    }
    process.stdout.write(`\nSKIP: ${msg}\n`);
    process.stdout.write('      Bootstrap once to enable this block in the gate:\n');
    process.stdout.write('        cd server/tts-sidecar\n');
    process.stdout.write('        python -m venv .venv\n');
    process.stdout.write('        .venv/bin/python -m pip install -r requirements.txt -r requirements-dev.txt\n\n');
    return 0;
  }

  // run-tests.ps1 also probes for pytest itself and SKIPs when a venv exists
  // but requirements-dev.txt was never installed. Without this, that box goes
  // from green-skip to RED on `npm run verify` and pre-push — a regression
  // dressed up as "local behaviour is unchanged".
  const probe = spawnSync(python, ['-m', 'pytest', '--version'], { encoding: 'utf8', windowsHide: true });
  if ((probe.status ?? 1) !== 0) {
    const msg = 'sidecar pytest -- venv present but pytest is not installed';
    if (requireVenv) {
      process.stderr.write(`ERROR: ${msg}\n`);
      return 1;
    }
    process.stdout.write(`\nSKIP: ${msg}\n`);
    process.stdout.write('        .venv/bin/python -m pip install -r requirements-dev.txt\n\n');
    return 0;
  }

  // -m "not golden" mirrors the existing runner: the opt-in golden-audio tier
  // must never load a model here. `--tb=short -q` and the explicit tests/ path
  // also mirror it, so output is comparable to the PowerShell runner's.
  const passthrough = argv.filter((a) => a !== '--require-venv');
  const result = spawnSync(
    python,
    ['-m', 'pytest', '-m', 'not golden', '--tb=short', '-q', 'tests', ...passthrough],
    { cwd: sidecarDir, stdio: 'inherit', windowsHide: true },
  );
  if (result.error) {
    process.stderr.write(`run-sidecar-tests: failed to spawn python: ${result.error.message}\n`);
    return 1;
  }
  return result.status ?? 1;
}

// Guarded so tests can import resolveVenvPython/main without running pytest.
// See scripts/lib/is-main-module.mjs (#2291) for the symlink/junction
// mechanism this guards against — first found here via GitHub's
// macos-latest CI runner, where it cost days of red cross-OS CI.
if (isDirectlyInvoked(import.meta.url)) {
  process.exit(main());
}
