"""Qwen device resolver: 'auto' picks cuda:0 -> mps -> cpu; explicit values pass through."""
import types
import pytest
from main import _resolve_torch_device


def _torch(cuda: bool, mps: bool):
    t = types.SimpleNamespace()
    t.cuda = types.SimpleNamespace(is_available=lambda: cuda)
    t.backends = types.SimpleNamespace(
        mps=types.SimpleNamespace(is_available=lambda: mps))
    return t


def test_auto_prefers_cuda():
    assert _resolve_torch_device("auto", _torch(cuda=True, mps=True)) == "cuda:0"


def test_auto_falls_to_mps_when_no_cuda():
    assert _resolve_torch_device("auto", _torch(cuda=False, mps=True)) == "mps"


def test_auto_falls_to_cpu_when_neither():
    assert _resolve_torch_device("auto", _torch(cuda=False, mps=False)) == "cpu"


@pytest.mark.parametrize("explicit", ["cuda:1", "cpu", "mps"])
def test_explicit_passes_through(explicit):
    assert _resolve_torch_device(explicit, _torch(cuda=True, mps=True)) == explicit


def test_design_first_load_resolves_device(monkeypatch):
    """design_voice loads VoiceDesign BEFORE base; the design path must resolve
    'auto' to a concrete device before .to(), else it crashes with .to('auto')."""
    from main import QwenEngine
    eng = QwenEngine()
    eng._device = "auto"
    eng._device_pref = "cpu"  # explicit → resolver returns 'cpu' without needing a GPU
    seen = {}

    def fake_load(model_id):
        seen["device"] = eng._device
        return object()

    monkeypatch.setattr(eng, "_load_qwen_model", fake_load)
    eng._ensure_design_loaded()
    assert seen["device"] == "cpu", "device must be resolved before the design load"
