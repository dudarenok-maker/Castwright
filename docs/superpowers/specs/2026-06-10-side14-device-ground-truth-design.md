# side-14 — Device ground-truth: sidecar reports per-engine torch device incl. mps

**Issue:** side-14 (#707) — the deep half of the fs-43 "Will it run on my machine?" panel,
split out by the 10 June critical review.
**Scopes:** `side` + `server` + `frontend` (one PR, multi-scope commits).
**Date:** 2026-06-10.

## Problem

`/health` reports `device` only when Coqui is loaded, resolves cuda/cpu only (never mps),
and Kokoro/Qwen report nothing:

- `server/tts-sidecar/main.py:2536` — `device = coqui._resolved_device if model_loaded else None`
- `server/tts-sidecar/main.py:914-929` — Qwen's `_resolve_torch_device` computes mps but never surfaces it
- Kokoro (the default eager engine, onnxruntime) reports no device at all

So the fs-43 panel can only say "host is *capable* of X" and hedges with "Load a voice to
confirm which device is in use". An Apple Silicon user silently running CPU never finds out.

## Decisions (user-approved 2026-06-10)

1. **Per-engine device map** on `/health` — not a single `active_device`. The sidecar has no
   single active engine (Kokoro eager, Qwen default-when-installed at the Node level, Coqui
   on demand), and engines genuinely resolve differently (Kokoro can be CPU while Qwen is mps
   on the same Mac).
2. **Background torch probe at startup** — ground truth regardless of load state, accepting
   torch's ~300–500 MB committed footprint at boot (paid anyway the moment Qwen loads).
3. **Panel shows headline + per-engine rows** — "Currently running on: X" for the active
   engine, plus a compact per-engine line.

## Design

### 1. Sidecar — startup device probe (`server/tts-sidecar/main.py`)

A background probe launched from startup alongside `_preload_default_engines` (its own
`asyncio.to_thread` task / daemon thread — never blocks boot; `/health` keeps responding
instantly):

- Imports `torch` (and `onnxruntime`) inside the probe, then computes per-engine predictions
  using **each engine's own resolver** so prediction cannot drift from load-time reality:
  - **qwen** — `_resolve_torch_device(qwen._device_pref, torch)` (the existing module-level
    resolver, `main.py:914`; auto → cuda:0 → mps → cpu). Report normalised to the device
    *family*: `cuda:0`/`cuda:1` → `cuda`.
  - **coqui** — `coqui._resolve_runtime_options(torch)["device"]` (cuda/cpu).
    **Non-goal:** teaching Coqui mps — XTTS-on-Metal is unvalidated; we report the truth
    that it would run CPU on a Mac.
  - **kokoro** — onnxruntime, not torch: predicted from `onnxruntime.get_available_providers()`
    mirroring kokoro-onnx's auto-selection (`CUDAExecutionProvider` present → `cuda`,
    else `cpu`).
- Cached in module state: `_device_probe: dict[str, str | None]` +
  `_device_probe_state: 'pending' | 'ready' | 'error'`.
- **Failure tolerance:** every step wrapped in try/except; torch import failure →
  `'error'` plus whatever the onnxruntime probe could still determine; one log line either
  way; the probe can never crash or poison the process. `torch.cuda.is_available()` /
  `torch.backends.mps.is_available()` do not create a CUDA context or allocate VRAM —
  the probe must not call anything heavier (no `torch.cuda.init()`, no tensor allocation).
- **Loaded engines override predictions** — `/health` composes the map at read time:
  - Coqui loaded (`_tts is not None`) → `_resolved_device`. (Gate on loadedness: `unload()`
    resets `_resolved_device` to `"cpu"`, which must not masquerade as ground truth.)
  - Qwen Base loaded → `qwen._device` (set by the existing shared resolve step,
    `main.py:1169`).
  - Kokoro loaded → real session providers via `sess.get_providers()`, getattr/try-guarded
    (kokoro-onnx API drifts); fall back to the prediction on any drift.

#### `/health` contract additions

```json
{
  "devices": { "kokoro": "cuda", "coqui": "cuda", "qwen": "mps" },
  "devices_state": "pending" | "ready" | "error"
}
```

- Values are normalised families: `'cuda' | 'mps' | 'cpu' | null` (null while pending /
  unknowable).
- The legacy `device` field (Coqui-when-loaded, raw string) is untouched — back-compat with
  older Node builds.

### 2. Node passthrough (`server/src/routes/sidecar-health.ts`, `info.ts`)

- `SidecarHealthBody` / `SidecarHealthResult` gain `devices` / `devicesState`
  (camelCase on the result), forwarded with old-sidecar defaults (absent → `null` /
  `'pending'`-equivalent) — same pattern as every prior field.
- `/api/info` (`info.ts`): `fetchSidecarVersion` broadens to parse `devices` +
  `devices_state` off the same single `/health` fetch it already makes for `__version__`
  (no second probe; `probeSidecarHealth` isn't reused because it doesn't carry
  `__version__`). `/api/info` additionally reports
  `activeEngine: 'kokoro' | 'qwen' | 'coqui'` via the existing
  `engineForModelKey(getResolvedTtsModelKey())` (today in `models-inventory.ts:374`;
  export from a shared location rather than duplicating).
- Mixed-engine nuance: a book can render per-character on multiple engines; `activeEngine`
  is the resolved *default*. The panel copy is "Currently running on" for that default —
  the per-engine rows carry the full truth.

### 3. Frontend panel (`src/components/device-panel.tsx`)

- When `devicesState === 'ready'` and the active engine's device is known:
  - Headline: **"Currently running on: NVIDIA GPU (CUDA) / Apple GPU (Metal) / CPU"**
    (label map: `cuda` → "NVIDIA GPU (CUDA)", `mps` → "Apple GPU (Metal)", `cpu` → "CPU"),
    replacing the "Load a voice to confirm…" hedge.
  - Compact per-engine rows below: e.g. `Kokoro · CPU`, `Qwen · Metal`, `Coqui · CPU` —
    only engines present in the map.
- Sidecar down / probe pending / old sidecar → panel renders exactly today's capability
  copy (graceful degradation, no spinner, no layout shift).
- `AppInfo` type in `src/lib/types.ts` extended; the mock `getAppInfo` payload gains
  `devices` + `activeEngine` so mock-mode (and e2e) exercises the full panel.

### 4. Error-string audit (sidecar)

Sweep GPU-not-detected / install-hint strings for NVIDIA-only phrasing. Known candidates:
the torch install hints (`whl/cpu` index suggestions, `main.py:527/535`), the
`onnxruntime-gpu` install hint (`main.py:765`), the `COQUI_DEVICE=cuda` log hint
(`main.py:550`). The NVIDIA sysmem-fallback diagnostics (`main.py:2308/2320`) are
Windows-specific and accurate — leave them. Expected outcome: 1–2 rewordings; the macOS
launch PR (2026-06-10) already fixed the worst case.

## Edge cases & concurrency

- **Probe vs. engine load racing on torch import** — Python's import lock serialises;
  both get the same module. No coordination needed.
- **`/health` during probe** — `devices_state: 'pending'`, `devices` values null; Node
  forwards; panel degrades. Order-independence: Kokoro's eager preload (~1 s) may finish
  before or after the probe; composition happens at `/health` read time.
- **Unload after load** — prediction takes back over (override gates on loadedness).
- **Sidecar recycle/respawn** — probe re-runs per process; no persistence.
- **Old sidecar + new Node** — fields absent → safe defaults → today's panel.
  **New sidecar + old Node** — extra fields ignored. No protocol-version bump needed
  (additive fields only).
- **Explicit device pins** (`QWEN_DEVICE=cuda:1`, `COQUI_DEVICE=cuda`) — resolver returns
  them unchanged; report normalises to family.

## Testing

- **pytest** (`server/tts-sidecar/tests/`): resolver matrix with injected torch stubs
  (cuda / mps / neither / explicit pin — probe function takes injectable modules, same
  pattern as `_resolve_runtime_options`); `/health` shape across pending → ready → error;
  loaded-engine override beats prediction (and unload reverts it); Kokoro provider mapping
  incl. API-drift fallback; torch-import-failure path leaves the process alive and
  `devices_state: 'error'`.
- **server Vitest**: passthrough forwards `devices`/`devicesState`; old-sidecar body →
  safe defaults; `/api/info` carries `activeEngine` + devices off one fetch.
- **frontend Vitest** (`device-panel.test.tsx`): pending, cuda headline, mps headline +
  per-engine rows, sidecar-down fallback.
- **e2e**: extend `e2e/about-page.spec.ts` to assert the upgraded panel text against the
  mock payload (UI-visible change crossing the api seam). `/about` is not in the visual
  snapshot set — no baseline churn.

## Non-goals

- Changing device *selection* for any engine (Coqui stays cuda/cpu; no mps synth
  enablement anywhere).
- Live re-probing (device availability cannot change mid-process).
- Companion-app surface.
- "GPU present but CPU-build torch" mismatch hint (worthwhile follow-up; file if wanted).

## Delivery

One branch `feat/side-device-ground-truth` off `main`, implemented in an isolated worktree;
plan doc under `docs/features/` (issue is tagged `needs-plan`); draft PR with
`Closes #707`; this spec committed on the same branch. Memory-baseline shift from the
torch import called out in the PR body so it doesn't read as a leak.
