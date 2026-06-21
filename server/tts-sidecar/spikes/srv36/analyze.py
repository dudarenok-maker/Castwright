# server/tts-sidecar/spikes/srv36/analyze.py
"""On-box: turn M over-generation runs into F1/F3/F5 numbers + the F4 listen-set.
Reads real segments.json gate verdicts; ffmpeg-decodes the chapter audio (MP3)
to 16 kHz mono PCM, slices per segment, embeds. Self-contained — no undefined
helpers. Run after Task 8 produces results/runs/<i>/."""
from __future__ import annotations
import json, subprocess
from pathlib import Path

from spikes.srv36.embed import embed_pcm
from spikes.srv36.metrics import cosine, centroid
from spikes.srv36.segments_io import load_segments, seg_key, slice_pcm
from spikes.srv36.gates import is_gate_flagged
from spikes.srv36.aggregates import f1_floor, f3_separability, f5_length_coverage

HERE = Path(__file__).resolve().parent
RESULTS = HERE / "results"
RUNS = RESULTS / "runs"          # runs/<i>/<slug>.segments.json + runs/<i>/<slug>.mp3
SR = 16000                       # decode everything to 16k mono (ECAPA's rate)
FLOOR_SEC = 2.0                  # fixed ECAPA reliability floor (F5 REPORTS variance; it does not feed back)
LENGTHS = [0.5, 1.0, 2.0, 3.0, 5.0]


def _decode_16k(path: Path) -> bytes:
    """ffmpeg → mono s16le @16k. Handles MP3/M4A/WAV (the pipeline emits MP3)."""
    return subprocess.run(
        ["ffmpeg", "-v", "error", "-i", str(path), "-ac", "1", "-ar", str(SR),
         "-f", "s16le", "-"],
        capture_output=True, check=True).stdout


def _chapter_audio(run_dir: Path, segs_path: Path) -> Path | None:
    slug = segs_path.name[: -len(".segments.json")]
    for ext in (".mp3", ".wav", ".m4a", ".aac"):
        p = run_dir / f"{slug}{ext}"
        if p.exists():
            return p
    return None


def _collect():
    """Every segment across all runs: (run, char, key, spcm16k, dur, flagged)."""
    rows = []
    for run_dir in sorted(RUNS.glob("*")):
        for segs_path in run_dir.glob("*.segments.json"):
            audio = _chapter_audio(run_dir, segs_path)
            if not audio:
                continue
            pcm = _decode_16k(audio)
            for seg in load_segments(str(segs_path)):
                spcm = slice_pcm(pcm, SR, seg["start_sec"], seg["end_sec"])
                rows.append((run_dir.name, seg["character"], seg_key(seg), spcm,
                             len(spcm) / 2 / SR, is_gate_flagged(seg)))
    return rows


def main():
    rows = _collect()
    all_durs = [r[4] for r in rows]                       # every segment, for F5 coverage
    scorable = [r for r in rows if r[4] >= FLOOR_SEC]

    emb = {}                                              # (run,key) -> (char, vec, flagged, spcm)
    clean_by_char = {}
    for run, ch, key, spcm, dur, flagged in scorable:
        v = embed_pcm(spcm, SR)
        emb[(run, key)] = (ch, v, flagged, spcm)
        if not flagged:
            clean_by_char.setdefault(ch, []).append(v)
    centroids = {ch: centroid(vs) for ch, vs in clean_by_char.items() if len(vs) >= 3}
    K = {ch: len(vs) for ch, vs in clean_by_char.items()}

    clean_sims, misfire_sims, gate_flagged = [], [], set()
    for (run, key), (ch, v, flagged, spcm) in emb.items():
        if ch not in centroids:
            continue
        (misfire_sims if flagged else clean_sims).append(cosine(centroids[ch], v))
        if flagged:
            gate_flagged.add((run, key))

    f3 = f3_separability(clean_sims, misfire_sims)
    thr = f3["eer"]["threshold"]                          # acoustic flag = cosine < EER threshold

    listen = RESULTS / "f4_listen"; listen.mkdir(parents=True, exist_ok=True)
    acoustic_flagged = set()
    for (run, key), (ch, v, flagged, spcm) in emb.items():
        if ch in centroids and cosine(centroids[ch], v) < thr:
            acoustic_flagged.add((run, key))
            if (run, key) not in gate_flagged:            # acoustic-only → the F4 listen-set
                (listen / f"{run}__{key.replace(':', '_')}.pcm").write_bytes(spcm)

    # F5 length sweep: clean clips that reach 5 s, truncated, cosine-to-centroid.
    length_to_sims = {L: [] for L in LENGTHS}
    for (run, key), (ch, v, flagged, spcm) in emb.items():
        if flagged or ch not in centroids or len(spcm) / 2 / SR < 5.0:
            continue
        for L in LENGTHS:
            length_to_sims[L].append(cosine(centroids[ch], embed_pcm(spcm[: int(L * SR) * 2], SR)))

    (RESULTS / "f1.json").write_text(json.dumps({**f1_floor(clean_sims), "K_per_char": K}, indent=2))
    (RESULTS / "f3.json").write_text(json.dumps({**f3, "note": "EER is in-sample (no held-out split)"}, indent=2))
    (RESULTS / "f5.json").write_text(json.dumps(
        f5_length_coverage(length_to_sims, all_durs, FLOOR_SEC), indent=2))
    (RESULTS / "f4_pending.json").write_text(json.dumps({
        "acoustic_flagged": sorted(f"{r}|{k}" for r, k in acoustic_flagged),
        "gate_flagged": sorted(f"{r}|{k}" for r, k in gate_flagged),
        "acoustic_only_to_listen": sorted(f"{r}|{k}" for r, k in (acoustic_flagged - gate_flagged)),
        "total_acoustic_flagged": len(acoustic_flagged),
    }, indent=2))
    print(f"F1/F3/F5 written. F4 listen-set: {len(acoustic_flagged - gate_flagged)} clips in {listen}")


if __name__ == "__main__":
    main()
