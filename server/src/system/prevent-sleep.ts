/* Windows-only: hold the system awake (Modern Standby suppressed) for the
   duration of any in-flight generation. Only ES_SYSTEM_REQUIRED is asserted
   (see scripts/lib/prevent-sleep.ps1) — the display is left alone and still
   dims/turns off on its own normal timeout.

   An overnight generation was found asleep for ~7h after Windows entered
   Modern Standby mid-run on Idle Timeout (2026-07-06 investigation, side-11)
   even with the AC power-plan sleep setting reading "never" — a vendor power
   utility or the active power source can override that setting outside the
   app's control, so this holds the lock at the app level instead of relying
   on it. */

import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
/** Repo root — three levels up from server/src/system/. */
const REPO_ROOT = resolve(__dirname, '..', '..', '..');
const SCRIPT_PATH = resolve(REPO_ROOT, 'scripts', 'lib', 'prevent-sleep.ps1');

export interface PreventSleepDeps {
  spawnFn?: (command: string, args: string[], options: SpawnOptions) => ChildProcess;
  platform?: NodeJS.Platform;
  /** Override for tests; defaults to reading PREVENT_SLEEP_DURING_GENERATION. */
  enabled?: boolean;
}

let activeChild: ChildProcess | null = null;

function defaultEnabled(): boolean {
  return process.env.PREVENT_SLEEP_DURING_GENERATION !== 'false';
}

/** Spawn the sleep-prevention helper if nothing is holding it already.
    No-op off Windows, when disabled, or while a helper is already active. */
export function preventSleep(deps: PreventSleepDeps = {}): void {
  const platform = deps.platform ?? process.platform;
  const enabled = deps.enabled ?? defaultEnabled();
  if (platform !== 'win32' || !enabled || activeChild) return;

  const spawnFn = deps.spawnFn ?? spawn;
  const child = spawnFn(
    'powershell.exe',
    ['-ExecutionPolicy', 'Bypass', '-NoProfile', '-File', SCRIPT_PATH],
    { windowsHide: true, stdio: 'ignore' },
  );
  activeChild = child;
  const clear = () => {
    if (activeChild === child) activeChild = null;
  };
  child.once('exit', clear);
  child.once('error', clear);
}

/** Kill the active sleep-prevention helper, if any. Windows resets the
    ES_SYSTEM_REQUIRED flag automatically when the holding process exits, so
    no explicit release call into the helper is needed. */
export function allowSleep(): void {
  if (!activeChild) return;
  const child = activeChild;
  activeChild = null;
  child.kill();
}

/** True while a helper is actively holding the system awake. */
export function isSleepPrevented(): boolean {
  return activeChild !== null;
}
