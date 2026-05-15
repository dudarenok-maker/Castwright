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

import asyncio
import io
import logging
import os
import re
import threading
import wave
from typing import Any, Optional

import numpy as np
from fastapi import FastAPI, HTTPException, Request, Response
from fastapi.responses import JSONResponse

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s.%(msecs)03d [sidecar] %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)
log = logging.getLogger("sidecar")

app = FastAPI(title="audiobook-generator local TTS sidecar")


# CUDA poison detection — phrases that PyTorch / NVIDIA emit when a kernel
# raises a device-side assert. Once any of these fire, the CUDA context is
# corrupted process-wide; every subsequent CUDA call re-raises the same
# error. We match liberally (any one of these strings is enough) because
# we never want to MISS a poison — over-classifying is harmless (fast-fail
# with a "restart the sidecar" detail is the right UX either way).
_CUDA_POISON_RE = re.compile(
    r"device-side assert|CUDA error|CUDA kernel errors|CUBLAS_STATUS|cublas|"
    r"out of memory.*CUDA|CUDA out of memory",
    re.IGNORECASE,
)

# Exit code used to signal "the supervisor (start.ps1's while-loop) should
# restart me — my CUDA context is poisoned and only a fresh process can
# clear it." Picked outside the conventional 0/1/2 range so a normal Ctrl+C
# or syntax error doesn't trigger a respawn. start.ps1 explicitly checks
# for this value; any other exit code breaks the loop and stays down.
_POISON_EXIT_CODE = 42

# How long to wait after flagging poison before we actually exit. The 503
# JSON response is small (~120 bytes) and uvicorn's HTTP/1.1 keep-alive
# socket buffers flush within a couple of ms, but we give a generous
# margin so a slow client read on Windows loopback can't drop the body.
# Override via TTS_SIDECAR_POISON_EXIT_DELAY_MS for tests.
_POISON_EXIT_DELAY_MS = int(os.environ.get("TTS_SIDECAR_POISON_EXIT_DELAY_MS", "500"))


def _schedule_poison_exit() -> None:
    """Schedule a hard process exit on a background thread so the inbound
    /synthesize response can flush BEFORE we vanish. Idempotent — multiple
    callers (the first poisoned synth + any concurrent in-flight ones)
    race onto the same timer, but only the first wins because of the
    `_exit_scheduled` flag the caller checks.

    Uses os._exit (not sys.exit) so we bypass uvicorn's graceful-shutdown
    sequence — that path attempts to close socket connections cleanly,
    which on a poisoned CUDA context risks blocking forever on a
    background thread waiting on a corrupted GPU op. Hard-exit is the
    right call: the supervisor in start.ps1 brings us straight back up."""
    def _do_exit() -> None:
        log.error(
            "Exiting with code %d so the start.ps1 supervisor restarts a "
            "fresh Python process with an uncorrupted CUDA context. "
            "Click Retry on the failed chapter once /health responds again.",
            _POISON_EXIT_CODE,
        )
        # os._exit skips atexit handlers and Python finalisers — exactly
        # what we want when the CUDA context is unsafe to touch.
        os._exit(_POISON_EXIT_CODE)

    delay_s = _POISON_EXIT_DELAY_MS / 1000.0
    threading.Timer(delay_s, _do_exit).start()


def _parse_bool(value: Optional[str], default: bool) -> bool:
    """Parse an env-var string into a bool. `"1"`, `"true"`, `"yes"`, `"on"`
    (case-insensitive) → True; `"0"`, `"false"`, `"no"`, `"off"` → False;
    anything else (including None / empty) returns the default. Used so
    `COQUI_HALF=1` / `COQUI_DEEPSPEED=0` work without changing semantics
    based on whitespace or case."""
    if value is None:
        return default
    s = value.strip().lower()
    if s in ("1", "true", "yes", "on"):
        return True
    if s in ("0", "false", "no", "off"):
        return False
    return default


class SynthResult:
    """Engine output: PCM bytes + sample rate + the speaker actually used.
    `substituted_from` is non-None when the requested voice wasn't in the
    model's manifest and we fell back — the route forwards this in the
    X-Voice-Substituted-From header so the Node side can log a warning that
    its voice catalog has drifted."""
    __slots__ = ("pcm", "sample_rate", "substituted_from")

    def __init__(self, pcm: bytes, sample_rate: int, substituted_from: Optional[str] = None) -> None:
        self.pcm = pcm
        self.sample_rate = sample_rate
        self.substituted_from = substituted_from


class Engine:
    """Each engine returns mono PCM as int16 little-endian + a sample rate.
    We never persist audio here — the Node side wraps PCM in WAV and writes
    the file. Keeps this process stateless except for the loaded model."""

    name: str

    def synthesize(self, model: str, voice: str, text: str) -> SynthResult:
        raise NotImplementedError


class CoquiEngine(Engine):
    """Coqui XTTS v2 via the `TTS` package. The model is loaded once on first
    call. XTTS speaks ~24 kHz; we down/up nothing — emit at native rate and
    let the Node side persist as-is."""

    name = "coqui"

    # Conservative fallback speaker. Hardcoded because it's the most widely
    # cited "default narrator" in the XTTS v2 community and has been stable
    # across every coqui-tts release we've tested. Used when the requested
    # voice isn't in the loaded model's manifest — synthesis still completes
    # rather than failing the whole chapter, and the Node-side warning header
    # tells the caller their catalog is stale.
    FALLBACK_SPEAKER = "Claribel Dervla"

    def __init__(self) -> None:
        self._tts: Any = None
        self._torch: Any = None
        # Tracks whether a `_ensure_loaded` call is mid-flight so the /load
        # endpoint can report `loading: true` separately from `model_loaded:
        # true`. Gated by `_load_lock` to serialise concurrent /load calls —
        # FastAPI happily accepts a second POST while the first is awaiting
        # `asyncio.to_thread(_ensure_loaded)`, and without the lock that second
        # call would race past the `_tts is None` check and load XTTS twice.
        self._loading: bool = False
        self._load_lock: asyncio.Lock = asyncio.Lock()
        self._language = os.environ.get("COQUI_LANGUAGE", "en")
        self._device = os.environ.get("COQUI_DEVICE", "auto")  # auto | cpu | cuda
        # fp16 and DeepSpeed-inference are CUDA-only XTTS speedups. Each ~1.5–2×
        # on top of CUDA itself, no audible quality loss. Defaults flip ON when
        # device resolves to cuda and OFF on cpu — env-var "1"/"0" overrides.
        # Resolved in _resolve_runtime_options so the env-var logic stays
        # unit-testable without loading the real model.
        self._half_env = os.environ.get("COQUI_HALF")           # "1" | "0" | None
        self._deepspeed_env = os.environ.get("COQUI_DEEPSPEED") # "1" | "0" | None
        # Resolved at load time; consumed by `synthesize` to decide whether to
        # wrap the inference call in a `torch.autocast` context.
        self._resolved_device = "cpu"
        self._use_half = False
        # Cached speaker manifest from the loaded model. Populated on first
        # load so /synthesize can validate `voice` BEFORE calling tts() —
        # XTTS's own error path raises a cryptic PyTorch "index out of range
        # in self" from the speaker-embedding lookup, which surfaces to the
        # user as a 500 with no actionable detail. Validating up front lets
        # us substitute the fallback and tell the caller what happened.
        self._speakers: list[str] = []
        # Process-lifetime poison fence. Set to True the first time
        # /synthesize catches a CUDA device-side assert (see _CUDA_POISON_RE).
        # PyTorch/NVIDIA semantics: once a kernel asserts on the device, the
        # CUDA context is corrupted for the rest of the process — no amount
        # of empty_cache(), reload, or model recreation will reset it. Only
        # restarting Python clears the state. While poisoned, /synthesize
        # fast-fails 503 with a structured detail so the Node classifier can
        # surface a single "auto-restarting" banner; meanwhile the
        # `_exit_scheduled` flag stops us from scheduling overlapping exit
        # timers when concurrent in-flight requests all hit the same poison
        # detection. `_poison_reason` carries the original CUDA error string
        # for /health diagnostics.
        self._poisoned: bool = False
        self._poison_reason: Optional[str] = None
        self._exit_scheduled: bool = False

    def _resolve_runtime_options(self, torch_module: Any) -> dict[str, Any]:
        """Resolve device + fp16 + deepspeed knobs into a concrete config dict.
        Lifted out of `_ensure_loaded` so the env-driven branching is
        unit-testable without instantiating the real ~3 GB XTTS model — tests
        inject a torch stub that controls `cuda.is_available()`."""
        device = self._device
        if device == "auto":
            device = "cuda" if torch_module.cuda.is_available() else "cpu"
        # On CUDA, default both extras ON (the whole point of the GPU path).
        # On CPU, force them OFF: torch raises on fp16 ops on CPU, and
        # deepspeed-inference is a CUDA-only runtime. Env override only
        # applies when device is cuda — there's no useful "fp16 on CPU" mode.
        if device == "cuda":
            half = _parse_bool(self._half_env, default=True)
            deepspeed = _parse_bool(self._deepspeed_env, default=True)
        else:
            half = False
            deepspeed = False
        return {"device": device, "half": half, "deepspeed": deepspeed}

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

        opts = self._resolve_runtime_options(torch)
        device, want_half, want_deepspeed = opts["device"], opts["half"], opts["deepspeed"]
        # Single startup log line — `npm run tts:sidecar` users can grep
        # logs/tts.log for this to confirm GPU mode is actually on. If you
        # set COQUI_DEVICE=cuda but this prints device=cpu, the venv has the
        # CPU PyTorch wheel installed (see README.md "GPU install" section).
        log.info(
            "Loading Coqui model=%s on device=%s half=%s deepspeed=%s …",
            model_id, device, want_half, want_deepspeed,
        )

        tts = TTS(model_id)

        # DeepSpeed inference engine. Wires in BEFORE `.to(device)` because
        # init_gpt_for_inference rebuilds the GPT module against the deepspeed
        # runtime — moving to GPU afterwards transfers the rebuilt module.
        # Best-effort: if deepspeed isn't installed or the hook drifts in a
        # future coqui-tts release, log and continue without it rather than
        # failing the whole sidecar boot.
        if want_deepspeed:
            try:
                tts.synthesizer.tts_model.gpt.init_gpt_for_inference(
                    kv_cache=True, use_deepspeed=True,
                )
                log.info("DeepSpeed inference enabled.")
            except Exception as e:
                log.warning(
                    "DeepSpeed enable failed (%s) — continuing without it. "
                    "If you want this speedup, install deepspeed in the sidecar venv.",
                    e,
                )

        tts.to(device)

        # fp16 mode. NOTE: we do NOT call `tts_model.half()` here — that
        # casts every weight including LayerNorm to fp16, but XTTS's inputs
        # (text tokens, audio conditioning latents) arrive as fp32 and the
        # LayerNorm forward then dies with `expected Float but found Half`.
        # Instead we record the intent and use `torch.autocast` around the
        # `tts()` call in `synthesize()` — autocast keeps LayerNorm in fp32
        # and only casts the ops where fp16 is safe (matmuls, attention),
        # which is where the speedup lives anyway.
        self._tts = tts
        self._torch = torch
        self._resolved_device = device
        self._use_half = bool(want_half and device == "cuda")
        if self._use_half:
            log.info("fp16 autocast enabled for /synthesize.")

        # Snapshot the speaker manifest so /synthesize can validate inbound
        # `voice` against what the model actually knows. Different coqui-tts
        # releases ship slightly different speaker lists; without this, any
        # drift between our Node-side catalog and the model's catalog
        # manifests as "index out of range in self" mid-chapter.
        try:
            speaker_manager = self._tts.synthesizer.tts_model.speaker_manager
            names = list(getattr(speaker_manager, "name_to_id", {}).keys())
            if not names:
                # Fallback for older speaker-manager APIs that expose
                # `speaker_names` directly.
                names = list(getattr(speaker_manager, "speaker_names", []))
            self._speakers = sorted(names)
            log.info("Coqui ready — %d speakers in manifest.", len(self._speakers))
        except Exception as e:
            # Don't crash startup if the manifest API drifts — synth will
            # still work, but validation falls back to permissive mode.
            log.warning("Could not enumerate Coqui speakers (%s). Skipping pre-validation.", e)
            self._speakers = []

    def unload(self) -> None:
        """Drop references to the loaded XTTS model and free GPU memory.
        Used by POST /unload when the UI's Stop button fires (or when the
        Analysing screen's Load button auto-evicts the TTS model to make
        room for the analyzer LLM). Idempotent — safe to call when nothing
        is loaded."""
        if self._tts is None:
            return
        torch_module = self._torch
        self._tts = None
        self._torch = None
        self._speakers = []
        self._resolved_device = "cpu"
        self._use_half = False
        # `torch.cuda.empty_cache()` releases the cached allocator blocks
        # back to the driver. Python's GC will reclaim the model's tensors
        # once `self._tts = None` drops the last reference, but the cached
        # allocator can hold those blocks for the next allocation — calling
        # empty_cache makes the freed VRAM visible to other processes (e.g.
        # the Ollama daemon) immediately, which is the whole point of the
        # auto-evict-on-load flow.
        if torch_module is not None:
            try:
                if torch_module.cuda.is_available():
                    torch_module.cuda.empty_cache()
            except Exception as e:
                log.warning("torch.cuda.empty_cache() failed (%s) — model is dropped, VRAM will free on GC.", e)
        log.info("Coqui model unloaded.")

    def synthesize(self, model: str, voice: str, text: str) -> SynthResult:
        self._ensure_loaded(model)
        assert self._tts is not None

        # Pre-flight validation. If the caller's `voice` isn't in this model's
        # manifest, substitute the fallback rather than letting XTTS fail with
        # a cryptic embedding index error mid-chapter. The actual_voice
        # carries forward into the synth so the swap is invisible at the
        # protocol level except for the X-Voice-Substituted-From header set
        # by the route handler.
        actual_voice = voice
        substituted_from: Optional[str] = None
        if self._speakers and voice not in self._speakers:
            substituted_from = voice
            actual_voice = (
                self.FALLBACK_SPEAKER
                if self.FALLBACK_SPEAKER in self._speakers
                else self._speakers[0]
            )
            log.warning(
                "Speaker '%s' not in XTTS v2 manifest — substituting '%s'. "
                "Update the Node-side voice catalog (server/src/tts/voice-mapping.ts) "
                "to remove this name. Valid sample: %s",
                voice, actual_voice, ", ".join(self._speakers[:8]),
            )

        # XTTS returns a list[float] at the model's sample rate. We convert
        # to int16 LE bytes here so the network payload is half the size of
        # float32 (and Node side already speaks 16-bit PCM).
        #
        # fp16 path: wrap inference in `torch.autocast`. Unlike a global
        # `model.half()`, autocast leaves LayerNorm + input tensors in fp32
        # (where mixed-precision would otherwise hit `expected Float but found
        # Half`) and casts only the matmul/attention ops that benefit from
        # tensor cores. This is the supported PyTorch pattern for fp16
        # inference on a model that wasn't trained mixed-precision.
        if self._use_half and self._torch is not None:
            with self._torch.autocast(device_type="cuda", dtype=self._torch.float16):
                audio = self._tts.tts(
                    text=text,
                    speaker=actual_voice,
                    language=self._language,
                )
        else:
            audio = self._tts.tts(
                text=text,
                speaker=actual_voice,
                language=self._language,
            )
        sample_rate = int(getattr(self._tts.synthesizer, "output_sample_rate", 24000))
        pcm = _float_audio_to_int16_le(audio)
        return SynthResult(pcm=pcm, sample_rate=sample_rate, substituted_from=substituted_from)


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


@app.on_event("startup")
async def _preload_default_engine() -> None:
    """Optional eager preload — OFF by default. The sidecar's HTTP port comes
    up immediately so the in-app Load button can fire `/load` whenever the
    user navigates to the Generate or Analysing screen.

    Set PRELOAD_COQUI=1 in server/.env to restore the old eager-load
    behaviour (~30–60s startup, model ready before any request)."""
    if os.environ.get("PRELOAD_COQUI", "0") != "1":
        log.info("PRELOAD_COQUI is not set — skipping eager load; use POST /load to warm the model.")
        return
    model = os.environ.get("PRELOAD_COQUI_MODEL", "xtts_v2")
    coqui = ENGINES.get("coqui")
    if not isinstance(coqui, CoquiEngine):
        return
    try:
        log.info("Preloading Coqui (model=%s) at startup…", model)
        await asyncio.to_thread(coqui._ensure_loaded, model)
        log.info("Coqui preload complete — /synthesize will respond fast on first call.")
    except Exception as e:
        # Don't crash the process — the user still gets /health and a
        # diagnostic on the first real /synthesize call.
        log.warning("Coqui preload failed (%s). Will retry lazily on first request.", e)


@app.get("/health")
def health() -> dict[str, Any]:
    """Liveness + load-state probe. `model_loaded` / `loading` / `device` let
    the Node proxy render the right state in the in-app Load/Stop pill without
    a separate round-trip to /speakers.

    `poisoned: true` signals "this process needs to be restarted before
    /synthesize will work again" — set the first time a device-side assert
    fires (see CoquiEngine._poisoned). The UI shows a red banner; the user
    has to actually kill+restart the sidecar."""
    coqui = ENGINES.get("coqui")
    model_loaded = False
    loading = False
    device: Optional[str] = None
    poisoned = False
    poison_reason: Optional[str] = None
    if isinstance(coqui, CoquiEngine):
        model_loaded = coqui._tts is not None
        loading = coqui._loading
        device = coqui._resolved_device if model_loaded else None
        poisoned = coqui._poisoned
        poison_reason = coqui._poison_reason
    return {
        "ok": True,
        "engines": sorted(ENGINES.keys()),
        "model_loaded": model_loaded,
        "loading": loading,
        "device": device,
        "poisoned": poisoned,
        "poison_reason": poison_reason,
    }


@app.post("/load")
async def load_model(req: Request) -> JSONResponse:
    """Load the Coqui XTTS model into memory. Idempotent — returns `ready`
    immediately if the model is already resident. Body: `{ model?: str }`,
    defaults to `xtts_v2`. Serialised by `_load_lock` so concurrent UI
    clicks don't double-load."""
    try:
        body = await req.json()
    except Exception:
        body = {}
    model = body.get("model") if isinstance(body, dict) else None
    if not isinstance(model, str) or not model.strip():
        model = "xtts_v2"

    coqui = ENGINES.get("coqui")
    if not isinstance(coqui, CoquiEngine):
        return JSONResponse({"status": "error", "error": "coqui engine missing"}, status_code=500)

    if coqui._tts is not None:
        return JSONResponse({"status": "ready"})

    async with coqui._load_lock:
        # Re-check under the lock — another concurrent request may have just
        # finished loading while we were waiting on the mutex.
        if coqui._tts is not None:
            return JSONResponse({"status": "ready"})
        coqui._loading = True
        try:
            await asyncio.to_thread(coqui._ensure_loaded, model)
        except Exception as e:
            log.exception("/load failed (model=%s)", model)
            return JSONResponse({"status": "error", "error": str(e)}, status_code=500)
        finally:
            coqui._loading = False
    return JSONResponse({"status": "ready"})


@app.post("/unload")
async def unload_model() -> JSONResponse:
    """Drop the loaded XTTS model and free GPU memory. Idempotent — returns
    `idle` whether or not a model was loaded. The Analysing screen's Load
    button fires this automatically (via the Node proxy) to evict TTS before
    warming the analyzer LLM, and vice-versa."""
    coqui = ENGINES.get("coqui")
    if isinstance(coqui, CoquiEngine):
        await asyncio.to_thread(coqui.unload)
    return JSONResponse({"status": "idle"})


@app.get("/speakers")
def speakers() -> dict[str, Any]:
    """List the speaker names the loaded model actually knows about.
    Useful for hunting drift between the Node-side voice catalog
    (server/src/tts/voice-mapping.ts) and what XTTS v2 ships. Empty list
    if the model isn't loaded yet or the speaker manager API has shifted."""
    coqui = ENGINES.get("coqui")
    if isinstance(coqui, CoquiEngine):
        return {"coqui": coqui._speakers}
    return {}


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

    # Cross-request poison fence. A CUDA device-side assert corrupts the
    # whole CUDA context for the lifetime of this Python process — every
    # subsequent CUDA call (including the next /synthesize) raises the same
    # error. Without this gate, the Node side hits the same 500 once per
    # chapter and the cascade detector takes ~2 chapters to bail. With it,
    # we fail fast and give the Node side a single fatal classification
    # that surfaces a clear "restart the sidecar" banner.
    if isinstance(engine, CoquiEngine) and engine._poisoned:
        return JSONResponse(
            {
                "detail": (
                    "TTS sidecar is in a poisoned CUDA state from a prior "
                    "device-side assert and must be restarted. Stop the "
                    "sidecar (Stop button or kill the process) and start it "
                    "again before retrying."
                ),
                "poisoned": True,
            },
            status_code=503,
        )

    try:
        # CRITICAL: offload to a worker thread.
        #
        # XTTS inference is CPU-bound Python (numpy/torch) and takes 30s–3min
        # per call. Running it inline on the event loop blocks the entire
        # process from accepting *any* inbound request — including the Node
        # proxy's /health probe, which then times out at 2s and the UI's
        # sidecar pill flips to "unreachable" the instant generation starts,
        # even though the sidecar is busy doing exactly what it should.
        #
        # asyncio.to_thread runs the sync call on a worker thread and yields
        # control back to the event loop, so /health stays sub-50ms during
        # synthesis. This is the single biggest UX fix in the sidecar.
        result = await asyncio.to_thread(engine.synthesize, model, voice, text)
    except Exception as e:
        err_str = str(e)
        # Forensic log: the offending text + speaker + language make a
        # post-mortem possible. Without these, "synth failed" with no
        # context means we keep hitting the same input bug blind. Truncated
        # to ~200 chars so log lines stay scannable; the full text is
        # already in the manuscript so this is just a beacon.
        truncated = text if len(text) <= 200 else text[:200] + "…"
        log.exception(
            "synth failed (engine=%s model=%s voice=%s text_len=%d text_preview=%r)",
            engine_id, model, voice, len(text), truncated,
        )

        # CUDA-poisoned detection. PyTorch/NVIDIA semantics: once a kernel
        # raises a device-side assert, the CUDA context is corrupted for the
        # lifetime of the process — empty_cache(), del model, even creating
        # a fresh model won't reset it. Only a process restart will.
        # Flag the engine so subsequent /synthesize calls fail-fast with a
        # 503 + structured detail (handled at the top of this route), AND
        # schedule a deferred os._exit(_POISON_EXIT_CODE) so the start.ps1
        # supervisor wraps us in a while-loop and brings up a fresh process
        # with a clean CUDA context. The user sees a brief "click Retry"
        # window while uvicorn rebinds :9000 (~2 s, model lazy-loads on the
        # next /synthesize).
        is_cuda_poisoned = bool(_CUDA_POISON_RE.search(err_str))
        if is_cuda_poisoned and isinstance(engine, CoquiEngine):
            engine._poisoned = True
            engine._poison_reason = err_str
            log.error(
                "CUDA poisoned — scheduling self-exit so the supervisor "
                "respawns me. Trigger: engine=%s model=%s voice=%s "
                "text_preview=%r",
                engine_id, model, voice, truncated,
            )
            if not engine._exit_scheduled:
                engine._exit_scheduled = True
                _schedule_poison_exit()
            return JSONResponse(
                {"detail": err_str, "poisoned": True},
                status_code=503,
            )

        return JSONResponse({"detail": err_str}, status_code=500)

    headers = {"X-Sample-Rate": str(result.sample_rate)}
    if result.substituted_from is not None:
        # Tell the Node side we couldn't honour the requested voice. The
        # synth still completed (with a fallback voice), so this isn't a
        # failure — just a signal that the upstream catalog has drifted.
        headers["X-Voice-Substituted-From"] = result.substituted_from
    return Response(
        content=result.pcm,
        media_type=f"audio/L16;codec=pcm;rate={result.sample_rate}",
        headers=headers,
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
