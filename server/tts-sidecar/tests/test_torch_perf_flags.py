"""test_torch_perf_flags.py — TF32 / fp32-matmul-precision flag wiring.

`_apply_torch_perf_flags` is called once in each torch load path (Coqui
`_ensure_loaded`, Qwen `_load_qwen_model`) right after torch imports. The
flags only affect fp32 matmuls — marginal for bf16 Qwen, a small win for
Coqui's fp32 residuals — but like the autocast/bf16 speedups they sit
alongside, a mis-wire is silent. So pin that the helper sets exactly the
three intended knobs, leaves cudnn.benchmark alone, and swallows attribute
drift instead of crashing a model load. See docs/tts-performance.md for why
cudnn.benchmark is deliberately NOT set.
"""

from __future__ import annotations

import types
from typing import Any

import main


def _make_stub_torch() -> Any:
    """A torch-shaped stub that records the perf-flag assignments the helper
    makes (the real torch.backends tree, minus the GPU)."""
    torch = types.SimpleNamespace()
    torch.backends = types.SimpleNamespace()
    torch.backends.cuda = types.SimpleNamespace()
    torch.backends.cuda.matmul = types.SimpleNamespace(allow_tf32=False)
    torch.backends.cudnn = types.SimpleNamespace(allow_tf32=False)
    calls: list[str] = []
    torch.set_float32_matmul_precision = lambda p: calls.append(p)
    torch._matmul_precision_calls = calls  # type: ignore[attr-defined]
    return torch


def test_apply_torch_perf_flags_sets_tf32_and_precision():
    torch = _make_stub_torch()
    main._apply_torch_perf_flags(torch)
    assert torch.backends.cuda.matmul.allow_tf32 is True
    assert torch.backends.cudnn.allow_tf32 is True
    assert torch._matmul_precision_calls == ["high"]


def test_apply_torch_perf_flags_leaves_cudnn_benchmark_off():
    """cudnn.benchmark stays OFF on purpose — audiobook input lengths vary
    wildly, so its per-shape autotune would re-fire on every new shape and
    regress first-hit latency. Flipping it on must be a deliberate, measured
    choice, never a side effect of this helper."""
    torch = _make_stub_torch()
    torch.backends.cudnn.benchmark = False
    main._apply_torch_perf_flags(torch)
    assert torch.backends.cudnn.benchmark is False


def test_apply_torch_perf_flags_swallows_attribute_drift():
    """If a future torch renames/removes one of these attributes, the helper
    must warn and continue — a model load must never die over a perf knob."""

    class _Hostile:
        @property
        def backends(self) -> Any:
            raise AttributeError("torch.backends drifted")

    # Must not raise.
    main._apply_torch_perf_flags(_Hostile())
