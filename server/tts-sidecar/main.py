"""Local TTS sidecar — speaks the protocol the Node backend's
SidecarTtsProvider expects.

Wire format:
  POST /synthesize  body: { engine, model, voice, text }
                    response: 16-bit signed LE mono PCM bytes,
                              X-Sample-Rate header, content-type audio/L16.
  GET  /health      response: { ok, engines: ['coqui', ...] }

Engines plug in by subclassing `Engine` and registering in ENGINES. Coqui
XTTS v2 is lazy-loaded on first call (a few GB of VRAM, ~30 s init — the
in-app Load/Stop pill controls its lifetime so it can be evicted to free
VRAM for the analyzer). Kokoro v1 is eagerly loaded at startup (~300 MB
ONNX + ~30 MB voices, ~1 s init; small enough to be permanently resident
alongside the analyzer).

License note: Coqui XTTS v2 ships under the Coqui Public Model License (CPML),
which restricts commercial use. This project is local-only / personal use, so
that's fine. Read the license before redistributing audio you generate.
"""

from __future__ import annotations

import asyncio
import logging
import os
import re
import shutil
import threading
import time
from typing import Any, Optional

import numpy as np
from fastapi import FastAPI, HTTPException, Request, Response
from fastapi.responses import JSONResponse

# Exposed as module constants so the logging-format regression test can
# assert on the intended format directly, instead of fishing the formatter
# off `logging.getLogger().handlers[0]` — pytest's caplog plugin installs
# its own root handler before `main` is imported, so basicConfig becomes a
# no-op and the handler-0 fishing approach reads pytest's formatter
# instead of ours.
LOG_FORMAT = "%(asctime)s.%(msecs)03d [sidecar] %(message)s"
LOG_DATEFMT = "%Y-%m-%d %H:%M:%S"

logging.basicConfig(
    level=logging.INFO,
    format=LOG_FORMAT,
    datefmt=LOG_DATEFMT,
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


class SynthBatchResult:
    """Batched engine output: one PCM blob per input item, SAME order, plus the
    single sample rate the model produced. Qwen-only — `generate_voice_clone`
    runs the N sequences in one batched forward, so the whole batch shares a
    rate. The /synthesize-batch route frames these as a length-prefixed binary
    body (header line + concatenated PCM)."""
    __slots__ = ("pcms", "sample_rate")

    def __init__(self, pcms: list[bytes], sample_rate: int) -> None:
        self.pcms = pcms
        self.sample_rate = sample_rate


class Engine:
    """Each engine returns mono PCM as int16 little-endian + a sample rate.
    We never persist audio here — the Node side encodes PCM to MP3 and
    writes the file. Keeps this process stateless except for the loaded
    model."""

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


class KokoroEngine(Engine):
    """Kokoro v1 via the `kokoro-onnx` package. Tuned for quality, not VRAM
    thrift: fp32 ONNX, CUDA execution provider when available with CPU
    fallback. Eagerly loaded on sidecar startup (the model is small enough
    that the cold-start cost isn't worth gating behind a /load button).

    The bundled voices-v1.0.bin manifest carries ~54 voices across 8
    languages; this project surfaces only the 28 English voices (American
    and British, female and male). The filter is hardcoded — if you ever
    need another language, extend ENGLISH_VOICE_PREFIXES and restart.
    """

    name = "kokoro"

    # American/British × female/male. Filters Kokoro's multilingual catalog
    # down to the English subset (28 voices) at load time so every consumer
    # — /speakers, /synthesize substitution, the Node-side base-voices
    # aggregator, the picker UI — sees the same shortlist. Non-English
    # voice IDs requested by /synthesize fall back to FALLBACK_VOICE the
    # same way XTTS substitutes unknown speakers.
    ENGLISH_VOICE_PREFIXES = ("af_", "am_", "bf_", "bm_")

    # Most-cited "narrator-quality" Kokoro voice in 2026 surveys. Used when
    # the requested voice isn't in the English manifest — synth still
    # completes rather than failing the whole chapter.
    FALLBACK_VOICE = "af_heart"

    # Kokoro v1 native output sample rate. Hardcoded because kokoro-onnx
    # versions have shuffled where they expose this; matching XTTS's 24 kHz
    # keeps the Node-side MP3 encoder on a single sample-rate path.
    NATIVE_SAMPLE_RATE = 24000

    def __init__(self) -> None:
        self._kokoro: Any = None
        self._loading: bool = False
        self._load_lock: asyncio.Lock = asyncio.Lock()
        # Default weight paths live next to this file under voices/kokoro/.
        # The install-kokoro.ps1 script downloads them there. Env overrides
        # let the user park the ~330 MB of weights on a different drive.
        default_dir = os.path.join(os.path.dirname(__file__), "voices", "kokoro")
        self._model_path = os.environ.get(
            "KOKORO_MODEL_PATH",
            os.path.join(default_dir, "kokoro-v1.0.onnx"),
        )
        self._voices_path = os.environ.get(
            "KOKORO_VOICES_PATH",
            os.path.join(default_dir, "voices-v1.0.bin"),
        )
        # Kokoro's language codes use the espeak-ng convention ("en-us",
        # "en-gb"). The voice itself encodes accent (af_ = American, bf_ =
        # British), so the language code is largely a phonemiser hint;
        # default to en-us and let users override if they hit edge cases.
        self._language = os.environ.get("KOKORO_LANGUAGE", "en-us")
        # English subset of the voice manifest, populated at load time.
        self._voices: list[str] = []

    def _ensure_loaded(self, model: str) -> None:
        if self._kokoro is not None:
            return
        try:
            from kokoro_onnx import Kokoro  # type: ignore
        except ImportError as e:
            raise RuntimeError(
                f"Failed to import kokoro-onnx ({e}). Install with: "
                "`.\\.venv\\Scripts\\python.exe -m pip install kokoro-onnx onnxruntime-gpu` "
                "in server/tts-sidecar (or onnxruntime for CPU-only)."
            ) from e

        if not os.path.isfile(self._model_path):
            raise RuntimeError(
                f"Kokoro model not found at {self._model_path}. "
                "Run server/tts-sidecar/scripts/install-kokoro.ps1 to download weights."
            )
        if not os.path.isfile(self._voices_path):
            raise RuntimeError(
                f"Kokoro voices manifest not found at {self._voices_path}. "
                "Run server/tts-sidecar/scripts/install-kokoro.ps1 to download weights."
            )

        log.info("Loading Kokoro model=%s voices=%s ...", self._model_path, self._voices_path)
        # kokoro-onnx selects ONNX Runtime providers automatically — CUDA
        # when onnxruntime-gpu is installed, CPU fallback otherwise. We
        # don't pass a providers list explicitly because the constructor
        # signature has shifted across kokoro-onnx releases; the auto-
        # detection has been stable.
        kokoro = Kokoro(self._model_path, self._voices_path)

        # Enumerate the voice manifest. The API has drifted across kokoro-
        # onnx versions: older releases expose `voices` as a dict, newer
        # ones add a `get_voices()` method. Try both; if neither works,
        # log and leave the list empty so /speakers reports nothing rather
        # than crashing the load.
        all_voices: list[str] = []
        try:
            getter = getattr(kokoro, "get_voices", None)
            if callable(getter):
                all_voices = list(getter())
            else:
                voices_attr = getattr(kokoro, "voices", None)
                if isinstance(voices_attr, dict):
                    all_voices = list(voices_attr.keys())
                elif voices_attr is not None:
                    all_voices = list(voices_attr)
        except Exception as e:
            log.warning(
                "Could not enumerate Kokoro voices (%s). /speakers will be empty "
                "and substitution will skip pre-validation.",
                e,
            )
            all_voices = []

        # English-only filter — the load-bearing line that keeps non-
        # English voices out of every downstream consumer.
        self._voices = sorted(
            v for v in all_voices
            if isinstance(v, str) and v.startswith(self.ENGLISH_VOICE_PREFIXES)
        )
        self._kokoro = kokoro
        log.info(
            "Kokoro loaded. English voices: %d (filtered from %d total in manifest).",
            len(self._voices), len(all_voices),
        )

    def unload(self) -> None:
        """Drop the Kokoro model. Idempotent. Kokoro is eagerly preloaded
        at startup so this is rarely called in production — kept for
        symmetry with CoquiEngine and to let tests reset state."""
        if self._kokoro is None:
            return
        self._kokoro = None
        self._voices = []
        log.info("Kokoro model unloaded.")

    def synthesize(self, model: str, voice: str, text: str) -> SynthResult:
        self._ensure_loaded(model)
        assert self._kokoro is not None

        # Pre-flight voice validation. Non-English voice IDs (ef_*, ff_*,
        # etc.) or unknown names fall back to FALLBACK_VOICE. The Node
        # side reads X-Voice-Substituted-From and surfaces a warning so
        # the upstream catalog can be fixed.
        actual_voice = voice
        substituted_from: Optional[str] = None
        if self._voices and voice not in self._voices:
            substituted_from = voice
            actual_voice = (
                self.FALLBACK_VOICE
                if self.FALLBACK_VOICE in self._voices
                else self._voices[0]
            )
            log.warning(
                "Voice '%s' not in Kokoro English subset — substituting '%s'. "
                "Valid sample: %s",
                voice, actual_voice, ", ".join(self._voices[:8]),
            )

        # kokoro-onnx's create() returns (samples, sample_rate). samples is
        # a numpy float32 array in [-1, 1]; sample_rate is the model's
        # native rate (24 kHz for v1). Wrap defensively in case a future
        # release changes the return shape.
        gen_start = time.perf_counter()
        result = self._kokoro.create(
            text,
            voice=actual_voice,
            speed=1.0,
            lang=self._language,
        )
        gen_ms = (time.perf_counter() - gen_start) * 1000.0
        if isinstance(result, tuple) and len(result) == 2:
            audio, sample_rate = result
        else:
            audio = result
            sample_rate = self.NATIVE_SAMPLE_RATE
        audio_ms = _audio_duration_ms(audio, int(sample_rate))
        log.info(
            "kokoro synth: voice=%s text_len=%d gen_ms=%.0f audio_ms=%.0f rtf=%.2f",
            actual_voice, len(text), gen_ms, audio_ms,
            (gen_ms / audio_ms if audio_ms > 0 else 0.0),
        )
        pcm = _float_audio_to_int16_le(audio)
        return SynthResult(
            pcm=pcm,
            sample_rate=int(sample_rate),
            substituted_from=substituted_from,
        )


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


def _audio_duration_ms(audio: Any, sample_rate: int) -> float:
    """Duration in ms of an audio array at the given sample rate. Drives the
    real-time-factor (rtf) perf logs; rtf = gen_ms / audio_ms, so <1 is
    faster-than-realtime synthesis. Frame count is the leading axis (mono
    (n,) or (n, channels))."""
    arr = np.asarray(audio)
    n = arr.shape[0] if arr.ndim >= 1 else 0
    return (n / sample_rate * 1000.0) if sample_rate > 0 else 0.0


class QwenEngine(Engine):
    """Qwen3-TTS as a per-character BESPOKE-voice engine (plan 108).

    Unlike Kokoro (a fixed 28-voice catalog), Qwen voices are DESIGNED once
    from a natural-language persona and then reused consistently across a
    whole book via the official design → clone → cache → reuse recipe:

      1. design  — VoiceDesign model: `generate_voice_design(text, language,
                   instruct)` synthesises a short reference clip that matches
                   a persona like "a warm, gentle teenage girl".
      2. clone   — Base model: `create_voice_clone_prompt(ref_audio, ref_text)`
                   distils that clip into a reusable speaker embedding
                   (x-vector + ICL tokens).
      3. cache   — the prompt object is saved to voices/qwen/<voiceId>.pt with
                   a sidecar <voiceId>.json manifest (instruct/language/ref_text).
      4. reuse   — synth: Base model `generate_voice_clone(text, language,
                   voice_clone_prompt)` re-uses the cached embedding for every
                   sentence, so the voice identity is identical across the book.

    `synthesize(model, voice, text)` treats `voice` as a designed voiceId and
    fails fast if that voice hasn't been designed yet (no profile-inference
    fallback — bespoke voices are explicit). Voice creation is a separate
    operation (`design_voice`, driven by POST /qwen/design-voice).

    Lazy-loaded (opt-in PRELOAD_QWEN=1): a second always-resident engine would
    break the 8 GB VRAM budget the dual-model flag exists to gate. The Base
    model (~1.2 GB) is the resident synth model; the heavier VoiceDesign model
    is loaded transiently only during voice creation and can be evicted after.

    NOTE (empirical verification owed): the exact `qwen_tts` method signatures,
    the clone-prompt object's serialisation, and that a designed preset yields a
    CONSISTENT identity across calls are confirmed against the real weights when
    the model is downloaded (see scripts/install-qwen3.mjs). The integration is
    isolated to the small `_qwen_*` shims below so a signature drift is a
    one-place fix. Output is numpy float → `_float_audio_to_int16_le` like the
    other engines; sample rate comes straight off the model return.
    """

    name = "qwen"

    # Synthesis (clone) model — small, resident. Base variant does the cloning
    # + the per-sentence generate_voice_clone.
    BASE_MODEL = os.environ.get(
        "QWEN_BASE_MODEL", "Qwen/Qwen3-TTS-12Hz-0.6B-Base"
    )
    # Voice-design model — produces the reference clip from a persona. There is
    # no confirmed 0.6B VoiceDesign at time of writing, so default to the 1.7B
    # one; loaded transiently during design only. Override via env once a 0.6B
    # VoiceDesign ships.
    VOICEDESIGN_MODEL = os.environ.get(
        "QWEN_VOICEDESIGN_MODEL", "Qwen/Qwen3-TTS-12Hz-1.7B-VoiceDesign"
    )
    # Default language for English-first books. Per-voice language is stored in
    # each voice's manifest and overrides this at synth time.
    DEFAULT_LANGUAGE = os.environ.get("QWEN_LANGUAGE", "English")
    # Calibration line spoken when designing a voice (gives the model enough
    # phonetic coverage to fix a timbre). Also reused as the audition preview.
    CALIBRATION_TEXT = (
        "The quick brown fox jumps over the lazy dog, "
        "and she wondered what tomorrow would bring."
    )

    def __init__(self) -> None:
        self._base: Any = None  # resident clone/synth model
        self._design: Any = None  # transient voice-design model
        self._loading: bool = False
        self._load_lock: asyncio.Lock = asyncio.Lock()
        self._device = os.environ.get("QWEN_DEVICE", "cuda:0")
        # In-memory designed-voice cache: voiceId -> (clone_prompt, language).
        # Without it every /synthesize re-reads <voiceId>.pt + <voiceId>.json
        # off disk; across a book that's the same two files re-loaded hundreds
        # of times for the same voice. Guarded by a lock because synth runs on
        # asyncio.to_thread worker threads — a double-load on a cold-cache race
        # is harmless, but the lock is cheap and keeps hit/miss accounting honest.
        self._prompt_cache: dict[str, tuple[Any, str]] = {}
        self._cache_lock = threading.Lock()
        # Designed-voice embeddings cache. Default lives next to this file
        # under voices/qwen/ (exact back-compat when QWEN_VOICES_DIR unset).
        # The Node server points QWEN_VOICES_DIR at the per-workspace tree
        # (<workspaceDir>/voices/qwen) so a sidecar restart / cwd change /
        # workspace move can't orphan designed voices (a latent ENOENT on
        # torch.load at synth time).
        legacy_voices_dir = os.path.join(os.path.dirname(__file__), "voices", "qwen")
        self._voices_dir = os.environ.get("QWEN_VOICES_DIR") or legacy_voices_dir
        self._migrate_legacy_voices(legacy_voices_dir)

    # --- qwen_tts integration shims (the only model-API-coupled surface) ---

    def _load_qwen_model(self, model_id: str) -> Any:
        """Load a Qwen3TTSModel. Isolated so the import + from_pretrained
        signature lives in exactly one place.

        Attention impl: the model supports both SDPA and flash-attn but our
        load passed neither, so it resolved to whatever transformers picked
        (often the slow eager path — qwen_tts even warns "Will only run the
        manual PyTorch version" on import when flash-attn is absent). SDPA
        ships inside PyTorch (no extra dependency, builds on Windows) and is
        the right default for the autoregressive decode loop. QWEN_ATTN_IMPL
        overrides it (e.g. "eager" to benchmark the baseline, or
        "flash_attention_2" if a flash-attn wheel is installed).

        Loading is two-tier so the sdpa win can't harden into a load failure:
          1. PREFERRED — request attn_implementation WITHOUT device_map, then
             move the model ourselves. Passing device_map routes the load
             through accelerate's dispatch_model, which leaves attention params
             on the `meta` device when attn_implementation is set and then 500s
             trying to move them ("Cannot copy out of meta tensor"). Without
             device_map every weight is a real tensor, so the (0.6B bf16) model
             moves to the target device cleanly and sdpa is honoured.
          2. FALLBACK — on ANY failure of the fast-path (an old build rejecting
             the kwarg, OR an accelerate/transformers combo that breaks the
             dispatch), retry the proven-good config: device_map + the library
             default attention. The single retry's own error propagates."""
        try:
            import torch  # type: ignore
            from qwen_tts import Qwen3TTSModel  # type: ignore
        except ImportError as e:
            raise RuntimeError(
                f"Failed to import qwen_tts/torch ({e}). Install with: "
                "`.\\.venv\\Scripts\\python.exe -m pip install qwen-tts` in "
                "server/tts-sidecar."
            ) from e
        attn_impl = os.environ.get("QWEN_ATTN_IMPL", "sdpa")
        try:
            model = Qwen3TTSModel.from_pretrained(
                model_id,
                dtype=torch.bfloat16,
                attn_implementation=attn_impl,
            )
            model.to(self._device)
        except Exception as e:
            # Catch broadly: sdpa can be rejected (ValueError/TypeError) OR
            # accepted-then-break dispatch (the meta-tensor NotImplementedError
            # we hit on this box). Either way, fall back to the pre-sdpa load
            # that always worked — device_map dispatch + default (eager) attn.
            log.warning(
                "Qwen load: sdpa fast-path failed (attn_implementation=%r): %s; "
                "falling back to device_map + library-default attention.",
                attn_impl, e,
            )
            model = Qwen3TTSModel.from_pretrained(
                model_id,
                device_map=self._device,
                dtype=torch.bfloat16,
            )
        # Surface the impl that actually took effect (getattr-guarded — the
        # nested attribute path can drift across qwen_tts/transformers versions).
        resolved = getattr(getattr(model, "model", None), "config", None)
        resolved_impl = getattr(resolved, "_attn_implementation", "unknown")
        log.info("Qwen model=%s attn_implementation=%s", model_id, resolved_impl)
        return model

    def _ensure_base_loaded(self) -> None:
        if self._base is None:
            log.info("Loading Qwen Base model=%s on %s …", self.BASE_MODEL, self._device)
            self._base = self._load_qwen_model(self.BASE_MODEL)
            log.info("Qwen Base loaded.")

    def _ensure_design_loaded(self) -> None:
        if self._design is None:
            log.info(
                "Loading Qwen VoiceDesign model=%s on %s (transient) …",
                self.VOICEDESIGN_MODEL, self._device,
            )
            self._design = self._load_qwen_model(self.VOICEDESIGN_MODEL)
            log.info("Qwen VoiceDesign loaded.")

    def _voice_paths(self, voice_id: str) -> tuple[str, str]:
        safe = re.sub(r"[^A-Za-z0-9_.-]", "_", voice_id)
        return (
            os.path.join(self._voices_dir, f"{safe}.pt"),
            os.path.join(self._voices_dir, f"{safe}.json"),
        )

    def _migrate_legacy_voices(self, legacy_dir: str) -> None:
        """One-time move of designed voices from the legacy __file__-relative
        dir into the configured QWEN_VOICES_DIR (the per-workspace tree).

        Runs only when QWEN_VOICES_DIR relocates the cache AND the legacy dir
        actually holds embeddings AND the target is empty/missing — so it's a
        no-op on the back-compat default and after the first migration.
        Fully defensive: any failure is logged and swallowed (never crashes
        startup), because losing the move just falls back to designing the
        voice again, not to a hard error."""
        try:
            if os.path.abspath(self._voices_dir) == os.path.abspath(legacy_dir):
                return  # unset / default — nothing to relocate.
            legacy_pts = (
                [fn for fn in os.listdir(legacy_dir) if fn.endswith(".pt")]
                if os.path.isdir(legacy_dir)
                else []
            )
            if not legacy_pts:
                return  # legacy dir has no designed voices — nothing to move.
            target_has_voices = os.path.isdir(self._voices_dir) and any(
                fn.endswith(".pt") for fn in os.listdir(self._voices_dir)
            )
            if target_has_voices:
                return  # already migrated (or workspace already populated).
            os.makedirs(self._voices_dir, exist_ok=True)
            moved = 0
            for fn in os.listdir(legacy_dir):
                if fn.endswith(".pt") or fn.endswith(".json"):
                    src = os.path.join(legacy_dir, fn)
                    dst = os.path.join(self._voices_dir, fn)
                    if not os.path.exists(dst):
                        shutil.move(src, dst)
                        moved += 1
            log.info(
                "Migrated %d Qwen voice file(s) from legacy %s to %s.",
                moved, legacy_dir, self._voices_dir,
            )
        except Exception as e:  # pragma: no cover - defensive guard
            log.warning("Qwen voice migration skipped (non-fatal): %s", e)

    def unload(self) -> None:
        """Drop both Qwen models and free VRAM. Idempotent."""
        had = self._base is not None or self._design is not None
        self._base = None
        self._design = None
        # Drop cached clone-prompt tensors too: they hold GPU memory and would
        # otherwise survive empty_cache() below, defeating the point of unload.
        with self._cache_lock:
            self._prompt_cache.clear()
        if had:
            try:
                import torch  # type: ignore

                if torch.cuda.is_available():
                    torch.cuda.empty_cache()
            except Exception:
                pass
            log.info("Qwen models unloaded.")

    def unload_design(self) -> None:
        """Drop only the heavy VoiceDesign model after a design pass, keeping
        the resident Base synth model loaded."""
        if self._design is None:
            return
        self._design = None
        try:
            import torch  # type: ignore

            if torch.cuda.is_available():
                torch.cuda.empty_cache()
        except Exception:
            pass
        log.info("Qwen VoiceDesign unloaded (Base stays resident).")

    def list_voices(self) -> list[str]:
        """Designed voice ids = the .json manifests under voices/qwen/."""
        try:
            names = [
                fn[:-5]
                for fn in os.listdir(self._voices_dir)
                if fn.endswith(".json")
            ]
            return sorted(names)
        except FileNotFoundError:
            return []

    def design_voice(
        self, voice_id: str, instruct: str, language: Optional[str], calibration_text: Optional[str]
    ) -> SynthResult:
        """Design + cache a reusable bespoke voice from a persona `instruct`.
        Returns an audition preview (the calibration line spoken in the new
        voice) so the UI can play it back before the user commits."""
        import torch  # type: ignore

        lang = (language or self.DEFAULT_LANGUAGE).strip() or self.DEFAULT_LANGUAGE
        ref_text = (calibration_text or self.CALIBRATION_TEXT).strip() or self.CALIBRATION_TEXT

        self._ensure_design_loaded()
        # 1. design a reference clip from the persona instruction.
        ref_wavs, ref_sr = self._design.generate_voice_design(
            text=ref_text, language=lang, instruct=instruct
        )
        ref_audio = ref_wavs[0]

        # 2. distil into a reusable clone prompt on the Base model.
        self._ensure_base_loaded()
        prompt = self._base.create_voice_clone_prompt(
            ref_audio=(ref_audio, ref_sr), ref_text=ref_text
        )

        # 3. cache prompt + manifest to disk (workspace-shared, keyed by voiceId).
        os.makedirs(self._voices_dir, exist_ok=True)
        pt_path, json_path = self._voice_paths(voice_id)
        torch.save(prompt, pt_path)
        import json as _json

        with open(json_path, "w", encoding="utf-8") as fh:
            _json.dump(
                {
                    "voiceId": voice_id,
                    "instruct": instruct,
                    "language": lang,
                    "refText": ref_text,
                    "baseModel": self.BASE_MODEL,
                    "designModel": self.VOICEDESIGN_MODEL,
                },
                fh,
                ensure_ascii=False,
                indent=2,
            )
        log.info("Designed + cached Qwen voice '%s' (instruct=%r).", voice_id, instruct[:80])

        # Evict any stale in-memory entry so a RE-designed voice can't keep
        # serving the previous embedding — the next synth reloads the fresh
        # .pt we just wrote. (We don't warm it here: the audition preview
        # below uses `prompt` directly, and the first real synth's single
        # disk load is negligible.)
        with self._cache_lock:
            self._prompt_cache.pop(voice_id, None)

        # 4. audition preview — speak the calibration line in the new voice.
        wavs, sr = self._base.generate_voice_clone(
            text=[ref_text], language=[lang], voice_clone_prompt=prompt
        )
        return SynthResult(pcm=_float_audio_to_int16_le(wavs[0]), sample_rate=int(sr))

    def _load_voice_prompt(self, voice: str) -> tuple[Any, str, bool]:
        """Return (clone_prompt, language, cache_hit) for a designed voice.

        Reads <voiceId>.pt + <voiceId>.json off disk only on a cache MISS;
        a hit skips both. Shared by synthesize + synthesize_batch so the
        single- and batched-synth paths can never drift on prompt loading or
        language resolution. Fails fast (no catalog fallback) if the voice
        hasn't been designed. The cache lock is released across the
        torch.load so a slow disk read can't block other threads' lookups —
        a concurrent double-miss just loads twice (benign, same content)."""
        import torch  # type: ignore

        with self._cache_lock:
            cached = self._prompt_cache.get(voice)
        if cached is not None:
            prompt, lang = cached
            return prompt, lang, True

        pt_path, json_path = self._voice_paths(voice)
        if not os.path.isfile(pt_path):
            raise RuntimeError(
                f"Qwen voice '{voice}' has not been designed yet (no cached "
                f"embedding at {pt_path}). Design it first via "
                "POST /qwen/design-voice."
            )
        lang = self.DEFAULT_LANGUAGE
        if os.path.isfile(json_path):
            try:
                import json as _json

                with open(json_path, encoding="utf-8") as fh:
                    lang = _json.load(fh).get("language", lang) or lang
            except Exception:
                pass
        # weights_only=False: the cached prompt is a qwen_tts VoiceClonePromptItem
        # (not a plain tensor), which PyTorch 2.6+'s default safe-unpickler
        # rejects. Safe here — WE wrote this file in design_voice (trusted),
        # it's not untrusted input.
        prompt = torch.load(pt_path, weights_only=False)
        with self._cache_lock:
            self._prompt_cache[voice] = (prompt, lang)
        return prompt, lang, False

    def synthesize(self, model: str, voice: str, text: str) -> SynthResult:
        """`voice` is a designed voiceId. Loads its cached clone prompt and
        reuses it — identical identity across the book. Fails fast (no
        catalog fallback) if the voice hasn't been designed."""
        # Resolve the voice prompt first so an undesigned voice still fails
        # fast WITHOUT paying the (heavy) Base-model load.
        load_start = time.perf_counter()
        prompt, lang, cache_hit = self._load_voice_prompt(voice)
        load_ms = (time.perf_counter() - load_start) * 1000.0

        self._ensure_base_loaded()
        gen_start = time.perf_counter()
        wavs, sr = self._base.generate_voice_clone(
            text=[text], language=[lang], voice_clone_prompt=prompt
        )
        gen_ms = (time.perf_counter() - gen_start) * 1000.0

        audio = wavs[0]
        audio_ms = _audio_duration_ms(audio, int(sr))
        log.info(
            "qwen synth: voice=%s text_len=%d cache=%s load_ms=%.1f "
            "gen_ms=%.0f audio_ms=%.0f rtf=%.2f",
            voice, len(text), "hit" if cache_hit else "miss", load_ms,
            gen_ms, audio_ms, (gen_ms / audio_ms if audio_ms > 0 else 0.0),
        )
        return SynthResult(pcm=_float_audio_to_int16_le(audio), sample_rate=int(sr))

    def synthesize_batch(self, model: str, items: list[dict]) -> SynthBatchResult:
        """TRUE batching (plan 112): synth N sentences in ONE batched forward.

        Each item is `{voice, text}`. We load every item's cached clone prompt
        + manifest language and pass parallel lists to a single
        `generate_voice_clone(text=[…], language=[…], voice_clone_prompt=[…])`
        call, so the model runs one batched forward per decode step instead of
        N separate ones. Two properties make this safe where plan 70d's
        fold-into-one-string was not:
          - each item keeps its OWN prompt → a batch may MIX voices (narrator +
            dialogue) with no cross-bleed;
          - each sentence is an INDEPENDENT sequence (not concatenated text) →
            no shared decode context, so no mid-chunk voice drift.

        Fails fast (RuntimeError naming the item index) if any voice hasn't
        been designed — the whole batch fails and the caller retries / fails
        the chapter exactly as a single call would."""
        if not items:
            raise RuntimeError("synthesize_batch called with no items.")

        texts: list[str] = []
        langs: list[str] = []
        prompts: list[Any] = []
        for i, item in enumerate(items):
            voice = item.get("voice")
            text = item.get("text")
            if not isinstance(voice, str) or not voice:
                raise RuntimeError(f"batch item {i}: `voice` is required.")
            if not isinstance(text, str) or not text.strip():
                raise RuntimeError(f"batch item {i}: `text` is required.")
            try:
                prompt, lang, _cache_hit = self._load_voice_prompt(voice)
            except RuntimeError as e:
                raise RuntimeError(f"batch item {i} (voice={voice!r}): {e}") from e
            texts.append(text)
            langs.append(lang)
            # A designed voice's cached prompt is a LIST of VoiceClonePromptItem
            # (qwen_tts create_voice_clone_prompt's return shape), normally
            # length 1. generate_voice_clone wants a FLAT prompt-item list with
            # one item per text — it does `[it.ref_code for it in items]`
            # internally. Appending the per-voice list verbatim builds a
            # list-of-LISTS, so `it` is a list → "'list' object has no attribute
            # 'ref_code'". Flatten so prompt item i lines up with text i. (The
            # single /synthesize path passes the whole length-1 list for its one
            # text, which is why it never tripped this.)
            prompts.extend(prompt if isinstance(prompt, list) else [prompt])

        self._ensure_base_loaded()
        wavs, sr = self._base.generate_voice_clone(
            text=texts, language=langs, voice_clone_prompt=prompts
        )
        # Hard invariant: one wav per input item, in order. A mismatch means a
        # library API drift — fail loudly rather than silently misalign audio
        # with sentences (which would scramble the chapter).
        if len(wavs) != len(items):
            raise RuntimeError(
                f"generate_voice_clone returned {len(wavs)} wavs for "
                f"{len(items)} items — batch demux would misalign."
            )
        pcms = [_float_audio_to_int16_le(w) for w in wavs]
        return SynthBatchResult(pcms=pcms, sample_rate=int(sr))


ENGINES: dict[str, Engine] = {
    "coqui": CoquiEngine(),
    "kokoro": KokoroEngine(),
    "qwen": QwenEngine(),
}


@app.on_event("startup")
async def _preload_default_engines() -> None:
    """Engine preload at startup.

    Coqui: opt-in via PRELOAD_COQUI=1 (off by default — the in-app Load
    button warms it on demand to avoid eating ~30 s of boot time and ~3 GB
    of VRAM the user may not need yet).

    Kokoro: eager by default (PRELOAD_KOKORO=1), opt-out via
    PRELOAD_KOKORO=0. ~1 s cold start and ~1 GB VRAM make the "always
    loaded" choice cheap, but a Qwen-primary user can free that ~1 GB by
    turning the eager load off — Kokoro then warms on demand on first
    synth (KokoroEngine.synthesize calls _ensure_loaded) or via POST
    /load. Failure-tolerant when eager: if the weights aren't installed
    yet (fresh clone before install-kokoro.ps1 runs), log a warning and
    keep the sidecar alive so the Coqui path still works."""
    if os.environ.get("PRELOAD_COQUI", "0") == "1":
        coqui_model = os.environ.get("PRELOAD_COQUI_MODEL", "xtts_v2")
        coqui = ENGINES.get("coqui")
        if isinstance(coqui, CoquiEngine):
            try:
                log.info("Preloading Coqui (model=%s) at startup…", coqui_model)
                await asyncio.to_thread(coqui._ensure_loaded, coqui_model)
                log.info("Coqui preload complete — /synthesize will respond fast on first call.")
            except Exception as e:
                # Don't crash the process — the user still gets /health and a
                # diagnostic on the first real /synthesize call.
                log.warning("Coqui preload failed (%s). Will retry lazily on first request.", e)
    else:
        log.info("PRELOAD_COQUI is not set — skipping eager Coqui load; use POST /load to warm the model.")

    if _parse_bool(os.environ.get("PRELOAD_KOKORO"), True):
        kokoro = ENGINES.get("kokoro")
        if isinstance(kokoro, KokoroEngine):
            try:
                log.info("Preloading Kokoro at startup…")
                await asyncio.to_thread(kokoro._ensure_loaded, "v1")
                log.info("Kokoro preload complete — /synthesize is hot.")
            except Exception as e:
                log.warning(
                    "Kokoro preload failed (%s). The Coqui path still works; run "
                    "server/tts-sidecar/scripts/install-kokoro.ps1 to install Kokoro weights.",
                    e,
                )
    else:
        log.info("PRELOAD_KOKORO=0 — Kokoro warms on demand on first synth.")

    # Qwen: opt-in via PRELOAD_QWEN=1 (off by default). A second always-resident
    # engine would break the 8 GB VRAM budget the dual-model flag gates, so Qwen
    # warms on demand via POST /load (the Node side loads it when a book uses a
    # Qwen voice and the dual-model flag is on). Only the resident Base model is
    # eagerly warmed here; the VoiceDesign model stays transient.
    if _parse_bool(os.environ.get("PRELOAD_QWEN"), False):
        qwen = ENGINES.get("qwen")
        if isinstance(qwen, QwenEngine):
            try:
                log.info("Preloading Qwen Base at startup (PRELOAD_QWEN=1)…")
                await asyncio.to_thread(qwen._ensure_base_loaded)
                log.info("Qwen Base preload complete.")
            except Exception as e:
                log.warning(
                    "Qwen preload failed (%s). Run "
                    "server/tts-sidecar/scripts/install-qwen3.mjs to install weights; "
                    "the other engines still work.",
                    e,
                )
    else:
        log.info("PRELOAD_QWEN is not set — Qwen warms on demand via POST /load.")


@app.get("/health")
def health() -> dict[str, Any]:
    """Liveness + load-state probe. `model_loaded` / `loading` / `device` let
    the Node proxy render the right state in the Coqui Load/Stop pill;
    `kokoro_loaded` / `kokoro_loading` do the same for the Kokoro pill.
    Both engines' state fan out from this single response so the frontend's
    consolidated useTtsLifecycle hook stays on one /health poll per tick.

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
    # Kokoro load state — `model_loaded` / `loading` above stay Coqui-specific
    # for back-compat (the Node proxy reads them as the Coqui pill's state).
    # Kokoro gets its own pair of fields so the new Kokoro pill (top bar +
    # Generation view) can read it from the same single /health response,
    # preserving the one-poll invariant the consolidated useTtsLifecycle hook
    # enforces.
    kokoro_loaded = False
    kokoro_loading = False
    kokoro = ENGINES.get("kokoro")
    if isinstance(kokoro, KokoroEngine):
        kokoro_loaded = kokoro._kokoro is not None
        kokoro_loading = kokoro._loading
    # Qwen load state — its own pair of fields, same pattern as Kokoro, so the
    # Node proxy + useTtsLifecycle hook read every engine's state off one poll.
    # `_base is not None` is "ready to synth" (the resident clone model);
    # the transient VoiceDesign model isn't surfaced (it's a creation-time detail).
    qwen_loaded = False
    qwen_loading = False
    qwen = ENGINES.get("qwen")
    if isinstance(qwen, QwenEngine):
        qwen_loaded = qwen._base is not None
        qwen_loading = qwen._loading
    return {
        "ok": True,
        "engines": sorted(ENGINES.keys()),
        "model_loaded": model_loaded,
        "loading": loading,
        "kokoro_loaded": kokoro_loaded,
        "kokoro_loading": kokoro_loading,
        "qwen_loaded": qwen_loaded,
        "qwen_loading": qwen_loading,
        "device": device,
        "poisoned": poisoned,
        "poison_reason": poison_reason,
    }


@app.post("/load")
async def load_model(req: Request) -> JSONResponse:
    """Load a TTS engine's model into memory. Idempotent — returns `ready`
    immediately if the model is already resident.

    Body: `{ engine?: 'coqui' | 'kokoro', model?: str }`. `engine` defaults
    to `'coqui'` for back-compat with existing callers; `model` defaults to
    `xtts_v2` for Coqui and `v1` for Kokoro. Each engine has its own
    `_load_lock` so concurrent UI clicks against the same engine serialise,
    but a Coqui load and a Kokoro load can proceed in parallel."""
    try:
        body = await req.json()
    except Exception:
        body = {}
    if not isinstance(body, dict):
        body = {}
    engine_id = body.get("engine")
    if not isinstance(engine_id, str) or engine_id not in {"coqui", "kokoro", "qwen"}:
        engine_id = "coqui"

    if engine_id == "kokoro":
        kokoro = ENGINES.get("kokoro")
        if not isinstance(kokoro, KokoroEngine):
            return JSONResponse(
                {"status": "error", "error": "kokoro engine missing"}, status_code=500
            )
        if kokoro._kokoro is not None:
            return JSONResponse({"status": "ready"})
        async with kokoro._load_lock:
            if kokoro._kokoro is not None:
                return JSONResponse({"status": "ready"})
            kokoro._loading = True
            try:
                await asyncio.to_thread(kokoro._ensure_loaded, "v1")
            except Exception as e:
                log.exception("/load failed (engine=kokoro)")
                return JSONResponse({"status": "error", "error": str(e)}, status_code=500)
            finally:
                kokoro._loading = False
        return JSONResponse({"status": "ready"})

    if engine_id == "qwen":
        qwen = ENGINES.get("qwen")
        if not isinstance(qwen, QwenEngine):
            return JSONResponse(
                {"status": "error", "error": "qwen engine missing"}, status_code=500
            )
        if qwen._base is not None:
            return JSONResponse({"status": "ready"})
        async with qwen._load_lock:
            if qwen._base is not None:
                return JSONResponse({"status": "ready"})
            qwen._loading = True
            try:
                # Warms the resident Base (clone/synth) model only; the heavy
                # VoiceDesign model loads transiently during design_voice.
                await asyncio.to_thread(qwen._ensure_base_loaded)
            except Exception as e:
                log.exception("/load failed (engine=qwen)")
                return JSONResponse({"status": "error", "error": str(e)}, status_code=500)
            finally:
                qwen._loading = False
        return JSONResponse({"status": "ready"})

    model = body.get("model")
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
async def unload_model(req: Request) -> JSONResponse:
    """Drop a TTS engine's loaded model and free GPU memory. Idempotent —
    returns `idle` whether or not the engine had a model resident.

    Body: `{ engine?: 'coqui' | 'kokoro' }`, default `'coqui'`. Coqui unload
    is what the Analysing screen fires automatically to evict TTS before
    warming the analyzer LLM. Kokoro unload is user-triggered via the
    in-app Stop pill (sidecar restart re-loads it via the eager preload
    hook)."""
    try:
        body = await req.json()
    except Exception:
        body = {}
    if not isinstance(body, dict):
        body = {}
    engine_id = body.get("engine")
    if not isinstance(engine_id, str) or engine_id not in {"coqui", "kokoro", "qwen"}:
        engine_id = "coqui"

    if engine_id == "kokoro":
        kokoro = ENGINES.get("kokoro")
        if isinstance(kokoro, KokoroEngine):
            await asyncio.to_thread(kokoro.unload)
        return JSONResponse({"status": "idle"})

    if engine_id == "qwen":
        qwen = ENGINES.get("qwen")
        if isinstance(qwen, QwenEngine):
            await asyncio.to_thread(qwen.unload)
        return JSONResponse({"status": "idle"})

    coqui = ENGINES.get("coqui")
    if isinstance(coqui, CoquiEngine):
        await asyncio.to_thread(coqui.unload)
    return JSONResponse({"status": "idle"})


@app.get("/speakers")
def speakers() -> dict[str, Any]:
    """List the voice names each loaded engine knows about. Used by the
    Node-side base-voices aggregator (server/src/tts/base-voices.ts) to
    populate the cast picker with the live catalog rather than a stale
    hardcoded list. Engine keys are present even when empty (model not
    loaded yet or manifest enumeration failed) so the consumer can tell
    "no voices" from "engine unknown".

    Kokoro's list is the English subset (28 voices) — non-English voices
    are filtered out at engine load time per the project's English-only
    scope."""
    out: dict[str, Any] = {}
    coqui = ENGINES.get("coqui")
    if isinstance(coqui, CoquiEngine):
        out["coqui"] = coqui._speakers
    kokoro = ENGINES.get("kokoro")
    if isinstance(kokoro, KokoroEngine):
        out["kokoro"] = kokoro._voices
    # Qwen's "catalog" is the set of DESIGNED voices (read from the cached
    # manifests under voices/qwen/), not a fixed list — bespoke per-character
    # voices, available even when the model isn't loaded.
    qwen = ENGINES.get("qwen")
    if isinstance(qwen, QwenEngine):
        out["qwen"] = qwen.list_voices()
    return out


@app.post("/qwen/design-voice")
async def qwen_design_voice(req: Request) -> Response:
    """Design + cache a reusable bespoke Qwen voice from a persona, and return
    an audition preview (PCM, same wire shape as /synthesize) of the calibration
    line spoken in the new voice.

    Body: `{ voiceId, instruct, language?, calibrationText? }`. `instruct` is the
    natural-language persona (e.g. "a warm, gentle teenage girl, mid-paced, with
    a hint of anxiety"); the caller composes it from the character's profile.
    Idempotent-ish — re-designing the same voiceId overwrites its embedding."""
    try:
        body = await req.json()
    except Exception:
        raise HTTPException(status_code=400, detail="Body must be JSON.")
    voice_id = body.get("voiceId")
    instruct = body.get("instruct")
    language = body.get("language")
    calibration_text = body.get("calibrationText")
    if not isinstance(voice_id, str) or not voice_id.strip():
        raise HTTPException(status_code=400, detail="`voiceId` is required.")
    if not isinstance(instruct, str) or not instruct.strip():
        raise HTTPException(status_code=400, detail="`instruct` is required.")

    qwen = ENGINES.get("qwen")
    if not isinstance(qwen, QwenEngine):
        return JSONResponse({"detail": "qwen engine missing"}, status_code=500)

    try:
        result = await asyncio.to_thread(
            qwen.design_voice,
            voice_id.strip(),
            instruct.strip(),
            language if isinstance(language, str) else None,
            calibration_text if isinstance(calibration_text, str) else None,
        )
    except Exception as e:
        log.exception("/qwen/design-voice failed (voiceId=%s)", voice_id)
        return JSONResponse({"detail": str(e)}, status_code=500)

    return Response(
        content=result.pcm,
        media_type=f"audio/L16;codec=pcm;rate={result.sample_rate}",
        headers={"X-Sample-Rate": str(result.sample_rate)},
    )


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


@app.post("/synthesize-batch")
async def synthesize_batch(req: Request) -> Response:
    r"""TRUE batching (plan 112) — Qwen-only. Synthesises N sentences in ONE
    batched forward and returns them as a single length-prefixed binary frame:

        {"sampleRate":24000,"lengths":[l0,l1,…]}\n<pcm0><pcm1>…

    The header is one minified-JSON line (newline-free) terminated by the FIRST
    \n; the body is each item's 16-bit LE mono PCM concatenated in item order,
    sliced by `lengths`. Binary (not base64) avoids ~33 % inflation per chapter
    and parses with the Node client's existing arrayBuffer() read."""
    try:
        body = await req.json()
    except Exception:
        raise HTTPException(status_code=400, detail="Body must be JSON.")

    engine_id = body.get("engine")
    model = body.get("model")
    items = body.get("items")

    # Batching is a Qwen-only capability: only generate_voice_clone runs a true
    # batched forward. Coqui/Kokoro have no list API, so the Node side never
    # routes them here (it falls back to per-call /synthesize for them).
    if engine_id != "qwen":
        return JSONResponse(
            {"detail": f"/synthesize-batch is qwen-only, got engine '{engine_id}'."},
            status_code=400,
        )
    if not isinstance(model, str) or not model:
        raise HTTPException(status_code=400, detail="`model` is required.")
    if not isinstance(items, list) or not items:
        raise HTTPException(status_code=400, detail="`items` must be a non-empty list.")
    for i, item in enumerate(items):
        if not isinstance(item, dict):
            raise HTTPException(status_code=400, detail=f"item {i} must be an object.")
        if not isinstance(item.get("voice"), str) or not item["voice"]:
            raise HTTPException(status_code=400, detail=f"item {i}: `voice` is required.")
        if not isinstance(item.get("text"), str) or not item["text"].strip():
            raise HTTPException(status_code=400, detail=f"item {i}: `text` is required.")

    engine = ENGINES["qwen"]

    try:
        # Offload like /synthesize so /health stays responsive while the
        # (potentially multi-second) batched forward runs on a worker thread.
        result = await asyncio.to_thread(engine.synthesize_batch, model, items)
    except Exception as e:
        err_str = str(e)
        # Forensic beacon: model + item count + the failing message. A qwen
        # CUDA error returns a plain 500 (the poison fence is Coqui-only), so
        # the Node side classifies + retries it exactly as a single qwen synth.
        log.exception(
            "batch synth failed (engine=qwen model=%s items=%d): %s",
            model, len(items), err_str,
        )
        return JSONResponse({"detail": err_str}, status_code=500)

    import json as _json

    header = _json.dumps(
        {"sampleRate": result.sample_rate, "lengths": [len(p) for p in result.pcms]},
        separators=(",", ":"),
    )
    frame = header.encode("utf-8") + b"\n" + b"".join(result.pcms)
    return Response(
        content=frame,
        media_type="application/octet-stream",
        headers={"X-Sample-Rate": str(result.sample_rate)},
    )


