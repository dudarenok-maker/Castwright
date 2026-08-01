"""Cross-engine sanity for the golden-audio harness (ops-11) — REAL models.

Coqui XTTS and Qwen are stochastic (no seed), so they get LOOSE, format-level
checks rather than Kokoro's exact length baseline: correct wire format
(24 kHz / int16 / mono), non-silent audio, a plausible duration, and no silent
voice substitution. This catches the "engine returns garbage / silence / wrong
format" regression class across all three engines without a brittle baseline.

All are gated behind explicit opt-in env flags so a casual run never triggers
a multi-GB model download:
  - GOLDEN_COQUI=1                  → run the Coqui XTTS check (weights lazy-load)
  - GOLDEN_QWEN_VOICE=<voiceId>     → run the Qwen check against an already-
                                      designed voice (a .pt under voices/qwen/)
  - GOLDEN_XTTS_CLONE=<voiceUuid>   → run the XTTS cloned-voice check against an
                                      already-cloned voice (a .pt under
                                      voices/xtts/, fs-38 Wave 3c)
  - GOLDEN_XTTS_DESIGNED=<voiceUuid> → run the XTTS designed-voice check against
                                      an XTTS clone derived from a designed
                                      voice's synthetic Qwen calibration clip
                                      (same voices/xtts/ .pt shape, different
                                      provenance — see D-B, wave3c plan §2.3)

Marked `@pytest.mark.golden` (excluded from the fast `test:sidecar` tier)."""
from __future__ import annotations

import os
import sys
from pathlib import Path

import pytest

SIDECAR_ROOT = Path(__file__).resolve().parents[2]
if str(SIDECAR_ROOT) not in sys.path:
    sys.path.insert(0, str(SIDECAR_ROOT))

import main  # noqa: E402

from tests.golden.compare import measure_pcm, rms  # noqa: E402
from tests.golden.prereq import synthesise_or_skip  # noqa: E402

pytestmark = pytest.mark.golden

SANITY_TEXT = "The quiet harbour town woke slowly to a cold morning."
# 318 chars — comfortably over XTTS's English `char_limits` split threshold of
# 250 (TTS/tts/layers/xtts/tokenizer.py). With `enable_text_splitting=False`
# (the low-level `Xtts.inference()` default, xtts.py:448-462) a text this long
# can trip `assert text_tokens.shape[-1] < gpt_max_text_tokens` and hard-crash
# — exactly the bug `_infer_from_latents` fixed by passing
# `enable_text_splitting=True` explicitly. A short SANITY_TEXT render alone
# would never exercise that path.
LONG_SANITY_TEXT = (
    "The harbourmaster read the manifest twice, checked the tide tables against "
    "the almanac pinned above his desk, counted the crates stacked along the "
    "pier a second time to be certain, and only then signed the release form "
    "that let the freighter slip its lines and head out past the breakwater "
    "into the grey morning swell."
)
MIN_RMS = 0.01
# Generous plausible-duration band (seconds) for one short clause — only a
# truncated (near-zero) or runaway (tens of seconds) render trips it.
MIN_DURATION_SEC = 0.4
MAX_DURATION_SEC = 30.0
# Wider band for LONG_SANITY_TEXT — several clauses, so a longer plausible
# render is expected; still tight enough to catch a truncated or runaway one.
MAX_DURATION_SEC_LONG = 60.0

# #2026 acceptance criterion 4 — Russian coverage for the golden tier. Every
# check in this file (and `test_xtts_clone_sanity` below) was English-only
# before this, which is exactly why fs-38 Wave 3 on-box acceptance found
# defects 1-3 (neuter-adjective mispronunciation, leading-dash pause,
# rare language-collapse) nowhere reachable by CI. The exact acceptance-
# chapter line from the issue: a leading em-dash, the standard Russian
# dialogue-opener convention. 34 chars, comfortably under XTTS's `ru`
# char_limits threshold of 182 (docs/testing/fs38-wave3-onbox-acceptance.md
# E-04). Node's own `normaliseForTts` softens a leading dash to "... " before
# text ever reaches the wire in production (server/src/tts/text-normalize.ts)
# — this check sends the RAW manuscript text straight to the engine instead,
# mirroring how the on-box probes that found the bug were run, so it
# exercises the tokenizer's own dash handling directly. Like every other
# check in this file it is LOOSE and format-only: it proves the render
# doesn't crash / go silent / come back in the wrong format, NOT that the
# leading-dash pause is now audible or that the neuter-adjective/language-
# collapse defects are fixed — those still need a real by-ear listen, tracked
# on the on-box acceptance run sheet.
RUSSIAN_SANITY_TEXT = "— Кто бы это ни был, пусть стучит."


def _assert_sane(res, requested_voice: str, *, max_duration: float = MAX_DURATION_SEC) -> None:
    assert res.sample_rate == 24000, f"sample_rate {res.sample_rate} != 24000"
    # 16-bit mono → even byte length.
    assert len(res.pcm) % 2 == 0, "PCM length not a whole number of int16 samples"
    assert res.substituted_from is None, (
        f"voice '{requested_voice}' was substituted from '{res.substituted_from}' (silent fallback)"
    )
    assert rms(res.pcm) >= MIN_RMS, "near-silent render"
    dur = measure_pcm(res.pcm, res.sample_rate)["duration_sec"]
    assert MIN_DURATION_SEC <= dur <= max_duration, f"implausible duration {dur:.2f}s"


def test_coqui_sanity():
    if os.environ.get("GOLDEN_COQUI") not in ("1", "true", "TRUE"):
        pytest.skip("Set GOLDEN_COQUI=1 to run the Coqui XTTS sanity check (lazy-loads weights).")
    engine = main.CoquiEngine()
    try:
        res = engine.synthesize("xtts_v2", engine.FALLBACK_SPEAKER, SANITY_TEXT)
    except Exception as e:  # pragma: no cover - environment-dependent
        pytest.skip(f"Coqui engine unavailable: {e}")
    _assert_sane(res, engine.FALLBACK_SPEAKER)


def test_coqui_sanity_ru():
    """Russian coverage for the golden tier (#2026 acceptance criterion 4) —
    see `RUSSIAN_SANITY_TEXT`'s module-level comment for why this specific
    line and what this loose, format-only check does and does not prove."""
    if os.environ.get("GOLDEN_COQUI") not in ("1", "true", "TRUE"):
        pytest.skip("Set GOLDEN_COQUI=1 to run the Coqui XTTS sanity check (lazy-loads weights).")
    engine = main.CoquiEngine()
    try:
        res = engine.synthesize(
            "xtts_v2", engine.FALLBACK_SPEAKER, RUSSIAN_SANITY_TEXT, language="ru"
        )
    except Exception as e:  # pragma: no cover - environment-dependent
        pytest.skip(f"Coqui engine unavailable: {e}")
    _assert_sane(res, engine.FALLBACK_SPEAKER)


def test_qwen_sanity():
    voice = os.environ.get("GOLDEN_QWEN_VOICE")
    if not voice:
        pytest.skip(
            "Set GOLDEN_QWEN_VOICE=<voiceId> (an already-designed voice under "
            "voices/qwen/) to run the Qwen sanity check."
        )
    engine = main.QwenEngine()
    try:
        res = engine.synthesize("0.6b", voice, SANITY_TEXT)
    except Exception as e:  # pragma: no cover - environment-dependent
        pytest.skip(f"Qwen engine/voice unavailable: {e}")
    _assert_sane(res, voice)


def test_xtts_clone_sanity():
    """XTTS cloned-voice check (fs-38 Wave 3c) — mirrors `test_qwen_sanity`'s
    shape against an already-cloned voice, plus a long-sentence case that
    specifically exercises the `enable_text_splitting` path (see
    `LONG_SANITY_TEXT`'s docstring).

    GATE 1 IMP-2: both synths used to sit inside
    `except Exception: pytest.skip(...)`, and `AssertionError` is an
    `Exception` — so the upstream
    `assert text_tokens.shape[-1] < gpt_max_text_tokens` crash this check
    exists to catch reported SKIP, which reads as green. The long render now
    calls `engine.synthesize` DIRECTLY: by then the short render has already
    proved the engine is present, so anything the long one raises is a
    regression by definition and must fail. Only the first call is
    skippable, and only when the engine itself is absent from this box
    (`synthesise_or_skip` — a missing `.pt` for the uuid the caller
    explicitly named in GOLDEN_XTTS_CLONE is a setup error it deliberately
    surfaces rather than absorbs)."""
    voice = os.environ.get("GOLDEN_XTTS_CLONE")
    if not voice:
        pytest.skip(
            "Set GOLDEN_XTTS_CLONE=<voiceUuid> (an already-cloned voice under "
            "voices/xtts/) to run the XTTS clone sanity check."
        )
    engine = main.CoquiEngine()
    requested_voice = f"{engine.XTTS_KEY_PREFIX}{voice}"
    res = synthesise_or_skip(engine, "xtts_v2", requested_voice, SANITY_TEXT)
    long_res = engine.synthesize("xtts_v2", requested_voice, LONG_SANITY_TEXT)
    _assert_sane(res, requested_voice)
    _assert_sane(long_res, requested_voice, max_duration=MAX_DURATION_SEC_LONG)


def test_xtts_designed_sanity():
    """XTTS designed-voice check (fs-38 Wave 3c, D-B) — same loose checks as
    `test_xtts_clone_sanity`, against a voice cloned from a DESIGNED voice's
    synthetic Qwen calibration clip rather than a real recorded reference.
    Coqui has no native "designed" concept (CoquiEngine's own docstring), so
    on disk this is the same `voices/xtts/<uuid>.pt` shape as any other
    clone — only its provenance differs, set up ahead of time via the
    Node-side design→clone flow (D-B). §2.3 of the wave3c plan called
    synthetic-clip→latents "quality-unvalidated" as a deferral rationale;
    this check converts that into a delivery gate. NOTE: format-level
    assertions below can only prove the render isn't broken, not that it
    sounds right — the listening test that actually settles quality belongs
    on the on-box acceptance sheet.

    Same GATE 1 IMP-2 narrowing as `test_xtts_clone_sanity` above: a failure
    is only skippable when the engine itself is missing from this box. A
    designed voice whose synthetic-clip-derived `.pt` is stranded raises
    `VoiceNotDesignedError`, which now FAILS this delivery gate — absorbing
    it as "engine/voice unavailable" is exactly how a §2.3 deferral would
    have shipped unnoticed."""
    voice = os.environ.get("GOLDEN_XTTS_DESIGNED")
    if not voice:
        pytest.skip(
            "Set GOLDEN_XTTS_DESIGNED=<voiceUuid> (a voice cloned from a designed "
            "voice's synthetic calibration clip, under voices/xtts/) to run the "
            "XTTS designed-voice sanity check."
        )
    engine = main.CoquiEngine()
    requested_voice = f"{engine.XTTS_KEY_PREFIX}{voice}"
    res = synthesise_or_skip(engine, "xtts_v2", requested_voice, SANITY_TEXT)
    _assert_sane(res, requested_voice)
