/* Node-side Qwen install detection — a filesystem probe that works at server
   BOOT, before the sidecar is spawned (so the /health probe isn't available
   yet). Mirrors the sidecar's _qwen_install_state (main.py): package present in
   the sidecar venv + Base weights in the HF hub cache. Used to seed the
   conditional Qwen-when-installed default at boot, and reused by the in-app
   installer's detect/recheck (phase 3).

   Kept deliberately conservative: any uncertainty resolves "downward"
   (not-installed / weights-missing) so we never hot-preload or default to a
   Qwen that can't actually synthesise. */

import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { QwenInstallState } from '../workspace/user-settings.js';

/* Same repo id QwenEngine.BASE_MODEL resolves (main.py) — env-overridable in
   lockstep so a relocated model is probed where it actually lives. */
const BASE_MODEL_REPO = process.env.QWEN_BASE_MODEL || 'Qwen/Qwen3-TTS-12Hz-0.6B-Base';
const WEIGHT_SUFFIXES = ['.safetensors', '.bin', '.gguf', '.pt'];

/* Resolve the HF hub cache exactly as huggingface_hub does so this probe and
   the runtime loader agree: HF_HUB_CACHE → HF_HOME/hub → $XDG_CACHE_HOME/
   huggingface/hub → ~/.cache/huggingface/hub. */
function hubCacheDir(): string {
  if (process.env.HF_HUB_CACHE) return process.env.HF_HUB_CACHE;
  if (process.env.HF_HOME) return join(process.env.HF_HOME, 'hub');
  const base = process.env.XDG_CACHE_HOME || join(homedir(), '.cache');
  return join(base, 'huggingface', 'hub');
}

/** True if the Base model snapshot holds at least one real weight blob (not
    just metadata) — so a half-finished download doesn't read as ready. */
export function qwenWeightsPresent(): boolean {
  const repoDir = join(hubCacheDir(), 'models--' + BASE_MODEL_REPO.replace(/\//g, '--'));
  const snapshots = join(repoDir, 'snapshots');
  if (!existsSync(snapshots)) return false;
  const stack = [snapshots];
  try {
    while (stack.length > 0) {
      const dir = stack.pop() as string;
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) stack.push(full);
        else if (WEIGHT_SUFFIXES.some((s) => entry.name.endsWith(s))) return true;
      }
    }
  } catch {
    return false;
  }
  return false;
}

/** True if the `qwen_tts` package is present in the sidecar venv's
    site-packages (Windows `Lib\` + posix `lib\pythonX.Y\`). */
export function qwenPackageInstalled(repoRoot: string): boolean {
  const venv = join(repoRoot, 'server', 'tts-sidecar', '.venv');
  const candidates = [join(venv, 'Lib', 'site-packages', 'qwen_tts')];
  const libDir = join(venv, 'lib');
  try {
    if (existsSync(libDir)) {
      for (const py of readdirSync(libDir)) {
        candidates.push(join(libDir, py, 'site-packages', 'qwen_tts'));
      }
    }
  } catch {
    /* no posix lib dir — Windows-only layout */
  }
  return candidates.some((p) => existsSync(p));
}

/** not-installed | weights-missing | ready. (Never 'loaded' — that's a runtime
    fact only the sidecar /health knows.) */
export function detectQwenInstallStateOnDisk(repoRoot: string): QwenInstallState {
  if (!qwenPackageInstalled(repoRoot)) return 'not-installed';
  if (!qwenWeightsPresent()) return 'weights-missing';
  return 'ready';
}
