# Wave 1 — GPU eviction before sidecar loads + safe keep_alive flip — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the already-done `qwen3.5:9b` `keep_alive: '5m'` flip safe by evicting a resident Ollama model server-side before any sidecar TTS/voice-design load, gated by a single VRAM threshold.

**Architecture:** A pure `residency` policy decides "evict before load?" from a cached VRAM state (last-known-good from sidecar `/health`, resilient to respawn). A shared `unloadResidentOllama()` (extracted from the `/unload` route) performs the eviction under a dedicated load-mutex, scoped to the configured analyzer model so concurrent sessions aren't stomped. Two server-side chokepoints call it: `ensureSidecarEngineReady` (generation/bulk) and `designQwenVoiceForCharacter` (voice design). An `isAnyAnalysisBusy()` interlock guarantees an in-flight analysis is never evicted.

**Tech Stack:** TypeScript (Node ESM), Vitest (node env), Express routes, the existing config registry (`configValue`).

**Spec:** `docs/superpowers/specs/2026-06-16-vram-budget-aware-gpu-policy-design.md` (§4).

**Branch:** `git switch feat/analysing-residency-label-progress` then rename: `git branch -m fix/server-gpu-eviction-before-sidecar-load`. The keep_alive flip + its ollama tests already live here (uncommitted) and ship with this wave.

---

### Task 1: Register the `gpu.safeCoexistMb` config knob

**Files:**
- Modify: `server/src/config/registry.ts` (the `gpu-lifecycle` group)

- [ ] **Step 1: Add the knob to the registry**

Find the `gpu-lifecycle` group entries (search `gpu.vramBudget` / `gpu.concurrency`) and add an entry alongside them:

```ts
{
  id: 'gpu.safeCoexistMb',
  group: 'gpu-lifecycle',
  type: 'number',
  default: 11000,
  label: 'Safe analyzer+TTS coexistence VRAM (MB)',
  help: 'If detected GPU VRAM is below this, evict the resident Ollama analyzer before loading a sidecar TTS/voice-design model. 8 GB cards evict; 12/16 GB coexist. Set 0 to always evict.',
  apply: 'live',
},
```

- [ ] **Step 2: Verify it resolves**

Run: `cd server && npx vitest run src/config -t "registry"`
Expected: PASS (existing registry-shape tests still green with the new entry).

- [ ] **Step 3: Commit**

```bash
git add server/src/config/registry.ts
git commit -m "feat(server): add gpu.safeCoexistMb eviction-threshold knob"
```

---

### Task 2: VRAM-state cache on sidecar health (resilient to respawn)

**Files:**
- Modify: `server/src/routes/sidecar-health.ts` (near `setLastKnownQwenInstallState`, ~line 244)
- Test: `server/src/routes/sidecar-health.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { setLastKnownVram, getLastKnownVram } from './sidecar-health.js';

describe('last-known VRAM cache', () => {
  beforeEach(() => setLastKnownVram(null)); // reset to "never probed"

  it('defaults to unknown accelerator / null total before any probe', () => {
    expect(getLastKnownVram()).toEqual({ accelerator: 'unknown', totalMb: null });
  });

  it('records a CUDA total and exposes accelerator cuda', () => {
    setLastKnownVram({ totalMb: 8188 });
    expect(getLastKnownVram()).toEqual({ accelerator: 'cuda', totalMb: 8188 });
  });

  it('records a reachable-but-no-CUDA probe as cpu', () => {
    setLastKnownVram({ totalMb: null });
    expect(getLastKnownVram()).toEqual({ accelerator: 'cpu', totalMb: null });
  });

  it('an unreachable poll (undefined) leaves the last-known state intact', () => {
    setLastKnownVram({ totalMb: 8188 });
    setLastKnownVram(undefined); // unreachable — do not downgrade
    expect(getLastKnownVram()).toEqual({ accelerator: 'cuda', totalMb: 8188 });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx vitest run src/routes/sidecar-health.test.ts -t "last-known VRAM"`
Expected: FAIL — `setLastKnownVram`/`getLastKnownVram` are not exported.

- [ ] **Step 3: Implement the cache**

Add near `setLastKnownQwenInstallState` in `sidecar-health.ts`:

```ts
export type Accelerator = 'cuda' | 'cpu' | 'unknown';
export interface VramState {
  accelerator: Accelerator;
  totalMb: number | null;
}

/* Last-known VRAM, mirroring the Qwen-install-state cache: only a REACHABLE
   probe updates it, so a transient sidecar respawn (when eviction must still
   make a decision) doesn't downgrade a known-good reading. `null` = reset to
   "never probed"; `undefined` = unreachable poll (no-op). CUDA presence is
   inferred from a non-null vram_total_mb (the sidecar reports it iff CUDA). */
let lastKnownVram: VramState = { accelerator: 'unknown', totalMb: null };

export function setLastKnownVram(
  next: { totalMb: number | null } | null | undefined,
): void {
  if (next === undefined) return; // unreachable — keep last-known
  if (next === null) {
    lastKnownVram = { accelerator: 'unknown', totalMb: null };
    return;
  }
  lastKnownVram = {
    totalMb: next.totalMb,
    accelerator: next.totalMb != null ? 'cuda' : 'cpu',
  };
}

export function getLastKnownVram(): VramState {
  return lastKnownVram;
}
```

- [ ] **Step 4: Populate it on a reachable probe**

In `probeSidecarHealth`, immediately after `setLastKnownQwenInstallState(qwenInstallState);` (line ~244):

```ts
setLastKnownVram({
  totalMb: typeof body.vram_total_mb === 'number' ? body.vram_total_mb : null,
});
```

- [ ] **Step 5: Run tests to verify pass**

Run: `cd server && npx vitest run src/routes/sidecar-health.test.ts`
Expected: PASS (new cache tests + existing health tests).

- [ ] **Step 6: Commit**

```bash
git add server/src/routes/sidecar-health.ts server/src/routes/sidecar-health.test.ts
git commit -m "feat(server): cache last-known GPU VRAM state from sidecar health"
```

---

### Task 3: Pure residency policy — `shouldEvictBeforeSidecarLoad`

**Files:**
- Create: `server/src/gpu/residency.ts`
- Test: `server/src/gpu/residency.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../config/resolver.js', () => ({
  configValue: vi.fn(() => 11000), // gpu.safeCoexistMb default
}));

import { shouldEvictBeforeSidecarLoad } from './residency.js';

describe('shouldEvictBeforeSidecarLoad', () => {
  it('CPU never evicts (no VRAM contention)', () => {
    expect(shouldEvictBeforeSidecarLoad({ accelerator: 'cpu', totalMb: null })).toBe(false);
  });

  it('GPU with unknown total is conservative — evict', () => {
    expect(shouldEvictBeforeSidecarLoad({ accelerator: 'cuda', totalMb: null })).toBe(true);
  });

  it('accelerator unknown (never probed) is conservative — evict', () => {
    expect(shouldEvictBeforeSidecarLoad({ accelerator: 'unknown', totalMb: null })).toBe(true);
  });

  it('8 GB card (below threshold) evicts', () => {
    expect(shouldEvictBeforeSidecarLoad({ accelerator: 'cuda', totalMb: 8188 })).toBe(true);
  });

  it('12 GB and 16 GB cards coexist (no evict)', () => {
    expect(shouldEvictBeforeSidecarLoad({ accelerator: 'cuda', totalMb: 12288 })).toBe(false);
    expect(shouldEvictBeforeSidecarLoad({ accelerator: 'cuda', totalMb: 16384 })).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx vitest run src/gpu/residency.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// server/src/gpu/residency.ts
import { configValue } from '../config/resolver.js';
import type { VramState } from '../routes/sidecar-health.js';

/** Should a resident Ollama analyzer be evicted before loading a sidecar
    TTS/voice-design model, given the detected VRAM?
    - CPU: never (models share system RAM; no GPU to overflow).
    - GPU, total unknown / never probed: yes (conservative — better a reload
      than an OOM).
    - GPU with a known total below `gpu.safeCoexistMb`: yes (8 GB can't host
      analyzer + TTS together). At/above it: no (12/16 GB coexist). */
export function shouldEvictBeforeSidecarLoad(v: VramState): boolean {
  if (v.accelerator === 'cpu') return false;
  if (v.totalMb == null) return true;
  return v.totalMb < configValue<number>('gpu.safeCoexistMb');
}
```

- [ ] **Step 4: Run test to verify pass**

Run: `cd server && npx vitest run src/gpu/residency.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/gpu/residency.ts server/src/gpu/residency.test.ts
git commit -m "feat(server): VRAM-threshold residency policy (shouldEvictBeforeSidecarLoad)"
```

---

### Task 4: Extract `unloadResidentOllama` and reuse it in the route

**Files:**
- Modify: `server/src/routes/ollama-health.ts` (the `POST /unload` handler, ~lines 282-301)
- Test: `server/src/routes/ollama-health.test.ts` (existing `/unload` describe block, ~line 225)

- [ ] **Step 1: Write the failing test**

Add to the existing `/unload` describe in `ollama-health.test.ts`:

```ts
it('exposes unloadResidentOllama() that evicts the named targets with keep_alive: 0', async () => {
  const fetchMock = vi.fn().mockResolvedValue(okResponse('{}')); // reuse the file's helpers
  vi.stubGlobal('fetch', fetchMock);
  const { unloadResidentOllama } = await import('./ollama-health.js');
  await unloadResidentOllama(['qwen3.5:9b']);
  const body = JSON.parse(fetchMock.mock.calls[0][1].body);
  expect(body.model).toBe('qwen3.5:9b');
  expect(body.keep_alive).toBe(0);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx vitest run src/routes/ollama-health.test.ts -t "unloadResidentOllama"`
Expected: FAIL — `unloadResidentOllama` not exported.

- [ ] **Step 3: Extract the helper**

In `ollama-health.ts`, add an exported function and have the route call it:

```ts
/** Evict resident Ollama model(s) by issuing keep_alive:0 generate calls.
    `targets` empty/omitted → evict EVERY model /api/ps reports (the explicit
    Stop path). Returns the list actually evicted. Throws on the first failed
    eviction so callers can surface it. */
export async function unloadResidentOllama(targets?: string[]): Promise<string[]> {
  const url = getResolvedOllamaUrl();
  const list =
    targets && targets.length > 0 ? targets : (await probeOllamaHealth()).resident ?? [];
  for (const model of list) {
    const result = await callOllamaGenerate(
      url,
      { model, prompt: '', keep_alive: 0, stream: false },
      PROBE_TIMEOUT_MS,
    );
    if (!result.ok) throw new Error(result.error ?? `unload ${model} failed`);
  }
  return list;
}
```

Replace the body of the `POST /unload` handler to delegate:

```ts
ollamaHealthRouter.post('/unload', async (req: Request, res: Response) => {
  const requested = typeof req.body?.model === 'string' ? req.body.model.trim() : '';
  try {
    const unloaded = await unloadResidentOllama(requested ? [requested] : undefined);
    return res.json({ status: 'unloaded', unloaded });
  } catch (e) {
    return res.status(502).json({ status: 'error', error: (e as Error).message });
  }
});
```

- [ ] **Step 4: Run tests to verify pass**

Run: `cd server && npx vitest run src/routes/ollama-health.test.ts`
Expected: PASS (new test + the existing single/all/error eviction tests).

- [ ] **Step 5: Commit**

```bash
git add server/src/routes/ollama-health.ts server/src/routes/ollama-health.test.ts
git commit -m "refactor(server): extract unloadResidentOllama() shared eviction helper"
```

---

### Task 5: Load-mutex + the `evictOllamaForGpuLoad` orchestrator

**Files:**
- Create: `server/src/gpu/load-mutex.ts`
- Create: `server/src/gpu/evict-for-load.ts`
- Test: `server/src/gpu/evict-for-load.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

const unloadMock = vi.fn().mockResolvedValue(['qwen3.5:9b']);
const vramMock = vi.fn();
const busyMock = vi.fn().mockReturnValue(false);

vi.mock('../routes/ollama-health.js', () => ({ unloadResidentOllama: unloadMock }));
vi.mock('../routes/sidecar-health.js', () => ({ getLastKnownVram: vramMock }));
vi.mock('../tts/design-lock.js', () => ({ isAnyAnalysisBusy: busyMock }));
vi.mock('../workspace/user-settings.js', () => ({
  getResolvedOllamaModel: () => 'qwen3.5:9b',
}));
vi.mock('./residency.js', () => ({
  shouldEvictBeforeSidecarLoad: (v: { totalMb: number | null }) =>
    v.totalMb != null && v.totalMb < 11000,
}));

import { evictOllamaForGpuLoad } from './evict-for-load.js';

describe('evictOllamaForGpuLoad', () => {
  beforeEach(() => {
    unloadMock.mockClear();
    busyMock.mockReturnValue(false);
  });

  it('evicts the configured analyzer model on an 8 GB card', async () => {
    vramMock.mockReturnValue({ accelerator: 'cuda', totalMb: 8188 });
    await evictOllamaForGpuLoad();
    expect(unloadMock).toHaveBeenCalledWith(['qwen3.5:9b']);
  });

  it('does NOT evict on a 12 GB card (coexist)', async () => {
    vramMock.mockReturnValue({ accelerator: 'cuda', totalMb: 12288 });
    await evictOllamaForGpuLoad();
    expect(unloadMock).not.toHaveBeenCalled();
  });

  it('does NOT evict while an analysis is in flight (interlock)', async () => {
    vramMock.mockReturnValue({ accelerator: 'cuda', totalMb: 8188 });
    busyMock.mockReturnValue(true);
    await evictOllamaForGpuLoad();
    expect(unloadMock).not.toHaveBeenCalled();
  });

  it('never throws if eviction fails (best-effort — a load must still proceed)', async () => {
    vramMock.mockReturnValue({ accelerator: 'cuda', totalMb: 8188 });
    unloadMock.mockRejectedValueOnce(new Error('ollama down'));
    await expect(evictOllamaForGpuLoad()).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx vitest run src/gpu/evict-for-load.test.ts`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement the load-mutex**

```ts
// server/src/gpu/load-mutex.ts
/* Serialises evict-then-load sequences. The GpuSemaphore arbitrates EXECUTION
   (token budget around /chat and /synthesize); it neither knows about nor
   serialises model LOADS. Two concurrent generation/design starts could each
   read "fits", then both load and overcommit. This mutex makes the
   evict→load decision atomic. Distinct from, and orthogonal to, the token
   semaphore. */
let tail: Promise<unknown> = Promise.resolve();

export function withGpuLoadLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = tail.then(fn, fn);
  // Keep the chain alive regardless of fn's outcome; swallow to avoid unhandled.
  tail = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}
```

- [ ] **Step 4: Implement the orchestrator**

```ts
// server/src/gpu/evict-for-load.ts
import { getLastKnownVram } from '../routes/sidecar-health.js';
import { unloadResidentOllama } from '../routes/ollama-health.js';
import { isAnyAnalysisBusy } from '../tts/design-lock.js';
import { getResolvedOllamaModel } from '../workspace/user-settings.js';
import { shouldEvictBeforeSidecarLoad } from './residency.js';
import { withGpuLoadLock } from './load-mutex.js';

/** Best-effort: before a server-initiated sidecar TTS/voice-design load, free a
    resident Ollama analyzer if the card can't host both. No-op on CPU / big
    cards / when an analysis is in flight (it must not be evicted; analysis and
    generation are sequential pipeline phases). Scoped to the configured
    analyzer model so a concurrent session's different model isn't stomped.
    Never throws — a failed eviction must not block the load it precedes. */
export async function evictOllamaForGpuLoad(): Promise<void> {
  if (isAnyAnalysisBusy()) return;
  if (!shouldEvictBeforeSidecarLoad(getLastKnownVram())) return;
  await withGpuLoadLock(async () => {
    try {
      await unloadResidentOllama([getResolvedOllamaModel()]);
    } catch (e) {
      console.warn(`[gpu] pre-load Ollama eviction failed (continuing): ${(e as Error).message}`);
    }
  });
}
```

- [ ] **Step 5: Run tests to verify pass**

Run: `cd server && npx vitest run src/gpu/evict-for-load.test.ts`
Expected: PASS (all four cases).

- [ ] **Step 6: Commit**

```bash
git add server/src/gpu/load-mutex.ts server/src/gpu/evict-for-load.ts server/src/gpu/evict-for-load.test.ts
git commit -m "feat(server): evictOllamaForGpuLoad orchestrator + GPU load-mutex"
```

---

### Task 6: Hook the generation/bulk preload (`ensureSidecarEngineReady`)

**Files:**
- Modify: `server/src/tts/ensure-sidecar-loaded.ts` (`ensureSidecarEngineReady`, before the `for (;;)` loop, ~line 113)
- Test: `server/src/tts/ensure-sidecar-loaded.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
it('evicts a resident Ollama model BEFORE the first /load poll', async () => {
  const calls: string[] = [];
  const evictMock = vi.fn(async () => { calls.push('evict'); });
  vi.doMock('../gpu/evict-for-load.js', () => ({ evictOllamaForGpuLoad: evictMock }));
  vi.stubGlobal('fetch', vi.fn(async () => { calls.push('load'); return okJson({ status: 'ready' }); }));
  const { ensureSidecarEngineReady } = await import('./ensure-sidecar-loaded.js');
  await ensureSidecarEngineReady('qwen', undefined, { timeoutMs: 1000, pollIntervalMs: 10 });
  expect(evictMock).toHaveBeenCalledTimes(1);
  expect(calls[0]).toBe('evict'); // eviction precedes the first load
});

it('does NOT evict for a cloud / non-sidecar engine', async () => {
  const evictMock = vi.fn();
  vi.doMock('../gpu/evict-for-load.js', () => ({ evictOllamaForGpuLoad: evictMock }));
  const { ensureSidecarEngineReady } = await import('./ensure-sidecar-loaded.js');
  await ensureSidecarEngineReady('gemini' as never);
  expect(evictMock).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx vitest run src/tts/ensure-sidecar-loaded.test.ts -t "evicts a resident"`
Expected: FAIL — no eviction call happens today.

- [ ] **Step 3: Implement the hook**

In `ensureSidecarEngineReady`, after the `if (!SIDECAR_ENGINES.has(engine)) return;` guard and before computing `target`/the loop:

```ts
const { evictOllamaForGpuLoad } = await import('../gpu/evict-for-load.js');
await evictOllamaForGpuLoad(); // once, before polling /load (not per attempt)
```

(Place it after the early returns so cloud engines and an already-aborted signal skip it; the dynamic import keeps the gpu module out of the cloud path.)

- [ ] **Step 4: Run tests to verify pass**

Run: `cd server && npx vitest run src/tts/ensure-sidecar-loaded.test.ts`
Expected: PASS (eviction-precedes-load + cloud-skips + existing readiness tests).

- [ ] **Step 5: Commit**

```bash
git add server/src/tts/ensure-sidecar-loaded.ts server/src/tts/ensure-sidecar-loaded.test.ts
git commit -m "feat(server): evict resident Ollama before the generation preload /load"
```

---

### Task 7: Hook the voice-design path (`designQwenVoiceForCharacter`)

**Files:**
- Modify: `server/src/routes/qwen-voice.ts` (inside `withDesignLock`, before the `/qwen/design-voice` fetch, ~line 271)
- Test: `server/src/routes/qwen-voice.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
it('evicts a resident Ollama model before the design fetch', async () => {
  const order: string[] = [];
  const evictMock = vi.fn(async () => { order.push('evict'); });
  vi.doMock('../gpu/evict-for-load.js', () => ({ evictOllamaForGpuLoad: evictMock }));
  vi.stubGlobal('fetch', vi.fn(async () => { order.push('design'); return okJson({ voiceId: 'v', url: 'u' }); }));
  const { designQwenVoiceForCharacter } = await import('./qwen-voice.js');
  await designQwenVoiceForCharacter(/* minimal valid params per the existing suite's helper */);
  expect(evictMock).toHaveBeenCalledTimes(1);
  expect(order[0]).toBe('evict');
});
```

(Reuse the file's existing param/fixture helper for `DesignQwenVoiceParams`; mock `withDesignLock` to invoke its callback if the suite already does.)

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx vitest run src/routes/qwen-voice.test.ts -t "evicts a resident"`
Expected: FAIL — no eviction before the design fetch.

- [ ] **Step 3: Implement the hook**

Inside the `withDesignLock(p.bookDir, async () => { ... })` callback, as the FIRST statement (before `gpuSemaphore.acquire`):

```ts
const { evictOllamaForGpuLoad } = await import('../gpu/evict-for-load.js');
await evictOllamaForGpuLoad(); // free VRAM before the sidecar lazily loads VoiceDesign (~5 GB)
```

- [ ] **Step 4: Run tests to verify pass**

Run: `cd server && npx vitest run src/routes/qwen-voice.test.ts`
Expected: PASS (eviction-precedes-design + existing design tests).

- [ ] **Step 5: Commit**

```bash
git add server/src/routes/qwen-voice.ts server/src/routes/qwen-voice.test.ts
git commit -m "feat(server): evict resident Ollama before voice-design loads VoiceDesign"
```

---

### Task 8: CPU-gate the 9B residency (keep_alive × accelerator)

**Files:**
- Modify: `server/src/analyzer/ollama.ts` (`keepAliveFor`, ~line 129; its caller at ~line 416)
- Test: `server/src/analyzer/ollama.test.ts` (the keep_alive describe, ~line 186)

- [ ] **Step 1: Write the failing test**

Add to the keep_alive describe:

```ts
it('keeps the heavy 9B resident only on a GPU; CPU-only unloads it to spare RAM', async () => {
  const { keepAliveFor } = await import('./ollama.js');
  expect(keepAliveFor('qwen3.5:9b', 'cuda')).toBe('5m');
  expect(keepAliveFor('qwen3.5:9b', 'cpu')).toBe(0);
  // small models stay resident regardless — they don't threaten RAM
  expect(keepAliveFor('qwen3.5:4b', 'cpu')).toBe('5m');
  // unknown accelerator: treat as GPU (the common case) — keep 9B resident
  expect(keepAliveFor('qwen3.5:9b', 'unknown')).toBe('5m');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx vitest run src/analyzer/ollama.test.ts -t "only on a GPU"`
Expected: FAIL — `keepAliveFor` takes one arg.

- [ ] **Step 3: Implement the gate**

Update `keepAliveFor` and its caller. Add a set of "big" models that are only worth pinning where VRAM (not RAM) is the constraint:

```ts
const RAM_HEAVY_MODELS = new Set(['qwen3.5:9b']); // pin only on a GPU

export function keepAliveFor(model: string, accelerator: Accelerator = 'unknown'): string | number {
  if (!RESIDENT_MODELS.has(model)) return 0;
  if (RAM_HEAVY_MODELS.has(model) && accelerator === 'cpu') return 0;
  return '5m';
}
```

Import `Accelerator` + `getLastKnownVram` and thread the accelerator at the call site (~line 416):

```ts
import type { Accelerator } from '../routes/sidecar-health.js';
import { getLastKnownVram } from '../routes/sidecar-health.js';
// ...
keep_alive: keepAliveFor(this.model, getLastKnownVram().accelerator),
```

- [ ] **Step 4: Run tests to verify pass**

Run: `cd server && npx vitest run src/analyzer/ollama.test.ts`
Expected: PASS (new gate test + the 3 updated 9B='5m' tests already on this branch).

- [ ] **Step 5: Commit**

```bash
git add server/src/analyzer/ollama.ts server/src/analyzer/ollama.test.ts
git commit -m "feat(server): pin the 9B analyzer resident only on a GPU (spare CPU RAM)"
```

---

### Task 9: Regression — no sidecar `/load` while an over-budget Ollama model is resident

**Files:**
- Test: `server/src/gpu/eviction-regression.test.ts` (new, integration-style with mocks)

- [ ] **Step 1: Write the failing-then-passing guard test**

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

/* The load-bearing safety invariant for the keep_alive flip: on an 8 GB card,
   a sidecar /load must be PRECEDED by an Ollama eviction. Drive the real
   ensureSidecarEngineReady with mocked VRAM (8 GB), a resident model, and a
   recording fetch; assert the eviction generate-call lands before the /load. */

const events: string[] = [];
vi.mock('../routes/sidecar-health.js', () => ({
  getLastKnownVram: () => ({ accelerator: 'cuda', totalMb: 8188 }),
}));
vi.mock('../tts/design-lock.js', () => ({ isAnyAnalysisBusy: () => false }));
vi.mock('../workspace/user-settings.js', () => ({
  getResolvedOllamaModel: () => 'qwen3.5:9b',
  getResolvedSidecarUrl: () => 'http://sidecar',
}));
vi.mock('../routes/ollama-health.js', () => ({
  unloadResidentOllama: vi.fn(async () => { events.push('ollama-evict'); return ['qwen3.5:9b']; }),
}));

beforeEach(() => { events.length = 0; });

it('on 8 GB, eviction precedes the sidecar /load', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => { events.push('sidecar-load'); return new Response(JSON.stringify({ status: 'ready' }), { status: 200 }); }));
  const { ensureSidecarEngineReady } = await import('../tts/ensure-sidecar-loaded.js');
  await ensureSidecarEngineReady('qwen', undefined, { timeoutMs: 1000, pollIntervalMs: 10 });
  expect(events).toEqual(['ollama-evict', 'sidecar-load']);
});
```

- [ ] **Step 2: Run it**

Run: `cd server && npx vitest run src/gpu/eviction-regression.test.ts`
Expected: PASS (Tasks 5-6 already wired the ordering; this pins it against regressions).

- [ ] **Step 3: Commit**

```bash
git add server/src/gpu/eviction-regression.test.ts
git commit -m "test(server): regression — eviction precedes sidecar load on 8 GB"
```

---

### Task 10: Document the .env knob + full verify

**Files:**
- Modify: `server/.env.example`

- [ ] **Step 1: Document the knob**

Add under the GPU section of `server/.env.example`:

```
# Below this detected GPU VRAM (MB), evict the resident Ollama analyzer before
# loading a sidecar TTS/voice-design model. 8 GB cards evict; 12/16 GB coexist.
# 0 = always evict. Default 11000.
GPU_SAFE_COEXIST_MB=11000
```

- [ ] **Step 2: Run the full server battery**

Run: `cd server && npm run test:server && npm run test:server-slow`
Expected: PASS (all green; the keep_alive-flip tests, the new gpu/ tests, the eviction hooks).

- [ ] **Step 3: Typecheck + verify**

Run: `npm run typecheck` then `npm run verify`
Expected: PASS. (Run `verify` only when the GPU is idle — it contends with any live analysis/generation.)

- [ ] **Step 4: Commit**

```bash
git add server/.env.example
git commit -m "docs(server): document GPU_SAFE_COEXIST_MB eviction threshold"
```

---

## Self-review notes

- **Spec coverage:** §4.1 threshold (Task 3), §4.2 VRAM cache (Task 2), §4.3 shared helper + scoped eviction (Tasks 4-5), §4.4 both hooks (Tasks 6-7), §4.5 load-mutex (Task 5), §4.6 in-flight interlock (Task 5), §4.7 CPU residency gate (Task 8), §8 W1 tests incl. the no-load-while-resident regression (Task 9). Registry knob (Task 1) + .env (Task 10).
- **Out of scope (later waves):** label honesty (W2), progress explainer (W3), MB-accounting policy + split-guard UI (W4 deferred).
- **Merge:** this branch carries the keep_alive flip; do not merge a build with the flip but without Tasks 5-7.
