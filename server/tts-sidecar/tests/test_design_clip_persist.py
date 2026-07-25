"""fs-38 Wave 3b2, §2.3 (Task 11) — `design_voice` retains its reference clip
as a real WAV file alongside the `.pt`/`.json` it already caches, so a
DESIGNED voice can later re-derive its embedding identically after a
base-model upgrade (Task 12 consumes this; not implemented here). Mirrors the
`master.wav` a CLONED voice already keeps from its uploaded sample (Wave 3b1).

Strictly additive: this must not change `design_voice`'s HTTP response, its
audition PCM, or its `.pt`/`.json` outputs — those stay covered by
test_qwen3.py. This file only pins the NEW artifact: the filename shape
(`<voiceId>__master.wav`), that it's a genuine, openable WAV, and that its
audio is the SAME reference clip that was distilled into the clone prompt
(asserted against `engine._base.prompt_calls[-1][0]`, the `(ref_audio,
ref_sr)` tuple the fake's `create_voice_clone_prompt` records — see
test_qwen3.py's `_FakeQwenModel`).

Reuses `fake_qwen_runtime` from test_qwen3.py (same sys.path bootstrap as
test_qwen_clone_voice.py) rather than duplicating the fixture.
"""
from __future__ import annotations

import sys
import wave
from pathlib import Path

import numpy as np

SIDECAR_ROOT = Path(__file__).resolve().parent.parent
if str(SIDECAR_ROOT) not in sys.path:
    sys.path.insert(0, str(SIDECAR_ROOT))

import main  # noqa: E402

TESTS_DIR = Path(__file__).resolve().parent
if str(TESTS_DIR) not in sys.path:
    sys.path.insert(0, str(TESTS_DIR))

from test_qwen3 import fake_qwen_runtime  # noqa: E402,F401  (reuse the fixture)


def test_design_voice_persists_reference_clip_as_master_wav(fake_qwen_runtime) -> None:
    engine = fake_qwen_runtime["engine"]
    voices_dir = fake_qwen_runtime["dir"]

    result = engine.design_voice("hart", "a witty teenage boy, mid-paced", "English", None)

    wav_path = voices_dir / "hart__master.wav"
    assert wav_path.is_file(), "design_voice must persist the reference clip as <voiceId>__master.wav"

    # A genuine, openable WAV — not a marker/stub file.
    with wave.open(str(wav_path), "rb") as wf:
        assert wf.getnchannels() == 1
        assert wf.getsampwidth() == 2  # int16
        n_frames = wf.getnframes()
        assert n_frames > 0
        framerate = wf.getframerate()
        raw = wf.readframes(n_frames)

    # It's the SAME clip that was distilled into the clone prompt — the fake's
    # create_voice_clone_prompt(ref_audio=(ref_audio, ref_sr), ...) records
    # that tuple as prompt_calls[-1][0].
    expected_ref_audio, expected_ref_sr = engine._base.prompt_calls[-1][0]
    assert framerate == int(expected_ref_sr)
    got = np.frombuffer(raw, dtype="<i2")
    expected = (np.clip(np.asarray(expected_ref_audio, dtype=np.float32), -1.0, 1.0) * 32767.0).astype("<i2")
    assert got.shape == expected.shape
    np.testing.assert_array_equal(got, expected)

    # Strictly additive: the existing outputs are untouched.
    assert (voices_dir / "hart.pt").is_file()
    assert (voices_dir / "hart.json").is_file()
    assert isinstance(result.pcm, bytes) and len(result.pcm) > 0
    assert result.sample_rate == 24000


def test_design_voice_clip_persist_failure_does_not_break_design(fake_qwen_runtime, monkeypatch) -> None:
    """A broken WAV writer must not fail voice design — the clip is a future
    re-derivation aid, not part of the design contract."""
    engine = fake_qwen_runtime["engine"]
    voices_dir = fake_qwen_runtime["dir"]

    def _boom(*_args, **_kwargs):
        raise OSError("disk full (fake)")

    monkeypatch.setattr(main, "_atomic_wav_save", _boom)

    result = engine.design_voice("wren", "a curious teenage girl", "English", None)

    assert not (voices_dir / "wren__master.wav").is_file()
    # design still succeeded end-to-end.
    assert (voices_dir / "wren.pt").is_file()
    assert (voices_dir / "wren.json").is_file()
    assert isinstance(result.pcm, bytes) and len(result.pcm) > 0
