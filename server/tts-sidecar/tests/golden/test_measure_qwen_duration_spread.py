"""Paired tests for `measure_qwen_duration_spread.py`'s pure statistics
helpers (#1994 review finding: the script shipped with zero test coverage).

`_line_stats` and `_suggest_tolerance` are pure, GPU-free — no pytest marker,
runs in the normal fast `test:sidecar` tier. The GPU-calling orchestration
(`measure`, `main_measure`) is deliberately untested here, matching this
repo's convention of unit-testing only the pure logic split out of a
hardware-calling script (see `prereq.py`/`compare.py`'s own docstrings for
the same reasoning)."""
from __future__ import annotations

import sys
from pathlib import Path

SIDECAR_ROOT = Path(__file__).resolve().parents[2]
if str(SIDECAR_ROOT) not in sys.path:
    sys.path.insert(0, str(SIDECAR_ROOT))

from tests.golden.measure_qwen_duration_spread import (  # noqa: E402
    _line_stats,
    _suggest_tolerance,
)


def test_line_stats_uniform_durations_zero_deviation() -> None:
    """Identical draws have zero spread — a sanity floor before checking the
    non-trivial cases below."""
    stats = _line_stats([2.0, 2.0, 2.0])
    assert stats["mean_sec"] == 2.0
    assert stats["stdev_sec"] == 0.0
    assert stats["max_abs_dev_sec"] == 0.0
    assert stats["max_frac_dev"] == 0.0


def test_line_stats_computes_mean_and_max_frac_dev() -> None:
    """Known values: mean=3.0, deviations=[1.0, 0.0, 1.0], so
    max_abs_dev=1.0 and max_frac_dev=1/3. Kills a mutant that divides by
    something other than the mean (e.g. by the max or min draw instead), or
    that takes the min deviation instead of the max."""
    stats = _line_stats([2.0, 3.0, 4.0])
    assert stats["mean_sec"] == 3.0
    assert stats["max_abs_dev_sec"] == 1.0
    assert abs(stats["max_frac_dev"] - (1.0 / 3.0)) < 1e-4
    # population stdev of [2,3,4] around mean 3: sqrt(((1)^2+0+1^2)/3)
    assert abs(stats["stdev_sec"] - (2.0 / 3.0) ** 0.5) < 1e-4


def test_line_stats_single_outlier_drives_max_frac_dev() -> None:
    """A single far outlier, not the population stdev, should drive
    max_frac_dev — proves the statistic is a MAX over per-draw deviations,
    not an average-based one (which a mutant swapping max() for a mean-based
    formula would still pass the previous two tests but fail this one)."""
    stats = _line_stats([1.0, 1.0, 1.0, 1.0, 2.0])  # mean=1.2, outlier dev=0.8
    assert abs(stats["mean_sec"] - 1.2) < 1e-4
    assert abs(stats["max_abs_dev_sec"] - 0.8) < 1e-4
    assert abs(stats["max_frac_dev"] - (0.8 / 1.2)) < 1e-4


def test_line_stats_low_outlier_still_drives_max_abs_dev() -> None:
    """A single outlier BELOW the mean, not above, must still drive
    max_abs_dev/max_frac_dev — kills a mutant that drops `abs()` from the
    per-draw deviation (`max(d - mean for d in durations)` instead of
    `max(abs(d - mean) for d in durations)`), which would only ever see
    positive/above-mean deviations — blind to a draw SHORTER than expected,
    the direction that actually matters for catching a real speech-rate
    regression (#1994 review-round-2 finding M5: the previous three tests
    all had their largest deviation on the high side, so this mutant
    survived them all)."""
    stats = _line_stats([0.5, 1.0, 1.0, 1.0, 1.0])  # mean=0.9, low outlier dev=-0.4
    assert abs(stats["mean_sec"] - 0.9) < 1e-4
    assert abs(stats["max_abs_dev_sec"] - 0.4) < 1e-4
    assert abs(stats["max_frac_dev"] - (0.4 / 0.9)) < 1e-4


def test_line_stats_zero_mean_returns_zero_frac_dev() -> None:
    """A degenerate zero-mean input must not raise a ZeroDivisionError —
    kills a mutant that drops the `mean > 0` guard."""
    stats = _line_stats([0.0, 0.0])
    assert stats["mean_sec"] == 0.0
    assert stats["max_frac_dev"] == 0.0


def test_suggest_tolerance_headroom_multipliers() -> None:
    """Kills a mutant that swaps the 1.3/1.5 headroom multipliers, or swaps
    the return order."""
    low, high = _suggest_tolerance(0.20)
    assert abs(low - 0.26) < 1e-9
    assert abs(high - 0.30) < 1e-9
    assert low < high
