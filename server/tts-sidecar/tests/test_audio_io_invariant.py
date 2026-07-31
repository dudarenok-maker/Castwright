"""Forward guardrail (fs-38 voice cloning): the sidecar's OWN source must never
call torchaudio's loader (`.load` / `.save` / `.info`). torchaudio 2.9+ removed
the soundfile/sox backends, so those calls now dispatch to torchcodec, which
needs FFmpeg's SHARED libraries and fails outright against a static build
(#1967). Kokoro is ONNX; Qwen and the XTTS clone path read and write PCM
directly via the stdlib `wave` module + NumPy (see `xtts_audio_io.py`).

This test can only see the sidecar's OWN top-level source — it CANNOT see a
call made from inside a third-party package the sidecar invokes. That is
exactly how #1967 got past it: XTTS's own reference loader
(`TTS/tts/models/xtts.py`, installed under site-packages) called torchaudio's
loader internally, on the cloned-voice derive path, and this scan has no
visibility into installed packages. The regression coverage for that call path
— the poison test and the patched-loader mechanism tests — lives in
`tests/test_xtts_audio_io.py`, not here.

This test is EXPECTED to be vacuously green today (the sidecar's own source
contains no such call) — it exists to fail loudly if that ever changes."""
import re
from pathlib import Path

SIDECAR = Path(__file__).resolve().parent.parent

# Call-shaped: `torchaudio . (load|save|info) (`  — the dot/space-tolerant CALL
# form, so pip-install HELP strings ("... torch torchaudio ...") never match.
CALL = re.compile(r"torchaudio\s*\.\s*(?:load|save|info)\s*\(")


def _strip_comments(src: str) -> str:
    """Drop full-line comments so a `# don't use torchaudio.load(...)` note can't
    trip the check. A full tokenizer is overkill for a guardrail."""
    return "\n".join(l for l in src.splitlines() if not l.lstrip().startswith("#"))


def test_detector_regex_is_correct():
    # Real calls are flagged...
    assert CALL.search("wav, sr = torchaudio.load(path)")
    assert CALL.search("torchaudio . save ( buf , x )")
    assert CALL.search("torchaudio.info(p)")
    # ...help strings and bare mentions are NOT.
    assert not CALL.search("pip install torch torchaudio --index-url https://...")
    assert not CALL.search("import torchaudio")


def test_sidecar_source_never_calls_torchaudio_io():
    # Top-level *.py only (non-recursive) → excludes tests/ and the vendored .venv.
    offenders = []
    for path in sorted(SIDECAR.glob("*.py")):
        src = _strip_comments(path.read_text(encoding="utf-8"))
        if CALL.search(src):
            offenders.append(path.name)
    assert not offenders, (
        f"{offenders} call torchaudio.load/save/info — forbidden under torch >=2.9 "
        "(no soundfile backend; dispatches to torchcodec, which fails on a static "
        "FFmpeg build). Decode/encode audio via the stdlib wave module + NumPy "
        "instead (see xtts_audio_io.py). See the fs-38 voice-cloning guardrail "
        "and #1967."
    )
