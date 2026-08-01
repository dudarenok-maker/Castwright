"""`_make_whisper()`'s ASR_COMPUTE_TYPE pin, and `_bless()`'s ASR-stack
version stamp (#2004) -- caller-side wiring, no model, no GPU.

`test_golden_regression.py` is `@pytest.mark.golden`, but neither of these
needs a real model load to exercise:

- `_make_whisper()` only constructs a `main.WhisperEngine()` and reads back
  its resolved env-derived attributes (`_model_name`, `_device`, and now
  `_compute_type()`) -- the actual `faster_whisper` import + model load only
  happens lazily inside `WhisperEngine._ensure_loaded`, which this file never
  calls.
- `_bless()`'s ASR-stack version stamping (`_faster_whisper_version()` /
  `_ctranslate2_version()`) is pure `importlib.metadata` lookups; the rest of
  `_bless()` only needs objects that behave like the two engines, not the
  real ones.

This drives both DIRECTLY as plain function calls (no pytest marker), the
same technique `test_instruct_bless_gating.py` uses for
`test_instruct_golden.py`'s `_bless()`: importing a `golden`-marked module
and calling one of its functions is an ordinary Python call, not a pytest
collection, so the module-level `pytestmark` never attaches to these test
items.
"""
from __future__ import annotations

import json
import struct
import sys
from pathlib import Path

import pytest

SIDECAR_ROOT = Path(__file__).resolve().parents[2]
if str(SIDECAR_ROOT) not in sys.path:
    sys.path.insert(0, str(SIDECAR_ROOT))

import main  # noqa: E402

from tests.golden import test_golden_regression as golden  # noqa: E402


# ── ASR_COMPUTE_TYPE pin ────────────────────────────────────────────────────


def test_make_whisper_pins_compute_type_against_a_stray_ambient_value(monkeypatch) -> None:
    """#2004 repro: `_make_whisper()` pinned `ASR_MODEL`/`ASR_DEVICE` outright
    but left `ASR_COMPUTE_TYPE` ambient, so a stray value in the caller's
    shell (e.g. `float32`, set for an unrelated reason) would silently apply
    to the golden run and shift the tolerance-0 content-drift check for an
    environment reason, not an audio one. The fix must set it OUTRIGHT (same
    shape as `ASR_MODEL`/`ASR_DEVICE`) so the resolved engine always reports
    the pinned compute type regardless of what was ambient beforehand."""
    monkeypatch.setenv("ASR_COMPUTE_TYPE", "float32")  # a plausible stray ambient value

    engine = golden._make_whisper()

    assert engine._compute_type() == golden.ASR_COMPUTE_TYPE_NAME


def test_make_whisper_pins_compute_type_with_nothing_ambient(monkeypatch) -> None:
    monkeypatch.delenv("ASR_COMPUTE_TYPE", raising=False)

    engine = golden._make_whisper()

    assert engine._compute_type() == golden.ASR_COMPUTE_TYPE_NAME


def test_asr_compute_type_name_matches_the_cpu_default() -> None:
    """`ASR_COMPUTE_TYPE_NAME` must actually BE the value `_compute_type()`
    resolves to for `ASR_DEVICE_NAME` ("cpu") with nothing overridden --
    otherwise the pin would just be asserting a made-up constant, not the
    value the recorded baseline was actually measured under."""
    family, _ = main._parse_device(golden.ASR_DEVICE_NAME)
    assert family == "cpu"
    # Mirrors WhisperEngine._compute_type's own default table (main.py).
    assert golden.ASR_COMPUTE_TYPE_NAME == "int8"


# ── ASR-stack version stamp in `_bless()`'s metadata (#2004) ───────────────


class _StubKokoro:
    """Enough of `main.KokoroEngine`'s surface for `_bless()`: a
    `_model_path` (for `model_sha256`, which tolerates a missing file) and a
    `synthesize()` that returns a real `main.SynthResult`."""

    _model_path = "/nonexistent/kokoro-weights.onnx"

    def synthesize(self, model: str, voice: str, text: str) -> "main.SynthResult":
        return main.SynthResult(
            pcm=struct.pack("<4h", 0, 0, 0, 0), sample_rate=24000, substituted_from=None
        )


class _StubWhisper:
    """Returns the fixture's OWN text as the transcript, so `bless_guard`'s
    first-bless WER floor is trivially satisfied (0 edits) and the write
    isn't refused for a reason unrelated to what this file tests."""

    def transcribe(self, pcm: bytes, sample_rate: int, language=None) -> dict:
        return {"text": _StubWhisper.next_text}

    next_text = "hello world"


def test_bless_stamps_asr_stack_versions_into_metadata(monkeypatch, tmp_path) -> None:
    """`kokoro-baseline.json`'s `metadata` already stamps `kokoro_onnx_version`
    + `model_sha256` "so a model bump is legible" (the file's own `_comment`).
    The content-drift side (`transcript`, added by #1911) had no equivalent --
    a `faster-whisper`/`ctranslate2` bump shifted every transcript with zero
    diagnostic on a tolerance-0 gate. `_bless()` must stamp both, mirroring
    the synth-side fields it already writes."""
    baseline_path = tmp_path / "kokoro-baseline.json"
    baseline_path.write_text(json.dumps({"entries": {}}), encoding="utf-8")
    monkeypatch.setattr(golden, "BASELINE_PATH", baseline_path)

    fixture = {"model": "v1", "lines": [{"id": "line1", "voice": "af_heart", "text": "hello world"}]}

    golden._bless(_StubKokoro(), _StubWhisper(), fixture)

    written = json.loads(baseline_path.read_text(encoding="utf-8"))
    metadata = written["metadata"]
    assert "faster_whisper_version" in metadata
    assert "ctranslate2_version" in metadata
