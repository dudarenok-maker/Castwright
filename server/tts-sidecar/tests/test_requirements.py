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


def _pkg(line):
    """Bare package name from a requirement line (strip extras + version spec)."""
    return line.split("[")[0].split(">")[0].split("=")[0].split("<")[0].split(";")[0].strip()


def _pin(line):
    """Exact `==` pin from a requirement line, or None."""
    return line.split("==", 1)[1].strip() if "==" in line else None


def test_torch_is_explicit():
    """torch MUST be an explicit requirement. It used to arrive transitively via
    coqui-tts, but coqui-tts 0.27.5 dropped that declaration — without an explicit
    line a fresh venv has NO torch and Coqui XTTS + Qwen synth (which import torch
    throughout main.py) fail. Kokoro (onnxruntime) is unaffected, so the sidecar
    would start but those engines would be silently broken."""
    assert any(_pkg(l) == "torch" for l in _lines()), \
        "expected an explicit torch requirement — coqui-tts no longer pulls it transitively"


def test_torch_and_torchaudio_are_a_matched_pair():
    """torchaudio is tightly coupled to torch's exact version, so both must be
    pinned to the SAME version. We pin the 2.8.0 pair (torch <2.9 keeps audio I/O
    in-core, so no torchcodec is needed)."""
    lines = _lines()
    torch_pin = next((_pin(l) for l in lines if _pkg(l) == "torch"), None)
    audio_pin = next((_pin(l) for l in lines if _pkg(l) == "torchaudio"), None)
    assert torch_pin is not None, "torch must be pinned with == to a matched torchaudio"
    assert audio_pin == torch_pin, \
        f"torch ({torch_pin}) and torchaudio ({audio_pin}) must be the same pinned version"
    major, minor = (int(x) for x in torch_pin.split(".")[:2])
    assert (major, minor) < (2, 9), \
        "torch must stay <2.9 so torchaudio keeps in-core audio I/O (no torchcodec)"


def test_no_torchcodec():
    """We dropped coqui-tts's `[codec]` extra, so torchcodec must NOT be pulled —
    it only ships cores for FFmpeg 4–7 and fails against the FFmpeg 8 on PATH, and
    is only needed on torch >=2.9 anyway."""
    assert not any(_pkg(l) == "torchcodec" for l in _lines()), \
        "torchcodec must not be a requirement (dropped with the [codec] extra)"
    assert not any("coqui-tts[codec]" in l for l in _lines()), \
        "coqui-tts must NOT use the [codec] extra (it pulls torchcodec)"
