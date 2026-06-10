"""Lock the onnxruntime dependency strategy: the GPU runtime must be pulled via
kokoro-onnx's platform-gated [gpu] extra, NOT a bare unmarked onnxruntime-gpu
line (which has no macOS wheel and aborts `pip install` on Apple Silicon)."""
from pathlib import Path

REQ = Path(__file__).resolve().parent.parent / "requirements.txt"


def _lines():
    return [l.strip() for l in REQ.read_text(encoding="utf-8").splitlines()
            if l.strip() and not l.strip().startswith("#")]


def test_kokoro_uses_gpu_extra():
    assert any(l.startswith("kokoro-onnx[gpu]") for l in _lines()), \
        "expected kokoro-onnx[gpu] so onnxruntime-gpu is platform-gated by the extra"


def test_no_bare_unmarked_onnxruntime_gpu():
    for l in _lines():
        if l.startswith("onnxruntime-gpu") and ";" not in l:
            raise AssertionError(
                f"bare unmarked onnxruntime-gpu line will break macOS pip install: {l!r}")
