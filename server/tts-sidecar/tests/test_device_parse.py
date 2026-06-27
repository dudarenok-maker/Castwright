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
