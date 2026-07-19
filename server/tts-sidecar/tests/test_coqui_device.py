"""test_coqui_device.py — CoquiEngine fp16+DeepSpeed gating via _parse_device.

Regression for the bug where `COQUI_DEVICE=cuda:1` silently disabled fp16 and
DeepSpeed because _resolve_runtime_options used `device == "cuda"` (exact match)
rather than routing through _parse_device family comparison.
"""

from __future__ import annotations

import types
import sys
from pathlib import Path

SIDECAR_ROOT = Path(__file__).resolve().parent.parent
if str(SIDECAR_ROOT) not in sys.path:
    sys.path.insert(0, str(SIDECAR_ROOT))

import main  # noqa: E402


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


# ── _resolve_runtime_options ───────────────────────────────────────────────


def test_indexed_cuda_enables_half_and_deepspeed(monkeypatch):
    """cuda:1 is a CUDA family device — fp16 and DeepSpeed must be enabled."""
    monkeypatch.setenv("COQUI_DEVICE", "cuda:1")
    monkeypatch.setenv("COQUI_HALF", "1")
    monkeypatch.setenv("COQUI_DEEPSPEED", "1")
    eng = main.CoquiEngine()
    opts = eng._resolve_runtime_options(_torch_stub())
    assert opts["half"] is True, "fp16 must be enabled for cuda:1"
    assert opts["deepspeed"] is True, "DeepSpeed must be enabled for cuda:1"


def test_indexed_cuda_default_half_and_deepspeed(monkeypatch):
    """cuda:1 with no explicit COQUI_HALF/DEEPSPEED → defaults ON (same as plain cuda)."""
    monkeypatch.setenv("COQUI_DEVICE", "cuda:1")
    monkeypatch.delenv("COQUI_HALF", raising=False)
    monkeypatch.delenv("COQUI_DEEPSPEED", raising=False)
    eng = main.CoquiEngine()
    opts = eng._resolve_runtime_options(_torch_stub())
    assert opts["half"] is True, "fp16 default must be True for cuda:1"
    assert opts["deepspeed"] is True, "DeepSpeed default must be True for cuda:1"


def test_indexed_cuda_half_opt_out(monkeypatch):
    """cuda:1 with COQUI_HALF=0 → half=False; deepspeed still follows its own env."""
    monkeypatch.setenv("COQUI_DEVICE", "cuda:1")
    monkeypatch.setenv("COQUI_HALF", "0")
    monkeypatch.setenv("COQUI_DEEPSPEED", "1")
    eng = main.CoquiEngine()
    opts = eng._resolve_runtime_options(_torch_stub())
    assert opts["half"] is False
    assert opts["deepspeed"] is True


def test_plain_cuda_still_works(monkeypatch):
    """Plain 'cuda' (no index) must still enable half+deepspeed — no regression."""
    monkeypatch.setenv("COQUI_DEVICE", "cuda")
    monkeypatch.delenv("COQUI_HALF", raising=False)
    monkeypatch.delenv("COQUI_DEEPSPEED", raising=False)
    eng = main.CoquiEngine()
    opts = eng._resolve_runtime_options(_torch_stub())
    assert opts["half"] is True
    assert opts["deepspeed"] is True


def test_cpu_disables_half_and_deepspeed(monkeypatch):
    """CPU device → half=False, deepspeed=False regardless of env vars."""
    monkeypatch.setenv("COQUI_DEVICE", "cpu")
    monkeypatch.setenv("COQUI_HALF", "1")
    monkeypatch.setenv("COQUI_DEEPSPEED", "1")
    eng = main.CoquiEngine()
    opts = eng._resolve_runtime_options(_torch_stub())
    assert opts["half"] is False
    assert opts["deepspeed"] is False


def test_auto_cuda_available_enables_half(monkeypatch):
    """'auto' with CUDA available resolves to cuda and enables half+deepspeed."""
    monkeypatch.setenv("COQUI_DEVICE", "auto")
    monkeypatch.delenv("COQUI_HALF", raising=False)
    monkeypatch.delenv("COQUI_DEEPSPEED", raising=False)
    eng = main.CoquiEngine()
    opts = eng._resolve_runtime_options(_torch_stub(cuda_available=True))
    assert opts["half"] is True
    assert opts["deepspeed"] is True


# ── _requested_device capture ──────────────────────────────────────────────


def test_requested_device_captured_in_init(monkeypatch):
    """CoquiEngine.__init__ captures _requested_device == _device."""
    monkeypatch.setenv("COQUI_DEVICE", "cuda:1")
    eng = main.CoquiEngine()
    assert hasattr(eng, "_requested_device"), "_requested_device must be set in __init__"
    assert eng._requested_device == "cuda:1"


def test_requested_device_default(monkeypatch):
    """Without COQUI_DEVICE, _requested_device defaults to 'auto'."""
    monkeypatch.delenv("COQUI_DEVICE", raising=False)
    eng = main.CoquiEngine()
    assert eng._requested_device == "auto"


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


# ── admitted-device consistency: self._device tracks the resolved card while
#    resident, and is restored to the pref on unload (#1730 gap 3) ────────────


def _stub_coqui_load(monkeypatch) -> dict:
    """Neutralise the heavy XTTS load so `_ensure_loaded` can run headless, and
    return a dict the fake TTS records the `.to(device)` target into."""
    moved: dict = {}
    monkeypatch.setattr(main, "_apply_torch_perf_flags", lambda t: None)
    monkeypatch.setattr(main, "_validate_cuda_index", lambda d, t: None)

    class _FakeTTS:
        synthesizer = types.SimpleNamespace(
            tts_model=types.SimpleNamespace(
                gpt=types.SimpleNamespace(init_gpt_for_inference=lambda **k: None),
                speaker_manager=types.SimpleNamespace(name_to_id={"speaker": 0}),
            )
        )

        def __init__(self, model_id):
            self.model_id = model_id

        def to(self, device):
            moved["device"] = device

    fake_pkg = types.ModuleType("TTS")
    fake_api = types.ModuleType("TTS.api")
    fake_api.TTS = _FakeTTS
    monkeypatch.setitem(sys.modules, "TTS", fake_pkg)
    monkeypatch.setitem(sys.modules, "TTS.api", fake_api)
    monkeypatch.setitem(sys.modules, "torch", _torch_stub())
    return moved


def test_admitted_device_updates_self_device_and_unload_restores(monkeypatch):
    """An admitted `device` override drives the load AND leaves `self._device`
    reflecting the resolved card — not stale at the env pref — so nothing that
    reads `self._device` sees a card the model isn't on (#1730 gap 3). Pre-fix
    `self._device` stayed 'auto' while the model sat on cuda:1. `unload()`
    restores the requested pref so a later flag-off reload re-resolves cleanly."""
    monkeypatch.setenv("COQUI_DEVICE", "auto")  # env pref, unresolved
    eng = main.CoquiEngine()
    assert eng._device == "auto" and eng._requested_device == "auto"

    moved = _stub_coqui_load(monkeypatch)
    eng._ensure_loaded("xtts_v2", device="cuda:1")

    assert moved["device"] == "cuda:1"       # model loaded on the admitted card
    assert eng._resolved_device == "cuda:1"  # concrete truth
    assert eng._device == "cuda:1"           # no longer stale at 'auto' (the fix)

    eng.unload()
    assert eng._device == "auto"             # pref restored for re-resolution
