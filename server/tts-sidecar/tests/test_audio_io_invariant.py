"""Forward guardrail (fs-38 voice cloning): the sidecar's OWN source must never
call torchaudio.load / .save / .info. torchaudio 2.9+ removed the soundfile/sox
backends, so those calls hard-require torchcodec (uninstalled) and raise
ImportError. The sidecar avoids them entirely — Kokoro is ONNX, Qwen reads audio
via soundfile (sf.read), and Coqui is driven with manifest speakers (pre-computed
latents), never a speaker_wav path. When fs-38 adds reference-clip cloning it MUST
load the reference WAV via soundfile, not torchaudio.load.

This test is EXPECTED to be vacuously green today (the sidecar contains no such
call) — it exists to fail loudly if that ever changes."""
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
        "(no soundfile backend; would need torchcodec). Load audio via soundfile "
        "(sf.read) instead. See the fs-38 voice-cloning guardrail."
    )
