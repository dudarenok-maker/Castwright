"""Unit coverage for the golden-audio comparison helpers (ops-11, extended by
ops-45 / #1911 for content drift).

NO model, NO GPU — runs inside the normal fast `test:sidecar` tier (these
have no `golden` marker, so `run-tests.ps1`'s `-m "not golden"` keeps them in
while excluding the real-model goldens). This is the cheap paired coverage for
the gate LOGIC, so a regression in the tolerance maths is caught everywhere,
not just on a blessed GPU box.

The content-drift section below pins `normalize_words` / `content_edits` /
`assert_content` / `bless_guard` directly — pure functions, no engine, no
stubs. This is also the fix for a verified objection to an earlier revision
of #1911: a stub-driven pass/fail control in `test_golden_sanity_gating.py`
can only ever be as good as its stub PCM's plausibility, so the threshold
arithmetic itself needs coverage that never goes near a stub.
"""
from __future__ import annotations

import struct

from tests.golden.compare import (
    FIRST_BLESS_MAX_WER,
    assert_content,
    bless_guard,
    bless_guard_thresholds,
    compare_to_baseline,
    content_edits,
    describe_measurement_move,
    measure_pcm,
    normalize_words,
    rms,
    should_rewrite_reference,
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


# ── normalize_words ────────────────────────────────────────────────────────


def test_normalize_words_lowercases_and_splits():
    assert normalize_words("The Lighthouse Keeper.") == ["the", "lighthouse", "keeper"]


def test_normalize_words_does_not_collapse_possessive_s():
    # #2005: deliberately does NOT mirror segment-asr-qa.ts:276-277's
    # possessive-strip -- that production line only ever strips a genuine
    # possessive because a prior step in normalizeForWer already expanded
    # contractions; this function never did, so stripping "'s" here
    # collapsed contractions ("he's" == "he") too, defeating the golden
    # gate's whole single-word-drift purpose. An apostrophe now just falls
    # out as ordinary punctuation, splitting the word either side of it.
    assert normalize_words("Aldric's before noon") == ["aldric", "s", "before", "noon"]


def test_normalize_words_does_not_collapse_apostrophe_s_contractions():
    # The live bug (#2005): stripping "'s" made a dropped/added contraction
    # invisible to a gate whose advertised purpose is catching exactly this.
    assert normalize_words("he's here") != normalize_words("he here")
    assert normalize_words("it's fine") != normalize_words("it fine")


def test_normalize_words_strips_punctuation_and_dashes():
    assert normalize_words('"Wait," she said -- it’s fine.') == [
        "wait",
        "she",
        "said",
        "it",
        "s",
        "fine",
    ]


def test_normalize_words_declines_integer_spelling():
    # #1911 s2d: deliberately NOT ported from segment-asr-qa.ts -- digits stay
    # digits, so "7" and "seven" are NOT treated as equal.
    assert normalize_words("all 7 of them") == ["all", "7", "of", "them"]


def test_normalize_words_empty_and_whitespace_only():
    assert normalize_words("") == []
    assert normalize_words("   ") == []
    assert normalize_words(None) == []  # defensive: callers pass a recorded/fresh string


# ── content_edits ──────────────────────────────────────────────────────────


def test_content_edits_identical_is_zero():
    assert content_edits("hello world", "hello world") == (0, 0.0)


def test_content_edits_one_substitution():
    edits, wer = content_edits("hello world", "hello there")
    assert edits == 1
    assert wer == 0.5


def test_content_edits_ignores_case_and_punctuation_only_diffs():
    # Both sides normalise to the same tokens -- 0 edits despite the raw
    # strings differing in case/punctuation only.
    edits, wer = content_edits("Wait, she said!", "wait she said")
    assert (edits, wer) == (0, 0.0)


def test_content_edits_wer_is_edits_over_expected_token_count():
    edits, wer = content_edits("one two three four", "one two three")  # a deletion
    assert edits == 1
    assert wer == 0.25  # 1 / 4 expected tokens


def test_content_edits_empty_expected_nonempty_actual_is_full_error():
    assert content_edits("", "hello") == (1, 1.0)


def test_content_edits_both_empty_is_clean():
    assert content_edits("", "") == (0, 0.0)


# ── assert_content -- the drift gate, tolerance 0 (#1911 s2b) ──────────────


def test_assert_content_passes_on_an_exact_match():
    assert assert_content("hello world", "hello world") is None


def test_assert_content_passes_on_a_normalisation_only_difference():
    # Casing/punctuation differences carry no content signal -- both sides
    # are Whisper output, so this is not the bless-path case.
    assert assert_content("Wait, she said!", "wait she said") is None


def test_assert_content_fails_on_a_single_word_substitution():
    reason = assert_content("the grey sea roll in", "the green tea roll in")
    assert reason is not None
    assert "grey sea" in reason and "green tea" in reason


def test_assert_content_tolerance_is_exactly_zero_not_one():
    # A single edit must already fail -- the whole point of #1911 s2b's
    # tolerance-0 decision (the earlier tolerance-1 design absorbed this).
    reason = assert_content("one two three", "one too three")
    assert reason is not None
    assert "1 edit" in reason


def test_assert_content_message_reports_edit_count():
    reason = assert_content("one two three four", "uno dos tres cuatro")
    assert reason is not None
    assert "4 edits" in reason


# ── bless_guard -- G1 + G2 + the first-bless ceiling (#1911 s2c) ───────────


def test_bless_guard_first_bless_accepts_a_clean_transcript():
    assert bless_guard("hello world", None, "hello world") is None


def test_bless_guard_first_bless_accepts_the_five_measured_pairs_from_1911():
    # Pins the 0.35 first-bless ceiling to the actual data (#1911 s1 / s2c):
    # measured worst case across the five fixture lines was 0.231
    # (numbers-and-year). Every pair here must clear the ceiling with room
    # to spare, or the ceiling is mis-set.
    pairs = [
        (
            "The lighthouse keeper watched the grey sea roll in.",
            "The lighthouse keeper watch the grey sea roll in.",
        ),
        (
            "In 1999, all 7 of them boarded the 4:15 train to Dover.",
            "In 1999, all seven of them boarded the four, 15 trained to dover.",
        ),
        (
            "Dr. Hollis and Mr. Vane arrived at St. Aldric's before noon.",
            "Dr. Hollies and Mr. Vane arrived at St. Aldrich's before noon.",
        ),
        (
            '"Wait," she said, "did you really mean it — all of it?"',
            "Wait, she said, did you really mean it all of it?",
        ),
        (
            "He paused at the door. The hallway was silent. Then he stepped through.",
            "He paused at the door, the whole way was silent, then he stepped through.",
        ),
    ]
    for text, fresh in pairs:
        assert bless_guard(text, None, fresh) is None, (text, fresh)


def test_bless_guard_first_bless_refuses_silence():
    assert bless_guard("hello world", None, "") is not None


def test_bless_guard_first_bless_refuses_wrong_text_entirely():
    reason = bless_guard(
        "The lighthouse keeper watched the grey sea roll in.",
        None,
        "completely unrelated words that share nothing with the fixture",
    )
    assert reason is not None


def test_bless_guard_first_bless_ceiling_is_035():
    # Sanity-pin the constant itself so a stray edit to compare.py's module
    # constant is caught here, not just via the behavioural cases above.
    assert FIRST_BLESS_MAX_WER == 0.35


def test_bless_guard_g1_refuses_a_differing_transcript_without_the_flag():
    existing = {"transcript": "hello world", "text_edits": 0}
    reason = bless_guard("hello world", existing, "hello there", allow_rebless_content=False)
    assert reason is not None
    assert "GOLDEN_REBLESS_CONTENT" in reason


def test_bless_guard_g1_allows_a_differing_transcript_with_the_flag():
    # G2 must still pass for this to go through -- 1 edit vs recorded 0 is
    # within the +1 cap.
    existing = {"transcript": "hello world", "text_edits": 0}
    assert (
        bless_guard("hello world", existing, "hello there", allow_rebless_content=True) is None
    )


def test_bless_guard_g1_is_silent_on_an_identical_transcript_even_without_the_flag():
    # Re-blessing durations after a fixture-neutral change (e.g. voice swap)
    # must not require the content flag when the transcript hasn't moved.
    existing = {"transcript": "hello world", "text_edits": 0}
    assert bless_guard("hello world", existing, "hello world", allow_rebless_content=False) is None


def test_bless_guard_g1_is_silent_on_a_normalisation_only_difference():
    # F6c (PR #2002 code-review): G1 compares NORMALISED transcripts, not
    # raw strings -- a punctuation/case-only re-bless (e.g. Whisper's
    # capitalisation or trailing punctuation shifting run-to-run with no
    # actual content change) must not need GOLDEN_REBLESS_CONTENT either.
    # Mutating the comparison to raw `recorded != fresh` leaves every other
    # test green, since none of them drive a normalisation-only difference
    # through G1 specifically.
    existing = {"transcript": "Hello, world!", "text_edits": 0}
    assert bless_guard("hello world", existing, "hello world", allow_rebless_content=False) is None


def test_bless_guard_g2_refuses_beyond_the_recorded_plus_one_cap_even_with_the_flag():
    # The flag bypasses G1 (transcript-differs), never G2 (the edit-count cap).
    existing = {"transcript": "hello world", "text_edits": 0}
    reason = bless_guard(
        "hello world",
        existing,
        "this is a completely different sentence with many more words",
        allow_rebless_content=True,
    )
    assert reason is not None
    assert "text_edits" in reason


def test_bless_guard_g2_allows_exactly_the_plus_one_boundary():
    # F6a (PR #2002 code-review): the prior version of this test never
    # actually drove edits == recorded + 1 -- one assertion was 0 edits
    # (trivially within any cap), the other was 3 edits (well past it).
    # Recorded text_edits=1, so the cap is 2: exactly 2 edits must be
    # ALLOWED, and 3 edits (one past the cap) must be REFUSED.
    existing = {"transcript": "one two three four five", "text_edits": 1}

    assert bless_guard(
        "one two three four five",
        existing,
        "one two threee fourr five",  # three->threee, four->fourr: 2 edits, == cap
        allow_rebless_content=True,
    ) is None

    reason = bless_guard(
        "one two three four five",
        existing,
        "one two threee fourr fiver",  # + five->fiver: 3 edits, one past the cap
        allow_rebless_content=True,
    )
    assert reason is not None
    assert "text_edits" in reason


def test_bless_guard_missing_transcript_key_fails_closed_not_first_bless():
    # #2003 repro 1: `existing` is present (this line has been blessed
    # before -- it carries `text_edits`/`voice`) but its `transcript` KEY is
    # absent (e.g. a hand-resolved merge conflict). That must NOT be treated
    # as a first bless -- the first-bless branch has no G1/opt-in check at
    # all, so a genuine one-word substitution ("grey" -> "green") sailed
    # through silently before this fix.
    existing = {"text_edits": 1, "voice": "af_heart"}
    reason = bless_guard(
        "The lighthouse keeper watched the grey sea roll in.",
        existing,
        "The lighthouse keeper watched the green sea roll in.",
    )
    assert reason is not None
    assert "GOLDEN_REBLESS_CONTENT" in reason


def test_bless_guard_missing_text_edits_key_fails_closed_not_open_cap():
    # #2003 repro 2: `existing` has a `transcript` (so G1 is reachable and
    # bypassed here via the flag) but no `text_edits` key. G2's cap must
    # still apply -- not silently disable, which previously let a totally
    # unrelated transcript through once G1 was bypassed.
    existing = {"transcript": "hello world"}
    reason = bless_guard(
        "hello world",
        existing,
        "utterly different words here entirely nothing alike",
        allow_rebless_content=True,
    )
    assert reason is not None
    assert "text_edits" in reason


def test_bless_guard_null_valued_transcript_fails_closed_like_a_missing_key():
    # #2003 follow-up (independent review of #2032, F2): JSON `null` is the
    # sibling corruption shape to a missing key -- a hand-resolved merge
    # conflict produces it just as easily. `normalize_words(None)` returns
    # [] (`text or ""`), so an unguarded null transcript previously compared
    # equal to an empty FRESH transcript (silence) and sailed through. The
    # cap here (99) is deliberately huge so only G1 -- not G2 -- can catch
    # this: the old code accepted it outright.
    existing = {"transcript": None, "text_edits": 99}
    reason = bless_guard(
        "The lighthouse keeper watched the grey sea roll in.",
        existing,
        "",  # silence
    )
    assert reason is not None
    assert "GOLDEN_REBLESS_CONTENT" in reason


def test_bless_guard_null_text_edits_treated_as_missing_not_a_crash():
    # #2003 follow-up (F2, row 2): a null `text_edits` must not raise
    # (`None + 1` was a TypeError before this fix) -- it gets the same
    # strictest-possible-cap (0) treatment as a missing key.
    existing = {"transcript": "one two three four five", "text_edits": None}
    reason = bless_guard(
        "one two three four five",
        existing,
        "one two threee fourr five",  # 2 edits > 0 + 1 cap
        allow_rebless_content=True,
    )
    assert reason is not None
    assert "text_edits" in reason


def test_bless_guard_wrong_type_text_edits_treated_as_missing_not_a_crash():
    # #2003 follow-up (F2, row 3): a wrong-typed `text_edits` (e.g. a string
    # from a hand-resolved merge conflict) must not raise (`"2" + 1` was a
    # TypeError before this fix) and must not be trusted as a numeric cap.
    existing = {"transcript": "one two three four five", "text_edits": "2"}
    reason = bless_guard(
        "one two three four five",
        existing,
        "one two threee fourr five",  # 2 edits > 0 + 1 cap ("2" not trusted)
        allow_rebless_content=True,
    )
    assert reason is not None
    assert "text_edits" in reason


def test_bless_guard_g2_protects_a_perfectly_transcribing_line():
    # #1911 s2c's key argument for G2: a line with 0 recorded edits over many
    # tokens is structurally unprotectable by a flat WER floor (a fraction of
    # a big denominator hands it several free edits), but G2's absolute cap
    # of recorded + 1 = 1 catches it regardless of line length.
    existing = {
        "transcript": "wait she said did you really mean it all of it",
        "text_edits": 0,
    }
    reason = bless_guard(
        "\"Wait,\" she said, \"did you really mean it — all of it?\"",
        existing,
        "wait she said did you really really mean it all of it",  # +1 word -> 1 edit, within cap
        allow_rebless_content=True,
    )
    assert reason is None  # 1 edit <= recorded 0 + 1

    reason2 = bless_guard(
        "\"Wait,\" she said, \"did you really mean it — all of it?\"",
        existing,
        "wait she said did you really really truly mean it all of it all of it",  # 2+ edits
        allow_rebless_content=True,
    )
    assert reason2 is not None
    assert "text_edits" in reason2


# ── bless_guard_thresholds -- instruct-baseline.json's tolerances (#1995) ──


def test_bless_guard_thresholds_first_bless_has_nothing_to_protect():
    # A never-before-blessed baseline has no committed tolerances to protect.
    assert bless_guard_thresholds(None, {"rtf_max": 1.31}) is None


def test_bless_guard_thresholds_silent_when_the_computed_value_is_unchanged():
    tol = {"identity_cosine_max": 0.15, "loudness_dbfs_abs": 4.0, "rtf_max": 1.0}
    assert bless_guard_thresholds(dict(tol), dict(tol)) is None


def test_bless_guard_thresholds_refuses_a_silent_change_without_the_flag():
    # #1995 repro: a --bless run performed for an unrelated reason (recording
    # Whisper transcripts elsewhere) silently raised rtf_max 1.0 -> 1.31.
    existing = {"identity_cosine_max": 0.15, "loudness_dbfs_abs": 4.0, "rtf_max": 1.0}
    computed = {"identity_cosine_max": 0.15, "loudness_dbfs_abs": 4.0, "rtf_max": 1.31}
    reason = bless_guard_thresholds(existing, computed)
    assert reason is not None
    assert "GOLDEN_REBLESS_THRESHOLDS" in reason


def test_bless_guard_thresholds_allows_the_change_with_the_flag():
    existing = {"identity_cosine_max": 0.15, "loudness_dbfs_abs": 4.0, "rtf_max": 1.0}
    computed = {"identity_cosine_max": 0.15, "loudness_dbfs_abs": 4.0, "rtf_max": 1.31}
    assert bless_guard_thresholds(existing, computed, allow_rebless_thresholds=True) is None


def test_bless_guard_thresholds_missing_key_on_a_previously_blessed_baseline_fails_closed():
    # #2003-shaped hole inside the #1995 fix (independent review of #2032,
    # F1): `existing is None` was the guard's ONLY signal, which makes "this
    # baseline was never blessed" (nothing to protect) and "this blessed
    # baseline lost its `tolerances` key" (e.g. a hand-resolved merge
    # conflict) the same state. The caller must pass `previously_blessed`
    # (its own `baseline.get("identity")` truthiness) so the two states are
    # distinguishable, and the latter must fail CLOSED.
    reason = bless_guard_thresholds(None, {"rtf_max": 1.31}, previously_blessed=True)
    assert reason is not None
    assert "GOLDEN_REBLESS_THRESHOLDS" in reason


def test_bless_guard_thresholds_missing_key_on_a_previously_blessed_baseline_allows_with_the_flag():
    reason = bless_guard_thresholds(
        None, {"rtf_max": 1.31}, previously_blessed=True, allow_rebless_thresholds=True
    )
    assert reason is None


# ── bless_guard_thresholds epsilon -- noise-tolerant measurement fields (#2045 F1) ──


def test_bless_guard_thresholds_default_epsilon_is_exact_equality():
    # epsilon=0.0 (the default) must behave EXACTLY like the pre-#2045
    # equality check -- this is what keeps `tolerances` (quantised, no
    # legitimate noise) refusing on ANY change with no epsilon widening it.
    existing = {"rtf_max": 1.0}
    computed = {"rtf_max": 1.0001}  # a tiny float move is still a REAL move for tolerances
    reason = bless_guard_thresholds(existing, computed)
    assert reason is not None
    assert "GOLDEN_REBLESS_THRESHOLDS" in reason


def test_bless_guard_thresholds_accepts_a_noise_sized_move_within_epsilon():
    # #2045 F1 repro: identity is a raw stochastic measurement (4dp), not a
    # quantised threshold -- exact equality refuses on every honest re-bless.
    existing = {"anchor": "neutral", "cosine": {"whisper": 0.0125}, "max": 0.0125}
    computed = {"anchor": "neutral", "cosine": {"whisper": 0.0130}, "max": 0.0130}  # 0.0005 move
    assert bless_guard_thresholds(existing, computed, epsilon=0.015, label="identity") is None


def test_bless_guard_thresholds_refuses_a_move_beyond_epsilon():
    existing = {"anchor": "neutral", "cosine": {"whisper": 0.0125}, "max": 0.0125}
    computed = {"anchor": "neutral", "cosine": {"whisper": 0.06}, "max": 0.06}  # 0.0475 move
    reason = bless_guard_thresholds(existing, computed, epsilon=0.015, label="identity")
    assert reason is not None
    assert "GOLDEN_REBLESS_THRESHOLDS" in reason
    assert "identity" in reason


def test_bless_guard_thresholds_allows_a_beyond_epsilon_move_with_the_flag():
    existing = {"anchor": "neutral", "cosine": {"whisper": 0.0125}, "max": 0.0125}
    computed = {"anchor": "neutral", "cosine": {"whisper": 0.06}, "max": 0.06}
    reason = bless_guard_thresholds(
        existing, computed, epsilon=0.015, label="identity", allow_rebless_thresholds=True
    )
    assert reason is None


def test_bless_guard_thresholds_epsilon_ignores_a_missing_leaf_never_masks_it():
    # A leaf present on only one side is a STRUCTURAL change, not numeric
    # noise -- must refuse regardless of how large epsilon is set.
    existing = {"whisper": -30.0, "neutral": -20.0}
    computed = {"whisper": -30.0}  # "neutral" silently dropped
    reason = bless_guard_thresholds(existing, computed, epsilon=1000.0, label="loudness_dbfs")
    assert reason is not None


def test_bless_guard_thresholds_epsilon_ignores_a_changed_non_numeric_leaf():
    # A non-numeric leaf that changed (e.g. `identity`'s `anchor` string)
    # must refuse regardless of epsilon -- it is never "noise".
    existing = {"anchor": "neutral", "cosine": {"whisper": 0.0125}, "max": 0.0125}
    computed = {"anchor": "different", "cosine": {"whisper": 0.0125}, "max": 0.0125}
    reason = bless_guard_thresholds(existing, computed, epsilon=1000.0, label="identity")
    assert reason is not None


# ── describe_measurement_move (#2045 F1) ────────────────────────────────────


def test_describe_measurement_move_none_on_first_bless():
    assert describe_measurement_move(None, {"whisper": -30.0}, epsilon=0.4) is None


def test_describe_measurement_move_none_when_nothing_changed():
    existing = {"whisper": -30.0, "neutral": -20.0}
    assert describe_measurement_move(existing, dict(existing), epsilon=0.4) is None


def test_describe_measurement_move_reports_every_moved_leaf():
    existing = {"whisper": -30.0, "neutral": -20.0}
    computed = {"whisper": -30.1, "neutral": -20.0}  # only whisper moved
    desc = describe_measurement_move(existing, computed, epsilon=0.4)
    assert desc is not None
    assert "whisper" in desc
    assert "neutral" not in desc  # unchanged leaf isn't reported as "moved"


def test_describe_measurement_move_labels_a_within_epsilon_move_as_noise():
    existing = {"whisper": -30.0}
    computed = {"whisper": -30.1}  # 0.1 move, epsilon 0.4 -- genuinely noise
    desc = describe_measurement_move(existing, computed, epsilon=0.4)
    assert desc is not None
    assert desc.startswith("within epsilon")
    assert "BEYOND" not in desc and "FORCED" not in desc


def test_describe_measurement_move_labels_a_beyond_epsilon_move_as_forced_not_noise():
    """#2045 F1 defect (independent review of the shipped fix): the shipped
    `describe_measurement_move` unconditionally formatted every move as
    "within epsilon ... (noise)", even one that only reaches this function
    because `bless_guard_thresholds` was forced through via
    `allow_rebless_thresholds` despite being WELL beyond epsilon -- the
    reviewer's repro was a 0.13 identity move (8.7x the 0.015 epsilon of the
    time) echoed as "within epsilon 0.015 (noise)". The label must reflect
    the actual move, not the caller's decision to accept it: a move beyond
    epsilon must say BEYOND/FORCED, never "noise"."""
    existing = {"cosine": {"whisper": 0.0125}}
    computed = {"cosine": {"whisper": 0.1425}}  # 0.13 move, 8.7x epsilon 0.015
    desc = describe_measurement_move(existing, computed, epsilon=0.015)
    assert desc is not None
    assert desc.startswith("BEYOND epsilon")
    assert "FORCED" in desc and "GOLDEN_REBLESS_THRESHOLDS" in desc
    assert "noise" not in desc
    assert "cosine.whisper" in desc


def test_describe_measurement_move_beyond_epsilon_echoes_a_custom_flag_name():
    """#2060 root cause / D1: the flag name in the FORCED echo must come from
    the caller (`GOLDEN_REBLESS_MEASUREMENTS` for identity/loudness_dbfs
    since the split), not a hardcoded `GOLDEN_REBLESS_THRESHOLDS` -- the
    guard's loudest output naming the WRONG flag would itself be a silent-ish
    failure, exactly the class of bug #2060 traced #2035's flag reuse to."""
    existing = {"whisper": -30.0}
    computed = {"whisper": -32.0}  # 2.0 dB, well beyond a 0.4 epsilon
    desc = describe_measurement_move(existing, computed, epsilon=0.4, flag_name="GOLDEN_REBLESS_MEASUREMENTS")
    assert desc is not None
    assert "GOLDEN_REBLESS_MEASUREMENTS" in desc
    assert "GOLDEN_REBLESS_THRESHOLDS" not in desc


def test_bless_guard_thresholds_missing_key_echoes_a_custom_flag_name():
    reason = bless_guard_thresholds(
        None, {"rtf_max": 1.31}, previously_blessed=True, flag_name="GOLDEN_REBLESS_MEASUREMENTS"
    )
    assert reason is not None
    assert "GOLDEN_REBLESS_MEASUREMENTS" in reason
    assert "GOLDEN_REBLESS_THRESHOLDS" not in reason


def test_bless_guard_thresholds_beyond_epsilon_refusal_echoes_a_custom_flag_name():
    existing = {"whisper": -30.0}
    computed = {"whisper": -32.0}
    reason = bless_guard_thresholds(
        existing, computed, epsilon=0.4, label="loudness_dbfs", flag_name="GOLDEN_REBLESS_MEASUREMENTS"
    )
    assert reason is not None
    assert "GOLDEN_REBLESS_MEASUREMENTS" in reason
    assert "GOLDEN_REBLESS_THRESHOLDS" not in reason


# ── _leaf_diffs non-dict corruption (#2061 / D2) -- exercised through the ───
# public functions that share it, not the private helper directly.


def test_bless_guard_thresholds_refuses_a_non_dict_existing_instead_of_crashing():
    """Before this fix, `_leaf_diffs(existing, computed)` called
    `existing.items()` unconditionally and crashed with `AttributeError` on
    a type-corrupted baseline block (e.g. a hand-resolved merge conflict
    that collapsed `"loudness_dbfs"` to a bare scalar). It already failed
    CLOSED (no write), so this pins the ERROR-QUALITY fix: the same guard
    refusal message a structural diff produces, not a traceback."""
    reason = bless_guard_thresholds(-21.16, {"whisper": -30.0}, label="loudness_dbfs")
    assert reason is not None
    assert "loudness_dbfs" in reason


def test_bless_guard_thresholds_refuses_a_non_dict_existing_list_shape_too():
    reason = bless_guard_thresholds([1, 2], {"whisper": -30.0}, label="loudness_dbfs")
    assert reason is not None


def test_bless_guard_thresholds_refuses_a_non_dict_computed_too():
    # `computed` is always built by `_bless()`'s own code in practice, but
    # the guard must not crash if it were ever handed something malformed.
    reason = bless_guard_thresholds({"whisper": -30.0}, -21.16, label="loudness_dbfs")
    assert reason is not None


def test_describe_measurement_move_refuses_gracefully_on_a_non_dict_existing():
    # Not reachable via a real bless (bless_guard_thresholds would already
    # have refused first), but describe_measurement_move shares _leaf_diffs
    # with the guard and must not crash either.
    desc = describe_measurement_move(-21.16, {"whisper": -30.0}, epsilon=0.4)
    assert desc is not None
    assert "BEYOND epsilon" in desc


# ── describe_measurement_move's forced-absent-key echo (#2069 / D5) ────────


def test_describe_measurement_move_forced_absent_key_speaks():
    """The highest-stakes case the guard handles -- a whole reference block
    resurrected blind over a dropped key, under an explicit flag -- used to
    print nothing at all (`existing is None` returned `None` unconditionally).
    Echoed in a shape that does not pretend to have a diff (there is no
    'before' to compare)."""
    computed = {"whisper": -30.0, "neutral": -20.0}
    desc = describe_measurement_move(None, computed, epsilon=0.4, previously_blessed=True)
    assert desc is not None
    assert desc.startswith("FORCED, key was ABSENT")
    assert "no prior reference" in desc
    assert repr(computed) in desc


def test_describe_measurement_move_genuine_first_bless_stays_silent():
    """`existing is None` with `previously_blessed=False` (the default) is a
    GENUINE first bless -- nothing to report, same as before this change."""
    assert describe_measurement_move(None, {"whisper": -30.0}, epsilon=0.4) is None
    assert describe_measurement_move(None, {"whisper": -30.0}, epsilon=0.4, previously_blessed=False) is None


# ── should_rewrite_reference (#2060 / D4) ───────────────────────────────────


def test_should_rewrite_reference_true_on_a_first_bless():
    assert should_rewrite_reference(None, {"whisper": -30.0}, epsilon=0.4) is True


def test_should_rewrite_reference_false_on_a_noise_sized_move():
    existing = {"whisper": -30.0}
    computed = {"whisper": -30.1}  # 0.1 move, epsilon 0.4 -- noise
    assert should_rewrite_reference(existing, computed, epsilon=0.4) is False


def test_should_rewrite_reference_true_on_a_beyond_epsilon_move():
    """Only reachable in `_bless()` after `bless_guard_thresholds` already
    accepted the move -- which, for a beyond-epsilon diff, only happens when
    the caller forced it through via the flag. The fresh measurement must be
    written in that case, not silently discarded like a noise move."""
    existing = {"whisper": -30.0}
    computed = {"whisper": -32.0}  # 2.0 move, epsilon 0.4 -- forced
    assert should_rewrite_reference(existing, computed, epsilon=0.4) is True


def test_should_rewrite_reference_false_at_the_epsilon_boundary():
    # max_diff == epsilon is within-tolerance (`bless_guard_thresholds` uses
    # the same `<=`), so this is the noise branch, not the forced one --
    # `tolerances`' default epsilon=0.0 makes an exact match (0.0 <= 0.0)
    # keep `existing`. Harmless here since existing == computed already, but
    # the boundary itself must land on the "keep" side, not silently on the
    # "write" side by an off-by-one in the comparison operator.
    tol = {"identity_cosine_max": 0.15, "loudness_dbfs_abs": 4.0, "rtf_max": 1.0}
    assert should_rewrite_reference(dict(tol), dict(tol), epsilon=0.0) is False
