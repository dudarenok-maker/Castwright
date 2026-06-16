# Wave 1 — GPU eviction before sidecar loads + safe keep_alive flip — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the already-done `qwen3.5:9b` `keep_alive: '5m'` flip safe by evicting resident Ollama models server-side before any sidecar TTS/voice-design load — atomically (evict+load under one lock), evicting **all** residents, and **refusing** the load (409) when analysis is busy on a card that can't coexist.

**Architecture:** A pure `residency` policy decides "evict before load?" from a cached VRAM state (last-known-good from sidecar `/health`, resilient to respawn). `withGpuLoad(loadFn)` is the single chokepoint: on a constrained card it takes a load-mutex, refuses if an analysis is in flight (`GpuBusyError` → 409), evicts **all** resident Ollama models, verifies they're gone (fail-closed), then runs the load **inside the lock**; on a roomy card / CPU it runs the load directly. Two call sites wrap their loads in it: `ensureSidecarEngineReady` (generation/bulk) and `designQwenVoiceForCharacter` (voice design).

**Tech Stack:** TypeScript (Node ESM), Vitest (node env), Express routes, the config registry (`configValue`).

**Spec:** `docs/superpowers/specs/2026-06-16-vram-budget-aware-gpu-policy-design.md` (§4). This plan was revised after a two-lens adversarial review of v1 — see §"Review fixes baked in" at the end.

**Branch:** `git switch feat/analysing-residency-label-progress` then `git branch -m fix/server-gpu-eviction-before-sidecar-load`. The keep_alive flip + its ollama tests already live here (uncommitted) and ship with this wave. **Keep the flip as the LAST commit** so it can be reverted independently if a post-merge OOM surfaces.

---

### Task 1: Register the `gpu.safeCoexistMb` config knob

**Files:**
- Modify: `server/src/config/registry.ts` (the `gpu-lifecycle` group)
- Reference: `server/src/config/types.ts` (the `ConfigKnob` shape — fields are `key`, `env`, `type`, `default`, `risk`, `apply`, `group`, `label`, `help`; numeric knobs may carry `min`)

- [ ] **Step 1: Add the knob to the registry**

Find the `gpu-lifecycle` entries (search `gpu.vramBudget`) and add, matching the existing `ConfigKnob` shape exactly:

```ts
{
  key: 'gpu.safeCoexistMb',
  env: 'GPU_SAFE_COEXIST_MB',
  group: 'gpu-lifecycle',
  type: 'number',
  default: 11000,
  min: 0,
  risk: 'high',
  apply: 'live',
  label: 'Safe analyzer+TTS coexistence VRAM (MB)',
  help: 'If detected GPU VRAM is below this, evict the resident Ollama analyzer before loading a sidecar TTS/voice-design model. 8 GB cards evict; 12/16 GB coexist. 0 = always evict.',
},
```

- [ ] **Step 2: Verify it resolves**

Run: `cd server && npx vitest run src/config`
Expected: PASS — existing registry-shape tests stay green with the new entry; `configValue<number>('gpu.safeCoexistMb')` resolves to 11000 (or `GPU_SAFE_COEXIST_MB`).

- [ ] **Step 3: Commit**

```bash
git add server/src/config/registry.ts
git commit -m "feat(server): add gpu.safeCoexistMb eviction-threshold knob"
```

---

### Task 2: VRAM-state module (cache + types), resilient to respawn

**Files:**
- Create: `server/src/gpu/vram-state.ts` (own the `VramState`/`Accelerator` types + the cache, so neither the analyzer nor the policy has to import the heavy `routes/sidecar-health.ts` graph)
- Modify: `server/src/routes/sidecar-health.ts` (populate the cache on a reachable probe, ~line 244)
- Test: `server/src/gpu/vram-state.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { setLastKnownVram, getLastKnownVram } from './vram-state.js';

describe('last-known VRAM cache', () => {
  beforeEach(() => setLastKnownVram(null)); // reset to "never probed"

  it('defaults to unknown / null before any probe', () => {
    expect(getLastKnownVram()).toEqual({ accelerator: 'unknown', totalMb: null });
  });
  it('records a CUDA total as accelerator cuda', () => {
    setLastKnownVram({ totalMb: 8188 });
    expect(getLastKnownVram()).toEqual({ accelerator: 'cuda', totalMb: 8188 });
  });
  it('records a reachable-but-no-CUDA probe as cpu', () => {
    setLastKnownVram({ totalMb: null });
    expect(getLastKnownVram()).toEqual({ accelerator: 'cpu', totalMb: null });
  });
  it('an unreachable poll (undefined) leaves the last-known state intact', () => {
    setLastKnownVram({ totalMb: 8188 });
    setLastKnownVram(undefined);
    expect(getLastKnownVram()).toEqual({ accelerator: 'cuda', totalMb: 8188 });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx vitest run src/gpu/vram-state.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the module**

```ts
// server/src/gpu/vram-state.ts
export type Accelerator = 'cuda' | 'cpu' | 'unknown';
export interface VramState {
  accelerator: Accelerator;
  totalMb: number | null;
}

/* Last-known VRAM, mirroring the Qwen-install-state cache: only a REACHABLE
   probe updates it, so a transient sidecar respawn (when eviction must still
   decide) doesn't downgrade a known-good reading. `null` resets to "never
   probed"; `undefined` is an unreachable poll (no-op). CUDA presence is inferred
   from a non-null vram_total_mb (the sidecar reports it iff CUDA). */
let lastKnownVram: VramState = { accelerator: 'unknown', totalMb: null };

export function setLastKnownVram(next: { totalMb: number | null } | null | undefined): void {
  if (next === undefined) return;
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

In `sidecar-health.ts` add the import at the top:
```ts
import { setLastKnownVram } from '../gpu/vram-state.js';
```
and immediately after `setLastKnownQwenInstallState(qwenInstallState);` (line ~244):
```ts
setLastKnownVram({
  totalMb: typeof body.vram_total_mb === 'number' ? body.vram_total_mb : null,
});
```

- [ ] **Step 5: Run tests to verify pass**

Run: `cd server && npx vitest run src/gpu/vram-state.test.ts src/routes/sidecar-health.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add server/src/gpu/vram-state.ts server/src/gpu/vram-state.test.ts server/src/routes/sidecar-health.ts
git commit -m "feat(server): last-known GPU VRAM state cache (gpu/vram-state)"
```

---

### Task 3: Pure residency policy — `shouldEvictBeforeSidecarLoad`

**Files:**
- Create: `server/src/gpu/residency.ts`
- Test: `server/src/gpu/residency.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, vi } from 'vitest';
vi.mock('../config/resolver.js', () => ({ configValue: vi.fn(() => 11000) }));
import { shouldEvictBeforeSidecarLoad } from './residency.js';

describe('shouldEvictBeforeSidecarLoad', () => {
  it('CPU never evicts', () => {
    expect(shouldEvictBeforeSidecarLoad({ accelerator: 'cpu', totalMb: null })).toBe(false);
  });
  it('GPU unknown total → evict (conservative)', () => {
    expect(shouldEvictBeforeSidecarLoad({ accelerator: 'cuda', totalMb: null })).toBe(true);
  });
  it('accelerator unknown (never probed) → evict (conservative)', () => {
    expect(shouldEvictBeforeSidecarLoad({ accelerator: 'unknown', totalMb: null })).toBe(true);
  });
  it('8 GB evicts; 12/16 GB coexist', () => {
    expect(shouldEvictBeforeSidecarLoad({ accelerator: 'cuda', totalMb: 8188 })).toBe(true);
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
import type { VramState } from './vram-state.js';

/** Evict a resident Ollama analyzer before loading a sidecar TTS/voice-design
    model? CPU: never. GPU with unknown/never-probed total: yes (conservative).
    GPU below `gpu.safeCoexistMb`: yes; at/above: no (12/16 GB coexist). */
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
git commit -m "feat(server): VRAM-threshold residency policy"
```

---

### Task 4: `unloadResidentOllama` (evict ALL) + `verifyOllamaEvicted`

**Files:**
- Modify: `server/src/routes/ollama-health.ts` (extract from `POST /unload`, ~lines 282-301; reuse `probeOllamaHealth().resident`, `callOllamaGenerate`, `PROBE_TIMEOUT_MS`, `getResolvedOllamaUrl`)
- Test: `server/src/routes/ollama-health.test.ts` (the `/unload` describe, ~line 225)

- [ ] **Step 1: Write the failing test**

```ts
it('unloadResidentOllama() with no targets evicts EVERY resident with keep_alive: 0', async () => {
  // probeOllamaHealth reports two residents; the helper must evict both.
  fetchMock.mockImplementation(async (url: string) => {
    if (String(url).endsWith('/api/ps')) {
      return new Response(JSON.stringify({ models: [{ name: 'qwen3.5:9b' }, { name: 'llama3.1:8b' }] }), { status: 200 });
    }
    return new Response('', { status: 200 }); // /api/generate unload
  });
  const { unloadResidentOllama } = await import('./ollama-health.js');
  const evicted = await unloadResidentOllama();
  expect(evicted.sort()).toEqual(['llama3.1:8b', 'qwen3.5:9b']);
});

it('verifyOllamaEvicted() resolves true once /api/ps no longer lists the target', async () => {
  let calls = 0;
  fetchMock.mockImplementation(async () => {
    calls += 1;
    const models = calls === 1 ? [{ name: 'qwen3.5:9b' }] : []; // gone on the 2nd probe
    return new Response(JSON.stringify({ models }), { status: 200 });
  });
  const { verifyOllamaEvicted } = await import('./ollama-health.js');
  await expect(verifyOllamaEvicted({ retries: 3, delayMs: 1 })).resolves.toBe(true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx vitest run src/routes/ollama-health.test.ts -t "unloadResidentOllama|verifyOllamaEvicted"`
Expected: FAIL — neither is exported.

- [ ] **Step 3: Implement**

```ts
/** Evict resident Ollama model(s) via keep_alive:0 generate calls. Empty/omitted
    `targets` → evict EVERY model /api/ps reports (the safe default: a phase-env
    or quant-tagged resident won't be missed; matches the /unload-all route).
    Returns the list evicted. Throws on the first failed eviction. */
export async function unloadResidentOllama(targets?: string[]): Promise<string[]> {
  const url = getResolvedOllamaUrl();
  const list = targets && targets.length > 0 ? targets : (await probeOllamaHealth()).resident ?? [];
  for (const model of list) {
    const result = await callOllamaGenerate(url, { model, prompt: '', keep_alive: 0, stream: false }, PROBE_TIMEOUT_MS);
    if (!result.ok) throw new Error(result.error ?? `unload ${model} failed`);
  }
  return list;
}

/** Poll /api/ps until no model remains resident (Ollama unloads asynchronously).
    Returns true when clear; false if still resident after the retries. */
export async function verifyOllamaEvicted(opts: { retries?: number; delayMs?: number } = {}): Promise<boolean> {
  const retries = opts.retries ?? 5;
  const delayMs = opts.delayMs ?? 400;
  for (let i = 0; i < retries; i += 1) {
    const resident = (await probeOllamaHealth()).resident ?? [];
    if (resident.length === 0) return true;
    await new Promise((r) => setTimeout(r, delayMs));
  }
  return ((await probeOllamaHealth()).resident ?? []).length === 0;
}
```

Replace the `POST /unload` handler body to delegate:
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
Expected: PASS (new tests + existing single/all/error eviction tests).

- [ ] **Step 5: Commit**

```bash
git add server/src/routes/ollama-health.ts server/src/routes/ollama-health.test.ts
git commit -m "refactor(server): unloadResidentOllama (evict-all) + verifyOllamaEvicted"
```

---

### Task 5: `withGpuLoad` orchestrator + load-mutex + `GpuBusyError`

**Files:**
- Create: `server/src/gpu/load-mutex.ts`
- Create: `server/src/gpu/gpu-load.ts`
- Test: `server/src/gpu/gpu-load.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

const unloadMock = vi.fn(async () => ['qwen3.5:9b']);
const verifyMock = vi.fn(async () => true);
const vramMock = vi.fn();
const busyMock = vi.fn(() => false);
const shouldEvictMock = vi.fn((v: { totalMb: number | null }) => v.totalMb != null && v.totalMb < 11000);

vi.mock('../routes/ollama-health.js', () => ({ unloadResidentOllama: unloadMock, verifyOllamaEvicted: verifyMock }));
vi.mock('./vram-state.js', () => ({ getLastKnownVram: vramMock }));
vi.mock('../tts/design-lock.js', () => ({ isAnyAnalysisBusy: busyMock }));
vi.mock('./residency.js', () => ({ shouldEvictBeforeSidecarLoad: shouldEvictMock }));

import { withGpuLoad, GpuBusyError } from './gpu-load.js';

beforeEach(() => {
  unloadMock.mockClear(); verifyMock.mockClear(); busyMock.mockReturnValue(false); verifyMock.mockResolvedValue(true);
});

describe('withGpuLoad', () => {
  it('on 8 GB: evicts, verifies, then runs the load (in that order)', async () => {
    vramMock.mockReturnValue({ accelerator: 'cuda', totalMb: 8188 });
    const order: string[] = [];
    unloadMock.mockImplementationOnce(async () => { order.push('evict'); return ['qwen3.5:9b']; });
    verifyMock.mockImplementationOnce(async () => { order.push('verify'); return true; });
    const out = await withGpuLoad(async () => { order.push('load'); return 'ok'; });
    expect(out).toBe('ok');
    expect(order).toEqual(['evict', 'verify', 'load']);
  });

  it('on 12 GB: runs the load directly, no eviction', async () => {
    vramMock.mockReturnValue({ accelerator: 'cuda', totalMb: 12288 });
    const out = await withGpuLoad(async () => 'ok');
    expect(out).toBe('ok');
    expect(unloadMock).not.toHaveBeenCalled();
  });

  it('REFUSES with GpuBusyError when analysis is busy on a constrained card (no load)', async () => {
    vramMock.mockReturnValue({ accelerator: 'cuda', totalMb: 8188 });
    busyMock.mockReturnValue(true);
    const load = vi.fn();
    await expect(withGpuLoad(load as never)).rejects.toBeInstanceOf(GpuBusyError);
    expect(load).not.toHaveBeenCalled();
    expect(unloadMock).not.toHaveBeenCalled();
  });

  it('fail-closed: if eviction cannot be verified, throws and does NOT load', async () => {
    vramMock.mockReturnValue({ accelerator: 'cuda', totalMb: 8188 });
    verifyMock.mockResolvedValue(false);
    const load = vi.fn();
    await expect(withGpuLoad(load as never)).rejects.toBeInstanceOf(GpuBusyError);
    expect(load).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx vitest run src/gpu/gpu-load.test.ts`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement the load-mutex**

```ts
// server/src/gpu/load-mutex.ts
/* Serialises evict+load sequences. The GpuSemaphore arbitrates EXECUTION (token
   budget around /chat and /synthesize); it neither knows about nor serialises
   model LOADS. This mutex makes evict→verify→load atomic so two concurrent
   starts can't both evict then both load and overcommit. */
let tail: Promise<unknown> = Promise.resolve();
export function withGpuLoadLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = tail.then(fn, fn);
  tail = run.then(() => undefined, () => undefined);
  return run;
}
```

- [ ] **Step 4: Implement the orchestrator**

```ts
// server/src/gpu/gpu-load.ts
import { getLastKnownVram } from './vram-state.js';
import { shouldEvictBeforeSidecarLoad } from './residency.js';
import { withGpuLoadLock } from './load-mutex.js';
import { unloadResidentOllama, verifyOllamaEvicted } from '../routes/ollama-health.js';
import { isAnyAnalysisBusy } from '../tts/design-lock.js';

/** Thrown when a sidecar TTS/voice-design load cannot proceed on a card that
    can't coexist — because an analysis is in flight, or eviction couldn't be
    confirmed. Routes map it to HTTP 409. */
export class GpuBusyError extends Error {
  readonly code = 'GPU_BUSY';
  constructor(message: string) {
    super(message);
    this.name = 'GpuBusyError';
  }
}

/** Run a sidecar model load safely w.r.t. the resident Ollama analyzer.
    - Roomy card / CPU: run the load directly (it fits; no serialisation needed).
    - Constrained card: under the load-mutex — refuse if analysis is busy
      (would have to evict an active analyzer), else evict ALL residents, verify
      they're gone (fail-closed), then run the load INSIDE the lock. */
export async function withGpuLoad<T>(loadFn: () => Promise<T>): Promise<T> {
  if (!shouldEvictBeforeSidecarLoad(getLastKnownVram())) {
    return loadFn();
  }
  return withGpuLoadLock(async () => {
    if (isAnyAnalysisBusy()) {
      throw new GpuBusyError('GPU busy with analysis — try again once it finishes.');
    }
    await unloadResidentOllama();
    if (!(await verifyOllamaEvicted())) {
      throw new GpuBusyError('Could not free GPU memory (analyzer still resident) — try again shortly.');
    }
    return loadFn();
  });
}
```

- [ ] **Step 5: Run tests to verify pass**

Run: `cd server && npx vitest run src/gpu/gpu-load.test.ts`
Expected: PASS (all four cases).

- [ ] **Step 6: Commit**

```bash
git add server/src/gpu/load-mutex.ts server/src/gpu/gpu-load.ts server/src/gpu/gpu-load.test.ts
git commit -m "feat(server): withGpuLoad — atomic evict+verify+load with refuse-on-busy"
```

---

### Task 6: Wrap the generation preload in `withGpuLoad`

**Files:**
- Modify: `server/src/tts/ensure-sidecar-loaded.ts` (`ensureSidecarEngineReady`, wrap the poll loop, after the early returns ~line 107)
- Modify: `server/src/routes/generation.ts` (the worker that calls `ensureSidecarEngineReady`, ~line 1103 — surface `GpuBusyError` as a clean refusal, not a breaker-tripping crash)
- Test: `server/src/tts/ensure-sidecar-loaded.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
it('wraps the load in withGpuLoad (eviction precedes the first /load on a constrained card)', async () => {
  const order: string[] = [];
  vi.doMock('../gpu/gpu-load.js', () => ({
    withGpuLoad: async (fn: () => Promise<unknown>) => { order.push('gpu-load-gate'); return fn(); },
    GpuBusyError: class extends Error {},
  }));
  vi.stubGlobal('fetch', vi.fn(async () => { order.push('load'); return { ok: true, json: async () => ({ status: 'ready' }) }; }));
  const { ensureSidecarEngineReady } = await import('./ensure-sidecar-loaded.js');
  await ensureSidecarEngineReady('qwen', undefined, { timeoutMs: 1000, pollIntervalMs: 10 });
  expect(order[0]).toBe('gpu-load-gate'); // gate wraps the load
  expect(order).toContain('load');
});

it('does NOT engage the gate for a cloud / non-sidecar engine', async () => {
  const gate = vi.fn(async (fn: () => Promise<unknown>) => fn());
  vi.doMock('../gpu/gpu-load.js', () => ({ withGpuLoad: gate, GpuBusyError: class extends Error {} }));
  const { ensureSidecarEngineReady } = await import('./ensure-sidecar-loaded.js');
  await ensureSidecarEngineReady('gemini' as never);
  expect(gate).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx vitest run src/tts/ensure-sidecar-loaded.test.ts -t "withGpuLoad"`
Expected: FAIL — no gate today.

- [ ] **Step 3: Wrap the loop**

In `ensureSidecarEngineReady`, after `if (!SIDECAR_ENGINES.has(engine)) return;` and `if (signal?.aborted) throw …;`, wrap the existing readiness loop. Move the `for (;;) { … }` into a `withGpuLoad` callback:

```ts
const { withGpuLoad } = await import('../gpu/gpu-load.js');
await withGpuLoad(async () => {
  const target = `${getResolvedSidecarUrl()}/load`;
  const deadline = Date.now() + (opts.timeoutMs ?? READINESS_TIMEOUT_MS);
  const pollIntervalMs = opts.pollIntervalMs ?? POLL_INTERVAL_MS;
  let lastReason = 'unknown';
  for (;;) {
    if (signal?.aborted) throw new DOMException('preload aborted', 'AbortError');
    const outcome = await tryLoadOnce(target, engine, signal);
    if (outcome.ready) return;
    lastReason = outcome.reason;
    if (Date.now() >= deadline) {
      console.warn(`[generation] preload ${engine}: not ready after budget (last: ${lastReason}) — falling back to lazy load.`);
      return;
    }
    await sleep(pollIntervalMs, signal);
  }
});
```

(The whole load is now inside the lock on a constrained card; `withGpuLoad` may throw `GpuBusyError` — let it propagate.)

- [ ] **Step 4: Handle GpuBusyError at the generation worker**

At the `await ensureSidecarEngineReady(engine, chapterSignal);` call sites in `generation.ts` (lines ~1103/1121/1329), wrap so a `GpuBusyError` fails the chapter with a clear, non-retryable message rather than tripping the consecutive-failure breaker:

```ts
try {
  await ensureSidecarEngineReady(engine, chapterSignal);
} catch (e) {
  const { GpuBusyError } = await import('../gpu/gpu-load.js');
  if (e instanceof GpuBusyError) {
    throw new Error(`Generation paused: ${e.message}`); // surfaced to the user; analysis must finish first
  }
  throw e;
}
```

- [ ] **Step 5: Run tests to verify pass**

Run: `cd server && npx vitest run src/tts/ensure-sidecar-loaded.test.ts`
Expected: PASS (gate-wraps-load + cloud-skips + existing readiness tests).

- [ ] **Step 6: Commit**

```bash
git add server/src/tts/ensure-sidecar-loaded.ts server/src/tts/ensure-sidecar-loaded.test.ts server/src/routes/generation.ts
git commit -m "feat(server): gate the generation preload through withGpuLoad"
```

---

### Task 7: Wrap voice design in `withGpuLoad` + map `GpuBusyError` → 409

**Files:**
- Modify: `server/src/routes/qwen-voice.ts` (`designQwenVoiceForCharacter`, wrap the design fetch inside `withDesignLock`, ~line 270)
- Modify: the route that calls `designQwenVoiceForCharacter` (search `design-voice` route handler in `qwen-voice.ts`) — map `GpuBusyError` → HTTP 409
- Test: `server/src/routes/qwen-voice.test.ts` (route-level — the suite is `request(app).post(...)`)

- [ ] **Step 1: Write the failing test (through the route, matching the suite's style)**

```ts
it('returns 409 when analysis is busy on a constrained card (GPU busy)', async () => {
  vi.doMock('../gpu/gpu-load.js', () => ({
    withGpuLoad: async () => { const { GpuBusyError } = await import('../gpu/gpu-load.js'); throw new GpuBusyError('GPU busy with analysis — try again once it finishes.'); },
    GpuBusyError: class GpuBusyError extends Error { code = 'GPU_BUSY'; },
  }));
  const app = await freshApp(); // the suite's app factory
  const res = await request(app).post('/api/books/demo/cast/maerin/design-voice').send({ persona: 'warm' });
  expect(res.status).toBe(409);
  expect(res.body.error).toMatch(/GPU busy/i);
});
```

(If `withGpuLoad` is hard to mock through the route, instead assert the route's error mapping directly: make `designQwenVoiceForCharacter` reject with `GpuBusyError` via the mock and assert the handler's `catch` returns 409. Use whichever the suite's existing structure supports — do NOT leave this as a placeholder; the suite already builds `app` and posts design requests.)

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx vitest run src/routes/qwen-voice.test.ts -t "GPU busy"`
Expected: FAIL — no gate / no 409 mapping yet.

- [ ] **Step 3: Wrap the design fetch**

Inside `withDesignLock(p.bookDir, async () => { … })`, wrap from the `gpuSemaphore.acquire` through the design fetch in `withGpuLoad`:

```ts
const { withGpuLoad } = await import('../gpu/gpu-load.js');
return withGpuLoad(async () => {
  const releaseGpu = await gpuSemaphore.acquire(costForEngine('qwen'));
  // … existing body through the /qwen/design-voice fetch and PCM encode …
});
```

- [ ] **Step 4: Map the error at the route**

In the `design-voice` route handler's `catch`, add before the generic 500:

```ts
const { GpuBusyError } = await import('../gpu/gpu-load.js');
if (err instanceof GpuBusyError) {
  return res.status(409).json({ error: err.message, code: 'gpu_busy' });
}
```

- [ ] **Step 5: Run tests to verify pass**

Run: `cd server && npx vitest run src/routes/qwen-voice.test.ts`
Expected: PASS (new 409 test + existing design tests).

- [ ] **Step 6: Commit**

```bash
git add server/src/routes/qwen-voice.ts server/src/routes/qwen-voice.test.ts
git commit -m "feat(server): gate voice design through withGpuLoad (409 when GPU busy)"
```

---

### Task 8: CPU-gate the 9B residency (keep_alive × accelerator)

**Files:**
- Modify: `server/src/analyzer/ollama.ts` (`keepAliveFor` ~line 129; its caller ~line 416 — import `Accelerator`/`getLastKnownVram` from `../gpu/vram-state.js`, NOT from routes, to keep the import graph light)
- Test: `server/src/analyzer/ollama.test.ts` (keep_alive describe, ~line 186)

- [ ] **Step 1: Write the failing test**

```ts
it('pins the heavy 9B resident only on a GPU; CPU unloads it to spare RAM', async () => {
  const { keepAliveFor } = await import('./ollama.js');
  expect(keepAliveFor('qwen3.5:9b', 'cuda')).toBe('5m');
  expect(keepAliveFor('qwen3.5:9b', 'cpu')).toBe(0);
  expect(keepAliveFor('qwen3.5:4b', 'cpu')).toBe('5m'); // small model: stays
  expect(keepAliveFor('qwen3.5:9b', 'unknown')).toBe('5m'); // unprobed: assume GPU (the perf win)
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx vitest run src/analyzer/ollama.test.ts -t "only on a GPU"`
Expected: FAIL — `keepAliveFor` takes one arg.

- [ ] **Step 3: Implement**

```ts
import type { Accelerator } from '../gpu/vram-state.js';
import { getLastKnownVram } from '../gpu/vram-state.js';

const RAM_HEAVY_MODELS = new Set(['qwen3.5:9b']); // pin only where VRAM (not RAM) is the constraint

export function keepAliveFor(model: string, accelerator: Accelerator = 'unknown'): string | number {
  if (!RESIDENT_MODELS.has(model)) return 0;
  if (RAM_HEAVY_MODELS.has(model) && accelerator === 'cpu') return 0;
  return '5m';
}
```

Caller (~line 416):
```ts
keep_alive: keepAliveFor(this.model, getLastKnownVram().accelerator),
```

- [ ] **Step 4: Run tests to verify pass**

Run: `cd server && npx vitest run src/analyzer/ollama.test.ts`
Expected: PASS (new gate test + the 3 updated 9B='5m' tests already on this branch — they call `keepAliveFor('qwen3.5:9b')` with the default 'unknown' → '5m', still green).

- [ ] **Step 5: Commit**

```bash
git add server/src/analyzer/ollama.ts server/src/analyzer/ollama.test.ts
git commit -m "feat(server): pin the 9B analyzer resident only on a GPU"
```

---

### Task 9: Regression — eviction/refusal invariants under real wiring

**Files:**
- Test: `server/src/gpu/eviction-regression.test.ts`

- [ ] **Step 1: Write the guard tests**

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

const events: string[] = [];
const busy = { value: false };

vi.mock('./vram-state.js', () => ({ getLastKnownVram: () => ({ accelerator: 'cuda', totalMb: 8188 }) }));
vi.mock('../tts/design-lock.js', () => ({ isAnyAnalysisBusy: () => busy.value }));
vi.mock('./residency.js', () => ({ shouldEvictBeforeSidecarLoad: (v: { totalMb: number | null }) => v.totalMb != null && v.totalMb < 11000 }));
vi.mock('../routes/ollama-health.js', () => ({
  unloadResidentOllama: vi.fn(async () => { events.push('evict'); return ['qwen3.5:9b']; }),
  verifyOllamaEvicted: vi.fn(async () => { events.push('verify'); return true; }),
}));

beforeEach(() => { events.length = 0; busy.value = false; });

it('on 8 GB idle: evict → verify → load, in order', async () => {
  const { withGpuLoad } = await import('./gpu-load.js');
  await withGpuLoad(async () => { events.push('load'); });
  expect(events).toEqual(['evict', 'verify', 'load']);
});

it('on 8 GB with analysis busy: REFUSES (GpuBusyError), never evicts or loads', async () => {
  busy.value = true;
  const { withGpuLoad, GpuBusyError } = await import('./gpu-load.js');
  await expect(withGpuLoad(async () => { events.push('load'); })).rejects.toBeInstanceOf(GpuBusyError);
  expect(events).toEqual([]); // no evict, no load
});
```

- [ ] **Step 2: Run it**

Run: `cd server && npx vitest run src/gpu/eviction-regression.test.ts`
Expected: PASS (Tasks 4-5 wired the ordering + refusal).

- [ ] **Step 3: Commit**

```bash
git add server/src/gpu/eviction-regression.test.ts
git commit -m "test(server): eviction precedes load; refuses on analysis-busy (8 GB)"
```

---

### Task 10: Document the knob + full verify

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
Expected: PASS (keep_alive-flip tests, the new gpu/ tests, the two hooks, the regression).

- [ ] **Step 3: Typecheck + verify (GPU idle)**

Run: `npm run typecheck` then `npm run verify`
Expected: PASS. (Run `verify` only when the GPU is idle — it contends with any live analysis/generation.)

- [ ] **Step 4: Commit**

```bash
git add server/.env.example
git commit -m "docs(server): document GPU_SAFE_COEXIST_MB threshold"
```

---

## Review fixes baked in (v1 → v2, from the adversarial review)

- **Registry shape** (B1): `key`/`env`/`risk`/`min`, not `id` — Task 1.
- **Test helpers** (B2/B3): `new Response(...)` and inline `{ ok, json }` — no nonexistent `okResponse`/`okJson` — Tasks 4, 6, 9.
- **Mock completeness** (B4): regression uses module-level mocks of the gpu deps, not a partial user-settings mock — Task 9.
- **Voice-design test** (B5): route-level (`request(app)`), asserting the 409 — Task 7, not an unfillable direct-call placeholder.
- **Interlock hole** (safety B1): analysis-busy on a constrained card now **REFUSES** (`GpuBusyError` → 409), never skip-and-load — Tasks 5, 6, 7.
- **Scoped-evict miss** (safety B2): evict **ALL** residents (button-path parity), not `getResolvedOllamaModel()` — Task 4/5.
- **Mutex scope** (safety B3): `withGpuLoad` holds the lock across **evict + verify + load** — Task 5.
- **Fail-open** (safety S1): `verifyOllamaEvicted` + fail-closed (`GpuBusyError`) on a constrained card — Tasks 4, 5.
- **Heavy import** (code S1): `VramState`/`Accelerator` + cache live in `gpu/vram-state.ts`; analyzer imports from there — Task 2, 8.
- **`'unknown'` accelerator**: eviction treats it as evict (conservative, Task 3); residency treats it as GPU/pin (the perf win, Task 8) — opposite-but-correct per decision; CPU-RAM in the brief unprobed window is the documented out-of-scope caveat (spec §4.8).
- **Independent flip revert** (N1): keep_alive flip stays the last commit on the branch.

## Self-review notes
- **Spec coverage:** §4.1 threshold (T3), §4.2 cache (T2), §4.3 evict-all helper + verify (T4), §4.4 both hooks (T6/T7), §4.5 mutex-wraps-load (T5), §4.6 refuse-on-busy (T5/T6/T7), §4.7 verify/fail-closed (T4/T5), §4.8 CPU residency gate (T8), §8 tests incl. the regression (T9). Knob (T1) + .env (T10).
- **Out of scope (later waves):** label honesty (W2), progress explainer (W3), MB-accounting policy + split-guard UI (W4 deferred).
