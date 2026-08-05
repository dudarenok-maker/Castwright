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
import re
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
    no longer applies: the sidecar never calls torchaudio's loader (Kokoro is
    ONNX; Qwen and the XTTS clone path read and write PCM directly via the
    stdlib `wave` module + NumPy — see `xtts_audio_io.py`, #1967 — and stock
    XTTS inference uses pre-computed manifest-speaker latents), so torchaudio's
    2.9 backend removal doesn't touch us. We assert a matched pair at or above
    the CVE-patched floor — torch >=2.10 clears CVE-2025-2999 (unpack_sequence)
    and CVE-2025-3001 (lstm_cell). The "sidecar's own source never calls
    torchaudio.load" invariant is enforced separately in
    test_audio_io_invariant.py; that guard can't see into third-party packages,
    which is why the XTTS clone path needed its own patch and its own test
    (test_xtts_audio_io.py)."""
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
    against re-adding `coqui-tts[codec]` or a bare `torchcodec` line to the base/
    overlays. A plain `pip install torchaudio==2.11.0` pulls no torchcodec, so the
    STANDARD engines (Kokoro, Qwen) never get it.

    torchcodec is NOT categorically absent from a Coqui venv, though: opt-in Coqui
    needs it. coqui-tts 0.27.5 presence-checks torchcodec at IMPORT on torch>=2.9
    (`is_torchcodec_available()` → `find_spec("torchcodec")`, NOT a functional
    import), and raises ImportError without it — so install-coqui.mjs installs it
    (#1586). It need only be PRESENT, never functional: stock XTTS inference uses
    precomputed manifest-speaker latents, and the XTTS clone path's own reference
    loader — the one call that would otherwise reach torchcodec's FFmpeg decode —
    is patched out at derive time (`xtts_audio_io.py`, #1967; poison-tested in
    test_xtts_audio_io.py). Without that patch it would fail here: on a static
    FFmpeg build torchcodec can't even load its shared libs. That runtime
    install is the OPT-IN installer's job, never the manifest's; hence this stays a
    manifest-only guard."""
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


def test_spacy_and_sudachipy_are_explicit_and_opt_in_only():
    """spacy (#2017: `CoquiEngine._infer_from_latents` passes
    `enable_text_splitting=True`, config-faithful, mirroring `Xtts.synthesize`'s own
    build, which reaches upstream's `get_spacy_lang` — raising `ImportError` without
    spacy installed, so a cloned Coqui voice rendering a line at or above
    `tokenizer.char_limits[lang]` would 500 outright) is reached ONLY via the opt-in
    Coqui/XTTS path, same tier as coqui-tts itself — never by Qwen or Kokoro. So it
    must NOT be in the shared manifest/overlays (same re-tier shape
    `test_coqui_absent_from_all_overlays` guards for coqui-tts): a CPU-only or
    Kokoro-only install would otherwise pay for a library it never imports. It must
    instead be installed by `install-coqui.mjs`, alongside the CJK phonemizers in
    its third pip step.

    #2038 (superseding the original plain-spacy-only decision this test used to
    guard): `sudachipy` + `sudachidict-core` — the practical equivalent of the
    `spacy[ja]` extra, installed as separate lines rather than the extras syntax
    — now ship in that SAME opt-in step, closing the one language plain spacy left
    broken (Japanese cloned-voice text-splitting). Cost, paid on every Coqui
    install: +68.9 MB (`sudachidict-core` alone) — surfaced in the install label
    and this test's own docstring rather than silently absorbed, per the review
    that reopened #2038. Still opt-in-only: a CPU-only or Kokoro-only install pays
    neither figure, same as spacy itself."""
    lines = _lines()
    assert not any(_pkg(l) == "spacy" for l in lines), \
        "spacy must NOT be in the manifest/overlays (#2017) — it is reached only via " \
        "the opt-in Coqui/XTTS path, so it belongs in install-coqui.mjs, not base.txt " \
        "(a CPU-only/Kokoro-only install would otherwise pay for a library it never imports)"
    for pkg in ("sudachipy", "sudachidict-core", "sudachidict_core"):
        assert not any(_pkg(l) == pkg for l in lines), \
            f"{pkg} must NOT be in the manifest/overlays (#2038) — same opt-in-only " \
            "tier as spacy itself, installed by install-coqui.mjs instead"

    installer = (
        Path(__file__).resolve().parent.parent / "scripts" / "install-coqui.mjs"
    ).read_text(encoding="utf-8")
    # Check the actual quoted pip-arg strings, not prose: the rationale comment
    # legitimately *mentions* these package names in backticks to explain the
    # decision, so a bare substring check on the whole file would false-positive
    # on the comment even if the real pip argument were deleted. Extracted
    # PER LINE, not over the whole file as one blob: a `//`/`/* */` comment
    # line containing a natural English apostrophe (e.g. "Xtts.synthesize's
    # own build") throws off single-quote pairing for the rest of a whole-file
    # regex scan, silently swallowing every real arg that follows it — a line
    # is short enough that this can't happen within one.
    quoted_args = [
        m for line in installer.splitlines()
        for m in re.findall(r"""['"]([^'"]*)['"]""", line)
    ]
    assert any(a.startswith("spacy") for a in quoted_args), \
        "install-coqui.mjs must pass a quoted spacy pip argument (#2017) — " \
        "CoquiEngine._infer_from_latents needs it for enable_text_splitting=True"
    assert "sudachipy" in quoted_args, \
        "install-coqui.mjs must pass a quoted 'sudachipy' pip argument (#2038) — " \
        "Japanese cloned-voice text-splitting needs it alongside spacy"
    assert any(a in ("sudachidict-core", "sudachidict_core") for a in quoted_args), \
        "install-coqui.mjs must pass a quoted sudachidict-core pip argument (#2038) — " \
        "SudachiPy needs its dictionary package installed alongside it"
