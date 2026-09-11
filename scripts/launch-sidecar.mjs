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

/* Minimal code-43 restart safeguard for the standalone-launch path.
   Issue #3121 notes that `npm run tts:sidecar` (used when autoStartSidecar is off)
   spawns start.ps1/start.sh directly with no Node supervisor behind it. When
   start.ps1/start.sh exits with code 43 (planned memory recycle), this handler
   re-launches once to match the supervised path's behavior. After the restart
   cap is reached, or on any other exit code (including 42, 0, or an error), the
   process exits with that code to let the user's supervisor handle it.

   The streak tracking mirrors sidecar-supervisor.ts: 3 code-43 exits in a 10-minute
   window trip the auto-revert mechanism even on the standalone path. */
const RESTART43_STREAK_WINDOW_MS = 600_000; // 10 min
const RESTART43_STREAK_TRIP_COUNT = 3;

async function launchSidecarWithRestart(platform, repoRoot) {
  const restart43Timestamps = [];

  const launch = () => {
    return new Promise((resolve) => {
      const { file, args } = sidecarCommand(platform, repoRoot);
      const child = spawn(file, args, { stdio: 'inherit', windowsHide: true });

      child.on('exit', (code) => {
        if (code === 43) {
          // Record this code-43 exit for streak tracking.
          const now = Date.now();
          restart43Timestamps.push(now);
          // Prune exits older than the window.
          restart43Timestamps.splice(
            0,
            restart43Timestamps.length - RESTART43_STREAK_WINDOW_MS,
            ...restart43Timestamps.filter((t) => now - t <= RESTART43_STREAK_WINDOW_MS),
          );

          // Check if we've hit the streak cap.
          if (restart43Timestamps.length >= RESTART43_STREAK_TRIP_COUNT) {
            console.log(
              `[tts:sidecar] ${restart43Timestamps.length} code-43 exits in ` +
                `${RESTART43_STREAK_WINDOW_MS / 60_000} minutes — auto-revert trip. Exiting.`,
            );
            process.exit(43);
          }

          // Restart once with a brief backoff.
          console.log('[tts:sidecar] exited with code 43 (recycle) — restarting in 2s.');
          setTimeout(() => {
            resolve(launch());
          }, 2000);
        } else {
          // Any other exit code: propagate and exit.
          process.exit(code ?? 0);
        }
      });

      child.on('error', (err) => {
        console.error('[tts:sidecar] failed to launch:', err.message);
        process.exit(1);
      });
    });
  };

  return launch();
}

// See scripts/lib/is-main-module.mjs — a resolve()-only comparison misses
// when the invocation crosses a symlink/junction (#2291).
const invokedDirectly = isDirectlyInvoked(import.meta.url);
if (invokedDirectly) {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  launchSidecarWithRestart(process.platform, repoRoot).catch((err) => {
    console.error('[tts:sidecar] launcher error:', err);
    process.exit(1);
  });
}
