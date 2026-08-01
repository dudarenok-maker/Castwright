"""Pure comparison helpers for the golden-audio regression harness (ops-11,
extended by ops-45 / #1911 for content drift).

Deliberately import-light — only the stdlib `array`/`math`/`re`/`unicodedata`,
NO torch / onnx / numpy / kokoro / faster_whisper. That keeps
`test_golden_compare.py` runnable inside the normal fast `test:sidecar` tier
(no model, no GPU), so the gate LOGIC always has cheap paired coverage even
though the real-model golden tests are opt-in.

Audio contract (mirrors server/src/tts/pcm.ts): raw 16-bit signed little-endian
MONO PCM. duration = sample_count / sample_rate; sample_count = len(pcm) // 2.

The harness asserts on duration / sample-count within a tolerance (portable
across machines) rather than a raw content hash (Kokoro is ONNX-deterministic in
LENGTH on the same weights, but sample VALUES drift across GPU/driver/hardware,
so a byte hash would flake — see docs/features/<N>-golden-audio-regression.md).

`normalize_words` / `content_edits` / `assert_content` / `bless_guard` are
NOT the production ASR-QA policy in `server/src/tts/segment-asr-qa.ts`. That
policy is a *trustworthiness policy* (cast allowlists, compression-ratio loop
detection, `avg_logprob` routing, short-reference and homophone backstops,
compound bridging) biased toward NOT false-flagging a reader's own book. A
golden gate has the opposite job: the fixture text is fixed and known, so it
should be intentionally simpler and stricter, and catch an engine regression
rather than avoid one false alarm. The two are not kept in sync, by design —
see ops-45 / #1911 §4.
"""
from __future__ import annotations

import array
import math
import re
import unicodedata
from typing import Optional

BYTES_PER_SAMPLE = 2  # 16-bit
INT16_FULL_SCALE = 32768.0

# Gross-garbage floor at FIRST bless only (ops-45 §2c) — silence (WER 1.0), a
# wrong-text render (~1.0), and calibration-pangram bleed (~1.0) all land near
# 1.0, far above this. It is explicitly NOT a regression guard once a
# `transcript` is recorded — `bless_guard`'s G1/G2 do that job instead, because
# a flat floor has no headroom to spare on a line that transcribes perfectly
# (see #1911 §2c). Measured worst case across the five fixture lines (2026-07-31,
# faster-whisper `base`/CPU, 3 identical passes) was 0.231 (numbers-and-year);
# kept at 0.35 rather than tightened because 0.30 leaves that line spare 0,
# able to spuriously refuse a legitimate first bless for no detection gain.
FIRST_BLESS_MAX_WER = 0.35

# #2045 F1 (independent review of #2035): `identity`/`loudness_dbfs` in
# instruct-baseline.json are raw stochastic measurements (4dp / 2dp) — NOT
# quantised like `tolerances` (`max(0.15, id_max+0.10)`, a flat `4.0`,
# `max(1.0, rtf*1.5)`), which is why an exact-equality guard is correct for
# `tolerances` but refuses on every honest re-bless of the other two:
# `instruct-baseline.json`'s own `metadata.notes` records ~0.0014 run-to-run
# identity spread (0.0125 committed vs ~0.0139 spike). Each epsilon below is
# 10% of the window the field feeds — `identity_cosine_max` (0.15) and
# `loudness_dbfs_abs` (4.0) as committed today — cross-checked against that
# spread: 0.015 sits ~10.7x above the observed 0.0014 noise floor, so a
# genuine re-bless's noise clears it easily while a move approaching the
# window itself does not.
IDENTITY_COSINE_EPSILON = 0.015  # 10% of the committed identity_cosine_max (0.15)
LOUDNESS_DBFS_EPSILON = 0.4  # 10% of the committed loudness_dbfs_abs (4.0)

_NON_ALNUM_RE = re.compile(r"[^a-z0-9]+")


def measure_pcm(pcm: bytes, sample_rate: int) -> dict:
    """Sample count + duration of a raw 16-bit mono PCM buffer."""
    sample_count = len(pcm) // BYTES_PER_SAMPLE
    duration_sec = sample_count / sample_rate if sample_rate > 0 else 0.0
    return {
        "sample_rate": sample_rate,
        "sample_count": sample_count,
        "duration_sec": duration_sec,
    }


def rms(pcm: bytes) -> float:
    """Mean normalised RMS over the whole buffer, in [0, 1]. A near-zero value
    means the engine returned (near-)silence. Mirrors the dead-RMS signal in
    server/src/tts/segment-qa.ts (the full gate is Node-only)."""
    sample_count = len(pcm) // BYTES_PER_SAMPLE
    if sample_count == 0:
        return 0.0
    samples = array.array("h")
    samples.frombytes(pcm[: sample_count * BYTES_PER_SAMPLE])
    if sys_byteorder_is_big():
        samples.byteswap()  # frombytes is native-endian; PCM is LE
    sum_squares = 0.0
    for s in samples:
        n = s / INT16_FULL_SCALE
        sum_squares += n * n
    return math.sqrt(sum_squares / sample_count)


def sys_byteorder_is_big() -> bool:
    import sys

    return sys.byteorder == "big"


def _within(actual: float, expected: float, tol: float) -> bool:
    """True when `actual` is within `tol` (fractional) of `expected`. A zero
    expected only matches a zero actual."""
    if expected == 0:
        return actual == 0
    return abs(actual - expected) / abs(expected) <= tol


def compare_to_baseline(measured: dict, baseline: dict, tol: float = 0.02) -> list[str]:
    """Return a list of human-readable mismatches between a freshly measured
    sample and its committed baseline. Empty list == pass.

    - sample_rate must match EXACTLY (a rate change is never within tolerance).
    - sample_count (and the derived duration) must be within `tol` fractional.
    """
    reasons: list[str] = []

    m_rate = measured.get("sample_rate")
    b_rate = baseline.get("sample_rate")
    if m_rate != b_rate:
        reasons.append(f"sample_rate {m_rate} != baseline {b_rate}")

    m_count = float(measured.get("sample_count", 0))
    b_count = float(baseline.get("sample_count", 0))
    if not _within(m_count, b_count, tol):
        pct = (abs(m_count - b_count) / b_count * 100) if b_count else float("inf")
        reasons.append(
            f"sample_count {int(m_count)} vs baseline {int(b_count)} "
            f"({pct:.1f}% off, tol {tol * 100:.0f}%)"
        )

    return reasons


def model_sha256(path: str) -> Optional[str]:
    """SHA-256 of a model weight file, or None if absent. Recorded in the
    baseline metadata so an intentional weights bump is legible (a mismatch
    explains 'you upgraded the model')."""
    import hashlib
    import os

    if not os.path.isfile(path):
        return None
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


# ── content drift (ops-45 / #1911) ────────────────────────────────────────


def normalize_words(text: str) -> list[str]:
    """Tokenise `text` for content-drift comparison: NFKC -> casefold ->
    replace non-alphanumeric with a space -> split. Deliberately NOT
    `segment-asr-qa.ts`'s `normalizeForWer` — no contraction expansion, no
    integer-to-word spelling (see #1911 §2d: under `bless_guard`'s G2 cap,
    adding those buys zero spare capacity, so they are skipped to save ~12
    lines and a second copy of production's number table).

    #2005: earlier revisions also stripped possessive `'s` / stray
    apostrophes before this step, mirroring `segment-asr-qa.ts:276-277`.
    That mirror was incomplete — production expands contractions BEFORE
    stripping `'s` (so only a genuine possessive ever reaches the strip),
    while this function never expanded contractions at all. The result
    collapsed `'s` **contractions** too: `he's` / `it's` / `that's` all
    normalised to `he` / `it` / `that`, so a regression that drops or adds
    `'s` scored 0 edits on a gate whose whole purpose is single-word drift
    (live on the committed `abbreviations` fixture: `Aldric's`). Per this
    module's own stricter-than-production rationale (see the module
    docstring), and since the drift check compares Whisper transcript to
    Whisper transcript (both sides carry the same apostrophe-splitting
    quirk, so it cancels — see #1911's identical argument for dropping
    integer-spelling normalisation), the fix is to drop the strip rather
    than add contraction expansion: an apostrophe is now just punctuation
    that falls out via `_NON_ALNUM_RE`, splitting `he's` into `he`, `s` —
    two tokens, not silently swallowed into `he`."""
    s = unicodedata.normalize("NFKC", text or "").casefold()
    s = _NON_ALNUM_RE.sub(" ", s)
    return s.split()


def _word_edit_distance(a: list[str], b: list[str]) -> int:
    """Levenshtein distance (substitution/insertion/deletion, cost 1 each)
    over two token lists. Plain O(len(a) * len(b)) DP — the fixture lines are
    a handful of words, so this never needs to be fast."""
    if not a:
        return len(b)
    if not b:
        return len(a)
    prev = list(range(len(b) + 1))
    for i, x in enumerate(a, start=1):
        cur = [i] + [0] * len(b)
        for j, y in enumerate(b, start=1):
            cost = 0 if x == y else 1
            cur[j] = min(
                prev[j] + 1,  # deletion
                cur[j - 1] + 1,  # insertion
                prev[j - 1] + cost,  # substitution
            )
        prev = cur
    return prev[-1]


def content_edits(expected: str, actual: str) -> tuple[int, float]:
    """Word-level edit distance between the normalised token lists of
    `expected` and `actual`, plus the derived error rate (edits / max(1,
    len(expected tokens))). Pure, no I/O — the metric both the drift check
    (`assert_content`) and the bless-time guard (`bless_guard`) share."""
    e = normalize_words(expected)
    a = normalize_words(actual)
    edits = _word_edit_distance(e, a)
    if e:
        wer = edits / len(e)
    else:
        wer = 1.0 if a else 0.0
    return edits, wer


def assert_content(recorded: str, fresh: str) -> Optional[str]:
    """Drift check at TOLERANCE 0 (#1911 §2b — not 1; the `1` traced to no
    measurement and was cut). `recorded` is the committed baseline
    transcript, `fresh` is this run's Whisper output for the same line —
    both sides are Whisper output, so normalisation only absorbs a
    cosmetic-only diff (casing, stray punctuation), never a real one.
    Returns a human-readable was/now message on ANY drift, None on a clean
    match."""
    edits, _wer = content_edits(recorded, fresh)
    if edits == 0:
        return None
    plural = "" if edits == 1 else "s"
    return f"content drift ({edits} edit{plural}): was {recorded!r}, now {fresh!r}"


def bless_guard(
    text: str,
    existing: Optional[dict],
    fresh: str,
    *,
    allow_rebless_content: bool = False,
) -> Optional[str]:
    """Refuse an unsafe `--bless` write of a per-line transcript. Pure: the
    caller reads `GOLDEN_REBLESS_CONTENT` from the environment and passes it
    as `allow_rebless_content` — this function never touches os.environ.

    `existing` is the CURRENT baseline entry for this line (or None on a
    brand-new fixture line); `text` is the authored fixture text; `fresh` is
    this bless run's Whisper transcript.

    Two guards, in order (#1911 §2c — the anti-tautology mechanism is these
    two, NOT a flat WER floor, which was shown to refuse nothing the drift
    gate at tolerance 0 can detect):

    - **G1**: if `existing` already has a `transcript` that DIFFERS from
      `fresh`, refuse unless `allow_rebless_content` — converts silent
      absorption (including the wider hole of a duration-only re-bless
      wholesale-rewriting every entry) into a deliberate, named act.
    - **G2**: `content_edits(text, fresh)`'s edit count may never exceed the
      existing entry's recorded `text_edits + 1`, even when G1 is bypassed.
      Unlike G1 this has NO escape flag — it is what protects a line that
      transcribes perfectly (0 recorded edits), which a flat floor cannot.

    A line with no recorded `transcript` yet (first bless) has no G2 value to
    key off, so it instead gets `FIRST_BLESS_MAX_WER` as a gross-garbage
    floor — explicitly not a regression guard, just a "did this render
    silence / the wrong text entirely" check.

    #2003: `existing is not None` but missing the `transcript` key (e.g. a
    hand-resolved merge conflict, or re-blessing on top of a pre-#1911
    baseline) is a DISTINCT state from `existing is None` (a genuine first
    bless) — it must fail CLOSED via the same G1 path as a differing
    transcript, never fall into the no-op first-bless branch. Likewise a
    missing `text_edits` key on an otherwise-populated entry must not
    silently disable G2's cap; it is treated as the strictest possible
    recorded value (0), not "no cap". A JSON `null` (present key, `None`
    value) or a wrong-typed value (e.g. a string) is the same corruption
    shape a hand-resolved merge conflict produces just as easily as an
    absent key, so both get the identical missing-key treatment: a null/
    non-string `transcript` fails closed via G1 (not silently accepted —
    `normalize_words(None)` collapses to `[]`, which would otherwise compare
    equal to a silent fresh transcript), and a null/non-int `text_edits`
    falls back to the strictest cap (0) rather than raising."""
    edits, wer = content_edits(text, fresh)

    if existing is None:
        if wer > FIRST_BLESS_MAX_WER:
            return (
                f"first bless refused: WER {wer:.3f} exceeds the gross-garbage "
                f"ceiling {FIRST_BLESS_MAX_WER} (text={text!r} fresh={fresh!r})"
            )
        return None

    recorded_transcript = existing.get("transcript")
    if not recorded_transcript:
        if not allow_rebless_content:
            return (
                "refusing to bless: existing entry has no recorded "
                f"'transcript' key (was {existing!r}) -- set "
                "GOLDEN_REBLESS_CONTENT=1 to confirm this is intentional"
            )
    else:
        if (
            normalize_words(recorded_transcript) != normalize_words(fresh)
            and not allow_rebless_content
        ):
            return (
                "refusing to re-bless: transcript differs from the recorded "
                f"baseline (was {recorded_transcript!r}, now {fresh!r}) -- set "
                "GOLDEN_REBLESS_CONTENT=1 to confirm this is intentional"
            )

    recorded_edits_raw = existing.get("text_edits", 0)
    recorded_edits = recorded_edits_raw if isinstance(recorded_edits_raw, int) else 0
    if edits > recorded_edits + 1:
        return (
            f"refusing to bless: text_edits {edits} would exceed the recorded "
            f"{recorded_edits} + 1 cap"
        )

    return None


def _flatten_leaves(d: dict, prefix: str = "") -> dict:
    """Flatten a dict nested at most one level deep (as `tolerances` /
    `identity` / `loudness_dbfs` all are) into `{"dotted.key": leaf_value}`
    pairs, so a nested dict (`identity`'s `cosine` sub-dict) and a flat one
    (`loudness_dbfs`, `tolerances`) can be diffed leaf-by-leaf with the same
    code."""
    out: dict = {}
    for k, v in d.items():
        key = f"{prefix}.{k}" if prefix else k
        if isinstance(v, dict):
            out.update(_flatten_leaves(v, prefix=key))
        else:
            out[key] = v
    return out


def _is_number(v: object) -> bool:
    return isinstance(v, (int, float)) and not isinstance(v, bool)


def _leaf_diffs(existing: dict, computed: dict) -> dict:
    """Per-leaf absolute difference between two (possibly one-level-nested)
    dicts, dotted-key flattened. A leaf present on only one side, or whose
    value isn't numeric on BOTH sides (e.g. `identity`'s `anchor` string
    leaf, if it ever changed), is reported as `float('inf')` — never
    mistaken for in-tolerance noise, however large `epsilon` is set, and
    never silently dropped from the comparison."""
    e_flat = _flatten_leaves(existing)
    c_flat = _flatten_leaves(computed)
    diffs: dict = {}
    for key in sorted(set(e_flat) | set(c_flat)):
        e_val = e_flat.get(key)
        c_val = c_flat.get(key)
        if _is_number(e_val) and _is_number(c_val):
            diffs[key] = abs(e_val - c_val)
        elif e_val == c_val:
            diffs[key] = 0.0
        else:
            diffs[key] = math.inf
    return diffs


def describe_measurement_move(existing: Optional[dict], computed: dict, *, epsilon: float) -> Optional[str]:
    """Human-readable summary of every leaf that moved between `existing`
    and `computed`, for the caller to print when a noise-tolerant
    (`epsilon > 0`) bless field is WRITTEN despite `existing != computed` —
    #2045 F1: the guard accepting a within-epsilon move silently was exactly
    the failure mode #2035's Acceptance ruled out ("surfaced loudly enough
    that it cannot pass unnoticed"), and the accept path is the half of a
    guard that mutation testing routinely leaves uncovered (see #2025 in a
    sibling lane). Returns `None` when there is nothing to report: `existing`
    is `None` (first bless, nothing to compare against) or every leaf is
    identical. Lists every moved leaf, not just the largest, so an operator
    scanning bless output sees exactly which keys moved.

    **The label reflects the ACTUAL move, not the caller's intent** (fix for
    an independent review finding on #2045 F1 itself: the first revision
    unconditionally printed "within epsilon ... (noise)" for every move this
    function was called on, including a move `bless_guard_thresholds` only
    let through because `allow_rebless_thresholds` was set — a window-sized
    or larger move, mislabelled as noise the one place an operator would
    have caught it). This function only ever runs on a move the guard already
    decided to WRITE, but that decision has two distinct reasons: the move
    was genuinely `<= epsilon` (real noise), or it was forced through despite
    being beyond epsilon via the flag. Recomputing `max(moved.values()) <=
    epsilon` here — independently of whatever the guard decided — tells the
    two apart and labels accordingly: `within epsilon` for a real noise-sized
    move, or an unmistakably loud `BEYOND epsilon ... (FORCED by
    GOLDEN_REBLESS_THRESHOLDS)` for a forced one, so the flag's one intended
    use (a genuine `tolerances`-only re-bless) can never quietly launder an
    unrelated large identity/loudness move as noise."""
    if existing is None:
        return None
    diffs = _leaf_diffs(existing, computed)
    moved = {k: v for k, v in diffs.items() if v > 0}
    if not moved:
        return None
    parts = ", ".join(f"{k}: +/-{v:.4f}" for k, v in sorted(moved.items(), key=lambda kv: -kv[1]))
    max_diff = max(moved.values())
    if max_diff <= epsilon:
        return f"within epsilon {epsilon} (noise) -- {parts}"
    return f"BEYOND epsilon {epsilon} (FORCED by GOLDEN_REBLESS_THRESHOLDS) -- {parts}"


def bless_guard_thresholds(
    existing: Optional[dict],
    computed: dict,
    *,
    previously_blessed: bool = False,
    allow_rebless_thresholds: bool = False,
    label: str = "tolerances",
    epsilon: float = 0.0,
) -> Optional[str]:
    """Refuse a `--bless` write that would change a baseline's assertion
    reference — a THRESHOLD *or a recorded measurement an assertion is
    diffed against*, neither of which is a free measurement (#1995, widened
    by #2035, made noise-tolerant by #2045 F1). `instruct-baseline.json`
    mixes bare measurements (rtf, the per-item breakdown) with values that
    later assertions compare a fresh run TO — thresholds derived from them
    (`identity_cosine_max`, `rtf_max`, ...) as well as the recorded
    `identity` cosines and `loudness_dbfs` figures themselves
    (`test_instruct_golden.py`'s per-emotion drift check diffs a fresh
    measurement against `baseline["loudness_dbfs"][e]` — that recorded
    figure is the CENTRE of a drift window, not just data). A bless run
    performed for an unrelated reason must not silently move any of these to
    whatever THIS run happened to measure (observed: rtf_max 1.0 -> 1.31
    under GPU contention, recorded by a bless that was about something else
    entirely). This same guard call protects all three fields — `_bless()`
    calls it once per field (`label="tolerances"`, `label="identity"`,
    `label="loudness_dbfs"`), each all-or-nothing: a refusal on any one
    field raises before ANY field is written, mirroring `bless_guard`'s
    G1/G2 no-partial-write shape.

    **`epsilon` (#2045 F1).** The comparison is `max(leaf diff) <= epsilon`,
    not raw equality — leaves are flattened via `_leaf_diffs`, so a leaf
    that only exists on one side, or a non-numeric leaf that changed (e.g.
    `identity`'s `anchor` string), always reports `inf` and therefore always
    exceeds any `epsilon`. The default `epsilon=0.0` makes this EXACTLY the
    old equality check for `tolerances` (a diff of 0 on every leaf, or
    refuse) — `tolerances` is quantised (`max(0.15, id_max+0.10)`, a flat
    `4.0`, `max(1.0, rtf*1.5)`), so an exact match IS the correct bar there;
    a re-bless with the same inputs computes byte-identical tolerances.
    `identity`/`loudness_dbfs` are raw stochastic measurements with real
    run-to-run noise (`instruct-baseline.json`'s own `metadata.notes`:
    ~0.0014 identity spread) — an exact-equality guard on THOSE refuses on
    every honest re-bless, which is worse than the #1995 hole this whole
    mechanism exists to close: it trains an operator to reach for
    `GOLDEN_REBLESS_THRESHOLDS=1` on a ROUTINE bless, and that flag also
    covers `tolerances`, so the routine habit re-opens #1995 one flag deep.
    Callers pass a field-specific `epsilon` (`compare.IDENTITY_COSINE_EPSILON`,
    `compare.LOUDNESS_DBFS_EPSILON`) for those two; a within-epsilon move is
    WRITTEN, not refused — the caller is expected to also call
    `describe_measurement_move` and print its result so the move is loud,
    per #2035's Acceptance ("surfaced loudly enough that it cannot pass
    unnoticed"), even though this function itself only decides refuse/accept
    and never prints.

    `existing` is the CURRENTLY COMMITTED dict for `label` (or None when
    there is no committed block at all for it); `computed` is what this
    bless run would write. Pure: the caller reads
    `GOLDEN_REBLESS_THRESHOLDS` from the environment and passes it as
    `allow_rebless_thresholds` — this function never touches os.environ.
    #2035 deliberately reuses this single flag rather than minting a second
    one: `identity`/`loudness_dbfs` live in the same baseline file, are
    guarded by this same function, and are the same *kind* of judgement
    call ("I know this bless run legitimately changed the reference point
    by more than noise") as a `tolerances` change — splitting the escape
    hatch per-field would add a flag without adding a distinct decision.

    Mirrors `bless_guard`'s G1 shape (refuse a silent change, escape via an
    explicit flag) but for a reference figure rather than the transcript.

    A missing `label` block is ambiguous on its own: it is either a genuine
    first bless (nothing recorded yet — the ORIGINAL, and still the common,
    case for `existing is None`) or a PREVIOUSLY blessed baseline that lost
    its `label` key (e.g. a hand-resolved merge conflict) — the exact #2003
    shape, reproduced inside this guard by an earlier revision of this fix.
    `existing is None` alone cannot tell those apart, so the caller passes
    `previously_blessed` — see `test_instruct_golden.py`'s `_bless()` for
    the exact probe and its history (#2045 F1/F5): an early revision read
    `bool(baseline.get("identity"))`, circular for `label="identity"`
    specifically since that field IS one of the three being guarded; the
    next revision narrowed to `bool(baseline.get("rtf"))` alone on the
    theory that `rtf` is never itself a guarded field, which is true but
    still left a SINGLE-key blind spot — a merge conflict is exactly as
    likely to drop `rtf` as `identity`, and losing it alone would fail
    ALL THREE guards open at once, a WIDER blast radius than the bug just
    fixed. The current probe is `any(...)` across all four keys
    (`rtf`/`identity`/`loudness_dbfs`/`tolerances`) — as long as ONE
    survives a corruption, the probe still reads correctly. A
    never-blessed baseline (`previously_blessed=False`) is accepted with no
    flag, same as before; a previously-blessed baseline missing `label`
    (`previously_blessed=True`) now fails CLOSED via the same flag as any
    other reference-figure change."""
    if existing is None:
        if not previously_blessed:
            return None
        if allow_rebless_thresholds:
            return None
        return (
            f"refusing to bless: baseline has been blessed before but its "
            f"'{label}' key is missing (e.g. a hand-resolved merge "
            f"conflict) -- computed {computed!r} would be written blind -- "
            "set GOLDEN_REBLESS_THRESHOLDS=1 to confirm this is intentional"
        )
    diffs = _leaf_diffs(existing, computed)
    max_diff = max(diffs.values()) if diffs else 0.0
    if max_diff <= epsilon:
        return None
    if allow_rebless_thresholds:
        return None
    changed = ", ".join(
        f"{k}: {'inf' if v == math.inf else f'{v:.4f}'}"
        for k, v in sorted(diffs.items(), key=lambda kv: -kv[1])
        if v > 0
    )
    return (
        f"refusing to bless: {label} would move beyond epsilon {epsilon} "
        f"({changed}) -- was {existing!r}, now {computed!r} -- set "
        "GOLDEN_REBLESS_THRESHOLDS=1 to confirm this is intentional"
    )
