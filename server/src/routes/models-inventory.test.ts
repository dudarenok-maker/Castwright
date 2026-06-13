/* fs-23 — Model Manager inventory. Unit-tests the pure buildModelInventory over
   a temp on-disk tree (kokoro files + an HF-cache Qwen snapshot), the
   dirSizeBytes sizer, and a route smoke test with both probes unreachable. */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildModelInventory,
  evaluateRemoval,
  performRemoval,
  modelsInventoryRouter,
  type InventoryDeps,
  type ModelInventoryItem,
} from './models-inventory.js';
import { dirSizeBytes, totalSizeBytes } from '../tts/model-paths.js';
import type { SidecarHealthResult } from './sidecar-health.js';

let repoRoot: string;
let hfCache: string;
let ttsHome: string;
const savedHfHubCache = process.env.HF_HUB_CACHE;
const savedHfHome = process.env.HF_HOME;
const savedTtsHome = process.env.TTS_HOME;

/* Coqui's XTTS v2 dir under a TTS_HOME, mirroring get_user_data_dir("tts"). */
const XTTS_DIR = 'tts_models--multilingual--multi-dataset--xtts_v2';

function writeFile(path: string, bytes: number) {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, Buffer.alloc(bytes, 1));
}

beforeEach(() => {
  repoRoot = mkdtempSync(join(tmpdir(), 'mm-repo-'));
  hfCache = mkdtempSync(join(tmpdir(), 'mm-hf-'));
  ttsHome = mkdtempSync(join(tmpdir(), 'mm-tts-'));
  /* Route the HF-cache resolver at our temp dir so qwen/whisper sizing is
     deterministic, and clear HF_HOME so it can't shadow HF_HUB_CACHE. */
  process.env.HF_HUB_CACHE = hfCache;
  delete process.env.HF_HOME;
  /* Pin TTS_HOME at a temp dir so the Coqui present-probe (coquiWeightsPresent)
     can't read the real %LOCALAPPDATA%\tts on the dev box and flake the
     "coqui absent" assertion. */
  process.env.TTS_HOME = ttsHome;
});

afterEach(() => {
  rmSync(repoRoot, { recursive: true, force: true });
  rmSync(hfCache, { recursive: true, force: true });
  rmSync(ttsHome, { recursive: true, force: true });
  if (savedHfHubCache === undefined) delete process.env.HF_HUB_CACHE;
  else process.env.HF_HUB_CACHE = savedHfHubCache;
  if (savedHfHome === undefined) delete process.env.HF_HOME;
  else process.env.HF_HOME = savedHfHome;
  if (savedTtsHome === undefined) delete process.env.TTS_HOME;
  else process.env.TTS_HOME = savedTtsHome;
  vi.restoreAllMocks();
});

const reachableSidecar: SidecarHealthResult = {
  status: 'reachable',
  url: 'http://localhost:9000',
  proxy: 'sidecar',
  kokoroLoaded: true,
  qwenLoaded: false,
  modelLoaded: false,
  asrLoaded: false,
  qwenInstallState: 'weights-missing',
};

function baseDeps(over: Partial<InventoryDeps> = {}): InventoryDeps {
  return {
    repoRoot,
    ts: '2026-06-06T00:00:00.000Z',
    sidecar: reachableSidecar,
    ollama: { reachable: true, models: [], resident: [] },
    resolvedTtsEngine: 'kokoro',
    analysisEngine: 'local',
    resolvedOllamaModel: 'qwen3.5:4b',
    ...over,
  };
}

describe('dirSizeBytes', () => {
  it('returns zero for a missing path', () => {
    expect(dirSizeBytes(join(repoRoot, 'nope'))).toEqual({ bytes: 0, fileCount: 0 });
  });

  it('sums file sizes recursively', () => {
    writeFile(join(repoRoot, 'a.bin'), 100);
    writeFile(join(repoRoot, 'sub', 'b.bin'), 50);
    expect(dirSizeBytes(repoRoot)).toEqual({ bytes: 150, fileCount: 2 });
  });

  it('sizes a single file directly', () => {
    writeFile(join(repoRoot, 'one.bin'), 42);
    expect(dirSizeBytes(join(repoRoot, 'one.bin'))).toEqual({ bytes: 42, fileCount: 1 });
  });

  it('totals multiple paths', () => {
    writeFile(join(repoRoot, 'x.bin'), 10);
    writeFile(join(repoRoot, 'y.bin'), 20);
    expect(totalSizeBytes([join(repoRoot, 'x.bin'), join(repoRoot, 'y.bin')])).toEqual({
      bytes: 30,
      fileCount: 2,
    });
  });
});

describe('buildModelInventory', () => {
  function installKokoro() {
    writeFile(join(repoRoot, 'server', 'tts-sidecar', 'voices', 'kokoro', 'kokoro-v1.0.onnx'), 1000);
    writeFile(join(repoRoot, 'server', 'tts-sidecar', 'voices', 'kokoro', 'voices-v1.0.bin'), 200);
  }
  function installQwenBase() {
    writeFile(
      join(
        hfCache,
        'models--Qwen--Qwen3-TTS-12Hz-0.6B-Base',
        'snapshots',
        'abc',
        'model.safetensors',
      ),
      5000,
    );
  }

  it('reports a present Kokoro with size, path, residency, and fallback flag', () => {
    installKokoro();
    const inv = buildModelInventory(baseDeps());
    const kokoro = inv.items.find((i) => i.id === 'kokoro')!;
    expect(kokoro.present).toBe(true);
    expect(kokoro.sizeBytes).toBe(1200);
    expect(kokoro.diskPath).toContain('kokoro');
    expect(kokoro.loaded).toBe(true);
    expect(kokoro.isFallbackEngine).toBe(true);
    expect(kokoro.isDefaultEngine).toBe(true); // resolvedTtsEngine: 'kokoro'
    expect(inv.sidecarReachable).toBe(true);
    expect(inv.ts).toBe('2026-06-06T00:00:00.000Z');
  });

  it('marks an absent model present:false with null size', () => {
    const inv = buildModelInventory(baseDeps());
    const coqui = inv.items.find((i) => i.id === 'coqui')!;
    expect(coqui.present).toBe(false);
    expect(coqui.sizeBytes).toBeNull();
    expect(coqui.removable).toBe(false);
  });

  it('reports Coqui present when model.pth lives in the TTS user-data dir', () => {
    /* Regression for the inventory↔installer-card disagreement: present is keyed
       off the same model.pth probe /api/coqui/detect uses, resolved under
       TTS_HOME — NOT the old voices/coqui guess the runtime never populates. */
    writeFile(join(ttsHome, 'tts', XTTS_DIR, 'model.pth'), 4096);
    const inv = buildModelInventory(baseDeps());
    const coqui = inv.items.find((i) => i.id === 'coqui')!;
    expect(coqui.present).toBe(true);
    expect(coqui.sizeBytes).toBe(4096);
    expect(coqui.removable).toBe(true);
  });

  it('sizes a Qwen Base HF snapshot and surfaces its install state', () => {
    installQwenBase();
    const inv = buildModelInventory(baseDeps());
    const qwen = inv.items.find((i) => i.id === 'qwen-base')!;
    expect(qwen.present).toBe(true);
    expect(qwen.sizeBytes).toBe(5000);
    expect(qwen.installState).toBe('weights-missing'); // from the stubbed health
    expect(qwen.isDefaultEngine).toBe(false); // default engine is kokoro here
  });

  it('lists local Ollama models with size + residency + default flag', () => {
    const inv = buildModelInventory(
      baseDeps({
        ollama: {
          reachable: true,
          models: [
            { name: 'qwen3.5:4b', size: 2_600_000_000 },
            { name: 'llama3.2:3b', size: 2_000_000_000 },
          ],
          resident: ['qwen3.5:4b'],
        },
      }),
    );
    const a = inv.items.find((i) => i.id === 'ollama:qwen3.5:4b')!;
    const b = inv.items.find((i) => i.id === 'ollama:llama3.2:3b')!;
    expect(a.kind).toBe('analyzer');
    expect(a.sizeBytes).toBe(2_600_000_000);
    expect(a.loaded).toBe(true); // resident
    expect(a.isDefaultEngine).toBe(true); // matches resolvedOllamaModel
    expect(b.loaded).toBe(false);
    expect(b.isDefaultEngine).toBe(false);
  });

  it('does not mark a same-family different-size tag as loaded (qwen3.5:4b resident ≠ qwen3.5:9b loaded)', () => {
    /* Regression: tagMatches over-matched on the family root, so a resident
       qwen3.5:4b lit up qwen3.5:9b as "Loaded" in the Model Manager even
       though ollama ps held only the 4b. Different explicit size tags must
       never be conflated. */
    const inv = buildModelInventory(
      baseDeps({
        ollama: {
          reachable: true,
          models: [
            { name: 'qwen3.5:4b', size: 3_200_000_000 },
            { name: 'qwen3.5:9b', size: 6_100_000_000 },
          ],
          resident: ['qwen3.5:4b'],
        },
      }),
    );
    const four = inv.items.find((i) => i.id === 'ollama:qwen3.5:4b')!;
    const nine = inv.items.find((i) => i.id === 'ollama:qwen3.5:9b')!;
    expect(four.loaded).toBe(true); // actually resident
    expect(nine.loaded).toBe(false); // NOT resident — must not borrow 4b's residency
  });

  it('treats a bare family tag as equivalent to :latest (qwen3.5 resident ⇒ qwen3.5:latest loaded)', () => {
    const inv = buildModelInventory(
      baseDeps({
        ollama: {
          reachable: true,
          models: [{ name: 'qwen3.5:latest', size: 3_200_000_000 }],
          resident: ['qwen3.5'],
        },
      }),
    );
    const latest = inv.items.find((i) => i.id === 'ollama:qwen3.5:latest')!;
    expect(latest.loaded).toBe(true); // bare 'qwen3.5' resident === ':latest'
  });

  it('flips Kokoro off-default when Qwen is the resolved engine', () => {
    installKokoro();
    const inv = buildModelInventory(baseDeps({ resolvedTtsEngine: 'qwen' }));
    expect(inv.items.find((i) => i.id === 'kokoro')!.isDefaultEngine).toBe(false);
    expect(inv.items.find((i) => i.id === 'qwen-base')!.isDefaultEngine).toBe(true);
  });
});

function item(over: Partial<ModelInventoryItem>): ModelInventoryItem {
  return {
    id: 'coqui',
    kind: 'tts',
    label: 'Coqui XTTS v2',
    present: true,
    sizeBytes: 1000,
    diskPath: '/x',
    loaded: false,
    isDefaultEngine: false,
    isFallbackEngine: false,
    removable: true,
    updatable: true,
    ...over,
  };
}

describe('evaluateRemoval', () => {
  it('allows a present, idle, non-default, non-fallback model', () => {
    expect(evaluateRemoval(item({})).ok).toBe(true);
  });
  it('blocks a loaded model (unload first)', () => {
    expect(evaluateRemoval(item({ loaded: true }))).toMatchObject({ ok: false, code: 'model-loaded' });
  });
  it('blocks the fallback engine the loudest (even if also default)', () => {
    expect(
      evaluateRemoval(item({ isFallbackEngine: true, isDefaultEngine: true })),
    ).toMatchObject({ ok: false, code: 'model-is-fallback' });
  });
  it('blocks the current default engine', () => {
    expect(evaluateRemoval(item({ isDefaultEngine: true }))).toMatchObject({
      ok: false,
      code: 'model-is-default',
    });
  });
});

describe('performRemoval', () => {
  it('deletes the Kokoro weight dir and reports freed bytes', async () => {
    writeFile(join(repoRoot, 'server', 'tts-sidecar', 'voices', 'kokoro', 'kokoro-v1.0.onnx'), 1000);
    writeFile(join(repoRoot, 'server', 'tts-sidecar', 'voices', 'kokoro', 'voices-v1.0.bin'), 200);
    const res = await performRemoval('kokoro', repoRoot);
    expect(res.removed).toBe(true);
    expect(res.freedBytes).toBe(1200);
    expect(dirSizeBytes(join(repoRoot, 'server', 'tts-sidecar', 'voices', 'kokoro')).bytes).toBe(0);
  });

  it('is a no-op (0 bytes) when the path is already gone', async () => {
    const res = await performRemoval('coqui', repoRoot);
    expect(res).toEqual({ removed: true, freedBytes: 0 });
  });
});

describe('POST /api/models/:id/remove', () => {
  it('404s an unknown model id', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new Error('offline'))),
    );
    const app = express();
    app.use(express.json());
    app.use('/api/models', modelsInventoryRouter);
    const res = await request(app).post('/api/models/not-a-model/remove');
    expect(res.status).toBe(404);
  });
});

describe('GET /api/models/inventory', () => {
  it('returns an inventory even when both probes are unreachable', async () => {
    /* Stub global fetch so the sidecar + ollama probes both fail fast. */
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new Error('connect ECONNREFUSED'))),
    );
    const app = express();
    app.use(express.json());
    app.use('/api/models', modelsInventoryRouter);

    const res = await request(app).get('/api/models/inventory');
    expect(res.status).toBe(200);
    expect(res.body.sidecarReachable).toBe(false);
    /* The five fixed engine rows are always present even with no sidecar. */
    const ids = res.body.items.map((i: { id: string }) => i.id);
    expect(ids).toEqual(
      expect.arrayContaining(['kokoro', 'qwen-base', 'qwen-design', 'coqui', 'whisper']),
    );
  });
});
