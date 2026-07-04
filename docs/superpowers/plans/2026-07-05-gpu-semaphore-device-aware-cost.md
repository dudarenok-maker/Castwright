# GPU semaphore device-aware cost — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop the TTS GPU semaphore from charging VRAM-budget tokens for Kokoro/Qwen/Coqui synth and Qwen-VoiceDesign calls when the engine is actually running on CPU or Apple Silicon (MPS) — and fix Coqui so it picks up MPS on Apple Silicon in the first place — without changing behavior on any existing NVIDIA/CUDA install.

**Architecture:** One new last-known-device cache (`server/src/gpu/engine-device-state.ts`), fed from data the sidecar already reports (`/health`'s per-engine `devices` map, side-14) via a small `sidecar-health.ts` wiring change. `engineDeviceIsGpu()` reads that cache first (falling back to today's config-knob heuristic only when never probed), and its boolean result gates three semaphore-acquire call sites — skipping `acquire()` entirely rather than passing it a zero cost (a zero cost would be floored back to 1 by the semaphore's own clamp). A separate, one-line Python fix makes Coqui's `auto` device resolution include the MPS branch Qwen's equivalent resolver already has.

**Tech Stack:** TypeScript / Node (Express), Vitest; Python (FastAPI sidecar), pytest.

## Global Constraints

- Every change must default to **today's exact behavior** whenever the new cache is `'unknown'` (never probed, or an old sidecar) — no NVIDIA/CUDA install's behavior may change.
- `costForEngine()` itself is **not modified** — it keeps returning its existing static weights for kokoro/qwen/coqui unconditionally; the gating happens at the three call sites, not inside the cost function.
- No new network calls on the hot synth path — the cache is read synchronously.
- The Coqui MPS fix ships gated on a required manual acceptance step on real Apple Silicon hardware (see Task 6) — it is not considered done from automated tests alone.
- Full spec: `docs/superpowers/specs/2026-07-05-gpu-semaphore-device-aware-cost-design.md` (already adversarially reviewed — two rounds, findings folded in). Read it before starting if anything below is ambiguous.

---

## Before Task 1: rename the branch

The design spec currently lives on branch `docs/gpu-semaphore-device-aware-cost-design` (nothing pushed yet). This plan's implementation is `fix(server)` work, not docs, and belongs on the same branch as the spec (one cohesive change: spec → plan → implementation). Rename it before starting:

```bash
git branch -m docs/gpu-semaphore-device-aware-cost-design fix/server-gpu-vram-device-aware-cost
```

All tasks below assume you're on `fix/server-gpu-vram-device-aware-cost`.

---

### Task 1: New shared cache — `server/src/gpu/engine-device-state.ts`

**Files:**
- Create: `server/src/gpu/engine-device-state.ts`
- Test: `server/src/gpu/engine-device-state.test.ts`

**Interfaces:**
- Produces: `EngineDeviceFamily = 'cuda' | 'rocm' | 'directml' | 'mps' | 'cpu' | 'unknown'`; `setLastKnownEngineDevices(devices: SidecarDeviceMap | null | undefined): void`; `getLastKnownEngineDevice(engine: string): EngineDeviceFamily`; `_resetEngineDevicesForTests(): void` (test-only reset, mirrors the pattern other gpu/* caches use).

- [ ] **Step 1: Write the failing test**

Create `server/src/gpu/engine-device-state.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import {
  setLastKnownEngineDevices,
  getLastKnownEngineDevice,
  _resetEngineDevicesForTests,
} from './engine-device-state.js';

describe('engine-device-state', () => {
  beforeEach(() => _resetEngineDevicesForTests());

  it('defaults every tracked engine to unknown', () => {
    expect(getLastKnownEngineDevice('kokoro')).toBe('unknown');
    expect(getLastKnownEngineDevice('coqui')).toBe('unknown');
    expect(getLastKnownEngineDevice('qwen')).toBe('unknown');
  });

  it('returns unknown for an engine outside {kokoro, coqui, qwen}', () => {
    expect(getLastKnownEngineDevice('gemini')).toBe('unknown');
  });

  it('records a reachable devices map per engine', () => {
    setLastKnownEngineDevices({ kokoro: 'cpu', coqui: 'cpu', qwen: 'mps' });
    expect(getLastKnownEngineDevice('kokoro')).toBe('cpu');
    expect(getLastKnownEngineDevice('coqui')).toBe('cpu');
    expect(getLastKnownEngineDevice('qwen')).toBe('mps');
  });

  it('maps a null per-engine slot to unknown', () => {
    setLastKnownEngineDevices({ kokoro: 'cuda', coqui: null, qwen: 'cuda' });
    expect(getLastKnownEngineDevice('coqui')).toBe('unknown');
  });

  it('a null devices map (old sidecar / malformed body) resets every engine to unknown', () => {
    setLastKnownEngineDevices({ kokoro: 'cuda', coqui: 'cuda', qwen: 'cuda' });
    setLastKnownEngineDevices(null);
    expect(getLastKnownEngineDevice('kokoro')).toBe('unknown');
    expect(getLastKnownEngineDevice('coqui')).toBe('unknown');
    expect(getLastKnownEngineDevice('qwen')).toBe('unknown');
  });

  it('an unreachable poll (undefined) leaves the last-known state intact', () => {
    setLastKnownEngineDevices({ kokoro: 'cuda', coqui: 'cuda', qwen: 'cuda' });
    setLastKnownEngineDevices(undefined);
    expect(getLastKnownEngineDevice('kokoro')).toBe('cuda');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx vitest run src/gpu/engine-device-state.test.ts`
Expected: FAIL — `Cannot find module './engine-device-state.js'`

- [ ] **Step 3: Write minimal implementation**

Create `server/src/gpu/engine-device-state.ts`:

```ts
/* Last-known per-engine (kokoro/coqui/qwen) runtime device, mirroring
   vram-state.ts's cache shape. Populated from the sidecar's side-14 `devices`
   map (server/src/routes/sidecar-health.ts) every REACHABLE health poll — an
   unreachable poll must not downgrade a known-good reading, so `undefined` is
   a no-op and only `null` (an old sidecar, or a malformed body) resets to
   'unknown'. Consumed synchronously by engine-device.ts's engineDeviceIsGpu()
   so the GPU semaphore and the pre-load eviction guard both read the same
   ground truth. */

import type { SidecarDeviceMap } from '../routes/sidecar-health.js';

export type EngineDeviceFamily = 'cuda' | 'rocm' | 'directml' | 'mps' | 'cpu' | 'unknown';

const TRACKED_ENGINES = ['kokoro', 'coqui', 'qwen'] as const;
type TrackedEngine = (typeof TRACKED_ENGINES)[number];

function emptyState(): Record<TrackedEngine, EngineDeviceFamily> {
  return { kokoro: 'unknown', coqui: 'unknown', qwen: 'unknown' };
}

let lastKnown: Record<TrackedEngine, EngineDeviceFamily> = emptyState();

function isTrackedEngine(engine: string): engine is TrackedEngine {
  return (TRACKED_ENGINES as readonly string[]).includes(engine);
}

/** Update from a health poll. `undefined` = unreachable poll (no-op, keeps
    prior state). `null` = reachable but no usable devices map (old sidecar,
    or a body `normaliseDevices` rejected) — resets every engine to
    'unknown', never silently invents a family. A concrete map's per-engine
    `null` slot (a family `normaliseDevices` couldn't recognize) also maps to
    'unknown'. */
export function setLastKnownEngineDevices(devices: SidecarDeviceMap | null | undefined): void {
  if (devices === undefined) return;
  if (devices === null) {
    lastKnown = emptyState();
    return;
  }
  const next = emptyState();
  for (const engine of TRACKED_ENGINES) {
    next[engine] = (devices[engine] ?? 'unknown') as EngineDeviceFamily;
  }
  lastKnown = next;
}

/** Synchronous read. Any engine outside {kokoro, coqui, qwen} (e.g. the
    cloud-only 'gemini') always reads back 'unknown' — matches
    costForEngine/engineDeviceIsGpu's existing "no registered device knob"
    convention. */
export function getLastKnownEngineDevice(engine: string): EngineDeviceFamily {
  return isTrackedEngine(engine) ? lastKnown[engine] : 'unknown';
}

export function _resetEngineDevicesForTests(): void {
  lastKnown = emptyState();
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && npx vitest run src/gpu/engine-device-state.test.ts`
Expected: PASS (6 tests)

- [ ] **Step 5: Commit**

```bash
git add server/src/gpu/engine-device-state.ts server/src/gpu/engine-device-state.test.ts
git commit -m "feat(server): add last-known per-engine device cache"
```

---

### Task 2: Wire the cache into `sidecar-health.ts`

**Files:**
- Modify: `server/src/routes/sidecar-health.ts:17` (import), `:250-298` (`probeSidecarHealth`)
- Test: `server/src/routes/sidecar-health.test.ts` (extend)

**Interfaces:**
- Consumes: `setLastKnownEngineDevices` from Task 1 (`server/src/gpu/engine-device-state.ts`).
- Produces: nothing new for later tasks — this only makes the Task 1 cache start receiving real data.

- [ ] **Step 1: Write the failing test**

Add to `server/src/routes/sidecar-health.test.ts` (inside the existing `describe('GET /api/sidecar/health — side-14 device fields', ...)` block, after the last existing `it`):

```ts
  it('feeds the last-known engine-device cache on a reachable poll', async () => {
    const { getLastKnownEngineDevice, _resetEngineDevicesForTests } = await import(
      '../gpu/engine-device-state.js'
    );
    _resetEngineDevicesForTests();
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          ok: true,
          engines: ['kokoro'],
          devices: { kokoro: 'cpu', coqui: 'cuda', qwen: 'mps' },
          devices_state: 'ready',
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );

    await request(makeApp()).get('/api/sidecar/health');
    expect(getLastKnownEngineDevice('kokoro')).toBe('cpu');
    expect(getLastKnownEngineDevice('coqui')).toBe('cuda');
    expect(getLastKnownEngineDevice('qwen')).toBe('mps');
  });

  it('leaves the engine-device cache untouched on an unreachable poll', async () => {
    const { getLastKnownEngineDevice, _resetEngineDevicesForTests, setLastKnownEngineDevices } =
      await import('../gpu/engine-device-state.js');
    _resetEngineDevicesForTests();
    setLastKnownEngineDevices({ kokoro: 'cuda', coqui: 'cuda', qwen: 'cuda' });

    fetchMock.mockResolvedValue(new Response('', { status: 503 }));
    await request(makeApp()).get('/api/sidecar/health');

    expect(getLastKnownEngineDevice('kokoro')).toBe('cuda'); // unchanged
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx vitest run src/routes/sidecar-health.test.ts -t "engine-device cache"`
Expected: FAIL — `getLastKnownEngineDevice('kokoro')` returns `'unknown'` (nothing feeds the cache yet)

- [ ] **Step 3: Write minimal implementation**

In `server/src/routes/sidecar-health.ts`, add the import next to the existing `setLastKnownVram` import (line 17):

```ts
import { setLastKnownVram } from '../gpu/vram-state.js';
import { setLastKnownEngineDevices } from '../gpu/engine-device-state.js';
```

Then hoist the devices computation and feed both consumers. Replace:

```ts
    setLastKnownQwenInstallState(qwenInstallState);
    setLastKnownVram({
      totalMb: typeof body.vram_total_mb === 'number' ? body.vram_total_mb : null,
    });
    return {
```

with:

```ts
    setLastKnownQwenInstallState(qwenInstallState);
    setLastKnownVram({
      totalMb: typeof body.vram_total_mb === 'number' ? body.vram_total_mb : null,
    });
    const devices = normaliseDevices(body.devices);
    setLastKnownEngineDevices(devices);
    return {
```

Then replace the now-duplicate computation further down in the same return object:

```ts
      devices: normaliseDevices(body.devices),
      devicesState: normaliseDevicesState(body.devices_state),
```

with:

```ts
      devices,
      devicesState: normaliseDevicesState(body.devices_state),
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && npx vitest run src/routes/sidecar-health.test.ts`
Expected: PASS (all existing + 2 new tests)

- [ ] **Step 5: Commit**

```bash
git add server/src/routes/sidecar-health.ts server/src/routes/sidecar-health.test.ts
git commit -m "feat(server): feed the per-engine device cache from sidecar health polls"
```

---

### Task 3: `engineDeviceIsGpu` — ground truth first

**Files:**
- Modify: `server/src/gpu/engine-device.ts`
- Test: `server/src/gpu/engine-device.test.ts` (extend)

**Interfaces:**
- Consumes: `getLastKnownEngineDevice` from Task 1.
- Produces: `engineDeviceIsGpu(engine: string): boolean` — same signature as today; callers in `ensure-sidecar-loaded.ts`, `persona-gpu-plan.ts`, `qwen-voice.ts` are unaffected by this task (Task 5 changes `qwen-voice.ts` itself, not because of this function's signature).

- [ ] **Step 1: Write the failing test**

Add a shared reset to the existing `describe('engineDeviceIsGpu', ...)` block's `beforeEach` (currently just `vi.clearAllMocks()`), so the new cache can't leak state between the tests below regardless of execution order:

```ts
beforeEach(async () => {
  vi.clearAllMocks();
  const { _resetEngineDevicesForTests } = await import('./engine-device-state.js');
  _resetEngineDevicesForTests();
});
```

Then add to `server/src/gpu/engine-device.test.ts`, inside that same `describe` block:

```ts
  it('ground truth cpu/mps wins over a GPU-looking knob', async () => {
    const { setLastKnownEngineDevices } = await import('./engine-device-state.js');
    setLastKnownEngineDevices({ kokoro: 'mps', coqui: 'cpu', qwen: 'cuda' });
    (configValue as any).mockReturnValue('cuda'); // knob would say "GPU" if consulted
    expect(engineDeviceIsGpu('kokoro')).toBe(false);
    expect(engineDeviceIsGpu('coqui')).toBe(false);
    expect(configValue).not.toHaveBeenCalled(); // ground truth short-circuits the knob read
  });

  it('ground truth cuda/rocm/directml wins over a cpu-pinned knob', async () => {
    const { setLastKnownEngineDevices } = await import('./engine-device-state.js');
    setLastKnownEngineDevices({ kokoro: 'rocm', coqui: 'directml', qwen: 'cuda' });
    (configValue as any).mockReturnValue('cpu'); // knob would say "not GPU" if consulted
    expect(engineDeviceIsGpu('kokoro')).toBe(true);
    expect(engineDeviceIsGpu('coqui')).toBe(true);
    expect(engineDeviceIsGpu('qwen')).toBe(true);
  });

  it('falls back to the knob when ground truth is unknown (never probed)', async () => {
    (configValue as any).mockReturnValue('cpu');
    expect(engineDeviceIsGpu('kokoro')).toBe(false);
    (configValue as any).mockReturnValue('cuda:1');
    expect(engineDeviceIsGpu('kokoro')).toBe(true);
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx vitest run src/gpu/engine-device.test.ts`
Expected: FAIL — the first new test fails because `engineDeviceIsGpu` still reads the (mocked, GPU-looking) knob and returns `true`, not `false`.

- [ ] **Step 3: Write minimal implementation**

Replace the full contents of `server/src/gpu/engine-device.ts`:

```ts
/* Resolves whether a TTS engine's ACTUAL runtime device is GPU or CPU-family.
   Ground truth (getLastKnownEngineDevice, fed from the sidecar's side-14
   per-engine devices map) wins whenever it's known; the CONFIGURED device
   knob is only a fallback for when that engine has never been probed (e.g.
   before the sidecar's first health poll). Used by the Wave 2 §W2.6 Node
   guards, which reason about whether the engine about to load/run touches
   the GPU at all (never which card) — and, since this design, also gates
   whether a synth/design call enters the GPU semaphore at all. */

import { configValue } from '../config/resolver.js';
import { getLastKnownEngineDevice } from './engine-device-state.js';

const ENGINE_DEVICE_KEY: Record<string, string> = {
  qwen: 'tts.qwen.device',
  coqui: 'tts.coqui.device',
  kokoro: 'tts.kokoro.device',
};

const GPU_FAMILIES = new Set(['cuda', 'rocm', 'directml']);

/** True when `engine` actually touches the GPU. Ground truth first: if the
    engine's last-known runtime device is known (cuda/rocm/directml/mps/cpu),
    that answer is authoritative. Only when it's 'unknown' (never probed, or
    an old sidecar) does this fall back to the CONFIGURED device knob —
    cuda/cuda:N, or auto (usually resolves to a GPU, so treated as GPU
    conservatively). False only for an explicit cpu/mps pin. An engine with
    no registered device knob (e.g. 'gemini', a cloud engine) defaults to
    true — the conservative "assume contention is possible" choice, so a new
    engine never silently defeats these guards. */
export function engineDeviceIsGpu(engine: string): boolean {
  const known = getLastKnownEngineDevice(engine);
  if (known !== 'unknown') return GPU_FAMILIES.has(known);
  const key = ENGINE_DEVICE_KEY[engine];
  if (!key) return true;
  const raw = (configValue<string>(key) ?? 'auto').trim().toLowerCase();
  return raw === 'auto' || raw.startsWith('cuda');
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && npx vitest run src/gpu/engine-device.test.ts`
Expected: PASS (all existing + 3 new tests). Note the existing test "true (conservative) for an engine with no registered device knob" (asserting `configValue` is never called for `'gemini'`) still passes: `getLastKnownEngineDevice('gemini')` returns `'unknown'` without touching `configValue`, then `!key` short-circuits before any `configValue` read.

- [ ] **Step 5: Commit**

```bash
git add server/src/gpu/engine-device.ts server/src/gpu/engine-device.test.ts
git commit -m "fix(server): engineDeviceIsGpu reads real device ground truth first"
```

---

### Task 4: Gate `sidecar.ts`'s two semaphore acquires

**This is the task that fixes the Critical defect an adversarial review caught in the design spec** — the original approach (returning `0` from `costForEngine`) was an inert no-op because `GpuSemaphore.acquire()`'s `clampCost` floors any cost below 1 back up to 1. The fix instead skips calling `acquire()` at all when the engine is off-GPU.

**Files:**
- Modify: `server/src/tts/sidecar.ts:26-29` (imports), `:104-160` (`synthesize`), `:191-220` (`synthesizeBatch`)
- Test: `server/src/tts/sidecar.test.ts` (extend)

**Interfaces:**
- Consumes: `engineDeviceIsGpu` from Task 3 (`server/src/gpu/engine-device.ts`).
- Produces: no change to `SidecarTtsProvider`'s public interface (`synthesize`/`synthesizeBatch` signatures unchanged); the existing test-only `gpuSem` constructor injection seam (`SidecarOptions.gpuSem`) is what the new test uses.

**A note on the test mocking approach below, before you start:** the first two tests use `vi.spyOn` on the `engine-device.js` module namespace to override `engineDeviceIsGpu`'s return value. This pattern isn't used anywhere else in this codebase today (the closest analogue, `transcribe-client.test.ts`'s `asrRunsOnGpu` coverage, drives the real function via an env var instead) — it should work under Vitest's ESM handling, but if Step 2 shows the mock isn't actually intercepting `sidecar.ts`'s call (i.e. the "skip" test still shows `acquire` called), don't fight it: switch that test to the same real-cache approach the third test below already uses (`setLastKnownEngineDevices` + the unmocked `engineDeviceIsGpu`), which is proven to work (it's exactly Task 3's own test pattern).

- [ ] **Step 1: Write the failing test**

Add to `server/src/tts/sidecar.test.ts` (new top-level `describe`, after the existing ones):

```ts
describe('device-aware GPU semaphore gating', () => {
  it('skips the GPU semaphore entirely when the engine is confirmed off-GPU', async () => {
    const { engineDeviceIsGpu } = await import('../gpu/engine-device.js');
    vi.spyOn(await import('../gpu/engine-device.js'), 'engineDeviceIsGpu').mockReturnValue(false);
    const { GpuSemaphore } = await import('../gpu/semaphore.js');
    const fakeGpuSem = new GpuSemaphore(4);
    const acquireSpy = vi.spyOn(fakeGpuSem, 'acquire');

    stubFetch(async () => {
      const pcm = Buffer.alloc(4, 0);
      return new Response(pcm, {
        status: 200,
        headers: { 'content-type': 'audio/L16;codec=pcm;rate=24000' },
      });
    });

    const provider = new SidecarTtsProvider({
      url: 'http://localhost:6006/',
      engine: 'coqui',
      gpuSem: fakeGpuSem,
    });
    await provider.synthesize(SYNTH_INPUT);

    expect(acquireSpy).not.toHaveBeenCalled();
    void engineDeviceIsGpu; // keep the import referenced for the mock above
  });

  it('still acquires a token when the engine is confirmed on-GPU', async () => {
    vi.spyOn(await import('../gpu/engine-device.js'), 'engineDeviceIsGpu').mockReturnValue(true);
    const { GpuSemaphore } = await import('../gpu/semaphore.js');
    const fakeGpuSem = new GpuSemaphore(4);
    const acquireSpy = vi.spyOn(fakeGpuSem, 'acquire');

    stubFetch(async () => {
      const pcm = Buffer.alloc(4, 0);
      return new Response(pcm, {
        status: 200,
        headers: { 'content-type': 'audio/L16;codec=pcm;rate=24000' },
      });
    });

    const provider = new SidecarTtsProvider({
      url: 'http://localhost:6006/',
      engine: 'coqui',
      gpuSem: fakeGpuSem,
    });
    await provider.synthesize(SYNTH_INPUT);

    expect(acquireSpy).toHaveBeenCalledTimes(1);
  });

  it('end-to-end with the REAL engineDeviceIsGpu: ground truth mps wins over an auto knob that would say GPU', async () => {
    /* No mocking of engine-device.js here — this proves Task 3's ground-truth-
       first logic is what actually causes the skip, not just a spied return
       value. Without Task 3 (i.e. engineDeviceIsGpu only reading the config
       knob), this test would fail: COQUI_DEVICE is unset ('auto'), which the
       knob-only logic treats as "assume GPU" — the real-world Apple Silicon
       case this whole design exists to fix. */
    const { setLastKnownEngineDevices, _resetEngineDevicesForTests } = await import(
      '../gpu/engine-device-state.js'
    );
    _resetEngineDevicesForTests();
    setLastKnownEngineDevices({ kokoro: 'mps', coqui: 'mps', qwen: 'mps' });
    const prevDevice = process.env.COQUI_DEVICE;
    delete process.env.COQUI_DEVICE; // unset → knob defaults to 'auto'

    const { GpuSemaphore } = await import('../gpu/semaphore.js');
    const fakeGpuSem = new GpuSemaphore(4);
    const acquireSpy = vi.spyOn(fakeGpuSem, 'acquire');

    stubFetch(async () => {
      const pcm = Buffer.alloc(4, 0);
      return new Response(pcm, {
        status: 200,
        headers: { 'content-type': 'audio/L16;codec=pcm;rate=24000' },
      });
    });

    try {
      const provider = new SidecarTtsProvider({
        url: 'http://localhost:6006/',
        engine: 'coqui',
        gpuSem: fakeGpuSem,
      });
      await provider.synthesize(SYNTH_INPUT);
      expect(acquireSpy).not.toHaveBeenCalled();
    } finally {
      _resetEngineDevicesForTests();
      if (prevDevice === undefined) delete process.env.COQUI_DEVICE;
      else process.env.COQUI_DEVICE = prevDevice;
    }
  });
});
```

Note: this test file already mocks the `undici` module's `fetch` export (see the top of `sidecar.test.ts`) via the shared `stubFetch`/`mockFetch` helpers — reuse those, don't add a second `fetch` mock.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx vitest run src/tts/sidecar.test.ts -t "device-aware GPU semaphore gating"`
Expected: FAIL — the first and third tests' `acquireSpy` WAS called once each (today's code always calls `this.gpuSem.acquire(...)` regardless of `engineDeviceIsGpu`).

- [ ] **Step 3: Write minimal implementation**

In `server/src/tts/sidecar.ts`, add the import next to the existing `costForEngine` import:

```ts
import { gpuSemaphore, GpuSemaphore } from '../gpu/semaphore.js';
import { costForEngine } from './engine-vram-cost.js';
import { engineDeviceIsGpu } from '../gpu/engine-device.js';
```

In `synthesize()`, replace:

```ts
      const releaseGpu = await this.gpuSem.acquire(costForEngine(this.engine));

      try {
        const response = await this.post('/synthesize', body, signal);
```

with:

```ts
      /* Skipped entirely (releaseGpu = null) when this.engine is confirmed
         running off-GPU (cpu/mps) — mirrors the analyzer/ASR/spk convention
         (see server/src/gpu/engine-device.ts). A returned cost of 0 would NOT
         achieve this: GpuSemaphore.acquire()'s clampCost floors any cost
         below 1 back up to 1, so the call site itself must skip acquire(). */
      const onGpu = engineDeviceIsGpu(this.engine);
      const releaseGpu = onGpu ? await this.gpuSem.acquire(costForEngine(this.engine)) : null;

      try {
        const response = await this.post('/synthesize', body, signal);
```

and further down in the same method, replace:

```ts
      } finally {
        releaseGpu();
      }
    } finally {
      releaseEngine();
    }
  }

  /* TRUE batching (plan 112)
```

with:

```ts
      } finally {
        releaseGpu?.();
      }
    } finally {
      releaseEngine();
    }
  }

  /* TRUE batching (plan 112)
```

In `synthesizeBatch()`, replace:

```ts
    const releaseEngine = await engineSynthSem(this.engineSynths, this.engine).acquire();
    try {
      const releaseGpu = await this.gpuSem.acquire(costForEngine(this.engine));
      try {
        const response = await this.post('/synthesize-batch', body, signal);
```

with:

```ts
    const releaseEngine = await engineSynthSem(this.engineSynths, this.engine).acquire();
    try {
      const onGpu = engineDeviceIsGpu(this.engine);
      const releaseGpu = onGpu ? await this.gpuSem.acquire(costForEngine(this.engine)) : null;
      try {
        const response = await this.post('/synthesize-batch', body, signal);
```

and replace:

```ts
        return { pcms, sampleRate, genMs, audioMs };
      } finally {
        releaseGpu();
      }
    } finally {
      releaseEngine();
    }
  }
```

with:

```ts
        return { pcms, sampleRate, genMs, audioMs };
      } finally {
        releaseGpu?.();
      }
    } finally {
      releaseEngine();
    }
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && npx vitest run src/tts/sidecar.test.ts`
Expected: PASS (all existing tests + 3 new ones)

- [ ] **Step 5: Run the full server test suite to check for ripple effects**

Run: `cd server && npm test`
Expected: PASS. (`engineDeviceIsGpu` is real, unmocked, in every other test file that exercises `SidecarTtsProvider` — its default knob-fallback behavior at `'unknown'` ground truth is unchanged from today, so no other test should need touching.)

- [ ] **Step 6: Commit**

```bash
git add server/src/tts/sidecar.ts server/src/tts/sidecar.test.ts
git commit -m "fix(server): skip the GPU semaphore for off-GPU TTS synth calls"
```

---

### Task 5: Gate `qwen-voice.ts`'s VoiceDesign acquire

**This closes the gap an adversarial re-review round caught** — this file already computes `engineDeviceIsGpu('qwen')` for its eviction guard but never reused it for its own semaphore acquire two lines above.

**Files:**
- Modify: `server/src/routes/qwen-voice.ts:324-329, 466-469`
- Test: `server/src/routes/qwen-voice.test.ts` (extend)

**Interfaces:**
- Consumes: `engineDeviceIsGpu` from Task 3 (already imported dynamically in this file today).
- Produces: nothing new for later tasks.

- [ ] **Step 1: Write the failing test**

Add to `server/src/routes/qwen-voice.test.ts`, inside the existing `describe('POST /api/books/:bookId/cast/:characterId/design-voice', ...)` block, right after the existing `'passes engineDeviceIsGpu(\'qwen\') as withGpuLoad\'s second arg'` test:

```ts
  it('skips the GPU semaphore for the design call when QWEN_DEVICE is pinned off-GPU', async () => {
    const { gpuSemaphore } = await import('../gpu/semaphore.js');
    const acquireSpy = vi.spyOn(gpuSemaphore, 'acquire');
    const prevDevice = process.env.QWEN_DEVICE;
    process.env.QWEN_DEVICE = 'cpu';

    try {
      const res = await request(app)
        .post(`/api/books/${bookId}/cast/maerin/design-voice`)
        .send(designBody);

      expect(res.status).toBe(200);
      expect(acquireSpy).not.toHaveBeenCalled();
    } finally {
      acquireSpy.mockRestore();
      if (prevDevice === undefined) delete process.env.QWEN_DEVICE;
      else process.env.QWEN_DEVICE = prevDevice;
    }
  });

  it('still acquires a token for the design call on the default (GPU-assumed) auto knob', async () => {
    const { gpuSemaphore } = await import('../gpu/semaphore.js');
    const acquireSpy = vi.spyOn(gpuSemaphore, 'acquire');

    const res = await request(app)
      .post(`/api/books/${bookId}/cast/maerin/design-voice`)
      .send(designBody);

    expect(res.status).toBe(200);
    expect(acquireSpy).toHaveBeenCalledTimes(1);
    acquireSpy.mockRestore();
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx vitest run src/routes/qwen-voice.test.ts -t "skips the GPU semaphore for the design call"`
Expected: FAIL — `acquireSpy` WAS called once even with `QWEN_DEVICE=cpu` (today's code always calls `gpuSemaphore.acquire(...)` at line 328 regardless of device).

- [ ] **Step 3: Write minimal implementation**

In `server/src/routes/qwen-voice.ts`, replace:

```ts
  return withDesignLock(p.bookDir, async () => {
    const { withGpuLoad } = await import('../gpu/gpu-load.js');
    const { engineDeviceIsGpu } = await import('../gpu/engine-device.js');
    return withGpuLoad(async () => {
      const releaseGpu = await gpuSemaphore.acquire(costForEngine('qwen'));
      const sidecarUrl = getResolvedSidecarUrl();
```

with:

```ts
  return withDesignLock(p.bookDir, async () => {
    const { withGpuLoad } = await import('../gpu/gpu-load.js');
    const { engineDeviceIsGpu } = await import('../gpu/engine-device.js');
    /* Computed once, reused both as withGpuLoad's eviction-guard hint AND to
       gate this function's own semaphore acquire below — an earlier pass of
       this design only wired the eviction guard and left this acquire
       unconditional, still charging a token for VoiceDesign on cpu/mps. */
    const onGpu = engineDeviceIsGpu('qwen');
    return withGpuLoad(async () => {
      const releaseGpu = onGpu ? await gpuSemaphore.acquire(costForEngine('qwen')) : null;
      const sidecarUrl = getResolvedSidecarUrl();
```

Then replace:

```ts
      } finally {
        releaseGpu();
      }
    }, engineDeviceIsGpu('qwen'));
  });
}
```

with:

```ts
      } finally {
        releaseGpu?.();
      }
    }, onGpu);
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && npx vitest run src/routes/qwen-voice.test.ts`
Expected: PASS (all existing tests, including the pre-existing `'passes engineDeviceIsGpu(\'qwen\') as withGpuLoad\'s second arg'` test — `onGpu` is the same value that function call would have produced inline — plus the 2 new tests)

- [ ] **Step 5: Commit**

```bash
git add server/src/routes/qwen-voice.ts server/src/routes/qwen-voice.test.ts
git commit -m "fix(server): skip the GPU semaphore for off-GPU Qwen voice design"
```

---

### Task 6: Coqui `auto` → MPS (Python sidecar)

**Files:**
- Modify: `server/tts-sidecar/main.py:737-738` (`CoquiEngine._resolve_runtime_options`)
- Test: `server/tts-sidecar/tests/test_coqui_device.py` (extend)

**Interfaces:**
- Consumes: `_resolve_torch_device(pref: str, torch_module) -> str` (already exists, `server/tts-sidecar/main.py:1497-1512`, used by `QwenEngine` today).
- Produces: no signature change to `CoquiEngine._resolve_runtime_options` — only its internal `auto` resolution changes.

**Note on a side effect this task intentionally accepts:** today, `auto` + CUDA available resolves to the bare string `"cuda"`. `_resolve_torch_device`'s `auto` branch resolves to `"cuda:0"` instead (explicit index 0). Both mean the exact same physical device — `_validate_cuda_index` handles `"cuda:0"` correctly (validates index 0 exists, a strict improvement over the old bare-string case where no index was ever validated), and every existing test that checks `_resolved_device == "cuda"` does so by setting `COQUI_DEVICE=cuda` **explicitly** (not `auto`), so none of them exercise this changed branch. This task adds an explicit test pinning the new `"cuda:0"` auto-resolution so the change is visible, not silent.

- [ ] **Step 1: Write the failing test**

Add to `server/tts-sidecar/tests/test_coqui_device.py`. First, widen the existing `_torch_stub` helper (this is backward compatible — every existing call site keeps passing, since `mps_available` defaults to `False` and is only consulted when `cuda_available` is `False` and `device == "auto"`, a combination no existing test exercises):

```python
def _torch_stub(cuda_available: bool = True, mps_available: bool = False) -> types.SimpleNamespace:
    """Minimal torch stub for _resolve_runtime_options injection.
    cuda.is_available() and (since the MPS fix) backends.mps.is_available()
    are read, and only when device == 'auto'."""
    t = types.SimpleNamespace()
    t.cuda = types.SimpleNamespace(is_available=lambda: cuda_available)
    t.backends = types.SimpleNamespace(
        mps=types.SimpleNamespace(is_available=lambda: mps_available)
    )
    return t
```

Then add these new test functions at the end of the file:

```python
def test_auto_falls_to_mps_when_no_cuda(monkeypatch):
    """'auto' with no CUDA but MPS available (Apple Silicon) resolves to mps,
    not cpu — the bug this fix closes. Mirrors test_qwen_device.py's
    equivalent case for QwenEngine's _resolve_torch_device."""
    monkeypatch.setenv("COQUI_DEVICE", "auto")
    monkeypatch.delenv("COQUI_HALF", raising=False)
    monkeypatch.delenv("COQUI_DEEPSPEED", raising=False)
    eng = main.CoquiEngine()
    opts = eng._resolve_runtime_options(_torch_stub(cuda_available=False, mps_available=True))
    assert opts["device"] == "mps"
    # fp16/deepspeed stay off on mps — same non-cuda branch as cpu.
    assert opts["half"] is False
    assert opts["deepspeed"] is False


def test_auto_falls_to_cpu_when_neither_cuda_nor_mps(monkeypatch):
    """'auto' with neither CUDA nor MPS available still resolves to cpu — no
    regression for a plain CPU-only box."""
    monkeypatch.setenv("COQUI_DEVICE", "auto")
    eng = main.CoquiEngine()
    opts = eng._resolve_runtime_options(_torch_stub(cuda_available=False, mps_available=False))
    assert opts["device"] == "cpu"


def test_auto_cuda_available_now_resolves_to_indexed_cuda_zero(monkeypatch):
    """Documents an accepted, harmless side effect of reusing
    _resolve_torch_device: 'auto' + CUDA available now resolves to 'cuda:0'
    (an explicit index) rather than the old bare 'cuda' string. Functionally
    identical (same physical device); pinned here so it's a visible,
    intentional change rather than a silent one."""
    monkeypatch.setenv("COQUI_DEVICE", "auto")
    eng = main.CoquiEngine()
    opts = eng._resolve_runtime_options(_torch_stub(cuda_available=True))
    assert opts["device"] == "cuda:0"
    assert opts["half"] is True
    assert opts["deepspeed"] is True
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server/tts-sidecar && .\.venv\Scripts\python.exe -m pytest tests/test_coqui_device.py -v`
Expected: FAIL on `test_auto_falls_to_mps_when_no_cuda` (`opts["device"] == "cpu"`, not `"mps"`) and on `test_auto_cuda_available_now_resolves_to_indexed_cuda_zero` (`opts["device"] == "cuda"`, not `"cuda:0"`). `test_auto_falls_to_cpu_when_neither_cuda_nor_mps` should already PASS (no code change needed for that case).

- [ ] **Step 3: Write minimal implementation**

In `server/tts-sidecar/main.py`, inside `CoquiEngine._resolve_runtime_options`, replace:

```python
        device = self._device
        if device == "auto":
            device = "cuda" if torch_module.cuda.is_available() else "cpu"
```

with:

```python
        device = self._device
        if device == "auto":
            device = _resolve_torch_device(device, torch_module)
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server/tts-sidecar && .\.venv\Scripts\python.exe -m pytest tests/test_coqui_device.py -v`
Expected: PASS (all existing tests + 3 new ones)

- [ ] **Step 5: Run the full sidecar test suite to check for ripple effects**

Run: `cd server/tts-sidecar && .\.venv\Scripts\python.exe -m pytest -v`
Expected: PASS. Pay particular attention to `test_runtime_wiring.py` and `test_device_probe.py` (both assert `_resolved_device`/`devices["coqui"]` in various scenarios) — every one of those sets `COQUI_DEVICE` to an explicit non-`"auto"` value or monkeypatches `_resolved_device` directly, so none should be affected by this change. If any fails, that's new information — stop and investigate before continuing (do not paper over a real regression).

- [ ] **Step 6: Commit**

```bash
cd server/tts-sidecar && git add main.py tests/test_coqui_device.py
git commit -m "fix(sidecar): Coqui auto device resolution picks up MPS on Apple Silicon"
```

**Do not mark this task's real-world behavior as done yet.** Per the design spec, this fix requires a manual acceptance step on real Apple Silicon hardware before it's considered shipped (see Task 7, Step 2) — automated tests only prove the device *string* resolves correctly, not that XTTS v2 inference actually produces correct audio on MPS.

---

### Task 7: Wrap-up — verify, docs, PR to mergeable state

**Files:**
- Modify: `docs/superpowers/specs/2026-07-05-gpu-semaphore-device-aware-cost-design.md` (Ship notes)
- Modify: `docs/features/108-qwen-coexistence.md` (brief addendum — this fix changes behavior of the VRAM-weighted semaphore that plan documents)
- Modify: `docs/release-notes-next.md`, `RELEASE_NOTES.md`

- [ ] **Step 1: Run the full verify battery**

Run: `npm run verify`
Expected: PASS (typecheck + all tests + e2e + build). This change has no frontend/UI surface, so no e2e spec is needed for it — the "UI-visible behaviour" testing-discipline bar in `CLAUDE.md` doesn't apply here (nothing changed in `src/`).

- [ ] **Step 2: Manual acceptance for the Coqui MPS fix, IF Apple Silicon hardware is available**

If you have access to a real Apple Silicon Mac: install the sidecar there, leave `COQUI_DEVICE` unset (`auto`), run a Coqui XTTS v2 synth, and confirm (a) the sidecar log shows it resolved to `mps`, and (b) the produced audio is correct, not garbled or silent. If it's broken, do not proceed with Task 6 as a default-on change — instead amend Task 6 to gate the MPS resolution behind an explicit opt-in (or revert to cpu-only for Coqui) and note the finding in the spec's Ship notes.

If no Apple Silicon hardware is available in this environment: **do not claim this is verified.** Note explicitly in the PR description and in the spec's Ship notes that Task 6 ships with automated coverage only, and file/link a follow-up asking for real-hardware confirmation before the next release that includes it.

- [ ] **Step 3: Add a Ship notes entry to the design spec**

Add to the end of `docs/superpowers/specs/2026-07-05-gpu-semaphore-device-aware-cost-design.md`, replacing the `_Not yet shipped._` line under `## Ship notes`:

```markdown
Shipped 2026-07-05 (or the actual merge date) on branch
`fix/server-gpu-vram-device-aware-cost`. Tasks 1-5 (the Node-side
device-aware semaphore gating) have full automated coverage. Task 6 (Coqui
MPS auto-resolution) has automated coverage for the device-string
resolution only — see the manual acceptance step above for whether real
Apple Silicon inference was confirmed working before this shipped.
```

- [ ] **Step 4: Add a brief addendum to plan 108**

Read `docs/features/108-qwen-coexistence.md`'s "Ship notes" section (near the end of the file) and add a new subsection after the existing Wave entries:

```markdown
### Follow-up — device-aware GPU semaphore gating (2026-07-05)

- The VRAM-weighted semaphore this plan introduced (Wave 1,
  `feat/gpu-vram-weighted-semaphore`) charged every kokoro/qwen/coqui synth
  its static VRAM-weight token regardless of whether the engine was
  actually running on CUDA, CPU, or Apple Silicon (MPS) — needlessly
  serialising generation on non-CUDA installs. Fixed in
  [docs/superpowers/specs/2026-07-05-gpu-semaphore-device-aware-cost-design.md](../superpowers/specs/2026-07-05-gpu-semaphore-device-aware-cost-design.md):
  a new per-engine device cache (fed from side-14's `devices` map) now gates
  the semaphore acquire in `sidecar.ts` and `qwen-voice.ts`'s VoiceDesign
  path, skipping it entirely when the engine is confirmed off-GPU. Also
  fixed Coqui's own `auto` device resolution, which had no MPS branch
  (unlike Qwen's).
```

- [ ] **Step 5: Release notes**

Add an entry to `docs/release-notes-next.md` (technical register) and a matching user-facing line to the in-progress version section at the top of `RELEASE_NOTES.md`, following the format already used by neighboring entries in each file — read the top few entries of each file first to match voice/format exactly before writing.

- [ ] **Step 6: Commit the docs**

```bash
git add docs/superpowers/specs/2026-07-05-gpu-semaphore-device-aware-cost-design.md \
        docs/features/108-qwen-coexistence.md \
        docs/release-notes-next.md RELEASE_NOTES.md
git commit -m "docs(docs): ship notes + release notes for device-aware GPU semaphore fix"
```

- [ ] **Step 7: Push and open the PR**

This is bug-shaped work (fixing existing broken behavior on non-CUDA platforms, no new feature) — per `CONTRIBUTING.md`'s two-shape convention it gets a standalone `bug`-labeled issue, not a `docs/BACKLOG.md` row.

```bash
git push -u origin fix/server-gpu-vram-device-aware-cost
```

Check whether a GitHub issue already covers this (it likely doesn't — this was discovered during this session's design work, not pre-filed). If none exists, file one:

```bash
gh issue create --title "GPU semaphore charges VRAM tokens for off-GPU TTS engines" \
  --label bug \
  --body "$(cat <<'EOF'
On CPU-only or Apple Silicon (MPS) installs, the weighted GPU semaphore
charges every kokoro/qwen/coqui synth call its static VRAM-weight token
regardless of the engine's actual runtime device, needlessly serialising
generation against a budget shaped for an 8 GB NVIDIA card. Coqui's own
`auto` device resolution also has no MPS branch, unlike Qwen's.

See docs/superpowers/specs/2026-07-05-gpu-semaphore-device-aware-cost-design.md
for the full design and the adversarial-review trail.
EOF
)"
```

Then open the PR (fill in the actual issue number from the command above):

```bash
gh pr create --title "fix(server): gate GPU semaphore on actual TTS engine device" --body "$(cat <<'EOF'
## Summary
- On CPU-only/Apple Silicon installs, kokoro/qwen/coqui synth + Qwen
  VoiceDesign no longer charge VRAM-budget semaphore tokens when the engine
  is confirmed running off-GPU — closes needless serialisation on hardware
  that was never really contending over a discrete VRAM pool.
- `engineDeviceIsGpu` now reads real per-engine device ground truth (fed
  from the sidecar's side-14 `devices` map) before falling back to the
  configured knob, fixing the same needless-eviction gap in the analyzer
  pre-load guard.
- Coqui's `auto` device resolution now picks up MPS on Apple Silicon,
  matching Qwen's existing resolver.
- Every change defaults to today's exact behaviour on any existing
  NVIDIA/CUDA install (falls back to the prior knob-based logic whenever
  the new cache is `'unknown'`).

## Test plan
- [ ] `npm run verify` green
- [ ] New/extended unit tests: `engine-device-state.test.ts`,
      `sidecar-health.test.ts`, `engine-device.test.ts`, `sidecar.test.ts`,
      `qwen-voice.test.ts`, `test_coqui_device.py`
- [ ] Manual: real Apple Silicon hardware confirms Coqui XTTS v2 actually
      produces correct audio under `auto`-resolved MPS (see spec Ship notes
      for whether this was completed before merge)

Closes #<issue-number-from-above>
EOF
)"
```

- [ ] **Step 8: Mandatory independent review**

Per `CLAUDE.md`'s model-routing skill: this PR is a single-scope `fix` touching only `server` (the sidecar lives under `server/tts-sidecar/`, same scope) — **medium** effort. Run:

```
/code-review medium
```

(without `--fix`). Triage findings by hand per the skill's rules: clear-cut correctness bugs get fixed, committed, and pushed (re-triggering a review pass); cleanup-only findings can be fixed without a mandatory re-review; genuinely ambiguous findings route through a judgment call with the user rather than being auto-resolved.

- [ ] **Step 9: Confirm mergeable state**

Once `npm run verify` is green, the PR is open with a linked issue, and the code-review pass has come back clean (or its findings are resolved), the branch is in mergeable state. Report the PR URL and a one-paragraph summary back to the user — do not merge without their go-ahead.

---

## Self-Review Notes (writing-plans skill)

- **Spec coverage:** Fix 1 (`engineDeviceIsGpu` ground-truth-first) → Task 3. Fix 2 (skip-acquire on `sidecar.ts`'s two call sites) → Task 4. The `qwen-voice.ts` third call site the re-review caught → Task 5. Fix 3 (Coqui MPS) → Task 6. The new shared cache + its wiring → Tasks 1-2. Ship notes / docs / PR → Task 7. All spec sections are covered.
- **Placeholder scan:** none found — every step has complete, runnable code.
- **Type consistency:** `EngineDeviceFamily`, `getLastKnownEngineDevice(engine: string)`, `setLastKnownEngineDevices(devices: SidecarDeviceMap | null | undefined)`, and `engineDeviceIsGpu(engine: string): boolean` are used identically across Tasks 1, 2, 3, 4, and 5 — verified no drift in name or signature between the task that defines each and the tasks that consume it.
