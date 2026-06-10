---
status: active
shipped: null
owner: null
---

# Sidecar device ground-truth (side-14)

> Status: active
> Key files: `server/tts-sidecar/main.py` (`_run_device_probe`, startup hook), `server/src/routes/sidecar-health.ts`, `server/src/routes/info.ts`, `src/components/device-panel.tsx`
> URL surface: `#/models` (Model Manager, device panel)
> OpenAPI ops: none (GET `/api/info` is hand-typed `AppInfo`)
> Issues: side-14 (#707)

## Benefit / Rationale

- **User:** the "Will it run on my machine?" device panel at `#/models` stops hedging ("Load a voice to confirm") and instead shows the real compute device for every engine at startup — including Metal on Apple Silicon. A new headline line ("Currently running on: NVIDIA GPU (CUDA) / Apple GPU (Metal) / CPU") makes the active-engine device unambiguous.
- **Technical:** `/health` gains a `devices: {kokoro, coqui, qwen}` object and a `devices_state: 'pending'|'ready'|'error'` gate, giving Node and the frontend a machine-readable device map without polling a loaded model. A non-blocking background probe prevents torch-import latency (~300–500 MB RAM committed, torch import) from delaying sidecar startup or the first synthesis.
- **Architectural:** each engine's OWN resolver drives its prediction (no cross-engine knowledge leakage); loaded-engine actuals override predictions, but only while the engine is loaded — so an unload reverts to prediction, never masquerades as a live reading. The legacy `/health` `device` field is preserved byte-identical.

## Architectural impact

- **New seams:** `_run_device_probe` (asyncio.to_thread from the FastAPI `startup` event); `_probe_cache: dict` per-engine predictions; `devices` + `devices_state` on the `/health` response; `AppInfo.devices` / `AppInfo.devicesState` / `AppInfo.activeEngine` on `GET /api/info`; `sidecar-health.ts` normalises + forwards the new fields; `info.ts` adds `activeEngine = engineForModelKey(getResolvedTtsModelKey())`.
- **Invariants preserved:** legacy `device` field on `/health` untouched; discriminated-union `ui.stage` untouched; OpenAPI type-source rule — `AppInfo` is hand-typed (no OpenAPI op), consistent with the pre-existing pattern.
- **Migration story:** additive JSON fields on `/health` and `GET /api/info`. Old-sidecar / new-Node and new-sidecar / old-Node both work: the frontend + Node fall back to the prior capability copy when the fields are absent.
- **Reversibility:** the probe is a background asyncio task; removing it leaves `/health` with the pre-existing `device` field only. The DevicePanel is a standalone component with graceful degradation — deleting it or disabling it leaves Model Manager unchanged.

## Invariants to preserve

- `_run_device_probe` in `server/tts-sidecar/main.py` MUST NOT raise / poison the sidecar — any exception is caught and sets `devices_state` to `'error'` on the wire; torch-missing is the canonical error path.
- `devices_state` on `/health` is one of `'pending'` (probe not yet complete), `'ready'` (predictions cached), or `'error'` (probe raised) — the frontend keys its headline on `devicesState === 'ready'`.
- A loaded engine's ACTUAL device overrides the probe prediction ONLY while that engine is loaded (`state === 'ready'` or `state === 'streaming'`); unloading Coqui resets `_resolved_device` to `'cpu'` and that value must NOT appear in `devices` as a live reading — the composition logic in `/health` gates overrides on loadedness.
- A loaded Qwen engine whose internal device resolves to `'auto'` (pre-resolved) MUST NOT leak `'auto'` to the wire — it must fall back to the probe prediction.
- Kokoro's probe uses the onnxruntime session's `ExecutionProvider` list (`CUDAExecutionProvider` → `'cuda'`, else `'cpu'`); onnxruntime session API drift must degrade to the probe prediction, not raise.
- Per-engine probe failures (`junk` / unexpected value) must be `null`-normalised by `sidecar-health.ts` without poisoning sibling slots — pinned by `server/src/routes/sidecar-health.test.ts`.
- The DevicePanel headline renders ONLY when `devicesState === 'ready'` AND the active engine has a non-null `devices` entry; Gemini/piper (cloud engines with no sidecar device) show rows only — pinned by `src/components/device-panel.test.tsx`.
- Capability copy (the pre-ground-truth "Load a voice to confirm" text) is byte-identical when ground truth is absent — pinned by `src/components/device-panel.test.tsx`.
- Legacy `device` field on `/health` is byte-identical pre/post — pinned by `server/src/routes/sidecar-health.test.ts`.

## Test plan

### Automated coverage

- Pytest sidecar (`server/tts-sidecar/tests/test_device_probe.py`, 16 cases) — probes cuda/cpu/mps predictions for all three engines; `devices_state: 'error'` when torch import fails; probe never raises; CUDA present → `'cuda'`; onnxruntime drift degrades to prediction; Qwen `'auto'` never leaks; loaded-override gates on loadedness; Coqui unload reverts `_resolved_device` to `'cpu'` and the override does not appear as a live reading; Kokoro loaded with CUDA provider → `'cuda'` override wins.
- Vitest server (`server/src/routes/sidecar-health.test.ts`, +4 cases) — `devices` / `devicesState` forwarded from the sidecar; per-slot junk normalised to `null` without poisoning siblings; legacy `device` field unchanged; `devicesState: 'pending'` passed through.
- Vitest server (`server/src/routes/info.test.ts`, +2 cases) — `AppInfo.devices` / `devicesState` lifted off the single `/health` fetch; `activeEngine` = `engineForModelKey(getResolvedTtsModelKey())`.
- Vitest (`src/components/device-panel.test.tsx`, 7 cases) — headline renders when `devicesState === 'ready'` + active engine non-null; headline absent for Gemini/piper (cloud engines); per-engine rows (Kokoro / Coqui XTTS / Qwen3-TTS brand names); capability copy byte-identical when ground truth absent; `devicesState: 'pending'` shows loading state, not stale copy.
- Playwright e2e (`e2e/device-panel.spec.ts`) — navigates to `#/models` and asserts the DevicePanel renders without errors in mock mode (golden path through the Model Manager view).

### Manual acceptance walkthrough

1. **Start prod** (`start-prod.bat` / `npm start`) — wait for sidecar startup banner. Allow ~5–10 s for the background probe to complete (`devices_state` transitions from `pending` → `ready`).
2. **`GET /api/info`** (curl or browser) → confirm `devices.kokoro`, `devices.coqui`, `devices.qwen` all report `'cuda'` on this Windows/NVIDIA box; `devicesState === 'ready'`; `activeEngine` matches the resolved default engine.
3. **Cross-check against nvidia-smi** — all three `'cuda'` values should align with the GPU being visible; committed-memory baseline is ~300–500 MB higher than pre-probe (torch import, NOT a leak).
4. **Navigate to `#/models`** → device panel shows headline "Currently running on: NVIDIA GPU (CUDA)" (active engine is Qwen or Kokoro per config); three engine rows show Kokoro / Coqui XTTS / Qwen3-TTS with their respective devices.
5. **Apple Silicon box (separate acceptance)** → `devices.qwen === 'mps'`; `devices.kokoro === 'cpu'`; `devices.coqui === 'cpu'` (mps deliberately not enabled for Coqui); headline reads "Currently running on: Apple GPU (Metal)" when Qwen is the active engine.
6. **Unload Coqui** (if loaded) → `GET /api/info` confirms `devices.coqui` reverts to probe prediction (`'cpu'` on CPU-only build), not the loaded `'cuda'` override.

## Out of scope

- axe-core a11y gate for `#/models` (informational panel; deferred — see suggested follow-ups).
- "GPU present but CPU-build torch" mismatch hint — YAGNI, deliberately deferred.
- Companion-app brand audit — app-16 (#706).
- Full brand-in-app rollout — plan 203 (fe-37 #704).

## Ship notes

(Filled when status flips to `stable`.)
