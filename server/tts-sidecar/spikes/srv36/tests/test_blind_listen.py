import pytest
from spikes.srv36.blind_listen import build_blind_set, score_blind


def test_build_blind_set_strips_labels_keeps_audio_and_is_deterministic():
    flagged = [{"id": "f1", "audio": "a/f1.wav", "start": 0.0, "end": 3.0, "is_flagged": True}]
    matched = [{"id": "m1", "audio": "a/m1.wav", "start": 1.0, "end": 4.0, "is_flagged": False}]
    pres1, key1 = build_blind_set(flagged, matched, seed=42)
    pres2, _ = build_blind_set(flagged, matched, seed=42)
    assert [c["id"] for c in pres1] == [c["id"] for c in pres2]   # deterministic
    # blind: no label leaks, but the audio path/timing the operator needs IS carried
    assert all("label" not in c and "is_flagged" not in c for c in pres1)
    assert all("audio" in c and "start" in c and "end" in c for c in pres1)
    assert key1["f1"] == "flagged" and key1["m1"] == "matched"


def test_score_blind_counts_fp_fn():
    key = {"f1": "flagged", "f2": "flagged", "m1": "matched", "m2": "matched"}
    # operator says: f1 drift (correct), f2 clean (FN), m1 drift (FP), m2 clean (correct)
    labels = {"f1": "drift", "f2": "clean", "m1": "drift", "m2": "clean"}
    out = score_blind(key, labels)
    assert out["fn"] == 1 and out["fp"] == 1
    assert out["fn_rate"] == pytest.approx(0.5) and out["fp_rate"] == pytest.approx(0.5)
