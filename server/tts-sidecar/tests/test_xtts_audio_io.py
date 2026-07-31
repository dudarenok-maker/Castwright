"""#1967 — the XTTS clone path must decode its reference WAV without torchcodec.

The poison test below is the regression gate. It asserts BOTH halves: with
torchcodec unimportable, torchaudio's own loader must fail, and ours must
succeed. Asserting only the success half would produce a test that passes
whether or not the fix is present -- the exact shape that let #1967 ship.
"""
import importlib
import sys
import types
import wave

import numpy as np
import pytest
import torch

from xtts_audio_io import patched_xtts_load_audio, wave_load_audio


class _BlockTorchcodec:
    """A meta-path finder that makes `import torchcodec` raise."""

    def find_module(self, fullname, path=None):  # legacy API, harmless
        return None

    def find_spec(self, fullname, path=None, target=None):
        if fullname == "torchcodec" or fullname.startswith("torchcodec."):
            raise ImportError("torchcodec blocked by test")
        return None


@pytest.fixture
def poisoned():
    finder = _BlockTorchcodec()
    saved = {k: v for k, v in sys.modules.items() if k.startswith("torchcodec")}
    for k in saved:
        del sys.modules[k]
    sys.meta_path.insert(0, finder)
    try:
        yield
    finally:
        sys.meta_path.remove(finder)
        sys.modules.update(saved)


def _write_wav(path, pcm_int16, sr=24000, nch=1):
    with wave.open(str(path), "wb") as w:
        w.setnchannels(nch)
        w.setsampwidth(2)
        w.setframerate(sr)
        w.writeframes(pcm_int16.tobytes())


@pytest.fixture
def ref_wav(tmp_path):
    t = np.linspace(0, 1, 24000, endpoint=False, dtype=np.float32)
    pcm = (np.sin(2 * np.pi * 220 * t) * 0.5 * 32767).astype("<i2")
    p = tmp_path / "ref.wav"
    _write_wav(p, pcm)
    return p


def test_torchaudio_loader_fails_without_torchcodec(poisoned, ref_wav):
    """The can-fail half: proves the poison fixture actually bites."""
    import torchaudio

    with pytest.raises((ImportError, OSError, RuntimeError)):
        torchaudio.load(str(ref_wav))


def test_our_loader_succeeds_without_torchcodec(poisoned, ref_wav):
    audio = wave_load_audio(str(ref_wav), 22050)
    assert audio.shape[0] == 1
    assert audio.dtype == torch.float32
    assert audio.shape[1] == pytest.approx(22050, rel=0.01)
    assert float(audio.abs().max()) <= 1.0


def test_matches_torchaudio_when_torchcodec_works(ref_wav):
    """Fidelity: same tensor as the loader we replace, where that loader runs."""
    torchaudio = pytest.importorskip("torchaudio")
    try:
        expected, sr = torchaudio.load(str(ref_wav))
    except Exception:
        pytest.skip("torchaudio's loader unavailable here (no shared FFmpeg)")
    ours = wave_load_audio(str(ref_wav), sr)
    assert torch.allclose(ours, expected, atol=1e-6)


def test_accepts_pathlib_path(ref_wav):
    assert wave_load_audio(ref_wav, 22050).shape[0] == 1


def test_rejects_non_pcm16(tmp_path):
    p = tmp_path / "eight.wav"
    with wave.open(str(p), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(1)
        w.setframerate(24000)
        w.writeframes(b"\x80" * 1000)
    with pytest.raises(ValueError, match="PCM_16"):
        wave_load_audio(str(p), 22050)


def _fake_xtts_module(load_audio_fn):
    pkg = types.ModuleType("TTS")
    tts = types.ModuleType("TTS.tts")
    models = types.ModuleType("TTS.tts.models")
    xtts = types.ModuleType("TTS.tts.models.xtts")
    xtts.load_audio = load_audio_fn
    pkg.__version__ = "0.27.5"
    return {
        "TTS": pkg,
        "TTS.tts": tts,
        "TTS.tts.models": models,
        "TTS.tts.models.xtts": xtts,
    }


@pytest.fixture
def fake_xtts(monkeypatch):
    def _install(load_audio_fn):
        mods = _fake_xtts_module(load_audio_fn)
        for name, mod in mods.items():
            monkeypatch.setitem(sys.modules, name, mod)
        return mods["TTS.tts.models.xtts"]

    return _install


def test_context_manager_swaps_and_restores(fake_xtts):
    def original(audiopath, sampling_rate):
        return "original"

    xtts = fake_xtts(original)
    with patched_xtts_load_audio():
        assert xtts.load_audio is wave_load_audio
    assert xtts.load_audio is original


def test_context_manager_restores_on_exception(fake_xtts):
    def original(audiopath, sampling_rate):
        return "original"

    xtts = fake_xtts(original)
    with pytest.raises(ValueError):
        with patched_xtts_load_audio():
            raise ValueError("boom")
    assert xtts.load_audio is original


def test_raises_when_load_audio_missing(fake_xtts):
    xtts = fake_xtts(lambda audiopath, sampling_rate: None)
    del xtts.load_audio
    with pytest.raises(RuntimeError, match="#1967"):
        with patched_xtts_load_audio():
            pass


def test_raises_on_signature_drift(fake_xtts):
    def renamed(path, sr):  # upstream renamed the parameters
        return "drifted"

    fake_xtts(renamed)
    with pytest.raises(RuntimeError, match="signature"):
        with patched_xtts_load_audio():
            pass


def test_patched_derive_survives_poison_where_unpatched_dies(poisoned, ref_wav, fake_xtts):
    """THE regression gate: poison and the derive-shaped call path, together.

    Every other test here exercises one or the other. The fake `load_audio`
    below calls torchaudio's loader for real, exactly as the shipped XTTS one
    does, and `derive()` reaches it through the module global exactly as
    get_conditioning_latents does -- so under poison it must die, and must stop
    dying once our context manager is active. Without this test the suite
    passes in full with the fix entirely absent, which is the #1967 shape.
    """
    import torchaudio

    def upstream_load_audio(audiopath, sampling_rate):
        audio, _lsr = torchaudio.load(audiopath)
        return audio

    fake_xtts(upstream_load_audio)

    def derive():
        return sys.modules["TTS.tts.models.xtts"].load_audio(str(ref_wav), 22050)

    with pytest.raises((ImportError, OSError, RuntimeError)):
        derive()

    with patched_xtts_load_audio():
        audio = derive()
    assert audio.shape[0] == 1


def test_installed_xtts_loader_still_has_the_shape_we_patch():
    """Spec §9 fidelity tier — the patch must stay NECESSARY and correctly shaped.

    Skips where coqui-tts was never opted into. This is a different assertion
    from the tensor-equivalence test above: that one checks our decoder is
    right, this one checks upstream still needs replacing.
    """
    import inspect as _inspect

    xtts = pytest.importorskip("TTS.tts.models.xtts")
    fn = getattr(xtts, "load_audio", None)
    assert fn is not None, "upstream removed load_audio — patched_xtts_load_audio will raise"
    assert tuple(_inspect.signature(fn).parameters)[:2] == ("audiopath", "sampling_rate")
    src = _inspect.getsource(fn)
    assert "torchaudio" in src and ".load(" in src, (
        "upstream stopped routing the reference decode through torchaudio's loader — "
        "the #1967 patch may no longer be necessary; re-evaluate before deleting it"
    )
