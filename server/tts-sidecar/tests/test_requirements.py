"""Lock the onnxruntime dependency strategy: the GPU runtime must be pulled via
kokoro-onnx's platform-gated [gpu] extra, NOT a bare unmarked onnxruntime-gpu
line (which has no macOS wheel and aborts `pip install` on Apple Silicon).

requirements.txt is a layered structure (a shim that `-r`-includes
requirements/nvidia-cuda.txt, which `-r`-includes requirements/base.txt), so the
checks below resolve the `-r` include chain and assert against the flattened
dependency set — independent of which overlay file a line happens to live in."""
from pathlib import Path

REQ = Path(__file__).resolve().parent.parent / "requirements.txt"


def _resolve(path, seen=None):
    """Flatten a requirements file, following `-r <relative>` includes, into the
    list of dependency lines (comments/blank stripped). Relative `-r` paths
    resolve against the including file's directory, as pip does."""
    seen = set() if seen is None else seen
    path = path.resolve()
    if path in seen:
        return []
    seen.add(path)
    out = []
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith("-r "):
            out.extend(_resolve(path.parent / line[3:].strip(), seen))
        else:
            out.append(line)
    return out


def _lines():
    return _resolve(REQ)


def test_kokoro_uses_gpu_extra():
    assert any(l.startswith("kokoro-onnx[gpu]") for l in _lines()), \
        "expected kokoro-onnx[gpu] so onnxruntime-gpu is platform-gated by the extra"


def test_no_bare_unmarked_onnxruntime_gpu():
    for l in _lines():
        if l.startswith("onnxruntime-gpu") and ";" not in l:
            raise AssertionError(
                f"bare unmarked onnxruntime-gpu line will break macOS pip install: {l!r}")


def test_torch_is_explicit():
    """torch MUST be an explicit requirement. It used to arrive transitively via
    coqui-tts, but coqui-tts 0.27.5 dropped that declaration — without an explicit
    line a fresh venv has NO torch and Coqui XTTS + Qwen synth (which import torch
    throughout main.py) fail. Kokoro (onnxruntime) is unaffected, so the sidecar
    would start but those engines would be silently broken."""
    assert any(l.split("[")[0].split(">")[0].split("=")[0].strip() == "torch"
               for l in _lines()), \
        "expected an explicit torch requirement — coqui-tts no longer pulls it transitively"
