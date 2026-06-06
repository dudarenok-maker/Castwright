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

/* Ollama canonicalises tags, so match on either the exact tag or the root. */
function tagMatches(tag: string, expected: string): boolean {
  if (tag === expected) return true;
  const root = expected.split(':')[0];
  return tag === root || tag.split(':')[0] === root;
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
  const coquiPath = coquiWeightDir(repoRoot);
  const coquiSize = dirSizeBytes(coquiPath);
  const coquiPresent = coquiSize.bytes > 0;
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
