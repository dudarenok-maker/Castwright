# side-14 Device Ground-Truth Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The sidecar reports every engine's actual/predicted torch device (cuda/mps/cpu) on `/health` regardless of load state; Node forwards it; the fs-43 panel says "Currently running on: X" with per-engine rows.

**Architecture:** A background probe at sidecar startup imports torch/onnxruntime once and caches per-engine device predictions computed by each engine's *own* resolver; `/health` composes the map at read time with loaded-engine actuals overriding predictions. `/api/info` lifts the map off its existing single `/health` fetch and adds the Node-resolved `activeEngine`; the panel upgrades with graceful degradation to today's copy.

**Tech Stack:** Python/FastAPI sidecar (pytest), Node/Express (Vitest), React/TS (Vitest + Playwright).

**Spec:** `docs/superpowers/specs/2026-06-10-side14-device-ground-truth-design.md` (issue #707).

**Branch:** `feat/side-device-ground-truth` off `main`, in an isolated worktree.
**Worktree gotchas (this repo):** junction `node_modules` AND `server\node_modules` from the main checkout (PowerShell `New-Item -ItemType Junction`); husky can't spawn from a worktree — do NOT `--no-verify`; instead `git config extensions.worktreeConfig true`, create `.husky-wt/` with shebang'd wrappers (`#!/usr/bin/env sh` + `. "C:/Claude/Projects/Audiobook-Generator/.husky/<hook>"`), then `git config --worktree core.hooksPath <wt>/.husky-wt`. The sidecar venv lives in the MAIN checkout — run pytest via the absolute venv python: `C:\Claude\Projects\Audiobook-Generator\server\tts-sidecar\.venv\Scripts\python.exe -m pytest <wt>\server\tts-sidecar\tests\... ` with `cwd` = `<wt>\server\tts-sidecar`.

---

### Task 0: Branch + spec commit

**Files:**
- Create (copy): `docs/superpowers/specs/2026-06-10-side14-device-ground-truth-design.md`

- [ ] **Step 1: Cut the branch in your worktree**

```bash
git branch -m feat/side-device-ground-truth   # rename the auto worktree branch
```

- [ ] **Step 2: Bring the spec into the worktree**

The spec exists UNTRACKED in the main checkout only. Copy it byte-for-byte:

```powershell
Copy-Item "C:\Claude\Projects\Audiobook-Generator\docs\superpowers\specs\2026-06-10-side14-device-ground-truth-design.md" "<wt>\docs\superpowers\specs\" -Force
```

- [ ] **Step 3: Commit**

```bash
git add docs/superpowers/specs/2026-06-10-side14-device-ground-truth-design.md
git commit -m "docs(docs): side-14 device ground-truth design spec"
```

---

### Task 1: Sidecar — probe state, normaliser, prediction functions (TDD)

**Files:**
- Modify: `server/tts-sidecar/main.py` (new module-level block; put it right BEFORE the `@app.get("/health")` route, ~line 2510)
- Create: `server/tts-sidecar/tests/test_device_probe.py`

- [ ] **Step 1: Write the failing tests**

Create `server/tts-sidecar/tests/test_device_probe.py`. Copy the sys.path bootstrap from the top of `tests/test_kokoro.py` (the block ending `import main  # noqa: E402`). Torch-stub pattern follows `tests/test_qwen_device.py`.

```python
"""side-14 — per-engine device ground-truth probe + /health composition."""
# <sys.path bootstrap copied from test_kokoro.py>
import main  # noqa: E402


class _StubCuda:
    def __init__(self, available: bool) -> None:
        self._available = available

    def is_available(self) -> bool:
        return self._available


class _StubMps:
    def __init__(self, available: bool) -> None:
        self._available = available

    def is_available(self) -> bool:
        return self._available


class _StubBackends:
    def __init__(self, mps_available: bool) -> None:
        self.mps = _StubMps(mps_available)


class _StubTorch:
    def __init__(self, cuda: bool = False, mps: bool = False) -> None:
        self.cuda = _StubCuda(cuda)
        self.backends = _StubBackends(mps)


class _StubOrt:
    def __init__(self, providers: list[str]) -> None:
        self._providers = providers

    def get_available_providers(self) -> list[str]:
        return self._providers


def test_normalize_device_family() -> None:
    assert main._normalize_device_family("cuda:0") == "cuda"
    assert main._normalize_device_family("cuda:1") == "cuda"
    assert main._normalize_device_family("mps") == "mps"
    assert main._normalize_device_family("CPU") == "cpu"
    assert main._normalize_device_family("auto") is None  # unresolved pref is not truth
    assert main._normalize_device_family(None) is None
    assert main._normalize_device_family("") is None


def test_predictions_cuda_box() -> None:
    out = main._compute_device_predictions(
        _StubTorch(cuda=True), _StubOrt(["CUDAExecutionProvider", "CPUExecutionProvider"])
    )
    assert out == {"kokoro": "cuda", "coqui": "cuda", "qwen": "cuda"}


def test_predictions_apple_silicon() -> None:
    """The headline case: Qwen rides Metal, Coqui/Kokoro honestly report CPU."""
    out = main._compute_device_predictions(_StubTorch(mps=True), _StubOrt(["CPUExecutionProvider"]))
    assert out == {"kokoro": "cpu", "coqui": "cpu", "qwen": "mps"}


def test_predictions_cpu_only() -> None:
    out = main._compute_device_predictions(_StubTorch(), _StubOrt(["CPUExecutionProvider"]))
    assert out == {"kokoro": "cpu", "coqui": "cpu", "qwen": "cpu"}


def test_predictions_explicit_pin_normalised(monkeypatch) -> None:
    qwen = main.ENGINES.get("qwen")
    monkeypatch.setattr(qwen, "_device_pref", "cuda:1")
    out = main._compute_device_predictions(_StubTorch(cuda=True), _StubOrt([]))
    assert out["qwen"] == "cuda"


def test_predictions_without_torch_still_predict_kokoro() -> None:
    out = main._compute_device_predictions(None, _StubOrt(["CUDAExecutionProvider"]))
    assert out["kokoro"] == "cuda"
    assert out["coqui"] is None
    assert out["qwen"] is None


def test_predictions_ort_failure_is_tolerated() -> None:
    class _BrokenOrt:
        def get_available_providers(self):  # noqa: ANN201
            raise RuntimeError("ort exploded")

    out = main._compute_device_predictions(_StubTorch(cuda=True), _BrokenOrt())
    assert out["kokoro"] == "cpu"  # degrade, never raise
```

- [ ] **Step 2: Run tests to verify they fail**

```powershell
& C:\Claude\Projects\Audiobook-Generator\server\tts-sidecar\.venv\Scripts\python.exe -m pytest tests/test_device_probe.py -v
```

(from `<wt>\server\tts-sidecar`). Expected: FAIL — `AttributeError: module 'main' has no attribute '_normalize_device_family'`. If the venv isn't bootstrapped the harness banner says SKIP — report that instead of faking a pass.

- [ ] **Step 3: Implement in `main.py`**

Insert immediately before the `/health` route (after `_qwen_install_state`, ~line 2510):

```python
# --- side-14: per-engine device ground-truth -------------------------------
# A background startup probe imports torch/onnxruntime ONCE and caches what
# device each engine WOULD resolve to, using each engine's own resolver so the
# prediction can't drift from load-time reality. /health composes the map at
# read time with loaded-engine actuals overriding predictions. The probe adds
# torch's ~300-500 MB committed footprint at boot — paid anyway the moment a
# torch engine loads, and far below every recycle ceiling.
_device_probe: dict[str, Optional[str]] = {"kokoro": None, "coqui": None, "qwen": None}
_device_probe_state: str = "pending"  # 'pending' | 'ready' | 'error'


def _normalize_device_family(raw: Optional[str]) -> Optional[str]:
    """'cuda:0'/'cuda:1' → 'cuda'; mps/cpu pass through; anything else (None,
    '', an unresolved 'auto' pref) → None so callers fall back to prediction."""
    if not raw:
        return None
    fam = str(raw).strip().lower().split(":", 1)[0]
    return fam if fam in ("cuda", "mps", "cpu") else None


def _predict_kokoro_device(ort_module: Any) -> Optional[str]:
    """Mirror kokoro-onnx's auto-selection: CUDA EP available → cuda, else cpu.
    Tolerates a broken/absent onnxruntime (None → caller leaves the slot null)."""
    try:
        providers = list(ort_module.get_available_providers())
    except Exception:
        return "cpu"
    return "cuda" if "CUDAExecutionProvider" in providers else "cpu"


def _compute_device_predictions(
    torch_module: Any, ort_module: Any
) -> dict[str, Optional[str]]:
    """Per-engine would-be devices. Modules are injected for testability (same
    pattern as CoquiEngine._resolve_runtime_options). Never raises."""
    out: dict[str, Optional[str]] = {"kokoro": None, "coqui": None, "qwen": None}
    if ort_module is not None:
        out["kokoro"] = _predict_kokoro_device(ort_module)
    if torch_module is not None:
        qwen = ENGINES.get("qwen")
        pref = (
            qwen._device_pref
            if isinstance(qwen, QwenEngine)
            else os.environ.get("QWEN_DEVICE", "auto")
        )
        out["qwen"] = _normalize_device_family(_resolve_torch_device(pref, torch_module))
        coqui = ENGINES.get("coqui")
        if isinstance(coqui, CoquiEngine):
            out["coqui"] = _normalize_device_family(
                coqui._resolve_runtime_options(torch_module)["device"]
            )
    return out


def _run_device_probe() -> None:
    """Blocking probe body — run via asyncio.to_thread from the startup hook.
    Imports the heavy modules HERE so module import (and therefore boot +
    /health) stays instant. torch.cuda.is_available() / backends.mps.
    is_available() query availability WITHOUT creating a CUDA context or
    allocating VRAM — never call anything heavier here. Must never raise."""
    global _device_probe, _device_probe_state
    ort_module = None
    torch_module = None
    try:
        import onnxruntime as ort_module  # type: ignore  # noqa: F811
    except Exception as e:
        log.warning("Device probe: onnxruntime unavailable (%s).", e)
    try:
        import torch as torch_module  # type: ignore  # noqa: F811
    except Exception as e:
        log.warning("Device probe: torch unavailable (%s).", e)
    try:
        _device_probe = _compute_device_predictions(torch_module, ort_module)
        _device_probe_state = "ready" if torch_module is not None else "error"
        log.info(
            "Device probe complete: %s (state=%s).", _device_probe, _device_probe_state
        )
    except Exception as e:  # belt-and-braces — predictions already never raise
        _device_probe_state = "error"
        log.warning("Device probe failed (%s) — devices_state=error.", e)
```

- [ ] **Step 4: Run tests to verify they pass**

Same command as Step 2. Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add server/tts-sidecar/main.py server/tts-sidecar/tests/test_device_probe.py
git commit -m "feat(side): per-engine device prediction probe (side-14)"
```

---

### Task 2: Sidecar — startup hook, /health composition, loaded overrides (TDD)

**Files:**
- Modify: `server/tts-sidecar/main.py` (`/health` route ~line 2565; startup hooks cluster, e.g. after `_start_asr_idle_watchdog` ~line 1917)
- Test: `server/tts-sidecar/tests/test_device_probe.py` (append)

- [ ] **Step 1: Append failing /health tests**

```python
from fastapi.testclient import TestClient  # noqa: E402


def _health(monkeypatch=None) -> dict:
    client = TestClient(main.app)
    res = client.get("/health")
    assert res.status_code == 200
    return res.json()


def test_health_pending_before_probe(monkeypatch) -> None:
    monkeypatch.setattr(main, "_device_probe", {"kokoro": None, "coqui": None, "qwen": None})
    monkeypatch.setattr(main, "_device_probe_state", "pending")
    body = _health()
    assert body["devices"] == {"kokoro": None, "coqui": None, "qwen": None}
    assert body["devices_state"] == "pending"


def test_health_reports_probe_result(monkeypatch) -> None:
    monkeypatch.setattr(
        main, "_device_probe", {"kokoro": "cpu", "coqui": "cpu", "qwen": "mps"}
    )
    monkeypatch.setattr(main, "_device_probe_state", "ready")
    body = _health()
    assert body["devices"] == {"kokoro": "cpu", "coqui": "cpu", "qwen": "mps"}
    assert body["devices_state"] == "ready"
    # legacy field untouched (Coqui not loaded)
    assert body["device"] is None


def test_health_loaded_coqui_overrides_prediction(monkeypatch) -> None:
    monkeypatch.setattr(
        main, "_device_probe", {"kokoro": "cpu", "coqui": "cpu", "qwen": None}
    )
    monkeypatch.setattr(main, "_device_probe_state", "ready")
    coqui = main.ENGINES["coqui"]
    monkeypatch.setattr(coqui, "_tts", object())
    monkeypatch.setattr(coqui, "_resolved_device", "cuda")
    body = _health()
    assert body["devices"]["coqui"] == "cuda"   # actual beats prediction
    assert body["device"] == "cuda"             # legacy field still works


def test_health_unloaded_coqui_falls_back_to_prediction(monkeypatch) -> None:
    """unload() resets _resolved_device to 'cpu' — that stale value must NOT
    masquerade as ground truth; the prediction takes back over."""
    monkeypatch.setattr(
        main, "_device_probe", {"kokoro": "cuda", "coqui": "cuda", "qwen": "cuda"}
    )
    monkeypatch.setattr(main, "_device_probe_state", "ready")
    coqui = main.ENGINES["coqui"]
    monkeypatch.setattr(coqui, "_tts", None)
    monkeypatch.setattr(coqui, "_resolved_device", "cpu")
    body = _health()
    assert body["devices"]["coqui"] == "cuda"


def test_health_loaded_qwen_reports_actual_device(monkeypatch) -> None:
    monkeypatch.setattr(
        main, "_device_probe", {"kokoro": "cpu", "coqui": "cpu", "qwen": "cpu"}
    )
    monkeypatch.setattr(main, "_device_probe_state", "ready")
    qwen = main.ENGINES["qwen"]
    monkeypatch.setattr(qwen, "_base", object())
    monkeypatch.setattr(qwen, "_device", "mps")
    body = _health()
    assert body["devices"]["qwen"] == "mps"


def test_health_loaded_qwen_unresolved_device_falls_back(monkeypatch) -> None:
    """A loaded Qwen whose _device somehow still reads 'auto' must not leak
    'auto' to the wire — normaliser maps it to None → prediction wins."""
    monkeypatch.setattr(
        main, "_device_probe", {"kokoro": "cpu", "coqui": "cpu", "qwen": "cuda"}
    )
    monkeypatch.setattr(main, "_device_probe_state", "ready")
    qwen = main.ENGINES["qwen"]
    monkeypatch.setattr(qwen, "_base", object())
    monkeypatch.setattr(qwen, "_device", "auto")
    body = _health()
    assert body["devices"]["qwen"] == "cuda"


def test_health_loaded_kokoro_reads_session_providers(monkeypatch) -> None:
    class _Sess:
        def get_providers(self) -> list[str]:
            return ["CUDAExecutionProvider", "CPUExecutionProvider"]

    class _FakeKokoro:
        sess = _Sess()

    monkeypatch.setattr(
        main, "_device_probe", {"kokoro": "cpu", "coqui": None, "qwen": None}
    )
    monkeypatch.setattr(main, "_device_probe_state", "ready")
    kokoro = main.ENGINES["kokoro"]
    monkeypatch.setattr(kokoro, "_kokoro", _FakeKokoro())
    body = _health()
    assert body["devices"]["kokoro"] == "cuda"


def test_health_kokoro_session_api_drift_falls_back(monkeypatch) -> None:
    class _NoSessKokoro:
        pass  # no .sess attribute — simulated kokoro-onnx API drift

    monkeypatch.setattr(
        main, "_device_probe", {"kokoro": "cuda", "coqui": None, "qwen": None}
    )
    monkeypatch.setattr(main, "_device_probe_state", "ready")
    kokoro = main.ENGINES["kokoro"]
    monkeypatch.setattr(kokoro, "_kokoro", _NoSessKokoro())
    body = _health()
    assert body["devices"]["kokoro"] == "cuda"  # prediction survives drift
```

- [ ] **Step 2: Run tests to verify the new ones fail**

Same pytest command. Expected: the Task-1 tests PASS, the new ones FAIL with `KeyError: 'devices'`.

- [ ] **Step 3: Implement**

(a) `_kokoro_session_device` helper, next to the Task-1 block:

```python
def _kokoro_session_device(engine: "KokoroEngine") -> Optional[str]:
    """Actual ONNX Runtime providers of the LOADED Kokoro session → family.
    kokoro-onnx internals drift across releases, so every access is guarded;
    None → caller keeps the prediction."""
    try:
        sess = getattr(engine._kokoro, "sess", None)
        if sess is None:
            return None
        providers = list(sess.get_providers())
        return "cuda" if "CUDAExecutionProvider" in providers else "cpu"
    except Exception:
        return None
```

(b) Startup hook, placed with the other `@app.on_event("startup")` hooks:

```python
@app.on_event("startup")
async def _start_device_probe() -> None:
    """side-14 — resolve per-engine devices in the background. Runs on a worker
    thread (torch import takes seconds); /health reports devices_state='pending'
    until it lands. Fire-and-forget: a probe failure degrades to 'error'."""
    asyncio.create_task(asyncio.to_thread(_run_device_probe))
```

(c) In `health()`, after the `qwen_install_state` block and before the `return`:

```python
    # side-14 — per-engine device map: loaded engines report their ACTUAL
    # device; unloaded ones the startup probe's prediction. Same resolvers on
    # both paths, so they only disagree if availability was misread — in which
    # case loaded truth wins. Composed at read time so engine load/unload and
    # probe completion are order-independent.
    devices = dict(_device_probe)
    if isinstance(coqui, CoquiEngine) and model_loaded:
        devices["coqui"] = _normalize_device_family(coqui._resolved_device) or devices["coqui"]
    if isinstance(kokoro, KokoroEngine) and kokoro_loaded:
        devices["kokoro"] = _kokoro_session_device(kokoro) or devices["kokoro"]
    if isinstance(qwen, QwenEngine) and qwen_loaded:
        devices["qwen"] = _normalize_device_family(qwen._device) or devices["qwen"]
```

and add to the returned dict, right after `"asr_device": ASR._device,`:

```python
        "devices": devices,
        "devices_state": _device_probe_state,
```

- [ ] **Step 4: Run the full sidecar suite**

```powershell
& C:\Claude\Projects\Audiobook-Generator\server\tts-sidecar\.venv\Scripts\python.exe -m pytest tests/ -v -m "not golden"
```

Expected: all PASS (existing `/health` shape tests are additive-safe).

- [ ] **Step 5: Commit**

```bash
git add server/tts-sidecar/main.py server/tts-sidecar/tests/test_device_probe.py
git commit -m "feat(side): /health reports per-engine devices with loaded-engine overrides"
```

---

### Task 3: Sidecar — NVIDIA-only error-string audit

**Files:**
- Modify: `server/tts-sidecar/main.py:760-767` (Kokoro import hint)

- [ ] **Step 1: Audit + reword**

Candidates audited in the design phase: torch install hints (`main.py:527/535` — the `whl/cpu` index is correct cross-platform guidance for a missing-torch error; leave), `COQUI_DEVICE=cuda` log hint (`main.py:550` — accurate; leave), NVIDIA sysmem diagnostics (`main.py:2308/2320` — Windows-specific and accurate; leave). The one real fix is the Kokoro import hint, which pushes `onnxruntime-gpu` (NVIDIA-only, doesn't exist for macOS arm64) as the default. Change:

```python
            raise RuntimeError(
                f"Failed to import kokoro-onnx ({e}). Install with: "
                "`.\\.venv\\Scripts\\python.exe -m pip install kokoro-onnx onnxruntime-gpu` "
                "in server/tts-sidecar (or onnxruntime for CPU-only)."
            ) from e
```

to:

```python
            raise RuntimeError(
                f"Failed to import kokoro-onnx ({e}). Install with: "
                "`.\\.venv\\Scripts\\python.exe -m pip install kokoro-onnx onnxruntime-gpu` "
                "in server/tts-sidecar (onnxruntime-gpu needs an NVIDIA GPU; on macOS / "
                "CPU-only boxes install plain onnxruntime instead)."
            ) from e
```

If `pytest tests/` greps this string anywhere (search `tests/` for `onnxruntime-gpu`), update the assertion in the same commit.

- [ ] **Step 2: Run the sidecar suite** — same command as Task 2 Step 4. Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add server/tts-sidecar/main.py
git commit -m "fix(side): platform-honest kokoro install hint (side-14 string audit)"
```

---

### Task 4: Node — sidecar-health passthrough (TDD)

**Files:**
- Modify: `server/src/routes/sidecar-health.ts`
- Test: `server/src/routes/sidecar-health.test.ts` (append; follow the file's existing fetch-mock pattern exactly)

- [ ] **Step 1: Append failing tests**

Read the top of `sidecar-health.test.ts` first and reuse its existing mock/server harness verbatim. Add cases:

```typescript
it('forwards devices + devicesState from the sidecar body', async () => {
  // arrange the existing fetch mock to return a /health body that includes:
  //   devices: { kokoro: 'cpu', coqui: 'cpu', qwen: 'mps' }, devices_state: 'ready'
  // assert the route/probe result carries:
  //   devices: { kokoro: 'cpu', coqui: 'cpu', qwen: 'mps' }, devicesState: 'ready'
});

it('defaults devices to null and devicesState to null on an old sidecar body', async () => {
  // body WITHOUT devices/devices_state →
  //   devices: null, devicesState: null
});

it('ignores a malformed devices field (non-object) rather than forwarding junk', async () => {
  // body with devices: "cuda" → devices: null
});
```

(Write them as real tests against the harness in that file — the comments above describe arrange/assert, the mechanics come from the existing cases.)

- [ ] **Step 2: Run to verify they fail**

```bash
cd server && npx vitest run src/routes/sidecar-health.test.ts
```

Expected: 3 new FAIL.

- [ ] **Step 3: Implement in `sidecar-health.ts`**

Add to the types and the result mapping:

```typescript
/* side-14 — per-engine device ground-truth. Sidecar values are normalised
   families ('cuda' | 'mps' | 'cpu') or null while unknowable; devices_state
   tracks the startup probe ('pending' until torch is imported in the
   background, 'ready', or 'error' when torch is missing/broken). Absent on an
   older sidecar → null. */
export type SidecarDeviceFamily = 'cuda' | 'mps' | 'cpu';
export type SidecarDeviceMap = Record<
  'kokoro' | 'coqui' | 'qwen',
  SidecarDeviceFamily | null
>;
export type SidecarDevicesState = 'pending' | 'ready' | 'error';
```

In `SidecarHealthBody`:

```typescript
  devices?: Record<string, string | null>;
  devices_state?: string;
```

In `SidecarHealthResult`:

```typescript
  devices?: SidecarDeviceMap | null;
  devicesState?: SidecarDevicesState | null;
```

Normaliser (top-level, near `normaliseQwenInstallState`):

```typescript
const DEVICE_FAMILIES: readonly SidecarDeviceFamily[] = ['cuda', 'mps', 'cpu'];
const DEVICES_STATES: readonly SidecarDevicesState[] = ['pending', 'ready', 'error'];
const DEVICE_ENGINES = ['kokoro', 'coqui', 'qwen'] as const;

/* side-14 — normalise the sidecar's devices map. Old sidecar omits it → null;
   junk values per-slot → null (never forward an unknown string to the UI). */
function normaliseDevices(raw: unknown): SidecarDeviceMap | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const rec = raw as Record<string, unknown>;
  const out = {} as SidecarDeviceMap;
  for (const engine of DEVICE_ENGINES) {
    const v = rec[engine];
    out[engine] = DEVICE_FAMILIES.includes(v as SidecarDeviceFamily)
      ? (v as SidecarDeviceFamily)
      : null;
  }
  return out;
}

function normaliseDevicesState(raw: unknown): SidecarDevicesState | null {
  return DEVICES_STATES.includes(raw as SidecarDevicesState)
    ? (raw as SidecarDevicesState)
    : null;
}
```

In the reachable-result object of `probeSidecarHealth`, after `device:`:

```typescript
      devices: normaliseDevices(body.devices),
      devicesState: normaliseDevicesState(body.devices_state),
```

- [ ] **Step 4: Run to verify pass**

Same command. Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/routes/sidecar-health.ts server/src/routes/sidecar-health.test.ts
git commit -m "feat(server): forward sidecar per-engine devices on /api/sidecar/health"
```

---

### Task 5: Node — /api/info devices + activeEngine (TDD)

**Files:**
- Modify: `server/src/routes/info.ts`
- Test: `server/src/routes/info.test.ts` (append; reuse its existing harness/mocks)

- [ ] **Step 1: Append failing tests**

Read `info.test.ts`'s harness first (it already mocks the sidecar `/health` fetch for `sidecarVersion`). Add:

```typescript
it('carries sidecar devices + devicesState + the resolved activeEngine', async () => {
  // arrange the sidecar /health mock body with __version__, devices
  //   { kokoro: 'cuda', coqui: 'cuda', qwen: 'cuda' }, devices_state: 'ready'
  // assert res.body.devices deep-equals the map, res.body.devicesState === 'ready',
  // and res.body.activeEngine is one of 'kokoro' | 'qwen' | 'coqui' (assert the
  // exact value the test harness's user-settings state implies — kokoro on a
  // fresh default with no Qwen known-installed).
});

it('reports null devices and a null devicesState when the sidecar is down', async () => {
  // arrange the fetch mock to reject → devices: null, devicesState: null,
  // activeEngine still present (Node-side resolution doesn't need the sidecar).
});
```

- [ ] **Step 2: Run to verify they fail**

```bash
cd server && npx vitest run src/routes/info.test.ts
```

- [ ] **Step 3: Implement in `info.ts`**

Imports:

```typescript
import { getResolvedTtsModelKey } from '../workspace/user-settings.js';
import { engineForModelKey } from '../tts/model-keys.js';
import type { SidecarDeviceMap, SidecarDevicesState } from './sidecar-health.js';
```

(`readUserSettings`/`writeUpgradeMeta`/`getResolvedSidecarUrl` are already imported — extend that import instead of duplicating.)

Broaden the probe (replace `fetchSidecarVersion`):

```typescript
interface SidecarInfoProbe {
  version: string | null;
  /* side-14 — per-engine device ground-truth, lifted off the SAME single
     /health fetch as the version (no second probe). Null when the sidecar is
     down or predates the field. */
  devices: SidecarDeviceMap | null;
  devicesState: SidecarDevicesState | null;
}

/** Best-effort sidecar probe — short timeout, all-null on any failure so a
    down sidecar never blocks /api/info. */
async function fetchSidecarInfo(): Promise<SidecarInfoProbe> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 2000);
  try {
    const res = await fetch(`${getResolvedSidecarUrl()}/health`, { signal: ctrl.signal });
    if (!res.ok) return { version: null, devices: null, devicesState: null };
    const body = (await res.json()) as {
      __version__?: string;
      devices?: unknown;
      devices_state?: unknown;
    };
    return {
      version: typeof body.__version__ === 'string' ? body.__version__ : null,
      devices: normaliseDevices(body.devices),
      devicesState: normaliseDevicesState(body.devices_state),
    };
  } catch {
    return { version: null, devices: null, devicesState: null };
  } finally {
    clearTimeout(timer);
  }
}
```

Export `normaliseDevices` / `normaliseDevicesState` from `sidecar-health.ts` (add `export` to the Task-4 functions) and import them here — do not duplicate.

Route handler additions:

```typescript
  const sidecar = await fetchSidecarInfo();
  res.json({
    appVersion,
    sidecarVersion: sidecar.version,
    /* …existing fields unchanged… */
    hardware: detectHardware(),
    /* side-14 — which device each engine runs on (sidecar ground truth) and
       which engine the server currently resolves as the default. activeEngine
       can be 'gemini'/'piper' for exotic defaults — the panel only headlines
       engines present in the devices map. */
    devices: sidecar.devices,
    devicesState: sidecar.devicesState,
    activeEngine: engineForModelKey(getResolvedTtsModelKey()),
  });
```

- [ ] **Step 4: Run to verify pass; then the server suite leg**

```bash
cd server && npx vitest run src/routes/info.test.ts src/routes/sidecar-health.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/routes/info.ts server/src/routes/info.test.ts server/src/routes/sidecar-health.ts
git commit -m "feat(server): /api/info carries sidecar devices + resolved activeEngine"
```

---

### Task 6: Frontend — AppInfo type + mock payload

**Files:**
- Modify: `src/lib/types.ts:181-196` (AppInfo)
- Modify: `src/lib/api.ts:4575-4583` (mockAppInfo)

- [ ] **Step 1: Extend `AppInfo`** (after `hardware`):

```typescript
  /* side-14 — per-engine device ground-truth from the sidecar (null while the
     sidecar's startup probe is pending or the sidecar is down) + the engine
     the server resolves as the current default. Optional: absent on an older
     server. */
  devices?: {
    kokoro: 'cuda' | 'mps' | 'cpu' | null;
    coqui: 'cuda' | 'mps' | 'cpu' | null;
    qwen: 'cuda' | 'mps' | 'cpu' | null;
  } | null;
  devicesState?: 'pending' | 'ready' | 'error' | null;
  activeEngine?: string;
```

- [ ] **Step 2: Extend `mockAppInfo`** (so mock mode + e2e exercise the full panel):

```typescript
let mockAppInfo: AppInfo = {
  appVersion: '1.6.0',
  sidecarVersion: '1.6.0',
  schemas: { state: 1, cast: 1, manuscriptEdits: 1, revisions: 1, listenProgress: 1, voices: 1 },
  lastSeenAppVersion: '1.6.0',
  showWhatsNew: false,
  releaseNotes: '# v1.6.0\n\n- In-app upgrades.\n',
  hardware: { platform: 'win32', arch: 'x64', appleSilicon: false, label: 'Windows (x64)' },
  devices: { kokoro: 'cuda', coqui: 'cuda', qwen: 'cuda' },
  devicesState: 'ready',
  activeEngine: 'kokoro',
};
```

- [ ] **Step 3: Typecheck**

```bash
npm run typecheck
```

Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add src/lib/types.ts src/lib/api.ts
git commit -m "feat(frontend): AppInfo devices/activeEngine + mock payload (side-14)"
```

---

### Task 7: Frontend — DevicePanel upgrade (TDD)

**Files:**
- Modify: `src/components/device-panel.tsx`
- Test: `src/components/device-panel.test.tsx` (append)

- [ ] **Step 1: Append failing tests**

```typescript
  it('headlines the active engine device and lists per-engine rows when ready', () => {
    h.info = {
      hardware: { platform: 'darwin', arch: 'arm64', appleSilicon: true, label: 'Apple Silicon Mac' },
      devices: { kokoro: 'cpu', coqui: 'cpu', qwen: 'mps' },
      devicesState: 'ready',
      activeEngine: 'qwen',
    };
    render(<DevicePanel />);
    expect(screen.getByText(/Currently running on:/)).toBeInTheDocument();
    expect(screen.getByText('Apple GPU (Metal)')).toBeInTheDocument();
    // per-engine rows carry the brand engine names
    expect(screen.getByText('Kokoro')).toBeInTheDocument();
    expect(screen.getByText('Coqui XTTS')).toBeInTheDocument();
    expect(screen.getByText('Qwen3-TTS')).toBeInTheDocument();
    // the hedge is replaced by ground truth
    expect(screen.queryByText(/Load a voice to confirm/)).not.toBeInTheDocument();
  });

  it('falls back to capability copy while the probe is pending', () => {
    h.info = {
      hardware: { platform: 'win32', arch: 'x64', appleSilicon: false, label: 'Windows (x64)' },
      devices: { kokoro: null, coqui: null, qwen: null },
      devicesState: 'pending',
      activeEngine: 'kokoro',
    };
    render(<DevicePanel />);
    expect(screen.queryByText(/Currently running on:/)).not.toBeInTheDocument();
    expect(screen.getByText(/falls back to the CPU/)).toBeInTheDocument();
  });

  it('falls back when the active engine has no device entry (e.g. gemini default)', () => {
    h.info = {
      hardware: { platform: 'win32', arch: 'x64', appleSilicon: false, label: 'Windows (x64)' },
      devices: { kokoro: 'cuda', coqui: 'cuda', qwen: 'cuda' },
      devicesState: 'ready',
      activeEngine: 'gemini',
    };
    render(<DevicePanel />);
    // no headline (gemini is cloud — no local device), but rows still show
    expect(screen.queryByText(/Currently running on:/)).not.toBeInTheDocument();
    expect(screen.getByText('Kokoro')).toBeInTheDocument();
  });
```

- [ ] **Step 2: Run to verify they fail**

```bash
npx vitest run src/components/device-panel.test.tsx
```

- [ ] **Step 3: Rewrite `device-panel.tsx`**

```tsx
/* fs-43 — "Will it run on my machine?" panel. Server-sourced host detection
   (the server runs the models; a paired browser may be a LAN phone, so
   client-side detection would describe the wrong machine). side-14 adds the
   ground truth: per-engine resolved devices from the sidecar's startup probe,
   headlined by the engine the server resolves as the active default. Falls
   back to the capability copy whenever ground truth isn't available (older
   server/sidecar, probe pending, sidecar down). */

import { useAppInfo } from '../lib/use-app-info';
import { HARDWARE_LINE } from '../lib/brand';

type DeviceFamily = 'cuda' | 'mps' | 'cpu';

const DEVICE_LABEL: Record<DeviceFamily, string> = {
  cuda: 'NVIDIA GPU (CUDA)',
  mps: 'Apple GPU (Metal)',
  cpu: 'CPU',
};

/* Brand engine names — keep in lockstep with the engine credits used across
   the app (Kokoro / Coqui XTTS / Qwen3-TTS). */
const ENGINE_LABEL = { kokoro: 'Kokoro', coqui: 'Coqui XTTS', qwen: 'Qwen3-TTS' } as const;
const ENGINE_ORDER = ['kokoro', 'qwen', 'coqui'] as const;

export function DevicePanel() {
  const { info } = useAppInfo();
  const hw = info?.hardware;
  const devices = info?.devicesState === 'ready' ? (info?.devices ?? null) : null;
  const activeEngine = info?.activeEngine;
  const headlineDevice =
    devices && activeEngine && activeEngine in devices
      ? devices[activeEngine as keyof typeof devices]
      : null;

  return (
    <section
      data-testid="device-panel"
      className="rounded-2xl border border-ink/10 bg-white p-6 shadow-card"
    >
      <h2 className="text-base font-semibold text-ink">Will it run on my machine?</h2>
      <p className="mt-1 text-sm text-ink/70">{HARDWARE_LINE}</p>

      {hw ? (
        <p className="mt-4 text-sm">
          <span className="text-ink/55">Detected:</span>{' '}
          <span className="font-medium text-ink">{hw.label}</span>
        </p>
      ) : (
        <p className="mt-4 text-sm text-ink/50">Detecting your hardware…</p>
      )}

      {headlineDevice && (
        <p className="mt-2 text-sm">
          <span className="text-ink/55">Currently running on:</span>{' '}
          <span className="font-medium text-ink">{DEVICE_LABEL[headlineDevice]}</span>
        </p>
      )}

      {devices && (
        <ul className="mt-2 space-y-0.5 text-xs text-ink/60">
          {ENGINE_ORDER.filter((e) => devices[e] !== null).map((e) => (
            <li key={e}>
              <span className="font-medium text-ink/80">{ENGINE_LABEL[e]}</span>
              {' · '}
              {DEVICE_LABEL[devices[e] as DeviceFamily]}
            </li>
          ))}
        </ul>
      )}

      {!devices && hw?.appleSilicon && (
        <p className="mt-2 text-xs text-ink/60">
          Castwright uses your Mac&rsquo;s Metal GPU automatically — no setup, no drivers.
        </p>
      )}
      {!devices && hw && !hw.appleSilicon && hw.platform === 'darwin' && (
        <p className="mt-2 text-xs text-ink/60">
          Intel Macs run on the CPU — slower than an 8&nbsp;GB GPU or Apple Silicon, but it works.
        </p>
      )}
      {!devices && hw && (hw.platform === 'win32' || hw.platform === 'linux') && (
        <p className="mt-2 text-xs text-ink/60">
          With an 8&nbsp;GB NVIDIA GPU you get near-realtime rendering; without one, Castwright
          falls back to the CPU (slower). Load a voice to confirm which device is in use.
        </p>
      )}
    </section>
  );
}
```

Note the capability paragraphs gain a `!devices &&` guard — ground truth replaces them; absent ground truth they render exactly as today (the existing four tests must keep passing untouched).

- [ ] **Step 4: Run the frontend suite**

```bash
npx vitest run src/components/device-panel.test.tsx && npm run test
```

Expected: PASS (all existing DevicePanel tests green without edits).

- [ ] **Step 5: Commit**

```bash
git add src/components/device-panel.tsx src/components/device-panel.test.tsx
git commit -m "feat(frontend): device panel headlines the active engine's resolved device"
```

---

### Task 8: e2e — /about asserts the upgraded panel

**Files:**
- Modify: `e2e/about-page.spec.ts`

- [ ] **Step 1: Append the spec**

```typescript
/* side-14 — mock mode ships a ready devices map (kokoro active on cuda), so
   the device panel's ground-truth headline must render on /about. */
test('/about device panel shows the ground-truth device line', async ({ page }) => {
  await page.goto('/#/about');

  const panel = page.getByTestId('device-panel');
  await expect(panel.getByText('Currently running on:', { exact: false })).toBeVisible({
    timeout: 10_000,
  });
  await expect(panel.getByText('NVIDIA GPU (CUDA)', { exact: false }).first()).toBeVisible();
});
```

- [ ] **Step 2: Run it**

```bash
npx playwright test e2e/about-page.spec.ts --project=chromium
```

Expected: PASS. If port 5174 is held by a concurrent session, re-run with a free port (`PLAYWRIGHT_PORT` env) and note it.

- [ ] **Step 3: Commit**

```bash
git add e2e/about-page.spec.ts
git commit -m "test(e2e): /about asserts the side-14 device ground-truth line"
```

---

### Task 9: Regression plan doc + INDEX

**Files:**
- Create: `docs/features/204-side14-device-ground-truth.md` (204 = next free number — verify with `Glob docs/features/2*.md` and bump if taken)
- Modify: `docs/features/INDEX.md`

- [ ] **Step 1: Write the plan doc** from `docs/features/TEMPLATE.md` structure, `status: active`. Content: the spec's Problem/Design condensed; invariants to protect (per-engine map composition order-independence; loaded-override gating on loadedness; legacy `device` field untouched; probe can never crash/poison; old-sidecar/old-Node compat matrix; panel graceful degradation); manual acceptance: boot prod, hit `/api/info`, confirm `devices` matches `nvidia-smi` reality; on a Mac confirm `qwen: mps`. Note the expected committed-baseline shift from the torch import (~300–500 MB) so it isn't mistaken for a leak.

- [ ] **Step 2: Add the INDEX.md entry** under the sidecar/ops area, matching neighbouring entries' format.

- [ ] **Step 3: Commit**

```bash
git add docs/features/204-side14-device-ground-truth.md docs/features/INDEX.md
git commit -m "docs(docs): regression plan for side-14 device ground-truth"
```

---

### Task 10: Full verify + draft PR

- [ ] **Step 1: Run the full battery**

```bash
npm run verify
```

Expected: lint, typecheck, all unit suites, e2e, build — green. Triage any failure per CLAUDE.md (related → fix; pre-existing → STOP and surface; flake → isolate once and name it).

- [ ] **Step 2: Push + draft PR**

```bash
git push -u origin feat/side-device-ground-truth
gh pr create --draft --title "feat(side,server,frontend): device ground-truth on /health + fs-43 panel (side-14)"
```

PR body: template's `## Summary` / `## Test plan` filled; link the spec + plan doc; `Closes #707`; call out the torch-import committed-baseline shift; note the `needs-plan` label is now satisfied by `docs/features/204-…`. End with the Claude Code attribution line. Do NOT mark ready.

- [ ] **Step 3: Backlog hygiene** — check `docs/BACKLOG.md` for a side-14 row; if present, remove it in the same PR (`docs(docs)` commit).

---

## Self-review (done at authoring time)

- **Spec coverage:** probe (T1/T2), /health contract (T2), string audit (T3), Node passthrough (T4), /api/info + activeEngine (T5), types/mocks (T6), panel (T7), e2e (T8), regression plan (T9), delivery (T0/T10). No gaps.
- **Type consistency:** `SidecarDeviceMap`/`SidecarDevicesState` defined once in `sidecar-health.ts`, imported by `info.ts`; frontend mirrors them structurally in `AppInfo`; `devices_state` (snake) on the wire ↔ `devicesState` (camel) in Node/frontend — consistent throughout.
- **Known judgment calls for the executor:** exact placement of the Task-1 block may shift line numbers (anchor on the named functions, not line numbers); `info.test.ts`/`sidecar-health.test.ts` harness mechanics must be copied from the files themselves.
