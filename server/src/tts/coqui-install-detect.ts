/* Node-side Coqui XTTS v2 install detection — a filesystem probe that works at
   server BOOT, before the sidecar is spawned. Mirrors qwen-install-detect.ts
   but for the Coqui engine. Two differences from Qwen:

     - The `coqui-tts` package (import name `TTS`) is a BASE sidecar requirement
       (requirements.txt), so it's present whenever the venv is bootstrapped —
       'not-installed' really means "venv not set up". The variable is whether
       the ~1.8 GB XTTS v2 weights have been pre-fetched.
     - The weights live in the TTS lib's user-data dir, NOT the HF hub cache.
       The sidecar runtime does NOT set TTS_HOME, so we resolve the DEFAULT
       location exactly as the lib's get_user_data_dir("tts") does (trainer.io)
       — TTS_HOME → XDG_DATA_HOME → %LOCALAPPDATA% / ~/Library/Application
       Support / ~/.local/share, then + "tts". Aligning the probe with the
       runtime is the same lesson install-qwen3.mjs records for the HF cache.

   Kept deliberately conservative: any uncertainty resolves "downward"
   (not-installed / weights-missing). */

import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export type CoquiInstallState = 'not-installed' | 'weights-missing' | 'ready' | 'loaded';

/* XTTS v2 manifest dir name the TTS ModelManager writes (slashes → '--'). */
const XTTS_DIR_NAME = 'tts_models--multilingual--multi-dataset--xtts_v2';

/* Resolve the TTS user-data dir exactly as trainer.io's get_user_data_dir
   ("tts") does, so this probe and the runtime loader agree on where XTTS v2
   weights land. Honors TTS_HOME / XDG_DATA_HOME overrides in lockstep. */
function ttsDataDir(): string {
  const ttsHome = process.env.TTS_HOME;
  const xdg = process.env.XDG_DATA_HOME;
  let base: string;
  if (ttsHome) base = ttsHome;
  else if (xdg) base = xdg;
  else if (process.platform === 'win32')
    base = process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local');
  else if (process.platform === 'darwin') base = join(homedir(), 'Library', 'Application Support');
  else base = join(homedir(), '.local', 'share');
  return join(base, 'tts');
}

/** True if the XTTS v2 model blob (`model.pth`) is present — a half-finished
    download (config.json only) reads as missing, mirroring Qwen's caution. */
export function coquiWeightsPresent(): boolean {
  return existsSync(join(ttsDataDir(), XTTS_DIR_NAME, 'model.pth'));
}

/** True if the `TTS` package (pip `coqui-tts`) is present in the sidecar venv's
    site-packages (Windows `Lib\` + posix `lib\pythonX.Y\`). */
export function coquiPackageInstalled(repoRoot: string): boolean {
  const venv = join(repoRoot, 'server', 'tts-sidecar', '.venv');
  const candidates = [join(venv, 'Lib', 'site-packages', 'TTS')];
  const libDir = join(venv, 'lib');
  try {
    if (existsSync(libDir)) {
      for (const py of readdirSync(libDir)) {
        candidates.push(join(libDir, py, 'site-packages', 'TTS'));
      }
    }
  } catch {
    /* no posix lib dir — Windows-only layout */
  }
  return candidates.some((p) => existsSync(p));
}

/** not-installed | weights-missing | ready. (Never 'loaded' — that's a runtime
    fact only the sidecar /health knows.) */
export function detectCoquiInstallStateOnDisk(repoRoot: string): CoquiInstallState {
  if (!coquiPackageInstalled(repoRoot)) return 'not-installed';
  if (!coquiWeightsPresent()) return 'weights-missing';
  return 'ready';
}
