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
"""
from __future__ import annotations

import struct
import sys
from pathlib import Path

import pytest

SIDECAR_ROOT = Path(__file__).resolve().parent.parent
if str(SIDECAR_ROOT) not in sys.path:
    sys.path.insert(0, str(SIDECAR_ROOT))

import main  # noqa: E402

from tests.golden import test_cross_engine_sanity as sanity  # noqa: E402
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
