/* Boot-time auto-install of the Coqui text-splitting packages (spacy, SudachiPy,
 * sudachidict-core) on a pre-1.15 Coqui install that lacks them (#4961).
 *
 * Without them the sidecar falls back to `enable_text_splitting=False`
 * (server/tts-sidecar/main.py `_infer_from_latents`), which risks truncated audio
 * or the upstream 400-token assert on long lines — worst for Japanese. A working
 * Coqui shows only "Re-check" in Models, so there is no in-app way to add them.
 *
 * Owner decision (2026-11-28, option C): install them HERE, at server start,
 * BEFORE the sidecar is spawned. The sidecar is not running, so no DLL is mapped
 * and nothing needs the hold the Repair/install flow takes (coqui-install-
 * bootstrap.ts) — no restart, no live pip into a running process. Boot is delayed
 * by one install (about a minute) once; afterwards the probe passes and this is a
 * ~seconds-long no-op.
 *
 * Reuses the Repair/install flow's installer: `install-coqui.mjs --extras-only`
 * runs the SAME third pip step the full installer runs (one source in that
 * script). Detection is `text_split_deps.py`, a real-import probe run with the
 * venv python.
 *
 * Never runs when the server will not spawn the sidecar (autoStartSidecar off)
 * or when something already listens on the sidecar port (an adopted sidecar
 * holds the venv's DLLs) — the next server start retries. A failure is logged,
 * the sidecar is started anyway (Coqui keeps working exactly as today) and a
 * notice is surfaced via GET /api/sidecar/health (`coquiExtras`).
 */

import { spawn as realSpawn, type ChildProcess } from 'node:child_process';
import { join } from 'node:path';
import { refuseUnderVitest } from '../system/refuse-under-vitest.js';
import { resolveSidecarVenvDir } from '../diagnostics/venv.js';
import { coquiPackageInstalled } from './coqui-install-detect.js';
import { runChild } from './install-bootstrap-shared.js';
import { probeListening } from './spawn-sidecar.js';
import { resolveSidecarPort } from './sidecar-owner.js';

export type CoquiExtrasNoticeStatus = 'installing' | 'installed' | 'failed';

export interface CoquiExtrasNotice {
  status: CoquiExtrasNoticeStatus;
  message: string;
}

let notice: CoquiExtrasNotice | null = null;

/** Current notice for GET /api/sidecar/health, or null when nothing ran. */
export function getCoquiExtrasNotice(): CoquiExtrasNotice | null {
  return notice;
}
export function _resetCoquiExtrasNotice(): void {
  notice = null;
}

type SpawnFn = (
  cmd: string,
  args: readonly string[],
  opts?: { cwd?: string; windowsHide?: boolean },
) => ChildProcess;

/** Upper bound on the probe: importing spacy cold can take several seconds. */
export const PROBE_IDLE_TIMEOUT_MS = 60_000;
/** Silence budget for the install (pip prints continuously while it works). */
export const INSTALL_IDLE_TIMEOUT_MS = 10 * 60_000;

export interface CoquiExtrasDeps {
  repoRoot: string;
  /** The server will spawn the sidecar itself (autoStartSidecar resolved on). */
  autoStart: boolean;
  /** True when the `TTS` package is in the venv (Coqui installed at all). */
  coquiInstalledFn?: () => boolean;
  /** True when something already listens on the sidecar port. */
  sidecarListeningFn?: () => Promise<boolean>;
  /** Real-import probe in the venv: resolves true iff every package imports. */
  probeFn?: () => Promise<boolean>;
  /** Runs `install-coqui.mjs --extras-only`; rejects on failure. */
  installFn?: () => Promise<void>;
  log?: (msg: string) => void;
  warn?: (msg: string) => void;
}

function venvPython(repoRoot: string): string {
  const venvDir = resolveSidecarVenvDir(repoRoot);
  return process.platform === 'win32'
    ? join(venvDir, 'Scripts', 'python.exe')
    : join(venvDir, 'bin', 'python');
}

const defaultSpawn: SpawnFn = refuseUnderVitest(
  realSpawn as unknown as SpawnFn,
  'coqui-extras-autoinstall: real spawn refused under vitest (#3712); inject probeFn/installFn',
);

function defaultProbe(repoRoot: string): Promise<boolean> {
  const script = join(repoRoot, 'server', 'tts-sidecar', 'text_split_deps.py');
  return runChild(
    defaultSpawn,
    repoRoot,
    venvPython(repoRoot),
    [script],
    { failure: (code) => `text_split_deps.py exited with code ${code}.` },
    { engineLabel: 'text_split_deps', childIdleTimeoutMs: PROBE_IDLE_TIMEOUT_MS },
  ).then(
    () => true,
    () => false,
  );
}

function defaultInstall(repoRoot: string): Promise<void> {
  const script = join(repoRoot, 'server', 'tts-sidecar', 'scripts', 'install-coqui.mjs');
  return runChild(
    defaultSpawn,
    repoRoot,
    'node',
    [script, '--extras-only'],
    { failure: (code, detail) => `install-coqui.mjs --extras-only exited with code ${code}.${detail ? ` ${detail}` : ''}` },
    { engineLabel: 'install-coqui --extras-only', childIdleTimeoutMs: INSTALL_IDLE_TIMEOUT_MS },
  );
}

/**
 * Install the Coqui text-splitting packages if Coqui is installed, they are
 * missing, and it is safe to (no sidecar running, server owns the sidecar).
 * Resolves once decided/finished; NEVER rejects — the caller starts the sidecar
 * right after regardless. Returns what happened, for tests and the boot log.
 */
export async function ensureCoquiTextSplitPackages(
  deps: CoquiExtrasDeps,
): Promise<'skipped-no-autostart' | 'skipped-no-coqui' | 'skipped-sidecar-running' | 'present' | 'installed' | 'failed'> {
  const log = deps.log ?? ((m) => console.log(m));
  const warn = deps.warn ?? ((m) => console.warn(m));
  try {
    if (!deps.autoStart) return 'skipped-no-autostart';
    if (!(deps.coquiInstalledFn ?? (() => coquiPackageInstalled(deps.repoRoot)))()) {
      return 'skipped-no-coqui';
    }
    const listening =
      deps.sidecarListeningFn ?? (() => probeListening('127.0.0.1', resolveSidecarPort()));
    if (await listening()) {
      log('[coqui-extras] a sidecar is already listening; not touching its venv (next server start retries).');
      return 'skipped-sidecar-running';
    }
    if (await (deps.probeFn ?? (() => defaultProbe(deps.repoRoot)))()) return 'present';

    log('[coqui-extras] Coqui is installed but its text-splitting packages (spacy, SudachiPy) are missing; installing before the sidecar starts.');
    notice = {
      status: 'installing',
      message:
        'Adding the Coqui text-splitting packages (spacy, SudachiPy) before the voice engine starts. This takes about a minute, once.',
    };
    try {
      await (deps.installFn ?? (() => defaultInstall(deps.repoRoot)))();
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      warn(`[coqui-extras] install failed: ${reason}`);
      notice = {
        status: 'failed',
        message:
          'Could not add the Coqui text-splitting packages (spacy, SudachiPy). Coqui still works; very long lines may be cut short. It retries on the next server start — see the server log for details.',
      };
      return 'failed';
    }
    log('[coqui-extras] text-splitting packages installed.');
    notice = {
      status: 'installed',
      message: 'Coqui text-splitting packages (spacy, SudachiPy) installed.',
    };
    return 'installed';
  } catch (err) {
    /* A probe/detect surprise must never keep the sidecar from starting. */
    warn(`[coqui-extras] skipped: ${err instanceof Error ? err.message : String(err)}`);
    return 'failed';
  }
}
