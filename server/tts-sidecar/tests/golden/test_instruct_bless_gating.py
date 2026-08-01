"""`_bless()` caller-side wiring for instruct-baseline.json's tolerances,
identity, and loudness_dbfs guards (#1995, widened by #2035).

`test_instruct_golden.py` is `@pytest.mark.golden` (it needs the real Qwen
1.7B weights + CUDA for `test_live_instruct_golden`), but `_bless()` itself
is pure file I/O plus `compare.bless_guard_thresholds` -- no model, no GPU.
This drives it DIRECTLY as a plain function call (no pytest marker), the
same technique `test_golden_sanity_gating.py` uses to pin
`test_golden_regression.py`'s bless/content gates in the normal fast
`test:sidecar` tier: importing a `golden`-marked module and calling one of
its functions is an ordinary Python call, not a pytest collection, so the
module-level `pytestmark` never attaches to these test items.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

SIDECAR_ROOT = Path(__file__).resolve().parents[2]
if str(SIDECAR_ROOT) not in sys.path:
    sys.path.insert(0, str(SIDECAR_ROOT))

from tests.golden import test_instruct_golden as instruct  # noqa: E402

BASE_TOLERANCES = {"identity_cosine_max": 0.15, "loudness_dbfs_abs": 4.0, "rtf_max": 1.0}


def _write_baseline(
    tmp_path: Path,
    *,
    blessed: bool,
    tolerances: dict | None,
    identity: dict | None = None,
    loudness_dbfs: dict | None = None,
) -> Path:
    """`blessed` controls whether the fixture carries the `identity` /
    `loudness_dbfs` / `rtf` measurement blocks -- `_bless()` reads
    `baseline.get("identity")` as its "has this baseline ever been blessed"
    signal (the same one `test_live_instruct_golden`'s unblessed-SKIP
    uses), so `blessed=False` is what a GENUINE never-before-blessed
    baseline looks like, and `blessed=True, tolerances=None` is the
    #2003-shaped hole: previously blessed, but its `tolerances` key was
    lost (e.g. a hand-resolved merge conflict). Conflating the two was the
    bug this file's tests originally pinned as intended behaviour.

    `identity`/`loudness_dbfs` default to exactly what `_measured()` below
    computes, so a test that only varies `rtf` (the pre-#2035 tests) still
    exercises a baseline that is self-consistent on the OTHER two guarded
    fields and doesn't spuriously need the flag for them. A test targeting
    the identity/loudness_dbfs guard passes an explicitly DIFFERENT dict."""
    path = tmp_path / "instruct-baseline.json"
    data: dict = {
        "description": "test fixture",
        "voice": "qwen-test",
        "model": "1.7b",
    }
    if blessed:
        data["identity"] = identity if identity is not None else {
            "anchor": "neutral",
            "cosine": {"whisper": 0.01, "sad": 0.005, "excited": 0.005, "angry": 0.007},
            "max": 0.01,
        }
        data["loudness_dbfs"] = loudness_dbfs if loudness_dbfs is not None else {
            "whisper": -30.0,
            "neutral": -20.0,
        }
        data["rtf"] = {"batched": 0.5}
    if tolerances is not None:
        data["tolerances"] = tolerances
    path.write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")
    return path


def _measured(rtf: float) -> dict:
    return {
        "identity": {"whisper": 0.01, "sad": 0.005, "excited": 0.005, "angry": 0.007},
        "loudness_dbfs": {"whisper": -30.0, "neutral": -20.0},
        "rtf": rtf,
    }


def test_bless_writes_tolerances_on_a_never_before_blessed_baseline(monkeypatch, tmp_path) -> None:
    """First bless -- GENUINELY never blessed (no `identity`/`loudness_dbfs`/
    `rtf` recorded yet, so no committed tolerances to protect), so no flag
    is needed even though `rtf_max` (1.31) differs from nothing."""
    path = _write_baseline(tmp_path, blessed=False, tolerances=None)
    monkeypatch.setattr(instruct, "BASELINE_PATH", path)
    monkeypatch.delenv("GOLDEN_REBLESS_THRESHOLDS", raising=False)

    # rtf 0.873 * 1.5 = 1.3095 -> round(., 2) = 1.31, matching the #1995
    # issue's observed regression (1.0 -> 1.31) exactly.
    instruct._bless(_measured(rtf=0.873))

    written = json.loads(path.read_text(encoding="utf-8"))
    assert written["tolerances"]["rtf_max"] == 1.31


def test_bless_refuses_when_a_previously_blessed_baseline_is_missing_tolerances(
    monkeypatch, tmp_path
) -> None:
    """The #2003-shaped hole inside the #1995 fix (independent review of
    #2032, F1): a baseline that HAS been blessed before (carries
    `identity`/`loudness_dbfs`/`rtf`) but lost its `tolerances` key (e.g. a
    hand-resolved merge conflict) must fail CLOSED like any other threshold
    change -- not silently route through the no-op first-bless branch just
    because `tolerances` happens to be absent."""
    path = _write_baseline(tmp_path, blessed=True, tolerances=None)
    monkeypatch.setattr(instruct, "BASELINE_PATH", path)
    monkeypatch.delenv("GOLDEN_REBLESS_THRESHOLDS", raising=False)
    before = path.read_bytes()

    with pytest.raises(AssertionError, match="GOLDEN_REBLESS_THRESHOLDS"):
        instruct._bless(_measured(rtf=0.873))

    assert path.read_bytes() == before, "a refused bless must leave the baseline file untouched"


def test_bless_allows_a_previously_blessed_missing_tolerances_with_the_flag(
    monkeypatch, tmp_path
) -> None:
    path = _write_baseline(tmp_path, blessed=True, tolerances=None)
    monkeypatch.setattr(instruct, "BASELINE_PATH", path)
    monkeypatch.setenv("GOLDEN_REBLESS_THRESHOLDS", "1")

    instruct._bless(_measured(rtf=0.873))

    written = json.loads(path.read_text(encoding="utf-8"))
    assert written["tolerances"]["rtf_max"] == 1.31


def test_bless_refuses_and_leaves_the_file_untouched_when_rtf_max_would_move(
    monkeypatch, tmp_path
) -> None:
    """#1995 repro: a bless run performed under contention (or for an
    unrelated reason) must not silently move rtf_max 1.0 -> 1.31 -- the
    whole bless is refused, mirroring the Kokoro G1/G2 all-or-nothing
    shape (no partial write on a refusal)."""
    path = _write_baseline(tmp_path, blessed=True, tolerances=dict(BASE_TOLERANCES))
    monkeypatch.setattr(instruct, "BASELINE_PATH", path)
    monkeypatch.delenv("GOLDEN_REBLESS_THRESHOLDS", raising=False)
    before = path.read_bytes()

    with pytest.raises(AssertionError, match="GOLDEN_REBLESS_THRESHOLDS"):
        instruct._bless(_measured(rtf=0.873))

    assert path.read_bytes() == before, "a refused bless must leave the baseline file untouched"


def test_bless_allows_the_move_with_the_flag(monkeypatch, tmp_path) -> None:
    path = _write_baseline(tmp_path, blessed=True, tolerances=dict(BASE_TOLERANCES))
    monkeypatch.setattr(instruct, "BASELINE_PATH", path)
    monkeypatch.setenv("GOLDEN_REBLESS_THRESHOLDS", "1")

    instruct._bless(_measured(rtf=0.873))

    written = json.loads(path.read_text(encoding="utf-8"))
    assert written["tolerances"]["rtf_max"] == 1.31


def test_bless_needs_no_flag_when_measurements_keep_tolerances_pinned(monkeypatch, tmp_path) -> None:
    """A routine, uncontended bless (rtf comfortably under the floor) must
    not need the flag at all -- the `max(1.0, ...)` floor keeps rtf_max
    pinned at 1.0, so nothing actually changed."""
    path = _write_baseline(tmp_path, blessed=True, tolerances=dict(BASE_TOLERANCES))
    monkeypatch.setattr(instruct, "BASELINE_PATH", path)
    monkeypatch.delenv("GOLDEN_REBLESS_THRESHOLDS", raising=False)

    instruct._bless(_measured(rtf=0.5))  # 0.5 * 1.5 = 0.75 < floor 1.0 -> rtf_max stays 1.0

    written = json.loads(path.read_text(encoding="utf-8"))
    assert written["tolerances"]["rtf_max"] == 1.0


# ── #2035: identity / loudness_dbfs are assertion references too, same guard ──


def test_bless_refuses_and_leaves_the_file_untouched_when_identity_would_move(
    monkeypatch, tmp_path
) -> None:
    """`test_live_instruct_golden`'s tolerance ceiling is DERIVED from the
    recorded identity cosines at bless time (`id_max + 0.10`), but the raw
    `identity` block itself was, pre-#2035, never guarded -- a bless run for
    an unrelated reason (e.g. a Kokoro-only re-bless that still touches this
    file) could silently re-record it. A committed identity cosine
    (`whisper: 0.01`) that differs from what this run measured
    (`whisper: 0.01` in `_measured`, but the FIXTURE below is deliberately
    different: `0.02`) must refuse, same all-or-nothing shape as the
    `tolerances` guard -- including that a refusal on `identity` must leave
    `tolerances`/`loudness_dbfs`/rtf entirely unwritten too."""
    differing_identity = {
        "anchor": "neutral",
        "cosine": {"whisper": 0.02, "sad": 0.005, "excited": 0.005, "angry": 0.007},
        "max": 0.02,
    }
    path = _write_baseline(
        tmp_path, blessed=True, tolerances=dict(BASE_TOLERANCES), identity=differing_identity
    )
    monkeypatch.setattr(instruct, "BASELINE_PATH", path)
    monkeypatch.delenv("GOLDEN_REBLESS_THRESHOLDS", raising=False)
    before = path.read_bytes()

    with pytest.raises(AssertionError, match="GOLDEN_REBLESS_THRESHOLDS"):
        instruct._bless(_measured(rtf=0.5))  # rtf pinned -- only identity differs

    assert path.read_bytes() == before, "a refused bless must leave the baseline file untouched"


def test_bless_allows_identity_move_with_the_flag(monkeypatch, tmp_path) -> None:
    differing_identity = {
        "anchor": "neutral",
        "cosine": {"whisper": 0.02, "sad": 0.005, "excited": 0.005, "angry": 0.007},
        "max": 0.02,
    }
    path = _write_baseline(
        tmp_path, blessed=True, tolerances=dict(BASE_TOLERANCES), identity=differing_identity
    )
    monkeypatch.setattr(instruct, "BASELINE_PATH", path)
    monkeypatch.setenv("GOLDEN_REBLESS_THRESHOLDS", "1")

    instruct._bless(_measured(rtf=0.5))

    written = json.loads(path.read_text(encoding="utf-8"))
    assert written["identity"]["cosine"]["whisper"] == 0.01


def test_bless_refuses_and_leaves_the_file_untouched_when_loudness_dbfs_would_move(
    monkeypatch, tmp_path
) -> None:
    """`baseline["loudness_dbfs"][e]` is the CENTRE of the ±`loudness_dbfs_abs`
    drift window `test_live_instruct_golden` measures a fresh run against --
    an assertion reference, not free data. A committed loudness figure that
    differs from this run's measurement must refuse."""
    differing_loudness = {"whisper": -29.0, "neutral": -20.0}  # measured has whisper: -30.0
    path = _write_baseline(
        tmp_path, blessed=True, tolerances=dict(BASE_TOLERANCES), loudness_dbfs=differing_loudness
    )
    monkeypatch.setattr(instruct, "BASELINE_PATH", path)
    monkeypatch.delenv("GOLDEN_REBLESS_THRESHOLDS", raising=False)
    before = path.read_bytes()

    with pytest.raises(AssertionError, match="GOLDEN_REBLESS_THRESHOLDS"):
        instruct._bless(_measured(rtf=0.5))  # rtf pinned -- only loudness_dbfs differs

    assert path.read_bytes() == before, "a refused bless must leave the baseline file untouched"


def test_bless_allows_loudness_dbfs_move_with_the_flag(monkeypatch, tmp_path) -> None:
    differing_loudness = {"whisper": -29.0, "neutral": -20.0}
    path = _write_baseline(
        tmp_path, blessed=True, tolerances=dict(BASE_TOLERANCES), loudness_dbfs=differing_loudness
    )
    monkeypatch.setattr(instruct, "BASELINE_PATH", path)
    monkeypatch.setenv("GOLDEN_REBLESS_THRESHOLDS", "1")

    instruct._bless(_measured(rtf=0.5))

    written = json.loads(path.read_text(encoding="utf-8"))
    assert written["loudness_dbfs"]["whisper"] == -30.0
