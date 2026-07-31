"""Reference-audio decode for the XTTS clone path (#1967).

XTTS's own reference loader routes through torchaudio's loader, which on
torchaudio >= 2.9 dispatches to torchcodec and needs FFmpeg's SHARED
libraries. A static ffmpeg build -- the normal Windows install, and the one
our docs steer deployers to -- ships none, so every cloned-voice derive
failed there. We decode the reference WAV ourselves with the stdlib `wave`
module plus NumPy (the pair main.py already uses for all its audio I/O) and
swap our decoder in for the duration of the derive.

NOTE for editors: this file sits in the directory tests/test_audio_io_invariant.py
scans, and that scan does not strip docstrings. Never spell torchaudio's
loader in call form anywhere in this file outside a `#` comment.
"""
from __future__ import annotations

import contextlib
import inspect
import logging
import os
import wave
from typing import TYPE_CHECKING, Any, Iterator

import numpy as np

if TYPE_CHECKING:  # pragma: no cover
    import torch

logger = logging.getLogger(__name__)

# torch / torchaudio are imported INSIDE the function on purpose. The clone
# tests install a fake `torch` into sys.modules (tests/test_xtts_clone_voice.py),
# and a module-level `import torchaudio` executed under that fake dies with
# "No module named 'torch.hub'; 'torch' is not a package" -- reddening ~30
# unrelated tests with an error that points nowhere near the cause.

# The parameter names XTTS's loader has had since 0.22; the patch refuses to
# apply against anything else rather than guessing (see _drift_message).
_EXPECTED_PARAMS = ("audiopath", "sampling_rate")


def wave_load_audio(audiopath: Any, sampling_rate: int) -> torch.Tensor:
    """Drop-in replacement for XTTS's reference loader, minus the codec.

    Returns float32 in [-1, 1], shaped (channels, frames), resampled to
    `sampling_rate` -- byte-identical semantics to the function it replaces,
    which normalises int16 by 1/32768 and resamples with the same
    torchaudio.functional call used below.
    """
    import torch  # noqa: PLC0415
    import torchaudio  # noqa: PLC0415

    path = os.fspath(audiopath)
    with wave.open(path, "rb") as w:
        if w.getsampwidth() != 2:
            raise ValueError(
                f"expected a PCM_16 reference WAV, got {w.getsampwidth() * 8}-bit: {path}"
            )
        lsr = w.getframerate()
        nch = w.getnchannels()
        raw = w.readframes(w.getnframes())

    pcm = np.frombuffer(raw, dtype="<i2").astype(np.float32) / 32768.0
    audio = torch.from_numpy(pcm.reshape(-1, nch).T.copy())

    # From here down this mirrors the replaced function exactly.
    if audio.size(0) != 1:
        audio = torch.mean(audio, dim=0, keepdim=True)
    if lsr != sampling_rate:
        audio = torchaudio.functional.resample(audio, lsr, sampling_rate)
    if torch.any(audio > 10) or not torch.any(audio < 0):
        logger.error("Error with %s. Max=%.2f min=%.2f", path, audio.max(), audio.min())
    audio.clip_(-1, 1)
    return audio


def _drift_message(what: str) -> str:
    try:
        import TTS as _tts_pkg  # noqa: PLC0415

        version = getattr(_tts_pkg, "__version__", "unknown")
    except Exception:  # pragma: no cover - only on a broken install
        version = "unknown"
    return (
        f"XTTS reference-audio patch cannot be applied: {what} (coqui-tts {version}). "
        "Refusing to derive: without the patch the clone path would decode via "
        "torchcodec and fail on any box whose FFmpeg is a static build. See #1967."
    )


@contextlib.contextmanager
def patched_xtts_load_audio() -> Iterator[None]:
    """Swap our decoder into TTS.tts.models.xtts for the duration of a derive.

    Scoped, not permanent, so nothing else in the process inherits a mutated
    third-party module. INSIDE THE SIDECAR PROCESS this must be entered and
    exited while holding CoquiEngine._synth_lock: an exit that fires outside
    the lock would restore the original decoder while another derive is
    mid-flight. The installer's verification snippet is exempt because it runs
    in a separate process with its own module globals.

    Raises RuntimeError rather than falling through if the target moved --
    a silent fall-through would restore #1967 on exactly the boxes that
    cannot notice.
    """
    import TTS.tts.models.xtts as _xtts  # noqa: PLC0415

    original = getattr(_xtts, "load_audio", None)
    if original is None:
        raise RuntimeError(_drift_message("TTS.tts.models.xtts.load_audio is missing"))
    params = tuple(inspect.signature(original).parameters)
    if params[:2] != _EXPECTED_PARAMS:
        raise RuntimeError(_drift_message(f"unexpected load_audio signature {params!r}"))

    _xtts.load_audio = wave_load_audio
    try:
        yield
    finally:
        _xtts.load_audio = original
