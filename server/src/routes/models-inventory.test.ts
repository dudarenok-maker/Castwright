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
  modelsInventoryRouter,
  type InventoryDeps,
} from './models-inventory.js';
import { dirSizeBytes, totalSizeBytes } from '../tts/model-paths.js';
import type { SidecarHealthResult } from './sidecar-health.js';

let repoRoot: string;
let hfCache: string;
const savedHfHubCache = process.env.HF_HUB_CACHE;
const savedHfHome = process.env.HF_HOME;

function writeFile(path: string, bytes: number) {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, Buffer.alloc(bytes, 1));
}

beforeEach(() => {
  repoRoot = mkdtempSync(join(tmpdir(), 'mm-repo-'));
  hfCache = mkdtempSync(join(tmpdir(), 'mm-hf-'));
  /* Route the HF-cache resolver at our temp dir so qwen/whisper sizing is
     deterministic, and clear HF_HOME so it can't shadow HF_HUB_CACHE. */
  process.env.HF_HUB_CACHE = hfCache;
  delete process.env.HF_HOME;
});

afterEach(() => {
  rmSync(repoRoot, { recursive: true, force: true });
  rmSync(hfCache, { recursive: true, force: true });
  if (savedHfHubCache === undefined) delete process.env.HF_HUB_CACHE;
  else process.env.HF_HUB_CACHE = savedHfHubCache;
  if (savedHfHome === undefined) delete process.env.HF_HOME;
  else process.env.HF_HOME = savedHfHome;
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

  it('flips Kokoro off-default when Qwen is the resolved engine', () => {
    installKokoro();
    const inv = buildModelInventory(baseDeps({ resolvedTtsEngine: 'qwen' }));
    expect(inv.items.find((i) => i.id === 'kokoro')!.isDefaultEngine).toBe(false);
    expect(inv.items.find((i) => i.id === 'qwen-base')!.isDefaultEngine).toBe(true);
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
