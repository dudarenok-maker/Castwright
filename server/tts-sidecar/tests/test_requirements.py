"""Lock the onnxruntime dependency strategy: the shared overlay installs PLAIN
`kokoro-onnx` (→ the core `onnxruntime` CPU module). The GPU runtime is swapped in
separately by the nvidia-only ORT swap (scripts/install-ort.mjs), NOT by a line in
the overlay. Two things the overlay must therefore NEVER carry:
  - a bare unmarked `onnxruntime-gpu` line (no macOS wheel → aborts `pip install`
    on Apple Silicon, which reads this same overlay), and
  - `kokoro-onnx[gpu]` (the extra coexists with the core onnxruntime dep, and pip's
    resolution order can leave the CPU build owning the shared `onnxruntime/`
    namespace → a silent CPU-only Kokoro on a GPU box; the 2026-06-16 regression).

Engine tier: Qwen + Kokoro are STANDARD (in the overlay); Coqui is OPT-IN (removed
from the overlay, installed on demand from the Model Manager).

requirements.txt is a layered structure (a shim that `-r`-includes
requirements/nvidia-cuda.txt, which `-r`-includes requirements/base.txt), so the
checks below resolve the `-r` include chain and assert against the flattened
dependency set — independent of which overlay file a line happens to live in."""
from pathlib import Path

REQ = Path(__file__).resolve().parent.parent / "requirements.txt"
OVERLAY_DIR = Path(__file__).resolve().parent.parent / "requirements"


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


def test_kokoro_is_plain_no_gpu_extra():
    lines = _lines()
    assert any(_pkg(l) == "kokoro-onnx" for l in lines), \
        "expected a plain kokoro-onnx requirement"
    assert not any(l.startswith("kokoro-onnx[gpu]") for l in lines), \
        ("kokoro-onnx[gpu] must NOT be used — the [gpu] extra coexists with the core "
         "onnxruntime dep and can leave the CPU build owning the namespace (silent "
         "CPU-only Kokoro). onnxruntime-gpu is installed by the nvidia ORT swap instead.")


def test_no_bare_unmarked_onnxruntime_gpu():
    """onnxruntime-gpu must never appear in the shared overlay (mac reads it too) —
    it's installed only by the nvidia-only swap in scripts/install-ort.mjs."""
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
    pinned to the SAME version. The old 2.8.0 "<2.9 keeps in-core I/O" rationale
    no longer applies: the sidecar never calls torchaudio.load (Kokoro is ONNX,
    Qwen uses soundfile, Coqui uses pre-computed manifest-speaker latents), so
    torchaudio's 2.9 backend removal doesn't touch us. We assert a matched pair
    at or above the CVE-patched floor — torch >=2.10 clears CVE-2025-2999
    (unpack_sequence) and CVE-2025-3001 (lstm_cell). The "we never call
    torchaudio.load" invariant is enforced separately in
    test_audio_io_invariant.py."""
    lines = _lines()
    torch_pin = next((_pin(l) for l in lines if _pkg(l) == "torch"), None)
    audio_pin = next((_pin(l) for l in lines if _pkg(l) == "torchaudio"), None)
    assert torch_pin is not None, "torch must be pinned with == to a matched torchaudio"
    assert audio_pin == torch_pin, \
        f"torch ({torch_pin}) and torchaudio ({audio_pin}) must be the same pinned version"
    major, minor = (int(x) for x in torch_pin.split(".")[:2])
    assert (major, minor) >= (2, 10), \
        "torch must stay >=2.10 (clears CVE-2025-2999 unpack_sequence + CVE-2025-3001 lstm_cell)"


def test_no_torchcodec():
    """torchcodec must NOT be a manifest requirement. NOTE: this inspects the
    requirements-manifest TEXT (_lines()), not the installed venv — it guards
    against re-adding `coqui-tts[codec]` or a bare `torchcodec` line. The runtime
    guarantee that torchcodec is absent comes separately from torchaudio 2.11's
    empty Requires-Dist (a plain `pip install torchaudio==2.11.0` pulls no
    torchcodec). torchcodec ships cores for FFmpeg 4–7 only (fails against the
    FFmpeg 8 on PATH) and is reached only if you call torchaudio.load — we never
    do (see test_audio_io_invariant.py)."""
    assert not any(_pkg(l) == "torchcodec" for l in _lines()), \
        "torchcodec must not be a requirement (dropped with the [codec] extra)"
    assert not any("coqui-tts[codec]" in l for l in _lines()), \
        "coqui-tts must NOT use the [codec] extra (it pulls torchcodec)"


def _overlay_lines(name):
    """Flatten a named overlay (e.g. 'nvidia-cuda.txt') and its includes."""
    return _resolve(OVERLAY_DIR / name)


def test_coqui_absent_from_all_overlays():
    """Re-tier: Coqui is opt-in — it must NOT appear in any overlay (nvidia, amd, or cpu)."""
    for overlay in ("nvidia-cuda.txt", "amd-rocm.txt", "cpu.txt"):
        lines = _overlay_lines(overlay)
        assert not any(_pkg(l) == "coqui-tts" for l in lines), \
            f"coqui-tts must not be in {overlay} (it is now opt-in, installed via the Model Manager)"


def test_qwen_present_in_gpu_overlays():
    """Re-tier: qwen-tts is standard on GPU profiles (nvidia + amd)."""
    for overlay in ("nvidia-cuda.txt", "amd-rocm.txt"):
        lines = _overlay_lines(overlay)
        assert any(_pkg(l) == "qwen-tts" for l in lines), \
            f"qwen-tts must be in {overlay} (it is now standard on GPU profiles)"


def test_qwen_absent_from_cpu_overlay():
    """Qwen is GPU-only standard — it must NOT appear in the cpu overlay."""
    lines = _overlay_lines("cpu.txt")
    assert not any(_pkg(l) == "qwen-tts" for l in lines), \
        "qwen-tts must not be in cpu.txt (Qwen is GPU-only standard)"
