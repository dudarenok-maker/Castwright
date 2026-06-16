# Dynamic Local Analyzer Models + Measured Keep-Alive — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make local (Ollama) analyzer model selection dynamic (curated ∪ live `/api/tags`), replace the hardcoded `RESIDENT_MODELS` set with a single `ANALYZER_KEEP_ALIVE` knob plus a measured-VRAM adaptive-eviction rule, and add `gemma-4-E4B-it-GGUF:UD-Q4_K_XL` to the single canonical install list.

**Architecture:** Merge-on-top — curated `MODEL_OPTIONS` stays as decoration + the engine-classifier safety net; live tags union on top. Keep-alive is a time knob with an adaptive `'0'` override driven by a measured per-model VRAM EMA (sampled from `/api/ps.size_vram` after each analysis call, only when the model is 100% on GPU) compared against a boot-probed device-total. Measured GPU-semaphore weights are explicitly OUT (deferred to a separate experiment).

**Tech Stack:** TypeScript, Node/Express (server), Vitest (server + frontend), React 18 + Redux Toolkit (frontend), Ollama HTTP API.

**Spec:** `docs/superpowers/specs/2026-06-16-dynamic-analyzer-models-design.md`

**Conventions:** TDD (failing test first). Commit after each green task. Run server tests with `cd server && npm run test -- <path>`; frontend with `npm run test -- <path>` from repo root. **The pre-commit hook does NOT run typecheck** — so after each task that touches `.ts`/`.tsx`, also run the relevant typecheck (`cd server && npm run typecheck` for server tasks, `npm run typecheck` from root for frontend) BEFORE committing. A type error otherwise commits silently and only detonates at the final `npm run verify`, far from its cause. This work happens in worktree `C:\Claude\wt-dynamic-analyzer-models` on branch `feat/server-dynamic-analyzer-models`.

---

## Task 1: Add the target model to the canonical install list

**Files:**
- Modify: `server/src/ollama/pull-bootstrap.ts:63-69` (`DEFAULT_ALLOWED_MODELS`)
- Modify: `server/src/ollama/pull-bootstrap.ts` (add `listAllowed()` method)
- Test: `server/src/ollama/pull-bootstrap.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `server/src/ollama/pull-bootstrap.test.ts`:

```ts
import { DEFAULT_ALLOWED_MODELS, PullBootstrap } from './pull-bootstrap.js';

describe('canonical install list', () => {
  it('includes the gemma-4 E4B edge model', () => {
    expect(DEFAULT_ALLOWED_MODELS.has('gemma-4-E4B-it-GGUF:UD-Q4_K_XL')).toBe(true);
  });

  it('listAllowed() returns the allowlist as an array', () => {
    const pb = new PullBootstrap();
    expect(pb.listAllowed()).toEqual(expect.arrayContaining(['gemma-4-E4B-it-GGUF:UD-Q4_K_XL']));
  });

  it('still rejects an off-list tag', () => {
    const pb = new PullBootstrap();
    expect(pb.isAllowed('totally-made-up:99b')).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npm run test -- src/ollama/pull-bootstrap.test.ts`
Expected: FAIL — `gemma-4-E4B-it-GGUF:UD-Q4_K_XL` not in set; `listAllowed` is not a function.

- [ ] **Step 3: Add the tag and the accessor**

In `DEFAULT_ALLOWED_MODELS` (line 63), add the tag:

```ts
export const DEFAULT_ALLOWED_MODELS: ReadonlySet<string> = new Set([
  'qwen3.5:4b',
  'qwen3.5:9b',
  'llama3.1:8b',
  'llama3.2:3b',
  'gemma3:4b',
  'gemma-4-E4B-it-GGUF:UD-Q4_K_XL',
]);
```

Add a method to the `PullBootstrap` class (next to `isAllowed`):

```ts
  /** The curated install list — both the pull suggestions the Model Manager
      renders and the allowlist this proxy enforces. Single source of truth. */
  listAllowed(): string[] {
    return [...this.allowedModels];
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && npm run test -- src/ollama/pull-bootstrap.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/ollama/pull-bootstrap.ts server/src/ollama/pull-bootstrap.test.ts
git commit -m "feat(server): add gemma-4 E4B to the canonical install list + listAllowed()"
```

---

## Task 2: Register the `ANALYZER_KEEP_ALIVE` + adaptive knobs

**Files:**
- Modify: `server/src/config/registry.ts` (add two knobs to the `analyzer-models` group block, after the existing `analyzer.phase1.minLagChapters` knob ~line 715)
- Test: `server/src/config/registry.test.ts` (create if absent; otherwise add a describe block)

- [ ] **Step 1: Write the failing test**

Create/append `server/src/config/registry.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { getKnob, knobByEnv } from './registry.js';

describe('analyzer keep-alive knobs', () => {
  it('registers ANALYZER_KEEP_ALIVE with a 1m default', () => {
    const k = getKnob('analyzer.ollama.keepAlive');
    expect(k).toBeDefined();
    expect(k?.env).toBe('ANALYZER_KEEP_ALIVE');
    expect(k?.default).toBe('1m');
    expect(k?.apply).toBe('live');
  });

  it('registers ANALYZER_KEEP_ALIVE_ADAPTIVE defaulting on', () => {
    const k = knobByEnv('ANALYZER_KEEP_ALIVE_ADAPTIVE');
    expect(k).toBeDefined();
    expect(k?.type).toBe('boolean');
    expect(k?.default).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npm run test -- src/config/registry.test.ts`
Expected: FAIL — knobs undefined.

- [ ] **Step 3: Add the knobs**

In `server/src/config/registry.ts`, inside the `analyzer-models` section (after the `analyzer.phase1.minLagChapters` knob, before the closing of that group's entries), add:

```ts
  {
    key: 'analyzer.ollama.keepAlive',
    env: 'ANALYZER_KEEP_ALIVE',
    group: 'analyzer-models',
    label: 'Analyzer keep-alive',
    help: "How long Ollama holds the analyzer model in VRAM after a call (Ollama keep_alive: '1m', '5m', '0' to unload immediately, '-1' to pin). Applied to every analyzer model. '1m' bridges the gap between back-to-back chapter calls without a long post-run squat. When adaptive eviction is on, a model whose measured VRAM can't coexist with the fallback engine is unloaded immediately regardless.",
    type: 'string',
    default: '1m', // ← resolveAnalyzerKeepAlive() default in analyzer/ollama.ts
    apply: 'live', risk: 'medium',
  },
  {
    key: 'analyzer.ollama.keepAliveAdaptive',
    env: 'ANALYZER_KEEP_ALIVE_ADAPTIVE',
    group: 'analyzer-models',
    label: 'Adaptive keep-alive eviction',
    help: 'When on (default), the analyzer is unloaded immediately (keep_alive 0) when its measured VRAM footprint plus the fallback engine would exceed the GPU. Requires a measured sample + a readable device-total; until both exist it behaves as the flat keep-alive knob.',
    type: 'boolean',
    default: true, // ← resolveAnalyzerKeepAliveAdaptive() default in analyzer/ollama.ts
    apply: 'live', risk: 'medium',
  },
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && npm run test -- src/config/registry.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/config/registry.ts server/src/config/registry.test.ts
git commit -m "feat(server): register ANALYZER_KEEP_ALIVE + adaptive knobs"
```

---

## Task 3: Device-total VRAM boot probe

A module that probes total GPU VRAM once (via `nvidia-smi`), caches it, and serves it synchronously. Independent of the TTS sidecar (which is typically down during analysis).

**Files:**
- Create: `server/src/gpu/device-total.ts`
- Test: `server/src/gpu/device-total.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import {
  parseNvidiaSmiTotalMb,
  setDeviceTotalVramMb,
  getDeviceTotalVramMb,
  _resetDeviceTotalForTests,
} from './device-total.js';

describe('device-total VRAM', () => {
  beforeEach(() => _resetDeviceTotalForTests());

  it('parses nvidia-smi memory.total CSV output (MiB)', () => {
    expect(parseNvidiaSmiTotalMb('8188\n')).toBe(8188);
    expect(parseNvidiaSmiTotalMb('8188 MiB\n')).toBe(8188);
  });

  it('returns null for unparseable output', () => {
    expect(parseNvidiaSmiTotalMb('')).toBeNull();
    expect(parseNvidiaSmiTotalMb('no GPU')).toBeNull();
  });

  it('caches a set value and serves it synchronously', () => {
    expect(getDeviceTotalVramMb()).toBeNull();
    setDeviceTotalVramMb(8188);
    expect(getDeviceTotalVramMb()).toBe(8188);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npm run test -- src/gpu/device-total.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the module**

Create `server/src/gpu/device-total.ts`:

```ts
/* Boot-time GPU total-VRAM probe. The analyzer keep-alive decision
   (analyzer/ollama.ts keepAliveFor) needs the device total synchronously,
   and the TTS sidecar — the other VRAM source — is typically DOWN during
   analysis (sequential phases). So we probe once at server start via
   nvidia-smi and cache the result. Non-NVIDIA / no nvidia-smi → null, which
   disables adaptive eviction (keep-alive falls back to the flat knob). */

import { execFile } from 'node:child_process';

let cachedTotalMb: number | null = null;

/** Parse `nvidia-smi --query-gpu=memory.total --format=csv,noheader,nounits`.
    Output is the first GPU's total in MiB, optionally with a " MiB" suffix. */
export function parseNvidiaSmiTotalMb(raw: string): number | null {
  const first = raw.split('\n').map((l) => l.trim()).find((l) => l.length > 0);
  if (!first) return null;
  const m = first.match(/(\d+)/);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** Test seam + the init path's setter. */
export function setDeviceTotalVramMb(mb: number | null): void {
  cachedTotalMb = mb;
}

/** Synchronous read for keepAliveFor(). Null until initDeviceTotalVram() runs
    (or on a box without nvidia-smi). */
export function getDeviceTotalVramMb(): number | null {
  return cachedTotalMb;
}

export function _resetDeviceTotalForTests(): void {
  cachedTotalMb = null;
}

/** Fire once at server boot. Best-effort: any failure leaves the cache null. */
export async function initDeviceTotalVram(): Promise<void> {
  await new Promise<void>((resolveP) => {
    execFile(
      'nvidia-smi',
      ['--query-gpu=memory.total', '--format=csv,noheader,nounits'],
      { timeout: 4_000, windowsHide: true },
      (err, stdout) => {
        if (!err && typeof stdout === 'string') {
          cachedTotalMb = parseNvidiaSmiTotalMb(stdout);
        }
        resolveP();
      },
    );
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && npm run test -- src/gpu/device-total.test.ts`
Expected: PASS.

- [ ] **Step 5: Wire the boot probe**

In `server/src/index.ts`, import and call `initDeviceTotalVram()` during startup (fire-and-forget, near where other one-time probes/inits run):

```ts
import { initDeviceTotalVram } from './gpu/device-total.js';
// ...during server bootstrap, alongside other init calls:
void initDeviceTotalVram();
```

- [ ] **Step 6: Run the full server suite for the touched area + commit**

Run: `cd server && npm run test -- src/gpu/`
Expected: PASS.

```bash
git add server/src/gpu/device-total.ts server/src/gpu/device-total.test.ts server/src/index.ts
git commit -m "feat(server): boot-time nvidia-smi device-total VRAM probe"
```

---

## Task 4: Measured-VRAM stats store (append-only JSONL + EMA-at-read)

**Files:**
- Create: `server/src/analyzer/model-vram-stats.ts`
- Test: `server/src/analyzer/model-vram-stats.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest';
import { canonicalVramKey, foldEma, _emaFromRecords } from './model-vram-stats.js';

describe('model-vram-stats helpers', () => {
  it('canonicalises a bare model name to :latest and suffixes num_ctx', () => {
    expect(canonicalVramKey('qwen3.5', 32768)).toBe('qwen3.5:latest@32768');
    expect(canonicalVramKey('gemma-4-E4B-it-GGUF:UD-Q4_K_XL', 32768)).toBe(
      'gemma-4-E4B-it-GGUF:UD-Q4_K_XL@32768',
    );
  });

  it('foldEma weights recent samples more (alpha=0.3)', () => {
    // ema0 = 1000; ema1 = .3*2000 + .7*1000 = 1300
    expect(foldEma([1000, 2000])).toBeCloseTo(1300, 5);
  });

  it('_emaFromRecords returns null when no record matches the key', () => {
    const recs = [{ at: 'x', key: 'other:latest@32768', vramMb: 500 }];
    expect(_emaFromRecords(recs, 'qwen3.5:latest@32768')).toBeNull();
  });

  it('_emaFromRecords folds matching records in file (chronological) order', () => {
    const recs = [
      { at: '1', key: 'm:latest@32768', vramMb: 1000 },
      { at: '2', key: 'm:latest@32768', vramMb: 2000 },
      { at: '3', key: 'other@1', vramMb: 9999 },
    ];
    expect(_emaFromRecords(recs, 'm:latest@32768')).toBeCloseTo(1300, 5);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npm run test -- src/analyzer/model-vram-stats.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the store**

Create `server/src/analyzer/model-vram-stats.ts`:

```ts
/* Measured per-model VRAM store. Each analysis call samples the resident
   model's actual GPU footprint from Ollama /api/ps (size_vram) and appends a
   JSONL line; keepAliveFor() reads back an EMA to decide whether the model is
   small enough to stay resident. Append-only (mirrors resource-telemetry.ts)
   because a read-modify-write JSON object loses concurrent updates. EMA is
   computed at read time by folding the log in chronological (file) order. */

import { mkdir, readFile, writeFile, appendFile } from 'node:fs/promises';
import { join } from 'node:path';
import { telemetryDir } from '../workspace/paths.js';

export interface VramSampleRecord {
  at: string;
  key: string; // canonicalVramKey(model, numCtx)
  vramMb: number;
}

const EMA_ALPHA = 0.3;
const MAX_LINES = 1000;

export function vramStatsFilePath(): string {
  return join(telemetryDir(), 'model-vram-stats.jsonl');
}

/** Canonical store key. Ollama canonicalises a bare family name to ':latest'
    (qwen3.5 ⇄ qwen3.5:latest are the same model); two explicit tags that only
    share a root (qwen3.5:4b vs :9b) are NOT. num_ctx is part of the key because
    KV-cache VRAM scales with it. */
export function canonicalVramKey(model: string, numCtx: number): string {
  const norm = model.includes(':') ? model : `${model}:latest`;
  return `${norm}@${numCtx}`;
}

/** EMA over an ordered list of samples (oldest → newest). */
export function foldEma(values: number[]): number | null {
  if (values.length === 0) return null;
  let ema = values[0];
  for (let i = 1; i < values.length; i++) ema = EMA_ALPHA * values[i] + (1 - EMA_ALPHA) * ema;
  return ema;
}

export function _emaFromRecords(records: VramSampleRecord[], key: string): number | null {
  return foldEma(records.filter((r) => r.key === key).map((r) => r.vramMb));
}

/** Append one sample. Best-effort — never throws (fire-and-forget on the
    analysis path). Trims to MAX_LINES via read-trim-rewrite past the cap. */
export async function recordVramSample(rec: VramSampleRecord): Promise<void> {
  const path = vramStatsFilePath();
  try {
    await mkdir(telemetryDir(), { recursive: true });
    await appendFile(path, `${JSON.stringify(rec)}\n`, 'utf8');
    const raw = await readFile(path, 'utf8');
    const lines = raw.split('\n').filter((l) => l.trim().length > 0);
    if (lines.length > MAX_LINES) {
      await writeFile(path, `${lines.slice(lines.length - MAX_LINES).join('\n')}\n`, 'utf8');
    }
  } catch {
    /* observability, not correctness */
  }
}

async function readRecords(): Promise<VramSampleRecord[]> {
  let raw: string;
  try {
    raw = await readFile(vramStatsFilePath(), 'utf8');
  } catch {
    return [];
  }
  const out: VramSampleRecord[] = [];
  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try {
      out.push(JSON.parse(t) as VramSampleRecord);
    } catch {
      /* skip corrupt/partial line */
    }
  }
  return out; // chronological (file) order — do NOT reverse for EMA
}

/** Async EMA read (used by tooling / tests that read the file). The hot
    keepAliveFor() path uses a synchronous in-memory cache primed below. */
export async function emaForModelAsync(model: string, numCtx: number): Promise<number | null> {
  return _emaFromRecords(await readRecords(), canonicalVramKey(model, numCtx));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && npm run test -- src/analyzer/model-vram-stats.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/analyzer/model-vram-stats.ts server/src/analyzer/model-vram-stats.test.ts
git commit -m "feat(server): append-only measured-VRAM stats store (EMA at read)"
```

---

## Task 5: Sampling — capture `/api/ps.size_vram` after a call (100%-GPU guard) + sync EMA cache

`keepAliveFor()` is synchronous (called while building the request body). So the store needs a synchronous read. We maintain an in-memory EMA cache updated whenever a sample is recorded, and a sampler that reads `/api/ps`.

**Files:**
- Modify: `server/src/analyzer/model-vram-stats.ts` (add sync cache + `sampleAndRecordVram`)
- Test: `server/src/analyzer/model-vram-stats.test.ts`

- [ ] **Step 1: Write the failing test**

Append:

```ts
import {
  emaForModelSync,
  primeVramCache,
  sampleAndRecordVram,
  _resetVramCacheForTests,
} from './model-vram-stats.js';

describe('sampleAndRecordVram', () => {
  beforeEach(() => _resetVramCacheForTests());

  it('records a sample only when the model is ~100% on GPU', async () => {
    const fetchFn = async () => ({
      ok: true,
      json: async () => ({
        models: [{ name: 'm:latest', size: 5_000_000_000, size_vram: 5_000_000_000 }],
      }),
    });
    await sampleAndRecordVram('http://x', 'm', 32768, fetchFn as any);
    // 5_000_000_000 bytes ≈ 4768 MB
    expect(emaForModelSync('m', 32768)).toBeCloseTo(4768.37, 0);
  });

  it('skips a partially-offloaded model (size_vram << size)', async () => {
    const fetchFn = async () => ({
      ok: true,
      json: async () => ({
        models: [{ name: 'm:latest', size: 5_000_000_000, size_vram: 2_000_000_000 }],
      }),
    });
    await sampleAndRecordVram('http://x', 'm', 32768, fetchFn as any);
    expect(emaForModelSync('m', 32768)).toBeNull();
  });

  it('primeVramCache folds the persisted log into the sync cache', () => {
    primeVramCache([
      { at: '1', key: 'm:latest@32768', vramMb: 1000 },
      { at: '2', key: 'm:latest@32768', vramMb: 2000 },
    ]);
    expect(emaForModelSync('m', 32768)).toBeCloseTo(1300, 5);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npm run test -- src/analyzer/model-vram-stats.test.ts`
Expected: FAIL — new exports undefined.

- [ ] **Step 3: Implement sync cache + sampler**

Append to `server/src/analyzer/model-vram-stats.ts`:

```ts
/* Synchronous EMA cache for keepAliveFor(). Keyed by canonicalVramKey. Updated
   on every recordVramSample and primed from disk at boot. */
const emaCache = new Map<string, number>();

export function emaForModelSync(model: string, numCtx: number): number | null {
  const v = emaCache.get(canonicalVramKey(model, numCtx));
  return v ?? null;
}

function updateEmaCache(key: string, vramMb: number): void {
  const prev = emaCache.get(key);
  emaCache.set(key, prev == null ? vramMb : EMA_ALPHA * vramMb + (1 - EMA_ALPHA) * prev);
}

/** Prime the sync cache from a record list (called at boot with readRecords()). */
export function primeVramCache(records: VramSampleRecord[]): void {
  emaCache.clear();
  const byKey = new Map<string, number[]>();
  for (const r of records) {
    const arr = byKey.get(r.key) ?? [];
    arr.push(r.vramMb);
    byKey.set(r.key, arr);
  }
  for (const [key, vals] of byKey) {
    const ema = foldEma(vals);
    if (ema != null) emaCache.set(key, ema);
  }
}

export function _resetVramCacheForTests(): void {
  emaCache.clear();
}

/** Boot init: read the persisted log and prime the sync cache. */
export async function initVramStats(): Promise<void> {
  primeVramCache(await readRecords());
}

type MinimalFetch = (url: string) => Promise<{ ok: boolean; json: () => Promise<unknown> }>;

/** Fraction of total bytes that must be resident in VRAM to count as a clean,
    fully-on-GPU sample. A partial CPU/GPU split under-reports the true need —
    recording it would teach keepAliveFor a model "fits" when it actually
    spilled, the precise wrong call. */
const GPU_RESIDENT_FRACTION = 0.95;

/** Read /api/ps once, find `model`, and record its size_vram (MB) IF the model
    is ~100% resident on GPU. Best-effort; never throws. */
/** Default fetch with a 1s abort budget — the sampler is awaited inside the
    analyzer's GPU lock (ollama.ts), so a hung /api/ps must not pin the GPU. */
const timedFetch: MinimalFetch = (u) => {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 1_000);
  return (fetch(u, { signal: ctrl.signal }) as unknown as ReturnType<MinimalFetch>).finally(
    () => clearTimeout(timer),
  );
};

export async function sampleAndRecordVram(
  url: string,
  model: string,
  numCtx: number,
  fetchFn: MinimalFetch = timedFetch,
): Promise<void> {
  try {
    const resp = await fetchFn(`${url.replace(/\/+$/, '')}/api/ps`);
    if (!resp.ok) return;
    const body = (await resp.json()) as {
      models?: Array<{ name?: string; model?: string; size?: number; size_vram?: number }>;
    };
    const norm = (t: string) => (t.includes(':') ? t : `${t}:latest`);
    const want = norm(model);
    const hit = (body.models ?? []).find((m) => norm(m.name ?? m.model ?? '') === want);
    if (!hit) return;
    const size = hit.size ?? 0;
    const vram = hit.size_vram ?? 0;
    if (size <= 0 || vram < size * GPU_RESIDENT_FRACTION) return; // not fully on GPU → skip
    const vramMb = vram / 1024 / 1024;
    const key = canonicalVramKey(model, numCtx);
    updateEmaCache(key, vramMb);
    await recordVramSample({ at: new Date().toISOString(), key, vramMb });
  } catch {
    /* best-effort */
  }
}
```

Note: `recordVramSample` must also keep the sync cache hot for processes that only write — update it there too. Add `updateEmaCache(rec.key, rec.vramMb)` is already done by the sampler before the await; do NOT double-update inside `recordVramSample` (the sampler owns the cache update).

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && npm run test -- src/analyzer/model-vram-stats.test.ts`
Expected: PASS.

- [ ] **Step 5: Wire boot priming**

In `server/src/index.ts`, alongside `initDeviceTotalVram()`:

```ts
import { initVramStats } from './analyzer/model-vram-stats.js';
void initVramStats();
```

- [ ] **Step 6: Commit**

```bash
git add server/src/analyzer/model-vram-stats.ts server/src/analyzer/model-vram-stats.test.ts server/src/index.ts
git commit -m "feat(server): sample /api/ps size_vram (100%-GPU guard) into sync EMA cache"
```

---

## Task 6: Rewrite `keepAliveFor` (knob + adaptive) and wire the sampler into `chat()`

**Files:**
- Modify: `server/src/analyzer/ollama.ts:109-131` (delete `RESIDENT_MODELS`, rewrite `keepAliveFor`, add resolvers)
- Modify: `server/src/analyzer/ollama.ts` (call `sampleAndRecordVram` after the stream drains)
- Test: `server/src/analyzer/ollama.test.ts:186-234` (rewrite the keep-alive block)

- [ ] **Step 1: Rewrite the failing test (replace the existing keep-alive describe block)**

Replace the `describe('keep_alive policy', …)` block in `server/src/analyzer/ollama.test.ts` (lines ~186-234) with the block below. **The config-override API is `writeConfigOverride` / `clearAllConfigOverrides` from `../workspace/user-settings.js` and is ASYNC** (it writes the user-settings JSON and refreshes the sync cache `configValue` reads). There is NO `../config/store.js` / `setConfigOverride`. An awaited write is visible to the next synchronous `configValue` read.

```ts
import { setDeviceTotalVramMb, _resetDeviceTotalForTests } from '../gpu/device-total.js';
import { primeVramCache, _resetVramCacheForTests } from './model-vram-stats.js';
import { writeConfigOverride, clearAllConfigOverrides } from '../workspace/user-settings.js';

describe('keepAliveFor', () => {
  beforeEach(async () => {
    _resetDeviceTotalForTests();
    _resetVramCacheForTests();
    await clearAllConfigOverrides();
  });

  it('returns the knob default (1m) for any model when unmeasured', () => {
    expect(keepAliveFor('anything:7b')).toBe('1m');
    expect(keepAliveFor('gemma-4-E4B-it-GGUF:UD-Q4_K_XL')).toBe('1m');
  });

  it('honors an ANALYZER_KEEP_ALIVE override', async () => {
    await writeConfigOverride('analyzer.ollama.keepAlive', '0');
    expect(keepAliveFor('qwen3.5:4b')).toBe('0');
  });

  it('keeps a measured model resident when it fits with the fallback engine', () => {
    setDeviceTotalVramMb(8188);
    primeVramCache([{ at: '1', key: 'gemma-4-E4B-it-GGUF:UD-Q4_K_XL@32768', vramMb: 6500 }]);
    // 6500 + 1024 (Kokoro) = 7524 <= 8188*0.92 ≈ 7533 → resident
    expect(keepAliveFor('gemma-4-E4B-it-GGUF:UD-Q4_K_XL')).toBe('1m');
  });

  it('evicts a measured model that cannot coexist with the fallback engine', () => {
    setDeviceTotalVramMb(8188);
    primeVramCache([{ at: '1', key: 'huge:9b@32768', vramMb: 7000 }]);
    // 7000 + 1024 = 8024 > 7533 → evict
    expect(keepAliveFor('huge:9b')).toBe(0);
  });

  it('falls back to the knob when device-total is unknown', () => {
    setDeviceTotalVramMb(null);
    primeVramCache([{ at: '1', key: 'huge:9b@32768', vramMb: 7000 }]);
    expect(keepAliveFor('huge:9b')).toBe('1m');
  });

  it('falls back to the knob when adaptive is off', async () => {
    await writeConfigOverride('analyzer.ollama.keepAliveAdaptive', false);
    setDeviceTotalVramMb(8188);
    primeVramCache([{ at: '1', key: 'huge:9b@32768', vramMb: 7000 }]);
    expect(keepAliveFor('huge:9b')).toBe('1m');
  });
});
```

> Confirm the exact helper names by reading the top of `server/src/workspace/user-settings.ts` (it exports `writeConfigOverride`, `clearConfigOverride`, `clearAllConfigOverrides`). The env-var route (`process.env.ANALYZER_KEEP_ALIVE = '0'` + restore in `afterEach`) is an equally valid, simpler alternative since `resolveKnob` checks env before overrides.

**Keep ≥1 wire-level test (do NOT go pure-function-only).** The block being replaced (`ollama.test.ts:206-231`) also asserts the resolved value actually reaches the `/api/chat` request body. Retain that seam — otherwise a regression where `keepAliveFor` is correct but its value is dropped when building the body passes every new test. Add (using the file's existing `fetchMock` + a real `runStage1Chapter`):

```ts
it('threads the resolved keep_alive into the /api/chat body (evict case)', async () => {
  setDeviceTotalVramMb(8188);
  primeVramCache([{ at: '1', key: 'huge:9b@32768', vramMb: 7000 }]);
  // run a real OllamaAnalyzer call against the fetch mock, then:
  const body = JSON.parse(lastChatRequestBody()); // however the file captures it
  expect(body.keep_alive).toBe(0);
});
```

- [ ] **Step 1b: Fix the pre-existing happy-path keep_alive assertion (it would otherwise go red)**

The keep-alive change also affects a test OUTSIDE the replaced block: `ollama.test.ts:155` in the `OllamaAnalyzer — happy path streaming` describe asserts `expect(body.keep_alive).toBe(0)` for `qwen3.5:9b`. Under the new `keepAliveFor`, an unmeasured `9b` returns the `'1m'` knob default. Update that assertion to `expect(body.keep_alive).toBe('1m')` and fix the stale `RESIDENT_MODELS` comment at lines ~150-154 (no resident set anymore — every model gets the knob unless adaptively evicted).

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npm run test -- src/analyzer/ollama.test.ts`
Expected: FAIL — `keepAliveFor` still uses `RESIDENT_MODELS`.

- [ ] **Step 3: Rewrite `keepAliveFor` + resolvers**

In `server/src/analyzer/ollama.ts`, delete the `RESIDENT_MODELS` const (lines 109-121) and replace `keepAliveFor` (lines 123-131) with:

```ts
import { getDeviceTotalVramMb } from '../gpu/device-total.js';
import { emaForModelSync } from './model-vram-stats.js';

/** Fraction of total VRAM usable before we consider the analyzer crowding the
    GPU. Leaves headroom for the OS / CUDA working set. */
const KEEPALIVE_HEADROOM = 0.92;
/** Reserve for the universal fallback engine (Kokoro, ~1 GB). Hardcoded:
    Kokoro is onnxruntime, invisible to any torch/Ollama VRAM number, so a
    "measured" value would read ~0 and defeat the rule. */
const FALLBACK_RESERVE_MB = 1024;

/** Live-read keep-alive base value (registry wins). */
export function resolveAnalyzerKeepAlive(): string {
  return configValue<string>('analyzer.ollama.keepAlive');
}
/** Live-read adaptive-eviction toggle. */
export function resolveAnalyzerKeepAliveAdaptive(): boolean {
  return configValue<boolean>('analyzer.ollama.keepAliveAdaptive');
}

/** Picks the `keep_alive` value for an Ollama /api/chat call.

    Base: the ANALYZER_KEEP_ALIVE knob (default '1m'), applied to EVERY model
    — no hardcoded resident set. When adaptive eviction is on AND we have both
    a boot-probed device-total and a measured footprint for this model, a model
    that cannot coexist with the fallback engine is unloaded immediately ('0').
    Cold-start / no-GPU / sidecar-down all degrade safely to the base knob. */
export function keepAliveFor(model: string): string | number {
  const base = resolveAnalyzerKeepAlive();
  if (!resolveAnalyzerKeepAliveAdaptive()) return base;
  const totalMb = getDeviceTotalVramMb();
  if (totalMb == null) return base;
  const ema = emaForModelSync(model, resolveAnalyzerNumCtx());
  if (ema == null) return base;
  return ema + FALLBACK_RESERVE_MB <= totalMb * KEEPALIVE_HEADROOM ? base : 0;
}
```

- [ ] **Step 4: Run the keep-alive test**

Run: `cd server && npm run test -- src/analyzer/ollama.test.ts`
Expected: PASS (the keep-alive describe block).

- [ ] **Step 5: Wire the sampler into `chat()` — INSIDE the GPU lock, AWAITED**

CRITICAL placement (runtime-review finding): the sample must be taken while the analyzer **still holds the GPU semaphore**, so `this.model` is provably the sole/just-used resident model. The GPU is released in the OUTER `finally` (`releaseGpu()`, ollama.ts:601-602); `return buf;` is the last line of the inner `try` (line 600). A fire-and-forget sample (`void …`) would resolve AFTER release, by which time the next queued chat() may have begun loading a different model — so `/api/ps` could read the wrong (or mid-eviction) model and teach a corrupt EMA. Instead **`await` the sample on the success path, immediately before `return buf;`** (still inside the try, before the finally releases):

```ts
import { sampleAndRecordVram } from './model-vram-stats.js';
// ...immediately before `return buf;` (success path, GPU still held):
await sampleAndRecordVram(this.url, this.model, resolveAnalyzerNumCtx());
return buf;
```

`sampleAndRecordVram` is best-effort (swallows all errors, never throws) and its `/api/ps` fetch is bounded by a short timeout (Task 5) so it cannot pin the GPU lock — the added latency is one local `/api/ps` round-trip (~10-50 ms) against a multi-second analysis call. Do NOT place it on the error/abort path (only sample a model we successfully streamed from). Because the sample runs inside the lock, co-residence from a prior model still held under `keep_alive` is handled by `sampleAndRecordVram` matching `this.model` by canonical name.

Add a paired test in `ollama.test.ts` for this wiring (the seam the Task 5 unit tests can't see): with the `/api/ps` fetch stubbed, a successful `runStage1Chapter` issues a `/api/ps` GET for `this.url`; an aborted/errored stream issues NONE.

- [ ] **Step 6: Run the full analyzer suite + commit**

Run: `cd server && npm run test -- src/analyzer/ollama.test.ts`
Expected: PASS.

```bash
git add server/src/analyzer/ollama.ts server/src/analyzer/ollama.test.ts
git commit -m "feat(server): measured adaptive keep-alive; delete RESIDENT_MODELS; sample after chat"
```

---

## Task 7: Expose `pullable` from the canonical list + de-duplicate `/refresh`

**Files:**
- Modify: `server/src/routes/ollama-health.ts:96-105` (`OllamaHealthResult` + `probeOllamaHealth` returns), `:370-443` (replace `/refresh` body with a delegate)
- Test: `server/src/routes/ollama-health.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `server/src/routes/ollama-health.test.ts`. **The harness has no top-level `app`** — it exposes `function makeApp()` (mounted at `/api/ollama`) that each test calls. Use the real default `pullBootstrap` (not mocked), so `listAllowed()` returns `DEFAULT_ALLOWED_MODELS` incl. the e4b tag from Task 1. (The daemon `fetch` may be unmocked → `status: 'unreachable'`, but `pullable` is still attached, so these assertions hold regardless.)

```ts
it('GET /health includes the pullable install list', async () => {
  const app = makeApp();
  const res = await request(app).get('/api/ollama/health');
  expect(res.body.pullable).toEqual(
    expect.arrayContaining(['gemma-4-E4B-it-GGUF:UD-Q4_K_XL']),
  );
});

it('POST /refresh returns the same envelope shape including pullable', async () => {
  const app = makeApp();
  const res = await request(app).post('/api/ollama/refresh');
  expect(res.body).toHaveProperty('status');
  expect(res.body.pullable).toEqual(
    expect.arrayContaining(['gemma-4-E4B-it-GGUF:UD-Q4_K_XL']),
  );
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npm run test -- src/routes/ollama-health.test.ts`
Expected: FAIL — `pullable` undefined; `/refresh` body lacks it.

- [ ] **Step 3: Add `pullable` to the result type + probe, and delegate `/refresh`**

In `OllamaHealthResult` (line 96), add:

```ts
  /** The curated install list (= pull suggestions + pull allowlist). Static
      per release; surfaced here so the frontend stops mirroring it. */
  pullable?: string[];
```

In `probeOllamaHealth()`, compute it once and add to BOTH the reachable and unreachable returns:

```ts
  const pullable = pullBootstrap.listAllowed();
  // ...in the unreachable early-return and the catch return: add `pullable,`
  // ...in the reachable return: add `pullable,`
```

(Add `pullable,` to every `return { status: …, url, … }` object in the function.)

Replace the entire `/refresh` handler body (lines 370-443) with a delegate:

```ts
ollamaHealthRouter.post('/refresh', async (_req: Request, res: Response) => {
  res.json(await probeOllamaHealth());
});
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && npm run test -- src/routes/ollama-health.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/routes/ollama-health.ts server/src/routes/ollama-health.test.ts
git commit -m "feat(server): expose pullable install list on /health; /refresh delegates to probe"
```

---

## Task 8: Frontend model helpers (engine classifier, label, union, groups)

**Files:**
- Modify: `src/lib/models.ts` (keep `MODEL_OPTIONS`; add helpers; replace `MODEL_OPTION_GROUPS` const with a function)
- Test: `src/lib/models.test.ts` (create)

- [ ] **Step 1: Write the failing test**

Create `src/lib/models.test.ts`. **Do NOT add an `analyzerModelLabel` to `src/lib/models.ts`** — that name is already exported by `src/components/account-forms.tsx` with different `(id) → label, null → 'server default'` semantics; a second one collides. Label resolution for dynamic tags is unnecessary: every label site already falls back to the raw id (which IS the tag name) for unknown ids, so a pulled-but-uncurated tag displays its own tag string — acceptable.

```ts
import { describe, it, expect } from 'vitest';
import {
  engineForModelId,
  buildLocalModelOptions,
  buildModelOptionGroups,
  MODEL_OPTION_GROUPS,
  MODEL_OPTIONS,
} from './models';

describe('engineForModelId', () => {
  it('classifies a tag with a colon as local', () => {
    expect(engineForModelId('qwen3.5:4b')).toBe('local');
    expect(engineForModelId('gemma-4-E4B-it-GGUF:UD-Q4_K_XL')).toBe('local');
  });
  it('classifies a colonless id as gemini', () => {
    expect(engineForModelId('gemma-4-31b-it')).toBe('gemini');
  });
});

describe('buildLocalModelOptions', () => {
  const curated = MODEL_OPTIONS.filter((m) => m.engine === 'local');
  it('keeps the curated label/hint for a matching live tag', () => {
    const opts = buildLocalModelOptions([{ name: 'qwen3.5:4b' }], curated);
    const q = opts.find((o) => o.id === 'qwen3.5:4b');
    expect(q?.label).toBe('Qwen3.5 4B (local)');
  });
  it('appends an uncurated live tag as a bare option', () => {
    const opts = buildLocalModelOptions([{ name: 'gemma-4-E4B-it-GGUF:UD-Q4_K_XL' }], curated);
    const g = opts.find((o) => o.id === 'gemma-4-E4B-it-GGUF:UD-Q4_K_XL');
    expect(g).toEqual({
      id: 'gemma-4-E4B-it-GGUF:UD-Q4_K_XL',
      label: 'gemma-4-E4B-it-GGUF:UD-Q4_K_XL',
      engine: 'local',
    });
  });
  it('always includes curated entries even when not in the live list (offline)', () => {
    const opts = buildLocalModelOptions([], curated);
    expect(opts.some((o) => o.id === 'qwen3.5:4b')).toBe(true);
  });
  it('does not duplicate a curated tag that is also live', () => {
    const opts = buildLocalModelOptions([{ name: 'qwen3.5:4b' }], curated);
    expect(opts.filter((o) => o.id === 'qwen3.5:4b')).toHaveLength(1);
  });
});

describe('buildModelOptionGroups', () => {
  it('returns a gemini group FIRST + a local group from the supplied local options', () => {
    const groups = buildModelOptionGroups([
      { id: 'qwen3.5:4b', label: 'Qwen3.5 4B (local)', engine: 'local' },
    ]);
    expect(groups[0].engine).toBe('gemini'); // gemini-first ordering preserved (picker tests rely on it)
    expect(groups.find((g) => g.engine === 'gemini')?.models.length).toBeGreaterThan(0);
    expect(groups.find((g) => g.engine === 'local')?.models).toHaveLength(1);
  });
});

describe('MODEL_OPTION_GROUPS (back-compat const)', () => {
  it('still exports a static groups array built from the curated locals', () => {
    expect(MODEL_OPTION_GROUPS[0].engine).toBe('gemini');
    expect(MODEL_OPTION_GROUPS.find((g) => g.engine === 'local')?.models.length).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -- src/lib/models.test.ts`
Expected: FAIL — helpers undefined.

- [ ] **Step 3: Implement the helpers**

In `src/lib/models.ts`: keep `MODEL_OPTIONS` (including the local entries) unchanged. **Replace the `MODEL_OPTION_GROUPS` const (lines 96-111) with a function + a back-compat const** (six files import the const today — `model-settings-form.tsx`, `analysis-model-picker.tsx`, `routes/index.tsx`, `setup/step-defaults.tsx`, `phase-model-swap.tsx`, and `analysis-model-picker.test.tsx` — so keep the export alive). Add:

```ts
/** Engine classification from the id shape — Ollama tags contain ':',
    Gemini ids never do. Matches the server's inferEngineFromModelId
    (server/src/analyzer/index.ts). Use this everywhere instead of looking the
    id up in MODEL_OPTIONS, so a dynamically-pulled (uncurated) local tag is
    still correctly classified — critical for the GPU-contention guard. */
export function engineForModelId(id: string): 'local' | 'gemini' {
  return id.includes(':') ? 'local' : 'gemini';
}

const norm = (t: string) => (t.includes(':') ? t : `${t}:latest`);

/** Merge-on-top: curated local entries (always shown, even offline) unioned
    with live Ollama tags. A live tag matching a curated id keeps the curated
    label/hint; an uncurated live tag becomes a bare option. */
export function buildLocalModelOptions(
  liveTags: Array<{ name: string; size?: number }>,
  curated: ModelOption[] = MODEL_OPTIONS.filter((m) => m.engine === 'local'),
): ModelOption[] {
  const out: ModelOption[] = [...curated];
  const have = new Set(curated.map((m) => norm(m.id)));
  for (const tag of liveTags) {
    if (have.has(norm(tag.name))) continue;
    have.add(norm(tag.name));
    out.push({ id: tag.name, label: tag.name, engine: 'local' });
  }
  return out;
}

/** Grouped form for <optgroup> pickers. Gemini is the curated static catalog;
    the local group is whatever was merged from live tags. */
export function buildModelOptionGroups(localOptions: ModelOption[]): Array<{
  engine: 'local' | 'gemini';
  label: string;
  models: ModelOption[];
}> {
  return [
    {
      engine: 'gemini',
      label: 'Gemini API (default)',
      models: MODEL_OPTIONS.filter((m) => m.engine === 'gemini'),
    },
    { engine: 'local', label: 'Local Ollama (on-device)', models: localOptions },
  ];
}

/** Back-compat static export: groups built from the CURATED local entries only
    (no live tags). Existing importers that don't have store access keep working
    unchanged; the dynamic pickers (Task 11) call buildModelOptionGroups(live)
    instead. Keeping this export means deleting the old const is non-breaking. */
export const MODEL_OPTION_GROUPS = buildModelOptionGroups(
  MODEL_OPTIONS.filter((m) => m.engine === 'local'),
);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test -- src/lib/models.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/models.ts src/lib/models.test.ts
git commit -m "feat: dynamic local model helpers (engineForModelId, merge-on-top groups)"
```

---

## Task 9: Route engine-CLASSIFICATION sites through `engineForModelId`

`MODEL_OPTIONS.find(...).engine` must not be used to classify engine — it defaults an uncurated (pulled) local tag to `'gemini'`, which silently disables the GPU-contention guard (a safety bug). Fix only the **classification** sites. The **label** sites (`account-forms.tsx:16`, `phase-model-chip.tsx:61`, `phase-model-swap.tsx:70`, `analyzer-model-override-badge.tsx:19`) are intentionally LEFT ALONE — they already fall back to the raw id for unknown tags, so a dynamic tag renders its own tag string, which is the desired label. (`account-forms.tsx` also has its own `analyzerModelLabel` with `null → 'server default'` semantics — do not touch it.) `MODEL_OPTION_GROUPS` still exists (back-compat const from Task 8), so nothing here breaks the build.

**Files:**
- Modify: `src/hooks/use-local-analyzer-guard.tsx:40` (import) + `:78` (classifier)
- Modify: `src/views/analysing.tsx:294` (`.engine === 'local'`; `:291` `MODEL_OPTIONS[0].id` fallback stays valid — curated list intact)
- Modify: `src/views/generation.tsx:323`, `:492` (the two `.find().engine` sites; there is NO `MODEL_OPTIONS[0]` in generation.tsx — the second `[0]` fallback is `analysing.tsx:1216`, already covered)
- Test: `src/hooks/use-local-analyzer-guard.test.tsx`

- [ ] **Step 1: Write the failing test (guard fires for an uncurated local tag)**

Add to `src/hooks/use-local-analyzer-guard.test.tsx` (follow its existing render-hook + store setup):

```ts
it('opens the confirm dialog for an UNCURATED local tag while a stream is active', () => {
  // store seeded with ui.selectedModel = a pulled-but-not-curated tag + an active stream
  const { result } = renderGuardWith({
    selectedModel: 'gemma-4-E4B-it-GGUF:UD-Q4_K_XL',
    activeStream: true,
  });
  const proceed = vi.fn();
  act(() => result.current.guard(proceed));
  expect(proceed).not.toHaveBeenCalled(); // guarded, because ':' => local
});
```

> `renderGuardWith` is pseudocode — the real harness in `use-local-analyzer-guard.test.tsx` uses a `makeStore(...)` + `Harness` render helper (read the file, lines ~31/58). Seed `ui.selectedModel` with the uncurated tag and an active `chapters.activeStreams` entry. The key assertion: a colon-bearing tag NOT in `MODEL_OPTIONS` is treated as local and the dialog opens.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -- src/hooks/use-local-analyzer-guard.test.tsx`
Expected: FAIL — current code maps the uncurated tag to `'gemini'` and calls `proceed()`.

- [ ] **Step 3: Replace the classifier in the guard**

In `src/hooks/use-local-analyzer-guard.tsx`: change the import on line 40 and the engine derivation on line 78:

```ts
import { engineForModelId } from '../lib/models';
// ...
const engine = engineForModelId(selectedModel);
```

- [ ] **Step 4: Run the guard test**

Run: `npm run test -- src/hooks/use-local-analyzer-guard.test.tsx`
Expected: PASS.

- [ ] **Step 5: Fix the two remaining classification sites**

Use `engineForModelId` for classification (import it from `../lib/models` / `../../lib/models` as the path requires):

- `src/views/analysing.tsx:294`: replace `MODEL_OPTIONS.find((m) => m.id === id)?.engine === 'local'` with `engineForModelId(id) === 'local'`. The `MODEL_OPTIONS[0].id` fallbacks at `:291` and `:1216` stay valid (curated `MODEL_OPTIONS` unchanged; `[0]` is still `qwen3.5:4b`).
- `src/views/generation.tsx:323`, `:492`: replace `MODEL_OPTIONS.find((m) => m.id === selectedAnalyzerModelId)?.engine` with `engineForModelId(selectedAnalyzerModelId)`.

Do NOT touch the label sites (`account-forms.tsx`, `phase-model-chip.tsx`, `phase-model-swap.tsx:70`, `analyzer-model-override-badge.tsx`) — they fall back to raw id, which is correct for dynamic tags. The `phase-model-swap.tsx:99` `MODEL_OPTION_GROUPS.map(...)` is handled in Task 11 (dynamic wiring), not here.

- [ ] **Step 6: Run the touched test files + typecheck**

Run: `npm run test -- src/views/analysing.test.tsx src/views/generation.test.tsx && npm run typecheck`
Expected: PASS / no type errors. (`MODEL_OPTION_GROUPS` still exists as a back-compat const, so importers are unaffected.)

- [ ] **Step 7: Commit**

```bash
git add src/hooks/use-local-analyzer-guard.tsx src/hooks/use-local-analyzer-guard.test.tsx src/views/analysing.tsx src/views/generation.tsx
git commit -m "fix: classify analyzer engine by id shape, not list membership (GPU guard safety)"
```

---

## Task 10: `pullable` on the API type/mock + account state + fetch thunk

**Files:**
- Modify: `src/lib/api.ts:4685-4699` (`OllamaHealth` + `pullable`), `:5916-5927` (`mockGetOllamaHealth`)
- Modify: `src/store/account-slice.ts` (state fields + `fetchAnalyzerModels` thunk + reducers)
- Test: `src/store/account-slice.test.ts`

- [ ] **Step 1: Fix the api mock, then write the failing tests**

`src/store/account-slice.test.ts`'s `vi.mock('../lib/api')` stubs only `getUserSettings`/`putUserSettings` — `api.getOllamaHealth` is `undefined`, so `fetchAnalyzerModels` (which calls it) would reject and the test fails for the wrong reason. **First** add to that mock object:

```ts
getOllamaHealth: vi.fn().mockResolvedValue({
  status: 'reachable',
  url: '(mock)',
  models: ['qwen3.5:4b'],
  pullable: ['qwen3.5:4b', 'gemma-4-E4B-it-GGUF:UD-Q4_K_XL'],
}),
```

Then add both branches (reachable + unreachable — the unreachable case is the only test that exercises the thunk's `status === 'reachable'` guard → empty local group, pullable still populated):

```ts
import { fetchAnalyzerModels } from './account-slice';

it('fetchAnalyzerModels populates localAnalyzerModels + pullableModels', async () => {
  const store = makeStore(); // existing helper in this test file
  await store.dispatch(fetchAnalyzerModels());
  const s = store.getState().account;
  expect(s.localAnalyzerModels.map((t) => t.name)).toEqual(expect.arrayContaining(['qwen3.5:4b']));
  expect(s.pullableModels).toEqual(expect.arrayContaining(['gemma-4-E4B-it-GGUF:UD-Q4_K_XL']));
});

it('leaves the local group empty when Ollama is unreachable (pullable still set)', async () => {
  (api.getOllamaHealth as vi.Mock).mockResolvedValueOnce({
    status: 'unreachable', url: '', pullable: ['qwen3.5:4b'],
  });
  const store = makeStore();
  await store.dispatch(fetchAnalyzerModels());
  expect(store.getState().account.localAnalyzerModels).toEqual([]);
  expect(store.getState().account.pullableModels).toEqual(['qwen3.5:4b']);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -- src/store/account-slice.test.ts`
Expected: FAIL — `fetchAnalyzerModels` / fields undefined.

- [ ] **Step 3: Add `pullable` to the API type + mock**

In `src/lib/api.ts`, add to the `OllamaHealth` interface (after `modelResident?`):

```ts
  /** Curated install list (pull suggestions + allowlist). From the server's
      single source; the frontend no longer hardcodes a mirror. */
  pullable?: string[];
```

Update `mockGetOllamaHealth` (line 5916) to include `pullable`:

```ts
  return {
    status: 'reachable',
    url: '(mock)',
    models: ['qwen3.5:4b', 'llama3.1:8b'],
    expectedModel: 'qwen3.5:4b',
    modelPulled: true,
    resident: Array.from(MOCK_OLLAMA_RESIDENT),
    modelResident: MOCK_OLLAMA_RESIDENT.has('qwen3.5:4b'),
    pullable: ['qwen3.5:4b', 'qwen3.5:9b', 'llama3.1:8b', 'llama3.2:3b', 'gemma3:4b', 'gemma-4-E4B-it-GGUF:UD-Q4_K_XL'],
  };
```

- [ ] **Step 4: Add the thunk + slice fields**

In `src/store/account-slice.ts` (read the file first). **`createAsyncThunk` and `api` are ALREADY imported (lines ~9 and ~12) — do NOT re-import them (duplicate import / redeclare error).** Add only: the `LocalAnalyzerTag` interface, the two state fields on the `AccountState` interface + `initialState`, the thunk, and the `extraReducers` case.

```ts
export interface LocalAnalyzerTag { name: string; size?: number }

// add to the slice's state interface + initialState:
//   localAnalyzerModels: LocalAnalyzerTag[];   // initial: []
//   pullableModels: string[];                  // initial: []

export const fetchAnalyzerModels = createAsyncThunk('account/fetchAnalyzerModels', async () => {
  const health = await api.getOllamaHealth();
  const localTags: LocalAnalyzerTag[] =
    health.status === 'reachable' && Array.isArray(health.models)
      ? health.models.map((name) => ({ name }))
      : [];
  return { localTags, pullable: Array.isArray(health.pullable) ? health.pullable : [] };
});

// in extraReducers:
//   builder.addCase(fetchAnalyzerModels.fulfilled, (state, action) => {
//     state.localAnalyzerModels = action.payload.localTags;
//     state.pullableModels = action.payload.pullable;
//   });
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npm run test -- src/store/account-slice.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/lib/api.ts src/store/account-slice.ts src/store/account-slice.test.ts
git commit -m "feat: fetchAnalyzerModels thunk + pullable on OllamaHealth/mock"
```

---

## Task 11: Wire pickers + Model Manager to the dynamic list; delete `PULLABLE_MODELS`

**Files:**
- Modify: `src/components/model-settings-form.tsx:86-92` (delete `PULLABLE_MODELS`), `:614-635` (`ModelsCardBody` uses the thunk + `account.pullableModels`), `:265/344/366` (`buildModelOptionGroups(localOptions)`)
- Modify (dynamic wiring, store-connected): `src/routes/index.tsx:1037` (re-parse modal), `src/components/setup/step-defaults.tsx:154` (wizard), `src/components/analysing/phase-model-swap.tsx:99`
- Modify (presentational): `src/components/analysis-model-picker.tsx` (upload picker — prop-only; add optional `groups` prop defaulting to `MODEL_OPTION_GROUPS`) + its caller `src/views/upload.tsx` (pass dynamic groups)
- Test: `src/views/model-manager.test.tsx` (real harness `renderManager`, line ~112), `src/components/analysis-model-picker.test.tsx`
- E2E: `e2e/model-manager-models.spec.ts`

> **Build safety:** `MODEL_OPTION_GROUPS` still exists (Task 8 back-compat const), so none of these importers break if not yet rewired. The dynamic upgrade is therefore incremental — do the store-connected ones first; the presentational picker needs a prop/caller change.

- [ ] **Step 1: Fix the test mock, then write the failing test**

The Model Manager harness is `src/views/model-manager.test.tsx` with helper `renderManager` (~line 112). Its `vi.mock('../lib/api')` object (lines ~17-30) does NOT include `getOllamaHealth` — once `ModelsCardBody` calls `api.getOllamaHealth()`, every test that renders the manager throws `api.getOllamaHealth is not a function`. **First** add to that mock object:

```ts
getOllamaHealth: vi.fn().mockResolvedValue({
  status: 'reachable',
  url: '(mock)',
  models: ['qwen3.5:4b'],
  pullable: ['qwen3.5:4b', 'gemma-4-E4B-it-GGUF:UD-Q4_K_XL'],
}),
```

Then add the failing test:

```ts
it('renders pull rows from fetched pullableModels (incl. the gemma-4 E4B tag)', async () => {
  renderManager(); // real harness in this file
  expect(await screen.findByText(/gemma-4-E4B-it-GGUF:UD-Q4_K_XL/)).toBeInTheDocument();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -- src/views/model-manager.test.tsx`
Expected: FAIL on the new test (static `PULLABLE_MODELS` lacks the e4b tag) — and confirm the mock addition keeps the OTHER ~30 tests green.

- [ ] **Step 3: Delete `PULLABLE_MODELS` and rewire `ModelsCardBody` (single fetch)**

In `src/components/model-settings-form.tsx`: delete the `PULLABLE_MODELS` const (lines 86-92). Rewrite `ModelsCardBody` to use the store thunk and a SINGLE `api.getOllamaHealth()` call (no raw `fetch`, no double-probe). Reuse the thunk's result for the health prop by reading it back, OR call `api.getOllamaHealth()` once locally and dispatch a lightweight action — simplest is one local call that feeds both `health` and a `setAnalyzerModelsFromHealth` dispatch:

```ts
function ModelsCardBody() {
  const dispatch = useAppDispatch();
  const pullableModels = useAppSelector((s) => s.account.pullableModels);
  const [health, setHealth] = useState<import('./model-pull-status').OllamaHealthEnvelope | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const h = await api.getOllamaHealth(); // mockable layer — NOT raw fetch
      if (cancelled) return;
      setHealth(h as unknown as import('./model-pull-status').OllamaHealthEnvelope);
      dispatch(fetchAnalyzerModels.fulfilled(
        { localTags: (h.models ?? []).map((name) => ({ name })), pullable: h.pullable ?? [] },
        '', undefined,
      ));
    })();
    return () => { cancelled = true; };
  }, [dispatch]);
  // ...render unchanged: <ModelPullStatus health={health} pullableModels={pullableModels} />
}
```

(`api.ts OllamaHealth` is a superset of `model-pull-status.tsx OllamaHealthEnvelope`; the `as unknown as` cast is safe. `pullable` reaches `ModelPullStatus` via the separate `pullableModels` prop, so `OllamaHealthEnvelope` does NOT need a `pullable` field. The `.fulfilled` manual-dispatch avoids a second network round-trip; if that feels hacky, just `void dispatch(fetchAnalyzerModels())` and accept one extra cheap mockable call.)

- [ ] **Step 4: Wire the model-group pickers (incremental, store-connected first)**

For each store-connected `MODEL_OPTION_GROUPS.map(...)` site, compute `const localOptions = buildLocalModelOptions(useAppSelector((s) => s.account.localAnalyzerModels));`, use `buildModelOptionGroups(localOptions).map(...)`, and `dispatch(fetchAnalyzerModels())` once on mount:
- `model-settings-form.tsx:265/344/366`
- `src/routes/index.tsx:1037` (re-parse modal)
- `src/components/setup/step-defaults.tsx:154` (wizard)
- `src/components/analysing/phase-model-swap.tsx:99`

For the **presentational** upload picker `src/components/analysis-model-picker.tsx` (props-only, no store): add an optional prop `groups: typeof MODEL_OPTION_GROUPS = MODEL_OPTION_GROUPS` and map over `groups` instead of the imported const; then in its caller `src/views/upload.tsx`, dispatch `fetchAnalyzerModels()` on mount and pass `groups={buildModelOptionGroups(buildLocalModelOptions(localAnalyzerModels))}`. Update `analysis-model-picker.test.tsx` to pass `groups` explicitly (its existing `MODEL_OPTION_GROUPS[0]`/`[1]` assertions still hold against the back-compat const).

**Post-pull refresh (runtime-review finding).** "Dispatch on mount" leaves a stale window: pulling a model in the Model Manager does NOT make it appear in an already-mounted picker (e.g. the analyzer dropdown on the same screen). Wire a re-dispatch of `fetchAnalyzerModels()` into the pull-success path — in `ModelPullStatus` (or its parent `ModelsCardBody`), when a `PullJob` reaches `status: 'pulled'`, `dispatch(fetchAnalyzerModels())` so the just-pulled tag becomes selectable without a remount.

**Rendered-picker union test (test-quality finding).** Add an RTL test (in the picker's or model-manager's test) that seeds `account.localAnalyzerModels` with an UNCURATED tag and asserts it renders inside the **Local `<optgroup>`** of the analyzer dropdown — not just the pull-status list. This is the only test that catches a picker which silently kept the static `MODEL_OPTION_GROUPS` const instead of the dynamic `buildModelOptionGroups(localOptions)`.

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm run test -- src/views/model-manager.test.tsx src/components/analysis-model-picker.test.tsx src/routes/index.test.tsx && npm run typecheck`
Expected: PASS.

- [ ] **Step 6: Update the e2e spec**

`e2e/model-manager-models.spec.ts` runs in `VITE_USE_MOCKS` mode, so the pull list comes from `mockGetOllamaHealth` (Task 10 added `pullable` with the e4b tag) — NOT from any `page.route` interception. If the spec also stubs `/api/ollama/health` / `/refresh` via `page.route`, add `pullable: [...]` to those stub bodies so both paths agree. Add an assertion that `gemma-4-E4B-it-GGUF:UD-Q4_K_XL` is offered in the pull list.

Run: `npm run test:e2e -- model-manager-models`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/components/model-settings-form.tsx src/components/analysis-model-picker.tsx src/components/analysis-model-picker.test.tsx src/components/setup/step-defaults.tsx src/components/analysing/phase-model-swap.tsx src/routes/index.tsx src/views/upload.tsx src/views/model-manager.test.tsx e2e/model-manager-models.spec.ts
git commit -m "feat: pickers + Model Manager render the dynamic local list; drop PULLABLE_MODELS"
```

---

## Task 12: Docs + backlog

**Files:**
- Modify: `docs/local-llm.md`
- Create: `docs/features/<NNN>-dynamic-analyzer-models.md` (next free number; check `docs/features/INDEX.md`)
- Modify: `docs/features/INDEX.md`
- Modify: `docs/BACKLOG.md` (+ file GitHub issues)

- [ ] **Step 1: Rewrite the residency sections of `docs/local-llm.md`**

Replace the "Why qwen3.5:4b is the default" / "Moving up to an 8B / candidates" / `RESIDENT_MODELS` references with: the picker reflects pulled tags (curated ∪ live); residency is the `ANALYZER_KEEP_ALIVE` knob (default `'1m'`) plus adaptive measured eviction; document the `/api/ps.size_vram` sampler (100%-GPU guard), the boot `nvidia-smi` device-total probe, the hardcoded Kokoro fallback reserve, and the num_ctx best-effort key. **Also note:** the in-app Load button's warmer (`ollama-health.ts:267`) still pins `keep_alive: '5m'` literally and does NOT honor `ANALYZER_KEEP_ALIVE` — manual warming is a deliberate "hold it" action, distinct from the per-call analysis keep-alive. Note the deferred measured-semaphore-weights experiment.

**Document the cold-start behavior honestly (runtime-review finding):** adaptive eviction is inactive until a model has been sampled at least once at the current `num_ctx` AND the boot device-total probe has resolved — so on a fresh box the first analysis call(s) run on the flat `'1m'` knob. It self-heals *within the same run* (the post-call sampler populates the EMA after the first chapter), so by the second chapter adaptive engages. Also note: `model-vram-stats.jsonl` is lossy under concurrent samples (the read-trim-rewrite past the cap can drop a racing append) — tolerated because the in-memory `emaCache` is authoritative within a process lifetime; the file only re-primes that cache at boot, so at worst a reboot loses a little history. And: changing `ANALYZER_NUM_CTX` between warming and analyzing can record a `size_vram` under a key whose ctx differs from the loaded ctx (best-effort; re-learns).

- [ ] **Step 2: Create the regression plan**

Create `docs/features/<NNN>-dynamic-analyzer-models.md` from `docs/features/TEMPLATE.md` with `status: active`, documenting the invariants (dynamic local list, classifier-by-shape safety, keep-alive knob + adaptive eviction, single canonical install list) and a manual acceptance walkthrough:
- Pull `gemma-4-E4B-it-GGUF:UD-Q4_K_XL` → it appears in the analyzer picker (and in an already-open picker after the pull completes — verifies the post-pull refresh).
- Stop Ollama → curated local options still render (no blank picker); the health pill shows unreachable.
- **Verify the e4b tag is actually sampled:** run an analysis with it, then confirm a record with its exact canonical key (`gemma-4-E4B-it-GGUF:UD-Q4_K_XL@<numCtx>`) lands in `.telemetry/model-vram-stats.jsonl` — i.e. `/api/ps`'s `.name` for this GGUF tag round-trips through `norm()` and matches (the one real-box assumption the unit tests can't cover).
- Large model (measured > headroom − fallback) → `keep_alive: 0` (evicts); e4b (~6.5 GB) → stays for `'1m'`.
- **Gemini-fallback caveat:** with `ANALYZER=local` + Ollama down + a Gemini key set, the picker still shows curated local options but analysis silently runs on the Gemini fallback (pre-existing `selectAnalyzer` behavior; this feature doesn't change it). Document it; file a backlog row if a "running on fallback" indicator is wanted.

Add its entry to `docs/features/INDEX.md`.

- [ ] **Step 3: File backlog issues + rows**

File two GitHub Backlog-item issues (per CONTRIBUTING.md): one closed-by-this-PR for the feature, and one OPEN for the **deferred measured-GPU-semaphore-weights experiment** (capturing the adversarial-review constraints: derive budget+weights from one unit atomically, never lower the Kokoro floor, sidecar-side per-engine probe). Add the deferred row to `docs/BACKLOG.md`.

- [ ] **Step 4: Commit**

```bash
git add docs/
git commit -m "docs: dynamic analyzer models — local-llm rewrite, regression plan, backlog"
```

---

## Final verification

- [ ] **Run the full battery**

Run: `npm run verify`
Expected: typecheck + all tests + e2e + build green. Fix any failures per the triage rules in CLAUDE.md (related → fix; pre-existing → surface, don't bundle).

- [ ] **Confirm the PR body** links the spec + regression plan, includes `Closes #<feature-issue>` and `Refs #<deferred-issue>`, and fills the `## Summary` / `## Test plan` sections.

---

## Self-review notes (author)

- **Spec coverage:** dynamic list (Tasks 8–11), engine-classifier safety fix (Task 9), `'1m'` knob + delete `RESIDENT_MODELS` (Tasks 2, 6), measured adaptive eviction with all four review fixes — sampling site (Task 5/6), 100%-GPU guard (Task 5), boot device-total not sidecar (Task 3), append-only JSONL + canonical keys (Task 4) — single canonical install list + `pullable` (Tasks 1, 7), target tag (Task 1), docs + deferred-experiment issue (Task 12). Measured semaphore weights intentionally absent (deferred).
- **Corrections applied after the plan's adversarial review (do not regress these):**
  - Task 6 test uses the REAL async config-override API (`writeConfigOverride`/`clearAllConfigOverrides` from `../workspace/user-settings.js`), not the nonexistent `../config/store.js`. Task 6 also updates the pre-existing happy-path assertion `ollama.test.ts:155` (`0` → `'1m'`).
  - Task 7 tests call `makeApp()` per test (no top-level `app`).
  - Task 8 KEEPS `MODEL_OPTION_GROUPS` as a back-compat const (six importers) and does NOT add an `analyzerModelLabel` (name collision with `account-forms.tsx`).
  - Task 9 fixes ONLY the engine-classification sites (guard + analysing + generation×2); label sites are left (they fall back to raw id). The phantom `generation.tsx:1216` reference is removed (both `MODEL_OPTIONS[0]` fallbacks are in `analysing.tsx`).
  - Task 11 targets the real `model-manager.test.tsx`/`renderManager`, ADDS `getOllamaHealth` to that test's api mock (or ~30 tests break), enumerates the three previously-missed importers (`analysis-model-picker.tsx` + caller, `routes/index.tsx`, `setup/step-defaults.tsx`), and uses a single mockable `getOllamaHealth` call.
- **Corrections from the SECOND adversarial round (test-quality / sequencing / runtime angles):**
  - **Runtime (correctness):** the VRAM sampler is `await`ed INSIDE the GPU lock (before `return buf`), not fire-and-forget after release — otherwise a back-to-back model swap mis-attributes `size_vram` and teaches a corrupt EMA (Task 6 Step 5). The `/api/ps` fetch is timeout-bounded (Task 5) so it can't pin the lock.
  - **Test-quality:** Task 10 adds `getOllamaHealth` to the api mock (else the thunk test throws) + an unreachable-branch case; Task 6 keeps ≥1 wire-level `keep_alive`-in-body test + a sampler-wiring test; Task 11 adds a rendered-picker `<optgroup>` union test (the helper unit tests don't prove the picker was rewired).
  - **Sequencing:** typecheck after each TS task (pre-commit doesn't); Task 10 must NOT re-import `createAsyncThunk`/`api` (already imported → redeclare error).
  - **Runtime (documented, not blocking):** adaptive eviction is inactive on the first call(s) of a fresh box and self-heals within the run; the JSONL store is lossy under concurrency (cache is authoritative); post-pull refresh wired so a just-pulled tag is selectable without remount (Task 11); Gemini-fallback-with-curated-shown caveat documented (Task 12).
- **Remaining executor adaptation points:** the account-slice additions in Task 10 must match the slice's real structure (it already uses `createAsyncThunk`/`extraReducers`; add the two fields to `AccountState` directly); the invented test helpers (`renderGuardWith`, `lastChatRequestBody`, the manual `.fulfilled` dispatch) are pseudocode — reuse each test file's real harness; confirm the `e2e/model-manager-models.spec.ts` health source (mock vs `page.route`) before asserting.
