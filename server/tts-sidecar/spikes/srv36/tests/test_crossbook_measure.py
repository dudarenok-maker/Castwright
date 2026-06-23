"""GPU-free tests for the measurement layer's pure parts (segment counting /
clean-render predicate). The audio decode + embed paths need ffmpeg + weights
and are operator-run, not tested here."""
import json

from spikes.srv36.crossbook_measure import _clean_seg_cid, count_clean_segments


def test_clean_seg_cid_accepts_and_rejects():
    floor = 3.0
    assert _clean_seg_cid({"characterId": "sophie", "sentenceIds": [1],
                           "startSec": 0.0, "endSec": 4.0}, floor) == "sophie"
    # too short
    assert _clean_seg_cid({"characterId": "s", "sentenceIds": [1],
                           "startSec": 0.0, "endSec": 2.0}, floor) is None
    # no sentenceIds (non-dialogue, e.g. chapter title)
    assert _clean_seg_cid({"characterId": "s", "sentenceIds": [],
                           "startSec": 0.0, "endSec": 9.0}, floor) is None
    # gate-flagged (ASR drift) → excluded
    assert _clean_seg_cid({"characterId": "s", "sentenceIds": [1], "startSec": 0.0,
                           "endSec": 9.0, "asr": {"verdict": "drift"}}, floor) is None


def _mk_book(root, book, segs):
    d = root / "author" / "keeper" / book / "audio"
    d.mkdir(parents=True)
    (d / "c1.segments.json").write_text(json.dumps({"segments": segs}), "utf-8")
    (root / "author" / "keeper" / book / "cast.json").write_text(
        json.dumps({"characters": [{"id": "sophie", "voice": {"voiceUuid": "u-soph"}}]}), "utf-8")


def test_count_clean_segments_per_voiceuuid_per_book(tmp_path):
    clean = {"characterId": "sophie", "sentenceIds": [1], "startSec": 0.0, "endSec": 4.0}
    short = {"characterId": "sophie", "sentenceIds": [2], "startSec": 4.0, "endSec": 5.0}
    flagged = {"characterId": "sophie", "sentenceIds": [3], "startSec": 5.0,
               "endSec": 9.0, "asr": {"verdict": "drift"}}
    _mk_book(tmp_path, "book1", [clean, clean, short, flagged])  # 2 clean (short+flagged excluded)
    _mk_book(tmp_path, "book2", [clean])                          # 1 clean
    out = count_clean_segments(str(tmp_path))
    assert out["u-soph"]["character_id"] == "sophie"
    assert out["u-soph"]["by_book"] == {"book1": 2, "book2": 1}
