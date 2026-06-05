"""Unit coverage for the golden-audio comparison helpers (ops-11).

NO model, NO GPU — runs inside the normal fast `test:sidecar` tier (these
have no `golden` marker, so `run-tests.ps1`'s `-m "not golden"` keeps them in
while excluding the real-model goldens). This is the cheap paired coverage for
the gate LOGIC, so a regression in the tolerance maths is caught everywhere,
not just on a blessed GPU box.
"""
from __future__ import annotations

import struct

from tests.golden.compare import (
    compare_to_baseline,
    measure_pcm,
    rms,
)


def _pcm(*samples: int) -> bytes:
    return struct.pack("<" + "h" * len(samples), *samples)


def test_measure_pcm_counts_int16_mono_samples():
    m = measure_pcm(_pcm(0, 1, 2, 3), sample_rate=24000)
    assert m["sample_count"] == 4
    assert m["sample_rate"] == 24000
    assert abs(m["duration_sec"] - 4 / 24000) < 1e-9


def test_measure_pcm_empty():
    m = measure_pcm(b"", sample_rate=24000)
    assert m["sample_count"] == 0
    assert m["duration_sec"] == 0.0


def test_rms_zero_for_silence():
    assert rms(_pcm(0, 0, 0, 0)) == 0.0


def test_rms_nonzero_for_signal():
    assert rms(_pcm(10000, -10000, 10000, -10000)) > 0.2


def test_compare_passes_within_tolerance():
    baseline = {"sample_rate": 24000, "sample_count": 1000}
    measured = {"sample_rate": 24000, "sample_count": 1015}  # +1.5%, under 2%
    assert compare_to_baseline(measured, baseline, tol=0.02) == []


def test_compare_flags_sample_count_drift():
    baseline = {"sample_rate": 24000, "sample_count": 1000}
    measured = {"sample_rate": 24000, "sample_count": 1100}  # +10%
    reasons = compare_to_baseline(measured, baseline, tol=0.02)
    assert len(reasons) == 1
    assert "sample_count" in reasons[0]


def test_compare_flags_sample_rate_change_exactly():
    baseline = {"sample_rate": 24000, "sample_count": 1000}
    measured = {"sample_rate": 22050, "sample_count": 1000}
    reasons = compare_to_baseline(measured, baseline, tol=0.02)
    assert any("sample_rate" in r for r in reasons)


def test_compare_clean_match_no_reasons():
    baseline = {"sample_rate": 24000, "sample_count": 2048}
    measured = {"sample_rate": 24000, "sample_count": 2048}
    assert compare_to_baseline(measured, baseline) == []
