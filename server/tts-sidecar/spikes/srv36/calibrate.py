"""srv-36 calibration harness: fit per-book cutoff constants from labelled clips.

Design choices
--------------
severe_edge_pctl
    Scan candidate percentiles 1..13 on the pooled per-character clean-cosine
    distribution.  For each candidate p, compute the threshold T = percentile(p)
    and evaluate the operating-point error rate as (FAR_at_T + FRR_at_T) / 2,
    where FAR = fraction of labelled_drift cosines >= T and FRR = fraction of
    labelled_clean cosines < T.  Pick the p that yields the lowest error rate.

    Design intent: this is a percentile grid-scan over the clean distribution,
    NOT a full EER curve.  The output is a portable percentile (meaningful
    across books), not an absolute cosine threshold.  metrics.eer() finds the
    true equal-error-rate threshold across ALL possible thresholds; here we
    deliberately restrict candidates to the clean-distribution percentile grid
    so the result is book-portable.  Fallback to p=5 when labelled_drift is
    empty or labelled_clean is empty (nothing to separate).

band_upper_pctl
    Set to severe_edge_pctl + 2, clamped to [severe_edge_pctl+1, 15].  Because
    the candidate scan is capped at 13, severe_edge_pctl <= 13, so band_upper
    (severe+2) is at most 15 and the strictly-greater invariant always holds.

min_duration_sec
    Derived from cosine-variance-vs-clip-length on the labelled clips.  Bin the
    clips by duration into four bands: [0,1), [1,2), [2,3), [3,∞).  Compute the
    standard deviation of cosine-to-centroid in each bin.  Return the lower edge
    of the first bin whose std drops below LEN_STD_THRESHOLD (imported from
    aggregates as LEN_STD_OK).  If no bin drops below the threshold (too few
    clips or high variance everywhere), fall back to the ECAPA reliability floor
    DEFAULT_FLOOR_SEC = 2.0.  If the [0,1) bin clears the threshold its lower
    edge is 0.0 — meaningless as a floor — so DEFAULT_FLOOR_SEC is returned
    instead (the bin label for display is 0.0 but the function never returns it).

CLI
---
Usage::
    python -m spikes.srv36.calibrate \\
        --book-dir   /path/to/book/audio \\
        --segments-glob "*.segments.json" \\
        --labelled   /path/to/labelled.json \\
        --output     /path/to/calibration-report.json

The labelled JSON is a list of dicts matching the clip contract used by
``fit_cutoffs`` (keys: ``sentence_id``, ``cosine``, ``duration_sec``, ``label``).
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

import numpy as np

from spikes.srv36.aggregates import LEN_STD_OK
from spikes.srv36.metrics import spread_stats

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

#: Candidate percentiles scanned for the severe-edge cutoff.
#: Capped at 13 so band_upper (severe+2) is always <= 15 and strictly above.
_PCTL_CANDIDATES: list[int] = list(range(1, 14))   # 1..13 inclusive

#: LEN_STD_THRESHOLD: cosine std below this = "stable enough to score".
#: Single source of truth: imported from aggregates.LEN_STD_OK.
LEN_STD_THRESHOLD: float = LEN_STD_OK

#: ECAPA reliability floor used as a fallback when we can't derive one.
DEFAULT_FLOOR_SEC: float = 2.0

#: Duration bin edges (seconds).  The lower edge of the first bin whose std
#: falls below LEN_STD_THRESHOLD is returned as min_duration_sec.
_DURATION_BINS: list[float] = [0.0, 1.0, 2.0, 3.0, float("inf")]
#: Lower edges of the four duration bands: [0,1), [1,2), [2,3), [3,∞).
#: The [0,1) band has true lower edge 0.0 — if it clears the threshold,
#: DEFAULT_FLOOR_SEC is returned instead (a 0.0 floor is meaningless).
_DURATION_BIN_LABELS: list[float] = [0.0, 1.0, 2.0, 3.0]

#: Default severe-edge percentile when there are no labelled drift clips.
_DEFAULT_PCTL: int = 5


# ---------------------------------------------------------------------------
# Pure core — testable on synthetic data (numpy only, no model/weights)
# ---------------------------------------------------------------------------

def fit_cutoffs(
    per_char_clean_cosines: dict[str, list[float]],
    labelled_clips: list[dict[str, Any]],
) -> dict[str, Any]:
    """Fit calibration constants from per-character clean cosines + labelled clips.

    Parameters
    ----------
    per_char_clean_cosines:
        ``{character_id: [cosine, …]}`` — clean (gate-OK) cosines pooled from
        the book's real renders.  Used to anchor the percentile thresholds.
    labelled_clips:
        List of clip dicts.  Required keys::

            sentence_id   str   — stable segment identifier (NOT a timestamp)
            cosine        float — cosine-to-centroid for this clip
            duration_sec  float — clip length in seconds
            label         str   — "clean" | "drift"

    Returns
    -------
    dict with keys:
        severe_edge_pctl  int   — percentile on the clean distribution below
                                  which a cosine is flagged "severe"
        band_upper_pctl   int   — upper edge of the uncertain "band" tier
        min_duration_sec  float — minimum clip length for reliable scoring
        N                 int   — total labelled clips consumed
        K                 int   — total clean cosines consumed
    """
    # --- Pool clean cosines ---------------------------------------------------
    all_clean: list[float] = []
    for cosines in per_char_clean_cosines.values():
        all_clean.extend(cosines)
    K = len(all_clean)

    # --- Split labelled clips by label ----------------------------------------
    lab_clean = [c["cosine"] for c in labelled_clips if c.get("label") == "clean"]
    lab_drift = [c["cosine"] for c in labelled_clips if c.get("label") == "drift"]
    N = len(labelled_clips)

    # --- Derive severe_edge_pctl ----------------------------------------------
    if all_clean and lab_clean and lab_drift:
        clean_arr = np.asarray(all_clean, np.float64)
        best_pctl = _DEFAULT_PCTL
        best_op_eer = 1.0
        for p in _PCTL_CANDIDATES:
            thr = float(np.percentile(clean_arr, p))
            # Operating-point FAR/FRR grid-scan — intentional design.
            # We want the output as a portable percentile, not an absolute
            # cosine threshold.  The percentile grid restricts candidates to
            # the clean distribution, making the result book-portable.
            # At threshold thr: a clip is "accepted" if cosine >= thr.
            # FAR = fraction of drift cosines that pass (>= thr) — false alarms
            # FRR = fraction of clean cosines that fail (< thr) — missed genuines
            far_at_p = float(np.mean(np.asarray(lab_drift, np.float64) >= thr))
            frr_at_p = float(np.mean(np.asarray(lab_clean, np.float64) < thr))
            op_eer = (far_at_p + frr_at_p) / 2.0
            if op_eer < best_op_eer:
                best_op_eer = op_eer
                best_pctl = p
        severe_edge_pctl = best_pctl
    else:
        # Fallback: no labelled drift or no clean — use the conventional 5th-pctl floor
        severe_edge_pctl = _DEFAULT_PCTL

    # --- band_upper_pctl = severe + 2, clamped --------------------------------
    # severe_edge_pctl <= 13 (scan cap), so severe+2 <= 15 always holds.
    band_upper_pctl = min(severe_edge_pctl + 2, max(_PCTL_CANDIDATES) + 2)
    # Ensure strictly above severe_edge_pctl (guaranteed by cap, but belt-and-braces)
    if band_upper_pctl <= severe_edge_pctl:
        band_upper_pctl = severe_edge_pctl + 1

    # --- Derive min_duration_sec from cosine-variance-vs-clip-length ----------
    min_duration_sec = _derive_min_duration(labelled_clips)

    return {
        "severe_edge_pctl": int(severe_edge_pctl),
        "band_upper_pctl": int(band_upper_pctl),
        "min_duration_sec": float(min_duration_sec),
        "N": int(N),
        "K": int(K),
    }


def _derive_min_duration(labelled_clips: list[dict[str, Any]]) -> float:
    """Return the minimum clip duration at which cosine variance stabilises.

    Bins clips by duration into bands [0,1), [1,2), [2,3), [3,∞).  Within each
    non-empty bin computes std(cosines).  Returns the lower edge of the first
    bin whose std drops below LEN_STD_THRESHOLD.  The [0,1) bin has lower edge
    0.0 which is meaningless as a scoring floor, so DEFAULT_FLOOR_SEC is
    returned instead.  Fallback: DEFAULT_FLOOR_SEC.
    """
    if not labelled_clips:
        return DEFAULT_FLOOR_SEC

    # Build bins: {bin_lower_edge: [cosines]}
    bins: dict[float, list[float]] = {lb: [] for lb in _DURATION_BIN_LABELS}
    edges = _DURATION_BINS       # [0.0, 1.0, 2.0, 3.0, inf]
    labels = _DURATION_BIN_LABELS   # [0.0, 1.0, 2.0, 3.0]

    for clip in labelled_clips:
        dur = float(clip.get("duration_sec", 0.0))
        cos = clip.get("cosine")
        if cos is None:
            continue
        cos = float(cos)
        for i, (lo, hi) in enumerate(zip(edges[:-1], edges[1:])):
            if lo <= dur < hi:
                bins[labels[i]].append(cos)
                break

    # Scan bins in ascending order, find first with std < LEN_STD_THRESHOLD
    for lb in sorted(bins.keys()):
        vals = bins[lb]
        if len(vals) >= 2:
            std = float(np.std(vals))
            if std < LEN_STD_THRESHOLD:
                # lb == 0.0 means the [0,1) bin — a 0.0 floor is meaningless;
                # return the ECAPA reliability floor instead.
                return DEFAULT_FLOOR_SEC if lb == 0.0 else float(lb)

    # No bin met the threshold — fall back to ECAPA reliability floor
    return DEFAULT_FLOOR_SEC


# ---------------------------------------------------------------------------
# Per-character spread report
# ---------------------------------------------------------------------------

def _char_spreads(per_char_clean_cosines: dict[str, list[float]]) -> dict[str, dict]:
    result = {}
    for char, cosines in per_char_clean_cosines.items():
        if cosines:
            result[char] = spread_stats(cosines)
    return result


# ---------------------------------------------------------------------------
# CLI entry — embeds a book's renders and writes the calibration report
# ---------------------------------------------------------------------------

def _embed_book(book_dir: str, segments_glob: str, sr: int = 16000) -> dict[str, list[dict]]:
    """Embed all clean segments of a book and return per-char sentence entries.

    Returns ``{character_id: [{"sentence_id": str, "cosine": float}, …]}`` —
    keyed on stable sentenceIds (the Phase-0 fix), NOT chapter/timestamp order.

    This function requires speechbrain + ffmpeg (not imported at module level so
    the pure fit_cutoffs tests can import calibrate.py without weights).
    """
    import glob as _glob
    from spikes.srv36.probe_real_library import embed_book_segments

    return embed_book_segments(book_dir, segments_glob, sr=sr)


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(
        description="Fit render-integrity cutoffs from a real book's renders.",
    )
    parser.add_argument("--book-dir", required=True, help="Directory containing chapter audio + segments.json files")
    parser.add_argument("--segments-glob", default="*.segments.json", help="Glob pattern for segments files (default: *.segments.json)")
    parser.add_argument("--labelled", default=None, help="Path to JSON file with labelled clips (list of {sentence_id, cosine, duration_sec, label})")
    parser.add_argument("--output", required=True, help="Path to write the JSON calibration report")
    parser.add_argument("--sr", type=int, default=16000, help="Sample rate for ECAPA embedding (default: 16000)")
    args = parser.parse_args(argv)

    print(f"Embedding book: {args.book_dir} ...")
    per_char_entries = _embed_book(args.book_dir, args.segments_glob, args.sr)

    # Build per_char_clean_cosines for fit_cutoffs (flat cosine lists)
    per_char_clean_cosines: dict[str, list[float]] = {
        ch: [e["cosine"] for e in entries]
        for ch, entries in per_char_entries.items()
    }
    total_segs = sum(len(v) for v in per_char_clean_cosines.values())
    print(f"  Embedded {total_segs} clean segments across {len(per_char_clean_cosines)} characters.")

    labelled_clips: list[dict] = []
    if args.labelled:
        labelled_clips = json.loads(Path(args.labelled).read_text(encoding="utf-8"))
        print(f"  Loaded {len(labelled_clips)} labelled clips from {args.labelled}")

    cutoffs = fit_cutoffs(per_char_clean_cosines, labelled_clips)
    char_spreads = _char_spreads(per_char_clean_cosines)

    report = {
        "cutoffs": cutoffs,
        "per_char_spreads": char_spreads,
        "per_char_sentence_entries": {
            ch: entries for ch, entries in per_char_entries.items()
        },
        "book_dir": str(args.book_dir),
        "labelled_path": args.labelled,
    }
    Path(args.output).write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(f"\nCalibration report written to: {args.output}")
    print(f"  severe_edge_pctl = {cutoffs['severe_edge_pctl']}")
    print(f"  band_upper_pctl  = {cutoffs['band_upper_pctl']}")
    print(f"  min_duration_sec = {cutoffs['min_duration_sec']:.2f}s")
    print(f"  N (labelled)     = {cutoffs['N']}")
    print(f"  K (clean cosines)= {cutoffs['K']}")


if __name__ == "__main__":
    # Allow running as: python -m spikes.srv36.calibrate --book-dir ...
    main()
