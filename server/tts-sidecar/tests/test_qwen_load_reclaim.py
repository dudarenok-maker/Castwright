"""Regression (side-11 / 2026-05-31): a Qwen load that FAILS after it has
materialised weights must reclaim the partial allocation before re-raising.

The dominant failed-reload shape is `inner.to(device)` hitting a CUDA OOM partway
through moving weights to a card that is already pressured. The partially-built
`Qwen3TTSModel` is an `nn.Module` whose reference CYCLES keep its tensors alive
past the failing frame (refcount alone won't free them), and `_ensure_*_loaded`
never assigns it to `self._base`/`self._design`, so without an explicit reclaim
nothing frees it — repeated failed reloads then orphan VRAM (the measured ~9.9 GB
CUDA-allocated with `base_loaded=false`). The fix wraps the load so it runs the
gc+empty_cache reclaim on failure, mirroring `unload()`.

CI has no GPU, so these pin the reclaim-on-failure CONTRACT (the reclaim runs and
no half-built model is left assigned), not actual byte counts.
"""

import sys
import types
from typing import Any

import pytest

import main


class _RaisingInner:
    """The inner nn.Module of the Qwen3TTSModel wrapper — the only object with a
    `.to()`. Here `.to(device)` raises, simulating a CUDA OOM partway through the
    move to the GPU."""

    def __init__(self) -> None:
        self.device: Any = None
        self.config = types.SimpleNamespace(_attn_implementation="sdpa")

    def to(self, _device: Any) -> Any:
        raise RuntimeError("CUDA out of memory: tried to allocate 2.00 GiB (move failed)")


class _PartialFakeQwen:
    """from_pretrained SUCCEEDS (weights materialised on CPU) but the subsequent
    move to device fails — the exact partial-load shape that orphaned VRAM."""

    def __init__(self, model_id: str) -> None:
        self.model_id = model_id
        self.model = _RaisingInner()
        self.device: Any = None

    @classmethod
    def from_pretrained(cls, model_id: str, **_kwargs: Any) -> "_PartialFakeQwen":
        return cls(model_id)


@pytest.fixture
def qwen_load_failure_runtime(monkeypatch):
    """Stub qwen_tts + torch so a load materialises then fails on `.to(device)`,
    and spy on `_reclaim_host_and_vram` to assert it runs on the failure path."""
    fake_qwen = types.ModuleType("qwen_tts")
    fake_qwen.Qwen3TTSModel = _PartialFakeQwen  # type: ignore[attr-defined]
    monkeypatch.setitem(sys.modules, "qwen_tts", fake_qwen)

    fake_torch = types.ModuleType("torch")
    fake_torch.bfloat16 = "bfloat16"  # type: ignore[attr-defined]
    fake_torch.device = lambda d: d  # type: ignore[attr-defined]
    fake_torch.cuda = types.SimpleNamespace(  # type: ignore[attr-defined]
        is_available=lambda: True, empty_cache=lambda: None, device_count=lambda: 1
    )
    monkeypatch.setitem(sys.modules, "torch", fake_torch)

    # The fake torch has no real perf-flag surface — neutralise the hook.
    monkeypatch.setattr(main, "_apply_torch_perf_flags", lambda _t: None)

    calls = {"reclaim": 0}
    monkeypatch.setattr(
        main, "_reclaim_host_and_vram", lambda: calls.__setitem__("reclaim", calls["reclaim"] + 1)
    )

    engine = main.ENGINES["qwen"]
    assert isinstance(engine, main.QwenEngine)
    engine._base = None
    engine._design = None
    yield {"engine": engine, "calls": calls}
    engine._base = None
    engine._design = None


def test_load_failure_reclaims_partial_allocation(qwen_load_failure_runtime) -> None:
    engine = qwen_load_failure_runtime["engine"]
    calls = qwen_load_failure_runtime["calls"]
    with pytest.raises(RuntimeError, match="out of memory"):
        engine._load_qwen_model(engine.BASE_MODEL)
    assert calls["reclaim"] == 1, "a failed load must run _reclaim_host_and_vram before re-raising"


def test_ensure_base_loaded_leaves_no_model_on_failure(qwen_load_failure_runtime) -> None:
    """A failed cold load must NOT leave a half-built model assigned to `_base`
    (which would make the next call think it's loaded and skip a real reload), and
    must have reclaimed the partial allocation."""
    engine = qwen_load_failure_runtime["engine"]
    calls = qwen_load_failure_runtime["calls"]
    with pytest.raises(RuntimeError, match="out of memory"):
        engine._ensure_base_loaded()
    assert engine._base is None
    assert calls["reclaim"] == 1


def test_ensure_design_loaded_leaves_no_model_on_failure(qwen_load_failure_runtime) -> None:
    engine = qwen_load_failure_runtime["engine"]
    calls = qwen_load_failure_runtime["calls"]
    with pytest.raises(RuntimeError, match="out of memory"):
        engine._ensure_design_loaded()
    assert engine._design is None
    assert calls["reclaim"] == 1
