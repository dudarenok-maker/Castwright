"""#2600 (PR #2617 review finding 1) — installing `nvidia-cudnn-cu12` lands the
cuDNN DLLs on disk but does not make them findable by onnxruntime's CUDA
execution provider on Windows (no `.pth`, no importable module, and the
onnxruntime-gpu wheel never touches the DLL search path itself). The fix is
`main._preload_ort_cuda_dlls()`, which calls onnxruntime's own opt-in
`preload_dlls()` once at import time.

This suite pins two properties: (1) the preload is actually attempted when the
symbol exists, and (2) every failure shape — no `preload_dlls` attribute (an
older/non-GPU onnxruntime build), `preload_dlls()` itself raising, and
onnxruntime not being importable at all — degrades to a logged no-op rather
than crashing the sidecar. The entire defect class this closes is *silent*
fallback, so each case also asserts a log line was emitted, not just a status
string.
"""
from __future__ import annotations

import logging
import sys
import types
from pathlib import Path
from typing import Any

SIDECAR_ROOT = Path(__file__).resolve().parent.parent
if str(SIDECAR_ROOT) not in sys.path:
    sys.path.insert(0, str(SIDECAR_ROOT))

import main  # noqa: E402


def _module_with(name: str, **attrs: Any) -> types.ModuleType:
    mod = types.ModuleType(name)
    for k, v in attrs.items():
        setattr(mod, k, v)
    return mod


def test_preload_runs_when_symbol_present(monkeypatch, caplog) -> None:
    calls: list[int] = []

    def _fake_preload() -> None:
        calls.append(1)

    monkeypatch.setitem(
        sys.modules,
        "onnxruntime",
        _module_with("onnxruntime", preload_dlls=_fake_preload, __version__="1.27.0"),
    )

    with caplog.at_level(logging.INFO, logger="sidecar"):
        result = main._preload_ort_cuda_dlls()

    assert result == "preloaded"
    assert calls == [1], "preload_dlls() must actually be called, not just detected"
    assert any("preload_dlls() ran" in r.message for r in caplog.records), (
        "a successful preload must log at info level -- the whole defect class "
        "here is silent fallback, so a silent success is not acceptable either"
    )


def test_preload_missing_symbol_degrades_to_noop(monkeypatch, caplog) -> None:
    """An onnxruntime build with no `preload_dlls` (older release, or a
    non-GPU wheel that never needed it) must not raise -- it degrades and
    logs why, rather than crashing sidecar startup."""
    monkeypatch.setitem(
        sys.modules, "onnxruntime", _module_with("onnxruntime", __version__="1.20.0")
    )

    with caplog.at_level(logging.INFO, logger="sidecar"):
        result = main._preload_ort_cuda_dlls()  # must not raise

    assert result == "unavailable"
    assert any("no preload_dlls()" in r.message for r in caplog.records)


def test_preload_dlls_raising_is_caught(monkeypatch, caplog) -> None:
    """`preload_dlls()` itself can raise (e.g. the `[cuda]`-extra packages
    absent) -- that must be caught, not left to crash the sidecar, and it must
    be LOGGED loudly (a warning), not swallowed silently."""

    def _boom() -> None:
        raise OSError("could not locate a CUDA DLL directory")

    monkeypatch.setitem(
        sys.modules,
        "onnxruntime",
        _module_with("onnxruntime", preload_dlls=_boom, __version__="1.27.0"),
    )

    with caplog.at_level(logging.WARNING, logger="sidecar"):
        result = main._preload_ort_cuda_dlls()  # must not raise

    assert result == "failed"
    assert any(
        r.levelno == logging.WARNING and "preload_dlls() raised" in r.message
        for r in caplog.records
    )


def test_onnxruntime_not_importable_degrades_to_noop(monkeypatch, caplog) -> None:
    """onnxruntime absent entirely (e.g. an interim state during a bootstrap
    swap) must not crash the module import."""
    monkeypatch.setitem(sys.modules, "onnxruntime", None)  # forces ImportError on re-import

    with caplog.at_level(logging.INFO, logger="sidecar"):
        result = main._preload_ort_cuda_dlls()  # must not raise

    assert result == "not-importable"
    assert any("not importable yet" in r.message for r in caplog.records)
