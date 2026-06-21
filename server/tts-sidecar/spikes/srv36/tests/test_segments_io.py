import json, numpy as np
from spikes.srv36.segments_io import load_segments, seg_key, slice_pcm

SR = 16000


def test_load_segments_normalises_fields(tmp_path):
    p = tmp_path / "ch.segments.json"
    p.write_text(json.dumps({"segments": [
        {"characterId": "wren", "startSec": 0.0, "endSec": 1.5,
         "asr": {"verdict": "ok"}, "suspect": False},
    ]}))
    segs = load_segments(str(p))
    assert segs[0]["character"] == "wren"
    assert segs[0]["start_sec"] == 0.0 and segs[0]["end_sec"] == 1.5
    assert segs[0]["asr"]["verdict"] == "ok"


def test_seg_key_stable():
    seg = {"character": "wren", "start_sec": 0.0, "end_sec": 1.5}
    assert seg_key(seg) == "wren:0.000-1.500"


def test_slice_pcm_byte_offsets():
    pcm = (np.arange(SR) % 1000).astype("<i2").tobytes()  # 1.0 s
    out = slice_pcm(pcm, SR, 0.25, 0.5)
    assert len(out) == int(SR * 0.25) * 2  # 0.25 s of int16
