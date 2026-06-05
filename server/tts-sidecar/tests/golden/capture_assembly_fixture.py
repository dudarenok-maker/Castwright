"""Capture the recorded-PCM fixture for the GPU-free assembly golden (ops-11).

Synthesizes a few short lines through the REAL Kokoro model and writes:
  - golden-chapter.pcm   concatenated raw 16-bit LE mono PCM (all segments)
  - golden-chapter.json  per-segment {characterId, text, voiceName, byteLength}

The server-side `golden-assembly.golden.test.ts` reads these and feeds the
slices through `synthesiseChapter` + `finalizeChapterAudioWrite` with NO GPU —
so the assembly / loudnorm / encode / segments contract is locked everywhere.

Re-run on a box with Kokoro weights whenever the segment set changes:
    server/tts-sidecar/.venv/Scripts/python.exe \\
        server/tts-sidecar/tests/golden/capture_assembly_fixture.py
Then commit both files. This is the Suite-B analogue of `--bless`.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

SIDECAR_ROOT = Path(__file__).resolve().parents[2]
if str(SIDECAR_ROOT) not in sys.path:
    sys.path.insert(0, str(SIDECAR_ROOT))

import main  # noqa: E402

# The fixture lives with its CONSUMER — the server-side assembly golden test —
# not next to this capture script. SIDECAR_ROOT is server/tts-sidecar; its
# parent is server/.
GOLDEN_DIR = SIDECAR_ROOT.parent / "src" / "tts" / "__fixtures__"
GOLDEN_DIR.mkdir(parents=True, exist_ok=True)

# Short, plain (no all-caps / dashes so normaliseForTts is identity) lines —
# distinct text per segment so the test stub can key PCM by text. Multiple
# characters + voices exercise the per-group routing + concat.
SEGMENTS = [
    {"characterId": "narrator", "voice": "af_heart", "text": "The harbor was quiet that morning."},
    {"characterId": "alice", "voice": "bf_emma", "text": "Did you hear that sound just now?"},
    {"characterId": "ben", "voice": "am_michael", "text": "It was only the wind off the water."},
]


def main_capture() -> None:
    engine = main.KokoroEngine()
    pcm_parts: list[bytes] = []
    meta_segments = []
    sample_rate = None
    for seg in SEGMENTS:
        res = engine.synthesize("v1", seg["voice"], seg["text"])
        if res.substituted_from is not None:
            raise SystemExit(f"voice {seg['voice']} substituted — fix the fixture voices")
        sample_rate = res.sample_rate
        pcm_parts.append(res.pcm)
        meta_segments.append(
            {
                "characterId": seg["characterId"],
                "text": seg["text"],
                "voiceName": seg["voice"],
                "byteLength": len(res.pcm),
            }
        )

    (GOLDEN_DIR / "golden-chapter.pcm").write_bytes(b"".join(pcm_parts))
    with open(GOLDEN_DIR / "golden-chapter.json", "w", encoding="utf-8") as f:
        json.dump({"sampleRate": sample_rate, "segments": meta_segments}, f, indent=2)
        f.write("\n")
    total = sum(len(p) for p in pcm_parts)
    print(f"Wrote golden-chapter.pcm ({total} bytes) + golden-chapter.json ({len(meta_segments)} segments).")


if __name__ == "__main__":
    main_capture()
