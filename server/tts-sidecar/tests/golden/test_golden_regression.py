"""Kokoro golden-audio regression (ops-11) — REAL model, opt-in.

Marked `@pytest.mark.golden` so the normal fast `test:sidecar` tier (run with
`-m "not golden"`) never loads the model. Run it via `npm run test:golden-audio`
(or `:sidecar`) on a box with the Kokoro weights.

What it locks:
  - each fixture line's synthesized sample-count/duration stays within tolerance
    of the committed baseline (catches engine/voice/version/normalization drift),
  - the audio isn't silent (dead-RMS guard),
  - the requested voice is honoured (NO silent fallback / substitution),
  - synthesis is deterministic in LENGTH (a double-run gives a stable count).

Bless: `GOLDEN_BLESS=1` (the `--bless` flag) records kokoro-baseline.json + the
weights SHA / kokoro-onnx version instead of asserting. Commit the result.

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
    compare_to_baseline,
    measure_pcm,
    model_sha256,
    rms,
)

pytestmark = pytest.mark.golden

GOLDEN_DIR = Path(__file__).resolve().parent
FIXTURE_PATH = GOLDEN_DIR / "fixture.json"
BASELINE_PATH = GOLDEN_DIR / "kokoro-baseline.json"

# A clearly-audible floor — Kokoro speech sits well above this; only silence /
# near-silence trips it. Mirrors the dead-RMS idea in segment-qa.ts.
MIN_RMS = 0.01


def _load_json(path: Path) -> dict:
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def _make_kokoro() -> "main.KokoroEngine":
    """Build a real KokoroEngine and force a load, skipping the whole module
    when the package or weights aren't present."""
    engine = main.KokoroEngine()
    if not os.path.isfile(engine._model_path) or not os.path.isfile(engine._voices_path):
        pytest.skip(
            f"Kokoro weights not found at {engine._model_path} / {engine._voices_path} — "
            "run server/tts-sidecar/scripts/install-kokoro.ps1 to bless/run the golden gate."
        )
    try:
        # First synth triggers _ensure_loaded; a missing kokoro-onnx package
        # raises RuntimeError which we turn into a skip.
        engine.synthesize("v1", engine.FALLBACK_VOICE, "Warm up.")
    except RuntimeError as e:  # pragma: no cover - environment-dependent
        pytest.skip(f"Kokoro engine unavailable: {e}")
    return engine


def _kokoro_onnx_version() -> Optional[str]:
    try:
        import importlib.metadata as md

        return md.version("kokoro-onnx")
    except Exception:  # pragma: no cover
        return None


def _bless(engine: "main.KokoroEngine", fixture: dict) -> None:
    entries: dict = {}
    for line in fixture["lines"]:
        res = engine.synthesize(fixture["model"], line["voice"], line["text"])
        m = measure_pcm(res.pcm, res.sample_rate)
        entries[line["id"]] = {
            "voice": line["voice"],
            "sample_rate": m["sample_rate"],
            "sample_count": m["sample_count"],
            "duration_sec": round(m["duration_sec"], 4),
        }
    baseline = _load_json(BASELINE_PATH)
    baseline["metadata"] = {
        "kokoro_onnx_version": _kokoro_onnx_version(),
        "model_sha256": model_sha256(engine._model_path),
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
        _bless(engine, fixture)
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
