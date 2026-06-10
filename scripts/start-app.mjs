#!/usr/bin/env node
// Cross-platform `npm start` dev launcher. Windows → the proven start-app.ps1
// (unchanged, no regression). POSIX → the dev stack `npm run dev` (concurrently
// runs frontend + server; the server spawns the TTS sidecar per plan 43, and
// Vite opens the browser). The pure `startAppCommand` is unit-tested.
import { spawn } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export function startAppCommand(platform, repoRoot) {
  if (platform === 'win32') {
    return {
      file: 'powershell.exe',
      args: ['-ExecutionPolicy', 'Bypass', '-NoProfile', '-File', join(repoRoot, 'scripts', 'start-app.ps1')],
    };
  }
  // POSIX: run the same concurrently dev stack `npm run dev` uses.
  return { file: 'npm', args: ['run', 'dev'] };
}

const invokedDirectly =
  process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (invokedDirectly) {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const { file, args } = startAppCommand(process.platform, repoRoot);
  // npm on Windows needs shell:true (npm.cmd); powershell.exe is a real exe so
  // shell is false on Windows. On POSIX npm is a real exe too — no shell needed.
  const useShell = file === 'npm' && process.platform === 'win32';
  const child = spawn(file, args, { stdio: 'inherit', cwd: repoRoot, shell: useShell });
  child.on('exit', (code) => process.exit(code ?? 0));
  child.on('error', (err) => {
    console.error('[start] failed to launch:', err.message);
    process.exit(1);
  });
}
