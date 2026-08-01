"""Kokoro golden-audio regression (ops-11) — REAL model, opt-in. Content-drift
check extended by ops-45 / #1911.

Marked `@pytest.mark.golden` so the normal fast `test:sidecar` tier (run with
`-m "not golden"`) never loads the model. Run it via `npm run test:golden-audio`
(or `:sidecar`) on a box with the Kokoro weights.

What it locks:
  - each fixture line's synthesized sample-count/duration stays within tolerance
    of the committed baseline (catches engine/voice/version/normalization drift),
  - the audio isn't silent (dead-RMS guard),
  - the requested voice is honoured (NO silent fallback / substitution),
  - synthesis is deterministic in LENGTH (a double-run gives a stable count),
  - each line's fresh Whisper transcript matches its recorded baseline
    transcript at tolerance 0 (ops-45 / #1911 — catches the RIGHT WORDS half
    that duration/RMS/substitution can't see: a wrong voice reading correct
    text, a dropped/repeated word, a hallucinated phrase).

Bless: `GOLDEN_BLESS=1` (the `--bless` flag) records kokoro-baseline.json + the
weights SHA / kokoro-onnx version, PLUS (since #1911) each line's transcript +
text_edits, instead of asserting. Commit the result. A bless that would
silently overwrite a differing transcript, or blow the per-line text_edits
cap, is REFUSED — see `compare.bless_guard` and `GOLDEN_REBLESS_CONTENT`.

The model load happens inside the test body (never at import) so the normal
suite can collect this file safely; if the weights / package are absent the test
SKIPs (belt-and-suspenders for a direct `pytest -m golden`)."""
from __future__ import annotations

import json
import os
import sys
from pathlib import Path
from typing import Optional

import pytest

SIDECAR_ROOT = Path(__file__).resolve().parents[2]
if str(SIDECAR_ROOT) not in sys.path:
    sys.path.insert(0, str(SIDECAR_ROOT))

import main  # noqa: E402

from tests.golden.compare import (  # noqa: E402
    assert_content,
    bless_guard,
    compare_to_baseline,
    content_edits,
    measure_pcm,
    model_sha256,
    rms,
)
from tests.golden.prereq import synthesise_or_skip  # noqa: E402

pytestmark = pytest.mark.golden

GOLDEN_DIR = Path(__file__).resolve().parent
FIXTURE_PATH = GOLDEN_DIR / "fixture.json"
BASELINE_PATH = GOLDEN_DIR / "kokoro-baseline.json"

# A clearly-audible floor — Kokoro speech sits well above this; only silence /
# near-silence trips it. Mirrors the dead-RMS idea in segment-qa.ts.
MIN_RMS = 0.01

# The exact model/device/language the recorded `transcript` baseline was
# measured under (#1911 s2e). A transcript baseline recorded under `base` is
# meaningless under `tiny`; recorded on CPU is meaningless auto-detected on a
# different language. Re-bless (with GOLDEN_REBLESS_CONTENT=1 if content
# moves) after a deliberate change to any of these.
ASR_MODEL_NAME = "base"
ASR_DEVICE_NAME = "cpu"
ASR_LANGUAGE = "en"
# #2004: the content-drift check runs at TOLERANCE 0, so a third unpinned
# input matters just as much as model/device -- `main.WhisperEngine.
# _compute_type()` also reads `ASR_COMPUTE_TYPE` (int8 vs int8_float16 vs
# float32 changes greedy-decode output), but pre-#2004 `_make_whisper()`
# left it ambient. This is the CPU default `_compute_type()` resolves to
# when ASR_COMPUTE_TYPE is unset and the device family is "cpu" (matching
# ASR_DEVICE_NAME above) -- pinned outright so a stray ambient value in an
# operator's shell fails loudly with a named reason instead of silently
# becoming content drift.
ASR_COMPUTE_TYPE_NAME = "int8"


def _load_json(path: Path) -> dict:
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def _make_kokoro() -> "main.KokoroEngine":
    """Build a real KokoroEngine and force a load, skipping the whole module
    when the package or weights aren't present.

    #1987: the warm-up synth used to wrap ANY `RuntimeError` in a blanket
    `pytest.skip(...)`, so a CUDA error, a bad voice substitution, or model
    corruption during warm-up all reported a green SKIP instead of a
    failure. `synthesise_or_skip` (the same classifier #1911 built for the
    identical Coqui swallow) narrows the skip to "the kokoro-onnx package
    itself is absent from this box" and lets everything else propagate."""
    engine = main.KokoroEngine()
    if not os.path.isfile(engine._model_path) or not os.path.isfile(engine._voices_path):
        pytest.skip(
            f"Kokoro weights not found at {engine._model_path} / {engine._voices_path} — "
            "run server/tts-sidecar/scripts/install-kokoro.ps1 to bless/run the golden gate."
        )
    # First synth triggers _ensure_loaded.
    synthesise_or_skip(engine, "v1", engine.FALLBACK_VOICE, "Warm up.")
    return engine


def _make_whisper() -> "main.WhisperEngine":
    """Build a real WhisperEngine pinned to the exact model/device/compute-type
    the recorded `transcript` baseline was measured under (#1911 s2e, compute
    type added by #2004).

    Set OUTRIGHT (`os.environ[...] =`), not `setdefault` — a stray ambient
    ASR_MODEL/ASR_DEVICE/ASR_COMPUTE_TYPE in the caller's shell must not
    silently apply to this box's golden run; the recorded baseline is
    meaningless under a different model, device family, or compute type, so
    this asserts rather than skips.

    The `_compute_type` check is skipped (not asserted-false) when `engine`
    doesn't expose it at all — `test_golden_sanity_gating.py` calls this
    function against a `_StubWhisperEngine` stand-in (real `_model_name` /
    `_device` attributes, deliberately no `_compute_type`) to drive the
    content-drift gate's OWN logic without a real model; that stub's
    contract predates #2004 and doesn't claim to cover the compute-type
    pin, so `hasattr` keeps this function usable by both without changing
    the stub. A REAL `main.WhisperEngine` always has `_compute_type`, so
    the golden run itself is unaffected."""
    os.environ["ASR_MODEL"] = ASR_MODEL_NAME
    os.environ["ASR_DEVICE"] = ASR_DEVICE_NAME
    os.environ["ASR_COMPUTE_TYPE"] = ASR_COMPUTE_TYPE_NAME
    engine = main.WhisperEngine()
    assert engine._model_name == ASR_MODEL_NAME, (
        f"ASR_MODEL resolved to {engine._model_name!r}, expected {ASR_MODEL_NAME!r} — "
        "the recorded transcript baseline does not apply to a different model."
    )
    family, _ = main._parse_device(engine._device)
    assert family == ASR_DEVICE_NAME, (
        f"ASR_DEVICE resolved to device family {family!r}, expected {ASR_DEVICE_NAME!r} — "
        "the recorded transcript baseline does not apply to a different device."
    )
    if hasattr(engine, "_compute_type"):
        compute_type = engine._compute_type()
        assert compute_type == ASR_COMPUTE_TYPE_NAME, (
            f"ASR_COMPUTE_TYPE resolved to {compute_type!r}, expected {ASR_COMPUTE_TYPE_NAME!r} — "
            "the recorded transcript baseline does not apply to a different compute type "
            "(int8 vs int8_float16 vs float32 changes greedy-decode output)."
        )
    return engine


def _kokoro_onnx_version() -> Optional[str]:
    try:
        import importlib.metadata as md

        return md.version("kokoro-onnx")
    except Exception:  # pragma: no cover
        return None


def _faster_whisper_version() -> Optional[str]:
    """#2004: `kokoro-baseline.json`'s `metadata` already stamps
    `kokoro_onnx_version` + `model_sha256` "so a model bump is legible" (the
    file's own `_comment`). The content-drift baseline had no equivalent —
    `pip install -U faster-whisper` (or an upstream `ctranslate2` bump) shifts
    every transcript with zero diagnostic on a tolerance-0 gate. Mirrors
    `_kokoro_onnx_version` above."""
    try:
        import importlib.metadata as md

        return md.version("faster-whisper")
    except Exception:  # pragma: no cover
        return None


def _ctranslate2_version() -> Optional[str]:
    try:
        import importlib.metadata as md

        return md.version("ctranslate2")
    except Exception:  # pragma: no cover
        return None


def _bless(engine: "main.KokoroEngine", whisper: "main.WhisperEngine", fixture: dict) -> None:
    """Record durations AND (since ops-45 / #1911) each line's transcript +
    text_edits. Guarded by `bless_guard` (G1/G2 + the first-bless ceiling) —
    a refusal on ANY line aborts the WHOLE bless with no file write, so a
    partially-accepted bless can never silently drop other lines' history."""
    baseline = _load_json(BASELINE_PATH)
    existing_entries: dict = baseline.get("entries") or {}
    allow_rebless_content = os.environ.get("GOLDEN_REBLESS_CONTENT") in ("1", "true", "TRUE")

    entries: dict = {}
    refusals: list[str] = []
    for line in fixture["lines"]:
        res = engine.synthesize(fixture["model"], line["voice"], line["text"])
        m = measure_pcm(res.pcm, res.sample_rate)
        transcribed = whisper.transcribe(res.pcm, res.sample_rate, language=ASR_LANGUAGE)
        fresh_transcript = transcribed["text"]

        existing = existing_entries.get(line["id"])
        guard_reason = bless_guard(
            line["text"], existing, fresh_transcript, allow_rebless_content=allow_rebless_content
        )
        if guard_reason is not None:
            refusals.append(f"{line['id']}: {guard_reason}")
            continue

        edits, _wer = content_edits(line["text"], fresh_transcript)
        entries[line["id"]] = {
            "voice": line["voice"],
            "sample_rate": m["sample_rate"],
            "sample_count": m["sample_count"],
            "duration_sec": round(m["duration_sec"], 4),
            "transcript": fresh_transcript,
            "text_edits": edits,
        }

    if refusals:
        raise AssertionError(
            "Bless refused for one or more lines (ops-45 G1/G2 — see #1911 s2c):\n  "
            + "\n  ".join(refusals)
        )

    baseline["metadata"] = {
        "kokoro_onnx_version": _kokoro_onnx_version(),
        "model_sha256": model_sha256(engine._model_path),
        # #2004: stamp the ASR stack too, mirroring the synth-side fields
        # above — a bump here is what actually moves a transcript, so it
        # needs to be just as legible as a Kokoro weights/version bump.
        "faster_whisper_version": _faster_whisper_version(),
        "ctranslate2_version": _ctranslate2_version(),
        # blessed_at intentionally left for the committer to stamp — the
        # harness has no clock and must stay reproducible.
        "blessed_at": baseline.get("metadata", {}).get("blessed_at"),
    }
    baseline["entries"] = entries
    with open(BASELINE_PATH, "w", encoding="utf-8") as f:
        json.dump(baseline, f, indent=2)
        f.write("\n")


def test_kokoro_golden_lengths_match_baseline():
    fixture = _load_json(FIXTURE_PATH)
    baseline = _load_json(BASELINE_PATH)
    tol = float(baseline.get("tolerance", 0.05))

    engine = _make_kokoro()

    if os.environ.get("GOLDEN_BLESS") in ("1", "true", "TRUE"):
        whisper = _make_whisper()
        _bless(engine, whisper, fixture)
        pytest.skip("GOLDEN_BLESS set — recorded kokoro-baseline.json (not asserting this run).")

    entries = baseline.get("entries") or {}
    if not entries:
        pytest.skip(
            "kokoro-baseline.json is unblessed (no entries). "
            "Bless on a real-GPU box: npm run test:golden-audio -- --bless"
        )

    failures: list[str] = []
    for line in fixture["lines"]:
        base = entries.get(line["id"])
        if base is None:
            failures.append(f"{line['id']}: no baseline entry (re-bless after editing fixture.json)")
            continue
        res = engine.synthesize(fixture["model"], line["voice"], line["text"])

        # No silent fallback — the requested voice must be honoured.
        if res.substituted_from is not None:
            failures.append(
                f"{line['id']}: voice '{line['voice']}' was substituted "
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


def test_kokoro_is_deterministic_in_length():
    """Two synths of the same line must give the same sample count. Guards
    against an accidental introduction of nondeterminism (e.g. a random seed
    or a sampling temperature) into the Kokoro path."""
    fixture = _load_json(FIXTURE_PATH)
    engine = _make_kokoro()
    line = fixture["lines"][0]
    a = engine.synthesize(fixture["model"], line["voice"], line["text"])
    b = engine.synthesize(fixture["model"], line["voice"], line["text"])
    assert measure_pcm(a.pcm, a.sample_rate)["sample_count"] == (
        measure_pcm(b.pcm, b.sample_rate)["sample_count"]
    )


def test_kokoro_golden_content_matches_baseline():
    """Per-line content-drift check (ops-45 / #1911): each line's fresh
    Whisper transcript must match its recorded baseline `transcript` at
    TOLERANCE 0. Separate from `test_kokoro_golden_lengths_match_baseline`
    so duration and content fail independently, and so the fast tier
    (`test_golden_sanity_gating.py`) can drive the content path alone.

    Check order is load-bearing (#1911 s2f) — GOLDEN_ASR=0 first, before
    anything else (a stub-driven fast-tier case for it must not pass
    vacuously via `_make_kokoro`'s own skip paths); GOLDEN_BLESS second, since
    content is (re)recorded by the lengths test's `_bless()` call, not here.

    ANY ASR failure is a FAILURE, never a SKIP (#1911 s5) — the ASR path
    itself (WhisperEngine construction + transcribe) must NOT call
    `prereq.engine_absent_reason` / `prereq.synthesise_or_skip`, which would
    turn a missing `faster_whisper` into a green SKIP, and has no accepted
    skip of its own beyond the two env checks below.

    That is NOT a claim about the function as a whole: `_make_kokoro()`
    (called below) carries its own two pre-existing skip paths — missing
    Kokoro weights, and a blanket `except RuntimeError` on warm-up that
    over-swallows (tracked separately as #1987, not fixed by ops-45). Those
    are Kokoro-side and orthogonal to this test's ASR-content contract; the
    property this docstring pins is narrower and about the ASR path only."""
    if os.environ.get("GOLDEN_ASR") == "0":
        pytest.skip("GOLDEN_ASR=0 — content-drift check disabled for this run.")

    if os.environ.get("GOLDEN_BLESS") in ("1", "true", "TRUE"):
        # Content is (re)recorded inside test_kokoro_golden_lengths_match_baseline's
        # _bless() call, not here — running this test on a first bless (no
        # transcript recorded yet) would fail for the wrong reason, and would
        # make the on-box bless task non-deterministic (which test ran first).
        pytest.skip(
            "GOLDEN_BLESS set — content is (re)recorded by the lengths test's bless step."
        )

    fixture = _load_json(FIXTURE_PATH)
    baseline = _load_json(BASELINE_PATH)
    entries = baseline.get("entries") or {}

    engine = _make_kokoro()
    whisper = _make_whisper()

    failures: list[str] = []
    for line in fixture["lines"]:
        base = entries.get(line["id"])
        if base is None or "transcript" not in base:
            failures.append(f"{line['id']}: no recorded transcript — re-bless required")
            continue

        res = engine.synthesize(fixture["model"], line["voice"], line["text"])

        try:
            transcribed = whisper.transcribe(res.pcm, res.sample_rate, language=ASR_LANGUAGE)
        except Exception as exc:  # noqa: BLE001 — deliberately broad, see #1911 s5
            pytest.fail(f"{line['id']}: ASR transcription failed: {exc!r}")

        reason = assert_content(base["transcript"], transcribed["text"])
        if reason is not None:
            failures.append(f"{line['id']}: {reason}")

    assert not failures, "Golden-audio content drift:\n  " + "\n  ".join(failures)
