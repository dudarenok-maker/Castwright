# Multi-GPU Wave 1 — Placement & Visibility Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every TTS-sidecar engine *placeable* on a specific GPU (or CPU) via a config knob, and make the cards + each engine's *actual* resident device *visible* — with no per-card safety logic and no UI (those are Wave 2 / Plan 2).

**Architecture:** Add/​widen the per-engine device knobs (Node registry), teach the two Node VRAM-gate helpers to recognise an indexed `cuda:N` value, fix the sidecar's inline `== "cuda"` device tests so an indexed pin actually reaches each engine's native device API (torch `.to`, CTranslate2 `device_index`, speechbrain `run_opts`, ONNX-Runtime `provider_options device_id`), expose a `GET /devices` enumeration, and extend `/health` with a `gpus[]` array reporting each engine's *actual* resident card.

**Tech Stack:** Python 3.12 sidecar (FastAPI/Starlette, torch, faster-whisper/CTranslate2, kokoro-onnx, speechbrain), pytest. Node 20 server (TypeScript, Express, undici), Vitest.

## Global Constraints

- **Source of truth is the design spec:** `docs/superpowers/specs/2026-06-27-multi-gpu-per-model-design.md` (Plan 1 / Wave 1, §1.1–1.5). Every task implements a numbered spec item.
- **Apply semantics:** all device knobs are `apply:'restart-sidecar'`. A knob value set in `server/.env` needs a *server* restart; a config override needs only a *sidecar* restart. Wave 1 ships no UI — pins are exercised via `server/.env` or env vars.
- **Engine device dialects are NOT uniform** — torch (`cuda:N` via `.to`), CTranslate2 (`device="cuda"` + `device_index=N`, **raises on a bad index — no silent CPU fallback**), speechbrain (`run_opts={"device":"cuda:N"}`), ONNX-Runtime (`provider_options=[{"device_id":N}]`).
- **Actual-card *index* readback is torch-only.** ORT (Kokoro) and CTranslate2 (Whisper) expose **family + a `fell_back` flag** only — never an index. Do not promise an index for them.
- **`stale_reason` is an enum:** `cpu_fallback | env_shadow | uuid_unresolved`. Wave 1 sets only `cpu_fallback`; the other two are Plan 2.
- **Additive, non-breaking telemetry:** the existing `/health` `devices` field (engine→family map) and every existing field MUST stay unchanged. Add a new `gpus[]` key; do not repurpose `devices`.
- **Testing discipline (CLAUDE.md):** every behaviour change ships a paired automated test; a bug-shaped fix ships a test that fails before and passes after. Sidecar tests live in `server/tts-sidecar/tests/`; server tests colocate as `*.test.ts`.
- **Commit convention:** `<type>(<scope>): <subject>`; scopes used here are `sidecar`, `server`. No `--no-verify`.
- **No hex colour literals / OpenAPI is the type source** — not relevant to Wave 1 (no UI, no new API shapes in `openapi.yaml`; `/devices` is a sidecar-internal route proxied like `/health`).
- **Kokoro `device_id` is contingent** on the pinned `kokoro-onnx` accepting `provider_options`; Task 5 begins with a verification spike and carries an `InferenceSession` fallback.

---

### Task 1: Device knobs — widen two, add two

**Files:**
- Modify: `server/src/config/registry.ts` (the `tts.coqui.device` knob ~424-432, the `qa.speaker.device` knob ~271-286; add `tts.kokoro.device` and `qa.asr.device`)
- Test: `server/src/config/registry.test.ts` (or the existing registry/resolver test file — locate with `grep -rl "tts.coqui.device" server/src/config`)

**Interfaces:**
- Consumes: the existing `Knob` type + `resolveKnob`/`resolveAll` from `server/src/config/`.
- Produces: four string device knobs whose env vars are `COQUI_DEVICE`, `SPK_DEVICE`, `KOKORO_DEVICE`, `ASR_DEVICE`, each `type:'string'`, `apply:'restart-sidecar'`. Later tasks (2, 5) read `KOKORO_DEVICE`/`ASR_DEVICE` from the sidecar env; the Node gates (Task 2) read `ASR_DEVICE`/`SPK_DEVICE`.

- [ ] **Step 1: Write the failing test**

Add to the registry test file:

```ts
import { describe, it, expect } from 'vitest';
import { resolveKnob, findKnob } from './registry'; // adjust import to the file's actual exports

describe('multi-GPU device knobs (Wave 1)', () => {
  it('COQUI_DEVICE is a string knob that accepts an indexed cuda value', () => {
    const knob = findKnob('tts.coqui.device');
    expect(knob.type).toBe('string');
    const st = resolveKnob(knob, { 'tts.coqui.device': 'cuda:1' });
    expect(st.effective).toBe('cuda:1');
  });

  it('SPK_DEVICE is a string knob (no longer enum cpu|cuda)', () => {
    const knob = findKnob('qa.speaker.device');
    expect(knob.type).toBe('string');
    expect(resolveKnob(knob, { 'qa.speaker.device': 'cuda:1' }).effective).toBe('cuda:1');
  });

  it('adds KOKORO_DEVICE (string, restart-sidecar, default auto)', () => {
    const knob = findKnob('tts.kokoro.device');
    expect(knob.env).toBe('KOKORO_DEVICE');
    expect(knob.type).toBe('string');
    expect(knob.apply).toBe('restart-sidecar');
    expect(knob.default).toBe('auto');
  });

  it('adds ASR_DEVICE registry knob (string, restart-sidecar, default cpu)', () => {
    const knob = findKnob('qa.asr.device');
    expect(knob.env).toBe('ASR_DEVICE');
    expect(knob.type).toBe('string');
    expect(knob.apply).toBe('restart-sidecar');
    expect(knob.default).toBe('cpu');
  });
});
```

> If the test file uses a different accessor than `findKnob`/`resolveKnob`, copy the pattern already in that file (it definitely resolves a knob by key and reads `.type`/`.effective`). Do not invent new helpers.

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd server && npx vitest run src/config/registry.test.ts -t "device knobs"`
Expected: FAIL — `tts.kokoro.device`/`qa.asr.device` not found; `SPK_DEVICE` type is `enum`.

- [ ] **Step 3: Widen the two enum knobs to string**

In `registry.ts`, the `tts.coqui.device` knob — replace:

```ts
    type: 'enum', options: ['auto', 'cpu', 'cuda'],
    default: 'auto', // ← COQUI_DEVICE default in tts-sidecar/main.py (line 415)
```
with:
```ts
    type: 'string',
    default: 'auto', // free-text so a multi-GPU user can pin cuda:1; sidecar resolves it
```

The `qa.speaker.device` knob — replace:
```ts
    type: 'enum',
    options: ['cpu', 'cuda'],
    default: 'cpu',
```
with:
```ts
    type: 'string',
    default: 'cpu', // free-text; accepts cpu | cuda | cuda:N
```

- [ ] **Step 4: Add the two new knobs**

Immediately after the `tts.coqui.device` knob block, add:

```ts
  {
    key: 'tts.kokoro.device',
    env: 'KOKORO_DEVICE',
    group: 'tts-engine',
    label: 'Kokoro device',
    help: 'Device for Kokoro (onnxruntime). "auto" lets the sidecar pick. Pin a specific GPU with "cuda:1", or force "cpu". Changing this requires a sidecar restart.',
    type: 'string',
    default: 'auto',
    apply: 'restart-sidecar', risk: 'high',
  },
```

Immediately after the `qa.speaker.device` knob block, add:

```ts
  {
    key: 'qa.asr.device',
    env: 'ASR_DEVICE',
    group: 'qa-gates',
    label: 'Content-QA (Whisper) device',
    help: '"cpu" (default) uses zero VRAM. "cuda" runs Whisper on the GPU; pin a specific card with "cuda:1". Changing the device restarts the sidecar.',
    type: 'string',
    default: 'cpu',
    apply: 'restart-sidecar', risk: 'medium',
  },
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd server && npx vitest run src/config/registry.test.ts -t "device knobs"`
Expected: PASS (4 tests).

- [ ] **Step 6: Guard against config:check drift**

Some repos validate that every `restart-sidecar` knob is documented in `.env.example`. Run: `cd server && npm run config:check` (if the script exists; otherwise skip).
Expected: PASS, or add `KOKORO_DEVICE=`/`ASR_DEVICE=` comment lines to `server/.env.example` matching the existing device-knob style, then re-run.

- [ ] **Step 7: Commit**

```bash
git add server/src/config/registry.ts server/src/config/registry.test.ts server/.env.example
git commit -m "feat(server): widen coqui/spk device knobs to string + add kokoro/asr device knobs"
```

---

### Task 2: Node VRAM gates recognise `cuda:N`

**Files:**
- Modify: `server/src/tts/transcribe-client.ts:58-60` (`asrRunsOnGpu`)
- Modify: `server/src/tts/embed-client.ts:40-42` (`spkRunsOnGpu`)
- Test: `server/src/tts/transcribe-client.test.ts`, `server/src/tts/embed-client.test.ts` (create if absent)

**Interfaces:**
- Consumes: `process.env.ASR_DEVICE` / `process.env.SPK_DEVICE` (strings, now possibly `cuda:N`).
- Produces: `asrRunsOnGpu(): boolean` / `spkRunsOnGpu(): boolean` returning `true` for `cuda` **and** `cuda:N`. No signature change — only the predicate widens.

**Why:** today both are `=== 'cuda'`. After Task 1 a user can set `ASR_DEVICE=cuda:1`; the exact-match test would return `false`, the GPU semaphore token would be skipped, and an on-GPU Whisper/ECAPA would run untracked → VRAM oversubscription.

- [ ] **Step 1: Write the failing tests**

`server/src/tts/transcribe-client.test.ts`:
```ts
import { afterEach, describe, expect, it } from 'vitest';
import { asrRunsOnGpu } from './transcribe-client';

describe('asrRunsOnGpu', () => {
  const prev = process.env.ASR_DEVICE;
  afterEach(() => { process.env.ASR_DEVICE = prev; });

  it('is false for cpu / unset', () => {
    delete process.env.ASR_DEVICE; expect(asrRunsOnGpu()).toBe(false);
    process.env.ASR_DEVICE = 'cpu'; expect(asrRunsOnGpu()).toBe(false);
  });
  it('is true for cuda and cuda:N', () => {
    process.env.ASR_DEVICE = 'cuda'; expect(asrRunsOnGpu()).toBe(true);
    process.env.ASR_DEVICE = 'cuda:1'; expect(asrRunsOnGpu()).toBe(true);
    process.env.ASR_DEVICE = 'CUDA:0'; expect(asrRunsOnGpu()).toBe(true);
  });
});
```

`server/src/tts/embed-client.test.ts` — identical shape against `spkRunsOnGpu` and `SPK_DEVICE`.

- [ ] **Step 2: Run to verify they fail**

Run: `cd server && npx vitest run src/tts/transcribe-client.test.ts src/tts/embed-client.test.ts`
Expected: FAIL on the `cuda:1` assertion (`=== 'cuda'` is false).

- [ ] **Step 3: Widen both predicates**

`transcribe-client.ts` — replace the body of `asrRunsOnGpu`:
```ts
export function asrRunsOnGpu(): boolean {
  return (process.env.ASR_DEVICE ?? 'cpu').trim().toLowerCase().startsWith('cuda');
}
```

`embed-client.ts` — replace the body of `spkRunsOnGpu`:
```ts
export function spkRunsOnGpu(): boolean {
  return (process.env.SPK_DEVICE ?? 'cpu').trim().toLowerCase().startsWith('cuda');
}
```

- [ ] **Step 4: Run to verify they pass**

Run: `cd server && npx vitest run src/tts/transcribe-client.test.ts src/tts/embed-client.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/tts/transcribe-client.ts server/src/tts/embed-client.ts server/src/tts/transcribe-client.test.ts server/src/tts/embed-client.test.ts
git commit -m "fix(server): asr/spk GPU gates recognise indexed cuda:N device"
```

---

### Task 3: Sidecar device parser + Whisper `cuda:N`

**Files:**
- Modify: `server/tts-sidecar/main.py` (add a module-level `_parse_device` helper near `_resolve_torch_device` ~1167; fix `WhisperEngine._compute_type` ~2821 and `_ensure_loaded` ~2842)
- Test: `server/tts-sidecar/tests/test_device_parse.py` (new), extend `server/tts-sidecar/tests/test_synthesize.py` only if a Whisper integration test already lives there (else keep the unit test standalone)

**Interfaces:**
- Produces: `_parse_device(value: str) -> tuple[str, Optional[int]]` returning `(family, index)` where `family ∈ {"cpu","cuda","mps","auto"}` and `index` is the GPU ordinal or `None`. Examples: `"cuda:1"→("cuda",1)`, `"cuda"→("cuda",None)`, `"cpu"→("cpu",None)`, `""→("auto",None)`. Tasks 4 and 7 reuse this.

- [ ] **Step 1: Write the failing test**

`server/tts-sidecar/tests/test_device_parse.py`:
```python
import importlib
main = importlib.import_module("main")

def test_parse_device_families_and_index():
    assert main._parse_device("cpu") == ("cpu", None)
    assert main._parse_device("cuda") == ("cuda", None)
    assert main._parse_device("cuda:0") == ("cuda", 0)
    assert main._parse_device("cuda:2") == ("cuda", 2)
    assert main._parse_device("CUDA:1") == ("cuda", 1)
    assert main._parse_device("") == ("auto", None)
    assert main._parse_device(None) == ("auto", None)  # type: ignore[arg-type]

def test_whisper_compute_type_honours_indexed_cuda(monkeypatch):
    monkeypatch.setenv("ASR_DEVICE", "cuda:1")
    eng = main.WhisperEngine()
    # int8_float16 is the GPU compute type; an indexed pin must still select it
    assert eng._compute_type() == "int8_float16"
```

- [ ] **Step 2: Run to verify it fails**

Run (from `server/tts-sidecar`): `.\.venv\Scripts\python.exe -m pytest tests/test_device_parse.py -v`
Expected: FAIL — `_parse_device` not defined; `_compute_type` returns `int8` for `cuda:1`.

> If the venv is unbootstrapped, `npm run test:sidecar` prints a SKIP banner — bootstrap the venv per `server/tts-sidecar/README.md` before this task, since it's the only way to exercise sidecar code.

- [ ] **Step 3: Add the parser**

In `main.py`, directly above `_resolve_torch_device` (line ~1167):
```python
def _parse_device(value: Optional[str]) -> tuple[str, Optional[int]]:
    """Split a device knob value into (family, index).

    'cuda:1' → ('cuda', 1); 'cuda' → ('cuda', None); 'cpu' → ('cpu', None);
    'mps' → ('mps', None); '' / None / 'auto' → ('auto', None). Case-insensitive.
    The single place that understands the `cuda:N` grammar — every engine's
    device read routes through it so an indexed pin can't silently degrade."""
    p = (value or "auto").strip().lower()
    if p in ("", "auto"):
        return ("auto", None)
    if p == "cpu":
        return ("cpu", None)
    if p == "mps":
        return ("mps", None)
    if p.startswith("cuda"):
        _, _, idx = p.partition(":")
        return ("cuda", int(idx) if idx.isdigit() else None)
    return (p, None)
```

- [ ] **Step 4: Fix Whisper's compute-type + device split**

In `WhisperEngine._compute_type` (~2821), replace:
```python
        default = "int8_float16" if self._device == "cuda" else "int8"
```
with:
```python
        family, _ = _parse_device(self._device)
        default = "int8_float16" if family == "cuda" else "int8"
```

In `WhisperEngine._ensure_loaded` (~2842), replace:
```python
        self._model = WhisperModel(
            self._model_name, device=self._device, compute_type=self._compute_type()
        )
```
with:
```python
        # CTranslate2 wants device="cuda" + a separate device_index; it RAISES on a
        # bad index (no silent CPU fallback), so an out-of-range pin surfaces as a
        # load error the supervisor/health can show — that's intended.
        family, index = _parse_device(self._device)
        ct2_device = "cuda" if family == "cuda" else ("cpu" if family in ("cpu", "auto") else family)
        ct2_kwargs = {"device": ct2_device, "compute_type": self._compute_type()}
        if family == "cuda" and index is not None:
            ct2_kwargs["device_index"] = index
        self._model = WhisperModel(self._model_name, **ct2_kwargs)
```

> Note: `self._device` keeps its raw `os.environ` string (still logged at 2845); only the `WhisperModel` construction is index-aware. Do not change the `_device` assignment at 2818.

- [ ] **Step 5: Run to verify it passes**

Run: `.\.venv\Scripts\python.exe -m pytest tests/test_device_parse.py -v`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add server/tts-sidecar/main.py server/tts-sidecar/tests/test_device_parse.py
git commit -m "feat(sidecar): _parse_device helper + Whisper honours cuda:N (device_index)"
```

---

### Task 4: ECAPA/SPK `cuda:N`

**Files:**
- Modify: `server/tts-sidecar/main.py` (`SpeakerEmbedder`/SPK `__init__` ~2936, `ensure_loaded` device-present check ~2954-2969, `_load_on` ~2938)
- Test: `server/tts-sidecar/tests/test_device_parse.py` (extend)

**Interfaces:**
- Consumes: `_parse_device` (Task 3).
- Produces: SPK loads on the *indexed* card; the availability-degrade check keys on the parsed family, not `== "cuda"`.

- [ ] **Step 1: Write the failing test**

Append to `tests/test_device_parse.py`:
```python
def test_spk_indexed_cuda_present_check(monkeypatch):
    monkeypatch.setenv("SPK_DEVICE", "cuda:1")
    spk = main.SpeakerEmbedder() if hasattr(main, "SpeakerEmbedder") else main.SPK.__class__()
    family, index = main._parse_device(spk.device)
    assert (family, index) == ("cuda", 1)
    # the load device string passed to speechbrain run_opts must carry the index
    assert main._spk_run_device(spk.device) == "cuda:1"
```

> Replace `SpeakerEmbedder` with the actual class name at `main.py:2924` (read the `class ...:` line). If the class is only instantiated as the `SPK` singleton, use `main.SPK.__class__()`.

- [ ] **Step 2: Run to verify it fails**

Run: `.\.venv\Scripts\python.exe -m pytest tests/test_device_parse.py::test_spk_indexed_cuda_present_check -v`
Expected: FAIL — `_spk_run_device` not defined.

- [ ] **Step 3: Add a tiny SPK device resolver + use the family check**

In `main.py`, near `_parse_device`, add:
```python
def _spk_run_device(value: Optional[str]) -> str:
    """speechbrain run_opts device string. 'cuda:1' stays 'cuda:1'; family-only
    'cuda' stays 'cuda'; everything else → 'cpu'."""
    family, index = _parse_device(value)
    if family == "cuda":
        return f"cuda:{index}" if index is not None else "cuda"
    return "cpu" if family in ("cpu", "auto") else family
```

In the SPK `ensure_loaded` present-check (~2954), replace:
```python
            if self.device == "cuda":
```
with:
```python
            if _parse_device(self.device)[0] == "cuda":
```
and the poison-class branch (~2969), replace:
```python
                if self.device == "cuda" and not _CUDA_POISON_RE.search(f"{e}"):
```
with:
```python
                if _parse_device(self.device)[0] == "cuda" and not _CUDA_POISON_RE.search(f"{e}"):
```

In `_load_on` (~2938), have the model load on the indexed device. The method receives `device`; ensure callers pass the resolved string by changing the call site in `ensure_loaded` (~2963):
```python
                self._model = await asyncio.to_thread(self._load_on, _spk_run_device(self.device))
```
and the degrade-reload call (~2972):
```python
                    self._model = await asyncio.to_thread(self._load_on, _spk_run_device(self.device))
```
(The `self.device = "cpu"` assignments on degrade stay; `_spk_run_device("cpu")` → `"cpu"`.)

- [ ] **Step 4: Run to verify it passes**

Run: `.\.venv\Scripts\python.exe -m pytest tests/test_device_parse.py -v`
Expected: PASS (all device-parse tests).

- [ ] **Step 5: Commit**

```bash
git add server/tts-sidecar/main.py server/tts-sidecar/tests/test_device_parse.py
git commit -m "feat(sidecar): ECAPA speaker-embed honours cuda:N via run_opts"
```

---

### Task 5: Kokoro `device_id` plumbing (spike-gated)

**Files:**
- Modify: `server/tts-sidecar/main.py` (`KokoroEngine._resolve_ort_providers` ~842 + the `Kokoro(...)` construction ~944)
- Test: `server/tts-sidecar/tests/test_kokoro.py` (extend)

**Interfaces:**
- Consumes: `_parse_device` (Task 3), `KOKORO_DEVICE` env.
- Produces: a pure helper `_kokoro_provider_options(device: str, providers: list[str]) -> Optional[list[dict]]` returning ORT `provider_options` (e.g. `[{"device_id": 1}, {}]` aligned to `providers`) for an indexed CUDA pin, else `None`. The construction passes it through when supported.

- [ ] **Step 1: SPIKE — verify the pinned `kokoro-onnx` API**

Run:
```bash
cd server/tts-sidecar
.\.venv\Scripts\python.exe -c "import inspect, kokoro_onnx; print(inspect.signature(kokoro_onnx.Kokoro.__init__))"
```
Record whether `Kokoro.__init__` accepts `provider_options=` (or a `sess`/`session=` for a pre-built `InferenceSession`). This decides Step 4's branch. Note the result in the commit body. **Do not skip this** — the spec flags Kokoro `device_id` as contingent.

- [ ] **Step 2: Write the failing test (pure helper — no model load)**

Append to `tests/test_kokoro.py`:
```python
import importlib
main = importlib.import_module("main")

def test_kokoro_provider_options_indexed_cuda():
    providers = ["CUDAExecutionProvider", "CPUExecutionProvider"]
    opts = main._kokoro_provider_options("cuda:1", providers)
    assert opts == [{"device_id": 1}, {}]

def test_kokoro_provider_options_none_when_not_indexed():
    assert main._kokoro_provider_options("cpu", ["CPUExecutionProvider"]) is None
    assert main._kokoro_provider_options("cuda", ["CUDAExecutionProvider"]) is None  # no index → ORT default
    assert main._kokoro_provider_options("auto", []) is None
```

- [ ] **Step 3: Run to verify it fails**

Run: `.\.venv\Scripts\python.exe -m pytest tests/test_kokoro.py -k provider_options -v`
Expected: FAIL — `_kokoro_provider_options` not defined.

- [ ] **Step 4: Implement the helper + wire it (branch on the spike)**

Add near `_resolve_ort_providers`:
```python
@staticmethod
def _kokoro_provider_options(device: Optional[str], providers: list[str]) -> Optional[list[dict]]:
    """Per-provider ORT options aligned to `providers`, setting CUDA `device_id`
    for an indexed pin (e.g. KOKORO_DEVICE=cuda:1). Returns None when there is no
    index to pin (ORT picks its default device) — keeps today's behaviour intact."""
    family, index = _parse_device(device)
    if family != "cuda" or index is None or not providers:
        return None
    return [{"device_id": index} if p == "CUDAExecutionProvider" else {} for p in providers]
```

At the `Kokoro(...)` construction (~944) — **if the spike showed `provider_options` is accepted:**
```python
    device = os.environ.get("KOKORO_DEVICE", "auto")
    provider_options = KokoroEngine._kokoro_provider_options(device, providers)
    kokoro_kwargs = {"providers": providers} if providers else {}
    if provider_options is not None:
        kokoro_kwargs["provider_options"] = provider_options
    self._kokoro = Kokoro(self._model_path, self._voices_path, **kokoro_kwargs)
```
Keep the existing `TypeError → no-kwarg fallback` (~945-950) so an older `kokoro-onnx` still loads.

**If the spike showed only a `session=`/`sess=` path** (no `provider_options` kwarg): build the `InferenceSession` yourself and pass it — implement `_build_kokoro_session(providers, provider_options)` using `onnxruntime.InferenceSession(self._model_path, providers=providers, provider_options=provider_options)` and pass `sess=`. Pin the exact kwarg name from the spike.

- [ ] **Step 5: Run to verify the helper passes**

Run: `.\.venv\Scripts\python.exe -m pytest tests/test_kokoro.py -k provider_options -v`
Expected: PASS. (The construction itself is covered on-box — a unit test can't load real weights.)

- [ ] **Step 6: Commit**

```bash
git add server/tts-sidecar/main.py server/tts-sidecar/tests/test_kokoro.py
git commit -m "feat(sidecar): Kokoro honours KOKORO_DEVICE via ORT provider device_id

Spike result: kokoro-onnx Kokoro.__init__ <accepts provider_options | needs session=>."
```

---

### Task 6: `GET /devices` enumeration + server proxy

**Files:**
- Modify: `server/tts-sidecar/main.py` (add `_enumerate_cuda_devices()` near `_cuda_vram_mb` ~3319; add a `@app.get("/devices")` route near the `/health` route)
- Create: `server/src/routes/devices.ts` (proxy, mirroring `server/src/routes/sidecar-health.ts`)
- Modify: the route registration site (wherever `sidecar-health` is mounted — `grep -rn "sidecar-health" server/src`)
- Test: `server/tts-sidecar/tests/test_devices.py` (new); `server/src/routes/devices.test.ts` (new)

**Interfaces:**
- Produces: sidecar `GET /devices` → `{"devices":[{"uuid","idx","name","total_mb","free_mb"}], "cpu": true}`; server proxy `GET /api/devices` returning the same. Task 7 + Plan 2 consume this shape.

- [ ] **Step 1: Write the failing sidecar test**

`server/tts-sidecar/tests/test_devices.py`:
```python
import importlib
main = importlib.import_module("main")

def test_enumerate_returns_list_of_card_dicts(monkeypatch):
    class _Props:
        def __init__(self, name, total, uuid): self.name=name; self.total_memory=total; self.uuid=uuid
    class _Cuda:
        @staticmethod
        def is_available(): return True
        @staticmethod
        def device_count(): return 2
        @staticmethod
        def get_device_properties(i):
            return _Props(["RTX 4070","RTX 5070 Ti"][i], [8*10**9,16*10**9][i], f"GPU-{i}")
        @staticmethod
        def mem_get_info(i): return ([6*10**9, 14*10**9][i], [8*10**9,16*10**9][i])
    monkeypatch.setattr(main, "torch", type("T", (), {"cuda": _Cuda})(), raising=False)
    out = main._enumerate_cuda_devices()
    assert [d["idx"] for d in out] == [0, 1]
    assert out[1]["name"] == "RTX 5070 Ti"
    assert out[1]["total_mb"] == 16000 and out[1]["free_mb"] == 14000
    assert out[1]["uuid"] == "GPU-1"
```

> Read how the existing sidecar tests stub torch (`tests/test_device_probe.py` uses a `_StubTorch`); match that injection style if `main` imports torch lazily rather than as a module global.

- [ ] **Step 2: Run to verify it fails**

Run: `.\.venv\Scripts\python.exe -m pytest tests/test_devices.py -v`
Expected: FAIL — `_enumerate_cuda_devices` not defined.

- [ ] **Step 3: Implement the enumerator + route**

Near `_cuda_vram_mb` (~3319):
```python
def _enumerate_cuda_devices() -> list[dict]:
    """[{uuid, idx, name, total_mb, free_mb}] per visible CUDA device, driver
    truth via mem_get_info (sees ALL allocators). [] when CUDA is unavailable."""
    try:
        import torch  # type: ignore
        if not torch.cuda.is_available():
            return []
        out = []
        for i in range(torch.cuda.device_count()):
            props = torch.cuda.get_device_properties(i)
            free, total = torch.cuda.mem_get_info(i)
            out.append({
                "uuid": str(getattr(props, "uuid", "")) or f"idx-{i}",
                "idx": i,
                "name": props.name,
                "total_mb": round(total / 1_000_000),
                "free_mb": round(free / 1_000_000),
            })
        return out
    except Exception:
        return []
```

Add the route next to `/health`:
```python
@app.get("/devices")
def devices() -> dict:
    """Discovery for the picker: visible GPUs + a cpu pseudo-option."""
    return {"devices": _enumerate_cuda_devices(), "cpu": True}
```

- [ ] **Step 4: Run to verify it passes**

Run: `.\.venv\Scripts\python.exe -m pytest tests/test_devices.py -v`
Expected: PASS.

- [ ] **Step 5: Write the failing proxy test + implement the proxy**

`server/src/routes/devices.test.ts` — mirror `sidecar-health.test.ts`: stand up the router with a fake sidecar returning the `/devices` body and assert `GET /api/devices` returns it (and `{devices:[],cpu:true}` when the sidecar is down). Copy the exact mounting + fetch-mock pattern from `sidecar-health.test.ts`.

`server/src/routes/devices.ts` — copy `sidecar-health.ts` and swap the upstream path to `/devices` and the mount path to `/api/devices`; keep its timeout/error-fallback handling (return `{devices:[],cpu:true}` on upstream failure). Register it where `sidecar-health` is registered.

- [ ] **Step 6: Run to verify the proxy passes**

Run: `cd server && npx vitest run src/routes/devices.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add server/tts-sidecar/main.py server/tts-sidecar/tests/test_devices.py server/src/routes/devices.ts server/src/routes/devices.test.ts server/src/<route-registration-file>.ts
git commit -m "feat(sidecar,server): GET /devices GPU discovery + /api/devices proxy"
```

---

### Task 7: `/health` `gpus[]` actual-card readback

**Files:**
- Modify: `server/tts-sidecar/main.py` (the `/health` handler ~4060-4109 — add a `gpus` key; add `_engine_actual_card(engine)` + `_resident_engines_by_card()` helpers)
- Test: `server/tts-sidecar/tests/test_devices.py` (extend) or `tests/test_runtime_wiring.py` if `/health` shape is asserted there

**Interfaces:**
- Consumes: `_enumerate_cuda_devices` (Task 6), `_parse_device` (Task 3), the existing `_normalize_device_family`/`_kokoro_session_device`.
- Produces: `/health` gains `"gpus": [{uuid, idx, name, total_mb, free_mb, torch_reserved_mb, resident:[{engine, actual_card}], stale_reason?}]`. The existing `devices` map and all other fields are untouched (Global Constraint: additive).

**Note on granularity:** torch engines (Qwen/Coqui/SPK) report an actual *index* via `param.device.index`; Kokoro (ORT) and Whisper (CT2) report **family + a `fell_back` flag** only — never an index. When a CUDA-pinned engine resolves to CPU, set `stale_reason="cpu_fallback"` on that engine's `resident` entry.

- [ ] **Step 1: Write the failing test**

Append to `tests/test_devices.py`:
```python
def test_health_includes_gpus_array(monkeypatch):
    # stub enumeration so the assertion is deterministic without real CUDA
    monkeypatch.setattr(main, "_enumerate_cuda_devices", lambda: [
        {"uuid": "GPU-0", "idx": 0, "name": "RTX 4070", "total_mb": 8000, "free_mb": 6000},
    ])
    monkeypatch.setattr(main, "_resident_engines_by_card", lambda cards: {0: [{"engine": "qwen", "actual_card": 0}]})
    payload = main._build_gpus_payload()
    assert payload[0]["uuid"] == "GPU-0"
    assert payload[0]["resident"] == [{"engine": "qwen", "actual_card": 0}]
```

- [ ] **Step 2: Run to verify it fails**

Run: `.\.venv\Scripts\python.exe -m pytest tests/test_devices.py::test_health_includes_gpus_array -v`
Expected: FAIL — `_build_gpus_payload` not defined.

- [ ] **Step 3: Implement the actual-card helpers + payload builder**

```python
def _engine_actual_card(engine: Any) -> tuple[Optional[str], Optional[int], bool]:
    """(family, card_index, fell_back). Index is torch-only; ORT/CT2 give family.
    fell_back is True when a cuda pin actually resolved to cpu."""
    fam = idx = None
    # torch engines expose a real device on the loaded module
    dev = getattr(engine, "_resolved_device", None) or getattr(engine, "_device", None) or getattr(engine, "device", None)
    if dev is not None:
        fam, idx = _parse_device(str(dev))
    requested_fam, _ = _parse_device(str(getattr(engine, "_requested_device", dev) or "auto"))
    fell_back = (requested_fam == "cuda" and fam == "cpu")
    return (fam, idx, fell_back)


def _build_gpus_payload() -> list[dict]:
    """gpus[] for /health: discovered cards + per-card torch_reserved + resident
    engines with their ACTUAL device (not the requested knob)."""
    cards = _enumerate_cuda_devices()
    reserved_by_idx = {}
    try:
        import torch  # type: ignore
        for c in cards:
            reserved_by_idx[c["idx"]] = round(torch.cuda.memory_reserved(c["idx"]) / 1_000_000)
    except Exception:
        pass
    resident = _resident_engines_by_card(cards)
    for c in cards:
        c["torch_reserved_mb"] = reserved_by_idx.get(c["idx"], 0)
        c["resident"] = resident.get(c["idx"], [])
    return cards
```

Add `_resident_engines_by_card(cards)` that walks the loaded engines (`COQUI`/`KOKORO`/`QWEN`/`ASR`/`SPK` singletons), calls `_engine_actual_card`, and buckets `{idx: [{"engine": name, "actual_card": idx, ...("stale_reason":"cpu_fallback" if fell_back)}]}`. For ORT/CT2 engines with no index, place them under their family without an index key and still flag `fell_back`. Keep it defensive — an unloaded engine contributes nothing.

In the `/health` return dict (after the `"devices": devices,` line ~4109), add:
```python
        "gpus": _build_gpus_payload(),
```

- [ ] **Step 4: Run to verify it passes**

Run: `.\.venv\Scripts\python.exe -m pytest tests/test_devices.py -v`
Expected: PASS.

- [ ] **Step 5: Guard the additive contract**

Run the existing health-shape test to prove nothing broke: `.\.venv\Scripts\python.exe -m pytest tests/test_runtime_wiring.py -v` (and any test asserting `/health` keys).
Expected: PASS — `devices`, `asr_device`, etc. unchanged.

- [ ] **Step 6: Commit**

```bash
git add server/tts-sidecar/main.py server/tts-sidecar/tests/test_devices.py
git commit -m "feat(sidecar): /health gpus[] reports each engine's actual resident card"
```

---

### Task 8: Wave 1 on-box acceptance checklist (written deliverable)

**Files:**
- Create: `docs/features/<n>-multi-gpu.md` from `docs/features/TEMPLATE.md` (assign `<n>` per the backlog; tag the issue `needs-plan`)

**Interfaces:** none (documentation). This converts the spec's "named, not written" acceptance into explicit pass/fail lines for the one operator with the 2-GPU box.

- [ ] **Step 1: Write the acceptance section**

In the new plan doc, under a `## Wave 1 acceptance (on-box, 2-GPU)` heading, list these explicit checks (each a checkbox the operator ticks):
```markdown
- [ ] `GET /api/devices` lists both cards with correct names + total_mb (8000 / 16000) and a live free_mb.
- [ ] `QWEN_DEVICE=cuda:1` then restart → `/health` gpus[] shows qwen resident with actual_card=1 (torch index truth).
- [ ] `ASR_DEVICE=cuda:1` then transcribe → no CTranslate2 error; `asrRunsOnGpu()` true (semaphore token taken).
- [ ] `SPK_DEVICE=cuda:1` then an embed → ECAPA loads on cuda:1 (no degrade-to-cpu warning).
- [ ] `KOKORO_DEVICE=cuda:1` then a Kokoro synth → no fell_back flag in gpus[]; (index unverifiable for ORT — confirm via nvidia-smi that VRAM lands on card 1).
- [ ] Force a fallback: `KOKORO_DEVICE=cuda:9` (no such card) → gpus[] flags kokoro stale_reason=cpu_fallback, sidecar serves from CPU, no crash.
- [ ] All existing `/health` fields unchanged (diff against a pre-Wave-1 capture).
```

- [ ] **Step 2: Update the features index + commit**

Add the new doc under its area in `docs/features/INDEX.md`.

```bash
git add docs/features/<n>-multi-gpu.md docs/features/INDEX.md
git commit -m "docs(docs): Wave 1 multi-GPU on-box acceptance checklist"
```

---

## Self-Review

**Spec coverage (Wave 1, §1.1–1.5):**
- §1.1 discovery + per-card sampler → Task 6 (`/devices`, `_enumerate_cuda_devices`) + Task 7 (`gpus[]`). ✓
- §1.2 config knobs (widen COQUI/SPK; add KOKORO/ASR) → Task 1. ✓
- §1.3 adapter + the inline `== "cuda"` sites (Whisper compute-type+device, SPK ×2, Kokoro device_id) → Tasks 3, 4, 5 (`_parse_device` is the adapter core; Qwen/Coqui already torch-indexed via `_resolve_torch_device`, verified at `main.py:1174`). ✓
- §1.4 Node gates (ASR + SPK embed) → Task 2. ✓
- §1.5 actual-card readback + `stale_reason` (cpu_fallback) → Task 7. ✓
- Written on-box checklist → Task 8. ✓

**Placeholder scan:** Task 5's spike + Task 4's class-name read are *instructions to verify a real value*, not placeholders — each has a concrete command and a concrete fallback. The `<n>` in Task 8 and `<route-registration-file>` in Task 6 are repo lookups with a stated `grep`. No "TBD/handle edge cases/write tests for the above."

**Type consistency:** `_parse_device(value) -> (family, index)` is defined in Task 3 and consumed with that exact shape in Tasks 4, 5, 7. `_enumerate_cuda_devices()` dict shape (`uuid/idx/name/total_mb/free_mb`) defined in Task 6, extended (not renamed) in Task 7. `asrRunsOnGpu`/`spkRunsOnGpu` keep their boolean signatures (Task 2).

**Known soft spots flagged for execution, not hidden:** Task 5 (Kokoro) is genuinely contingent on the `kokoro-onnx` API — the spike is Step 1 and the fallback is specified. Task 7's `_resident_engines_by_card` walk depends on the actual singleton names (`COQUI`/`KOKORO`/`QWEN`/`ASR`/`SPK`) and each engine's loaded-device attribute — the implementer reads the engine classes to confirm attribute names before writing the bucketing loop.
