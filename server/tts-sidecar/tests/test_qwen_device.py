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
