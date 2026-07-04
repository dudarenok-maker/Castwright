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
