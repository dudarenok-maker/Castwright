"""The golden cross-engine sanity gate must be able to FAIL (GATE 1 IMP-2).

`test_cross_engine_sanity.py` is `@pytest.mark.golden`, so it never runs in
the fast `test:sidecar` tier and its own behaviour was never covered by
anything. That is how it shipped wrapping both of its synth calls in
`except Exception: pytest.skip(...)` — which turns the
`assert text_tokens.shape[-1] < gpt_max_text_tokens` crash it was written to
catch into a SKIP, i.e. a green run. The tenth placebo test found on this
branch.

These cases are deliberately NOT marked golden: they drive the real golden
test FUNCTIONS with a stubbed engine, so the gate's own pass/skip/fail
behaviour is pinned on every ordinary run, with no model, no GPU and no
weights. Mirrors why `test_golden_compare.py` covers `compare.py` in the fast
tier.

The `test_kokoro_golden_content_*` section (ops-45 / #1911) applies the same
treatment to the new content-drift gate: `test_golden_regression.py`'s
`test_kokoro_golden_content_matches_baseline` is driven with a stubbed Kokoro
+ stubbed Whisper + a tmp_path baseline/fixture pair, so the gating logic
(GOLDEN_ASR=0 first, GOLDEN_BLESS second, ASR failure -> FAIL never SKIP,
wrong ASR_MODEL -> FAIL, the baseline transcript is actually consulted) is
pinned with no model, no GPU, and no weights.
"""
from __future__ import annotations

import json
import struct
import sys
from pathlib import Path
from typing import Optional

import pytest

SIDECAR_ROOT = Path(__file__).resolve().parent.parent
if str(SIDECAR_ROOT) not in sys.path:
    sys.path.insert(0, str(SIDECAR_ROOT))

import main  # noqa: E402

from tests.golden import test_cross_engine_sanity as sanity  # noqa: E402
from tests.golden import test_golden_regression as golden  # noqa: E402
from tests.golden.prereq import engine_absent_reason, synthesise_or_skip  # noqa: E402

# The real upstream failure text, from `Xtts.inference` (xtts.py:516) — the
# crash `enable_text_splitting=True` prevents.
TEXT_SPLITTING_CRASH = "text_tokens.shape[-1] < gpt_max_text_tokens"


def _plausible_pcm(seconds: float = 1.0, sample_rate: int = 24000) -> bytes:
    """Audio that passes `_assert_sane`: 24 kHz, mono int16, non-silent, and
    a plausible duration. Built here rather than reused from a fixture so a
    change to the sanity thresholds surfaces as a failure in these tests too."""
    count = int(seconds * sample_rate)
    # Constant amplitude ~0.3 full scale -> rms 0.3, well over MIN_RMS (0.01).
    return struct.pack("<%dh" % count, *([9830] * count))


def _ok_result() -> main.SynthResult:
    return main.SynthResult(pcm=_plausible_pcm(), sample_rate=24000, substituted_from=None)


class _StubCoquiEngine:
    """Minimal stand-in for `CoquiEngine` as the golden tests use it: the key
    prefix constant plus `synthesize`. `raise_on_long` reproduces the
    regression — a short line renders, a long one hard-crashes on the
    upstream token-length assert."""

    XTTS_KEY_PREFIX = "xtts-"

    def __init__(self, *, raise_on_long: bool = False, always_raise: BaseException | None = None) -> None:
        self.raise_on_long = raise_on_long
        self.always_raise = always_raise
        self.calls: list[str] = []

    def synthesize(self, model: str, voice: str, text: str) -> main.SynthResult:
        self.calls.append(text)
        if self.always_raise is not None:
            raise self.always_raise
        if self.raise_on_long and len(text) > 250:
            raise AssertionError(TEXT_SPLITTING_CRASH)
        return _ok_result()


def _expect_raise(fn, exc_type: type, match: str = "") -> BaseException:
    """Call `fn` and require it to RAISE `exc_type`.

    Load-bearing detail, found by mutating this very file: `pytest.skip()`
    raises `Skipped`, which derives from `BaseException`, so a plain
    `with pytest.raises(AssertionError): gate()` does NOT fail when the gate
    skips — the `Skipped` sails past `pytest.raises` and marks THIS test
    skipped, which reads as green. Testing a "must not skip" property with
    `pytest.raises` alone reproduces the exact defect under test one level
    up. So `Skipped` is caught first and converted into a hard failure."""
    try:
        fn()
    except pytest.skip.Exception as skipped:
        pytest.fail(f"the gate reported SKIP instead of failing: {skipped}")
    except exc_type as exc:  # type: ignore[misc]
        if match and match not in str(exc):
            pytest.fail(f"raised {exc_type.__name__} but not the expected one: {exc}")
        return exc
    pytest.fail(f"the gate did not raise {exc_type.__name__} at all")


def _expect_pass(fn) -> None:
    """Call `fn` and require it to complete — neither raising nor skipping.
    Same reasoning as `_expect_raise`: an unnoticed skip is a green run."""
    try:
        fn()
    except pytest.skip.Exception as skipped:
        pytest.fail(f"the gate reported SKIP on a healthy engine: {skipped}")


def _expect_skip_containing(fn, needle: str) -> None:
    """Call `fn` and require it to SKIP, with `needle` in the skip reason.

    #1911 s5a: the `GOLDEN_ASR=0` case can pass vacuously. On a box with no
    Kokoro weights, `_make_kokoro()` has its OWN skip path (missing weights),
    which does not mention GOLDEN_ASR — so a case that only asserts "it
    skipped" stays green even if the GOLDEN_ASR=0 check regresses to run
    AFTER `_make_kokoro()`. Asserting the reason string closes that hole."""
    try:
        fn()
    except pytest.skip.Exception as skipped:
        assert needle in str(skipped), f"skipped for the wrong reason: {skipped}"
        return
    pytest.fail(f"expected the gate to SKIP (reason containing {needle!r}), but it did not")


# ── the classifier ────────────────────────────────────────────────────────


def test_engine_absent_reason_skips_only_a_missing_engine() -> None:
    assert engine_absent_reason(ImportError("No module named 'TTS'")) is not None
    assert engine_absent_reason(
        RuntimeError("Failed to import coqui-tts (No module named 'TTS').")
    ) is not None
    assert engine_absent_reason(
        RuntimeError("PyTorch missing from this venv (No module named 'torch').")
    ) is not None


def test_engine_absent_reason_does_not_absorb_a_real_failure() -> None:
    """The four shapes the old blanket handler swallowed. Each must return
    None so the caller re-raises and the test FAILS."""
    assert engine_absent_reason(AssertionError(TEXT_SPLITTING_CRASH)) is None
    assert engine_absent_reason(
        main.VoiceNotDesignedError("Voice 'xtts-x' has not been cloned yet (no cached latents).")
    ) is None
    assert engine_absent_reason(
        RuntimeError("CUDA error: device-side assert triggered")
    ) is None
    assert engine_absent_reason(TypeError("inference() got an unexpected keyword argument")) is None


def test_synthesise_or_skip_propagates_a_regression() -> None:
    engine = _StubCoquiEngine(always_raise=AssertionError(TEXT_SPLITTING_CRASH))
    _expect_raise(
        lambda: synthesise_or_skip(engine, "xtts_v2", "xtts-x", "hello"),
        AssertionError, "gpt_max_text_tokens",
    )


def test_synthesise_or_skip_skips_a_missing_engine() -> None:
    engine = _StubCoquiEngine(
        always_raise=RuntimeError("Failed to import coqui-tts (No module named 'TTS').")
    )
    with pytest.raises(pytest.skip.Exception):
        synthesise_or_skip(engine, "xtts_v2", "xtts-x", "hello")


# ── the golden gate itself ────────────────────────────────────────────────


def test_clone_sanity_fails_on_the_text_splitting_regression(monkeypatch) -> None:
    """THE regression IMP-2 is about. `LONG_SANITY_TEXT` is over XTTS's
    250-char English split threshold precisely so that dropping
    `enable_text_splitting=True` from `_infer_from_latents` trips the
    upstream assert. Under the old blanket handler that reported SKIP.
    It must report FAILURE."""
    monkeypatch.setenv("GOLDEN_XTTS_CLONE", "some-cloned-uuid")
    engine = _StubCoquiEngine(raise_on_long=True)
    monkeypatch.setattr(main, "CoquiEngine", lambda: engine)

    _expect_raise(sanity.test_xtts_clone_sanity, AssertionError, "gpt_max_text_tokens")

    # Both renders were attempted — the short one succeeded, so the failure
    # is unambiguously the long-sentence path and not a cold-start problem.
    assert len(engine.calls) == 2
    assert len(engine.calls[1]) > 250


def test_clone_sanity_fails_when_the_named_voice_is_missing(monkeypatch) -> None:
    """A caller who set GOLDEN_XTTS_CLONE=<uuid> asserted that voice exists.
    `VoiceNotDesignedError` is therefore a setup error to surface, not an
    "engine/voice unavailable" skip — and it is a `RuntimeError` subclass, so
    a type-based classifier would have swept it back in."""
    monkeypatch.setenv("GOLDEN_XTTS_CLONE", "some-cloned-uuid")
    engine = _StubCoquiEngine(
        always_raise=main.VoiceNotDesignedError("Voice 'xtts-x' has not been cloned yet.")
    )
    monkeypatch.setattr(main, "CoquiEngine", lambda: engine)

    _expect_raise(sanity.test_xtts_clone_sanity, main.VoiceNotDesignedError)


def test_clone_sanity_still_skips_when_coqui_is_not_installed(monkeypatch) -> None:
    """The narrowing must not break the legitimate case: a box without
    coqui-tts still SKIPs rather than failing an opt-in golden run."""
    monkeypatch.setenv("GOLDEN_XTTS_CLONE", "some-cloned-uuid")
    engine = _StubCoquiEngine(
        always_raise=RuntimeError("Failed to import coqui-tts (No module named 'TTS').")
    )
    monkeypatch.setattr(main, "CoquiEngine", lambda: engine)

    with pytest.raises(pytest.skip.Exception):
        sanity.test_xtts_clone_sanity()


def test_clone_sanity_passes_on_a_healthy_engine(monkeypatch) -> None:
    """Control: with both renders healthy the gate passes, so the failure
    cases above are attributable to the injected fault and not to the stub
    tripping `_assert_sane` on every path."""
    monkeypatch.setenv("GOLDEN_XTTS_CLONE", "some-cloned-uuid")
    engine = _StubCoquiEngine()
    monkeypatch.setattr(main, "CoquiEngine", lambda: engine)

    _expect_pass(sanity.test_xtts_clone_sanity)

    assert len(engine.calls) == 2


def test_designed_sanity_fails_on_a_stranded_artifact(monkeypatch) -> None:
    """`test_xtts_designed_sanity` had the same swallow. A designed voice
    whose synthetic-clip-derived `.pt` never landed must fail this delivery
    gate — absorbing it is how the wave3c §2.3 deferral would have shipped
    unnoticed."""
    monkeypatch.setenv("GOLDEN_XTTS_DESIGNED", "some-designed-uuid")
    engine = _StubCoquiEngine(
        always_raise=main.VoiceNotDesignedError("Voice 'xtts-d' has not been cloned yet.")
    )
    monkeypatch.setattr(main, "CoquiEngine", lambda: engine)

    _expect_raise(sanity.test_xtts_designed_sanity, main.VoiceNotDesignedError)


def test_designed_sanity_still_skips_when_the_env_flag_is_absent(monkeypatch) -> None:
    """The opt-in gate itself is untouched — no flag, no run."""
    monkeypatch.delenv("GOLDEN_XTTS_DESIGNED", raising=False)
    with pytest.raises(pytest.skip.Exception):
        sanity.test_xtts_designed_sanity()


# ── content-drift gate (ops-45 / #1911) ────────────────────────────────────


class _StubKokoroEngine:
    """Minimal stand-in for `KokoroEngine` as `_make_kokoro()` uses it
    (#1911 s5c). `_StubCoquiEngine` above is Coqui-shaped: no `_model_path` /
    `_voices_path` file-presence check, no `FALLBACK_VOICE`. `_make_kokoro`
    checks both paths on disk BEFORE the ASR path this file exists to gate,
    so a Coqui-shaped stub would skip before ever reaching it (compounding
    the s5a vacuous-pass hole)."""

    FALLBACK_VOICE = "af_heart"

    def __init__(
        self, model_path: Path, voices_path: Path, *, result: Optional["main.SynthResult"] = None
    ) -> None:
        self._model_path = str(model_path)
        self._voices_path = str(voices_path)
        self.calls: list[str] = []
        self._result = result

    def synthesize(self, model: str, voice: str, text: str) -> main.SynthResult:
        self.calls.append(text)
        return self._result if self._result is not None else _ok_result()


class _StubWhisperEngine:
    """Stand-in for `WhisperEngine` as `_make_whisper()` /
    `test_kokoro_golden_content_matches_baseline` use it. `next_text`
    controls what `.transcribe()` "hears"; `always_raise` reproduces M3 (a
    `faster_whisper` import failure surfacing as a RuntimeError) without a
    real model. `model_name` / `device` let a case mismatch the pinned
    ASR_MODEL / ASR_DEVICE (#1911 s2e) to prove that gate fires."""

    def __init__(
        self,
        *,
        next_text: str = "",
        always_raise: Optional[BaseException] = None,
        model_name: str = "base",
        device: str = "cpu",
    ) -> None:
        self._model_name = model_name
        self._device = device
        self.next_text = next_text
        self.always_raise = always_raise
        self.calls = 0

    def transcribe(self, pcm: bytes, sample_rate: int, language: Optional[str] = None, **_: object) -> dict:
        self.calls += 1
        if self.always_raise is not None:
            raise self.always_raise
        return {
            "text": self.next_text,
            "language": language,
            "avg_logprob": -0.1,
            "no_speech_prob": 0.01,
            "compression_ratio": 1.2,
            "words": None,
        }


def _write_kokoro_stub_fixture_and_baseline(
    tmp_path: Path, *, recorded_transcript: Optional[str] = "hello world"
) -> tuple[Path, Path]:
    """One fixture line ("stub-line") + one matching baseline entry, written
    to `tmp_path` so `golden.FIXTURE_PATH` / `golden.BASELINE_PATH` can be
    monkeypatched onto them. `recorded_transcript=None` reproduces the
    unblessed-content case (no `transcript` key yet)."""
    fixture_path = tmp_path / "fixture.json"
    baseline_path = tmp_path / "kokoro-baseline.json"
    fixture_path.write_text(
        json.dumps(
            {
                "model": "v1",
                "lines": [{"id": "stub-line", "voice": "af_heart", "text": "hello world"}],
            }
        ),
        encoding="utf-8",
    )
    entry = {"voice": "af_heart", "sample_rate": 24000, "sample_count": 24000, "duration_sec": 1.0}
    if recorded_transcript is not None:
        entry["transcript"] = recorded_transcript
        entry["text_edits"] = 0
    baseline_path.write_text(
        json.dumps({"tolerance": 0.05, "entries": {"stub-line": entry}}), encoding="utf-8"
    )
    return fixture_path, baseline_path


def _patch_kokoro_stub(monkeypatch, tmp_path: Path) -> _StubKokoroEngine:
    model_path = tmp_path / "kokoro-v1.0.onnx"
    voices_path = tmp_path / "voices-v1.0.bin"
    model_path.write_bytes(b"")
    voices_path.write_bytes(b"")
    stub = _StubKokoroEngine(model_path, voices_path)
    monkeypatch.setattr(main, "KokoroEngine", lambda: stub)
    # `_make_whisper()` sets these OUTRIGHT via a raw `os.environ[...] = `
    # (by design -- #1911 s2e), which monkeypatch cannot see or auto-revert.
    # Priming both keys through monkeypatch.setenv first means its teardown
    # restores whatever this process's ambient value was, undoing that raw
    # write so this test can't leak ASR_MODEL/ASR_DEVICE into a sibling test
    # later in the same fast-tier pytest session.
    monkeypatch.setenv("ASR_MODEL", "base")
    monkeypatch.setenv("ASR_DEVICE", "cpu")
    return stub


def test_content_gate_golden_asr_0_skips_before_touching_kokoro(monkeypatch, tmp_path) -> None:
    """`GOLDEN_ASR=0` must be checked FIRST (#1911 s2f step 1) — before
    `_make_kokoro()` is ever reached. `main.KokoroEngine` is monkeypatched to
    something that raises if constructed at all, so a check-order regression
    fails loudly here instead of silently skipping for the WRONG reason
    (`_make_kokoro`'s own weights-missing path, which never mentions
    GOLDEN_ASR — see `_expect_skip_containing`)."""
    monkeypatch.setenv("GOLDEN_ASR", "0")
    monkeypatch.setattr(
        main,
        "KokoroEngine",
        lambda: pytest.fail("GOLDEN_ASR=0 must short-circuit before constructing KokoroEngine"),
    )

    _expect_skip_containing(golden.test_kokoro_golden_content_matches_baseline, "GOLDEN_ASR")


def test_content_gate_golden_bless_skips(monkeypatch) -> None:
    """Content is (re)recorded inside the lengths test's `_bless()` call, not
    here (#1911 s2f step 2) — running on a first bless (no `transcript` yet)
    would fail for the wrong reason."""
    monkeypatch.delenv("GOLDEN_ASR", raising=False)
    monkeypatch.setenv("GOLDEN_BLESS", "1")

    with pytest.raises(pytest.skip.Exception):
        golden.test_kokoro_golden_content_matches_baseline()


def test_content_gate_asr_failure_fails_never_skips(monkeypatch, tmp_path) -> None:
    """M3 shape, permanent fast-tier coverage (#1911 s5b/s6): ANY exception
    from `WhisperEngine.transcribe()` must FAIL the test, never skip it —
    this path must not route through `prereq.engine_absent_reason` /
    `synthesise_or_skip`, which would turn a missing `faster_whisper` into a
    green SKIP (the exact placebo #1911 exists to prevent)."""
    monkeypatch.delenv("GOLDEN_ASR", raising=False)
    monkeypatch.delenv("GOLDEN_BLESS", raising=False)
    fixture_path, baseline_path = _write_kokoro_stub_fixture_and_baseline(tmp_path)
    monkeypatch.setattr(golden, "FIXTURE_PATH", fixture_path)
    monkeypatch.setattr(golden, "BASELINE_PATH", baseline_path)
    _patch_kokoro_stub(monkeypatch, tmp_path)
    whisper = _StubWhisperEngine(
        always_raise=RuntimeError(
            "Failed to import faster-whisper (No module named 'faster_whisper')."
        )
    )
    monkeypatch.setattr(main, "WhisperEngine", lambda: whisper)

    _expect_raise(
        golden.test_kokoro_golden_content_matches_baseline,
        pytest.fail.Exception,
        "ASR transcription failed",
    )
    assert whisper.calls == 1


def test_content_gate_wrong_asr_model_fails(monkeypatch, tmp_path) -> None:
    """`_model_name != 'base'` must FAIL (#1911 s5 table) — the recorded
    transcript baseline does not apply to a different model."""
    monkeypatch.delenv("GOLDEN_ASR", raising=False)
    monkeypatch.delenv("GOLDEN_BLESS", raising=False)
    fixture_path, baseline_path = _write_kokoro_stub_fixture_and_baseline(tmp_path)
    monkeypatch.setattr(golden, "FIXTURE_PATH", fixture_path)
    monkeypatch.setattr(golden, "BASELINE_PATH", baseline_path)
    _patch_kokoro_stub(monkeypatch, tmp_path)
    monkeypatch.setattr(main, "WhisperEngine", lambda: _StubWhisperEngine(model_name="tiny"))

    _expect_raise(
        golden.test_kokoro_golden_content_matches_baseline,
        AssertionError,
        "ASR_MODEL resolved to",
    )


def test_content_gate_passes_when_fresh_transcript_matches_the_recorded_baseline(
    monkeypatch, tmp_path
) -> None:
    """Control for the M4 pair below: a fresh transcript identical to the
    recorded baseline passes cleanly.

    F6b (PR #2002 code-review): the failing twin below asserts
    `whisper.calls == 1`; this control had omitted it, so it could pass with
    zero transcribes ever attempted -- one loop-mutation (e.g. an early
    `continue`/`return` skipping the whole body) from vacuous."""
    monkeypatch.delenv("GOLDEN_ASR", raising=False)
    monkeypatch.delenv("GOLDEN_BLESS", raising=False)
    fixture_path, baseline_path = _write_kokoro_stub_fixture_and_baseline(
        tmp_path, recorded_transcript="hello world"
    )
    monkeypatch.setattr(golden, "FIXTURE_PATH", fixture_path)
    monkeypatch.setattr(golden, "BASELINE_PATH", baseline_path)
    _patch_kokoro_stub(monkeypatch, tmp_path)
    whisper = _StubWhisperEngine(next_text="hello world")
    monkeypatch.setattr(main, "WhisperEngine", lambda: whisper)

    _expect_pass(golden.test_kokoro_golden_content_matches_baseline)
    assert whisper.calls == 1


def test_content_gate_fails_when_the_baseline_transcript_differs(monkeypatch, tmp_path) -> None:
    """M4 shape (#1911 s6): editing the RECORDED baseline transcript (not the
    stub's fresh output, which is unchanged from the passing control above)
    must flip this to a failure — proving the baseline is actually consulted
    rather than the gate comparing a fresh transcript to itself."""
    monkeypatch.delenv("GOLDEN_ASR", raising=False)
    monkeypatch.delenv("GOLDEN_BLESS", raising=False)
    fixture_path, baseline_path = _write_kokoro_stub_fixture_and_baseline(
        tmp_path, recorded_transcript="goodbye world"  # <- only this changed vs the control
    )
    monkeypatch.setattr(golden, "FIXTURE_PATH", fixture_path)
    monkeypatch.setattr(golden, "BASELINE_PATH", baseline_path)
    _patch_kokoro_stub(monkeypatch, tmp_path)
    monkeypatch.setattr(main, "WhisperEngine", lambda: _StubWhisperEngine(next_text="hello world"))

    _expect_raise(
        golden.test_kokoro_golden_content_matches_baseline,
        AssertionError,
        "content drift",
    )


def test_content_gate_fails_with_no_recorded_transcript(monkeypatch, tmp_path) -> None:
    """An unblessed-for-content entry (duration data present, no `transcript`
    key yet) must FAIL with a re-bless hint, not silently pass or skip
    (#1911 s5 table) — on a box with everything else present this is a
    defect, not a valid steady state."""
    monkeypatch.delenv("GOLDEN_ASR", raising=False)
    monkeypatch.delenv("GOLDEN_BLESS", raising=False)
    fixture_path, baseline_path = _write_kokoro_stub_fixture_and_baseline(
        tmp_path, recorded_transcript=None
    )
    monkeypatch.setattr(golden, "FIXTURE_PATH", fixture_path)
    monkeypatch.setattr(golden, "BASELINE_PATH", baseline_path)
    _patch_kokoro_stub(monkeypatch, tmp_path)
    monkeypatch.setattr(main, "WhisperEngine", lambda: _StubWhisperEngine(next_text="hello world"))

    _expect_raise(
        golden.test_kokoro_golden_content_matches_baseline,
        AssertionError,
        "re-bless required",
    )


# ── _bless caller-side wiring (PR #2002 code-review, F1) ───────────────────


def test_bless_writes_the_baseline_when_every_line_is_accepted(monkeypatch, tmp_path) -> None:
    """Control for the refusal case below: a clean bless (fresh transcript
    matches the recorded one, no drift) actually writes the file -- proving
    the refusal test below isn't vacuously green because `_bless` never
    writes anything at all.

    Also checks the WRITTEN content, not just that some bytes changed
    (a follow-on gap of the same F1 shape, found while closing F1 itself):
    the recorded transcript here is deliberately ONE word longer than the
    fixture `text` ("hello there world" vs "hello world"), so the correct
    `text_edits` is 1, not 0 -- a caller-side bug that hardcoded `text_edits`
    to 0 (or copied the wrong field, or wrote under the wrong line id) would
    still make `after != before` true, so that check alone would not have
    caught it."""
    fixture_path, baseline_path = _write_kokoro_stub_fixture_and_baseline(
        tmp_path, recorded_transcript="hello there world"
    )
    # A stale entry for a line no longer in fixture.json -- a REPLACE must
    # drop it; a MERGE (`baseline.setdefault("entries", {}).update(entries)`)
    # would let it survive. A single-line fixture can't observe this
    # distinction at all (replace and merge produce the same one key), which
    # is exactly why F1b's mutation was invisible to the original control.
    baseline_data = json.loads(baseline_path.read_text(encoding="utf-8"))
    baseline_data["entries"]["leftover-line"] = {
        "voice": "af_heart", "sample_rate": 24000, "sample_count": 1,
        "duration_sec": 0.0001, "transcript": "stale", "text_edits": 0,
    }
    # The EXISTING recorded voice deliberately differs from the fixture's
    # requested voice ("af_heart", set by _write_kokoro_stub_fixture_and_baseline)
    # -- a stand-in for "the cast reassigned this line's voice since the last
    # bless." `_bless` must write the REQUESTED voice, not carry the stale one
    # forward: `"voice": (existing or {}).get("voice", line["voice"])` would be
    # invisible if existing and requested voice happened to match.
    baseline_data["entries"]["stub-line"]["voice"] = "am_michael"
    baseline_path.write_text(json.dumps(baseline_data), encoding="utf-8")

    monkeypatch.setattr(golden, "BASELINE_PATH", baseline_path)
    monkeypatch.delenv("GOLDEN_REBLESS_CONTENT", raising=False)
    before = baseline_path.read_bytes()

    fixture = json.loads(fixture_path.read_text(encoding="utf-8"))
    # sample_rate (16000) and sample_count (20000, i.e. 1.25s) are
    # deliberately DIFFERENT values -- `_ok_result()`'s default
    # (24000 Hz / 1.0s) makes them both 24000, so a `sample_count` <->
    # `sample_rate` field swap in `_bless` is otherwise invisible.
    mismatched_pcm = struct.pack("<20000h", *([1000] * 20000))
    result = main.SynthResult(pcm=mismatched_pcm, sample_rate=16000, substituted_from=None)
    kokoro = _StubKokoroEngine(
        tmp_path / "kokoro-v1.0.onnx", tmp_path / "voices-v1.0.bin", result=result
    )
    whisper = _StubWhisperEngine(next_text="hello there world")  # matches recorded -> no refusal

    golden._bless(kokoro, whisper, fixture)

    after = baseline_path.read_bytes()
    assert after != before, "a clean bless must actually write the baseline"

    written = json.loads(after.decode("utf-8"))
    # F1b (post-merge re-review): only the `transcript`/`text_edits`/`voice`
    # fields were checked. `len(entries) == 1` (with the stale leftover entry
    # above) catches a spurious extra key AND a merge-not-replace write; the
    # three length fields (with sample_rate != sample_count above) catch a
    # mixed-up field (e.g. `sample_count` written from `m["sample_rate"]`)
    # that would silently corrupt compare.py's own length assertion, the one
    # thing ops-11 already shipped and ops-45 must not regress.
    assert len(written["entries"]) == 1
    assert "leftover-line" not in written["entries"]
    entry = written["entries"]["stub-line"]
    assert entry["transcript"] == "hello there world"
    assert entry["text_edits"] == 1  # content_edits("hello world", "hello there world")
    assert entry["voice"] == "af_heart"
    assert entry["sample_rate"] == 16000
    assert entry["sample_count"] == 20000
    assert entry["duration_sec"] == 1.25


def test_bless_aborts_and_writes_nothing_when_any_line_is_refused(monkeypatch, tmp_path) -> None:
    """F1 (PR #2002 code-review): `_bless`'s CALLER-side wiring had zero
    coverage. `bless_guard` (the pure function) is exhaustively pinned in
    `test_golden_compare.py`, but nothing pinned that `_bless()` actually
    reads the guard's verdict and aborts the WHOLE write on a refusal.
    Mutation-verified red against both: `if refusals: raise` neutered to
    `if False and refusals: raise`, and `if guard_reason is not None:
    refusals.append(...)` neutered the same way -- both left the entire
    fast tier green while writing the baseline despite a refusal.

    A refusal must both RAISE and leave the file BYTE-IDENTICAL -- checking
    only the exception would miss a mutation that drops the raise but still
    corrupts the file, or vice versa (the first #2002 mutation raises
    nothing AND writes)."""
    fixture_path, baseline_path = _write_kokoro_stub_fixture_and_baseline(
        tmp_path, recorded_transcript="hello world"
    )
    monkeypatch.setattr(golden, "BASELINE_PATH", baseline_path)
    monkeypatch.delenv("GOLDEN_REBLESS_CONTENT", raising=False)
    before = baseline_path.read_bytes()

    fixture = json.loads(fixture_path.read_text(encoding="utf-8"))
    kokoro = _StubKokoroEngine(tmp_path / "kokoro-v1.0.onnx", tmp_path / "voices-v1.0.bin")
    whisper = _StubWhisperEngine(next_text="hello there")  # differs from recorded -> G1 refuses

    with pytest.raises(AssertionError, match="Bless refused"):
        golden._bless(kokoro, whisper, fixture)

    after = baseline_path.read_bytes()
    assert after == before, "a refused bless must leave the baseline file untouched"


def test_bless_writes_the_fresh_transcript_under_rebless_content_not_the_stale_one(
    monkeypatch, tmp_path
) -> None:
    """F1a (post-merge re-review): G1's VERDICT was pinned (refuses/allows a
    differing transcript) but its BYPASS was not -- `GOLDEN_REBLESS_CONTENT=1`
    is the only path on which `fresh_transcript` and the existing recorded
    `transcript` actually differ, and no test anywhere drove `_bless` with it
    set (both `_bless` caller tests above `delenv` it, since neither needs
    the flag: one has fresh == recorded, the other is refused before the
    write). That left a caller-side bug -- writing the STALE recorded
    transcript back instead of the fresh one -- completely undetected:
    mutating `"transcript": fresh_transcript` to
    `(existing or {}).get("transcript", fresh_transcript)` was GREEN across
    all 55 tests.

    Recorded transcript matches the fixture text exactly (0 edits); fresh
    has 1 edit ("hello there world" vs "hello world") -- inside the +1 cap,
    so G2 allows it once G1 is bypassed by the flag. The bless must write
    the FRESH transcript, not silently re-write the stale recorded one."""
    fixture_path, baseline_path = _write_kokoro_stub_fixture_and_baseline(
        tmp_path, recorded_transcript="hello world"
    )
    monkeypatch.setattr(golden, "BASELINE_PATH", baseline_path)
    monkeypatch.setenv("GOLDEN_REBLESS_CONTENT", "1")

    fixture = json.loads(fixture_path.read_text(encoding="utf-8"))
    kokoro = _StubKokoroEngine(tmp_path / "kokoro-v1.0.onnx", tmp_path / "voices-v1.0.bin")
    whisper = _StubWhisperEngine(next_text="hello there world")  # differs -> needs the flag

    golden._bless(kokoro, whisper, fixture)

    entry = json.loads(baseline_path.read_bytes().decode("utf-8"))["entries"]["stub-line"]
    assert entry["transcript"] == "hello there world"
    assert entry["text_edits"] == 1  # content_edits("hello world", "hello there world")


def test_bless_aborts_on_a_first_bless_ceiling_refusal_too(monkeypatch, tmp_path) -> None:
    """Fourth level (post-merge re-review, "is there a fourth level?"):
    every `_bless`-driving test above triggers a refusal via G1 (differing
    transcript, an `existing` entry present but with a different recorded
    `transcript`). None exercises `bless_guard`'s OTHER refusal reason, the
    first-bless gross-garbage ceiling -- which fires when the line has NO
    existing entry at all (`existing_entries.get(line["id"])` is `None`, not
    merely an entry dict missing a `transcript` key -- `_write_kokoro_stub_
    fixture_and_baseline(recorded_transcript=None)` still writes an entry
    with voice/sample_rate/etc, so it does NOT reach this branch; the entry
    is deleted outright below to get a genuinely absent key).

    `_bless`'s refusal handling (`if guard_reason is not None: refusals.
    append(...)`) doesn't branch on WHICH reason fired or on `existing`'s
    presence, so this is unlikely to catch a new mutation in `_bless` itself
    -- but it closes a caller-side regression that special-cases one
    refusal reason on `existing is not None`, which every G1 test above
    would still trip (their `existing` is always a real dict) and so could
    never observe such a gate. Verified: mutating the append to `if
    guard_reason is not None and existing is not None:` is GREEN on every
    other `_bless` test (their `existing` is always present) and RED only
    here."""
    fixture_path, baseline_path = _write_kokoro_stub_fixture_and_baseline(tmp_path)
    baseline_data = json.loads(baseline_path.read_text(encoding="utf-8"))
    del baseline_data["entries"]["stub-line"]  # genuinely absent key, not just no "transcript"
    baseline_path.write_text(json.dumps(baseline_data), encoding="utf-8")

    monkeypatch.setattr(golden, "BASELINE_PATH", baseline_path)
    monkeypatch.delenv("GOLDEN_REBLESS_CONTENT", raising=False)
    before = baseline_path.read_bytes()

    fixture = json.loads(fixture_path.read_text(encoding="utf-8"))
    kokoro = _StubKokoroEngine(tmp_path / "kokoro-v1.0.onnx", tmp_path / "voices-v1.0.bin")
    # WER 2.0 against "hello world" -- well past the 0.35 first-bless ceiling.
    whisper = _StubWhisperEngine(next_text="completely unrelated garbage words")

    with pytest.raises(AssertionError, match="Bless refused"):
        golden._bless(kokoro, whisper, fixture)

    after = baseline_path.read_bytes()
    assert after == before, "a first-bless-ceiling refusal must also leave the file untouched"
