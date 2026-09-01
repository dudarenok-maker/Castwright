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


@pytest.mark.parametrize("rocm,cuda", [("rocm:0", "cuda:0"), ("rocm:1", "cuda:1")])
def test_rocm_normalises_to_cuda(rocm, cuda):
    """#2813: the admission ledger's own ROCm-vs-CUDA accounting vocabulary
    (`probe()`'s `kind`) hands engines an explicit 'rocm:N' — but a ROCm/HIP
    torch build only ever understands 'cuda:N' at the API level, so the
    admitted value must be re-tagged (index preserved) before any .to()
    call, not passed through unchanged like other explicit values."""
    assert _resolve_torch_device(rocm, _torch(cuda=True, mps=False)) == cuda


def test_design_first_load_resolves_device(monkeypatch):
    """design_voice loads VoiceDesign BEFORE base; the design path must resolve
    'auto' to a concrete device before .to(), else it crashes with .to('auto')."""
    # `_ensure_design_loaded` -> `_ensure_device_resolved()` does an
    # unconditional `import torch` (main.py) even though `_load_qwen_model`
    # is stubbed below — needs the real package.
    pytest.importorskip("torch")
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
