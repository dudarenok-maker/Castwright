/* Node-side Whisper ASR install detection (srv-31, plan 186). A filesystem probe
   that works at server BOOT and backs the in-app installer's detect/recheck.
   Mirrors qwen-install-detect.ts: the `faster_whisper` package present in the
   sidecar venv + the chosen model's CTranslate2 weights in the HF hub cache.

   Conservative: any uncertainty resolves "downward" (not-installed /
   model-missing) so the admin console never claims a non-working ASR is ready. */

import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export type WhisperInstallState = 'not-installed' | 'model-missing' | 'ready';

/* faster-whisper resolves a size name ("base") to the Systran CTranslate2 repo.
   Env-overridable in lockstep with the sidecar's ASR_MODEL so a relocated model
   is probed where it actually lives. */
const ASR_MODEL = process.env.ASR_MODEL || 'base';
/* CTranslate2 Whisper snapshots ship `model.bin` (not .safetensors). */
const WEIGHT_NAMES = ['model.bin'];

function modelRepo(model: string): string {
  /* A bare size name maps to Systran/faster-whisper-<size>; a full `owner/repo`
     (custom model) is used as-is. */
  return model.includes('/') ? model : `Systran/faster-whisper-${model}`;
}

/* Resolve the HF hub cache exactly as huggingface_hub does so this probe and the
   runtime loader agree: HF_HUB_CACHE → HF_HOME/hub → $XDG_CACHE_HOME/
   huggingface/hub → ~/.cache/huggingface/hub. */
function hubCacheDir(): string {
  if (process.env.HF_HUB_CACHE) return process.env.HF_HUB_CACHE;
  if (process.env.HF_HOME) return join(process.env.HF_HOME, 'hub');
  const base = process.env.XDG_CACHE_HOME || join(homedir(), '.cache');
  return join(base, 'huggingface', 'hub');
}

/** True if the model snapshot holds the CTranslate2 weight blob (`model.bin`) —
    so a half-finished download (metadata only) doesn't read as ready. */
export function whisperModelPresent(model: string = ASR_MODEL): boolean {
  const repo = modelRepo(model);
  const repoDir = join(hubCacheDir(), 'models--' + repo.replace(/\//g, '--'));
  const snapshots = join(repoDir, 'snapshots');
  if (!existsSync(snapshots)) return false;
  const stack = [snapshots];
  try {
    while (stack.length > 0) {
      const dir = stack.pop() as string;
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) stack.push(full);
        else if (WEIGHT_NAMES.includes(entry.name)) return true;
      }
    }
  } catch {
    return false;
  }
  return false;
}

/** True if the `faster_whisper` package is present in the sidecar venv's
    site-packages (Windows `Lib\` + posix `lib/pythonX.Y/`). */
export function fasterWhisperInstalled(repoRoot: string): boolean {
  const venv = join(repoRoot, 'server', 'tts-sidecar', '.venv');
  const candidates = [join(venv, 'Lib', 'site-packages', 'faster_whisper')];
  const libDir = join(venv, 'lib');
  try {
    if (existsSync(libDir)) {
      for (const py of readdirSync(libDir)) {
        candidates.push(join(libDir, py, 'site-packages', 'faster_whisper'));
      }
    }
  } catch {
    /* no posix lib dir — Windows-only layout */
  }
  return candidates.some((p) => existsSync(p));
}

/** not-installed | model-missing | ready. */
export function detectWhisperInstallStateOnDisk(
  repoRoot: string,
  model: string = ASR_MODEL,
): WhisperInstallState {
  if (!fasterWhisperInstalled(repoRoot)) return 'not-installed';
  if (!whisperModelPresent(model)) return 'model-missing';
  return 'ready';
}
