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

_SMART_APOSTROPHE = "\u2019"  # RIGHT SINGLE QUOTATION MARK -- written as a Python escape, never a literal glyph (see r_unicode_regex_class memory note)
_POSSESSIVE_RE = re.compile(r"'s\b")
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
    strip possessive 's / stray apostrophes -> replace non-alphanumeric with
    a space -> split. Deliberately NOT `segment-asr-qa.ts`'s `normalizeForWer`
    — no contraction expansion, no integer-to-word spelling (see #1911 §2d:
    under `bless_guard`'s G2 cap, adding those buys zero spare capacity, so
    they are skipped to save ~12 lines and a second copy of production's
    number table)."""
    s = unicodedata.normalize("NFKC", text or "").casefold()
    s = s.replace(_SMART_APOSTROPHE, "'")
    s = _POSSESSIVE_RE.sub("", s)
    s = s.replace("'", "")
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
    silence / the wrong text entirely" check."""
    edits, wer = content_edits(text, fresh)
    recorded_transcript = existing.get("transcript") if existing else None

    if recorded_transcript is None:
        if wer > FIRST_BLESS_MAX_WER:
            return (
                f"first bless refused: WER {wer:.3f} exceeds the gross-garbage "
                f"ceiling {FIRST_BLESS_MAX_WER} (text={text!r} fresh={fresh!r})"
            )
        return None

    if (
        normalize_words(recorded_transcript) != normalize_words(fresh)
        and not allow_rebless_content
    ):
        return (
            "refusing to re-bless: transcript differs from the recorded "
            f"baseline (was {recorded_transcript!r}, now {fresh!r}) -- set "
            "GOLDEN_REBLESS_CONTENT=1 to confirm this is intentional"
        )

    recorded_edits = existing.get("text_edits") if existing else None
    if recorded_edits is not None and edits > recorded_edits + 1:
        return (
            f"refusing to bless: text_edits {edits} would exceed the recorded "
            f"{recorded_edits} + 1 cap"
        )

    return None
