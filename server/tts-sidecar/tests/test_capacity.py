"""Tests for `probe_capacity()` — the cross-vendor VRAM/RAM inventory used by
capacity-aware GPU placement (task 1 of the vram-aware-placement plan).

Contract pinned here: the probe NEVER raises. A per-device failure (poisoned
CUDA context, vanished card, missing psutil) omits just that device; the
returned list always ends with a `cpu` row so a placement decision always has
somewhere to fall back to."""
from __future__ import annotations

import sys
from pathlib import Path

# Add the sidecar root to sys.path so `import main` works regardless of
# pytest's collection directory — same pattern as test_smoke.py.
SIDECAR_ROOT = Path(__file__).resolve().parent.parent
if str(SIDECAR_ROOT) not in sys.path:
    sys.path.insert(0, str(SIDECAR_ROOT))

import main  # noqa: E402


def test_probe_always_includes_cpu(monkeypatch):
    monkeypatch.setattr(main, "_cuda_device_count", lambda: 0)
    monkeypatch.setattr(main, "_mps_available", lambda: False)
    d = main.probe_capacity()
    assert d[-1]["kind"] == "cpu" and d[-1]["freeMb"] > 0


def test_probe_enumerates_cuda(monkeypatch):
    monkeypatch.setattr(main, "_cuda_device_count", lambda: 2)
    monkeypatch.setattr(main, "_mps_available", lambda: False)
    monkeypatch.setattr(
        main,
        "_cuda_mem_get_info",
        lambda i: (2 * 1024**3, 8 * 1024**3) if i == 0 else (15 * 1024**3, 16 * 1024**3),
    )
    cuda = [x for x in main.probe_capacity() if x["kind"] == "cuda"]
    assert [c["totalMb"] for c in cuda] == [8192, 16384]
    assert cuda[0]["freeMb"] == 2048


def test_probe_omits_dead_device(monkeypatch):
    monkeypatch.setattr(main, "_cuda_device_count", lambda: 1)
    monkeypatch.setattr(main, "_mps_available", lambda: False)
    monkeypatch.setattr(
        main, "_cuda_mem_get_info", lambda i: (_ for _ in ()).throw(RuntimeError("GPU is lost"))
    )
    d = main.probe_capacity()
    assert [x for x in d if x["kind"] == "cuda"] == [] and d[-1]["kind"] == "cpu"


def test_probe_cpu_row_present_when_psutil_none(monkeypatch):
    """psutil is imported guarded at module scope (main.py ~line 780) and can
    be None on a stripped install. The cpu/mps rows must degrade to an
    OS-level readout in that case — never raise, never omit the cpu row."""
    monkeypatch.setattr(main, "_cuda_device_count", lambda: 0)
    monkeypatch.setattr(main, "_mps_available", lambda: False)
    monkeypatch.setattr(main, "psutil", None)
    d = main.probe_capacity()
    assert d[-1]["kind"] == "cpu"
    assert isinstance(d[-1]["freeMb"], int) and d[-1]["freeMb"] > 0
    assert isinstance(d[-1]["totalMb"], int) and d[-1]["totalMb"] > 0
