import { execFileSync } from 'node:child_process';

/* #698 — sweep orphaned Playwright browser processes after every e2e run.
 *
 * On Windows, Playwright's bundled chromium (headless_shell.exe + its renderer/
 * gpu children) can survive a run's normal teardown and accumulate across runs
 * — we measured ~52 leaking PER run, which eats memory/CPU and contaminates
 * later batteries (a stale herd makes unrelated specs fail). This best-effort
 * teardown kills ONLY processes whose image path is under the `ms-playwright`
 * browser cache, so it can never touch the developer's real Chrome/Edge (those
 * live under Program Files, not ms-playwright). No-op on macOS/Linux, where
 * Playwright cleans up reliably.
 *
 * Opt out with PLAYWRIGHT_NO_BROWSER_SWEEP=1 (e.g. if running two e2e batteries
 * concurrently, since the sweep is system-wide across ms-playwright processes). */
export default function globalTeardown() {
  if (process.platform !== 'win32') return;
  if (process.env.PLAYWRIGHT_NO_BROWSER_SWEEP) return;
  const script =
    'Get-CimInstance Win32_Process | ' +
    "Where-Object { $_.ExecutablePath -like '*\\ms-playwright\\*' } | " +
    'ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }';
  try {
    execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], {
      stdio: 'ignore',
      timeout: 30_000,
    });
  } catch {
    /* best-effort: never fail the run on a cleanup hiccup */
  }
}
