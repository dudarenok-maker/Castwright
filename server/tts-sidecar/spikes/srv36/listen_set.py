"""srv-36 held-out listen-set generator.

Emits a small set of clips (~20) that the operator listens to in order to
validate the render-integrity calibration on a held-out book.  Two tiers are
selected:

  **Severe** — segments whose cosine falls below the ``severe_edge_pctl``
  percentile of the character's clean distribution.  These are the most
  suspicious renders.

  **Band** — segments that fall in the straddle band between the severe edge
  and the ``band_upper_pctl`` percentile of the clean distribution.  These
  are the uncertain tier that the operator's ear resolves.

Selection is capped at *cap* total clips (default 20).  Severe rows fill
slots first (lowest cosine first — worst first), then band rows fill the
remainder (also lowest cosine first).

The IO entry-point ``emit_listen_set`` wraps the pure selector, calls
``extract_listen.extract_clip`` for the wav extraction, and writes a
``manifest.json`` to *out_dir*.

Design choices
--------------
Threshold derivation:
    Per-character: ``severe_edge = np.percentile(clean_cosines, severe_edge_pctl)``
    and ``band_upper = np.percentile(clean_cosines, band_upper_pctl)``.
    This matches the calibrate.py convention exactly.

Unknown characters:
    Any segment whose ``character`` key has no entry in ``per_char_clean_cosines``
    is silently skipped (no centroid → no meaningful threshold).

Manifest row keys:
    ``character``, ``chapter``, ``sentence_id``, ``cosine``, ``predicted_verdict``
    (values: ``"severe"`` | ``"band"``).

Wav extraction:
    Reuses ``extract_listen.extract_clip`` from the spike.  The wav files are named
    ``<character>_<verdict>_cos<cosine>_<sentence_id[:12]>.wav``.

CLI:
    python -m spikes.srv36.listen_set \\
        --book-dir /path/to/audio \\
        --calibration-report /path/to/calibration-report.json \\
        --out-dir /path/to/listen-set
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any

import numpy as np


# ---------------------------------------------------------------------------
# Pure, testable selection core — numpy only, no audio/weights
# ---------------------------------------------------------------------------

def select_listen_set(
    scored_segments: list[dict[str, Any]],
    per_char_clean_cosines: dict[str, list[float]],
    cutoffs: dict[str, Any],
    cap: int = 20,
) -> list[dict[str, Any]]:
    """Select the listen-set from scored segments.

    Parameters
    ----------
    scored_segments:
        List of segment dicts.  Required keys:
            character     str   — character id
            chapter       str   — chapter stem / identifier
            sentence_id   str   — stable sentence identifier
            cosine        float — cosine-to-centroid for this segment
        Optional keys ignored (e.g. ``duration_sec``).

    per_char_clean_cosines:
        ``{character_id: [cosine, …]}`` — clean cosines from the *calibration*
        book (used to derive the per-character thresholds).

    cutoffs:
        Dict with at minimum:
            severe_edge_pctl  int — percentile below which cosine is "severe"
            band_upper_pctl   int — percentile above which cosine is out of band

    cap:
        Maximum number of clips to return.  Severe rows fill first.

    Returns
    -------
    List of manifest row dicts, each with keys:
        character, chapter, sentence_id, cosine, predicted_verdict
    Ordered: severe rows (lowest cosine first) then band rows (lowest cosine first).
    Total length <= cap.

    Notes
    -----
    This function intentionally takes ``per_char_clean_cosines`` as a separate
    parameter (rather than the 3-arg illustrative shape in the spec).  Scored
    segments don't carry the full clean distribution needed to compute per-character
    percentile thresholds, so the clean cosines must be passed in explicitly.
    """
    if cap <= 0:
        return []

    severe_pctl: int = int(cutoffs["severe_edge_pctl"])
    band_pctl: int = int(cutoffs["band_upper_pctl"])

    # Pre-compute per-character thresholds from the clean distribution
    char_thresholds: dict[str, tuple[float, float]] = {}
    for char, clean in per_char_clean_cosines.items():
        if not clean:
            continue
        arr = np.asarray(clean, np.float64)
        severe_thr = float(np.percentile(arr, severe_pctl))
        band_thr = float(np.percentile(arr, band_pctl))
        char_thresholds[char] = (severe_thr, band_thr)

    severe_rows: list[dict[str, Any]] = []
    band_rows: list[dict[str, Any]] = []

    for seg in scored_segments:
        char = seg.get("character", "")
        if char not in char_thresholds:
            continue
        severe_thr, band_thr = char_thresholds[char]
        cos = float(seg["cosine"])

        if cos < severe_thr:
            verdict = "severe"
        elif cos <= band_thr:
            verdict = "band"
        else:
            continue  # above the band: not interesting

        row: dict[str, Any] = {
            "character": char,
            "chapter": seg.get("chapter", ""),
            "sentence_id": seg.get("sentence_id", ""),
            "cosine": cos,
            "predicted_verdict": verdict,
        }
        if verdict == "severe":
            severe_rows.append(row)
        else:
            band_rows.append(row)

    # Sort each tier: lowest cosine first (most suspicious first)
    severe_rows.sort(key=lambda r: r["cosine"])
    band_rows.sort(key=lambda r: r["cosine"])

    # Fill cap: severe first, band fills remainder
    selected = severe_rows[:cap]
    remaining = cap - len(selected)
    if remaining > 0:
        selected.extend(band_rows[:remaining])

    return selected


# ---------------------------------------------------------------------------
# IO entry-point — wav extraction + manifest write
# ---------------------------------------------------------------------------

def emit_listen_set(
    book_dir: str,
    cutoffs: dict[str, Any],
    out_dir: str,
    segments_glob: str = "*.segments.json",
    sr: int = 16000,
    cap: int = 20,
) -> list[dict[str, Any]]:
    """Emit the operator's listen-set for a held-out book.

    Scores each segment against its per-character centroid (built from the book's
    own gate-OK segments), selects the listen-set via ``select_listen_set``, extracts
    wav clips via ``ffmpeg``, and writes ``manifest.json`` to *out_dir*.

    Parameters
    ----------
    book_dir:
        Directory containing ``.segments.json`` + ``.mp3`` chapter pairs.
    cutoffs:
        Calibrated cutoff constants (from ``calibrate.fit_cutoffs``).
        Required keys: ``severe_edge_pctl``, ``band_upper_pctl``.
    out_dir:
        Directory to write wav clips and ``manifest.json`` into.
    segments_glob:
        Glob pattern matching the segments files (default ``*.segments.json``).
    sr:
        Sample rate for ffmpeg extraction (default 16000 Hz).
    cap:
        Maximum number of clips to extract (default 20).

    Returns
    -------
    The manifest (list of row dicts) that was written to ``manifest.json``.

    Notes
    -----
    Requires ``ffmpeg`` on PATH and ``speechbrain`` weights (via ``embed_pcm``).
    Skips segments shorter than ``cutoffs.get('min_duration_sec', 2.0)`` seconds.
    """
    import glob as _glob

    from spikes.srv36.probe_real_library import embed_book_segments
    from spikes.srv36.extract_listen import extract_clip

    Path(out_dir).mkdir(parents=True, exist_ok=True)
    floor = float(cutoffs.get("min_duration_sec", 2.0))

    # Build per-character centroids and collect per-segment cosines for THIS book
    # embed_book_segments returns {char: [{sentence_id, cosine}]} using the book's
    # own clean segments — this is the "held-out" scoring path.
    per_char_entries = embed_book_segments(book_dir, segments_glob, sr=sr, floor=floor)

    # Flatten to scored_segments + collect per_char_clean_cosines from THIS book
    per_char_clean_cosines: dict[str, list[float]] = {}
    scored_segments: list[dict[str, Any]] = []

    # We need chapter + sentence_id for each entry.  Re-walk the segments files to
    # recover those fields (embed_book_segments returns only sentence_id + cosine).
    # Build a sentence_id → {chapter, start_sec, end_sec} lookup first.
    sid_meta: dict[str, dict] = {}
    for segf in sorted(_glob.glob(str(Path(book_dir) / segments_glob))):
        if ".previous." in segf:
            continue
        try:
            data = json.loads(Path(segf).read_text(encoding="utf-8"))
        except Exception:
            continue
        chapter_stem = Path(segf).name.replace(".segments.json", "")
        for seg in data.get("segments", []):
            sids = seg.get("sentenceIds") or []
            sid = "-".join(str(s) for s in sids) if sids else None
            if sid:
                sid_meta[sid] = {
                    "chapter": chapter_stem,
                    "start_sec": seg.get("startSec"),
                    "end_sec": seg.get("endSec"),
                    "character": seg.get("characterId") or seg.get("character", ""),
                }

    for char, entries in per_char_entries.items():
        cosines = [e["cosine"] for e in entries]
        per_char_clean_cosines[char] = cosines
        for entry in entries:
            sid = entry["sentence_id"]
            meta = sid_meta.get(sid, {})
            scored_segments.append({
                "character": char,
                "chapter": meta.get("chapter", ""),
                "sentence_id": sid,
                "cosine": entry["cosine"],
                "start_sec": meta.get("start_sec"),
                "end_sec": meta.get("end_sec"),
            })

    manifest = select_listen_set(scored_segments, per_char_clean_cosines, cutoffs, cap=cap)

    # Extract wav clips
    for row in manifest:
        sid = row["sentence_id"]
        meta = sid_meta.get(sid, {})
        start_sec = meta.get("start_sec")
        end_sec = meta.get("end_sec")
        chapter = row.get("chapter") or meta.get("chapter", "unknown")
        audio_path = str(Path(book_dir) / (chapter + ".mp3"))
        cos_str = f"{row['cosine']:.3f}"
        sid_slug = str(sid)[:12].replace("/", "-").replace("\\", "-")
        out_name = f"{row['character']}_{row['predicted_verdict']}_cos{cos_str}_{sid_slug}.wav"
        out_path = str(Path(out_dir) / out_name)
        row["wav_path"] = out_path

        if start_sec is not None and end_sec is not None and Path(audio_path).exists():
            ok = extract_clip(audio_path, float(start_sec), float(end_sec), out_path, sr=sr)
            if not ok:
                row.pop("wav_path", None)

    manifest_path = str(Path(out_dir) / "manifest.json")
    Path(manifest_path).write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    print(f"Listen-set written to: {out_dir}  ({len(manifest)} clips)")
    return manifest


# ---------------------------------------------------------------------------
# CLI entry-point
# ---------------------------------------------------------------------------

def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(
        description="Emit the held-out listen-set for a book using calibrated cutoffs.",
    )
    parser.add_argument("--book-dir", required=True,
                        help="Directory containing chapter audio + segments.json files")
    parser.add_argument("--calibration-report", required=True,
                        help="Path to the JSON calibration report (from calibrate.py --output)")
    parser.add_argument("--out-dir", required=True,
                        help="Directory to write wav clips and manifest.json into")
    parser.add_argument("--segments-glob", default="*.segments.json",
                        help="Glob pattern for segments files (default: *.segments.json)")
    parser.add_argument("--sr", type=int, default=16000,
                        help="Sample rate for extraction (default: 16000)")
    parser.add_argument("--cap", type=int, default=20,
                        help="Maximum number of clips to extract (default: 20)")
    args = parser.parse_args(argv)

    report = json.loads(Path(args.calibration_report).read_text(encoding="utf-8"))
    cutoffs = report["cutoffs"]
    print(f"Loaded cutoffs: severe_edge_pctl={cutoffs['severe_edge_pctl']}, "
          f"band_upper_pctl={cutoffs['band_upper_pctl']}, "
          f"min_duration_sec={cutoffs['min_duration_sec']}")

    emit_listen_set(
        book_dir=args.book_dir,
        cutoffs=cutoffs,
        out_dir=args.out_dir,
        segments_glob=args.segments_glob,
        sr=args.sr,
        cap=args.cap,
    )


if __name__ == "__main__":
    main()
