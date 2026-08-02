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
import os
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


def _prime_make_whisper_env(monkeypatch) -> None:
    """`_make_whisper()` sets `ASR_MODEL`/`ASR_DEVICE`/`ASR_COMPUTE_TYPE`
    OUTRIGHT via a raw `os.environ[...] =` (by design -- #1911 s2e / #2004),
    which `monkeypatch` cannot see or auto-revert. #2045 F6 (independent
    review): priming all three through `monkeypatch.setenv` FIRST means its
    teardown restores whatever this process's ambient value was (or deletes
    the key if there wasn't one), undoing the raw write -- mirrors
    `test_golden_sanity_gating.py`'s `_patch_kokoro_stub` doing the same for
    `ASR_MODEL`/`ASR_DEVICE`. Without this, collection order (`tests/golden/`
    runs before `tests/`) means THIS file's raw writes land first and leak
    into a sibling test later in the same fast-tier pytest session -- benign
    today only because the pinned values happen to coincide with `main.py`'s
    defaults."""
    monkeypatch.setenv("ASR_MODEL", "base")
    monkeypatch.setenv("ASR_DEVICE", "cpu")
    monkeypatch.setenv("ASR_COMPUTE_TYPE", "int8")


def test_make_whisper_env_writes_do_not_leak_past_the_test() -> None:
    """#2045 F6 repro: `_make_whisper()` raw-writes `ASR_MODEL`/`ASR_DEVICE`/
    `ASR_COMPUTE_TYPE` via `os.environ[...] =`, which plain `monkeypatch`
    cannot see or auto-revert UNLESS those keys were first primed via
    `monkeypatch.setenv`/`delenv` -- priming snapshots the pre-call value so
    teardown restores it regardless of what a later RAW write does to it in
    between. This test drives its OWN nested `pytest.MonkeyPatch` context
    (not the outer fixture) so it can inspect environ state AFTER that
    context's teardown fires, from within a single test function -- the
    fixture-based tests around it can't observe their own teardown this way.

    Mutation-verified: commenting out the `_prime_make_whisper_env(mp)` call
    below (so `_make_whisper()`'s raw writes are never tracked by `mp` at
    all) leaves `ASR_MODEL`/`ASR_DEVICE`/`ASR_COMPUTE_TYPE` permanently set
    in `os.environ` after the `with` block exits -- this test goes RED."""
    keys = ("ASR_MODEL", "ASR_DEVICE", "ASR_COMPUTE_TYPE")
    before = {k: os.environ.get(k) for k in keys}

    with pytest.MonkeyPatch.context() as mp:
        _prime_make_whisper_env(mp)
        golden._make_whisper()
        # Mid-test: the raw write landed (sanity-check the mutation actually
        # exercises something, not a no-op).
        assert os.environ.get("ASR_MODEL") == "base"

    after = {k: os.environ.get(k) for k in keys}
    assert after == before, (
        f"_make_whisper()'s raw os.environ writes leaked past the test: "
        f"before={before!r} after={after!r}"
    )


def test_make_whisper_pins_compute_type_against_a_stray_ambient_value(monkeypatch) -> None:
    """#2004 repro: `_make_whisper()` pinned `ASR_MODEL`/`ASR_DEVICE` outright
    but left `ASR_COMPUTE_TYPE` ambient, so a stray value in the caller's
    shell (e.g. `float32`, set for an unrelated reason) would silently apply
    to the golden run and shift the tolerance-0 content-drift check for an
    environment reason, not an audio one. The fix must set it OUTRIGHT (same
    shape as `ASR_MODEL`/`ASR_DEVICE`) so the resolved engine always reports
    the pinned compute type regardless of what was ambient beforehand."""
    _prime_make_whisper_env(monkeypatch)
    monkeypatch.setenv("ASR_COMPUTE_TYPE", "float32")  # a plausible stray ambient value

    engine = golden._make_whisper()

    assert engine._compute_type() == golden.ASR_COMPUTE_TYPE_NAME


def test_make_whisper_pins_compute_type_with_nothing_ambient(monkeypatch) -> None:
    _prime_make_whisper_env(monkeypatch)
    monkeypatch.delenv("ASR_COMPUTE_TYPE", raising=False)

    engine = golden._make_whisper()

    assert engine._compute_type() == golden.ASR_COMPUTE_TYPE_NAME


def test_asr_compute_type_name_matches_the_default_compute_type_for_cpu(monkeypatch) -> None:
    """`ASR_COMPUTE_TYPE_NAME` must actually BE the value `main.WhisperEngine
    ._compute_type()` resolves to for `ASR_DEVICE_NAME` ("cpu") with nothing
    overridden -- otherwise the pin in `_make_whisper()` would just be
    asserting a made-up constant, not the value the recorded baseline was
    actually measured under.

    #2045 F3 (independent review): the earlier version of this test compared
    `golden.ASR_COMPUTE_TYPE_NAME == "int8"` -- a module constant against its
    OWN literal, never touching `main.py`'s actual default table at all.
    Mutating that table (`_compute_type`'s `"int8_float16" if family ==
    "cuda" else "float32"`, i.e. swapping the cpu branch's default from
    `"int8"` to `"float32"`) left the entire file green. Fixed by
    constructing `main.WhisperEngine()` DIRECTLY here -- not via
    `_make_whisper()`, which sets `ASR_COMPUTE_TYPE` outright and would mask
    exactly the default this test needs to see -- and reading back its
    real, computed `_compute_type()`."""
    monkeypatch.setenv("ASR_DEVICE", golden.ASR_DEVICE_NAME)
    monkeypatch.delenv("ASR_COMPUTE_TYPE", raising=False)

    engine = main.WhisperEngine()
    family, _ = main._parse_device(engine._device)
    assert family == "cpu"

    assert engine._compute_type() == golden.ASR_COMPUTE_TYPE_NAME


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
