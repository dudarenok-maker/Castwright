"""srv-36 calibration harness: fit per-book cutoff constants from labelled clips.

Design choices
--------------
severe_edge_pctl
    Scan candidate percentiles 1..15 on the pooled per-character clean-cosine
    distribution.  For each candidate p, compute the threshold T = percentile(p)
    on the clean pool, then evaluate EER(genuine=labelled_clean_cosines,
    impostor=labelled_drift_cosines) using T as the operating point.  Pick the p
    that yields the lowest EER (i.e. best separates labelled drift from clean).
    Fallback to p=5 when labelled_drift is empty or labelled_clean is empty
    (nothing to separate — use the conventional 5th-percentile floor).

band_upper_pctl
    Set to severe_edge_pctl + 2, clamped to [severe_edge_pctl+1, 15].  This
    creates a narrow "uncertain band" tier between the floor and the severe edge,
    matching the F3/F4 tier structure in the spike.

min_duration_sec
    Derived from cosine-variance-vs-clip-length on the labelled clips.  Bin the
    clips by duration into four bands: <1s, 1–2s, 2–3s, >=3s.  Compute the
    standard deviation of cosine-to-centroid in each bin.  Return the lower edge
    of the first bin whose std drops below LEN_STD_THRESHOLD (0.07, consistent
    with f5_length_coverage in aggregates.py).  If no bin drops below the
    threshold (too few clips or high variance everywhere), fall back to the ECAPA
    reliability floor DEFAULT_FLOOR_SEC = 2.0.

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

from spikes.srv36.metrics import eer, spread_stats

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

#: Candidate percentiles scanned for the severe-edge cutoff.
_PCTL_CANDIDATES: list[int] = list(range(1, 16))   # 1..15 inclusive

#: LEN_STD_THRESHOLD: cosine std below this = "stable enough to score".
#: Matches aggregates.f5_length_coverage LEN_STD_OK.
LEN_STD_THRESHOLD: float = 0.07

#: ECAPA reliability floor used as a fallback when we can't derive one.
DEFAULT_FLOOR_SEC: float = 2.0

#: Duration bin edges (seconds).  The lower edge of the first bin whose std
#: falls below LEN_STD_THRESHOLD is returned as min_duration_sec.
_DURATION_BINS: list[float] = [0.0, 1.0, 2.0, 3.0, float("inf")]
_DURATION_BIN_LABELS: list[float] = [0.5, 1.0, 2.0, 3.0]   # representative lower edges

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
        best_eer = 1.0
        for p in _PCTL_CANDIDATES:
            thr = float(np.percentile(clean_arr, p))
            # EER: genuine = labelled clean cosines, impostor = labelled drift cosines
            # At threshold thr: a clip is "accepted" if cosine >= thr.
            # FAR = fraction of drift cosines that pass (>= thr) — false alarms
            # FRR = fraction of clean cosines that fail (< thr) — missed genuines
            #
            # Note: metrics.eer() convention: genuine > threshold = accept.
            # We want to flag low cosines; so "impostor" = drift (low cosines).
            e = eer(genuine=lab_clean, impostor=lab_drift)
            # Evaluate the operating-point EER at this candidate threshold
            far_at_p = float(np.mean(np.asarray(lab_drift, np.float64) >= thr))
            frr_at_p = float(np.mean(np.asarray(lab_clean, np.float64) < thr))
            op_eer = (far_at_p + frr_at_p) / 2.0
            if op_eer < best_eer:
                best_eer = op_eer
                best_pctl = p
        severe_edge_pctl = best_pctl
    else:
        # Fallback: no labelled drift or no clean — use the conventional 5th-pctl floor
        severe_edge_pctl = _DEFAULT_PCTL

    # --- band_upper_pctl = severe + 2, clamped --------------------------------
    band_upper_pctl = min(severe_edge_pctl + 2, max(_PCTL_CANDIDATES))
    # Ensure strictly above severe_edge_pctl
    if band_upper_pctl <= severe_edge_pctl:
        band_upper_pctl = min(severe_edge_pctl + 1, max(_PCTL_CANDIDATES))

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
    bin whose std drops below LEN_STD_THRESHOLD.  Fallback: DEFAULT_FLOOR_SEC.
    """
    if not labelled_clips:
        return DEFAULT_FLOOR_SEC

    # Build bins: {bin_lower_edge: [cosines]}
    bins: dict[float, list[float]] = {lb: [] for lb in _DURATION_BIN_LABELS}
    edges = _DURATION_BINS       # [0.0, 1.0, 2.0, 3.0, inf]
    labels = _DURATION_BIN_LABELS   # [0.5, 1.0, 2.0, 3.0]

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
                return float(lb) if lb > 0.0 else DEFAULT_FLOOR_SEC

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

def _embed_book(book_dir: str, segments_glob: str, sr: int = 16000) -> dict[str, list[float]]:
    """Embed all clean segments of a book and return per-char cosine distributions.

    Re-keyed on sentenceIds (not timestamps) — the Phase-0 fix.

    This function requires speechbrain + ffmpeg (not imported at module level so
    the pure fit_cutoffs tests can import calibrate.py without weights).
    """
    import glob as _glob
    import subprocess
    from pathlib import Path

    # Lazy imports so the module stays importable without weights
    from spikes.srv36.embed import embed_pcm
    from spikes.srv36.metrics import cosine, centroid
    from spikes.srv36.segments_io import slice_pcm
    from spikes.srv36.gates import is_gate_flagged

    FLOOR = DEFAULT_FLOOR_SEC
    per_char_embeds: dict[str, list] = {}
    per_char_cosines: dict[str, list[float]] = {}

    pcm_cache: dict[str, bytes] = {}

    def _decode(audio_path: str) -> bytes:
        if audio_path not in pcm_cache:
            pcm_cache[audio_path] = subprocess.run(
                ["ffmpeg", "-v", "error", "-i", audio_path,
                 "-ac", "1", "-ar", str(sr), "-f", "s16le", "-"],
                capture_output=True, check=True,
            ).stdout
        return pcm_cache[audio_path]

    for segf in _glob.glob(str(Path(book_dir) / segments_glob)):
        if ".previous." in segf:
            continue
        try:
            data = json.loads(Path(segf).read_text(encoding="utf-8"))
        except Exception:
            continue

        audio_path = segf.replace(".segments.json", ".mp3")
        if not Path(audio_path).exists():
            continue

        try:
            pcm = _decode(audio_path)
        except Exception:
            continue

        for seg in data.get("segments", []):
            ch = seg.get("characterId") or seg.get("character")
            if not ch:
                continue
            # Re-key on sentenceId (stable), NOT timestamps (shift every run)
            sentence_id = seg.get("sentenceId") or seg.get("id")
            st = seg.get("startSec")
            en = seg.get("endSec")
            if st is None or en is None or (en - st) < FLOOR:
                continue
            if is_gate_flagged(seg):
                continue

            spcm = slice_pcm(pcm, sr, float(st), float(en))
            try:
                vec = embed_pcm(spcm, sr)
            except Exception:
                continue
            per_char_embeds.setdefault(ch, []).append(vec)

    # Build centroids + cosines
    from spikes.srv36.metrics import centroid as _centroid
    for ch, vecs in per_char_embeds.items():
        if len(vecs) < 3:
            continue
        cen = _centroid(vecs)
        per_char_cosines[ch] = [cosine(cen, v) for v in vecs]

    return per_char_cosines


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
    per_char_clean_cosines = _embed_book(args.book_dir, args.segments_glob, args.sr)
    print(f"  Embedded {sum(len(v) for v in per_char_clean_cosines.values())} clean segments "
          f"across {len(per_char_clean_cosines)} characters.")

    labelled_clips: list[dict] = []
    if args.labelled:
        labelled_clips = json.loads(Path(args.labelled).read_text(encoding="utf-8"))
        print(f"  Loaded {len(labelled_clips)} labelled clips from {args.labelled}")

    cutoffs = fit_cutoffs(per_char_clean_cosines, labelled_clips)
    char_spreads = _char_spreads(per_char_clean_cosines)

    report = {
        "cutoffs": cutoffs,
        "per_char_spreads": char_spreads,
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
