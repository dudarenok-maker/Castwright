/* fs-23 — In-app Model Manager backend.

     GET  /api/models/inventory       — every local model: present? · size ·
                                         disk path · live residency + flags
     POST /api/models/:id/remove      — delete a model's weights (Phase B)

   Sizes are computed in Node (direct FS via tts/model-paths.ts) folded together
   with live residency from the sidecar /health probe and the Ollama daemon, so
   the inventory is correct even when the sidecar is DOWN (the user may want to
   inspect/remove precisely because it won't start). These routes are local-ops
   only and deliberately stay OUT of openapi.yaml, like the sidecar/qwen/ollama
   routes they sit beside. */

import { Router } from 'express';
import type { Request, Response } from '../http.js';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { rmSync } from 'node:fs';
import { execFile } from 'node:child_process';
import {
  probeSidecarHealth,
  type SidecarHealthResult,
} from './sidecar-health.js';
import { getResolvedOllamaUrl } from '../workspace/user-settings.js';
import {
  getResolvedTtsModelKey,
  getResolvedOllamaModel,
  getResolvedAnalysisEngine,
} from '../workspace/user-settings.js';
import { engineForModelKey, type TtsEngine } from '../tts/index.js';
import { detectQwenInstallStateOnDisk } from '../tts/qwen-install-detect.js';
import { coquiWeightsPresent } from '../tts/coqui-install-detect.js';
import {
  kokoroWeightPaths,
  kokoroWeightDir,
  coquiWeightDir,
  qwenBaseRepoDir,
  qwenDesignRepoDir,
  whisperRepoDir,
  dirSizeBytes,
  totalSizeBytes,
} from '../tts/model-paths.js';
import { kokoroIntegrity } from '../tts/model-integrity.js';

export const modelsInventoryRouter = Router();

/* server/src/routes/models-inventory.ts → repo root is three levels up. */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

const OLLAMA_TIMEOUT_MS = 2_000;

export type ModelInventoryId =
  | 'kokoro'
  | 'qwen-base'
  | 'qwen-design'
  | 'coqui'
  | 'whisper'
  | `ollama:${string}`;

export interface ModelInventoryItem {
  id: ModelInventoryId;
  kind: 'tts' | 'analyzer' | 'asr';
  label: string;
  present: boolean;
  sizeBytes: number | null;
  diskPath: string | null;
  loaded: boolean;
  installState?: string;
  isDefaultEngine: boolean;
  /* Kokoro is the universal fallback engine — removing it breaks fallback for
     EVERY book, even ones whose default isn't Kokoro. The UI warns harder. */
  isFallbackEngine: boolean;
  removable: boolean;
  updatable: boolean;
  /* ops-7 (Phase C) — re-hash-vs-manifest verdict for pinned weights. */
  integrity?: 'verified' | 'unpinned' | 'mismatch';
}

export interface ModelInventoryResponse {
  ts: string;
  sidecarReachable: boolean;
  items: ModelInventoryItem[];
}

interface OllamaSnapshot {
  reachable: boolean;
  models: { name: string; size: number }[];
  resident: string[];
}

export interface InventoryDeps {
  repoRoot: string;
  ts: string;
  sidecar: SidecarHealthResult;
  ollama: OllamaSnapshot;
  resolvedTtsEngine: TtsEngine;
  analysisEngine: 'local' | 'gemini';
  resolvedOllamaModel: string;
}

/* Match an Ollama residency tag against an inventory model name. Ollama
   canonicalises a bare family name to its ':latest' tag, so 'qwen3.5' and
   'qwen3.5:latest' are the same model — but two DIFFERENT explicit tags that
   merely share a family root (qwen3.5:4b vs qwen3.5:9b) are NOT. The previous
   root-only comparison conflated the latter, so a resident qwen3.5:4b lit up
   qwen3.5:9b as "Loaded" in the Model Manager (residency borrowed across size
   variants). Normalise the bare-name⇄:latest equivalence only. */
function tagMatches(tag: string, expected: string): boolean {
  const norm = (t: string) => (t.includes(':') ? t : `${t}:latest`);
  return norm(tag) === norm(expected);
}

/** Pure inventory builder — all I/O (sidecar/ollama probes, resolver reads) is
    pre-resolved into `deps`; only the synchronous FS sizing (via model-paths,
    keyed off deps.repoRoot + the HF-cache env) happens here. Keeps the route a
    thin wiring shell and makes the inventory unit-testable against a temp tree. */
export function buildModelInventory(deps: InventoryDeps): ModelInventoryResponse {
  const { repoRoot, sidecar, ollama, resolvedTtsEngine, analysisEngine, resolvedOllamaModel } =
    deps;
  const items: ModelInventoryItem[] = [];

  /* ── Kokoro (TTS, fallback engine) ─────────────────────────────────── */
  const kokoroPaths = kokoroWeightPaths(repoRoot);
  const kokoroSize = totalSizeBytes(kokoroPaths);
  items.push({
    id: 'kokoro',
    kind: 'tts',
    label: 'Kokoro v1',
    present: kokoroSize.fileCount > 0,
    sizeBytes: kokoroSize.fileCount > 0 ? kokoroSize.bytes : null,
    diskPath: kokoroWeightDir(repoRoot),
    loaded: sidecar.kokoroLoaded === true,
    isDefaultEngine: resolvedTtsEngine === 'kokoro',
    isFallbackEngine: true,
    removable: kokoroSize.fileCount > 0,
    updatable: true,
    integrity: kokoroSize.fileCount > 0 ? kokoroIntegrity(repoRoot) : undefined,
  });

  /* ── Qwen Base (TTS, bespoke per-character voices) ─────────────────── */
  const qwenBasePath = qwenBaseRepoDir();
  const qwenBaseSize = dirSizeBytes(qwenBasePath);
  const qwenBasePresent = qwenBaseSize.bytes > 0;
  items.push({
    id: 'qwen-base',
    kind: 'tts',
    label: 'Qwen3-TTS Base (0.6B)',
    present: qwenBasePresent,
    sizeBytes: qwenBasePresent ? qwenBaseSize.bytes : null,
    diskPath: qwenBasePath,
    loaded: sidecar.qwenLoaded === true,
    installState:
      sidecar.qwenInstallState ?? detectQwenInstallStateOnDisk(repoRoot),
    isDefaultEngine: resolvedTtsEngine === 'qwen',
    isFallbackEngine: false,
    removable: qwenBasePresent,
    updatable: true,
  });

  /* ── Qwen VoiceDesign (transient design-time model) ────────────────── */
  const qwenDesignPath = qwenDesignRepoDir();
  const qwenDesignSize = dirSizeBytes(qwenDesignPath);
  const qwenDesignPresent = qwenDesignSize.bytes > 0;
  items.push({
    id: 'qwen-design',
    kind: 'tts',
    label: 'Qwen3-TTS VoiceDesign (1.7B)',
    present: qwenDesignPresent,
    sizeBytes: qwenDesignPresent ? qwenDesignSize.bytes : null,
    diskPath: qwenDesignPath,
    /* Design model loads transiently during voice design and isn't surfaced on
       /health, so residency reads false here (it's never the steady state). */
    loaded: false,
    isDefaultEngine: false,
    isFallbackEngine: false,
    removable: qwenDesignPresent,
    updatable: true,
  });

  /* ── Coqui XTTS v2 (alternate TTS) ─────────────────────────────────── */
  const coquiPath = coquiWeightDir();
  const coquiSize = dirSizeBytes(coquiPath);
  /* Authoritative present check — the same model.pth probe /api/coqui/detect
     uses, so the inventory row and the installer card never disagree. A
     half-finished download (config.json only) reads as not-present. */
  const coquiPresent = coquiWeightsPresent();
  items.push({
    id: 'coqui',
    kind: 'tts',
    label: 'Coqui XTTS v2',
    present: coquiPresent,
    sizeBytes: coquiPresent ? coquiSize.bytes : null,
    diskPath: coquiPath,
    loaded: sidecar.modelLoaded === true,
    isDefaultEngine: resolvedTtsEngine === 'coqui',
    isFallbackEngine: false,
    removable: coquiPresent,
    updatable: true,
  });

  /* ── Whisper ASR (content-QA, srv-31) ──────────────────────────────── */
  const whisperPath = whisperRepoDir();
  const whisperSize = dirSizeBytes(whisperPath);
  const whisperPresent = whisperSize.bytes > 0;
  items.push({
    id: 'whisper',
    kind: 'asr',
    label: 'Whisper ASR (faster-whisper)',
    present: whisperPresent,
    sizeBytes: whisperPresent ? whisperSize.bytes : null,
    diskPath: whisperPath,
    loaded: sidecar.asrLoaded === true,
    isDefaultEngine: false,
    isFallbackEngine: false,
    removable: whisperPresent,
    updatable: true,
  });

  /* ── Analyzer (local Ollama models only — cloud Gemini is not a disk
        artifact and has nothing to install/remove) ───────────────────── */
  for (const m of ollama.models) {
    const resident = ollama.resident.some((r) => tagMatches(r, m.name));
    items.push({
      id: `ollama:${m.name}`,
      kind: 'analyzer',
      label: m.name,
      present: true,
      sizeBytes: m.size > 0 ? m.size : null,
      diskPath: null,
      loaded: resident,
      isDefaultEngine: analysisEngine === 'local' && tagMatches(m.name, resolvedOllamaModel),
      isFallbackEngine: false,
      removable: true,
      updatable: true,
    });
  }

  return {
    ts: deps.ts,
    sidecarReachable: sidecar.status === 'reachable',
    items,
  };
}

/** Fetch pulled Ollama tags (name + size) + resident set. Never throws —
    an unreachable daemon yields an empty, not-reachable snapshot. */
async function probeOllamaModels(): Promise<OllamaSnapshot> {
  const url = getResolvedOllamaUrl();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), OLLAMA_TIMEOUT_MS);
  try {
    const [tagsResp, psResp] = await Promise.all([
      fetch(`${url}/api/tags`, { method: 'GET', signal: controller.signal }),
      fetch(`${url}/api/ps`, { method: 'GET', signal: controller.signal }),
    ]);
    clearTimeout(timer);
    if (!tagsResp.ok) return { reachable: false, models: [], resident: [] };
    const tagsBody = (await tagsResp.json().catch(() => ({}))) as {
      models?: { name?: string; model?: string; size?: number }[];
    };
    const models = Array.isArray(tagsBody.models)
      ? tagsBody.models
          .map((m) => ({ name: m.name ?? m.model ?? '', size: m.size ?? 0 }))
          .filter((m) => m.name)
      : [];
    let resident: string[] = [];
    if (psResp.ok) {
      const psBody = (await psResp.json().catch(() => ({}))) as {
        models?: { name?: string; model?: string }[];
      };
      resident = Array.isArray(psBody.models)
        ? psBody.models.map((m) => m.name ?? m.model ?? '').filter(Boolean)
        : [];
    }
    return { reachable: true, models, resident };
  } catch {
    clearTimeout(timer);
    return { reachable: false, models: [], resident: [] };
  }
}

/* ── Remove (Phase B) ──────────────────────────────────────────────────── */

export interface RemovalGuard {
  ok: boolean;
  code?: 'model-loaded' | 'model-is-default' | 'model-is-fallback';
  error?: string;
  remediation?: string;
}

/** Pure guard — decide whether `item` may be removed. Order matters: a loaded
    model is the most actionable (unload first); the fallback guard is the
    loudest (removing Kokoro breaks fallback for every book). */
export function evaluateRemoval(item: ModelInventoryItem): RemovalGuard {
  if (item.loaded) {
    return {
      ok: false,
      code: 'model-loaded',
      error: `${item.label} is currently loaded in GPU memory.`,
      remediation: 'Unload it first, then remove.',
    };
  }
  if (item.isFallbackEngine) {
    return {
      ok: false,
      code: 'model-is-fallback',
      error: `${item.label} is the universal fallback engine — removing it breaks audio fallback for every book.`,
      remediation: 'Keep the fallback engine installed.',
    };
  }
  if (item.isDefaultEngine) {
    return {
      ok: false,
      code: 'model-is-default',
      error: `${item.label} is your current default engine.`,
      remediation: 'Change the default in the Model Manager first, then remove.',
    };
  }
  return { ok: true };
}

/** Resolve the on-disk path(s) a model id occupies. Ollama models have no local
    path (managed by the daemon). */
function removalPaths(id: string, repoRoot: string): string[] {
  switch (id) {
    case 'kokoro':
      return [kokoroWeightDir(repoRoot)];
    case 'qwen-base':
      return [qwenBaseRepoDir()];
    case 'qwen-design':
      return [qwenDesignRepoDir()];
    case 'coqui':
      return [coquiWeightDir()];
    case 'whisper':
      return [whisperRepoDir()];
    default:
      return [];
  }
}

/** Delete a model's weights. For Ollama, exec `ollama rm <tag>`. Returns the
    freed byte count (computed before deletion). Throws on a locked file (the
    route maps EBUSY/EPERM to a 409) or an ollama failure. */
export async function performRemoval(
  id: string,
  repoRoot: string,
): Promise<{ removed: boolean; freedBytes: number }> {
  if (id.startsWith('ollama:')) {
    const tag = id.slice('ollama:'.length);
    await new Promise<void>((resolveP, rejectP) => {
      execFile('ollama', ['rm', tag], { timeout: 10_000, windowsHide: true }, (err) =>
        err ? rejectP(err) : resolveP(),
      );
    });
    return { removed: true, freedBytes: 0 };
  }
  const paths = removalPaths(id, repoRoot);
  let freedBytes = 0;
  for (const p of paths) {
    freedBytes += totalSizeBytes([p]).bytes;
    rmSync(p, { recursive: true, force: true });
  }
  return { removed: true, freedBytes };
}

modelsInventoryRouter.post('/:id/remove', async (req: Request, res: Response) => {
  const id = req.params.id;
  const [sidecar, ollama] = await Promise.all([
    probeSidecarHealth().catch(
      (): SidecarHealthResult => ({ status: 'unreachable', url: '', proxy: 'sidecar' }),
    ),
    probeOllamaModels(),
  ]);
  const inventory = buildModelInventory({
    repoRoot: REPO_ROOT,
    ts: new Date().toISOString(),
    sidecar,
    ollama,
    resolvedTtsEngine: engineForModelKey(getResolvedTtsModelKey()),
    analysisEngine: getResolvedAnalysisEngine(),
    resolvedOllamaModel: getResolvedOllamaModel(),
  });
  const item = inventory.items.find((i) => i.id === id);
  if (!item) {
    return res.status(404).json({ error: `Unknown model '${id}'.` });
  }
  if (!item.present) {
    /* Idempotent: nothing to delete. */
    return res.json({ id, removed: false, freedBytes: 0, item });
  }
  const guard = evaluateRemoval(item);
  if (!guard.ok) {
    return res.status(409).json({ code: guard.code, error: guard.error, remediation: guard.remediation });
  }
  try {
    const { removed, freedBytes } = await performRemoval(id, REPO_ROOT);
    return res.json({ id, removed, freedBytes });
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    if (err.code === 'EBUSY' || err.code === 'EPERM' || err.code === 'ENOTEMPTY') {
      return res.status(409).json({
        code: 'files-locked',
        error: `Couldn't delete ${item.label} — files are in use.`,
        remediation: 'Stop the sidecar (or Unload the model) and retry.',
      });
    }
    return res.status(500).json({ error: err.message || 'Removal failed.' });
  }
});

modelsInventoryRouter.get('/inventory', async (_req: Request, res: Response) => {
  const [sidecar, ollama] = await Promise.all([
    probeSidecarHealth().catch(
      (): SidecarHealthResult => ({ status: 'unreachable', url: '', proxy: 'sidecar' }),
    ),
    probeOllamaModels(),
  ]);
  const inventory = buildModelInventory({
    repoRoot: REPO_ROOT,
    ts: new Date().toISOString(),
    sidecar,
    ollama,
    resolvedTtsEngine: engineForModelKey(getResolvedTtsModelKey()),
    analysisEngine: getResolvedAnalysisEngine(),
    resolvedOllamaModel: getResolvedOllamaModel(),
  });
  return res.json(inventory);
});
