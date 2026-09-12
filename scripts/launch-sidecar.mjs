#!/usr/bin/env node
// Cross-platform `npm run tts:sidecar`: Windows → powershell start.ps1,
// POSIX → bash start.sh. The pure `sidecarCommand` is unit-tested; the CLI
// tail spawns it with inherited stdio so it behaves like the old npm script.
import { spawn as realSpawn } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDirectlyInvoked } from './lib/is-main-module.mjs';

export function sidecarCommand(platform, repoRoot) {
  const dir = join(repoRoot, 'server', 'tts-sidecar');
  return platform === 'win32'
    ? { file: 'powershell.exe', args: ['-ExecutionPolicy', 'Bypass', '-NoProfile', '-File', join(dir, 'start.ps1')] }
    : { file: 'bash', args: [join(dir, 'start.sh')] };
}

/* Restart safeguards for the standalone-launch path.
   Issue #3121 notes that `npm run tts:sidecar` (used when autoStartSidecar is off)
   spawns start.ps1/start.sh directly with no Node supervisor behind it. When
   start.ps1/start.sh exits with code 43 (planned memory recycle), this handler
   re-launches to match the supervised path's behavior until the streak cap is reached.
   After 3 code-43 exits within a 10-minute window, this launcher exits with code 43
   to stop the retry loop — the process is then up to the user's own supervisor.
   Any other unexpected non-zero exit (including 42, the CUDA poison exit — see
   #3206) gets its own generic crash-loop retry, below. Code 0 (and a null/
   signal-terminated exit) still propagates immediately with no retry.

   The streak tracking mirrors sidecar-supervisor.ts exactly. */
const RESTART43_STREAK_WINDOW_MS = 600_000; // 10 min
const RESTART43_STREAK_TRIP_COUNT = 3;

/* Generic crash-loop retry for code-42 exits only (#3206).
   Code 42 (CUDA device-side assert / "poison") is the driving case — before
   PR #3148 both start.ps1/start.sh retried it unconditionally, and the
   supervised path (sidecar-supervisor.ts) still does. This path is
   kept SEPARATE from the code-43 streak above: 43 is a planned memory-recycle
   event with its own fixed-2s/3-in-10-minutes shape, and folding a poison exit
   into that cap/message would misdiagnose it. Values duplicated (not imported)
   from sidecar-supervisor.ts's DEFAULT_BACKOFFS_MS/DEFAULT_MAX_CONSECUTIVE_FAILURES
   — that file is TS compiled separately from this .mjs script and does not
   export them. A child that lived past QUICK_DEATH_MS before exiting is a
   fresh incident and resets the counter (#2106); one that dies fast is part
   of the crash loop. */
const CRASH_LOOP_BACKOFFS_MS = [2_000, 5_000, 15_000];
const CRASH_LOOP_MAX_CONSECUTIVE_FAILURES = 5;
const QUICK_DEATH_MS = 30_000; // Child lifetime threshold for fresh-incident detection

export async function launchSidecarWithRestart(platform, repoRoot, spawn = realSpawn) {
  let restart43Timestamps = [];
  let crashLoopFailures = 0;
  let lastSpawnAt = 0;

  const launch = () => {
    return new Promise((resolve, reject) => {
      const { file, args } = sidecarCommand(platform, repoRoot);
      lastSpawnAt = Date.now(); // Record spawn time for this attempt
      const child = spawn(file, args, { stdio: 'inherit', windowsHide: true });

      child.on('exit', (code) => {
        if (code === 43) {
          // Record this code-43 exit for streak tracking.
          const now = Date.now();
          // Prune exits older than the window, then add the current one.
          // This mirrors sidecar-supervisor.ts:590-591 exactly.
          restart43Timestamps = restart43Timestamps.filter((t) => now - t <= RESTART43_STREAK_WINDOW_MS);
          restart43Timestamps.push(now);

          // Check if we've hit the streak cap.
          if (restart43Timestamps.length >= RESTART43_STREAK_TRIP_COUNT) {
            console.log(
              `[tts:sidecar] ${restart43Timestamps.length} code-43 exits in ` +
                `${RESTART43_STREAK_WINDOW_MS / 60_000} minutes — streak cap reached. Exiting.`,
            );
            try {
              process.exit(43);
            } catch (err) {
              // In tests, process.exit may throw; reject the promise so await completes
              reject(err);
              return;
            }
          }

          // Restart once with a brief backoff.
          console.log('[tts:sidecar] exited with code 43 (recycle) — restarting in 2s.');
          setTimeout(() => {
            resolve(launch());
          }, 2000);
        } else if (code === 0 || code == null) {
          // Clean shutdown (or signal-terminated with no code): propagate immediately, no retry.
          try {
            process.exit(code ?? 0);
          } catch (err) {
            // In tests, process.exit may throw; reject the promise so await completes
            reject(err);
          }
        } else if (code === 42) {
          // Code 42 (CUDA poison): generic crash-loop retry with fresh-incident reset.
          // A child that lived past QUICK_DEATH_MS is a fresh incident, not part of a crash loop.
          const freshIncident = Date.now() - lastSpawnAt >= QUICK_DEATH_MS;
          if (freshIncident) crashLoopFailures = 0;
          crashLoopFailures += 1;

          if (crashLoopFailures > CRASH_LOOP_MAX_CONSECUTIVE_FAILURES) {
            console.log(
              `[tts:sidecar] ${crashLoopFailures} rapid unexpected exits (code ${code}) in a row — giving up.`,
            );
            try {
              process.exit(code);
            } catch (err) {
              reject(err);
              return;
            }
          } else {
            const delayMs =
              CRASH_LOOP_BACKOFFS_MS[Math.min(crashLoopFailures - 1, CRASH_LOOP_BACKOFFS_MS.length - 1)];
            console.log(
              `[tts:sidecar] exited with code ${code} (unexpected) — restarting in ${delayMs}ms ` +
                `(attempt ${crashLoopFailures}/${CRASH_LOOP_MAX_CONSECUTIVE_FAILURES}).`,
            );
            setTimeout(() => {
              resolve(launch());
            }, delayMs);
          }
        } else {
          // Any other unexpected non-zero, non-43 exit: propagate immediately, no retry.
          try {
            process.exit(code);
          } catch (err) {
            reject(err);
            return;
          }
        }
      });

      child.on('error', (err) => {
        console.error('[tts:sidecar] failed to launch:', err.message);
        try {
          process.exit(1);
        } catch (exitErr) {
          // In tests, process.exit may throw; reject the promise so await completes
          reject(exitErr);
        }
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
