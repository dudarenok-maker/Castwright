"""crossbook_measure.py — on-box measurement orchestration for the srv-36
Phase-2 cross-book spike. Operator-run (needs ffmpeg + the speechbrain weights,
and the live sidecar for G0). NOT unit-tested: the pure scoring it composes lives
in crossbook.py (tested); this layer is the disk/audio/sidecar I/O.

Pipeline per gate: collect per-(voiceUuid, book) ECAPA vectors from the
re-rendered Keeper books (reusing the proven decode->slice->embed loop), then
feed the tested crossbook helpers, then write results/crossbook_gN.json matching
GATE_EXPECTED_KEYS so `crossbook_run.py --report` can assemble the verdict.

Run via crossbook_run.py: `python -m spikes.srv36.crossbook_run <BOOKS_ROOT> --g1` etc.
"""
from __future__ import annotations
import json
import subprocess
from pathlib import Path

import numpy as np

from spikes.srv36.embed import embed_pcm
from spikes.srv36.metrics import centroid, cosine
from spikes.srv36.segments_io import slice_pcm
from spikes.srv36.gates import is_gate_flagged
from spikes.srv36.voice_index import iter_series_books, resolve_voice_uuid
from spikes.srv36 import crossbook as cb

SR = 16000
FLOOR = 3.0  # min segment seconds (matches the spec's duration floor)
RESULTS = Path(__file__).resolve().parent / "results"


# --------------------------------------------------------------------------
# Collection — per-(voiceUuid, book) clean-render vectors from disk
# --------------------------------------------------------------------------

def _decode(audio_path: str, cache: dict) -> bytes:
    if audio_path not in cache:
        cache[audio_path] = subprocess.run(
            ["ffmpeg", "-v", "error", "-i", audio_path,
             "-ac", "1", "-ar", str(SR), "-f", "s16le", "-"],
            capture_output=True, check=True,
        ).stdout
    return cache[audio_path]


def collect_book_vectors(book_dir: str, cast: dict, floor: float = FLOOR) -> dict:
    """Embed every gate-OK, >=floor-second segment of one rendered book, keyed by
    the character's resolved voiceUuid (cast.json join). Returns
    {voiceUuid: {"vecs": [np.ndarray], "meta": [{chapter, sentence_id, start, end}]}}.
    Mirrors probe_real_library.embed_book_segments but returns RAW vectors (needed
    for cross-book centroid comparison), keyed by voiceUuid not characterId."""
    pcm_cache: dict = {}
    out: dict = {}
    for segf in sorted(Path(book_dir).glob("*.segments.json")):
        if ".previous." in segf.name:
            continue
        try:
            data = json.loads(segf.read_text(encoding="utf-8"))
        except Exception:
            continue
        mp3 = str(segf).replace(".segments.json", ".mp3")
        if not Path(mp3).exists():
            continue
        chapter = segf.name.replace(".segments.json", "")
        try:
            pcm = _decode(mp3, pcm_cache)
        except Exception:
            continue
        for seg in data.get("segments", []):
            cid = seg.get("characterId") or seg.get("character")
            if not cid:
                continue
            sids = seg.get("sentenceIds") or []
            sentence_id = "-".join(str(s) for s in sids) if sids else None
            st, en = seg.get("startSec"), seg.get("endSec")
            if sentence_id is None or st is None or en is None or (en - st) < floor:
                continue
            if is_gate_flagged(seg):
                continue
            vu = resolve_voice_uuid(cid, cast)
            if not vu:
                continue
            try:
                vec = embed_pcm(slice_pcm(pcm, SR, float(st), float(en)), SR)
            except Exception:
                continue
            rec = out.setdefault(vu, {"vecs": [], "meta": []})
            rec["vecs"].append(vec)
            rec["meta"].append({"chapter": chapter, "sentence_id": sentence_id,
                                 "start": float(st), "end": float(en)})
    return out


def collect_series(books_root: str, series: str | None = None) -> dict:
    """Walk the library and collect per-book vectors for one series (or all).
    Returns {bookId: {voiceUuid: {"vecs": [...], "meta": [...]}}}."""
    by_book: dict = {}
    for b in iter_series_books(books_root):
        if series and b["series"] != series:
            continue
        cast_path = Path(b["cast_path"])
        cast = json.loads(cast_path.read_text("utf-8")) if cast_path.exists() else {}
        by_book[b["bookId"]] = collect_book_vectors(str(Path(b["segments_path"]).parent), cast)
    return by_book


def _write(name: str, payload: dict) -> dict:
    RESULTS.mkdir(parents=True, exist_ok=True)
    (RESULTS / f"crossbook_{name}.json").write_text(json.dumps(payload, indent=2), "utf-8")
    return payload


def _per_key_per_book(by_book: dict) -> dict:
    """{voiceUuid: {bookId: [vecs]}} from {bookId: {voiceUuid: {vecs,...}}}."""
    out: dict = {}
    for book_id, by_key in by_book.items():
        for vu, rec in by_key.items():
            out.setdefault(vu, {})[book_id] = rec["vecs"]
    return out


def _recurring_keys(by_book: dict) -> set:
    counts: dict = {}
    for by_key in by_book.values():
        for vu in by_key:
            counts[vu] = counts.get(vu, 0) + 1
    return {vu for vu, n in counts.items() if n >= 2}


# --------------------------------------------------------------------------
# Gate runners — each writes results/crossbook_gN.json
# --------------------------------------------------------------------------

def run_g1(by_book: dict, floor_std: float) -> dict:
    """G1 — median genuine-voice cross-book drift, in G0-floor-std units."""
    out = cb.aggregate_drift_stds(_per_key_per_book(by_book), floor_std)
    out["floor_std_used"] = floor_std
    return _write("g1", out)


def run_g2(by_book: dict, audition_centroids: dict) -> dict:
    """G2 — seed divergence + per-voice cross-book spread. audition_centroids:
    {voiceUuid: centroid} (from G0's K audition renders). central drives Branch
    A-vs-B; spread sets the (single-series, provisional) sanity-gate band."""
    ppb = _per_key_per_book(by_book)
    centrals, spreads, per_key = [], [], {}
    for vu, per_book in ppb.items():
        aud = audition_centroids.get(vu)
        if aud is None:
            continue
        book_cens = [centroid(v) for v in per_book.values() if len(v)]
        if len(book_cens) < 1:
            continue
        sd = cb.seed_divergence(aud, book_cens)
        per_key[vu] = sd
        centrals.append(sd["central"])
        spreads.append(sd["spread"])
    return _write("g2", {
        "central": cb._median(centrals), "spread": cb._median(spreads),
        "per_key": per_key, "single_series_provisional": True,
    })


def run_g6(by_book: dict, held_out_book: str | None = None) -> dict:
    """G6 — out-of-sample per-line separability on a held-out book: each held-out
    line scored vs its own-key anchor (built from the OTHER books) vs other keys."""
    book_ids = list(by_book)
    if len(book_ids) < 2:
        return _write("g6", {"separation_auc": 0.5, "note": "need >=2 books for held-out G6"})
    held = held_out_book or book_ids[-1]
    held_by_key = {vu: rec["vecs"] for vu, rec in by_book.get(held, {}).items()}
    anchors: dict = {}
    for vu in _recurring_keys(by_book):
        other_vecs = [v for b, by_key in by_book.items() if b != held
                      for v in by_key.get(vu, {}).get("vecs", [])]
        if other_vecs:
            anchors[vu] = centroid(other_vecs)
    out = cb.g6_separation(held_by_key, anchors)
    out["held_out_book"] = held
    return _write("g6", out)


def run_g4(by_book: dict) -> dict:
    """G4 — within-book temporal wander: per (key, book), order clean-line
    cosines-to-(book anchor) by render position and fit a slope; report the
    median slope + the fraction of slope-flagged lines NOT already per-line
    low-cosine (residual). Prior: likely no-go (a single config renders the
    voice near-identically)."""
    slopes, residual_hits, residual_total = [], 0, 0
    for by_key in by_book.values():
        for rec in by_key.values():
            vecs, meta = rec["vecs"], rec["meta"]
            if len(vecs) < 3:
                continue
            anchor = centroid(vecs)
            order = sorted(range(len(vecs)),
                           key=lambda i: (meta[i]["chapter"], meta[i]["start"]))
            cos_seq = [cosine(vecs[i], anchor) for i in order]
            slope = cb.wander_slope(cos_seq)
            slopes.append(slope)
            # residual: a downward-trend tail not already a low-cosine outlier
            lo = float(np.percentile(cos_seq, 10)) if cos_seq else 0.0
            for c in cos_seq:
                residual_total += 1
                if slope < -0.01 and c > lo:
                    residual_hits += 1
    return _write("g4", {
        "wander_slope": cb._median([abs(s) for s in slopes]),
        "residual_fraction": (residual_hits / residual_total) if residual_total else 0.0,
        "n_units": len(slopes),
    })


def run_g0(keys_cfg: dict, K: int = 12) -> dict:
    """G0 — same-text content control. NEEDS THE LIVE SIDECAR. For each voiceUuid,
    render the SAME fixed audition text K times (same config) and embed; the std
    of pairwise distances is the stochastic+identical-content floor that G1
    divides by. keys_cfg: {voiceUuid: {"text": <audition text>, "voice": <storage key>}}.

    OPERATOR: confirm the audition-text source and the sidecar /synthesize contract
    on-box before trusting these numbers — this is the one gate that re-renders.
    Returns {floor_std_median, per_key, floor_std_by_key}."""
    from spikes.srv36.synth_client import render
    per_key, stds, centroids = {}, [], {}
    for vu, cfg in keys_cfg.items():
        embs = []
        for _ in range(K):
            try:
                pcm, sr = render(cfg["text"], cfg["voice"])
                embs.append(embed_pcm(pcm, sr))
            except Exception:
                continue
        if len(embs) < 2:
            per_key[vu] = {"mean": None, "std": None, "n": len(embs), "withheld": True}
            continue
        f = cb.same_text_floor(embs)
        per_key[vu] = {**f, "n": len(embs)}
        stds.append(f["std"])
        centroids[vu] = [float(x) for x in centroid(embs)]  # G2 reuses these
    # persist audition centroids so --g2 can reuse them without re-rendering
    _write("audition_centroids", centroids)
    return _write("g0", {
        "floor_std_median": cb._median(stds), "per_key": per_key,
        "floor_std_by_key": {vu: per_key[vu].get("std") for vu in per_key},
    })


def run_g3(by_book: dict) -> dict:
    """G3 — per-emotion shift. NOT measurable from on-disk renders: the persisted
    segment record carries no emotion tag (segments-io.ts:54), so a neutral-vs-
    emotional split needs a manuscript-emotion join by sentenceId — deferred.
    Writes emotion_shift=0.0 (safe: per_emotion → no-go = 'no material shift
    measured') with an explicit note rather than fabricating a number."""
    return _write("g3", {
        "emotion_shift": 0.0,
        "note": ("not measurable on-disk — rendered segments carry no emotion tag; "
                 "needs a manuscript-emotion join by sentenceId (plan M3/I4). "
                 "Treated as no-material-shift until that join is wired."),
    })
