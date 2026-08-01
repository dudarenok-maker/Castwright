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
    omit_identity: bool = False,
    omit_rtf: bool = False,
) -> Path:
    """`blessed` controls whether the fixture carries the `identity` /
    `loudness_dbfs` / `rtf` measurement blocks -- `_bless()` reads
    `any(k in baseline for k in ("rtf", "identity", "loudness_dbfs",
    "tolerances"))` as its "has this baseline ever been blessed" signal
    (#2045 F5; NOT `identity` alone -- circular for `label="identity"`,
    the defect #2035's first revision shipped; NOT `rtf` alone either -- a
    narrower but still real single-key blind spot the SECOND revision
    shipped, since a merge conflict is just as likely to drop `rtf` as
    `identity`), so `blessed=False` is what a GENUINE never-before-blessed
    baseline looks like, and `blessed=True, tolerances=None` is the
    #2003-shaped hole: previously blessed, but its `tolerances` key was
    lost (e.g. a hand-resolved merge conflict). Conflating the two was the
    bug this file's tests originally pinned as intended behaviour.

    `identity`/`loudness_dbfs` default to exactly what `_measured()` below
    computes, so a test that only varies `rtf` (the pre-#2035 tests) still
    exercises a baseline that is self-consistent on the OTHER two guarded
    fields and doesn't spuriously need the flag for them. A test targeting
    the identity/loudness_dbfs guard passes an explicitly DIFFERENT dict.
    `omit_identity=True` drops `identity` specifically while keeping
    `loudness_dbfs`/`rtf`/`tolerances` -- the #2003-shaped hole applied to
    `identity` itself, the scenario that exposed the FIRST circular probe.
    Under the current `any(...)` probe this fixture correctly reports
    "previously blessed" via the surviving `rtf`/`loudness_dbfs`/
    `tolerances` keys, same as it did under the narrower `rtf`-only probe
    -- this fixture shape doesn't distinguish the two; see
    `omit_rtf` below for the fixture that does. `omit_rtf=True` drops
    `rtf` specifically while keeping `identity`/`loudness_dbfs`/
    `tolerances` -- the scenario the SECOND (still single-key) probe got
    wrong: `bool(baseline.get("rtf"))` alone reads "never blessed" here
    even though three of the four guarded keys are intact."""
    path = tmp_path / "instruct-baseline.json"
    data: dict = {
        "description": "test fixture",
        "voice": "qwen-test",
        "model": "1.7b",
    }
    if blessed:
        if not omit_identity:
            data["identity"] = identity if identity is not None else {
                "anchor": "neutral",
                "cosine": {"whisper": 0.01, "sad": 0.005, "excited": 0.005, "angry": 0.007},
                "max": 0.01,
            }
        data["loudness_dbfs"] = loudness_dbfs if loudness_dbfs is not None else {
            "whisper": -30.0,
            "neutral": -20.0,
        }
        if not omit_rtf:
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
# ── #2045 F1: ...but noise-tolerant -- a WINDOW-sized move refuses, a
#    NOISE-sized move (< epsilon) is accepted AND echoed to stdout. ──


def test_bless_refuses_and_leaves_the_file_untouched_when_identity_would_move(
    monkeypatch, tmp_path
) -> None:
    """`test_live_instruct_golden`'s tolerance ceiling is DERIVED from the
    recorded identity cosines at bless time (`id_max + 0.10`), but the raw
    `identity` block itself was, pre-#2035, never guarded -- a bless run for
    an unrelated reason (e.g. a Kokoro-only re-bless that still touches this
    file) could silently re-record it. A committed identity cosine
    (`whisper: 0.06`) that differs from what this run measured
    (`whisper: 0.01` in `_measured`) by 0.05 -- well beyond
    `IDENTITY_COSINE_EPSILON` (0.015), i.e. WINDOW-sized, not noise -- must
    refuse, same all-or-nothing shape as the `tolerances` guard, including
    that a refusal on `identity` must leave `tolerances`/`loudness_dbfs`/rtf
    entirely unwritten too."""
    differing_identity = {
        "anchor": "neutral",
        "cosine": {"whisper": 0.06, "sad": 0.005, "excited": 0.005, "angry": 0.007},
        "max": 0.06,
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
        "cosine": {"whisper": 0.06, "sad": 0.005, "excited": 0.005, "angry": 0.007},
        "max": 0.06,
    }
    path = _write_baseline(
        tmp_path, blessed=True, tolerances=dict(BASE_TOLERANCES), identity=differing_identity
    )
    monkeypatch.setattr(instruct, "BASELINE_PATH", path)
    monkeypatch.setenv("GOLDEN_REBLESS_THRESHOLDS", "1")

    instruct._bless(_measured(rtf=0.5))

    written = json.loads(path.read_text(encoding="utf-8"))
    assert written["identity"]["cosine"]["whisper"] == 0.01


def test_bless_accepts_and_echoes_a_noise_sized_identity_move(monkeypatch, tmp_path, capsys) -> None:
    """#2045 F1: an exact-equality guard on `identity` refuses on every
    HONEST re-bless -- `instruct-baseline.json`'s own `metadata.notes`
    records ~0.0014 run-to-run identity spread. A committed `whisper: 0.014`
    against this run's measured `0.01` is a 0.004 move -- comfortably below
    `IDENTITY_COSINE_EPSILON` (0.015) and in the same order as the recorded
    noise floor -- so the write must PROCEED with no flag needed, and the
    move must be echoed to stdout (#2035's Acceptance: surfaced loudly
    enough that it cannot pass unnoticed) rather than silently absorbed."""
    noisy_identity = {
        "anchor": "neutral",
        "cosine": {"whisper": 0.014, "sad": 0.005, "excited": 0.005, "angry": 0.007},
        "max": 0.014,
    }
    path = _write_baseline(
        tmp_path, blessed=True, tolerances=dict(BASE_TOLERANCES), identity=noisy_identity
    )
    monkeypatch.setattr(instruct, "BASELINE_PATH", path)
    monkeypatch.delenv("GOLDEN_REBLESS_THRESHOLDS", raising=False)

    instruct._bless(_measured(rtf=0.5))  # no flag set, no raise -- must not refuse

    written = json.loads(path.read_text(encoding="utf-8"))
    assert written["identity"]["cosine"]["whisper"] == 0.01  # the write proceeded
    out = capsys.readouterr().out
    assert "identity" in out and "cosine.whisper" in out, (
        f"expected the noise-sized identity move to be echoed to stdout, got: {out!r}"
    )


def test_bless_refuses_and_leaves_the_file_untouched_when_loudness_dbfs_would_move(
    monkeypatch, tmp_path
) -> None:
    """`baseline["loudness_dbfs"][e]` is the CENTRE of the ±`loudness_dbfs_abs`
    drift window `test_live_instruct_golden` measures a fresh run against --
    an assertion reference, not free data. A committed loudness figure that
    differs from this run's measurement by 1.0 dB -- beyond
    `LOUDNESS_DBFS_EPSILON` (0.4), i.e. WINDOW-sized -- must refuse."""
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


def test_bless_accepts_and_echoes_a_noise_sized_loudness_dbfs_move(monkeypatch, tmp_path, capsys) -> None:
    """A committed `whisper: -30.1` against this run's measured `-30.0` is a
    0.1 dB move -- comfortably below `LOUDNESS_DBFS_EPSILON` (0.4), i.e.
    noise -- so the write must proceed with no flag needed, and echo."""
    noisy_loudness = {"whisper": -30.1, "neutral": -20.0}
    path = _write_baseline(
        tmp_path, blessed=True, tolerances=dict(BASE_TOLERANCES), loudness_dbfs=noisy_loudness
    )
    monkeypatch.setattr(instruct, "BASELINE_PATH", path)
    monkeypatch.delenv("GOLDEN_REBLESS_THRESHOLDS", raising=False)

    instruct._bless(_measured(rtf=0.5))  # no flag set, no raise -- must not refuse

    written = json.loads(path.read_text(encoding="utf-8"))
    assert written["loudness_dbfs"]["whisper"] == -30.0  # the write proceeded
    out = capsys.readouterr().out
    assert "loudness_dbfs" in out and "whisper" in out, (
        f"expected the noise-sized loudness_dbfs move to be echoed to stdout, got: {out!r}"
    )


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


# ── #2035 follow-up: the previously_blessed probe must not be `identity` ───
# itself, or the identity guard can never detect its own #2003-shaped hole.


def test_bless_refuses_when_a_previously_blessed_baseline_is_missing_identity(
    monkeypatch, tmp_path
) -> None:
    """The #2003-shaped hole, applied to `identity` itself (found by
    independent review of #2035's first revision): the FIRST fix used
    `previously_blessed = bool(baseline.get("identity"))` as the probe for
    ALL three guarded fields. That is circular for `label="identity"` --
    it IS the field being guarded, so a baseline that lost exactly its
    `identity` key (this fixture: `omit_identity=True`, everything else
    populated) makes the probe itself read "never blessed" and the guard
    for `identity` never fires, silently re-recording it from whatever this
    run measured. `rtf` (still present here) is the correct probe -- it is
    written unconditionally by every bless and is never itself guarded, so
    it has no equivalent blind spot. Fixed by reading `baseline.get("rtf")`
    instead. Must refuse and leave the file completely untouched, same
    all-or-nothing shape as every other guard refusal in this file."""
    path = _write_baseline(
        tmp_path, blessed=True, tolerances=dict(BASE_TOLERANCES), omit_identity=True
    )
    monkeypatch.setattr(instruct, "BASELINE_PATH", path)
    monkeypatch.delenv("GOLDEN_REBLESS_THRESHOLDS", raising=False)
    before = path.read_bytes()

    with pytest.raises(AssertionError, match="GOLDEN_REBLESS_THRESHOLDS"):
        instruct._bless(_measured(rtf=0.5))  # rtf pinned -- only identity is missing

    assert path.read_bytes() == before, "a refused bless must leave the baseline file untouched"


def test_bless_allows_a_previously_blessed_missing_identity_with_the_flag(
    monkeypatch, tmp_path
) -> None:
    path = _write_baseline(
        tmp_path, blessed=True, tolerances=dict(BASE_TOLERANCES), omit_identity=True
    )
    monkeypatch.setattr(instruct, "BASELINE_PATH", path)
    monkeypatch.setenv("GOLDEN_REBLESS_THRESHOLDS", "1")

    instruct._bless(_measured(rtf=0.5))

    written = json.loads(path.read_text(encoding="utf-8"))
    assert written["identity"]["cosine"]["whisper"] == 0.01


# ── #2045 F5: the `rtf`-only probe removed the CIRCULARITY but kept a ──────
# single-key blind spot -- losing `rtf` alone must still be correctly read
# as "previously blessed" by the OTHER fields' guards. Note this can only be
# observed on a field whose OWN key is also missing (the `existing is None`
# branch is the only branch that consults `previously_blessed` at all) --
# so these fixtures omit `identity` (or `loudness_dbfs`) TOGETHER WITH
# `rtf`, and check THAT field's guard, not `tolerances` (whose key survives
# intact here and so never even reaches the `previously_blessed` check).


def test_bless_refuses_when_a_previously_blessed_baseline_is_missing_both_rtf_and_identity(
    monkeypatch, tmp_path
) -> None:
    """Under the narrower `bool(baseline.get("rtf"))` probe (#2045 F1's
    revision, before F5), a baseline that lost BOTH `rtf` and `identity` --
    while `loudness_dbfs`/`tolerances` survive -- read as "never blessed"
    (`baseline.get("rtf")` is None), so the identity guard's `existing is
    None` branch took the no-op first-bless path and silently re-recorded
    identity with no flag, even though this baseline plainly WAS blessed
    before (evidenced by the surviving `loudness_dbfs`/`tolerances`). The
    current `any(...)` probe reads "previously blessed" via those surviving
    keys and refuses correctly."""
    path = _write_baseline(
        tmp_path, blessed=True, tolerances=dict(BASE_TOLERANCES), omit_rtf=True, omit_identity=True
    )
    monkeypatch.setattr(instruct, "BASELINE_PATH", path)
    monkeypatch.delenv("GOLDEN_REBLESS_THRESHOLDS", raising=False)
    before = path.read_bytes()

    with pytest.raises(AssertionError, match="GOLDEN_REBLESS_THRESHOLDS"):
        instruct._bless(_measured(rtf=0.5))  # rtf pinned so tolerances/loudness_dbfs stay quiet

    assert path.read_bytes() == before, "a refused bless must leave the baseline file untouched"


def test_bless_allows_a_previously_blessed_missing_both_rtf_and_identity_with_the_flag(
    monkeypatch, tmp_path
) -> None:
    path = _write_baseline(
        tmp_path, blessed=True, tolerances=dict(BASE_TOLERANCES), omit_rtf=True, omit_identity=True
    )
    monkeypatch.setattr(instruct, "BASELINE_PATH", path)
    monkeypatch.setenv("GOLDEN_REBLESS_THRESHOLDS", "1")

    instruct._bless(_measured(rtf=0.5))

    written = json.loads(path.read_text(encoding="utf-8"))
    assert written["identity"]["cosine"]["whisper"] == 0.01  # the previously-missing key is now written
    assert written["rtf"]["batched"] == 0.5  # ditto
