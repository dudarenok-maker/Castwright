#!/usr/bin/env node
// Cross-platform `npm run tts:sidecar`: Windows → powershell start.ps1,
// POSIX → bash start.sh. The pure `sidecarCommand` is unit-tested; the CLI
// tail spawns it with inherited stdio so it behaves like the old npm script.
import { spawn } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export function sidecarCommand(platform, repoRoot) {
  const dir = join(repoRoot, 'server', 'tts-sidecar');
  return platform === 'win32'
    ? { file: 'powershell.exe', args: ['-ExecutionPolicy', 'Bypass', '-NoProfile', '-File', join(dir, 'start.ps1')] }
    : { file: 'bash', args: [join(dir, 'start.sh')] };
}

const invokedDirectly =
  process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (invokedDirectly) {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const { file, args } = sidecarCommand(process.platform, repoRoot);
  const child = spawn(file, args, { stdio: 'inherit' });
  child.on('exit', (code) => process.exit(code ?? 0));
  child.on('error', (err) => {
    console.error('[tts:sidecar] failed to launch:', err.message);
    process.exit(1);
  });
}
