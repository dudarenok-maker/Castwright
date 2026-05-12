"""Local TTS sidecar — speaks the protocol the Node backend's
SidecarTtsProvider expects.

Wire format:
  POST /synthesize  body: { engine, model, voice, text }
                    response: 16-bit signed LE mono PCM bytes,
                              X-Sample-Rate header, content-type audio/L16.
  GET  /health      response: { ok, engines: ['coqui', ...] }

Engines are lazy-loaded on first call. Coqui XTTS v2 takes a few seconds to
load and a few GB of RAM, so the process holds it in memory for the rest of
its lifetime. Piper / Kokoro plug in alongside by adding their own
`Engine`-subclass under engines/ and registering in ENGINES.

License note: Coqui XTTS v2 ships under the Coqui Public Model License (CPML),
which restricts commercial use. This project is local-only / personal use, so
that's fine. Read the license before redistributing audio you generate.
"""

from __future__ import annotations

import io
import logging
import os
import wave
from typing import Any, Optional

import numpy as np
from fastapi import FastAPI, HTTPException, Request, Response
from fastapi.responses import JSONResponse

logging.basicConfig(level=logging.INFO, format="[sidecar] %(message)s")
log = logging.getLogger("sidecar")

app = FastAPI(title="audiobook-generator local TTS sidecar")


class Engine:
    """Each engine returns mono PCM as int16 little-endian + a sample rate.
    We never persist audio here — the Node side wraps PCM in WAV and writes
    the file. Keeps this process stateless except for the loaded model."""

    name: str

    def synthesize(self, model: str, voice: str, text: str) -> tuple[bytes, int]:
        raise NotImplementedError


class CoquiEngine(Engine):
    """Coqui XTTS v2 via the `TTS` package. The model is loaded once on first
    call. XTTS speaks ~24 kHz; we down/up nothing — emit at native rate and
    let the Node side persist as-is."""

    name = "coqui"

    def __init__(self) -> None:
        self._tts: Any = None
        self._language = os.environ.get("COQUI_LANGUAGE", "en")
        self._device = os.environ.get("COQUI_DEVICE", "auto")  # auto | cpu | cuda

    def _ensure_loaded(self, model: str) -> None:
        if self._tts is not None:
            return
        # Importing lazily so the process can start (and /health respond)
        # before the heavy ML deps load. Most useful while iterating on
        # the protocol — the Node side can verify reachability instantly.
        # Surface the *actual* import error so the Node-side log/UI carries
        # a useful diagnostic (torch missing vs TTS missing vs a third-party
        # incompatibility) instead of a one-size-fits-all message.
        try:
            from TTS.api import TTS  # type: ignore
        except ImportError as e:
            raise RuntimeError(
                f"Failed to import coqui-tts ({e}). "
                "Most common cause: PyTorch isn't installed in this venv — "
                "coqui-tts excludes it from its deps so you can pick CPU vs CUDA. "
                "Run `.\\.venv\\Scripts\\python.exe -m pip install torch torchaudio "
                "--index-url https://download.pytorch.org/whl/cpu` in server/tts-sidecar."
            ) from e
        try:
            import torch  # type: ignore
        except ImportError as e:
            raise RuntimeError(
                f"PyTorch missing from this venv ({e}). Install with: "
                "`.\\.venv\\Scripts\\python.exe -m pip install torch torchaudio "
                "--index-url https://download.pytorch.org/whl/cpu` in server/tts-sidecar."
            ) from e

        model_id = {
            "xtts_v2": "tts_models/multilingual/multi-dataset/xtts_v2",
        }.get(model, model)

        device = self._device
        if device == "auto":
            device = "cuda" if torch.cuda.is_available() else "cpu"
        log.info("Loading Coqui model=%s on device=%s …", model_id, device)
        self._tts = TTS(model_id).to(device)
        log.info("Coqui ready.")

    def synthesize(self, model: str, voice: str, text: str) -> tuple[bytes, int]:
        self._ensure_loaded(model)
        assert self._tts is not None
        # XTTS returns a list[float] at the model's sample rate. We convert
        # to int16 LE bytes here so the network payload is half the size of
        # float32 (and Node side already speaks 16-bit PCM).
        audio = self._tts.tts(
            text=text,
            speaker=voice,
            language=self._language,
        )
        sample_rate = int(getattr(self._tts.synthesizer, "output_sample_rate", 24000))
        pcm = _float_audio_to_int16_le(audio)
        return pcm, sample_rate


def _float_audio_to_int16_le(audio: Any) -> bytes:
    """Coqui returns either numpy float32 or a python list of floats in
    [-1.0, 1.0]. Convert to 16-bit signed LE mono PCM."""
    arr = np.asarray(audio, dtype=np.float32)
    if arr.ndim > 1:
        # mono if multi-channel by averaging
        arr = arr.mean(axis=-1)
    arr = np.clip(arr, -1.0, 1.0)
    scaled = (arr * 32767.0).astype("<i2")  # int16 little-endian
    return scaled.tobytes()


ENGINES: dict[str, Engine] = {
    "coqui": CoquiEngine(),
}


@app.get("/health")
def health() -> dict[str, Any]:
    return {"ok": True, "engines": sorted(ENGINES.keys())}


@app.post("/synthesize")
async def synthesize(req: Request) -> Response:
    try:
        body = await req.json()
    except Exception:
        raise HTTPException(status_code=400, detail="Body must be JSON.")

    engine_id = body.get("engine")
    model = body.get("model")
    voice = body.get("voice")
    text = body.get("text")

    if not isinstance(engine_id, str) or engine_id not in ENGINES:
        return JSONResponse(
            {"detail": f"unknown engine '{engine_id}'. Available: {sorted(ENGINES)}"},
            status_code=400,
        )
    if not isinstance(model, str) or not model:
        raise HTTPException(status_code=400, detail="`model` is required.")
    if not isinstance(voice, str) or not voice:
        raise HTTPException(status_code=400, detail="`voice` is required.")
    if not isinstance(text, str) or not text.strip():
        raise HTTPException(status_code=400, detail="`text` is required.")

    engine = ENGINES[engine_id]
    try:
        pcm, sample_rate = engine.synthesize(model, voice, text)
    except Exception as e:
        log.exception("synth failed (engine=%s model=%s voice=%s)", engine_id, model, voice)
        return JSONResponse({"detail": str(e)}, status_code=500)

    return Response(
        content=pcm,
        media_type=f"audio/L16;codec=pcm;rate={sample_rate}",
        headers={"X-Sample-Rate": str(sample_rate)},
    )


def _wav_bytes(pcm: bytes, sample_rate: int) -> bytes:
    """Debug helper: wrap raw PCM in WAV. Not used by the wire protocol — the
    Node side does that — but useful when curling /synthesize manually."""
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sample_rate)
        w.writeframes(pcm)
    return buf.getvalue()
