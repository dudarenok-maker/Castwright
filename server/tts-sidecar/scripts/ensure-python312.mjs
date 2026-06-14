#!/usr/bin/env node
// ensure-python312.mjs — discover / auto-install / guide a Python 3.12 interpreter
// for FRESH installs (the alpha *upgrade* path uses detect-and-reinstall, not this).
// The PURE decision (decidePythonAcquisition) is the source of truth and is unit-
// tested from server/src/tts/ensure-python312-helpers.test.ts; the guarded CLI at
// the bottom does the actual discovery / winget install / guidance I/O, which is
// best-effort and NOT unit-tested. Side-effect-guarded so importing it is inert.

import { pathToFileURL } from 'node:url';
import { spawnSync, execSync } from 'node:child_process';

/** The Python tag/version this release targets. */
export const REQUIRED_PYTHON = '3.12';

/**
 * Decide how to acquire Python 3.12 from a discovery result. Pure — no I/O.
 * Precedence: an interpreter already on PATH always wins (`use`). Otherwise, on
 * Windows with winget we auto-install; on Windows without winget we guide the
 * user to the official installer; on any other platform (Linux) we guide them to
 * their package manager — never a silent `sudo`.
 * @param {{found: string|null, platform: string, wingetAvailable: boolean}} a
 *   `found` is the working interpreter command (e.g. 'py -3.12'), or null.
 * @returns {{action:'use', cmd:string}
 *          | {action:'auto-install', method:'winget'}
 *          | {action:'guide', method:'official-installer'|'package-manager'}}
 */
export function decidePythonAcquisition({ found, platform, wingetAvailable }) {
  if (found) return { action: 'use', cmd: found };
  if (platform === 'win32') {
    return wingetAvailable
      ? { action: 'auto-install', method: 'winget' }
      : { action: 'guide', method: 'official-installer' };
  }
  return { action: 'guide', method: 'package-manager' };
}

/**
 * Discover a working Python 3.12 interpreter command, or null. Tries the candidate
 * commands in order and returns the first whose `--version` reports 3.12. I/O —
 * not unit-tested (the pure decision above is). The `py -3.12` launcher is tried
 * first on Windows (the canonical version-pinned invocation).
 * @param {string} platform process.platform
 * @returns {string|null}
 */
function discoverPython312(platform) {
  const candidates =
    platform === 'win32'
      ? [['py', ['-3.12', '--version']], ['python3.12', ['--version']], ['python', ['--version']]]
      : [['python3.12', ['--version']], ['python3', ['--version']], ['python', ['--version']]];
  for (const [bin, args] of candidates) {
    try {
      const r = spawnSync(bin, args, { encoding: 'utf8' });
      const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
      if (r.status === 0 && /Python 3\.12\./.test(out)) {
        // Report the command WITHOUT the trailing --version so callers can reuse it.
        return bin === 'py' ? 'py -3.12' : bin;
      }
    } catch {
      // try the next candidate
    }
  }
  return null;
}

/** Whether `winget` is callable. I/O — not unit-tested. */
function wingetAvailable() {
  try {
    return spawnSync('winget', ['--version'], { encoding: 'utf8' }).status === 0;
  } catch {
    return false;
  }
}

// Side-effect guard: only runs when invoked directly (`node ensure-python312.mjs`),
// stays inert on import so tests/consumers don't trigger I/O.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const platform = process.platform;
  const found = discoverPython312(platform);
  const decision = decidePythonAcquisition({ found, platform, wingetAvailable: wingetAvailable() });

  if (decision.action === 'use') {
    process.stdout.write(`${decision.cmd}\n`);
    process.exit(0);
  }

  if (decision.action === 'auto-install') {
    process.stderr.write('Python 3.12 not found — installing via winget…\n');
    try {
      execSync('winget install --id Python.Python.3.12 --source winget --accept-source-agreements --accept-package-agreements', {
        stdio: 'inherit',
      });
    } catch {
      process.stderr.write(
        'winget install failed. Install Python 3.12 from https://www.python.org/downloads/ and re-run.\n',
      );
      process.exit(1);
    }
    // H3: the freshly-installed interpreter is NOT on the running process's PATH —
    // a new shell must be started before discovery will see it. Tell the user to
    // relaunch rather than pretending we can continue in-process.
    process.stderr.write(
      'Python 3.12 installed. Open a NEW terminal (so the updated PATH takes effect) and re-run the setup.\n',
    );
    process.exit(0);
  }

  // decision.action === 'guide'
  if (decision.method === 'official-installer') {
    process.stderr.write(
      'Python 3.12 not found and winget is unavailable.\n' +
        'Install Python 3.12 from https://www.python.org/downloads/ (tick "Add python.exe to PATH"),\n' +
        'then open a NEW terminal and re-run the setup.\n',
    );
  } else {
    process.stderr.write(
      'Python 3.12 not found. Install it with your package manager, e.g.:\n' +
        '  Debian/Ubuntu:  sudo apt install python3.12 python3.12-venv\n' +
        '  Fedora:         sudo dnf install python3.12\n' +
        '  Arch:           sudo pacman -S python\n' +
        'then re-run the setup.\n',
    );
  }
  process.exit(1);
}
