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
    `any(baseline.get(k) is not None for k in ("rtf", "identity",
    "loudness_dbfs", "tolerances"))` as its "has this baseline ever been
    blessed" signal
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
    is needed even though `rtf_max` differs from nothing."""
    path = _write_baseline(tmp_path, blessed=False, tolerances=None)
    monkeypatch.setattr(instruct, "BASELINE_PATH", path)
    monkeypatch.delenv("GOLDEN_REBLESS_THRESHOLDS", raising=False)

    # rtf 0.873 * 1.5 = 1.3095, matching the #1995 issue's observed
    # regression (1.0 -> 1.31) before quantisation. #2062 / D3: quantised UP
    # to the nearest 0.05 step -> 1.35, never the pre-quantisation 1.31.
    instruct._bless(_measured(rtf=0.873))

    written = json.loads(path.read_text(encoding="utf-8"))
    assert written["tolerances"]["rtf_max"] == 1.35


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
    monkeypatch, tmp_path, capsys
) -> None:
    """#2069 / D5: this is the highest-stakes case the guard handles -- a
    whole `tolerances` block resurrected blind under the flag, with no prior
    reference to diff against. It must speak, even though `tolerances` uses
    epsilon=0.0 (the old `if epsilon > 0` gate would have suppressed this
    echo entirely)."""
    path = _write_baseline(tmp_path, blessed=True, tolerances=None)
    monkeypatch.setattr(instruct, "BASELINE_PATH", path)
    monkeypatch.setenv("GOLDEN_REBLESS_THRESHOLDS", "1")

    instruct._bless(_measured(rtf=0.873))

    written = json.loads(path.read_text(encoding="utf-8"))
    assert written["tolerances"]["rtf_max"] == 1.35
    out = capsys.readouterr().out
    assert "tolerances: FORCED, key was ABSENT" in out, (
        f"expected the forced-absent-key write to speak, got: {out!r}"
    )


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
    assert written["tolerances"]["rtf_max"] == 1.35


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
    `IDENTITY_COSINE_EPSILON` (0.005), i.e. WINDOW-sized, not noise -- must
    refuse, same all-or-nothing shape as the `tolerances` guard, including
    that a refusal on `identity` must leave `tolerances`/`loudness_dbfs`/rtf
    entirely unwritten too. #2060 root cause / D1: `identity` is governed by
    `GOLDEN_REBLESS_MEASUREMENTS`, NOT `GOLDEN_REBLESS_THRESHOLDS` -- the two
    flags were split so a `tolerances`-only re-bless can never silently
    re-authorise this move."""
    differing_identity = {
        "anchor": "neutral",
        "cosine": {"whisper": 0.06, "sad": 0.005, "excited": 0.005, "angry": 0.007},
        "max": 0.06,
    }
    path = _write_baseline(
        tmp_path, blessed=True, tolerances=dict(BASE_TOLERANCES), identity=differing_identity
    )
    monkeypatch.setattr(instruct, "BASELINE_PATH", path)
    monkeypatch.delenv("GOLDEN_REBLESS_MEASUREMENTS", raising=False)
    before = path.read_bytes()

    with pytest.raises(AssertionError, match="GOLDEN_REBLESS_MEASUREMENTS"):
        instruct._bless(_measured(rtf=0.5))  # rtf pinned -- only identity differs

    assert path.read_bytes() == before, "a refused bless must leave the baseline file untouched"


def test_bless_allows_identity_move_with_the_flag(monkeypatch, tmp_path, capsys) -> None:
    """#2045 F1 defect (independent review of the shipped fix): this is a
    WINDOW-sized move (0.05, well beyond `IDENTITY_COSINE_EPSILON`) that only
    gets written because the flag forced the guard through -- the shipped
    `describe_measurement_move` unconditionally labelled every echoed move
    "within epsilon ... (noise)" regardless of whether it actually was, so
    this exact scenario printed a large, flag-forced re-centre as if it were
    routine noise, the one line meant to make it loud. Must say
    BEYOND/FORCED, never "noise". #2060 root cause / D1: the forcing flag
    and its echo both name `GOLDEN_REBLESS_MEASUREMENTS`, not the
    `tolerances`-only `GOLDEN_REBLESS_THRESHOLDS`."""
    differing_identity = {
        "anchor": "neutral",
        "cosine": {"whisper": 0.06, "sad": 0.005, "excited": 0.005, "angry": 0.007},
        "max": 0.06,
    }
    path = _write_baseline(
        tmp_path, blessed=True, tolerances=dict(BASE_TOLERANCES), identity=differing_identity
    )
    monkeypatch.setattr(instruct, "BASELINE_PATH", path)
    monkeypatch.setenv("GOLDEN_REBLESS_MEASUREMENTS", "1")

    instruct._bless(_measured(rtf=0.5))

    written = json.loads(path.read_text(encoding="utf-8"))
    assert written["identity"]["cosine"]["whisper"] == 0.01  # forced -- the fresh value IS written
    out = capsys.readouterr().out
    assert "identity" in out and "cosine.whisper" in out
    assert "BEYOND epsilon" in out and "FORCED" in out and "GOLDEN_REBLESS_MEASUREMENTS" in out, (
        f"a flag-forced window-sized move must never be echoed as noise, got: {out!r}"
    )
    assert "(noise)" not in out
    assert "GOLDEN_REBLESS_THRESHOLDS" not in out, "identity's echo must never name the wrong flag"


def test_bless_accepts_a_noise_sized_identity_move_without_rewriting_the_reference(
    monkeypatch, tmp_path, capsys
) -> None:
    """#2045 F1: an exact-equality guard on `identity` refuses on every
    HONEST re-bless -- `instruct-baseline.json`'s own `metadata.notes`
    records ~0.0014 run-to-run identity spread. A committed `whisper: 0.014`
    against this run's measured `0.01` is a 0.004 move -- below
    `IDENTITY_COSINE_EPSILON` (0.005, ~3.6x the observed 0.0014 noise floor)
    and in the same order as the recorded noise -- so the bless must not
    refuse, no flag needed, and the move must be echoed to stdout (#2035's
    Acceptance: surfaced loudly enough that it cannot pass unnoticed).

    #2060 / D4: unlike the pre-fix behaviour, the write does NOT rewrite the
    reference with the fresh measurement -- a noise-sized move is noise, and
    noise carries no information. `written["identity"]` must stay the
    COMMITTED `0.014`, not the fresh `0.01`; this is what makes N consecutive
    within-epsilon blesses structurally unable to walk the reference (#2060's
    ten-successive-blesses repro), rather than merely bounded."""
    noisy_identity = {
        "anchor": "neutral",
        "cosine": {"whisper": 0.014, "sad": 0.005, "excited": 0.005, "angry": 0.007},
        "max": 0.014,
    }
    path = _write_baseline(
        tmp_path, blessed=True, tolerances=dict(BASE_TOLERANCES), identity=noisy_identity
    )
    monkeypatch.setattr(instruct, "BASELINE_PATH", path)
    monkeypatch.delenv("GOLDEN_REBLESS_MEASUREMENTS", raising=False)

    instruct._bless(_measured(rtf=0.5))  # no flag set, no raise -- must not refuse

    written = json.loads(path.read_text(encoding="utf-8"))
    assert written["identity"]["cosine"]["whisper"] == 0.014, (
        "a noise-sized move must leave the committed reference UNCHANGED, not overwrite it "
        "with the fresh measurement"
    )
    assert written["identity"] == noisy_identity
    out = capsys.readouterr().out
    assert "identity" in out and "cosine.whisper" in out, (
        f"expected the noise-sized identity move to be echoed to stdout, got: {out!r}"
    )
    assert "noise -- reference unchanged" in out
    assert "BEYOND" not in out and "FORCED" not in out


def test_bless_refuses_an_identity_move_the_old_arbitrary_epsilon_would_have_masked(
    monkeypatch, tmp_path
) -> None:
    """#2045 F1 defect (independent review): `IDENTITY_COSINE_EPSILON` was
    shipped as `0.015` -- "10% of `identity_cosine_max` (0.15)" -- but
    nothing in the assert path diffs a fresh measurement against the
    committed `identity` block at all (the assertion is an absolute
    ceiling, `dist > tol["identity_cosine_max"]`), so "10% of 0.15" had no
    real relationship to identity's actual noise. Against the real signal
    (`instruct-baseline.json`'s own recorded ~0.0014 run-to-run spread),
    0.015 was ~10.7x the noise floor -- enough to silently swallow a 0.008
    move (0.64x the committed 0.0125 identity value itself) as "noise". The
    recalibrated epsilon (0.005, ~3.6x the noise floor) must refuse this
    same 0.008 move without the flag -- proving the old value would have
    hidden a real regression the new one catches."""
    committed_identity = {
        "anchor": "neutral",
        # 0.01 + 0.008 = 0.018 -- an 0.008 move from _measured()'s 0.01.
        "cosine": {"whisper": 0.018, "sad": 0.005, "excited": 0.005, "angry": 0.007},
        "max": 0.018,
    }
    path = _write_baseline(
        tmp_path, blessed=True, tolerances=dict(BASE_TOLERANCES), identity=committed_identity
    )
    monkeypatch.setattr(instruct, "BASELINE_PATH", path)
    monkeypatch.delenv("GOLDEN_REBLESS_MEASUREMENTS", raising=False)
    before = path.read_bytes()

    with pytest.raises(AssertionError, match="GOLDEN_REBLESS_MEASUREMENTS"):
        instruct._bless(_measured(rtf=0.5))  # rtf pinned -- only identity differs

    assert path.read_bytes() == before, "a refused bless must leave the baseline file untouched"


def test_bless_refuses_and_leaves_the_file_untouched_when_loudness_dbfs_would_move(
    monkeypatch, tmp_path
) -> None:
    """`baseline["loudness_dbfs"][e]` is the CENTRE of the ±`loudness_dbfs_abs`
    drift window `test_live_instruct_golden` measures a fresh run against --
    an assertion reference, not free data. A committed loudness figure that
    differs from this run's measurement by 1.0 dB -- beyond
    `LOUDNESS_DBFS_EPSILON` (0.4), i.e. WINDOW-sized -- must refuse. #2060
    root cause / D1: governed by `GOLDEN_REBLESS_MEASUREMENTS`, not
    `GOLDEN_REBLESS_THRESHOLDS`."""
    differing_loudness = {"whisper": -29.0, "neutral": -20.0}  # measured has whisper: -30.0
    path = _write_baseline(
        tmp_path, blessed=True, tolerances=dict(BASE_TOLERANCES), loudness_dbfs=differing_loudness
    )
    monkeypatch.setattr(instruct, "BASELINE_PATH", path)
    monkeypatch.delenv("GOLDEN_REBLESS_MEASUREMENTS", raising=False)
    before = path.read_bytes()

    with pytest.raises(AssertionError, match="GOLDEN_REBLESS_MEASUREMENTS"):
        instruct._bless(_measured(rtf=0.5))  # rtf pinned -- only loudness_dbfs differs

    assert path.read_bytes() == before, "a refused bless must leave the baseline file untouched"


def test_bless_accepts_a_noise_sized_loudness_dbfs_move_without_rewriting_the_reference(
    monkeypatch, tmp_path, capsys
) -> None:
    """A committed `whisper: -30.1` against this run's measured `-30.0` is a
    0.1 dB move -- comfortably below `LOUDNESS_DBFS_EPSILON` (0.4), i.e.
    noise -- so the bless must not refuse, no flag needed, and it must echo.
    #2060 / D4: the write must NOT rewrite the reference with the fresh
    measurement -- `written["loudness_dbfs"]["whisper"]` stays the committed
    `-30.1`, not the fresh `-30.0`."""
    noisy_loudness = {"whisper": -30.1, "neutral": -20.0}
    path = _write_baseline(
        tmp_path, blessed=True, tolerances=dict(BASE_TOLERANCES), loudness_dbfs=noisy_loudness
    )
    monkeypatch.setattr(instruct, "BASELINE_PATH", path)
    monkeypatch.delenv("GOLDEN_REBLESS_MEASUREMENTS", raising=False)

    instruct._bless(_measured(rtf=0.5))  # no flag set, no raise -- must not refuse

    written = json.loads(path.read_text(encoding="utf-8"))
    assert written["loudness_dbfs"]["whisper"] == -30.1, (
        "a noise-sized move must leave the committed reference UNCHANGED, not overwrite it "
        "with the fresh measurement"
    )
    assert written["loudness_dbfs"] == noisy_loudness
    out = capsys.readouterr().out
    assert "loudness_dbfs" in out and "whisper" in out, (
        f"expected the noise-sized loudness_dbfs move to be echoed to stdout, got: {out!r}"
    )
    assert "noise -- reference unchanged" in out
    assert "BEYOND" not in out and "FORCED" not in out


def test_bless_allows_loudness_dbfs_move_with_the_flag(monkeypatch, tmp_path, capsys) -> None:
    """#2045 F1 defect (independent review of the shipped fix): a 1.0 dB
    move -- beyond `LOUDNESS_DBFS_EPSILON` (0.4) -- only written because the
    flag forced it through. Must be echoed BEYOND/FORCED, never as noise.
    #2060 root cause / D1: `GOLDEN_REBLESS_MEASUREMENTS`, not
    `GOLDEN_REBLESS_THRESHOLDS`."""
    differing_loudness = {"whisper": -29.0, "neutral": -20.0}
    path = _write_baseline(
        tmp_path, blessed=True, tolerances=dict(BASE_TOLERANCES), loudness_dbfs=differing_loudness
    )
    monkeypatch.setattr(instruct, "BASELINE_PATH", path)
    monkeypatch.setenv("GOLDEN_REBLESS_MEASUREMENTS", "1")

    instruct._bless(_measured(rtf=0.5))

    written = json.loads(path.read_text(encoding="utf-8"))
    assert written["loudness_dbfs"]["whisper"] == -30.0  # forced -- the fresh value IS written
    out = capsys.readouterr().out
    assert "loudness_dbfs" in out and "whisper" in out
    assert "BEYOND epsilon" in out and "FORCED" in out and "GOLDEN_REBLESS_MEASUREMENTS" in out, (
        f"a flag-forced window-sized move must never be echoed as noise, got: {out!r}"
    )
    assert "(noise)" not in out
    assert "GOLDEN_REBLESS_THRESHOLDS" not in out, "loudness_dbfs's echo must never name the wrong flag"


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
    monkeypatch.delenv("GOLDEN_REBLESS_MEASUREMENTS", raising=False)
    before = path.read_bytes()

    with pytest.raises(AssertionError, match="GOLDEN_REBLESS_MEASUREMENTS"):
        instruct._bless(_measured(rtf=0.5))  # rtf pinned -- only identity is missing

    assert path.read_bytes() == before, "a refused bless must leave the baseline file untouched"


def test_bless_allows_a_previously_blessed_missing_identity_with_the_flag(
    monkeypatch, tmp_path, capsys
) -> None:
    """#2069 / D5: the highest-stakes forced write (a whole guarded block
    resurrected blind over a dropped key) must speak."""
    path = _write_baseline(
        tmp_path, blessed=True, tolerances=dict(BASE_TOLERANCES), omit_identity=True
    )
    monkeypatch.setattr(instruct, "BASELINE_PATH", path)
    monkeypatch.setenv("GOLDEN_REBLESS_MEASUREMENTS", "1")

    instruct._bless(_measured(rtf=0.5))

    written = json.loads(path.read_text(encoding="utf-8"))
    assert written["identity"]["cosine"]["whisper"] == 0.01
    out = capsys.readouterr().out
    assert "identity: FORCED, key was ABSENT" in out, (
        f"expected the forced-absent-key write to speak, got: {out!r}"
    )


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
    monkeypatch.delenv("GOLDEN_REBLESS_MEASUREMENTS", raising=False)
    before = path.read_bytes()

    with pytest.raises(AssertionError, match="GOLDEN_REBLESS_MEASUREMENTS"):
        instruct._bless(_measured(rtf=0.5))  # rtf pinned so tolerances/loudness_dbfs stay quiet

    assert path.read_bytes() == before, "a refused bless must leave the baseline file untouched"


def test_bless_allows_a_previously_blessed_missing_both_rtf_and_identity_with_the_flag(
    monkeypatch, tmp_path
) -> None:
    path = _write_baseline(
        tmp_path, blessed=True, tolerances=dict(BASE_TOLERANCES), omit_rtf=True, omit_identity=True
    )
    monkeypatch.setattr(instruct, "BASELINE_PATH", path)
    monkeypatch.setenv("GOLDEN_REBLESS_MEASUREMENTS", "1")

    instruct._bless(_measured(rtf=0.5))

    written = json.loads(path.read_text(encoding="utf-8"))
    assert written["identity"]["cosine"]["whisper"] == 0.01  # the previously-missing key is now written
    assert written["rtf"]["batched"] == 0.5  # ditto


# ── #2045 F5 second pass: `k in baseline` refuses the documented first ─────
# bless (independent review of #2045 itself). `instruct-baseline.json`'s own
# `description` field prescribes the never-blessed scaffold as all four
# guarded keys present but explicitly `null` -- "Unblessed (entries null) =>
# the assert test SKIPs." A bare `k in baseline` presence check reads that
# shape as "previously blessed" (the keys ARE present, just null), so a
# genuine first bless of a baseline scaffolded exactly per its own docs
# demanded the flag on all three guards. The fix reads
# `baseline.get(k) is not None`.


def test_bless_allows_a_first_bless_of_the_documented_all_null_scaffold(monkeypatch, tmp_path) -> None:
    """Reproduces `instruct-baseline.json`'s own documented "Unblessed"
    shape verbatim: all four guarded keys present with an explicit `null`
    value, not omitted. This must be treated exactly like a genuinely
    never-blessed baseline (`blessed=False` in `_write_baseline`) -- no
    flag needed, every field written."""
    path = tmp_path / "instruct-baseline.json"
    path.write_text(
        json.dumps(
            {
                "description": "Unblessed (entries null) => the assert test SKIPs.",
                "voice": "qwen-test",
                "model": "1.7b",
                "tolerances": None,
                "identity": None,
                "loudness_dbfs": None,
                "rtf": None,
            },
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )
    monkeypatch.setattr(instruct, "BASELINE_PATH", path)
    monkeypatch.delenv("GOLDEN_REBLESS_THRESHOLDS", raising=False)
    monkeypatch.delenv("GOLDEN_REBLESS_MEASUREMENTS", raising=False)

    instruct._bless(_measured(rtf=0.873))

    written = json.loads(path.read_text(encoding="utf-8"))
    assert written["tolerances"]["rtf_max"] == 1.35  # #2062 / D3: quantised, see other tests
    assert written["identity"]["cosine"]["whisper"] == 0.01
    assert written["loudness_dbfs"]["whisper"] == -30.0
    assert written["rtf"]["batched"] == 0.873


# ── #2060 root cause / D1: the flag is SPLIT, not shared -- setting one ────
# must never silently authorise the other domain (the exact bug #2035
# introduced by reusing a single GOLDEN_REBLESS_THRESHOLDS for all three
# guarded fields).


def test_bless_flag_permutations_each_domain_needs_its_own_flag(monkeypatch, tmp_path) -> None:
    """#2035's original single `GOLDEN_REBLESS_THRESHOLDS` armed `tolerances`,
    `identity`, AND `loudness_dbfs` together -- an operator setting the flag
    to force through a legitimate `identity` re-bless silently re-authorised
    an unrelated `rtf_max` ceiling move too. This fixture needs BOTH a
    `tolerances` move (rtf 0.5 -> 0.873, pinned floor 1.0 -> quantised 1.35)
    and a WINDOW-sized `identity` move (committed 0.06 vs measured 0.01) to
    exercise all four permutations of the two now-separate flags."""
    differing_identity = {
        "anchor": "neutral",
        "cosine": {"whisper": 0.06, "sad": 0.005, "excited": 0.005, "angry": 0.007},
        "max": 0.06,
    }
    path = _write_baseline(
        tmp_path, blessed=True, tolerances=dict(BASE_TOLERANCES), identity=differing_identity
    )
    monkeypatch.setattr(instruct, "BASELINE_PATH", path)
    before = path.read_bytes()

    # 1. Neither flag set -- refuses. `tolerances` is checked first in
    # `_bless()`'s guard order, so the refusal names GOLDEN_REBLESS_THRESHOLDS.
    monkeypatch.delenv("GOLDEN_REBLESS_THRESHOLDS", raising=False)
    monkeypatch.delenv("GOLDEN_REBLESS_MEASUREMENTS", raising=False)
    with pytest.raises(AssertionError, match="GOLDEN_REBLESS_THRESHOLDS"):
        instruct._bless(_measured(rtf=0.873))
    assert path.read_bytes() == before

    # 2. GOLDEN_REBLESS_THRESHOLDS alone -- forces `tolerances` through, but
    # `identity` is NOT armed by it -- refuses, naming the OTHER flag. Proves
    # the split: pre-#2060 this single flag would have silently forced BOTH.
    monkeypatch.setenv("GOLDEN_REBLESS_THRESHOLDS", "1")
    monkeypatch.delenv("GOLDEN_REBLESS_MEASUREMENTS", raising=False)
    with pytest.raises(AssertionError, match="GOLDEN_REBLESS_MEASUREMENTS"):
        instruct._bless(_measured(rtf=0.873))
    assert path.read_bytes() == before, "a refusal on identity must leave tolerances unwritten too"

    # 3. GOLDEN_REBLESS_MEASUREMENTS alone -- `tolerances` is checked FIRST
    # and is NOT armed by this flag -- still refuses, naming THRESHOLDS.
    monkeypatch.delenv("GOLDEN_REBLESS_THRESHOLDS", raising=False)
    monkeypatch.setenv("GOLDEN_REBLESS_MEASUREMENTS", "1")
    with pytest.raises(AssertionError, match="GOLDEN_REBLESS_THRESHOLDS"):
        instruct._bless(_measured(rtf=0.873))
    assert path.read_bytes() == before, "GOLDEN_REBLESS_MEASUREMENTS must never authorise a tolerances move"

    # 4. Both set -- both moves are forced through, and the bless succeeds.
    monkeypatch.setenv("GOLDEN_REBLESS_THRESHOLDS", "1")
    monkeypatch.setenv("GOLDEN_REBLESS_MEASUREMENTS", "1")
    instruct._bless(_measured(rtf=0.873))
    written = json.loads(path.read_text(encoding="utf-8"))
    assert written["tolerances"]["rtf_max"] == 1.35
    assert written["identity"]["cosine"]["whisper"] == 0.01


# ── #2062 / D3: rtf_max is quantised to a 0.05 step, rounded UP -- ordinary ─
# rtf noise (sub-0.05) can no longer move it across a re-bless, and the
# committed baseline itself must not move under the new arithmetic.


def test_bless_quantised_rtf_max_survives_sub_step_rtf_noise_across_two_blesses(
    monkeypatch, tmp_path
) -> None:
    """rtf=0.68 and rtf=0.69 straddle a 0.01 raw difference in
    `max(1.0, rtf*1.5)` (1.02 vs 1.035) that, pre-quantisation, rounded to
    TWO DIFFERENT rtf_max values (1.02 vs 1.03) -- a second honest re-bless
    with slightly different rtf would have refused under the exact-equality
    `tolerances` guard with no flag set. Quantised to a 0.05 step, both
    compute the SAME rtf_max (1.05), so the second bless needs no flag."""
    path = _write_baseline(tmp_path, blessed=False, tolerances=None)
    monkeypatch.setattr(instruct, "BASELINE_PATH", path)
    monkeypatch.delenv("GOLDEN_REBLESS_THRESHOLDS", raising=False)

    instruct._bless(_measured(rtf=0.68))
    first = json.loads(path.read_text(encoding="utf-8"))
    assert first["tolerances"]["rtf_max"] == 1.05

    # Second bless, same identity/loudness (only rtf_max is in play here),
    # slightly different rtf -- must NOT need the flag.
    instruct._bless(_measured(rtf=0.69))

    second = json.loads(path.read_text(encoding="utf-8"))
    assert second["tolerances"]["rtf_max"] == 1.05


def test_quantise_rtf_max_does_not_move_the_committed_baseline() -> None:
    """#2062 / D3 acceptance, verified against the ACTUAL committed
    `instruct-baseline.json` (`rtf.batched` = 0.5089, well under the ~0.667
    cliff): `max(1.0, 0.5089 * 1.5)` = 1.0, and quantising 1.0 up to the
    nearest 0.05 step is still 1.0 -- byte-identical to the committed
    `tolerances.rtf_max`. If this test ever fails, the quantisation
    arithmetic changed and the committed baseline needs an actual re-bless,
    not a silent drift at review time."""
    baseline = instruct._load_json(instruct.BASELINE_PATH)
    committed_rtf = baseline["rtf"]["batched"]
    recomputed = instruct._quantise_rtf_max(max(1.0, committed_rtf * 1.5))
    assert recomputed == baseline["tolerances"]["rtf_max"]


# ── #2060 / D4: a within-epsilon move no longer rewrites the reference, so ──
# repeated noise-sized blesses cannot compound into an unbounded walk.


def test_bless_ten_successive_noise_sized_loudness_moves_leave_the_reference_unmoved(
    monkeypatch, tmp_path
) -> None:
    """#2060's repro, replayed literally (#2116 F8, independent review: the
    prior revision of this test precomputed a FIXED absolute measured value
    every iteration, so under the pre-fix producer the reference moved
    ONCE and then stopped -- it never reproduced the reported compounding
    3.90 dB walk). Each iteration here instead reads the file's CURRENT
    `loudness_dbfs["whisper"]` and measures 0.39 dB below THAT (just under
    `LOUDNESS_DBFS_EPSILON` = 0.4) -- genuinely relative to the current
    reference, exactly mirroring how `_bless()` itself re-reads
    `BASELINE_PATH` fresh on every call in real life.

    Pre-fix (every accepted noise move REWRITES the reference): bless 1
    reads -30.0, measures -30.39, diff 0.39 (noise), WRITES -30.39. Bless 2
    reads THAT -30.39 as its anchor, measures -30.78, diff 0.39 again
    (still noise relative to the JUST-WRITTEN reference), WRITES -30.78.
    ... bless 10 writes -33.90 -- the exact 3.90 dB walk #2060 reported,
    with no refusal and no flag ever needed at any step.

    #2060 / D4: since a noise move keeps `existing` untouched, the file's
    reference never moves past its first committed value -- so every
    subsequent iteration reads the SAME -30.0 as 'current', and 10 repeats
    of an identical 0.39 dB-from-anchor measurement never move it, not even
    by increments. The walk is not merely caught late; it cannot start."""
    starting_whisper = -30.0
    path = _write_baseline(
        tmp_path,
        blessed=True,
        tolerances=dict(BASE_TOLERANCES),
        loudness_dbfs={"whisper": starting_whisper, "neutral": -20.0},
    )
    monkeypatch.setattr(instruct, "BASELINE_PATH", path)
    monkeypatch.delenv("GOLDEN_REBLESS_MEASUREMENTS", raising=False)

    for _ in range(10):
        current_ref = json.loads(path.read_text(encoding="utf-8"))["loudness_dbfs"]["whisper"]
        measured = _measured(rtf=0.5)
        measured["loudness_dbfs"] = {"whisper": round(current_ref - 0.39, 2), "neutral": -20.0}
        instruct._bless(measured)  # must not refuse -- every call is individually noise-sized

    written = json.loads(path.read_text(encoding="utf-8"))
    assert written["loudness_dbfs"]["whisper"] == starting_whisper, (
        "ten successive noise-sized moves, each measured relative to the CURRENT reference, "
        f"must leave the reference UNMOVED at {starting_whisper} -- not walk it to -33.9 dB "
        "the way #2060's literal repro did pre-fix"
    )
    assert written["loudness_dbfs"] == {"whisper": starting_whisper, "neutral": -20.0}


# ── #2061 / D2, second half: `_assert_against_baseline` (test_live_instruct_ ─
# golden's guard body, extracted so it's drivable without a GPU).


def test_assert_against_baseline_skips_instead_of_keyerror_when_tolerances_is_missing(
    monkeypatch, tmp_path
) -> None:
    """`identity` present but `tolerances` absent is the same hand-resolved-
    merge-conflict shape `_bless()`'s own guards were hardened against --
    before this fix, `test_live_instruct_golden` read `baseline["tolerances"]`
    unguarded behind a skip check that only looked at `identity`, so this
    shape raised `KeyError` instead of taking the documented SKIP path."""
    path = tmp_path / "instruct-baseline.json"
    path.write_text(
        json.dumps(
            {
                "description": "test fixture",
                "identity": {"anchor": "neutral", "cosine": {"whisper": 0.01}, "max": 0.01},
                "loudness_dbfs": {"whisper": -30.0, "neutral": -20.0},
                # tolerances deliberately omitted -- the #2003-shaped hole.
            },
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )
    monkeypatch.setattr(instruct, "BASELINE_PATH", path)

    with pytest.raises(pytest.skip.Exception) as exc_info:
        instruct._assert_against_baseline(_measured(rtf=0.5))

    assert "unblessed" in str(exc_info.value).lower()


def test_assert_against_baseline_skips_when_identity_is_missing(monkeypatch, tmp_path) -> None:
    """Unchanged behaviour, pinned alongside the new tolerances-absent case
    so the two documented SKIP triggers (`identity` absent, `tolerances`
    absent) stay distinguishable from each other in coverage."""
    path = tmp_path / "instruct-baseline.json"
    path.write_text(
        json.dumps({"description": "test fixture", "tolerances": None, "identity": None}, indent=2) + "\n",
        encoding="utf-8",
    )
    monkeypatch.setattr(instruct, "BASELINE_PATH", path)

    with pytest.raises(pytest.skip.Exception) as exc_info:
        instruct._assert_against_baseline(_measured(rtf=0.5))

    assert "unblessed" in str(exc_info.value).lower()


def test_assert_against_baseline_passes_when_fully_blessed(monkeypatch, tmp_path) -> None:
    """Sanity check that the extraction (#2061 / D2) didn't change the
    HAPPY path: a fully-blessed baseline with `measured` safely inside
    tolerance neither skips nor raises.

    #2116 R2 (independent review): the ORIGINAL version of this test called
    `instruct._assert_against_baseline(...)` with a bare trailing comment
    ("must not raise or skip") and no enforcement. `pytest.skip()` raises
    `Skipped`, a `BaseException` -- it propagates straight past the end of
    the test function and pytest reports the TEST ITSELF as skipped, which
    reads as GREEN in a summary line, not as a failure. So an unconditional
    `if True: pytest.skip(...)` swapped in for the real (#2116 F3/F4)
    `isinstance` guard survived the entire suite: `test_live_instruct_
    golden`'s own real-hardware SKIP path makes an unconditional skip look
    correct in isolation, and this was the ONE test meant to prove the
    assert path still runs on a healthy baseline -- but asserted nothing
    about which outcome (pass vs. skip) actually happened. This is the same
    shape as the golden-audio tier's known "reports exit 0 while running
    NOTHING" failure mode (a `pytest.skip()` reading as a green run) arriving
    through a new door, and the F3/F4 fix widened the door: the skip
    condition went from one field's bare `is None` to two fields'
    `isinstance` checks with no corresponding tightening of the one test
    meant to catch an over-broad version of it.
    `pytest.skip.Exception` (`Skipped`) is caught explicitly and turned into
    a hard `pytest.fail` here, so a skip on this fixture is now a RED, not
    a quiet extra line in `-v` output.

    Separately (documented here per #2116 R2, not a behaviour change): a
    non-dict `tolerances`/`loudness_dbfs` block is now a SILENT SKIP where,
    before #2061/#2116 F3/F4, it raised a loud `TypeError`. That is the
    intended #2061 design extended consistently to the assert side (a
    corrupted baseline reads as "nothing to assert against yet", the same
    as a genuinely unblessed one) -- but it trades a crash for a green skip
    on a corrupted baseline, which is worth stating plainly rather than
    leaving for the next reader to discover by surprise."""
    path = _write_baseline(tmp_path, blessed=True, tolerances=dict(BASE_TOLERANCES))
    monkeypatch.setattr(instruct, "BASELINE_PATH", path)

    try:
        instruct._assert_against_baseline(_measured(rtf=0.5))
    except pytest.skip.Exception as skipped:
        pytest.fail(
            f"a fully-blessed baseline with measured safely inside tolerance must not SKIP: {skipped}"
        )


# ── #2116 F3/F4 (independent review): the SAME two corruption shapes on ────
# `loudness_dbfs` (F3: dropped outright, the adjacent-unguarded-subscript
# shape #2061 fixed for `tolerances` alone) and on `tolerances` itself (F4:
# present but collapsed to a non-dict scalar, closing the cross product of
# "which field" x "dropped vs wrong-shaped" that #2061/D2 left open).


def test_assert_against_baseline_skips_instead_of_keyerror_when_loudness_dbfs_is_missing(
    monkeypatch, tmp_path
) -> None:
    """#2116 F3: `identity` and `tolerances` present, `loudness_dbfs` absent
    -- the identical hand-resolved-merge-conflict shape #2061 fixed for
    `tolerances`, but on the adjacent subscript (`base_L = baseline[
    "loudness_dbfs"]`) the comment two lines above it already named as
    needing this same guard. Must SKIP, not raise `KeyError`."""
    path = tmp_path / "instruct-baseline.json"
    path.write_text(
        json.dumps(
            {
                "description": "test fixture",
                "identity": {"anchor": "neutral", "cosine": {"whisper": 0.01}, "max": 0.01},
                "tolerances": dict(BASE_TOLERANCES),
                # loudness_dbfs deliberately omitted -- the #2003-shaped hole.
            },
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )
    monkeypatch.setattr(instruct, "BASELINE_PATH", path)

    with pytest.raises(pytest.skip.Exception) as exc_info:
        instruct._assert_against_baseline(_measured(rtf=0.5))

    assert "unblessed" in str(exc_info.value).lower()


def test_assert_against_baseline_skips_instead_of_typeerror_when_tolerances_is_a_scalar(
    monkeypatch, tmp_path
) -> None:
    """#2116 F4: `tolerances` collapsed to a non-dict scalar (the same
    corruption class #2061/D2 closed on the BLESS side via `_leaf_diffs`'
    `isinstance` guard) is non-`None`, so it sailed past the old bare `tol
    is None` SKIP check and raised `TypeError: 'float' object is not
    subscriptable` on `tol["identity_cosine_max"]`. Must SKIP instead."""
    path = tmp_path / "instruct-baseline.json"
    path.write_text(
        json.dumps(
            {
                "description": "test fixture",
                "identity": {"anchor": "neutral", "cosine": {"whisper": 0.01}, "max": 0.01},
                "loudness_dbfs": {"whisper": -30.0, "neutral": -20.0},
                "tolerances": -21.16,  # collapsed to a scalar -- the #2061-shaped corruption
            },
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )
    monkeypatch.setattr(instruct, "BASELINE_PATH", path)

    with pytest.raises(pytest.skip.Exception) as exc_info:
        instruct._assert_against_baseline(_measured(rtf=0.5))

    assert "unblessed" in str(exc_info.value).lower()


def test_assert_against_baseline_skips_instead_of_typeerror_when_loudness_dbfs_is_a_scalar(
    monkeypatch, tmp_path
) -> None:
    """#2116 F3/F4 cross product: `loudness_dbfs` collapsed to a non-dict,
    truthy, non-`None` scalar -- passes a bare presence/`is None` check but
    (pre-fix) raised `TypeError: argument of type 'float' is not a
    container or iterable` on the very first `e in base_L` membership test
    below. Must SKIP instead. (A LIST-shaped corruption here is a
    DIFFERENT, sneakier defect than a crash -- `"whisper" in [1, 2]` is
    valid Python and just evaluates False, so the per-emotion drift check
    silently no-ops instead of raising anything at all; `isinstance(...,
    dict)` closes that shape too, since a list is exactly as non-dict as a
    scalar, but it isn't separately pinned here because it wouldn't
    distinguish old from new behaviour via a raise/no-raise mutation
    test.)"""
    path = tmp_path / "instruct-baseline.json"
    path.write_text(
        json.dumps(
            {
                "description": "test fixture",
                "identity": {"anchor": "neutral", "cosine": {"whisper": 0.01}, "max": 0.01},
                "tolerances": dict(BASE_TOLERANCES),
                "loudness_dbfs": -21.16,  # collapsed to a scalar -- the #2061-shaped corruption
            },
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )
    monkeypatch.setattr(instruct, "BASELINE_PATH", path)

    with pytest.raises(pytest.skip.Exception) as exc_info:
        instruct._assert_against_baseline(_measured(rtf=0.5))

    assert "unblessed" in str(exc_info.value).lower()


# ── #2116 independent review of PR #2116 (D5): F1 -- echoes must never ─────
# print before the write they describe. F2 -- the caller-side echo gate was
# ITSELF the bug, not the fix; deleted rather than widened.


def test_bless_mixed_forced_and_refused_prints_nothing_and_writes_nothing(
    monkeypatch, tmp_path, capsys
) -> None:
    """#2116 F1 (independent review), reproduced exactly as reported: a
    previously-blessed baseline with `tolerances` dropped (forced through
    via `GOLDEN_REBLESS_THRESHOLDS`) and `identity` beyond epsilon with
    `GOLDEN_REBLESS_MEASUREMENTS` NOT set. `_bless()`'s guard order
    processes `tolerances` FIRST -- it is forced through and would (pre-fix)
    echo `tolerances: FORCED, key was ABSENT ... wrote {...}` immediately,
    inside the loop -- then `identity` is checked and REFUSES, aborting the
    whole call. The write is all-or-nothing (one `write_text`, at the very
    end, after every field is accepted), so a refusal must leave BOTH the
    file AND stdout exactly as they were: nothing written, nothing printed.
    The pre-fix echo-inside-the-loop bug printed a false "wrote {...}" for a
    write that never happened -- precisely the class of lie #2060 / D4
    removed from the noise line and D5 reintroduced on the guard's loudest
    output."""
    differing_identity = {
        "anchor": "neutral",
        "cosine": {"whisper": 0.06, "sad": 0.005, "excited": 0.005, "angry": 0.007},
        "max": 0.06,
    }
    path = _write_baseline(tmp_path, blessed=True, tolerances=None, identity=differing_identity)
    monkeypatch.setattr(instruct, "BASELINE_PATH", path)
    monkeypatch.setenv("GOLDEN_REBLESS_THRESHOLDS", "1")
    monkeypatch.delenv("GOLDEN_REBLESS_MEASUREMENTS", raising=False)
    before = path.read_bytes()

    with pytest.raises(AssertionError, match="GOLDEN_REBLESS_MEASUREMENTS"):
        instruct._bless(_measured(rtf=0.5))  # rtf pinned -- only identity moves beyond epsilon

    assert path.read_bytes() == before, "a refused bless must leave the baseline file untouched"
    out = capsys.readouterr().out
    assert out == "", f"a refused bless must print NOTHING -- an earlier field's echo leaked: {out!r}"


def test_bless_allows_a_forced_tolerances_move_and_echoes_it(monkeypatch, tmp_path, capsys) -> None:
    """#2116 F2 (independent review): the literal #1995 shape -- a
    flag-forced `tolerances` MOVE (`existing` present, non-`None`, epsilon
    0.0), not merely an ABSENT key -- used to print nothing at all, because
    the caller-side `if epsilon > 0 or existing_val is None` gate only
    widened the D5 echo to cover the absent-key HALF of `tolerances`, not a
    move on an already-present block. `rtf_max` moving 1.0 -> 1.35 (rtf 0.5
    -> 0.873) under the flag -- the exact #1995 shape this whole mechanism
    exists to catch -- must be echoed BEYOND epsilon, not silent."""
    path = _write_baseline(tmp_path, blessed=True, tolerances=dict(BASE_TOLERANCES))
    monkeypatch.setattr(instruct, "BASELINE_PATH", path)
    monkeypatch.setenv("GOLDEN_REBLESS_THRESHOLDS", "1")
    monkeypatch.delenv("GOLDEN_REBLESS_MEASUREMENTS", raising=False)

    instruct._bless(_measured(rtf=0.873))

    written = json.loads(path.read_text(encoding="utf-8"))
    assert written["tolerances"]["rtf_max"] == 1.35
    out = capsys.readouterr().out
    assert "tolerances" in out and "rtf_max" in out, (
        f"a flag-forced tolerances MOVE must be echoed, got: {out!r}"
    )
    assert "BEYOND epsilon" in out and "FORCED" in out and "GOLDEN_REBLESS_THRESHOLDS" in out
    # #2116 R3 (independent review): the producer emits "within epsilon N
    # (noise -- reference unchanged)" for a noise move, so the literal
    # substring "(noise)" (with the parenthesis) never appears in EITHER
    # branch and this assertion could not fail -- a placebo. "noise" (no
    # parens), matching the sibling accept-path tests' spelling, is what
    # actually distinguishes the BEYOND/FORCED branch from the noise one.
    assert "noise" not in out
