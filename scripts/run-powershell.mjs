#!/usr/bin/env node
// Run a PowerShell script across Windows / macOS / Linux. Picks `pwsh`
// (PowerShell 7+, cross-platform) when available — on POSIX it's the only
// option, on Windows it's the modern default. Falls back to `powershell.exe`
// (Windows PowerShell 5.1) on Windows when `pwsh` isn't installed; this keeps
// the maintainer's local environment working without a hard `pwsh` prereq.
//
// Usage:
//   node scripts/run-powershell.mjs <script.ps1> [args...]
//
// Exits with the script's own exit code. Stdio is inherited so output streams
// live (Pester pretty-prints, pytest banners).

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';

const [, , scriptPath, ...rest] = process.argv;
if (!scriptPath) {
  process.stderr.write('run-powershell: missing script path argument\n');
  process.exit(2);
}
if (!existsSync(scriptPath)) {
  process.stderr.write(`run-powershell: script not found: ${scriptPath}\n`);
  process.exit(2);
}

function which(cmd) {
  // `spawnSync('cmd', ['--version'])` returns ENOENT when the binary isn't
  // on PATH. We don't need version output, only "does it resolve."
  const r = spawnSync(cmd, ['-NoProfile', '-Command', '$null'], {
    stdio: 'ignore',
  });
  return r.error == null;
}

function pick() {
  if (which('pwsh')) return 'pwsh';
  if (process.platform === 'win32' && which('powershell')) return 'powershell';
  return null;
}

const shell = pick();
if (!shell) {
  process.stderr.write(
    'run-powershell: neither `pwsh` nor `powershell` found on PATH.\n' +
      '  Install PowerShell 7+ (https://github.com/PowerShell/PowerShell) or, on Windows, ensure Windows PowerShell 5.1 is on PATH.\n',
  );
  process.exit(127);
}

const args = ['-ExecutionPolicy', 'Bypass', '-NoProfile', '-File', scriptPath, ...rest];
const result = spawnSync(shell, args, { stdio: 'inherit' });
if (result.error) {
  process.stderr.write(`run-powershell: failed to spawn ${shell}: ${result.error.message}\n`);
  process.exit(1);
}
process.exit(result.status ?? 1);
