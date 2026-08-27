"""Qwen golden-audio DURATION regression (#1994) — REAL model, opt-in.

Mirrors `test_golden_regression.py`'s DURATION half only. Today only Kokoro
(the fallback engine) has any golden-audio regression coverage; a Qwen
speech-rate/prosody regression (a shift in line duration under the same
model/voice/text for a designed Qwen voice) is invisible to every automated
gate. #1994 is scoped to a per-line DURATION baseline ONLY — no Whisper
content-drift check (that half of `test_golden_regression.py` is Kokoro-only,
and #1994 does not ask for Qwen content coverage).

Marked `@pytest.mark.golden` so the normal fast `test:sidecar` tier (run with
`-m "not golden"`) never loads the model. Run it via
`npm run test:golden-audio -- --sidecar-only --engine=qwen` on a box with the
Qwen 0.6B-Base weights AND a designed Qwen voice (Qwen voices are per-workspace
bespoke — no fixed catalog like Kokoro's — so `list_voices()` discovers whicher
voices already exist on the box).

The baseline ships UNBLESSED (empty `entries`, placeholder `tolerance`) — the
real N-run stochastic-spread measurement and tolerance derivation are an
on-box acceptance register row, not this file's job. An unblessed baseline
SKIPS (never fails), exactly like `kokoro-baseline.json` before its first
bless.
"""
from __future__ import annotations

import json
import os
import sys
from pathlib import Path

import pytest

SIDECAR_ROOT = Path(__file__).resolve().parents[2]
if str(SIDECAR_ROOT) not in sys.path:
    sys.path.insert(0, str(SIDECAR_ROOT))

import main  # noqa: E402

from tests.golden.compare import (  # noqa: E402
    compare_to_baseline,
    measure_pcm,
    rms,
)
from tests.golden.prereq import (  # noqa: E402
    pick_designed_voice,
    synthesise_or_skip,
)

pytestmark = pytest.mark.golden

GOLDEN_DIR = Path(__file__).resolve().parent
FIXTURE_PATH = GOLDEN_DIR / "qwen-duration-fixture.json"
BASELINE_PATH = GOLDEN_DIR / "qwen-duration-baseline.json"

# A clearly-audible floor — Qwen speech sits well above this; only silence /
# near-silence trips it. Mirrors the dead-RMS idea in Kokoro's golden file.
MIN_RMS = 0.01

# The model string QwenEngine.synthesize takes for the Base model — pinned
# here because `test_cross_engine_sanity.py`'s `test_qwen_sanity` also calls
# it with the literal `"0.6b"` (left untouched by #1994).
QWEN_MODEL = "0.6b"


def _load_json(path: Path) -> dict:
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def _make_qwen() -> "main.QwenEngine":
    """Build a real QwenEngine. No weights-file precheck like Kokoro's —
    `QwenEngine` lazy-loads, so absence of the package/weights surfaces through
    `synthesise_or_skip`'s exception path instead (SKIP only when the engine
    itself is absent from this box; everything else must fail)."""
    return main.QwenEngine()


def test_qwen_golden_lengths_match_baseline():
    fixture = _load_json(FIXTURE_PATH)
    baseline = _load_json(BASELINE_PATH)
    tol = float(baseline.get("tolerance", 0.10))

    engine = _make_qwen()
    voice = _resolve_voice(engine)

    if os.environ.get("GOLDEN_BLESS") in ("1", "true", "TRUE"):
        _bless(engine, voice, fixture)
        pytest.skip("GOLDEN_BLESS set — recorded qwen-duration-baseline.json (not asserting this run).")

    entries = baseline.get("entries") or {}
    if not entries:
        pytest.skip(
            "qwen-duration-baseline.json is unblessed (no entries). Its "
            "tolerance is a placeholder — bless on a real GPU box with a "
            "designed Qwen voice after measuring the per-line duration spread "
            "across N repeated syntheses (see the Group A on-box register row "
            "for the required measurement): `npm run test:golden-audio -- "
            "--sidecar-only --engine=qwen --bless`."
        )

    failures: list[str] = []
    for i, line in enumerate(fixture["lines"]):
        # Use synthesise_or_skip only for the first line (warm-up) — if that
        # fails, the engine is absent and we skip. Any later failure is a
        # real regression. This must run BEFORE the missing-baseline-entry
        # check below: skipping the warm-up because line 0's entry happens
        # to be missing would leave line 1's direct engine.synthesize() call
        # with no SKIP protection, turning an absent engine into an uncaught
        # exception instead of a clean SKIP.
        if i == 0:
            res = synthesise_or_skip(engine, QWEN_MODEL, voice, line["text"])
        else:
            res = engine.synthesize(QWEN_MODEL, voice, line["text"])

        base = entries.get(line["id"])
        if base is None:
            failures.append(f"{line['id']}: no baseline entry (re-bless after editing the fixture).")
            continue

        # No silent fallback — the requested voice must be honoured.
        if res.substituted_from is not None:
            failures.append(
                f"{line['id']}: voice '{voice}' was substituted "
                f"from '{res.substituted_from}' (silent fallback)"
            )

        # Not silent.
        line_rms = rms(res.pcm)
        if line_rms < MIN_RMS:
            failures.append(f"{line['id']}: near-silent (RMS {line_rms:.4f} < {MIN_RMS})")

        # Length within tolerance of the baseline.
        measured = measure_pcm(res.pcm, res.sample_rate)
        for reason in compare_to_baseline(measured, base, tol=tol):
            failures.append(f"{line['id']}: {reason}")

    assert not failures, "Golden-audio mismatches:\n  " + "\n  ".join(failures)


def _bless(engine: "main.QwenEngine", voice: str, fixture: dict) -> None:
    """Record each fixture line's fresh duration into qwen-duration-baseline.json.

    No `bless_guard` here — that guard is specific to the transcript-content
    check Kokoro's `_bless` also does, which this file does not have. Qwen
    decoding is stochastic with no seed, so a repeated-synthesis spread exists;
    the on-box register row is where N and the observed spread get recorded so
    `tolerance` can be derived from measurement rather than blessed as a guess.

    The placeholder `tolerance` in the committed baseline (0.10) is a safe interim
    — measured real-world spread is 6.7% — widened to stay comfortably above that
    with headroom for run-to-run variance until the on-box measurement (#1994)
    is complete. Real tolerance derivation from an actual N-repeat on-box measurement
    remains register row A38's owed acceptance work.
    """
    baseline = _load_json(BASELINE_PATH)
    entries: dict = {}

    # Use synthesise_or_skip only for the first line (warm-up) — if that fails,
    # the engine is absent and we skip. Any later failure is a real regression.
    for i, line in enumerate(fixture["lines"]):
        if i == 0:
            res = synthesise_or_skip(engine, QWEN_MODEL, voice, line["text"])
        else:
            res = engine.synthesize(QWEN_MODEL, voice, line["text"])

        m = measure_pcm(res.pcm, res.sample_rate)
        entries[line["id"]] = {
            "voice": voice,
            "sample_rate": m["sample_rate"],
            "sample_count": m["sample_count"],
            "duration_sec": round(m["duration_sec"], 4),
        }

    # Record entries only — preserve whatever tolerance is already in baseline
    # (whether the committed placeholder 0.10 or a hand-set measured value from
    # on-box acceptance work). Real tolerance derivation remains register row A38.
    baseline["entries"] = entries
    with open(BASELINE_PATH, "w", encoding="utf-8") as f:
        json.dump(baseline, f, indent=2)
        f.write("\n")


# #2696: there used to be a `test_qwen_is_deterministic_in_length` here,
# asserting that two back-to-back `QwenEngine.synthesize()` calls on the same
# model/voice/text produce the SAME sample_count. That contradicts this
# file's own documented understanding (see `_bless`'s docstring and
# `qwen-duration-fixture.json`'s `_comment`): Qwen decoding is stochastic
# with no seed. Reproduced twice on a box with a designed Qwen voice: two
# consecutive synths of the same line gave sample_count 86400 vs 92160 (a
# ~6.7% spread). At the time this was reproduced, the placeholder `tolerance`
# was 0.05, so loosening the assertion to that tolerance would still have
# failed, not just vacuously passed. The placeholder was later widened to
# 0.10 (comfortable headroom above the observed 6.7%) specifically so a bless
# doesn't immediately fail its own next run -- see `_bless`'s docstring. That
# widening is a safe INTERIM value, not a measurement: it does not make the
# dropped exact-equality check any more honest to reintroduce. There is no
# blessed baseline yet to derive a real bound from (`qwen-duration-baseline.json`
# ships with empty `entries` -- see its own `_comment`), so a bounded
# same-line check has no measured spread to bound against. The right per-line
# length regression coverage is `test_qwen_golden_lengths_match_baseline`
# above once that on-box acceptance bless (Group A register row) records a
# real N-run spread and tolerance; this file no longer asserts determinism it
# cannot honestly demonstrate. Do not reintroduce an exact-equality
# determinism check on Qwen output.


def _resolve_voice(engine: "main.QwenEngine") -> str:
    """Select the designed voice this golden run drives against, skipping
    when this box has none (#1994): an explicit GOLDEN_QWEN_VOICE always
    wins; otherwise discover whichever designed voice(s) already exist via
    `list_voices()` (Qwen voices are bespoke and per-workspace, so no id is
    hardcoded, and `pick_designed_voice` is pure/import-light)."""
    voice = pick_designed_voice(engine.list_voices(), os.environ.get("GOLDEN_QWEN_VOICE"))
    if voice is None:
        pytest.skip(
            "no designed Qwen voice on this box (voices/qwen/ has no designed "
            "voices) and no GOLDEN_QWEN_VOICE opt-in set — Qwen voices are "
            "per-workspace bespoke, so a golden run needs one to already exist."
        )
    return voice