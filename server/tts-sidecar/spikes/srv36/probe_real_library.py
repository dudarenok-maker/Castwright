"""probe_real_library.py — embed a real audiobook library and report per-character cosine stats.

The core embed/decode/segment-walk loop is exposed as ``embed_book_segments()``
so that ``calibrate.py`` can reuse it without duplicating the logic.
"""
import sys, json, glob, os, subprocess, random
import numpy as np
from spikes.srv36.embed import embed_pcm
from spikes.srv36.metrics import cosine, centroid, eer, spread_stats
from spikes.srv36.segments_io import slice_pcm, seg_key
from spikes.srv36.gates import is_gate_flagged


# ---------------------------------------------------------------------------
# Shared importable helper — also used by calibrate.py CLI
# ---------------------------------------------------------------------------

def embed_book_segments(
    book_dir: str,
    segments_glob: str = "*.segments.json",
    sr: int = 16000,
    floor: float = 2.0,
) -> "dict[str, list[dict]]":
    """Embed all gate-OK segments in *book_dir* and return per-character entries.

    Returns
    -------
    ``{character_id: [{"sentence_id": str, "cosine": float}, …]}``

    Entries are keyed on stable ``sentenceId`` (Phase-0 fix) — NOT on
    chapter/timestamp order, which shifts on every stochastic run.

    Requires ffmpeg on PATH and the speechbrain weights loaded via embed_pcm.
    """
    import glob as _glob
    from pathlib import Path

    pcm_cache: dict[str, bytes] = {}

    def _decode(audio_path: str) -> bytes:
        if audio_path not in pcm_cache:
            pcm_cache[audio_path] = subprocess.run(
                ["ffmpeg", "-v", "error", "-i", audio_path,
                 "-ac", "1", "-ar", str(sr), "-f", "s16le", "-"],
                capture_output=True, check=True,
            ).stdout
        return pcm_cache[audio_path]

    per_char_vecs: dict[str, list] = {}
    per_char_ids: dict[str, list[str]] = {}

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
            # Re-key on sentenceIds (stable), NOT timestamps (shift every run).
            # Real segments carry `sentenceIds` (a list of manuscript indices);
            # join into one stable, globally-unique key. Non-dialogue segments
            # (e.g. chapter titles) have an empty list and are skipped.
            sids = seg.get("sentenceIds") or []
            sentence_id = "-".join(str(s) for s in sids) if sids else None
            if sentence_id is None:
                continue
            st = seg.get("startSec")
            en = seg.get("endSec")
            if st is None or en is None or (en - st) < floor:
                continue
            if is_gate_flagged(seg):
                continue

            spcm = slice_pcm(pcm, sr, float(st), float(en))
            try:
                vec = embed_pcm(spcm, sr)
            except Exception:
                continue
            per_char_vecs.setdefault(ch, []).append(vec)
            per_char_ids.setdefault(ch, []).append(sentence_id)

    # Build centroids + per-sentence cosine entries
    per_char_entries: dict[str, list[dict]] = {}
    for ch, vecs in per_char_vecs.items():
        if len(vecs) < 3:
            continue
        cen = centroid(vecs)
        per_char_entries[ch] = [
            {"sentence_id": sid, "cosine": cosine(cen, v)}
            for sid, v in zip(per_char_ids[ch], vecs)
        ]

    return per_char_entries


# ---------------------------------------------------------------------------
# Script entry — original exploratory probe (unchanged behaviour)
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    ADIR = r"C:/AudiobookWorkspace/books/Derek Landy/Skulduggery Pleasant/Scepter of the Ancients/audio"
    SR=16000; FLOOR=2.0
    TARGETS=["narrator","skulduggery-pleasant","stephanie-edgley"]
    random.seed(7)

    # collect segments per char: (chapterfile, seg, flagged)
    bychar={t:{"flag":[],"ok":[]} for t in TARGETS}
    for segf in glob.glob(os.path.join(ADIR,"*.segments.json")):
        if ".previous." in segf: continue
        d=json.load(open(segf,encoding="utf-8"))
        for s in d.get("segments",[]):
            ch=s.get("characterId")
            if ch not in TARGETS: continue
            st,en=s.get("startSec"),s.get("endSec")
            if st is None or en is None or (en-st)<FLOOR: continue
            rec=(segf,float(st),float(en))
            (bychar[ch]["flag"] if is_gate_flagged(s) else bychar[ch]["ok"]).append(rec)

    _dec={}
    def dec(mp3):
        if mp3 not in _dec:
            _dec[mp3]=subprocess.run(["ffmpeg","-v","error","-i",mp3,"-ac","1","-ar",str(SR),"-f","s16le","-"],capture_output=True).stdout
        return _dec[mp3]
    def emb(rec):
        segf,st,en=rec; mp3=segf.replace(".segments.json",".mp3")
        if not os.path.exists(mp3): return None
        return embed_pcm(slice_pcm(dec(mp3),SR,st,en),SR)

    for ch in TARGETS:
        ok=bychar[ch]["ok"]; flag=bychar[ch]["flag"]
        random.shuffle(ok)
        cen_recs=ok[:40]; held=ok[40:160]
        cen_e=[e for e in (emb(r) for r in cen_recs) if e is not None]
        if len(cen_e)<5: print(f"{ch}: too few clean"); continue
        cen=centroid(cen_e)
        held_s=[cosine(cen,e) for e in (emb(r) for r in held) if e is not None]
        flag_e=[(r,emb(r)) for r in flag]; flag_e=[(r,e) for r,e in flag_e if e is not None]
        flag_s=[cosine(cen,e) for r,e in flag_e]
        print(f"\n=== {ch}: centroid={len(cen_e)} | clean held-out n={len(held_s)} | flagged n={len(flag_s)} ===")
        print(" clean cosine:", {k:round(v,3) for k,v in spread_stats(held_s).items()})
        if flag_s: print(" flagged cosine:", {k:round(v,3) for k,v in spread_stats(flag_s).items()})
        if flag_s and held_s:
            e=eer(genuine=held_s,impostor=flag_s); print(" EER(clean vs flagged):",round(e["eer"],3),"thr",round(e["threshold"],3))
        # F4 candidates: lowest-cosine CLEAN (gate-OK) segments = timbre outliers gates rated OK
        scored=sorted(zip(held_s,held),key=lambda x:x[0])[:6]
        print(" lowest-cosine GATE-OK (acoustic outliers → listen candidates):")
        for c,rec in scored:
            print(f"    cos={c:.3f}  {os.path.basename(rec[0])}  {rec[1]:.1f}-{rec[2]:.1f}s")
    print("\nDONE")
