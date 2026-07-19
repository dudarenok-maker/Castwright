# Op Capacity Admission Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Route every heavy GPU sidecar op (`/load`, `design_voice`, `mint_variant`, `/transcribe`, `/embed`) through the capacity-aware `PlacementController` admission — with multi-GPU load steering — and handle the resulting `noCapacity` 503 on the Node side, so `SEG_CAPACITY_ADMISSION` can safely default ON.

**Architecture:** Sidecar (Python): wrap each op in `PlacementController.reservation()`, plumb the admitted device into the engine load path, and honour operator device pins via a new `pinned` candidate constraint. Node (TS): extract the existing `postWithCapacityRetry` into a reusable `withCapacityRetry(doPost, opts)` free function (contract: retry `noCapacity` only, return every other response), flag-gate `withGpuLoad` to a lock-free passthrough when the flag is ON, and wire each op's Node caller through the helper.

**Tech Stack:** Python 3.12 + FastAPI (sidecar `server/tts-sidecar/main.py`), pytest; TypeScript + Node 20 (`server/src`), Vitest; `undici` fetch.

## Global Constraints

- **Flag:** everything behind `SEG_CAPACITY_ADMISSION` (env; `"1"` = on, default OFF). Sidecar reads it via `_capacity_admission_enabled()`; Node reads `process.env.SEG_CAPACITY_ADMISSION === '1'`. This PR does NOT change the default.
- **Flag-OFF parity is sacred:** every new sidecar param defaults to `None` (device) / `None` (`pinned`) and preserves today's env/enumeration behaviour byte-for-byte. Node with flag OFF: `withGpuLoad` unchanged, `withCapacityRetry` a transparent pass-through.
- **Footprints already seeded** (`SEED_FOOTPRINTS_MB`): `coqui:3584`, `kokoro:1200`, `qwen:6144`, `qwen.1.7b:7168`, `asr:400`, `spk:200`. Do NOT add or edit footprints.
- **Device forms:** `cuda:N` / `rocm:N` / `cpu` (what `PlacementController._device_key` emits).
- **Lock ordering:** admission's idle-evict uses the *threading* load locks (`_base_load_lock`/`_base17_load_lock`), never the asyncio `_load_lock`; the ledger lock releases before any forward/load. Do not hold the ledger lock across a load.
- **Commit convention:** `<type>(<scope>): <subject>` (e.g. `feat(server): …`). Sidecar-only diffs stay in scope `server`.
- Spec of record: `docs/superpowers/specs/2026-07-19-sidecar-op-capacity-admission-design.md`. Parent design: `docs/superpowers/specs/2026-07-18-vram-aware-gpu-placement-design.md`.

---

## File Structure

**Sidecar (Python):**
- `server/tts-sidecar/main.py` — all sidecar changes: `pinned` on `PlacementController.admit`/`reservation` + `_gpu_candidates`; `_engine_env_pin` helper; `device=` params on engine load methods; `design_voice`/`mint_variant` device plumbing; ASR/SPK attr-set; wrap the 5 handler families in `reservation()`.
- `server/tts-sidecar/tests/test_placement.py` — admission unit tests (`pinned`, device routing, cpu rule).
- `server/tts-sidecar/tests/test_synthesize.py` / new focused test modules per handler as needed.

**Node (TypeScript):**
- `server/src/gpu/capacity-retry.ts` — **new** — extracted `withCapacityRetry(doPost, opts)` + `parseNoCapacity` (moved) + `_capacityWaiters` counter + `getCapacityWaiterCount`.
- `server/src/tts/sidecar.ts` — `postWithCapacityRetry` becomes a thin wrapper over the helper; **re-export** `getCapacityWaiterCount` (so `routes/gpu-queue.ts` importer is untouched).
- `server/src/gpu/gpu-load.ts` — flag-gate `withGpuLoad` to a lock-free passthrough when the flag is ON.
- `server/src/routes/qwen-voice.ts` — wrap design + mint POSTs in `withCapacityRetry`.
- `server/src/routes/sidecar-health.ts` — wrap the `/api/sidecar/load` proxy POST in `withCapacityRetry`.
- `server/src/tts/transcribe-client.ts`, `server/src/tts/embed-client.ts` — wrap the fetch in `withCapacityRetry`.
- Colocated `*.test.ts` for each.

---

## Task 1 — Sidecar: `pinned` operator-pin constraint on admission

**Files:**
- Modify: `server/tts-sidecar/main.py` — `PlacementController._gpu_candidates`, `.admit`, `.reservation`; add module helper `_engine_env_pin`.
- Test: `server/tts-sidecar/tests/test_placement.py`

**Interfaces:**
- Produces: `PlacementController.admit(engine, model, cfg, cpu_capable, heavy, pinned=None)` and `PlacementController.reservation(engine, model, cfg, cpu_capable=False, heavy=False, pinned=None)` — `pinned: Optional[str]` a device key (`"cuda:1"`) that, when set, restricts GPU candidates to exactly that device. `_engine_env_pin(engine_id: str) -> Optional[str]`.

- [ ] **Step 1: Write the failing test** in `test_placement.py`:

```python
def test_pinned_restricts_candidates_to_one_device(monkeypatch):
    # Two GPUs, both roomy; pin to cuda:1 → only cuda:1 considered.
    devices = [
        {"kind": "cuda", "index": 0, "freeMb": 20000, "totalMb": 24000},
        {"kind": "cuda", "index": 1, "freeMb": 20000, "totalMb": 24000},
    ]
    pc = PlacementController(probe=lambda: devices, footprints=FootprintTable(),
                             ledger=ReservationLedger(), reserve_mb=lambda: 768)
    adm = pc.admit("coqui", "xtts_v2", {}, cpu_capable=False, heavy=True, pinned="cuda:1")
    assert adm == {"device": "cuda:1"}

def test_pinned_full_card_yields_nocapacity_even_with_room_elsewhere():
    devices = [
        {"kind": "cuda", "index": 0, "freeMb": 20000, "totalMb": 24000},
        {"kind": "cuda", "index": 1, "freeMb": 500, "totalMb": 24000},
    ]
    pc = PlacementController(probe=lambda: devices, footprints=FootprintTable(),
                             ledger=ReservationLedger(), reserve_mb=lambda: 768)
    adm = pc.admit("coqui", "xtts_v2", {}, cpu_capable=False, heavy=True, pinned="cuda:1")
    assert "noCapacity" in adm and adm["noCapacity"]["deviceKey"] == "cuda:1"
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd server/tts-sidecar && .venv\Scripts\python.exe -m pytest tests/test_placement.py -k pinned -v`
Expected: FAIL — `admit()` got an unexpected keyword argument `pinned`.

- [ ] **Step 3: Implement.** In `_gpu_candidates`, accept an effective pin that is the resident device OR the env pin. Thread `pinned` through `admit`/`reservation`:

```python
def _gpu_candidates(self, devices, resident_or_pinned):
    gpus = [(self._device_key(d), d["freeMb"], d["totalMb"])
            for d in devices if d["kind"] != "cpu"]
    if resident_or_pinned is not None:
        return [c for c in gpus if c[0] == resident_or_pinned]
    return gpus
```

In `admit`/`reservation`, compute `constraint = resident if resident is not None else pinned` and pass `constraint` where `resident` was passed to `_gpu_candidates`. **The `noCapacity.deviceKey` must prefer the constraint over the roomiest card** — a pinned op that can't fit needs Node to evict from *its* card, not the roomiest one: `device_key = resident if resident is not None else (pinned if pinned is not None else worst)` (was `resident if resident is not None else worst`). Add:

```python
def _engine_env_pin(engine_id: str) -> Optional[str]:
    """Concrete device key an engine's env pins it to, or None for auto/unset/cpu."""
    env_var = {"coqui": "COQUI_DEVICE", "kokoro": "KOKORO_DEVICE", "qwen": "QWEN_DEVICE",
               "asr": "ASR_DEVICE", "spk": "SPK_DEVICE"}.get(engine_id)
    if env_var is None:
        return None
    fam, idx = _parse_device(_read_device_env(env_var))
    if fam in ("cuda", "rocm") and idx is not None:
        return f"{fam}:{idx}"
    return None
```

- [ ] **Step 4: Run to verify pass** (`-k pinned`) → PASS. Then run the whole file to confirm no regression: `pytest tests/test_placement.py -v`.

- [ ] **Step 5: Commit** — `git commit -m "feat(server): pinned operator-device constraint on sidecar admission (#1720)"`

---

## Task 2 — Sidecar: device param on engine load methods + wrap `/load`

**Files:**
- Modify: `server/tts-sidecar/main.py` — `CoquiEngine._ensure_loaded`, `KokoroEngine._ensure_loaded`, `QwenEngine._ensure_base_loaded`, `QwenEngine._ensure_base17_loaded` (add `device: Optional[str] = None`); `/load` handler (`load_model`).
- Test: `server/tts-sidecar/tests/test_placement.py` (or a focused `test_load_admission.py`).

**Interfaces:**
- Consumes: Task 1 `reservation(..., pinned=)`.
- Produces: `_ensure_loaded(self, model, device=None)` (Coqui/Kokoro); `_ensure_base_loaded(self, device=None)` / `_ensure_base17_loaded(self, device=None)` (Qwen). When `device` is a concrete key it overrides the engine's resolved device for that cold load; `None` = env resolution unchanged.

- [ ] **Step 1: Write failing tests** — (a) flag-OFF `/load` never probes; (b) flag-ON `/load` with a mocked probe favouring `cuda:1` calls the engine load with `device="cuda:1"`; (c) flag-ON `/load` when nothing fits returns 503 `{noCapacity, neededMb, deviceKey}`. Use FastAPI `TestClient` and monkeypatch `_placement.probe` + `_capacity_admission_enabled`. Example (c):

```python
def test_load_nocapacity_returns_503(monkeypatch, client):
    monkeypatch.setenv("SEG_CAPACITY_ADMISSION", "1")
    monkeypatch.setattr(main._placement, "probe",
                        lambda: [{"kind": "cuda", "index": 0, "freeMb": 500, "totalMb": 8000}])
    r = client.post("/load", json={"engine": "coqui"})
    assert r.status_code == 503
    body = r.json()
    assert body["noCapacity"] is True and body["deviceKey"] == "cuda:0"
```

- [ ] **Step 2: Run to verify fail** — `pytest tests/test_load_admission.py -v` → FAIL (200/ready instead of 503; engine loaded with no device).

- [ ] **Step 3: Implement.** Add `device=None` params, threaded into each engine's existing resolution at these exact points (all read the engine's device attr today):
  - **Coqui** (`_ensure_loaded`): add `device_override` to `_resolve_runtime_options(self, torch_module, device_override=None)` (`main.py:1032`) and use it in place of `self._device` when set.
  - **Qwen** (`_ensure_base_loaded`/`_ensure_base17_loaded`): when `device` is given, set `self._device_pref = device` before calling `_ensure_device_resolved()` (`main.py:2830`, which resolves `self._device` from `_device_pref`) — do this under the threading `_base_load_lock`/`_base17_load_lock` already held.
  - **Kokoro** (`_ensure_loaded`, `main.py:1361`): set `self._requested_device = device` before its resolution when given.

  In every case `device=None` leaves the attr untouched → env resolution unchanged. Then in `load_model`, mirror `/synthesize`: after the idempotent-`ready` short-circuit, when `_capacity_admission_enabled()`, compute `pinned = _engine_env_pin(engine_id)`, enter `with _placement.reservation(engine_id, model_key, {}, cpu_capable=<kokoro:True else False>, heavy=<not kokoro>, pinned=pinned) as adm:`; on `noCapacity` return the 503; else pass `device=adm["device"]` into the `to_thread(ensure_loaded, …)` call. `model_key`: `"1.7b"` for the qwen 1.7b branch, else `None`. Kokoro is always wrapped (`cpu_capable=True`).

- [ ] **Step 4: Run to verify pass** — all three tests PASS; run `pytest tests/test_synthesize.py tests/test_kokoro.py -v` to confirm no load-path regression.

- [ ] **Step 5: Commit** — `feat(server): capacity-admit and device-steer the /load path (#1720)`

---

## Task 3 — Sidecar: `design_voice` + `mint_variant` device plumbing + admission

**Files:**
- Modify: `server/tts-sidecar/main.py` — `QwenEngine.design_voice(..., device=None)` (`main.py:3412`) and `QwenEngine.mint_variant(..., device=None)` (`main.py:3594`) to route their internal `_ensure_design_loaded`/`_ensure_base17_loaded`/`_ensure_base_loaded` to `device` (all resolve off the shared `self._device`, so setting `self._device_pref = device` once under the load lock steers every internal load); `/qwen/design-voice` and `/qwen/mint-variant` handlers.
- Test: `server/tts-sidecar/tests/test_placement.py` / `test_qwen3.py` sibling.

**Interfaces:**
- Consumes: Task 1 `reservation(..., pinned=)`, Task 2 Qwen `_ensure_*` device params.
- Produces: `design_voice(self, voice_id, instruct, language, calibration_text, voice_uuid, report, mint_method, fallback_for, device=None)` and `mint_variant(self, base_voice_id, variant_voice_id, emotion_instruct, language, calibration_text, …, device=None)` — append `device` LAST on both to preserve the positional handler callers (`qwen_design_voice` at `main.py:6405`, `qwen_mint_variant` at ~`6497`).

- [ ] **Step 1: Write failing tests** — flag-ON `/qwen/design-voice` and `/qwen/mint-variant` reserve the `qwen.1.7b` footprint (7168) and 503 when it doesn't fit; flag-OFF both unchanged. Assert the reservation key via a spy on `_placement.footprints.peak_mb` or by observing the 503 `neededMb == 7168`.

- [ ] **Step 2: Run to verify fail** → FAIL (no 503).

- [ ] **Step 3: Implement.** Append `device=None` to `design_voice`; inside, pass `device` to its `_ensure_design_loaded`/`_ensure_base_loaded` calls (Qwen centralizes on `self._device`, so setting it once under the load lock suffices). Do the same for the mint path. In both handlers, wrap the `to_thread(qwen.design_voice, …)` / mint call in `with _placement.reservation("qwen", "1.7b", {}, cpu_capable=False, heavy=True, pinned=_engine_env_pin("qwen")) as adm:`; on `noCapacity` return 503; else forward `device=adm["device"]`.

- [ ] **Step 4: Run to verify pass** → PASS; run `pytest tests/test_qwen_design_base17_exclusion.py tests/test_design_progress.py -v` to confirm design-path invariants hold.

- [ ] **Step 5: Commit** — `feat(server): capacity-admit design_voice and mint_variant (#1720)`

---

## Task 4 — Sidecar: `/transcribe` + `/embed` attr-set plumbing + GPU-only wrap

**Files:**
- Modify: `server/tts-sidecar/main.py` — `/transcribe` and `/embed` handlers; ASR/SPK device attr-set under the infer/load lock.
- Test: `server/tts-sidecar/tests/test_transcribe.py`, `test_speaker_embed.py`.

**Interfaces:**
- Consumes: Task 1 `reservation`.
- Produces: no new signatures; handlers set `ASR._device` / `SPK.device` to the admitted device under lock when wrapped.

- [ ] **Step 1: Write failing tests** — (a) `ASR_DEVICE=cpu` (default): `/transcribe` never touches `_placement` (spy asserts `probe` not called) — flag ON or OFF; (b) `ASR_DEVICE=cuda` + flag ON + no-fit probe → 503 `noCapacity`; same pair for `/embed` + `SPK_DEVICE`.

- [ ] **Step 2: Run to verify fail** → FAIL (cuda case returns 200/500, not 503).

- [ ] **Step 3: Implement.** In each handler, compute `on_gpu = _parse_device(<engine>._device)[0] in ("cuda","rocm")` (ASR: `self._device`; SPK: `self.device`). Only when `on_gpu and _capacity_admission_enabled()` enter `with _placement.reservation("asr"|"spk", None, {}, cpu_capable=True, heavy=False, pinned=_engine_env_pin("asr"|"spk")) as adm:`; on `noCapacity` return 503; else set the engine device attr to `adm["device"]` under its lock before the `to_thread(...)` call. cpu default → run directly, unchanged.

- [ ] **Step 4: Run to verify pass** → PASS; run `pytest tests/test_transcribe.py tests/test_speaker_embed.py -v`.

- [ ] **Step 5: Commit** — `feat(server): capacity-admit /transcribe and /embed on GPU (#1720)`

---

## Task 5 — Node: extract `withCapacityRetry` with the corrected contract

**Files:**
- Create: `server/src/gpu/capacity-retry.ts`
- Modify: `server/src/tts/sidecar.ts` — `postWithCapacityRetry` → thin wrapper; re-export `getCapacityWaiterCount`.
- Test: `server/src/gpu/capacity-retry.test.ts`; existing `server/src/tts/sidecar.test.ts` stays green.

**Interfaces:**
- Produces:
```ts
export interface CapacityRetryOpts {
  engine: string;
  signal?: AbortSignal;
  capacityProbe?: CapacityProbe;
  evictOllama?: () => Promise<void>;
  analyzerEvictWouldHelp?: (neededMb: number, freeOnDeviceMb: number) => Promise<boolean>;
  isAnalysisInFlight?: () => boolean;
  pollMs?: number;
  maxAttempts?: number;
}
/** Retries a `noCapacity` 503 (evict-once-then-bounded-poll). On an ok
 *  response OR any non-`noCapacity` response, returns that Response — the
 *  caller applies its own error handling. Throws NoCapacityError after
 *  maxAttempts, or the signal's abort reason. */
export async function withCapacityRetry(
  doPost: (signal?: AbortSignal) => Promise<Response>,
  opts: CapacityRetryOpts,
): Promise<Response>;
export function getCapacityWaiterCount(): number;
export { parseNoCapacity };
```

- [ ] **Step 1: Write failing tests** in `capacity-retry.test.ts`: (a) first `doPost` returns ok → returned as-is, no probe; (b) 503 `noCapacity` + `analyzerEvictWouldHelp=true` + `!isAnalysisInFlight` → calls `evictOllama` once then retries; (c) exhausts `maxAttempts` → throws `NoCapacityError`; (d) **contract:** a 503 that is NOT `noCapacity` (e.g. `{detail:'base17-unavailable'}`) is **returned**, not thrown; (e) a 500 is returned, not thrown; (f) `getCapacityWaiterCount()` reflects a parked waiter. Use injected doubles for all deps.

- [ ] **Step 2: Run to verify fail** — `npm run test:server -- capacity-retry` → FAIL (module missing).

- [ ] **Step 3: Implement.** Move the loop body from `sidecar.ts:325-374` into the free function, replacing `this.*` with `opts.*` (defaulting to the singletons), `this.post` with `doPost`, and — critically — **delete the `throwForResponse` call**: on a non-`noCapacity` response, `return response`. Move `parseNoCapacity`, `abortableDelay`, `_capacityWaiters`, `getCapacityWaiterCount` into the module. In `sidecar.ts`, make `postWithCapacityRetry` call `withCapacityRetry((s) => this.post(path, body, s), {engine: this.engine, signal, ...injected})` and, on the returned Response, apply the existing `if (!response.ok) await throwForResponse(response)` before returning it. Re-export `getCapacityWaiterCount` from `sidecar.ts` so `routes/gpu-queue.ts` is untouched.

- [ ] **Step 4: Run to verify pass** — `npm run test:server -- capacity-retry sidecar gpu-queue` → all PASS (synth path + waiter-count tests still green).

- [ ] **Step 5: Commit** — `refactor(server): extract reusable withCapacityRetry helper (#1720)`

---

## Task 6 — Node: flag-gate `withGpuLoad` to a lock-free passthrough

**Files:**
- Modify: `server/src/gpu/gpu-load.ts`
- Test: `server/src/gpu/gpu-load.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `withGpuLoad` unchanged signature; behaviour branches on `process.env.SEG_CAPACITY_ADMISSION === '1'`.

- [ ] **Step 1: Write failing tests**: (a) flag ON → `withGpuLoad(fn)` runs `fn` without calling `capacityProbe.read`, without `evictOllama`, and without acquiring `withGpuLoadLock` (assert via spies + a probe that would throw if called); (b) flag OFF → existing behaviour intact (tight+idle evicts; tight+busy throws `GpuBusyError`; roomy loads directly) — keep the current tests.

- [ ] **Step 2: Run to verify fail** → FAIL (flag-ON path still probes).

- [ ] **Step 3: Implement.** At the top of `withGpuLoad`, add:

```ts
if (!engineOnGpu) return loadFn();
if (process.env.SEG_CAPACITY_ADMISSION === '1') return loadFn(); // sidecar admission owns VRAM
return withGpuLoadLock(async () => { /* existing coarse probe/evict/refuse */ });
```

- [ ] **Step 4: Run to verify pass** — `npm run test:server -- gpu-load` → PASS.

- [ ] **Step 5: Commit** — `feat(server): withGpuLoad defers to sidecar admission when flag on (#1720)`

---

## Task 7 — Node: wire the five callers through `withCapacityRetry`

**Files:**
- Modify: `server/src/routes/qwen-voice.ts` (design + mint POSTs), `server/src/routes/sidecar-health.ts` (`/api/sidecar/load` proxy), `server/src/tts/transcribe-client.ts`, `server/src/tts/embed-client.ts`.
- Test: `qwen-voice.test.ts`, `sidecar-health.test.ts`, `transcribe-client.test.ts`, `embed-client.test.ts`.

**Interfaces:**
- Consumes: Task 5 `withCapacityRetry`.

- [ ] **Step 1: Write failing tests** — one per caller: with an injected `doPost` that returns a `noCapacity` 503 once then ok, the caller succeeds after an evict/retry; a non-`noCapacity` 503 still hits the caller's existing error path (`SidecarDesignError` for design; the client's thrown `Error(... returned 503)` for transcribe/embed; the proxy's status passthrough for `/load`). For `transcribe`/`embed`, also assert the wrap is inert when `asrRunsOnGpu()`/`spkRunsOnGpu()` is false.

- [ ] **Step 2: Run to verify fail** → FAIL (503 not retried).

- [ ] **Step 3: Implement.** In each caller, replace the bare fetch call with `withCapacityRetry((signal) => <caller's fetch>(url, {...init, signal}), { engine: '<coqui|qwen|asr|spk>', signal: <existing signal> })`, then keep the caller's existing `if (!response.ok)` handling on the returned Response. Note the fetch impl differs per caller — `qwen-voice.ts` and `sidecar-health.ts` use the global `fetch`; `transcribe-client.ts`/`embed-client.ts` use `undiciFetch` — and `withCapacityRetry` is thunk-agnostic, so pass whichever the caller already uses. In `transcribe-client`/`embed-client` only wrap when the GPU-gate (`asrRunsOnGpu()`/`spkRunsOnGpu()`) is true (else call the fetch directly). In `qwen-voice.ts`, wrap inside `postDesignAndCache` around the design + mint POSTs; the `base17-unavailable` branch is unaffected (helper returns that 503 for the existing `SidecarDesignError` path).

- [ ] **Step 4: Run to verify pass** — `npm run test:server -- qwen-voice sidecar-health transcribe-client embed-client` → PASS.

- [ ] **Step 5: Commit** — `feat(server): handle noCapacity 503 for load/design/mint/transcribe/embed (#1720)`

---

## Task 8 — Docs, regression plan, release notes, whole-branch verify

**Files:**
- Modify: `docs/features/264-vram-aware-gpu-placement.md` (note the four+one ops now admitted; document the flag-ON `GpuBusyError→NoCapacityError` behaviour change; update the flag-on-readiness/#1720 line).
- Modify: `docs/features/INDEX.md` if needed.
- Modify: `docs/release-notes-next.md` (technical entry, Refs #1720) + `RELEASE_NOTES.md` (brand-voice line).
- Modify: close-out — `Refs #1720` in the PR body (partial-until-flag-flip; the flag flip is a separate deferred item).

- [ ] **Step 1** Update regression plan 264: add a subsection "Op admission (#1720)" listing the five ops, the `pinned` rule, the `withGpuLoad` flag-gate, and the documented busy→noCapacity change; add the new manual-acceptance rows (2-card: a cold Coqui load steers to the roomier card; a design on a full 8 GB card evicts Ollama and proceeds, else surfaces the busy toast).
- [ ] **Step 2** Append `docs/release-notes-next.md` + `RELEASE_NOTES.md` entries.
- [ ] **Step 3** Run `npm run verify:fast:branch` from the worktree. Expected: green (or diagnose per CLAUDE.md commit-gate rules).
- [ ] **Step 4** Run the sidecar suite: `npm run test:sidecar`. Expected: green (or SKIP banner if venv unbootstrapped — then run in a venv-bootstrapped checkout).
- [ ] **Step 5: Commit** — `docs(server): regression plan + release notes for op admission (#1720)`

---

## Self-Review

- **Spec coverage:** Part A A1 (device params) → Tasks 2–4; A2 (`pinned`) → Task 1; A3 wiring (5 op families incl. mint) → Tasks 2–4; A4 cpu rule → Tasks 2 (kokoro) + 4 (asr/spk); A5 lock ordering → honoured in Tasks 2–4 (reservation reused, no ledger lock held across load). Part B B1 (helper + contract) → Task 5; B2 (`withGpuLoad` flag-gate, lock-free) → Task 6; B3 (wire callers) → Task 7. Testing → each task's tests + Task 8 verify. Flag discipline → Global Constraints + flag-OFF tests in every task. **No gaps.**
- **Placeholder scan:** none — each task carries real test code / real signatures / exact anchors.
- **Type consistency:** `withCapacityRetry(doPost, opts)` / `CapacityRetryOpts` / `getCapacityWaiterCount` consistent between Task 5 (def) and Task 7 (use); `reservation(..., pinned=)` consistent Task 1 (def) → Tasks 2–4 (use); `_engine_env_pin` consistent Task 1 (def) → Tasks 2–4 (use); Qwen `_ensure_*loaded(device=None)` consistent Task 2 (def) → Task 3 (use).
