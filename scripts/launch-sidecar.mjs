#!/usr/bin/env node
// Cross-platform `npm run tts:sidecar`: Windows → powershell start.ps1,
// POSIX → bash start.sh. The pure `sidecarCommand` is unit-tested; the CLI
// tail spawns it with inherited stdio so it behaves like the old npm script.
import { spawn } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDirectlyInvoked } from './lib/is-main-module.mjs';

export function sidecarCommand(platform, repoRoot) {
  const dir = join(repoRoot, 'server', 'tts-sidecar');
  return platform === 'win32'
    ? { file: 'powershell.exe', args: ['-ExecutionPolicy', 'Bypass', '-NoProfile', '-File', join(dir, 'start.ps1')] }
    : { file: 'bash', args: [join(dir, 'start.sh')] };
}

// See scripts/lib/is-main-module.mjs — a resolve()-only comparison misses
// when the invocation crosses a symlink/junction (#2291).
const invokedDirectly = isDirectlyInvoked(import.meta.url);
if (invokedDirectly) {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const { file, args } = sidecarCommand(process.platform, repoRoot);
  const child = spawn(file, args, { stdio: 'inherit', windowsHide: true });
  child.on('exit', (code) => process.exit(code ?? 0));
  child.on('error', (err) => {
    console.error('[tts:sidecar] failed to launch:', err.message);
    process.exit(1);
  });
}
