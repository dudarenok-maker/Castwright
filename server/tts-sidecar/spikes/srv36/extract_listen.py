import os, json, glob, subprocess


def extract_clip(
    audio_path: str,
    start_sec: float,
    end_sec: float,
    out_path: str,
    sr: int = 16000,
) -> bool:
    """Extract a mono wav clip from an audio file via ffmpeg.

    Parameters
    ----------
    audio_path:
        Source audio file (mp3, wav, etc.).
    start_sec:
        Clip start time in seconds.
    end_sec:
        Clip end time in seconds.
    out_path:
        Destination wav file path.
    sr:
        Output sample rate in Hz (default 16000).

    Returns
    -------
    True on success, False if ffmpeg returned a non-zero exit code.
    """
    result = subprocess.run(
        [
            "ffmpeg", "-v", "error", "-y",
            "-ss", str(start_sec), "-to", str(end_sec),
            "-i", audio_path,
            "-ar", str(sr), "-ac", "1",
            out_path,
        ],
        check=False,
    )
    if result.returncode != 0:
        print(f"  WARNING: ffmpeg failed (rc={result.returncode}) for {os.path.basename(out_path)}")
        return False
    print(f"  wrote {os.path.basename(out_path)}")
    return True


if __name__ == "__main__":
    ADIR = r"C:/AudiobookWorkspace/books/Derek Landy/Skulduggery Pleasant/Scepter of the Ancients/audio"
    OUT = r"C:/Users/dudar/srv36-listen"
    os.makedirs(OUT, exist_ok=True)
    # outliers from the probe: (char, chapterfile_stem, start, end, cosine)
    OUT_CLIPS = [
        ("skulduggery", "11-eight-ghastly", 1269.6, 1272.0, 0.151),
        ("skulduggery", "07-four-the-secret-war", 709.4, 711.6, 0.244),
        ("skulduggery", "11-eight-ghastly", 318.9, 326.3, 0.262),
        ("skulduggery", "11-eight-ghastly", 1371.4, 1374.0, 0.288),
        ("narrator", "16-thirteen-the-red-right-hand", 341.9, 347.2, 0.502),
        ("narrator", "19-sixteen-what-s-in-a-name", 1.5, 5.4, 0.536),
        ("stephanie", "11-eight-ghastly", 242.0, 244.0, 0.323),
        ("stephanie", "13-ten-the-gal-in-black", 671.4, 673.8, 0.345),
    ]
    for ch, stem, st, en, cos in OUT_CLIPS:
        mp3 = os.path.join(ADIR, stem + ".mp3")
        if not os.path.exists(mp3):
            print("MISSING", mp3)
            continue
        dst = os.path.join(OUT, f"{ch}_OUTLIER_cos{cos:.3f}_{stem[:12]}_{st:.0f}s.mp3")
        subprocess.run(
            ["ffmpeg", "-v", "error", "-y", "-ss", str(st), "-to", str(en),
             "-i", mp3, "-c:a", "libmp3lame", "-q:a", "2", dst],
            check=False,
        )
        print("wrote", os.path.basename(dst))
    # one REFERENCE (normal) clip per char: first OK seg 3-6s from an early chapter
    refchar = {"narrator": "narrator", "skulduggery": "skulduggery-pleasant", "stephanie": "stephanie-edgley"}
    done = set()
    for segf in sorted(glob.glob(os.path.join(ADIR, "*.segments.json"))):
        if ".previous." in segf:
            continue
        d = json.load(open(segf, encoding="utf-8"))
        for s in d.get("segments", []):
            ch = s.get("characterId")
            v = (s.get("asr") or {}).get("verdict")
            st, en = s.get("startSec"), s.get("endSec")
            for short, full in refchar.items():
                if ch == full and short not in done and v == "ok" and st and en and 3 <= (en - st) <= 6:
                    extract_clip(
                        os.path.join(ADIR, os.path.basename(segf).replace(".segments.json", ".mp3")),
                        st, en,
                        os.path.join(OUT, f"{short}_REFERENCE_normal_{st:.0f}s.wav"),
                    )
                    done.add(short)
    print("REF done:", done)
    print("LISTEN DIR:", OUT)
