---
status: draft
---

# GPU semaphore / eviction guard: device-aware VRAM cost — design

> Date: 2026-07-05
> Key files: `server/src/gpu/engine-device-state.ts` (new), `server/src/gpu/engine-device.ts`,
> `server/src/gpu/vram-state.ts`, `server/src/tts/engine-vram-cost.ts`, `server/src/tts/sidecar.ts`,
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

`probeSidecarHealth()` already computes `normaliseDevices(body.devices)` once (line 297) for the
API response. Reuse that same value in a new call to `setLastKnownEngineDevices(...)` right next
to the existing `setLastKnownVram(...)` call, so both caches update from the same reachable poll
in the same place.

### Fix 1 — `costForEngine` (concurrency)

For `kokoro`/`qwen`/`coqui`, consult `getLastKnownEngineDevice(engine)` before returning the
configured weight:

- `'cpu'` or `'mps'` → **0**. No discrete VRAM pool to protect; charging a token here only forces
  needless serialization against other engines/the analyzer.
- `'cuda'` / `'rocm'` / `'directml'` → the configured weight, unchanged.
- `'unknown'` (never polled, sidecar unreachable at boot, or an old sidecar without the side-14
  field) → the configured weight, unchanged. Matches the analyzer's existing "unknown stays
  charged" convention — conservative by default, never silently disables protection nobody asked
  to turn off.

This is a pure addition inside the existing `switch` in `costForEngine` — no signature change, no
caller changes (`sidecar.ts` keeps calling `costForEngine(this.engine)` exactly as today).

### Fix 2 — `engineDeviceIsGpu` (pre-load eviction guard)

Ground truth first, config knob as fallback:

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

Because every call site (`ensure-sidecar-loaded.ts:155`, `persona-gpu-plan.ts:61`,
`qwen-voice.ts:469`) already threads `engineDeviceIsGpu(engine)` into `withGpuLoad`/
`shouldEvictBeforeSidecarLoad` as the `engineOnGpu` param, this one change is sufficient — no
edits needed in `residency.ts` or `gpu-load.ts` themselves.

An engine not in `ENGINE_DEVICE_KEY` (e.g. `'gemini'`, a cloud engine) also isn't in
`SidecarDeviceMap`, so `getLastKnownEngineDevice` returns `'unknown'` for it and behavior falls
straight through to today's `!key → true` conservative default — unchanged.

### Fix 3 — Coqui `auto` → MPS (Python sidecar)

`CoquiEngine._resolve_runtime_options` (`main.py:737-738`) replaces its inline
`"cuda" if torch_module.cuda.is_available() else "cpu"` with a call to the existing
`_resolve_torch_device(self._device, torch_module)` (already used by Qwen, already handles
`cuda:0 → mps → cpu`, already guards `torch.backends.mps` with `getattr` so it's a no-op on a
torch build without MPS support). Downstream code in the same method already treats any non-`cuda`
family correctly (`_parse_device(device)[0] == "cuda"` gates fp16/deepspeed and `_use_half`), so no
other change is needed — `tts.to("mps")` is a valid call today, it just never gets reached.

## Data flow

1. Sidecar `/health` reports the per-engine `devices` map (already computed server-side in
   `main.py`, unchanged by this design).
2. `probeSidecarHealth()` normalizes it (existing `normaliseDevices`) and now also caches it via
   `setLastKnownEngineDevices`.
3. Any TTS synth or design call → `costForEngine(engine)` / `engineDeviceIsGpu(engine)` reads the
   cache synchronously — no new network calls, no added latency on the hot synth path.
4. The semaphore admits/evicts based on the actual per-platform reality instead of a fixed,
   NVIDIA-8GB-shaped assumption.

## Error handling / edge cases

- **Before the first health poll** (e.g. a synth call races ahead of the 30s poll cadence at cold
  start): cache is `'unknown'` for every engine → today's behavior, unchanged, no regression.
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
- Extend `server/src/tts/engine-vram-cost.test.ts`: kokoro/qwen/coqui charge `0` when the cached
  device is `cpu` or `mps`; charge the configured weight when `cuda`/`rocm`/`directml`; charge the
  configured weight when `unknown`.
- Extend `server/src/gpu/engine-device.test.ts`: ground truth `mps`/`cpu` → `false` regardless of
  the configured knob; ground truth `cuda`/`rocm`/`directml` → `true` regardless of the knob;
  `unknown` → falls back to today's existing knob-based test cases unchanged.
- Extend `server/src/routes/sidecar-health.test.ts`: a reachable poll with a `devices` body
  populates the new cache (assert via the exported getter or a mocked setter); an unreachable poll
  leaves it untouched.
- Extend `server/tts-sidecar/tests/test_coqui_device.py`: `COQUI_DEVICE=auto` (or unset) +
  `torch.cuda.is_available() == False` + a stubbed `torch.backends.mps.is_available() == True` →
  resolves to `"mps"`, mirroring whatever `test_qwen_device.py` already asserts for Qwen's
  equivalent case.

## Reversibility

Every change is additive and defaults to today's exact behavior whenever the new cache is
`'unknown'` (no health poll yet, or an old sidecar). Nothing here changes `ENGINE_VRAM_COST` values,
`DEFAULT_GPU_VRAM_BUDGET`, or any existing config knob — a box that never triggers the `cpu`/`mps`
branches (i.e. every existing NVIDIA install once at least one health poll has landed) sees
byte-identical costing and eviction decisions to before this change.

## Out of scope

- Re-tuning `ENGINE_VRAM_COST` weights themselves (tracked separately, BACKLOG #39).
- A unified-memory- or system-RAM-aware budget model (e.g. sizing `GPU_VRAM_BUDGET` differently
  for Apple Silicon/CPU installs) — this design only stops *mischarging* CPU/MPS ops against a
  GPU-shaped budget; it doesn't introduce a new budget concept for those platforms.
- AMD ROCm/DirectML-specific tuning — those families are charged exactly like CUDA today (real
  discrete/managed VRAM), unchanged by this design.

## Ship notes

_Not yet shipped._
