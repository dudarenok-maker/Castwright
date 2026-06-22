/* fs-23 — centralised on-disk locations for every local model the Model Manager
   inventories / removes. The detect helpers (qwen-install-detect.ts,
   whisper-install-detect.ts) answer "is it installed?"; this module answers
   "WHERE does it live and HOW BIG is it?" so the inventory can show a disk path
   + size and the remove route knows exactly what to delete.

   Resolution mirrors the runtime loaders and the install scripts so the figures
   match reality: Kokoro/Coqui under the sidecar's voices/ tree (env-overridable),
   Qwen + Whisper in the Hugging Face hub cache. The HF cache resolver is
   replicated here (it's a tiny env-derived helper, already duplicated between the
   two detect modules) to keep this module free of cross-module coupling. */

import { existsSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { coquiModelDir } from './coqui-install-detect.js';

/* Same repo ids the sidecar engines resolve (main.py), env-overridable in
   lockstep so a relocated model is sized/removed where it actually lives. */
const QWEN_BASE_MODEL = process.env.QWEN_BASE_MODEL || 'Qwen/Qwen3-TTS-12Hz-0.6B-Base';
const QWEN_BASE17_MODEL = process.env.QWEN_BASE_17B_MODEL || 'Qwen/Qwen3-TTS-12Hz-1.7B-Base';
const QWEN_DESIGN_MODEL =
  process.env.QWEN_VOICEDESIGN_MODEL || 'Qwen/Qwen3-TTS-12Hz-1.7B-VoiceDesign';
const ASR_MODEL = process.env.ASR_MODEL || 'base';

export interface DirSize {
  bytes: number;
  fileCount: number;
}

/* Resolve the HF hub cache exactly as huggingface_hub does so this module and
   the runtime loaders agree: HF_HUB_CACHE → HF_HOME/hub → $XDG_CACHE_HOME/
   huggingface/hub → ~/.cache/huggingface/hub. */
function hubCacheDir(): string {
  if (process.env.HF_HUB_CACHE) return process.env.HF_HUB_CACHE;
  if (process.env.HF_HOME) return join(process.env.HF_HOME, 'hub');
  const base = process.env.XDG_CACHE_HOME || join(homedir(), '.cache');
  return join(base, 'huggingface', 'hub');
}

function hfRepoDir(repo: string): string {
  return join(hubCacheDir(), 'models--' + repo.replace(/\//g, '--'));
}

function sidecarDir(repoRoot: string): string {
  return join(repoRoot, 'server', 'tts-sidecar');
}

/** The two Kokoro weight files. Honours KOKORO_MODEL_PATH / KOKORO_VOICES_PATH
    (the sidecar's env overrides); otherwise the install-script defaults under
    voices/kokoro/. */
export function kokoroWeightPaths(repoRoot: string): string[] {
  const dir = join(sidecarDir(repoRoot), 'voices', 'kokoro');
  return [
    process.env.KOKORO_MODEL_PATH || join(dir, 'kokoro-v1.0.onnx'),
    process.env.KOKORO_VOICES_PATH || join(dir, 'voices-v1.0.bin'),
  ];
}

/** Directory the Kokoro weights live in (what Remove deletes). */
export function kokoroWeightDir(repoRoot: string): string {
  return join(sidecarDir(repoRoot), 'voices', 'kokoro');
}

/** The XTTS v2 model directory. Delegates to the authoritative resolver in
    coqui-install-detect.ts (the TTS lib's user-data dir — what the runtime and
    /api/coqui/detect actually use), NOT the old voices/coqui guess: the sidecar
    runtime never sets TTS_HOME, so the guess diverged from reality and made the
    inventory disagree with the installer card. */
export function coquiWeightDir(): string {
  return coquiModelDir();
}

/** Qwen Base / Base-1.7B / VoiceDesign HF snapshot repo dirs. */
export function qwenBaseRepoDir(): string {
  return hfRepoDir(QWEN_BASE_MODEL);
}
export function qwenBase17RepoDir(): string {
  return hfRepoDir(QWEN_BASE17_MODEL);
}
export function qwenDesignRepoDir(): string {
  return hfRepoDir(QWEN_DESIGN_MODEL);
}

/** Whisper (faster-whisper) CTranslate2 HF snapshot repo dir. A bare size name
    maps to Systran/faster-whisper-<size>; a full owner/repo is used as-is. */
export function whisperRepoDir(model: string = ASR_MODEL): string {
  const repo = model.includes('/') ? model : `Systran/faster-whisper-${model}`;
  return hfRepoDir(repo);
}

/** Recursive on-disk size of a path (file or directory). Uses the Dirent's
    lstat-based type and SKIPS symlinks so an HF hub repo (snapshots/<rev>/ are
    symlinks into blobs/) is counted once, not doubled. Missing path → 0.
    Never throws — a permission error on one entry just stops that branch. */
export function dirSizeBytes(path: string): DirSize {
  if (!existsSync(path)) return { bytes: 0, fileCount: 0 };
  let bytes = 0;
  let fileCount = 0;
  let st;
  try {
    st = statSync(path);
  } catch {
    return { bytes: 0, fileCount: 0 };
  }
  if (st.isFile()) return { bytes: st.size, fileCount: 1 };

  const stack = [path];
  while (stack.length > 0) {
    const dir = stack.pop() as string;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
      } else if (entry.isFile()) {
        try {
          bytes += statSync(full).size;
          fileCount += 1;
        } catch {
          /* unreadable entry — skip */
        }
      }
    }
  }
  return { bytes, fileCount };
}

/** Sum of multiple paths' sizes (e.g. the two Kokoro files). */
export function totalSizeBytes(paths: string[]): DirSize {
  return paths.reduce<DirSize>(
    (acc, p) => {
      const s = dirSizeBytes(p);
      return { bytes: acc.bytes + s.bytes, fileCount: acc.fileCount + s.fileCount };
    },
    { bytes: 0, fileCount: 0 },
  );
}
