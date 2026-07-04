---
status: draft
---

# GPU semaphore / eviction guard: device-aware VRAM cost — design

> Date: 2026-07-05
> Key files: `server/src/gpu/engine-device-state.ts` (new), `server/src/gpu/engine-device.ts`,
> `server/src/gpu/vram-state.ts`, `server/src/tts/engine-vram-cost.ts`, `server/src/tts/sidecar.ts`,
> `server/src/routes/qwen-voice.ts` (VoiceDesign's own semaphore acquire, line 328/467),
> `server/src/routes/sidecar-health.ts`, `server/tts-sidecar/main.py` (`CoquiEngine._resolve_runtime_options`)
> Related: plan [108](../../features/108-qwen-coexistence.md) (Qwen/Coqui coexistence, the VRAM-weighted
> semaphore), plan [204](../../features/204-side14-device-ground-truth.md) (side-14, the per-engine
> `devices` map this design consumes), `docs/features/236-multi-gpu-per-model-safety.md`

## Benefit / Rationale

- **User:** on an Apple Silicon Mac or a CPU-only install (both officially supported platforms —
  `docs/wiki/Installing-Castwright.md`), Qwen + Coqui (or any TTS-engine combination) stop
  serializing against a "VRAM budget" that was never calibrated for unified memory or system RAM.
  Multi-engine generation actually runs concurrently where the hardware has the most headroom to
  offer it, instead of the least.
- **Technical:** closes an inconsistency where the analyzer, ASR, and speaker-embed paths already
  learned to skip GPU-semaphore charges when not actually running on GPU (the "W2.6 don't
  cross-charge" convention), but the three original TTS engines (Kokoro/Qwen/Coqui) never got the
  same treatment. The fix reuses ground-truth data (`side-14`'s per-engine `devices` map) that
  already flows through every sidecar health poll but was never cached for server-side logic to
  read synchronously.
- **Architectural:** establishes one shared "what device is this engine actually on" cache that
  both the concurrency system (the VRAM-weighted semaphore) and the pre-load eviction guard
  consult, instead of two independent, differently-precise answers to the same question.

## Context — how the gap was found

Investigating whether the VRAM-weighted GPU semaphore (`server/src/gpu/semaphore.ts` +
`server/src/tts/engine-vram-cost.ts`, added in plan 108 for Qwen/Coqui coexistence) could
misbehave on CPU-only or Apple Silicon boxes turned up three findings, none of them a crash risk —
the sidecar's actual OOM/VRAM-ceiling watchdog is already properly device-gated and self-disables
on non-CUDA hardware. The gap is in the **concurrency-arbitration** layer:

1. `costForEngine('kokoro'|'qwen'|'coqui')` (`engine-vram-cost.ts:44-67`) always returns the
   engine's static configured weight (kokoro 1, qwen 1, coqui 3) with no check of the engine's
   actual runtime device. `sidecar.ts:118` and `:194` acquire the semaphore with this cost on
   every single synth call, unconditionally. Contrast: the `analyzer` case (added in the same
   file, W2.6) charges `0` when `getLastKnownAnalyzerDevice() === 'cpu'`; `asr`/`spk`
   (`transcribe-client.ts`, `embed-client.ts`) only acquire a token at all when their engine is
   confirmed running on GPU. Kokoro/Qwen/Coqui — the original three engines from plan 108 — never
   received this same treatment.
2. The ground truth to fix (1) already exists: `side-14` (plan 204) added a per-engine `devices`
   map (`{kokoro, coqui, qwen} → 'cuda'|'rocm'|'directml'|'mps'|'cpu'|null`) that the sidecar
   computes every `/health` response and that `sidecar-health.ts` already normalizes
   (`normaliseDevices`, line 137). It's forwarded to the frontend for the per-engine device pill,
   but — unlike `vram_total_mb` or the Qwen install-state — it is never cached into a
   synchronously-readable Node-side singleton, so nothing in the cost/eviction logic can consult it.
3. `engineDeviceIsGpu` (`engine-device.ts:19-24`), which feeds the separate pre-load
   eviction guard (`residency.ts`/`gpu-load.ts` — "should we evict the resident analyzer before
   loading this sidecar model"), only looks at the *configured* device knob and treats the
   default `'auto'` as "assume GPU". On Apple Silicon, where the installer explicitly tells users
   no config is needed (the sidecar auto-resolves to `mps` on its own), the knob is left at
   `auto` — so this guard still assumes GPU contention and evicts the analyzer needlessly.

A smaller, unrelated finding in the same sweep: Coqui's own `auto` device resolution
(`main.py:737-738`, `device = "cuda" if torch_module.cuda.is_available() else "cpu"`) has no MPS
branch, unlike Qwen's `_resolve_torch_device` (`main.py:1497-1512`), which already implements the
correct `cuda:0 → mps → cpu` chain as a standalone, engine-agnostic helper. Coqui silently runs on
CPU on every Apple Silicon box today even though MPS is available and already exercised by Qwen.

## Design

### New shared cache: `server/src/gpu/engine-device-state.ts`

Structurally identical to the existing `analyzer-device-state.ts`:

```ts
export type EngineDeviceFamily = 'cuda' | 'rocm' | 'directml' | 'mps' | 'cpu' | 'unknown';

// last-known per engine; defaults to 'unknown' until the first reachable health poll
export function setLastKnownEngineDevices(devices: SidecarDeviceMap | null): void;
// accepts any string (matches costForEngine/engineDeviceIsGpu's existing convention) —
// an engine outside {kokoro, coqui, qwen} (e.g. 'gemini') always reads back 'unknown'
export function getLastKnownEngineDevice(engine: string): EngineDeviceFamily;
```

`setLastKnownEngineDevices(null)` (an old sidecar with no `devices` field, or a body that fails
`normaliseDevices`) resets every engine to `'unknown'` — never silently invents a device family.
An **unreachable** poll is a no-op (mirrors `setLastKnownVram`'s existing rule) — a transient
health-check timeout mid-render must not change what a concurrent synth call gets charged.

### Wiring: `sidecar-health.ts`

`probeSidecarHealth()` currently computes `normaliseDevices(body.devices)` inline, once, inside the
returned response object (line 297) — a different spot from the existing `setLastKnownVram(...)`
call (line 263). Hoist `normaliseDevices(body.devices)` into a local `const` above line 263, call
`setLastKnownEngineDevices(...)` with it there (next to `setLastKnownVram`), and reuse the same
local in the return object at line 297 instead of recomputing it — one normalization, two
consumers, both updated from the same reachable poll.

### Fix 1 (was Fix 2) — `engineDeviceIsGpu` ground-truth-first

Presented first because Fix 2 below depends on it. Ground truth first, config knob as fallback:

```ts
export function engineDeviceIsGpu(engine: string): boolean {
  const known = getLastKnownEngineDevice(engine);
  if (known !== 'unknown') return known === 'cuda' || known === 'rocm' || known === 'directml';
  // fall back to today's config-knob heuristic when never probed
  const key = ENGINE_DEVICE_KEY[engine];
  if (!key) return true;
  const raw = (configValue<string>(key) ?? 'auto').trim().toLowerCase();
  return raw === 'auto' || raw.startsWith('cuda');
}
```

This directly fixes the pre-load **eviction guard**: every existing call site
(`ensure-sidecar-loaded.ts:155`, `persona-gpu-plan.ts:61`, `qwen-voice.ts:469`) already threads
`engineDeviceIsGpu(engine)` into `withGpuLoad`/`shouldEvictBeforeSidecarLoad` as the `engineOnGpu`
param, so this one change is sufficient there — no edits needed in `residency.ts` or `gpu-load.ts`
themselves.

An engine not in `ENGINE_DEVICE_KEY` (e.g. `'gemini'`, a cloud engine) also isn't in
`SidecarDeviceMap`, so `getLastKnownEngineDevice` returns `'unknown'` for it and behavior falls
straight through to today's `!key → true` conservative default — unchanged.

### Fix 2 (was Fix 1, corrected) — skip the semaphore acquire, not a `0` cost

**This revises the original design after an adversarial review caught it as an inert no-op.**
`GpuSemaphore.acquire()` runs every cost through `clampCost` (`semaphore.ts:71-76`), which floors
anything `< 1` back up to `1`:

```ts
private clampCost(cost: number): number {
  const c = Math.floor(cost);
  if (!Number.isFinite(c) || c < 1) return 1;
  ...
}
```

So a `costForEngine` that returns `0` for `kokoro`/`qwen`/`coqui` on cpu/mps would still consume a
full token once passed through `acquire()` — **the original Fix 1 changed nothing at runtime.**
The codebase's real "don't cross-charge" convention is a **call-site skip**, not a zeroed cost:
`ollama.ts:733` (`const release = onCpu ? null : await gpuSemaphore.acquire(...)`) and
`transcribe-client.ts:77` (`asrRunsOnGpu() ? await ...acquire(...) : null`) bypass `acquire()`
entirely rather than passing it a zero. `costForEngine` itself is **unchanged** by this design —
it keeps returning the static configured weight for kokoro/qwen/coqui exactly as today.

The fix gates **three** acquire call sites — every runtime consumer of
`costForEngine('kokoro'|'qwen'|'coqui')` — behind `engineDeviceIsGpu(engine)` (Fix 1 above),
mirroring the existing analyzer/ASR/spk pattern:

- `server/src/tts/sidecar.ts` `synthesize()` (line 118) and `synthesizeBatch()` (line 194):

  ```ts
  const onGpu = engineDeviceIsGpu(this.engine);
  const releaseGpu = onGpu ? await this.gpuSem.acquire(costForEngine(this.engine)) : null;
  try {
    /* ... unchanged ... */
  } finally {
    releaseGpu?.();
  }
  ```

- `server/src/routes/qwen-voice.ts` (Qwen VoiceDesign, line 328/467) — an initial pass of this
  design missed this third site; an adversarial review caught it. This function already computes
  `engineDeviceIsGpu('qwen')` two lines below (line 469, passed to `withGpuLoad` for the eviction
  guard) but never reused it for its own `gpuSemaphore.acquire(costForEngine('qwen'))` at line 328.
  The fix hoists that computation once and reuses it for both:

  ```ts
  const onGpu = engineDeviceIsGpu('qwen'); // computed once, reused below
  return withGpuLoad(async () => {
    const releaseGpu = onGpu ? await gpuSemaphore.acquire(costForEngine('qwen')) : null;
    // ...
    try {
      // ...
    } finally {
      releaseGpu?.();
    }
  }, onGpu); // was: engineDeviceIsGpu('qwen') recomputed inline
  ```

  The VoiceDesign model itself has no separate entry in the per-engine `devices` map (only Base's
  device is reported under the `qwen` key) — but Base and VoiceDesign always run on the same
  process-wide resolved torch device (there is one `QWEN_DEVICE` resolution per sidecar process),
  so proxying the design call's device through `engineDeviceIsGpu('qwen')` is accurate, not an
  approximation of a genuinely different value.

`engineOnGpu === false` at any of these three sites means that call never enters the semaphore's
FIFO at all — it can neither be blocked by, nor block, another engine's acquire.

**What actually backstops CPU/MPS memory pressure once this token is gone.** This is not "no risk"
— MPS is unified memory, a real finite shared pool, not a discrete VRAM pool with nothing to
protect. Removing the semaphore token here does not add a new gap; it matches the tradeoff the
codebase **already accepts** for the analyzer's CPU path and ASR/spk's CPU-default paths: the
sidecar's own committed-host-RAM watchdog (`main.py`'s soft/hard recycle ceilings, cross-platform
via `psutil`, already running today) is the actual backstop for CPU/unified-memory pressure, not
the Node-side VRAM semaphore. This design shifts kokoro/qwen/coqui onto the same, already-relied-on
backstop that analyzer/asr/spk use today — it does not invent a new one, and it does not add
*proactive* per-op throttling for unified memory (that would require a system-RAM-shaped budget
model, explicitly out of scope below). The per-engine synth semaphore
(`engineSynthSem`, `sidecar.ts:37-46`, cap 1) still serializes same-engine calls regardless of
device; only *cross-engine* concurrency (e.g. Qwen + Coqui at once) loses its token-based ceiling
on cpu/mps.

### Fix 3 — Coqui `auto` → MPS (Python sidecar)

`CoquiEngine._resolve_runtime_options` (`main.py:737-738`) replaces its inline
`"cuda" if torch_module.cuda.is_available() else "cpu"` with a call to the existing
`_resolve_torch_device(self._device, torch_module)` (already used by Qwen, already handles
`cuda:0 → mps → cpu`, already guards `torch.backends.mps` with `getattr` so it's a no-op on a
torch build without MPS support). Downstream code in the same method already treats any non-`cuda`
family correctly (`_parse_device(device)[0] == "cuda"` gates fp16/deepspeed and `_use_half`), so no
other Python change is needed to make `tts.to("mps")` reachable.

**Caveat this design does NOT resolve statically:** confirming the device string resolves to
`"mps"` and confirming XTTS v2 *inference* actually produces correct audio on the MPS backend are
different claims. XTTS has a documented history of unimplemented MPS ops in some `torch`/`TTS`
version combinations. This fix is therefore gated on a **required manual acceptance step on real
Apple Silicon hardware** (see Testing) before it ships — mirroring how this codebase already gates
other engine-device changes (e.g. plan 108's Qwen3 wave shipped only after "ran the real model
end-to-end" on real hardware). `COQUI_DEVICE=cpu` remains available as an explicit override, so if
MPS inference proves broken in practice, an operator (or this fix's own rollout) can pin back to
CPU without reverting the code change.

## Data flow

1. Sidecar `/health` reports the per-engine `devices` map (already computed server-side in
   `main.py`, unchanged by this design).
2. `probeSidecarHealth()` normalizes it (existing `normaliseDevices`) and now also caches it via
   `setLastKnownEngineDevices`.
3. Every runtime consumer of `costForEngine('kokoro'|'qwen'|'coqui')` — the two `sidecar.ts` synth
   sites and `qwen-voice.ts`'s VoiceDesign acquire — calls `engineDeviceIsGpu(engine)` first to
   decide whether to enter the semaphore at all; `costForEngine(engine)` is only consulted (and
   only ever returns its unchanged static weight) when it does. No new network calls, no added
   latency on the hot synth path.
4. The semaphore admits/evicts based on the actual per-platform reality instead of a fixed,
   NVIDIA-8GB-shaped assumption.

**Cache-population timing — corrected.** The cache is *not* guaranteed warm before every
generation call. In normal interactive use, the Generate screen's existing 30s health poll (the
same `probeSidecarHealth()` function, via `sidecarHealthRouter`) has almost always populated the
cache well before the user clicks Generate — no change needed there. But the generation hot path's
*own* per-chapter check, `getSidecarRecyclePending()` (`generation.ts:179-192`), is a bare `fetch`
that reads only `recycle_pending` and never calls `probeSidecarHealth()` — it does not feed this
cache. The only call on the generation path that does is the **post-chapter, fire-and-forget**
telemetry probe (`generation.ts` ~line 1677, `void (async () => { ... probeSidecarHealth() ...
})()`). So a fully headless/API-driven render, with no frontend ever polling `/api/sidecar/health`,
sees an `'unknown'` cache for chapter 1 — which fails safe to today's exact behavior (charged in
full, evicted conservatively), not a correctness bug, but a real latency characteristic worth
documenting rather than asserting away.

## Error handling / edge cases

- **Before the first health poll** (e.g. a headless render's first chapter, per the timing note
  above): cache is `'unknown'` for every engine → today's behavior, unchanged, no regression.
- **Old sidecar** (pre-side-14, omits `devices`): `normaliseDevices(undefined)` → `null` →
  `setLastKnownEngineDevices(null)` resets to `'unknown'` for all three engines → byte-identical to
  today.
- **Sidecar temporarily unreachable mid-session**: cache keeps its last reachable reading (mirrors
  `vram-state.ts`), so a transient blip doesn't change costing for an in-flight render.
- **Device changes mid-session** (e.g. an accelerator-profile switch + sidecar restart): the cache
  catches up on the next reachable poll (≤30s) — the same staleness window every other
  last-known-state cache in this codebase already accepts.

## Testing

- New `server/src/gpu/engine-device-state.test.ts` (mirrors `analyzer-device-state.test.ts`):
  defaults to `'unknown'` for all three engines; `setLastKnownEngineDevices` sets/reads per engine;
  `null` resets to `'unknown'`; `undefined` (unreachable poll) is a no-op that preserves prior state.
- Extend `server/src/gpu/engine-device.test.ts`: ground truth `mps`/`cpu` → `false` regardless of
  the configured knob; ground truth `cuda`/`rocm`/`directml` → `true` regardless of the knob;
  `unknown` → falls back to today's existing knob-based test cases unchanged.
- **`sidecar.test.ts` (new/extended) — the test that actually catches the original defect.**
  Mock `engineDeviceIsGpu` to return `false` for an engine and assert `this.gpuSem.acquire` is
  **never called** for that engine's `synthesize`/`synthesizeBatch` (mirrors the existing pattern
  in `embed-client.test.ts` for `spk`). A test that only checks a return value from
  `costForEngine` would NOT catch a regression here — the value must be observed at the semaphore
  call site, not the cost function.
- Extend `server/src/routes/qwen-voice.test.ts`: with `engineDeviceIsGpu('qwen')` mocked `false`,
  `gpuSemaphore.acquire` is never called for the design path either, and `withGpuLoad` still
  receives the same (now hoisted, single) boolean it does today — this is the third call site an
  earlier pass of this design missed.
- New/extended semaphore-level test: acquire against a **real** `GpuSemaphore` instance for an
  off-GPU engine and assert `usedTokens`/`inFlight` are unaffected by that acquire — verifies the
  actual token accounting, not just an intermediate return value.
- Extend `server/src/routes/sidecar-health.test.ts`: a reachable poll with a `devices` body
  populates the new cache (assert via the exported getter or a mocked setter); an unreachable poll
  leaves it untouched.
- Extend `server/tts-sidecar/tests/test_coqui_device.py`: `COQUI_DEVICE=auto` (or unset) +
  `torch.cuda.is_available() == False` + a stubbed `torch.backends.mps.is_available() == True` →
  resolves to `"mps"`, mirroring whatever `test_qwen_device.py` already asserts for Qwen's
  equivalent case.
- **Required manual acceptance (Fix 3, before shipping):** on real Apple Silicon hardware, run a
  Coqui XTTS v2 synth with `COQUI_DEVICE` unset (`auto`) and confirm it resolves to `mps` in the
  sidecar log AND produces correct, non-garbled audio — not just that `.to("mps")` doesn't throw.
  If inference is broken or degraded, document the failure and ship Fix 3 gated behind an explicit
  opt-in (or hold it) rather than flipping the default.

## Reversibility

Every change is additive and defaults to today's exact behavior whenever the new cache is
`'unknown'` (no health poll yet, or an old sidecar). Nothing here changes `ENGINE_VRAM_COST` values,
`DEFAULT_GPU_VRAM_BUDGET`, `costForEngine`'s return values, or any existing config knob — a box
that never triggers the `cpu`/`mps` branches (i.e. every existing NVIDIA install once at least one
health poll has landed) sees byte-identical costing and eviction decisions to before this change.
Fix 3 additionally keeps `COQUI_DEVICE=cpu` as a live, explicit rollback if MPS inference proves
broken in practice.

## Out of scope

- Re-tuning `ENGINE_VRAM_COST` weights themselves (tracked separately, BACKLOG #39).
- A unified-memory- or system-RAM-aware budget model (e.g. sizing a proactive throttle for Apple
  Silicon/CPU installs based on system RAM rather than VRAM) — this design stops
  *mischarging* CPU/MPS ops against a GPU-shaped VRAM budget by removing them from that budget
  entirely; it does not introduce a replacement proactive-throttle concept for those platforms.
  The existing host-RAM watchdog remains the only backstop there, same as it already is for the
  analyzer/asr/spk CPU paths today.
- Proactively warming the new device cache ahead of a headless/API-only render's first chapter
  (e.g. an explicit `probeSidecarHealth()` call at generation start) — the cache-timing section
  above documents the gap; closing it is a separate, small follow-up if it proves to matter in
  practice, not required for this design to be correct (it fails safe).
- AMD ROCm/DirectML-specific tuning — those families are charged exactly like CUDA today (real
  discrete/managed VRAM), unchanged by this design.

## Ship notes

_Not yet shipped._
