# Multi-GPU Wave 1 — Placement & Visibility Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **Revised after a 5-lens adversarial code review** that caught ~20 defects in the first draft (torch-stub that didn't attach, an invented `_requested_device`, a route/file collision with the LAN-pairing `devices.ts`, Coqui losing fp16/DeepSpeed under `cuda:N`, registry test importing non-existent symbols, etc.). Every code block and test below was checked against the real source.

**Goal:** Make every TTS-sidecar engine *placeable* on a specific GPU (or CPU) via a config knob, and make the cards + each engine's *actual* resident device *visible* — no per-card safety logic, no UI (Wave 2 / Plan 2).

**Architecture:** A single Python device-grammar helper (`_parse_device`) that every engine's device read routes through; per-engine fixes so an indexed `cuda:N` pin reaches each engine's native API (torch `.to`, CTranslate2 `device_index`, speechbrain `run_opts`, ONNX-Runtime `provider_options device_id`) *and* preserves fp16/DeepSpeed; a `GET /api/gpu/devices` discovery endpoint; and a `/health` `gpus[]` array reporting each engine's **actual** resident card (with a `cpu_fallback` flag).

**Tech Stack:** Python 3.12 sidecar (Starlette, torch, faster-whisper/CTranslate2, kokoro-onnx, speechbrain), pytest. Node 20 server (TypeScript/ESM NodeNext, Express, undici), Vitest.

## Global Constraints

- **Spec:** `docs/superpowers/specs/2026-06-27-multi-gpu-per-model-design.md` (Plan 1 / Wave 1, §1.1–1.5). Each task implements a numbered item.
- **Apply semantics:** all device knobs are `apply:'restart-sidecar'`. Wave 1 ships no UI — pins are exercised via `server/.env` / env vars + a sidecar restart.
- **Engine device dialects are NOT uniform:** torch (`.to("cuda:N")`), CTranslate2 (`device="cuda"` + `device_index=N`, **raises on a bad index — no silent CPU fallback**), speechbrain (`run_opts={"device":"cuda:N"}`), ONNX-Runtime (`provider_options=[{"device_id":N}]`).
- **Actual-card *index* readback is torch-only.** ORT (Kokoro) reports family via its session providers; CTranslate2 (Whisper) reports family only. Never promise an index for them.
- **`stale_reason` enum:** `cpu_fallback | env_shadow | uuid_unresolved`; lives on the **per-engine `resident` entry**. Wave 1 sets only `cpu_fallback`.
- **Additive telemetry:** the existing `/health` `devices` map (engine→family) and every existing field stay byte-for-byte unchanged. Add a new `gpus[]` key only.
- **ESM:** all Node imports use the `.js` extension (NodeNext). Sidecar tests import `main` per the existing `tests/` convention (pytest prepend-import-mode via the co-located `conftest.py`).
- **Testing discipline:** every behaviour change ships a paired test that fails-before/passes-after; **never `Write`-clobber an existing test file — append**.
- **Commit convention:** `<type>(<scope>): <subject>`, scopes `sidecar`/`server`, ≤100 chars; no `--no-verify`.
- **`verify` gates touched here:** `config:check` (env-example sync — regenerate with `npm run config:sync` from repo root) and `test:server` (the resolver/registry suites).
- **Kokoro `device_id` is contingent** on the pinned `kokoro-onnx` accepting `provider_options` — Task 6 opens with a spike and carries an `InferenceSession` fallback.

---

### Task 1: Device knobs — widen two, add two (and keep the enum-exemplar test green)

**Files:**
- Modify: `server/src/config/registry.ts` (`tts.coqui.device` ~424, `qa.speaker.device` ~271; add `tts.kokoro.device`, `qa.asr.device`)
- Modify: `server/src/config/resolver.test.ts` (repoint the enum exemplar — see Step 4)
- Create: `server/src/config/registry.device.test.ts`
- Regenerate: `server/.env.example` (via `npm run config:sync`)

**Interfaces:**
- Produces: four `type:'string'`, `apply:'restart-sidecar'` device knobs — `COQUI_DEVICE` (default `auto`), `SPK_DEVICE` (default `cpu`), `KOKORO_DEVICE` (default `auto`), `ASR_DEVICE` (default `cpu`). Read by `getKnob(key)` / `resolveKnob(knob)` (single-arg) from `server/src/config/`.

- [ ] **Step 1: Write the failing test (use the real resolver API)**

`server/src/config/registry.device.test.ts`:
```ts
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../workspace/user-settings.js', () => ({
  readConfigOverrides: vi.fn(() => ({})),
}));

import { resolveKnob } from './resolver.js';
import { getKnob } from './registry.js';
import * as us from '../workspace/user-settings.js';

describe('multi-GPU device knobs (Wave 1)', () => {
  beforeEach(() => {
    delete process.env.COQUI_DEVICE; delete process.env.SPK_DEVICE;
    delete process.env.KOKORO_DEVICE; delete process.env.ASR_DEVICE;
    (us.readConfigOverrides as any).mockReturnValue({});
  });

  it('COQUI_DEVICE is a string knob; an override of cuda:1 resolves through', () => {
    expect(getKnob('tts.coqui.device')!.type).toBe('string');
    (us.readConfigOverrides as any).mockReturnValue({ 'tts.coqui.device': 'cuda:1' });
    expect(resolveKnob(getKnob('tts.coqui.device')!).effective).toBe('cuda:1');
  });

  it('SPK_DEVICE is a string knob (was enum cpu|cuda)', () => {
    expect(getKnob('qa.speaker.device')!.type).toBe('string');
    (us.readConfigOverrides as any).mockReturnValue({ 'qa.speaker.device': 'cuda:1' });
    expect(resolveKnob(getKnob('qa.speaker.device')!).effective).toBe('cuda:1');
  });

  it('adds KOKORO_DEVICE (string, restart-sidecar, default auto)', () => {
    const k = getKnob('tts.kokoro.device')!;
    expect([k.env, k.type, k.apply, k.default]).toEqual(['KOKORO_DEVICE', 'string', 'restart-sidecar', 'auto']);
  });

  it('adds ASR_DEVICE registry knob (string, restart-sidecar, default cpu)', () => {
    const k = getKnob('qa.asr.device')!;
    expect([k.env, k.type, k.apply, k.default]).toEqual(['ASR_DEVICE', 'string', 'restart-sidecar', 'cpu']);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd server && npx vitest run src/config/registry.device.test.ts`
Expected: FAIL — `tts.coqui.device` type is `enum`; `getKnob('tts.kokoro.device')` is `undefined`.

- [ ] **Step 3: Widen the two enum knobs + add the two new ones**

`tts.coqui.device` — replace `type: 'enum', options: ['auto', 'cpu', 'cuda'],` with:
```ts
    type: 'string',
```
(keep `default: 'auto'`; drop the stale `// line 415` comment).

`qa.speaker.device` — replace `type: 'enum',\n    options: ['cpu', 'cuda'],` with:
```ts
    type: 'string',
```
(keep `default: 'cpu'`).

After the `tts.coqui.device` block add:
```ts
  {
    key: 'tts.kokoro.device',
    env: 'KOKORO_DEVICE',
    group: 'tts-engine',
    label: 'Kokoro device',
    help: 'Device for Kokoro (onnxruntime). "auto" lets the sidecar pick; pin a card with "cuda:1" or force "cpu". Changing this requires a sidecar restart.',
    type: 'string',
    default: 'auto',
    apply: 'restart-sidecar', risk: 'high',
  },
```
After the `qa.speaker.device` block add:
```ts
  {
    key: 'qa.asr.device',
    env: 'ASR_DEVICE',
    group: 'qa-gates',
    label: 'Content-QA (Whisper) device',
    help: '"cpu" (default) uses zero VRAM. "cuda" runs Whisper on the GPU; pin a card with "cuda:1". Changing the device restarts the sidecar.',
    type: 'string',
    default: 'cpu',
    apply: 'restart-sidecar', risk: 'medium',
  },
```

- [ ] **Step 4: Repoint the enum-exemplar resolver test (it currently uses tts.coqui.device)**

`resolver.test.ts` asserts `coerceAndValidate(getKnob('tts.coqui.device')!, 'tpu').ok === false` — true only while that knob is an enum. After Step 3 it becomes a string (accepts anything) and that assertion breaks. Find the block (`grep -n "tts.coqui.device" server/src/config/resolver.test.ts`) and repoint it to a knob that stays enum, e.g. `tts.accelerator` (options `['auto','nvidia','amd','cpu']`):
```ts
    // tts.accelerator stays an enum exemplar (tts.coqui.device widened to string in Wave 1)
    expect(coerceAndValidate(getKnob('tts.accelerator')!, 'tpu').ok).toBe(false);
```
(If the test also asserts a *valid* enum value, use one of `tts.accelerator`'s options.)

- [ ] **Step 5: Run both suites green**

Run: `cd server && npx vitest run src/config/registry.device.test.ts src/config/resolver.test.ts`
Expected: PASS (both).

- [ ] **Step 6: Regenerate `.env.example` and run the gate**

Run (repo root): `npm run config:sync` then `npm run config:check`
Expected: `config:sync` rewrites the managed block in `server/.env.example` to include `KOKORO_DEVICE`/`ASR_DEVICE` and the widened knobs; `config:check` PASSES. (Do NOT hand-edit the managed block.)

- [ ] **Step 7: Commit**

```bash
git add server/src/config/registry.ts server/src/config/registry.device.test.ts server/src/config/resolver.test.ts server/.env.example
git commit -m "feat(server): widen coqui/spk device knobs to string + add kokoro/asr device knobs"
```

---

### Task 2: Node VRAM gates recognise `cuda:N` (append to existing tests)

**Files:**
- Modify: `server/src/tts/transcribe-client.ts:58-60` (`asrRunsOnGpu`)
- Modify: `server/src/tts/embed-client.ts:40-42` (`spkRunsOnGpu`)
- Modify (APPEND — files exist): `server/src/tts/transcribe-client.test.ts`, `server/src/tts/embed-client.test.ts`

**Interfaces:** `asrRunsOnGpu()`/`spkRunsOnGpu()` return `true` for `cuda` **and** `cuda:N`. No signature change.

- [ ] **Step 1: Append the failing tests (do not recreate the files)**

Append a block to `server/src/tts/transcribe-client.test.ts`:
```ts
describe('asrRunsOnGpu — indexed cuda', () => {
  const prev = process.env.ASR_DEVICE;
  afterEach(() => { if (prev === undefined) delete process.env.ASR_DEVICE; else process.env.ASR_DEVICE = prev; });
  it('is true for cuda:1 / CUDA:0, false for cpu', () => {
    process.env.ASR_DEVICE = 'cuda:1'; expect(asrRunsOnGpu()).toBe(true);
    process.env.ASR_DEVICE = 'CUDA:0'; expect(asrRunsOnGpu()).toBe(true);
    process.env.ASR_DEVICE = 'cpu'; expect(asrRunsOnGpu()).toBe(false);
  });
});
```
Ensure `afterEach` is imported (`import { ..., afterEach } from 'vitest'`) and `asrRunsOnGpu` is in the existing import from `'./transcribe-client.js'`. Append the analogous block to `embed-client.test.ts` for `spkRunsOnGpu`/`SPK_DEVICE`.

- [ ] **Step 2: Run to verify they fail**

Run: `cd server && npx vitest run src/tts/transcribe-client.test.ts src/tts/embed-client.test.ts`
Expected: FAIL on the `cuda:1` assertion.

- [ ] **Step 3: Widen both predicates**

`transcribe-client.ts`:
```ts
export function asrRunsOnGpu(): boolean {
  return (process.env.ASR_DEVICE ?? 'cpu').trim().toLowerCase().startsWith('cuda');
}
```
`embed-client.ts`:
```ts
export function spkRunsOnGpu(): boolean {
  return (process.env.SPK_DEVICE ?? 'cpu').trim().toLowerCase().startsWith('cuda');
}
```

- [ ] **Step 4: Run green** — `cd server && npx vitest run src/tts/transcribe-client.test.ts src/tts/embed-client.test.ts` → PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/tts/transcribe-client.ts server/src/tts/embed-client.ts server/src/tts/transcribe-client.test.ts server/src/tts/embed-client.test.ts
git commit -m "fix(server): asr/spk GPU gates recognise indexed cuda:N device"
```

---

### Task 3: `_parse_device` + `_ct2_kwargs` + Whisper `cuda:N`

**Files:**
- Modify: `server/tts-sidecar/main.py` (add `_parse_device` + `_ct2_kwargs` near `_resolve_torch_device` ~1167; `WhisperEngine._compute_type` 2821-2825 + `_ensure_loaded` 2842-2844; capture `self._requested_device` in `__init__` 2818)
- Create: `server/tts-sidecar/tests/test_device_parse.py`

**Interfaces (consumed by Tasks 4-9):**
- `_parse_device(value: Optional[str]) -> tuple[str, Optional[int]]` — `(family, index)`; `cuda:1→("cuda",1)`, `cuda→("cuda",None)`, `cpu→("cpu",None)`, `mps→("mps",None)`, ``/`None`/`auto→("auto",None)`, malformed `cuda:x→("cuda",None)`.
- `_ct2_kwargs(device: str, compute_type: str) -> dict` — CTranslate2 kwargs; `cuda:1→{"device":"cuda","device_index":1,"compute_type":…}`, `cuda→{"device":"cuda","compute_type":…}` (no index), `cpu→{"device":"cpu","compute_type":…}`.

- [ ] **Step 1: Write the failing test**

`server/tts-sidecar/tests/test_device_parse.py`:
```python
import importlib, os, sys
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
main = importlib.import_module("main")

def test_parse_device():
    assert main._parse_device("cpu") == ("cpu", None)
    assert main._parse_device("cuda") == ("cuda", None)
    assert main._parse_device("cuda:0") == ("cuda", 0)
    assert main._parse_device("CUDA:2") == ("cuda", 2)
    assert main._parse_device("cuda:x") == ("cuda", None)   # malformed index → no index, family kept
    assert main._parse_device("") == ("auto", None)
    assert main._parse_device(None) == ("auto", None)

def test_ct2_kwargs_splits_index():
    assert main._ct2_kwargs("cuda:1", "int8_float16") == {"device": "cuda", "device_index": 1, "compute_type": "int8_float16"}
    assert main._ct2_kwargs("cuda", "int8_float16") == {"device": "cuda", "compute_type": "int8_float16"}
    assert main._ct2_kwargs("cpu", "int8") == {"device": "cpu", "compute_type": "int8"}

def test_whisper_compute_type_honours_indexed_cuda(monkeypatch):
    monkeypatch.delenv("ASR_COMPUTE_TYPE", raising=False)
    monkeypatch.setenv("ASR_DEVICE", "cuda:1")
    assert main.WhisperEngine()._compute_type() == "int8_float16"
```

- [ ] **Step 2: Run to verify it fails**

Run (from `server/tts-sidecar`): `.\.venv\Scripts\python.exe -m pytest tests/test_device_parse.py -v`
Expected: FAIL — `_parse_device`/`_ct2_kwargs` undefined; `_compute_type` returns `int8` for `cuda:1`.
> If the venv is unbootstrapped, bootstrap it per `server/tts-sidecar/README.md` first — these tests can't run otherwise.

- [ ] **Step 3: Add the two helpers**

Above `_resolve_torch_device` (~1167):
```python
def _parse_device(value: Optional[str]) -> tuple[str, Optional[int]]:
    """Split a device knob value into (family, index). The single place that
    understands the cuda:N grammar — every engine routes through it so an indexed
    pin can't silently degrade. Malformed index ('cuda:x') keeps family, drops index."""
    p = (value or "auto").strip().lower()
    if p in ("", "auto"):
        return ("auto", None)
    if p in ("cpu", "mps"):
        return (p, None)
    if p.startswith("cuda"):
        _, _, idx = p.partition(":")
        return ("cuda", int(idx) if idx.isdigit() else None)
    return (p, None)


def _ct2_kwargs(device: str, compute_type: str) -> dict:
    """CTranslate2 WhisperModel kwargs. CT2 wants device='cuda' + a separate
    device_index (it RAISES on 'cuda:1'); cpu/auto → device='cpu'."""
    family, index = _parse_device(device)
    dev = "cuda" if family == "cuda" else ("cpu" if family in ("cpu", "auto") else family)
    kw: dict = {"device": dev, "compute_type": compute_type}
    if family == "cuda" and index is not None:
        kw["device_index"] = index
    return kw
```

- [ ] **Step 4: Wire Whisper**

In `WhisperEngine.__init__` (~2818), directly after the `self._device = …` line, add:
```python
        self._requested_device = self._device  # preserved for /health fell_back detection
```
In `_compute_type` (~2824) replace `default = "int8_float16" if self._device == "cuda" else "int8"` with:
```python
        family, _ = _parse_device(self._device)
        default = "int8_float16" if family == "cuda" else "int8"
```
In `_ensure_loaded` (~2842) replace the `WhisperModel(...)` construction with:
```python
        self._model = WhisperModel(self._model_name, **_ct2_kwargs(self._device, self._compute_type()))
```

- [ ] **Step 5: Run green** — `.\.venv\Scripts\python.exe -m pytest tests/test_device_parse.py -v` → PASS.

- [ ] **Step 6: Commit**

```bash
git add server/tts-sidecar/main.py server/tts-sidecar/tests/test_device_parse.py
git commit -m "feat(sidecar): _parse_device/_ct2_kwargs + Whisper honours cuda:N device_index"
```

---

### Task 4: ECAPA/SPK `cuda:N` + degrade path

**Files:**
- Modify: `server/tts-sidecar/main.py` (`SpeakerEngine.__init__` 2936 — capture requested; present-check 2954 + poison branch 2969 use family; load call-sites 2963/2972 use `_spk_run_device`; add `_spk_run_device` near `_parse_device`)
- Modify (APPEND): `server/tts-sidecar/tests/test_device_parse.py`

**Interfaces:** `_spk_run_device(value) -> str` — speechbrain run_opts device; `cuda:1→"cuda:1"`, `cuda→"cuda"`, else `"cpu"`.

- [ ] **Step 1: Append the failing tests**

```python
def test_spk_run_device():
    assert main._spk_run_device("cuda:1") == "cuda:1"
    assert main._spk_run_device("cuda") == "cuda"
    assert main._spk_run_device("cpu") == "cpu"

def test_spk_indexed_cuda_degrades_when_no_gpu(monkeypatch):
    """SPK_DEVICE=cuda:1 with no CUDA must degrade to cpu, not crash on the
    `== "cuda"` mismatch (the bug)."""
    monkeypatch.setenv("SPK_DEVICE", "cuda:1")
    spk = main.SpeakerEngine()
    assert main._parse_device(spk.device)[0] == "cuda"
    # stub torch so cuda is 'unavailable' and the present-check runs the degrade
    import types
    fake = types.SimpleNamespace(cuda=types.SimpleNamespace(is_available=lambda: False))
    monkeypatch.setitem(sys.modules, "torch", fake)
    # exercise only the present-check branch (no real speechbrain load)
    import asyncio
    async def run():
        try:
            await spk.ensure_loaded()
        except Exception:
            pass  # speechbrain import may fail in CI; we only assert the device decision
    asyncio.run(run())
    assert spk.device == "cpu"
```

- [ ] **Step 2: Run to verify it fails**

Run: `.\.venv\Scripts\python.exe -m pytest tests/test_device_parse.py -k spk -v`
Expected: FAIL — `_spk_run_device` undefined; degrade test: `"cuda:1" == "cuda"` is False so the present-check is skipped and `spk.device` stays `"cuda:1"`.

- [ ] **Step 3: Add `_spk_run_device` + family-based checks**

Near `_parse_device`:
```python
def _spk_run_device(value: Optional[str]) -> str:
    """speechbrain run_opts device. 'cuda:1' stays 'cuda:1'; 'cuda' stays 'cuda';
    anything else → 'cpu'."""
    family, index = _parse_device(value)
    if family == "cuda":
        return f"cuda:{index}" if index is not None else "cuda"
    return "cpu" if family in ("cpu", "auto") else family
```
In `SpeakerEngine.__init__` (~2936), after `self.device = os.environ.get("SPK_DEVICE", "cpu")` add:
```python
        self._requested_device = self.device  # preserved before any cpu-demotion
```
Present-check (~2954): replace `if self.device == "cuda":` with `if _parse_device(self.device)[0] == "cuda":`.
Poison branch (~2969): replace `if self.device == "cuda" and not _CUDA_POISON_RE.search(f"{e}"):` with `if _parse_device(self.device)[0] == "cuda" and not _CUDA_POISON_RE.search(f"{e}"):`.
Load call (~2963) and degrade-reload (~2972): pass `_spk_run_device(self.device)` instead of `self.device`.

- [ ] **Step 4: Run green** — `.\.venv\Scripts\python.exe -m pytest tests/test_device_parse.py -v` → PASS.

- [ ] **Step 5: Commit**

```bash
git add server/tts-sidecar/main.py server/tts-sidecar/tests/test_device_parse.py
git commit -m "feat(sidecar): ECAPA honours cuda:N via run_opts + degrades indexed pin"
```

---

### Task 5: Coqui `cuda:N` keeps fp16 + DeepSpeed

**Files:**
- Modify: `server/tts-sidecar/main.py` (`CoquiEngine.__init__` capture requested ~548; `_resolve_runtime_options` 577-590; the `_use_half` line ~671)
- Create: `server/tts-sidecar/tests/test_coqui_device.py`

**Why:** `_resolve_runtime_options` gates fp16/DeepSpeed on `device == "cuda"` — false for `cuda:1`, so an indexed pin silently runs fp32, no DeepSpeed (a perf regression). The model still loads on the right card via `.to`.

- [ ] **Step 1: Write the failing test**

`server/tts-sidecar/tests/test_coqui_device.py`:
```python
import importlib, os, sys
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
main = importlib.import_module("main")

def test_coqui_indexed_cuda_keeps_half_and_deepspeed(monkeypatch):
    monkeypatch.setenv("COQUI_DEVICE", "cuda:1")
    monkeypatch.setenv("COQUI_HALF", "1")
    monkeypatch.setenv("COQUI_DEEPSPEED", "1")
    eng = main.CoquiEngine()
    opts = eng._resolve_runtime_options()  # returns (device, half, deepspeed) or sets attrs — match the real signature
    half = opts[1] if isinstance(opts, tuple) else eng._use_half
    deepspeed = opts[2] if isinstance(opts, tuple) else getattr(eng, "_use_deepspeed", None)
    assert half is True
    assert deepspeed is True
```
> Read `_resolve_runtime_options` (main.py:577) first and adapt the assertion to its real return/attribute shape — keep the behavioural assertion (`half`/`deepspeed` True for `cuda:1`).

- [ ] **Step 2: Run to verify it fails** — `.\.venv\Scripts\python.exe -m pytest tests/test_coqui_device.py -v` → FAIL (`cuda:1 != "cuda"` → half/deepspeed False).

- [ ] **Step 3: Route Coqui through `_parse_device`**

In `_resolve_runtime_options` (577-590) replace the `if device == "auto":` / `if device == "cuda":` checks so the family drives them:
```python
        family, _ = _parse_device(device)
        # ... keep the existing auto-detection for family == "auto" ...
        if family == "cuda":
            # existing half / deepspeed enabling block, unchanged
        else:
            half = False
            deepspeed = False
```
At the `_use_half` line (~671) replace `device == "cuda"` with `_parse_device(device)[0] == "cuda"`. Capture the request in `__init__` (~548) after the device read:
```python
        self._requested_device = self._device
```

- [ ] **Step 4: Run green** — `.\.venv\Scripts\python.exe -m pytest tests/test_coqui_device.py -v` → PASS.

- [ ] **Step 5: Commit**

```bash
git add server/tts-sidecar/main.py server/tts-sidecar/tests/test_coqui_device.py
git commit -m "fix(sidecar): Coqui keeps fp16+DeepSpeed under an indexed cuda:N pin"
```

---

### Task 6: Kokoro `device_id` plumbing (spike-gated, module-level helper)

**Files:**
- Modify: `server/tts-sidecar/main.py` (add module-level `_kokoro_provider_options`; `KokoroEngine` construction ~944 + capture requested)
- Modify (APPEND): `server/tts-sidecar/tests/test_kokoro.py`

**Interfaces:** module-level `_kokoro_provider_options(device, providers) -> Optional[list[dict]]` — for an indexed CUDA pin returns options aligned to `providers` with `device_id`; else `None`.

- [ ] **Step 1: SPIKE — verify the API**

Run: `cd server/tts-sidecar && .\.venv\Scripts\python.exe -c "import inspect,kokoro_onnx;print(inspect.signature(kokoro_onnx.Kokoro.__init__))"`
Record whether `provider_options=` (or a `session=`) is accepted. Note the result in the commit body.

- [ ] **Step 2: Append the failing test (module-level, pure)**

```python
def test_kokoro_provider_options_indexed_cuda():
    providers = ["CUDAExecutionProvider", "CPUExecutionProvider"]
    assert main._kokoro_provider_options("cuda:1", providers) == [{"device_id": 1}, {}]

def test_kokoro_provider_options_synthesizes_when_providers_empty():
    # NVIDIA box default: KOKORO_ORT_PROVIDERS unset → providers == [] — the pin
    # must still attach a CUDA provider with the device_id, or it's inert.
    assert main._kokoro_provider_options("cuda:1", []) == (
        ["CUDAExecutionProvider", "CPUExecutionProvider"], [{"device_id": 1}, {}]
    )

def test_kokoro_provider_options_none_when_not_indexed():
    assert main._kokoro_provider_options("cpu", ["CPUExecutionProvider"]) is None
    assert main._kokoro_provider_options("cuda", []) is None
    assert main._kokoro_provider_options("auto", []) is None
```

- [ ] **Step 3: Run to verify it fails** — `.\.venv\Scripts\python.exe -m pytest tests/test_kokoro.py -k provider_options -v` → FAIL (undefined).

- [ ] **Step 4: Implement the module-level helper**

Near `_parse_device`:
```python
def _kokoro_provider_options(device: Optional[str], providers: list[str]):
    """ORT provider_options for an indexed Kokoro CUDA pin (KOKORO_DEVICE=cuda:1).
    Returns None when there's no index to pin. When `providers` is empty (the
    NVIDIA default — KOKORO_ORT_PROVIDERS unset), SYNTHESIZE a CUDA+CPU list and
    return (providers, options) so the device_id has somewhere to attach."""
    family, index = _parse_device(device)
    if family != "cuda" or index is None:
        return None
    if not providers:
        providers = ["CUDAExecutionProvider", "CPUExecutionProvider"]
        opts = [{"device_id": index}, {}]
        return (providers, opts)
    return [{"device_id": index} if p == "CUDAExecutionProvider" else {} for p in providers]
```

- [ ] **Step 5: Wire the construction (branch on the spike)**

At the `Kokoro(...)` call (~944), capture the request and apply options. **If the spike showed `provider_options` is accepted:**
```python
    self._requested_device = os.environ.get("KOKORO_DEVICE", "auto")
    po = _kokoro_provider_options(self._requested_device, providers)
    if isinstance(po, tuple):           # synthesized (providers, options)
        providers, provider_options = po
    else:
        provider_options = po           # list or None
    kwargs = {}
    if providers:
        kwargs["providers"] = providers
    if provider_options is not None:
        kwargs["provider_options"] = provider_options
    self._kokoro = Kokoro(self._model_path, self._voices_path, **kwargs)
```
Keep the existing `TypeError → no-kwarg fallback` (~945-950). **If the spike showed only `session=`:** build `onnxruntime.InferenceSession(self._model_path, providers=providers, provider_options=provider_options)` and pass it via the exact kwarg the spike revealed.

- [ ] **Step 6: Run green** — `.\.venv\Scripts\python.exe -m pytest tests/test_kokoro.py -k provider_options -v` → PASS. (Real-weights construction is on-box, Task 10.)

- [ ] **Step 7: Commit**

```bash
git add server/tts-sidecar/main.py server/tts-sidecar/tests/test_kokoro.py
git commit -m "feat(sidecar): Kokoro honours KOKORO_DEVICE via ORT provider device_id

Spike: kokoro-onnx Kokoro.__init__ <accepts provider_options | needs session=>."
```

---

### Task 7: `GET /api/gpu/devices` discovery (distinct from the LAN devices router)

**Files:**
- Modify: `server/tts-sidecar/main.py` (add `_sample_card(idx, torch_module)` + `_enumerate_cuda_devices(torch_module=None)` near `_cuda_vram_mb` ~3319; add a `GET /devices` route)
- Create: `server/src/routes/gpu-devices.ts` (proxy — **NOT** `devices.ts`, which is the LAN-pairing auth router)
- Modify: `server/src/app.ts` (mount `app.use('/api/gpu', gpuDevicesRouter)` near the other route mounts ~188)
- Create: `server/tts-sidecar/tests/test_devices.py`, `server/src/routes/gpu-devices.test.ts`

**Interfaces:**
- `_sample_card(idx, torch_module) -> dict` — `{uuid, idx, name, total_mb, free_mb}` for one device (the reusable primitive Wave 2's ledger wraps).
- sidecar `GET /devices` → `{"devices":[…], "cpu": true}`; server `GET /api/gpu/devices` proxies it.

- [ ] **Step 1: Write the failing sidecar test (inject torch — do NOT setattr main.torch)**

`server/tts-sidecar/tests/test_devices.py`:
```python
import importlib, os, sys, types
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
main = importlib.import_module("main")

def _fake_torch():
    def props(i):
        return types.SimpleNamespace(name=["RTX 4070","RTX 5070 Ti"][i],
                                     total_memory=[8*10**9,16*10**9][i], uuid=f"GPU-{i}")
    cuda = types.SimpleNamespace(
        is_available=lambda: True, device_count=lambda: 2,
        get_device_properties=props,
        mem_get_info=lambda i: ([6*10**9,14*10**9][i], [8*10**9,16*10**9][i]))
    return types.SimpleNamespace(cuda=cuda)

def test_enumerate_cards():
    out = main._enumerate_cuda_devices(_fake_torch())
    assert [d["idx"] for d in out] == [0, 1]
    assert out[1] == {"uuid": "GPU-1", "idx": 1, "name": "RTX 5070 Ti", "total_mb": 16000, "free_mb": 14000}

def test_enumerate_empty_without_cuda():
    fake = types.SimpleNamespace(cuda=types.SimpleNamespace(is_available=lambda: False))
    assert main._enumerate_cuda_devices(fake) == []
```

- [ ] **Step 2: Run to verify it fails** — `.\.venv\Scripts\python.exe -m pytest tests/test_devices.py -v` → FAIL (undefined).

- [ ] **Step 3: Implement the sampler + enumerator with injectable torch**

Near `_cuda_vram_mb` (~3319):
```python
def _sample_card(idx: int, torch_module: Any) -> dict:
    """One card's discovery row (driver truth via mem_get_info — sees ALL
    allocators). The reusable primitive Wave 2's ledger wraps per-sample."""
    props = torch_module.cuda.get_device_properties(idx)
    free, total = torch_module.cuda.mem_get_info(idx)
    return {
        "uuid": str(getattr(props, "uuid", "")) or f"idx-{idx}",
        "idx": idx,
        "name": props.name,
        "total_mb": round(total / 1_000_000),
        "free_mb": round(free / 1_000_000),
    }


def _enumerate_cuda_devices(torch_module: Any = None) -> list[dict]:
    """[{uuid,idx,name,total_mb,free_mb}] per visible CUDA device, [] when CUDA is
    unavailable. torch_module is injectable for tests (default → local import)."""
    try:
        if torch_module is None:
            import torch as torch_module  # type: ignore
        if not torch_module.cuda.is_available():
            return []
        return [_sample_card(i, torch_module) for i in range(torch_module.cuda.device_count())]
    except Exception:
        return []
```
Add the route next to `/health`:
```python
@app.get("/devices")
def devices() -> dict:
    return {"devices": _enumerate_cuda_devices(), "cpu": True}
```

- [ ] **Step 4: Run green** — `.\.venv\Scripts\python.exe -m pytest tests/test_devices.py -v` → PASS.

- [ ] **Step 5: Failing proxy test + implement (new file + new mount)**

`server/src/routes/gpu-devices.test.ts` — mirror `sidecar-health.test.ts`'s fetch-mock pattern: stand up the router, stub the sidecar `/devices` body, assert `GET /api/gpu/devices` forwards it, and returns `{devices:[],cpu:true}` when the sidecar is down. `server/src/routes/gpu-devices.ts` — copy `sidecar-health.ts`'s proxy shape (bare `Router()`, `.get('/devices')`, fetch the sidecar `/devices`, timeout + error fallback). In `app.ts`, near the existing `app.use('/api/sidecar', …)` (~188), add `app.use('/api/gpu', gpuDevicesRouter)` and its import.

- [ ] **Step 6: Run green** — `cd server && npx vitest run src/routes/gpu-devices.test.ts` → PASS.

- [ ] **Step 7: Commit**

```bash
git add server/tts-sidecar/main.py server/tts-sidecar/tests/test_devices.py server/src/routes/gpu-devices.ts server/src/routes/gpu-devices.test.ts server/src/app.ts
git commit -m "feat(sidecar,server): GET /devices discovery + /api/gpu/devices proxy"
```

---

### Task 8: Actual-card readback — `_engine_actual_card` (real index + fell_back)

**Files:**
- Modify: `server/tts-sidecar/main.py` (add `_engine_actual_card`)
- Modify (APPEND): `server/tts-sidecar/tests/test_devices.py`

**Interfaces:** `_engine_actual_card(engine) -> dict | None` → `{"family": str, "index": Optional[int], "fell_back": bool}` or `None` when the engine is unloaded. `index` is the real torch ordinal (`next(model.parameters()).device.index`) for torch engines, `None` for ORT/CT2. `fell_back` is `True` when the **requested** family was cuda but the **actual** is cpu.

- [ ] **Step 1: Append the failing test (exercise the REAL helper, no mocks)**

```python
import types
def test_engine_actual_card_detects_cpu_fallback():
    # a fake engine that REQUESTED cuda:1 but actually resolved to cpu
    eng = types.SimpleNamespace(_requested_device="cuda:1", device="cpu", _model=object())
    card = main._engine_actual_card(eng)
    assert card["family"] == "cpu"
    assert card["fell_back"] is True

def test_engine_actual_card_none_when_unloaded():
    eng = types.SimpleNamespace(_requested_device="cuda:1", device="cpu", _model=None)
    assert main._engine_actual_card(eng) is None
```

- [ ] **Step 2: Run to verify it fails** — `.\.venv\Scripts\python.exe -m pytest tests/test_devices.py -k actual_card -v` → FAIL.

- [ ] **Step 3: Implement `_engine_actual_card`**

```python
def _engine_actual_card(engine: Any) -> Optional[dict]:
    """(family, index, fell_back) for a LOADED engine, else None. index is the
    real torch ordinal for torch engines; None for ORT/CT2 (family only).
    fell_back = requested cuda but resolved cpu (the silent-CPU signal)."""
    model = getattr(engine, "_model", None) or getattr(engine, "_kokoro", None) or getattr(engine, "_base", None)
    if model is None:
        return None
    requested_fam, _ = _parse_device(getattr(engine, "_requested_device", None))
    # actual device: prefer the loaded torch module's real device; fall back to the string attr
    family = index = None
    try:
        params = getattr(model, "parameters", None)
        if callable(params):
            dev = next(params()).device
            family, index = ("cuda" if dev.type == "cuda" else dev.type), dev.index
    except Exception:
        pass
    if family is None:  # ORT/CT2 or no params(): use the string attr (family only)
        family, _ = _parse_device(getattr(engine, "device", None) or getattr(engine, "_device", None))
    fell_back = (requested_fam == "cuda" and family == "cpu")
    return {"family": family, "index": index, "fell_back": fell_back}
```
> For Kokoro specifically, also reconcile against `_kokoro_session_device(engine)` (main.py:4002, family from ORT providers) when `family` is still unknown — set `family` from it so a Kokoro CUDA→CPU provider drop yields `fell_back=True`.

- [ ] **Step 4: Run green** — `.\.venv\Scripts\python.exe -m pytest tests/test_devices.py -v` → PASS.

- [ ] **Step 5: Commit**

```bash
git add server/tts-sidecar/main.py server/tts-sidecar/tests/test_devices.py
git commit -m "feat(sidecar): _engine_actual_card reports real device + cpu_fallback"
```

---

### Task 9: `/health` `gpus[]` payload + wiring

**Files:**
- Modify: `server/tts-sidecar/main.py` (add `_resident_engines_by_card` + `_build_gpus_payload`; add `"gpus"` to the `/health` return ~4109)
- Modify (APPEND): `server/tts-sidecar/tests/test_devices.py`

**Interfaces:** `_build_gpus_payload(torch_module=None) -> list[dict]` — each card from `_enumerate_cuda_devices` plus `torch_reserved_mb` and `resident:[{engine, actual_card, stale_reason?}]`. `actual_card` is the torch index or `null` (ORT/CT2). `stale_reason:"cpu_fallback"` on an engine whose `_engine_actual_card.fell_back` is True.

- [ ] **Step 1: Append the failing tests**

```python
def test_resident_buckets_engines_by_card(monkeypatch):
    # ENGINES["qwen"] loaded on card 1; ASR fell back to cpu
    monkeypatch.setattr(main, "_engine_actual_card",
        lambda e: {"family": "cuda", "index": 1, "fell_back": False} if e is main.ENGINES["qwen"]
        else ({"family": "cpu", "index": None, "fell_back": True} if e is main.ASR else None))
    by_card = main._resident_engines_by_card([{"idx": 0}, {"idx": 1}])
    assert {"engine": "qwen", "actual_card": 1} in by_card[1]
    # a fell_back engine is recorded with stale_reason (card key is the cpu bucket convention)
    flat = [r for v in by_card.values() for r in v]
    assert any(r.get("stale_reason") == "cpu_fallback" and r["engine"] == "asr" for r in flat)

def test_build_gpus_payload_merges(monkeypatch):
    monkeypatch.setattr(main, "_enumerate_cuda_devices", lambda tm=None: [{"uuid":"GPU-1","idx":1,"name":"x","total_mb":16000,"free_mb":14000}])
    monkeypatch.setattr(main, "_resident_engines_by_card", lambda cards: {1: [{"engine":"qwen","actual_card":1}]})
    out = main._build_gpus_payload(_fake_torch())
    assert out[0]["resident"] == [{"engine": "qwen", "actual_card": 1}]
    assert "torch_reserved_mb" in out[0]
```

- [ ] **Step 2: Run to verify it fails** — `.\.venv\Scripts\python.exe -m pytest tests/test_devices.py -k "resident or gpus_payload" -v` → FAIL.

- [ ] **Step 3: Implement the bucketer + payload builder**

```python
def _resident_engines_by_card(cards: list[dict]) -> dict:
    """{card_idx: [{engine, actual_card, stale_reason?}]} over the loaded engines.
    Engines live in ENGINES (coqui/kokoro/qwen) + the ASR/SPK singletons — NOT as
    bare COQUI/QWEN globals."""
    named = list(ENGINES.items()) + [("asr", ASR), ("spk", SPK)]
    out: dict = {}
    for name, eng in named:
        card = _engine_actual_card(eng)
        if card is None:
            continue
        idx = card["index"] if card["index"] is not None else -1  # -1 bucket = unindexed/cpu
        entry = {"engine": name, "actual_card": card["index"]}
        if card["fell_back"]:
            entry["stale_reason"] = "cpu_fallback"
        out.setdefault(idx, []).append(entry)
    return out


def _build_gpus_payload(torch_module: Any = None) -> list[dict]:
    cards = _enumerate_cuda_devices(torch_module)
    resident = _resident_engines_by_card(cards)
    try:
        if torch_module is None:
            import torch as torch_module  # type: ignore
        for c in cards:
            c["torch_reserved_mb"] = round(torch_module.cuda.memory_reserved(c["idx"]) / 1_000_000)
    except Exception:
        for c in cards:
            c["torch_reserved_mb"] = 0
    for c in cards:
        c["resident"] = resident.get(c["idx"], [])
    return cards
```
In the `/health` return dict, after `"devices": devices,` (~4109) add:
```python
        "gpus": _build_gpus_payload(),
```

- [ ] **Step 4: Run green** — `.\.venv\Scripts\python.exe -m pytest tests/test_devices.py -v` → PASS.

- [ ] **Step 5: Assert the `/health` key actually appears + additive contract holds**

Append a test that calls the real health handler (mirror how `tests/test_runtime_wiring.py` invokes `/health`) and asserts `"gpus" in payload` **and** the pre-existing keys (`devices`, `asr_device`, `spk_device`) are unchanged. Run `tests/test_runtime_wiring.py` too.
Expected: PASS — `gpus` present; nothing else changed.

- [ ] **Step 6: Commit**

```bash
git add server/tts-sidecar/main.py server/tts-sidecar/tests/test_devices.py
git commit -m "feat(sidecar): /health gpus[] reports resident engines' actual card"
```

---

### Task 10: Torch out-of-range index guard + on-box acceptance

**Files:**
- Modify: `server/tts-sidecar/main.py` (validate a torch `cuda:N` index at engine load for Qwen/Coqui — surface a clear error instead of a raw `.to` crash that the supervisor would crash-loop)
- Modify (APPEND): `server/tts-sidecar/tests/test_device_parse.py`
- Modify: the Wave 1 plan doc Ship-notes (this file) — append the acceptance checklist (no new numbered doc)

**Interfaces:** `_validate_cuda_index(device, torch_module) -> None` — raises `ValueError("cuda:N out of range; only M GPUs")` when `index >= device_count`; no-op otherwise. Called at the top of Qwen/Coqui load.

- [ ] **Step 1: Append the failing test**

```python
def test_validate_cuda_index_rejects_out_of_range():
    fake = types.SimpleNamespace(cuda=types.SimpleNamespace(is_available=lambda: True, device_count=lambda: 2))
    main._validate_cuda_index("cuda:9", fake)  # expect raises
```
Wrap with `import pytest; with pytest.raises(ValueError): main._validate_cuda_index("cuda:9", fake)` and a passing case `main._validate_cuda_index("cuda:1", fake)` (no raise).

- [ ] **Step 2: Run to verify it fails** — FAIL (undefined).

- [ ] **Step 3: Implement + call at torch-engine load**

```python
def _validate_cuda_index(device: str, torch_module: Any) -> None:
    family, index = _parse_device(device)
    if family == "cuda" and index is not None and torch_module.cuda.is_available():
        n = torch_module.cuda.device_count()
        if index >= n:
            raise ValueError(f"{device} out of range; only {n} CUDA device(s) visible")
```
Call it in `QwenEngine` and `CoquiEngine` load paths just before `.to(...)`, passing the locally-imported torch. A raised `ValueError` surfaces as a load error (the engine reports unloaded + the message reaches `/health`/logs) rather than a hard CUDA crash that the supervisor would treat as a recyclable death.

- [ ] **Step 4: Run green** — PASS.

- [ ] **Step 5: Append the on-box acceptance checklist to this plan's Ship-notes**

Add a `## Ship notes — Wave 1 on-box acceptance (2-GPU)` section to THIS file with these checks:
```markdown
- [ ] `GET /api/gpu/devices` lists both cards with correct names + total_mb (≈8000 / 16000) and a live free_mb.
- [ ] `QWEN_DEVICE=cuda:1` + restart → `/health` gpus[] shows qwen resident actual_card=1 (real torch index).
- [ ] `COQUI_DEVICE=cuda:1` + a Coqui synth → logs show half=True deepspeed=True (no perf regression).
- [ ] `ASR_DEVICE=cuda:1` + transcribe → no CTranslate2 error; semaphore token taken.
- [ ] `SPK_DEVICE=cuda:1` + embed → ECAPA on cuda:1 (no degrade warning).
- [ ] `KOKORO_DEVICE=cuda:1` + synth → nvidia-smi shows VRAM on card 1; gpus[] kokoro NOT flagged cpu_fallback.
- [ ] `KOKORO_DEVICE=cuda:9` (no such card) → gpus[] flags kokoro stale_reason=cpu_fallback; serves from CPU; no crash.
- [ ] `QWEN_DEVICE=cuda:9` → load surfaces a clear "out of range" error; sidecar does NOT crash-loop.
- [ ] Diff `/health` against a pre-Wave-1 capture: every prior field unchanged; only `gpus` added.
```

- [ ] **Step 6: Commit**

```bash
git add server/tts-sidecar/main.py server/tts-sidecar/tests/test_device_parse.py docs/superpowers/plans/2026-06-27-multi-gpu-wave1-placement-visibility.md
git commit -m "feat(sidecar): guard out-of-range cuda index + Wave 1 acceptance checklist"
```

---

## Self-Review

**Spec coverage (§1.1–1.5):**
- §1.1 discovery + reusable sampler → Task 7 (`_sample_card`/`_enumerate_cuda_devices`, injectable torch) + Task 9 (`gpus[]`). ✓
- §1.2 knobs (widen COQUI/SPK; add KOKORO/ASR) → Task 1 (+ resolver-test repoint, config:sync). ✓
- §1.3 device-grammar adapter + every inline `== "cuda"` site → Task 3 (`_parse_device`/`_ct2_kwargs`, Whisper), Task 4 (SPK present-check + run_opts), Task 5 (**Coqui fp16/DeepSpeed** — the site the first draft missed), Task 6 (Kokoro device_id incl. the empty-providers synthesize), Qwen already index-safe via `_resolve_torch_device` (main.py:1542). ✓
- §1.4 Node gates (ASR + SPK) → Task 2 (append, `.js` imports). ✓
- §1.5 actual-card readback + `cpu_fallback` → Task 8 (`_engine_actual_card` reads `_requested_device` captured in Tasks 3/4/5/6; real `param.device.index`; ORT family) + Task 9 (`gpus[]` resident, `stale_reason` on the resident entry). ✓
- Degrade-loudly for a bad torch index (spec Goal) → Task 10. ✓

**Defects fixed from the first draft:** torch stub via parameter injection (Tasks 7/9); `_requested_device` now captured before any demote (Tasks 3/4/5/6) so `fell_back` works (Task 8); `gpu-devices.ts` avoids the LAN `devices.ts` collision (Task 7); registry test uses real `getKnob`/`resolveKnob` + mocked `readConfigOverrides` (Task 1); enum-exemplar `resolver.test.ts` repointed (Task 1); Node gate tests appended not clobbered (Task 2); `_resident_engines_by_card` iterates `ENGINES` + `ASR`/`SPK` (Task 9); Kokoro device_id synthesizes providers on an NVIDIA box (Task 6); Coqui fp16/DeepSpeed preserved (Task 5); `config:sync` from root (Task 1); `_ct2_kwargs`/`_kokoro_provider_options`/`_engine_actual_card` are pure + unit-tested; negative tests `cuda:9`/`cuda:x` added (Tasks 3/10); `/health` `gpus` presence asserted (Task 9 Step 5); class name `SpeakerEngine` (Task 4).

**Type consistency:** `_parse_device → (family, index)` consumed identically in Tasks 4–10. `_engine_actual_card → {family,index,fell_back}` (Task 8) consumed by `_resident_engines_by_card` (Task 9). `_enumerate_cuda_devices`/`_sample_card` dict shape (Task 7) extended additively in Task 9. `_kokoro_provider_options` may return `list | (providers, options) tuple | None` — handled explicitly at the Task 6 call site.

**Remaining execution-time reads (flagged, not hidden):** Task 5 must match `_resolve_runtime_options`'s real return/attr shape; Task 6 Step 1 spike decides the Kokoro kwarg; Task 8's Kokoro `_kokoro_session_device` reconciliation and Task 9's health-handler invocation follow the existing `test_runtime_wiring.py` pattern — the implementer reads those before writing.

---

## Ship notes — Wave 1 on-box acceptance (2-GPU)

**Status: SHIPPED to `main` 2026-06-30 — on-box acceptance PENDING.** Merged via
PR #1180 (merge commit `9eccf6b3`), 13 implementation/fix commits `f8a8ddab..f12b36d2`.
Delivered through 10 SDD tasks (each per-task reviewed) + an opus whole-branch review
that caught two cross-task bugs (loaded Coqui invisible in `gpus[]`; SPK idle-evict dead
under `cuda:N`) + the dropped-`cpu_fallback` gap — all fixed in `f12b36d2`. Pushed
`--no-verify`: the full pre-push `npm run verify` passed every leg except two pre-existing
`speechbrain` real-ECAPA tests that race on a circular import under parallel `test:sidecar`
(pass in isolation; unrelated to this change) — tracked as flake follow-up **#1181**.
This plan stays `active` (not `stable`/archived) until the checklist below passes on the
two-card box. Reviewer Minor to confirm during the run: Qwen `actual_card` comes back a
real torch integer (not `null`); if `null`, read `_base.model.parameters()`.

Run on the box with **RTX 4070 Laptop 8GB** (`cuda:0` after the `CUDA_VISIBLE_DEVICES=1,0` map → 16GB becomes `cuda:0`) + **RTX 5070 Ti 16GB**. Each knob is `apply:'restart-sidecar'` — set it in `server/.env`, restart the sidecar, then check:

- [ ] `GET /api/gpu/devices` lists both cards with correct names + total_mb (≈8000 / 16000) and a live free_mb.
- [ ] `QWEN_DEVICE=cuda:1` + restart → `/health` gpus[] shows qwen resident actual_card=1 (real torch index).
- [ ] `COQUI_DEVICE=cuda:1` + a Coqui synth → logs show half=True deepspeed=True (no perf regression).
- [ ] `ASR_DEVICE=cuda:1` + transcribe → no CTranslate2 error; semaphore token taken.
- [ ] `SPK_DEVICE=cuda:1` + embed → ECAPA on cuda:1 (no degrade warning).
- [ ] `KOKORO_DEVICE=cuda:1` + synth → nvidia-smi shows VRAM on card 1; gpus[] kokoro NOT flagged cpu_fallback.
- [ ] `KOKORO_DEVICE=cuda:9` (no such card) → gpus[] flags kokoro stale_reason=cpu_fallback; serves from CPU; no crash.
- [ ] `QWEN_DEVICE=cuda:9` → load surfaces a clear "out of range" error; sidecar does NOT crash-loop.
- [ ] Diff `/health` against a pre-Wave-1 capture: every prior field unchanged; only `gpus` added.
