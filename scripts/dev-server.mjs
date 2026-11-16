#!/usr/bin/env node
// The dev server launcher: server/package.json `dev`, so `npm start` (Windows
// via start-app.ps1 -> dev:server, POSIX via `npm run dev`), `npm run dev`,
// `dev:mock` and `dev:lan`. It runs `tsx watch` on src/index.ts with the
// report-exclusion flags both on the command line (what the server's gate
// reads) and in NODE_OPTIONS (what tsx's esbuild Worker, started with
// `execArgv: []`, reads). See scripts/lib/report-exclusion.mjs (#4054).
//
// A node script rather than `cross-env NODE_OPTIONS=...`: cross-env is only a
// root devDependency (server/ does not have it), and it sets a value rather
// than appending to the user's NODE_OPTIONS.
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDirectlyInvoked } from './lib/is-main-module.mjs';
import { REPORT_EXCLUSION_FLAGS, withReportExclusionNodeOptions } from './lib/report-exclusion.mjs';

/** What to spawn for the dev server. `resolveTsxCli` is injectable for tests. */
export function devServerCommand(
  serverDir,
  baseEnv,
  resolveTsxCli = () => createRequire(join(serverDir, 'package.json')).resolve('tsx/cli'),
) {
  return {
    file: process.execPath,
    args: [resolveTsxCli(), 'watch', '--include=.env', ...REPORT_EXCLUSION_FLAGS, 'src/index.ts'],
    options: { cwd: serverDir, env: withReportExclusionNodeOptions(baseEnv), stdio: 'inherit' },
  };
}

if (isDirectlyInvoked(import.meta.url)) {
  const serverDir = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'server');
  const { file, args, options } = devServerCommand(serverDir, process.env);
  const child = spawn(file, args, { ...options, windowsHide: true });
  // Ctrl+C reaches tsx itself (same console / process group), and tsx relays it
  // to the server; stay alive until tsx has finished, then exit with its code.
  process.on('SIGINT', () => {});
  process.on('SIGTERM', () => child.kill('SIGTERM'));
  child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
  child.on('error', (err) => {
    console.error('[dev-server] failed to launch tsx:', err.message);
    process.exit(1);
  });
}
