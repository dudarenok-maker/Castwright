import importlib, os, sys
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
main = importlib.import_module("main")

def test_parse_device():
    assert main._parse_device("cpu") == ("cpu", None)
    assert main._parse_device("cuda") == ("cuda", None)
    assert main._parse_device("cuda:0") == ("cuda", 0)
    assert main._parse_device("CUDA:2") == ("cuda", 2)
    assert main._parse_device("cuda:x") == ("cuda", None)   # malformed index → no index, family kept
    assert main._parse_device("") == ("auto", None)
    assert main._parse_device(None) == ("auto", None)

def test_ct2_kwargs_splits_index():
    assert main._ct2_kwargs("cuda:1", "int8_float16") == {"device": "cuda", "device_index": 1, "compute_type": "int8_float16"}
    assert main._ct2_kwargs("cuda", "int8_float16") == {"device": "cuda", "compute_type": "int8_float16"}
    assert main._ct2_kwargs("cpu", "int8") == {"device": "cpu", "compute_type": "int8"}

def test_whisper_compute_type_honours_indexed_cuda(monkeypatch):
    monkeypatch.delenv("ASR_COMPUTE_TYPE", raising=False)
    monkeypatch.setenv("ASR_DEVICE", "cuda:1")
    assert main.WhisperEngine()._compute_type() == "int8_float16"

def test_spk_run_device():
    assert main._spk_run_device("cuda:1") == "cuda:1"
    assert main._spk_run_device("cuda") == "cuda"
    assert main._spk_run_device("cpu") == "cpu"

def test_spk_indexed_cuda_degrades_when_no_gpu(monkeypatch):
    """SPK_DEVICE=cuda:1 with no CUDA must degrade to cpu, not crash on the
    `== "cuda"` mismatch (the bug)."""
    monkeypatch.setenv("SPK_DEVICE", "cuda:1")
    spk = main.SpeakerEngine()
    assert main._parse_device(spk.device)[0] == "cuda"
    # stub torch so cuda is 'unavailable' and the present-check runs the degrade
    import types
    fake = types.SimpleNamespace(cuda=types.SimpleNamespace(is_available=lambda: False))
    monkeypatch.setitem(sys.modules, "torch", fake)
    # exercise only the present-check branch (no real speechbrain load)
    import asyncio
    async def run():
        try:
            await spk.ensure_loaded()
        except Exception:
            pass  # speechbrain import may fail in CI; we only assert the device decision
    asyncio.run(run())
    assert spk.device == "cpu"


import types as _types
import pytest

def test_validate_cuda_index_rejects_out_of_range():
    fake = _types.SimpleNamespace(
        cuda=_types.SimpleNamespace(is_available=lambda: True, device_count=lambda: 2)
    )
    with pytest.raises(ValueError):
        main._validate_cuda_index("cuda:9", fake)


def test_validate_cuda_index_passes_in_range():
    fake = _types.SimpleNamespace(
        cuda=_types.SimpleNamespace(is_available=lambda: True, device_count=lambda: 2)
    )
    main._validate_cuda_index("cuda:1", fake)  # must not raise
