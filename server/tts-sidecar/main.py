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
import gc
import hashlib
import json
import logging
import os
import re
import shutil
import threading
import time
from contextlib import contextmanager
from typing import Any, Optional

import numpy as np
from fastapi import FastAPI, HTTPException, Request, Response
from fastapi.responses import JSONResponse

from warning_filters import configure_warning_filters

# Silence the benign-but-scary warnings the Qwen install + first model load
# emit on a clean Windows box (HF Hub symlink warning, SoX-not-found probe,
# transformers flash-attn banner) before anything heavy loads. See
# warning_filters.py for the per-warning rationale.
configure_warning_filters()

# Exposed as module constants so the logging-format regression test can
# assert on the intended format directly, instead of fishing the formatter
# off `logging.getLogger().handlers[0]` — pytest's caplog plugin installs
# its own root handler before `main` is imported, so basicConfig becomes a
# no-op and the handler-0 fishing approach reads pytest's formatter
# instead of ours.
LOG_FORMAT = "%(asctime)s.%(msecs)03d [sidecar] %(message)s"
LOG_DATEFMT = "%Y-%m-%d %H:%M:%S"

# Sidecar /health protocol version. The Node server reads this at startup to
# decide whether an already-listening sidecar is the CURRENT build before it
# reuses it (spawn-sidecar.ts). A stale process (running an older main.py)
# either omits this field entirely or reports a lower number — the server then
# replaces it instead of silently trusting it. BUMP this whenever a /health or
# wire-protocol change makes an older sidecar incompatible with the current
# server. (Plan 135 / side-8 — stale-sidecar incident 2026-05-29.)
SIDECAR_PROTOCOL_VERSION = 1

# fs-1 — informational app version, surfaced in /health for the Node /api/info.
# Rewritten in lockstep with the package.jsons by scripts/bump-version.mjs. A
# fresh clone / older sidecar without version.py falls back to "0.0.0".
try:
    from version import __version__ as __sidecar_version__
except Exception:  # pragma: no cover - version.py always ships in a release
    __sidecar_version__ = "0.0.0"

logging.basicConfig(
    level=logging.INFO,
    format=LOG_FORMAT,
    datefmt=LOG_DATEFMT,
)
log = logging.getLogger("sidecar")


def error_response(e: Exception, log, status: int = 500):
    """Log the full traceback server-side and return a GENERIC error body.

    The response references the exception object zero times — no stringified
    exception, repr, type name or args ever reaches the client (CodeQL
    py/stack-trace-exposure). The reason lives only in the server log.
    """
    log.exception("request failed")
    return JSONResponse({"status": "error", "error": "Internal error."}, status_code=status)


class _DropSubstringLogFilter(logging.Filter):
    """Drop log records whose rendered message contains ``needle``.

    Used to silence ONE benign third-party line during Qwen model load without
    raising the level of (and thus muting real warnings from) the qwen_tts /
    transformers loggers. Backlog item side-5."""

    def __init__(self, needle: str) -> None:
        super().__init__()
        self._needle = needle

    def filter(self, record: logging.LogRecord) -> bool:
        try:
            return self._needle not in record.getMessage()
        except Exception:
            return True


@contextmanager
def _suppress_code_predictor_log():
    """Temporarily drop the benign qwen_tts load line::

        code_predictor_config is None. Initializing code_predictor model with
        default values

    It originates in ``Qwen3TTSTalkerConfig.__init__`` (the installed qwen_tts
    package) at ``from_pretrained`` — HuggingFace config-defaulting at load,
    NOT a per-sentence recompute, so it's noise that reads as alarming (it drew
    the eye during both the plan-108 OOM and the design-timeout debugging). The
    filter attaches to the ROOT handlers (child-logger records propagate there)
    and is removed in ``finally`` so nothing leaks past the load. side-5."""
    flt = _DropSubstringLogFilter("code_predictor_config is None")
    handlers = list(logging.getLogger().handlers)
    for h in handlers:
        h.addFilter(flt)
    try:
        yield
    finally:
        for h in handlers:
            h.removeFilter(flt)


def _apply_torch_perf_flags(torch: Any) -> None:
    """Enable TF32 + high fp32-matmul precision once, idempotently, right
    after torch is imported in a load path.

    Scope note: these flags only affect *fp32* matmuls, so they help Coqui's
    fp32 residual ops but barely touch Qwen, which loads in bfloat16 (see
    `_load_qwen_model`). They are NOT a fix for the dispatch-bound Qwen RTF
    floor — that would need CUDA graphs, which are blocked by Qwen's
    DynamicCache (see docs/tts-performance.md). cudnn.benchmark is
    deliberately left OFF: audiobook input lengths vary wildly, so its
    per-shape autotune re-fires on every new shape and can regress first-hit
    latency. Best-effort — any attribute drift across torch versions is
    swallowed so a model load never fails over a perf knob."""
    try:
        torch.backends.cuda.matmul.allow_tf32 = True
        torch.backends.cudnn.allow_tf32 = True
        torch.set_float32_matmul_precision("high")
        # side-11 probe: optionally disable MKLDNN. The variable-input-shape host
        # leak (committed-private climbs unbounded on variable-length generation,
        # flat on fixed shapes; CUDA flat — pytorch/pytorch #32596) is suspected to
        # be a per-shape CPU MKLDNN workspace (speech_tokenizer / Code2Wav decode
        # run on CPU even though the Qwen forward is on cuda). Disabling MKLDNN
        # kills that workspace at a small CPU-op cost. Default OFF (opt-in) — flip
        # via SIDECAR_DISABLE_MKLDNN once a live A/B proves the slope flattens.
        # Read here (a shared post-import hook) so the env knob applies whichever
        # engine triggers the load. CPU-only flag: a no-op if the leak is on the
        # CUDA allocator side. Inside the same try so attr drift is swallowed.
        if _disable_mkldnn():
            torch.backends.mkldnn.enabled = False
            log.info("torch.backends.mkldnn.enabled = False (SIDECAR_DISABLE_MKLDNN).")
    except Exception as e:  # pragma: no cover - defensive against API drift
        log.warning("Could not apply torch perf flags (%s) — continuing.", e)


app = FastAPI(title="audiobook-generator local TTS sidecar")


# CUDA poison detection — phrases that PyTorch / NVIDIA emit when a kernel
# raises a device-side assert. Once any of these fire, the CUDA context is
# corrupted process-wide; every subsequent CUDA call re-raises the same
# error. We match liberally (any one of these strings is enough) because
# we never want to MISS a poison — over-classifying is harmless (fast-fail
# with a "restart the sidecar" detail is the right UX either way).
_CUDA_POISON_RE = re.compile(
    r"device-side assert|CUDA error|CUDA kernel errors|CUBLAS_STATUS|cublas|"
    r"out of memory.*CUDA|CUDA out of memory|"
    # ROCm/HIP equivalents — under the AMD profile torch reports HIP errors; a
    # poisoned HIP context is just as fatal and needs the same supervised restart.
    r"HIP error|hipError|rocBLAS|hipBLAS|HIP out of memory",
    re.IGNORECASE,
)

# Exit code used to signal "the supervisor (start.ps1's while-loop) should
# restart me — my CUDA context is poisoned and only a fresh process can
# clear it." Picked outside the conventional 0/1/2 range so a normal Ctrl+C
# or syntax error doesn't trigger a respawn. start.ps1 explicitly checks
# for this value; any other exit code breaks the loop and stays down.
_POISON_EXIT_CODE = 42

# Exit code for the host-memory process-recycle (the RSS-ceiling self-restart).
# Distinct from poison only for log clarity — the server's sidecar supervisor
# (srv-15) respawns on ANY unexpected child exit, so the value isn't load-bearing
# the way the poison code was for the (now-retired) start.ps1 supervisor loop.
_RESTART_EXIT_CODE = 43

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


# Process-wide CUDA poison state. The CUDA context is shared by EVERY engine in
# this process, so once any kernel corrupts it (device-side assert, OR a
# context-fatal "CUDA error: unknown error" — see _CUDA_POISON_RE) all
# subsequent CUDA calls re-raise regardless of which engine made them. We
# therefore track poison per-PROCESS, not per-engine: any engine's CUDA failure
# fast-fails every engine AND schedules ONE supervised self-exit so start.ps1
# respawns a fresh process. (This was previously gated to CoquiEngine, which
# left the Qwen default — the common case — wedged: a Qwen CUDA error returned a
# plain 500, never self-exited, and every retry re-hit the dead context.)
_process_poisoned: bool = False
_process_poison_reason: Optional[str] = None
_poison_exit_scheduled: bool = False


def _mark_cuda_poisoned(reason: str) -> None:
    """Flag the process CUDA context as corrupted and schedule the supervised
    exit exactly once. Safe to call from any engine / any concurrent in-flight
    request — the `_poison_exit_scheduled` guard makes the exit single-shot."""
    global _process_poisoned, _process_poison_reason, _poison_exit_scheduled
    _process_poisoned = True
    if _process_poison_reason is None:
        _process_poison_reason = reason
    if not _poison_exit_scheduled:
        _poison_exit_scheduled = True
        _schedule_poison_exit()


def _reset_poison_for_test() -> None:
    """Test-only: clear process poison state so cases don't bleed into each
    other (the flags are module globals that outlive a TestClient)."""
    global _process_poisoned, _process_poison_reason, _poison_exit_scheduled
    _process_poisoned = False
    _process_poison_reason = None
    _poison_exit_scheduled = False


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


# --- Process-memory instrumentation + reclaim (host-RAM leak guard) ---
#
# Added after the 2026-05-30 incident: a long-lived sidecar grew to ~54 GB
# committed-private host RAM, starved the 64 GB box, and the OS killed the Node
# server mid-run (no crash trace). Root cause: PyTorch nn.Module/Parameter
# graphs hold reference CYCLES, so dropping a heavy model (`self._base = None`)
# does NOT refcount-free it — it waits for CPython's cyclic GC, which lags under
# the GIL-contended synth load, so unloaded multi-GB models pile up. The unload
# paths now gc.collect() explicitly; this block gives the watchdog + /debug
# endpoint a host-RAM readout so the curve is observable.
#
# psutil is a hard transitive dep (accelerate → it); declared explicitly in
# requirements.txt so the readout can't silently lose its only RSS source.
# Import is guarded so a stripped install degrades to "no readout" not a crash.
try:
    import psutil  # type: ignore

    _PROC = psutil.Process()
except Exception:  # pragma: no cover - psutil is a hard dep in practice
    psutil = None  # type: ignore
    _PROC = None


def _process_mem() -> dict[str, float]:
    """Process memory snapshot in MB. `rss_mb` is resident set; `private_mb`
    (Windows pmem.private) is committed-private bytes — the TRUE leak signal,
    since it excludes shared libraries and memory-mapped weight files (the
    incident read 54 GB private while the working set sat at 42 GB). Returns {}
    when psutil is unavailable so callers degrade gracefully."""
    if _PROC is None:
        return {}
    try:
        mi = _PROC.memory_info()
        out: dict[str, float] = {
            "rss_mb": mi.rss / 1_000_000.0,
            "vms_mb": mi.vms / 1_000_000.0,
        }
        private = getattr(mi, "private", None)  # Windows-only; absent elsewhere
        if private is not None:
            out["private_mb"] = private / 1_000_000.0
        return out
    except Exception:
        return {}


def _reclaim_host_and_vram() -> None:
    """Full reclaim after a heavy model is dropped. ORDER matters:
      1. gc.collect() FIRST — break the dropped nn.Module's reference cycles so
         its backing host storage is released now, not whenever the lagging
         cyclic collector next runs (the 2026-05-30 leak mechanism).
      2. torch.cuda.empty_cache() SECOND — return the freed GPU tensors' blocks
         from the caching allocator back to the driver.
    Defensive throughout: a torch import / CUDA error must never turn an unload
    (or a watchdog tick) into a failure."""
    gc.collect()
    try:
        import torch  # type: ignore

        if torch.cuda.is_available():
            torch.cuda.empty_cache()
    except Exception:
        pass


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
    body (header line + concatenated PCM).

    gen_ms / audio_ms are the batch's forward-compute wall and the total audio
    it produced — the server reads them off the frame header to surface a LIVE
    per-batch RTF (gen_ms ÷ audio_ms) while a chapter renders, instead of only a
    per-chapter summary."""
    __slots__ = ("pcms", "sample_rate", "gen_ms", "audio_ms")

    def __init__(
        self,
        pcms: list[bytes],
        sample_rate: int,
        gen_ms: float = 0.0,
        audio_ms: float = 0.0,
    ) -> None:
        self.pcms = pcms
        self.sample_rate = sample_rate
        self.gen_ms = gen_ms
        self.audio_ms = audio_ms


class _VdKokoroArbiter:
    """Mutual exclusion between a VoiceDesign forward and Kokoro synths.

    Kokoro runs on onnxruntime-gpu (a separate allocator from torch), so a
    resident Kokoro + Qwen Base + the 1.7B VoiceDesign model oversubscribe an
    8 GB card and spill. This arbiter guarantees the two heaviest-combined ops
    never co-reside: a design waits for in-flight Kokoro synths to drain, then
    blocks new ones until it finishes. Kokoro synths still run concurrently with
    EACH OTHER (a drain-and-lock policy, not writer-priority: a waiting design
    does NOT block new Kokoro synths until it has drained the in-flight ones
    and set `_design_active`), so normal generation is unaffected when no
    design is running. Under a continuous Kokoro stream a design may therefore
    wait up to ~one sentence's duration beyond the last drain point —
    acceptable because designs are rare and brief. Qwen Base generation never touches this
    arbiter, so a Qwen-voiced chapter generates at full speed alongside a design.
    """

    def __init__(self) -> None:
        self._cv = threading.Condition()
        self._kokoro_in_flight = 0
        self._design_active = False

    @contextmanager
    def kokoro_synth(self):
        with self._cv:
            while self._design_active:
                self._cv.wait()
            self._kokoro_in_flight += 1
        try:
            yield
        finally:
            with self._cv:
                self._kokoro_in_flight -= 1
                self._cv.notify_all()

    @contextmanager
    def design(self):
        with self._cv:
            while self._kokoro_in_flight > 0:
                self._cv.wait()
            self._design_active = True
        try:
            yield
        finally:
            with self._cv:
                self._design_active = False
                self._cv.notify_all()


_VD_KOKORO = _VdKokoroArbiter()


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
        # CUDA poison is tracked PROCESS-WIDE (a CUDA context is shared by every
        # engine), not per-engine — see the module-level `_process_poisoned` /
        # `_mark_cuda_poisoned`. Any engine's context-fatal CUDA error fast-fails
        # all engines + schedules one supervised self-exit.

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

        _apply_torch_perf_flags(torch)

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
        # Break the dropped model's reference cycles NOW (see
        # _reclaim_host_and_vram) — nn.Module graphs aren't refcount-freed, and
        # a lagging cyclic GC under load is what leaked host RAM (2026-05-30).
        gc.collect()
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
        # DirectML self-test outcome (AMD-Windows): None when not applicable,
        # 'directml' when the one-time synth proved DML runs the model, or
        # 'fallback-cpu' when it failed and we rebuilt on the CPU EP.
        self._dml_status: Optional[str] = None

    @staticmethod
    def _resolve_ort_providers() -> list[str]:
        """The ONNX Runtime provider list to pass to Kokoro, parsed from the
        KOKORO_ORT_PROVIDERS env var (a JSON string list the server injects from
        the accelerator profile, e.g. ["DmlExecutionProvider","CPUExecutionProvider"]).
        Returns [] when the env is unset/blank/malformed → kokoro-onnx
        auto-detects (today's behaviour)."""
        raw = os.environ.get("KOKORO_ORT_PROVIDERS")
        if not raw:
            return []
        try:
            parsed = json.loads(raw)
        except (ValueError, TypeError):
            return []
        if isinstance(parsed, list) and all(isinstance(p, str) for p in parsed):
            return parsed
        return []

    def _dml_marker_path(self) -> str:
        """Sidecar-side marker recording that the DirectML self-test passed, so
        it runs at most once per install (sits next to the Kokoro weights)."""
        return os.path.join(os.path.dirname(self._model_path), ".kokoro-dml-selftest-ok")

    def _directml_selftest_or_fallback(self, kokoro_cls: Any, kokoro: Any) -> Any:
        """One-time DirectML proof-of-life. Returns the Kokoro instance to keep:
        the DML one if a tiny synth succeeds (and caches a PASS marker), else a
        fresh CPU-EP instance. Sets self._dml_status to 'directml' | 'fallback-cpu'."""
        if os.path.isfile(self._dml_marker_path()):
            self._dml_status = "directml"
            return kokoro
        voice = self._voices[0] if self._voices else self.FALLBACK_VOICE
        try:
            kokoro.create("ok", voice, 1.0, self._language)
        except Exception as e:
            log.warning("Kokoro DirectML self-test failed (%s); falling back to CPU EP.", e)
            self._dml_status = "fallback-cpu"
            try:
                return kokoro_cls(
                    self._model_path, self._voices_path, providers=["CPUExecutionProvider"]
                )
            except TypeError:
                return kokoro_cls(self._model_path, self._voices_path)
        self._dml_status = "directml"
        try:
            with open(self._dml_marker_path(), "w", encoding="utf-8") as f:
                f.write("ok\n")
        except OSError:
            pass
        return kokoro

    def _ensure_loaded(self, model: str) -> None:
        if self._kokoro is not None:
            return
        try:
            from kokoro_onnx import Kokoro  # type: ignore
        except ImportError as e:
            # Profile-aware remediation: the right ONNX-runtime package depends on
            # this box's accelerator profile (injected as CASTWRIGHT_ACCELERATOR_
            # PROFILE), not a hard-coded "needs an NVIDIA GPU".
            profile = os.environ.get("CASTWRIGHT_ACCELERATOR_PROFILE", "nvidia")
            if profile == "amd" and os.name == "nt":
                ort_pkg, ort_note = (
                    "onnxruntime-directml",
                    "onnxruntime-directml runs Kokoro on AMD-Windows via DirectML",
                )
            elif profile == "nvidia":
                ort_pkg, ort_note = (
                    "onnxruntime-gpu",
                    "onnxruntime-gpu needs an NVIDIA GPU",
                )
            else:
                ort_pkg, ort_note = (
                    "onnxruntime",
                    "plain onnxruntime is the CPU / macOS / AMD-Linux runtime",
                )
            raise RuntimeError(
                f"Failed to import kokoro-onnx ({e}). Install with: "
                f"`.\\.venv\\Scripts\\python.exe -m pip install kokoro-onnx {ort_pkg}` "
                f"in server/tts-sidecar (accelerator profile '{profile}': {ort_note})."
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
        # ORT providers: honour the injected KOKORO_ORT_PROVIDERS (the server
        # resolves them from the accelerator profile — e.g. DirectML on
        # AMD-Windows) when present, else let kokoro-onnx auto-detect (CUDA when
        # onnxruntime-gpu is installed, CPU otherwise). The constructor's
        # providers= kwarg has come and gone across kokoro-onnx releases, so a
        # TypeError falls back to the proven no-arg construction.
        providers = self._resolve_ort_providers()
        if providers:
            try:
                kokoro = Kokoro(self._model_path, self._voices_path, providers=providers)
            except TypeError:
                log.warning(
                    "kokoro-onnx ignored providers=%s (older release); using auto-detection.",
                    providers,
                )
                kokoro = Kokoro(self._model_path, self._voices_path)
        else:
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

        # DirectML self-test (AMD-Windows). The Kokoro DML path has a known
        # ConvTranspose risk (spike S0.1, OWED on real AMD hw): prove DML actually
        # runs the model with one tiny synth on first load, and fall back to the
        # CPU EP if it can't — so generation still works (honestly reported as cpu
        # in /health via the session providers). Cached via a marker so later loads
        # skip the ~1 s probe. Only runs when DirectML is in the providers (amd-win);
        # other profiles and a Qwen-only session never reach this (Kokoro unloaded).
        self._dml_status = None
        if "DmlExecutionProvider" in providers:
            kokoro = self._directml_selftest_or_fallback(Kokoro, kokoro)

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
        # Resident-VRAM exclusion: never let this Kokoro forward overlap a
        # VoiceDesign forward (the three-way 8 GB spill). Held around load+create
        # so a design can't evict Kokoro out from under an in-flight synth.
        with _VD_KOKORO.kokoro_synth():
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


def _resolve_torch_device(pref: str, torch_module: Any) -> str:
    """Resolve a QWEN_DEVICE preference to a concrete torch device string.

    'auto' (the default) picks cuda:0 -> mps (Apple Silicon) -> cpu by
    availability. An explicit value (e.g. 'cuda:1', 'cpu', 'mps') is returned
    unchanged so multi-GPU pins and forced devices are respected."""
    p = (pref or "auto").strip().lower()
    if p != "auto":
        return pref
    if torch_module.cuda.is_available():
        return "cuda:0"
    backends = getattr(torch_module, "backends", None)
    mps = getattr(backends, "mps", None) if backends is not None else None
    if mps is not None and mps.is_available():
        return "mps"
    return "cpu"


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
        self._device_pref = os.environ.get("QWEN_DEVICE", "auto")
        # PYTORCH_ENABLE_MPS_FALLBACK lets unsupported mps ops fall back to CPU
        # instead of raising. Read per-op at dispatch, so set it early whenever
        # mps is in play. Concrete device is resolved lazily at load time (torch
        # isn't imported yet here).
        if self._device_pref.strip().lower() in ("auto", "mps") or "mps" in self._device_pref.lower():
            os.environ.setdefault("PYTORCH_ENABLE_MPS_FALLBACK", "1")
        self._device = self._device_pref
        # In-memory designed-voice cache: voiceId -> (clone_prompt, language).
        # Without it every /synthesize re-reads <voiceId>.pt + <voiceId>.json
        # off disk; across a book that's the same two files re-loaded hundreds
        # of times for the same voice. Guarded by a lock because synth runs on
        # asyncio.to_thread worker threads — a double-load on a cold-cache race
        # is harmless, but the lock is cheap and keeps hit/miss accounting honest.
        self._prompt_cache: dict[str, tuple[Any, str]] = {}
        self._cache_lock = threading.Lock()
        # Serialises the GPU model forward. The Qwen Base model's batched
        # `generate_voice_clone` is NOT thread-safe: two overlapping forwards of
        # different batch sizes (which the Node side issues when GPU_VRAM_BUDGET>1
        # runs N workers — e.g. a full batch of 8 overlapping a chapter's 7-item
        # remainder) collide on shared model state and raise "size of tensor a
        # (8) must match tensor b (7)". Synth runs on asyncio.to_thread worker
        # threads, so a plain threading.Lock here serialises same-engine forwards
        # without blocking the event loop (asyncio offload + /health stay live).
        # Per-engine: a concurrent Kokoro synth still runs in parallel (separate
        # engine instance, separate lock). Batching — not concurrency — is the
        # throughput lever on a single autoregressive model anyway.
        self._synth_lock = threading.Lock()
        # Serialises the COLD model load. `_ensure_base_loaded` runs on
        # asyncio.to_thread worker threads (both the synth path and the /load
        # route offload it there), so a plain threading.Lock — NOT the asyncio
        # `_load_lock` above, which a worker thread can't acquire — is what makes
        # the load single-flight. Without it, two workers that both observe
        # `_base is None` on a cold start each call `from_pretrained` +
        # `.to(device)`, and the racing loads leave the model in a half-cast
        # dtype state → every later forward dies with "expected mat1 and mat2 to
        # have the same dtype, float != BFloat16". Double-checked inside.
        self._base_load_lock = threading.Lock()
        # Monotonic timestamp of the last voice-design activity. The startup
        # idle watchdog frees the heavy transient VoiceDesign model once this
        # goes stale (QWEN_DESIGN_IDLE_TTL), so a cast-review session's rapid
        # back-to-back designs stay warm (no reload) while a pause reclaims
        # ~4–5 GB. 0.0 until the first design.
        self._design_last_used: float = 0.0
        # Count of in-flight design_voice() calls. The idle watchdog must NOT
        # free the VoiceDesign model out from under an active design — the
        # plan-161 A/B compare makes the user dwell long enough for the idle TTL
        # to elapse mid-design, and a watchdog free in the unguarded window
        # between _ensure_design_loaded() and the _synth_lock forward nulls
        # `_design` → "'NoneType' object has no attribute 'generate_voice_design'".
        # Incremented at entry / decremented in a finally; `maybe_free_idle_design`
        # bails while it's > 0. Read/written under the GIL (simple int), which is
        # sufficient here: the airtight backstop is the re-ensure under _synth_lock
        # inside design_voice — this guard just stops the wasteful, racy free.
        self._design_in_flight: int = 0
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
        """Load a Qwen3TTSModel onto self._device. Isolated so the import +
        from_pretrained signature lives in exactly one place.

        Two facts about the real qwen_tts API + this transformers/accelerate
        stack drive the load shape (both confirmed against logs/tts.err.log):

          1. `Qwen3TTSModel` is a thin WRAPPER, not an nn.Module — it holds the
             real module at `.model` and caches the device at `.device`. It has
             NO `.to()`, so calling `model.to(device)` raises AttributeError. We
             move `model.model` ourselves and resync `model.device`; the wrapper
             sends generate-time inputs to `self.device`
             (qwen3_tts_model.py: `input_ids.to(self.device)`), so a stale CPU
             value there would mismatch the GPU weights mid-synth.
          2. Passing `device_map` routes the load through accelerate's
             dispatch_model, which on this composite model (talker /
             code_predictor / encoder sub-modules built from default configs)
             leaves some params on the `meta` device and then 500s moving them
             ("Cannot copy out of meta tensor"). We avoid device_map entirely
             and force `low_cpu_mem_usage=False` so every weight materialises as
             a real tensor that `.to()` can move.

        Attention impl defaults to sdpa (PyTorch-native, no extra dep, the right
        default for the autoregressive decode loop); QWEN_ATTN_IMPL overrides it
        (e.g. "eager" to bench the baseline, "flash_attention_2" with a wheel).
        A build that *rejects* the kwarg retries without it — the load never
        hardens into a failure over the attention knob."""
        try:
            import torch  # type: ignore
            from qwen_tts import Qwen3TTSModel  # type: ignore
        except ImportError as e:
            raise RuntimeError(
                f"Failed to import qwen_tts/torch ({e}). Install with: "
                "`.\\.venv\\Scripts\\python.exe -m pip install qwen-tts` in "
                "server/tts-sidecar."
            ) from e
        _apply_torch_perf_flags(torch)
        attn_impl = os.environ.get("QWEN_ATTN_IMPL", "sdpa")
        # low_cpu_mem_usage=False: full CPU materialisation, no meta-device
        # skeleton, so the move below can never hit "copy out of meta tensor".
        common = {"dtype": torch.bfloat16, "low_cpu_mem_usage": False}
        # Reclaim-on-failure (side-11 / 2026-05-31): a load that raises AFTER it
        # has materialised weights — most commonly `inner.to(device)` hitting a
        # CUDA OOM partway through the move when the card is already pressured —
        # leaves a partially-built model whose nn.Module reference CYCLES keep its
        # tensors alive past this failing frame. Refcount alone won't free them
        # (cycles need gc.collect), and `_ensure_*_loaded` never assigned them to
        # `self._base`/`self._design`, so nothing else reclaims either. Repeated
        # failed reloads then accumulate orphaned VRAM (the measured ~9.9 GB
        # CUDA-allocated with `base_loaded=false`). Mirror unload(): drop the
        # partial and run the gc+empty_cache reclaim before re-raising, so a
        # failed (re)load leaves the allocator where it started.
        model: Any = None
        try:
            try:
                with _suppress_code_predictor_log():
                    model = Qwen3TTSModel.from_pretrained(
                        model_id, attn_implementation=attn_impl, **common
                    )
            except (ValueError, TypeError) as e:
                # Only an old transformers/qwen_tts build that doesn't know the
                # kwarg lands here — retry with library-default attention. (A
                # device_map fallback is deliberately NOT used: it is the path that
                # 500s with the meta-tensor NotImplementedError on this stack.)
                log.warning(
                    "Qwen load: attn_implementation=%r rejected (%s); retrying without it.",
                    attn_impl, e,
                )
                with _suppress_code_predictor_log():
                    model = Qwen3TTSModel.from_pretrained(model_id, **common)
            # Move the inner nn.Module to the device and resync the wrapper's cached
            # device (the wrapper has no `.to()` — see docstring point 1).
            inner = getattr(model, "model", None)
            if inner is not None and hasattr(inner, "to"):
                inner.to(self._device)
            else:  # defensive: wrapper-API drift moved the module — move the object.
                model.to(self._device)
            try:
                model.device = torch.device(self._device)
            except Exception:
                pass
            # Surface the impl that actually took effect (getattr-guarded — the
            # nested attribute path can drift across qwen_tts/transformers versions).
            resolved = getattr(getattr(model, "model", None), "config", None)
            resolved_impl = getattr(resolved, "_attn_implementation", "unknown")
            log.info(
                "Qwen model=%s attn_implementation=%s device=%s",
                model_id, resolved_impl, self._device,
            )
            return model
        except Exception:
            model = None
            _reclaim_host_and_vram()
            raise

    def _ensure_device_resolved(self) -> None:
        """Resolve a 'auto' device preference to a concrete torch device once
        torch is importable. Idempotent — an already-concrete self._device (or an
        explicit pref like 'cuda:1'/'cpu'/'mps') is unchanged. Called by BOTH the
        base and design load paths because design_voice loads the VoiceDesign
        model BEFORE the base model, so resolving only in _ensure_base_loaded left
        a design-first cold start doing `.to("auto")`."""
        import torch  # type: ignore
        self._device = _resolve_torch_device(self._device_pref, torch)

    def _ensure_base_loaded(self) -> None:
        # Fast path: already loaded, no lock needed (the assignment below is the
        # only writer and it publishes a fully-built model).
        if self._base is not None:
            return
        # Single-flight the cold load — see `_base_load_lock`. Double-checked so
        # the loser of the race returns the winner's model instead of loading a
        # second copy (which would corrupt the dtype state).
        with self._base_load_lock:
            if self._base is None:
                self._ensure_device_resolved()
                log.info("Loading Qwen Base model=%s on %s …", self.BASE_MODEL, self._device)
                self._base = self._load_qwen_model(self.BASE_MODEL)
                log.info("Qwen Base loaded.")

    def _ensure_design_loaded(self) -> None:
        if self._design is None:
            self._ensure_device_resolved()
            log.info(
                "Loading Qwen VoiceDesign model=%s on %s (transient) …",
                self.VOICEDESIGN_MODEL, self._device,
            )
            self._design = self._load_qwen_model(self.VOICEDESIGN_MODEL)
            global _QWEN_DESIGN_EVER_LOADED
            _QWEN_DESIGN_EVER_LOADED = True
            log.info("Qwen VoiceDesign loaded.")

    def _voice_paths(self, voice_id: str) -> tuple[str, str]:
        # Filename-safe id. For an already-ASCII voice_id this is the identity
        # (so every voice designed before plan 219 keeps its exact filename — no
        # orphaning). When the sanitisation IS lossy — a non-Latin (e.g.
        # Cyrillic) id, where `re.sub` would flatten every char to `_` and two
        # distinct characters could collide on the same file — append a short
        # stable hash of the ORIGINAL id so the mapping stays injective.
        safe = re.sub(r"[^A-Za-z0-9_.-]", "_", voice_id)
        if safe != voice_id:
            digest = hashlib.sha1(voice_id.encode("utf-8")).hexdigest()[:8]
            safe = f"{safe}-{digest}"
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
        """Drop both Qwen models and free VRAM. Idempotent.

        Acquires `_synth_lock` before nulling the models — like `unload_design`,
        and for the same reason. Without it, an `/unload` that lands mid-synth
        nulls `_base` while a clone/synth forward is still running on it; the
        running thread keeps the old model alive past the null, so the
        `gc.collect()`+`empty_cache()` below can't reclaim its VRAM, and the
        next (idempotent) `/load` — seeing `_base is None` — loads a SECOND copy.
        Two copies cross the 8 GB card into the Windows sysmem fallback and the
        GPU thrashes (the 2026-06-01 reload spill). Waiting on the lock lets the
        in-flight forward finish and drop its reference first, so the reload is
        clean. MUST NOT be called while already holding `_synth_lock` (it is a
        non-reentrant threading.Lock) — only the /unload route calls this, and
        it holds no lock."""
        with self._synth_lock:
            had = self._base is not None or self._design is not None
            self._base = None
            self._design = None
            # Drop cached clone-prompt tensors too: they hold GPU memory and
            # would otherwise survive empty_cache() below, defeating the unload.
            with self._cache_lock:
                self._prompt_cache.clear()
        if had:
            # Collect the dropped Base + VoiceDesign reference cycles before
            # reclaiming VRAM — see _reclaim_host_and_vram (2026-05-30 leak).
            _before_reserved = _cuda_vram_mb()[1]
            gc.collect()
            try:
                import torch  # type: ignore

                if torch.cuda.is_available():
                    torch.cuda.empty_cache()
            except Exception:
                pass
            # Log the reserved-VRAM delta so a unload that FAILS to free (an
            # already-spilled/fragmented pool empty_cache can't compact, or a
            # surviving reference) is visible rather than silent — that's the
            # state in which a subsequent /load doubles VRAM. The VRAM watchdog
            # is the backstop: a still-high reserved pool trips its recycle.
            _after_reserved = _cuda_vram_mb()[1]
            if _before_reserved is not None and _after_reserved is not None:
                log.info(
                    "Qwen models unloaded — reserved VRAM %.0f→%.0fMB (freed %.0fMB).",
                    _before_reserved, _after_reserved, _before_reserved - _after_reserved,
                )
            else:
                log.info("Qwen models unloaded.")

    def unload_design(self) -> None:
        """Drop only the heavy VoiceDesign model, keeping the resident Base
        synth model loaded. Lock-guarded so it can't null the model out from
        under a concurrent design/synth forward (which holds `_synth_lock` —
        we wait for it). MUST NOT be called while already holding `_synth_lock`:
        it is a non-reentrant threading.Lock. Idempotent."""
        with self._synth_lock:
            if self._design is None:
                return
            self._design = None
        # The VoiceDesign 1.7B is the heaviest transient model and this fires on
        # the first generation after a design session — collect its cycles
        # before freeing VRAM or the ~3.4 GB host copy lingers (the dominant
        # contributor to the 2026-05-30 54 GB leak: ~15 design cycles × 3.4 GB).
        gc.collect()
        try:
            import torch  # type: ignore

            if torch.cuda.is_available():
                torch.cuda.empty_cache()
        except Exception:
            pass
        log.info("Qwen VoiceDesign unloaded (Base stays resident).")

    def maybe_free_idle_design(self, ttl_seconds: float) -> bool:
        """Free the transient VoiceDesign model when it's been idle longer than
        `ttl_seconds` since the last design. Returns True if it freed. Driven by
        the startup watchdog: rapid back-to-back designs keep it warm (no
        per-design reload — the user's explicit preference), but a quiet pause
        reclaims ~4–5 GB. Cheap no-op when nothing is resident.

        The idle test is re-validated UNDER `_synth_lock` and skipped entirely
        while a design is in flight (`_design_in_flight`), so the watchdog can
        never free `_design` out from under an active design — the plan-161
        race. Nulls `_design` inline rather than calling `unload_design()`
        (which re-acquires the non-reentrant `_synth_lock` → deadlock); the
        gc/empty_cache reclaim runs after the lock is released."""
        # Cheap, lock-free fast-outs first (no model, or recently used).
        if self._design is None or self._design_in_flight > 0:
            return False
        if time.monotonic() - self._design_last_used <= ttl_seconds:
            return False
        # Re-validate under the lock: design_voice refreshes `_design_last_used`
        # and runs its forward while holding `_synth_lock`, so a check that still
        # finds it idle here cannot be mid-forward.
        with self._synth_lock:
            if self._design is None or self._design_in_flight > 0:
                return False
            if time.monotonic() - self._design_last_used <= ttl_seconds:
                return False
            self._design = None
        # Mirror unload_design()'s reclaim: collect the dropped VoiceDesign
        # reference cycles before freeing VRAM (the 2026-05-30 host leak).
        gc.collect()
        try:
            import torch  # type: ignore

            if torch.cuda.is_available():
                torch.cuda.empty_cache()
        except Exception:
            pass
        log.info("Qwen VoiceDesign unloaded (Base stays resident).")
        return True

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
        self, voice_id: str, instruct: str, language: Optional[str], calibration_text: Optional[str], voice_uuid: Optional[str] = None
    ) -> SynthResult:
        """Design + cache a reusable bespoke voice from a persona `instruct`.
        Returns an audition preview (the calibration line spoken in the new
        voice) so the UI can play it back before the user commits."""
        import torch  # type: ignore

        lang = (language or self.DEFAULT_LANGUAGE).strip() or self.DEFAULT_LANGUAGE
        # The reference clip + clone prompt only need a few seconds of
        # phonetically rich audio to fix the voice's timbre — the persona
        # (`instruct`) defines the identity; the words are just a carrier. So
        # voice the SHORT CALIBRATION_TEXT here, never the caller's evidence
        # quote (up to 320 chars). The reference is generated on the heavy 1.7B
        # VoiceDesign model, and voicing a long quote there at design-RTF ~10 is
        # what pushed cold designs past the 120s server budget.
        ref_text = self.CALIBRATION_TEXT
        # The audition preview speaks the caller's own calibration line, so the
        # UI plays back the character's actual words AND the MP3 the design
        # route caches matches the "Play 12s" player's cache key (the server
        # keys it on this exact text). Falls back to CALIBRATION_TEXT when the
        # caller sent nothing.
        audition_text = (calibration_text or self.CALIBRATION_TEXT).strip() or self.CALIBRATION_TEXT

        # Mark the design model active up front AND register an in-flight design
        # so the idle watchdog can't free the VoiceDesign model out from under
        # it. The timestamp alone is a TOCTOU (the watchdog can read a stale value
        # and free in the gap before the _synth_lock forward); `_design_in_flight`
        # + the re-ensure under the lock below close that race. Decremented in the
        # finally so a failure can't leave the guard stuck > 0.
        self._design_last_used = time.monotonic()
        self._design_in_flight += 1
        try:
            # Resident-VRAM exclusion (root fix): a VoiceDesign forward and a
            # Kokoro synth must not co-reside on the 8 GB card. Take the arbiter
            # (waits for any in-flight Kokoro synth to drain, blocks new ones),
            # then evict a resident Kokoro so the 1.7B load has headroom. Kokoro
            # reloads on the next synth (~1s); when no generation ran it isn't
            # resident, so this is a no-op.
            with _VD_KOKORO.design():
                _kokoro_eng = ENGINES.get("kokoro")
                if isinstance(_kokoro_eng, KokoroEngine) and _kokoro_eng._kokoro is not None:
                    log.info("Evicting resident Kokoro to free VRAM for VoiceDesign load.")
                    _kokoro_eng.unload()
                self._ensure_design_loaded()
                self._ensure_base_loaded()
                # Serialise the GPU forwards against any concurrent synth/design — see
                # `_synth_lock` in __init__ (the Base model isn't thread-safe).
                with self._synth_lock:
                    # Re-ensure the models UNDER the lock. Every in-place nuller of
                    # `_design`/`_base` (the idle watchdog, a concurrent
                    # /synthesize's unload_design, a full /unload) holds `_synth_lock`,
                    # so a model ensured before we took the lock may have been freed
                    # in the gap. Re-ensuring here is the airtight backstop against
                    # "'NoneType' object has no attribute 'generate_voice_design'".
                    # Idempotent / a no-op on the warm path; `_ensure_*` don't take
                    # `_synth_lock`, so this can't deadlock.
                    self._ensure_design_loaded()
                    self._ensure_base_loaded()
                    # 1. design a reference clip from the persona instruction.
                    ref_wavs, ref_sr = self._design.generate_voice_design(
                        text=ref_text, language=lang, instruct=instruct
                    )
                    ref_audio = ref_wavs[0]

                    # 2. distil into a reusable clone prompt on the Base model.
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
                        "voiceUuid": voice_uuid,
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

            # 4. audition preview — speak the caller's calibration line in the new
            #    voice (the full evidence quote, NOT the short reference text).
            with self._synth_lock:
                self._ensure_base_loaded()  # re-ensure under the lock — see above
                wavs, sr = self._base.generate_voice_clone(
                    text=[audition_text], language=[lang], voice_clone_prompt=prompt
                )
            # Idle clock starts now (design finished) — back-to-back designs keep
            # the model warm; a pause past the TTL lets the watchdog reclaim it.
            self._design_last_used = time.monotonic()
            return SynthResult(pcm=_float_audio_to_int16_le(wavs[0]), sample_rate=int(sr))
        finally:
            self._design_in_flight -= 1

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
        # Leaving design mode: a real synth means generation/sampling, not
        # designing — free the heavy VoiceDesign model so it can't squeeze
        # generation VRAM. Auditions inside design_voice use _base directly
        # (not synthesize), so the design→refine loop stays warm. No-op once
        # freed. Must precede any _synth_lock acquire (unload_design takes that
        # lock; it is non-reentrant).
        if self._design is not None:
            self.unload_design()
        # Resolve the voice prompt first so an undesigned voice still fails
        # fast WITHOUT paying the (heavy) Base-model load.
        load_start = time.perf_counter()
        prompt, lang, cache_hit = self._load_voice_prompt(voice)
        load_ms = (time.perf_counter() - load_start) * 1000.0

        self._ensure_base_loaded()
        gen_start = time.perf_counter()
        # Serialise the forward — see `_synth_lock` in __init__.
        with self._synth_lock:
            # Re-ensure under the lock: a concurrent /unload (analyzer/XTTS evict)
            # holds `_synth_lock` to null `_base`, so a model ensured before the
            # lock can be gone in the gap. No-op on the warm path.
            self._ensure_base_loaded()
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
        # See synthesize(): a real batch synth means generation, so free the
        # transient VoiceDesign model first (no-op once freed). Before any
        # _synth_lock acquire — the lock is non-reentrant.
        if self._design is not None:
            self.unload_design()
        if not items:
            raise RuntimeError("synthesize_batch called with no items.")

        load_start = time.perf_counter()
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
        load_ms = (time.perf_counter() - load_start) * 1000.0

        self._ensure_base_loaded()
        # Serialise the forward — see `_synth_lock` in __init__. Without this,
        # two concurrent batches of different sizes (e.g. a full 8 overlapping a
        # 7-item remainder, which GPU_VRAM_BUDGET>1 schedules in parallel) race
        # on shared model state → "size of tensor a (8) must match tensor b (7)".
        gen_start = time.perf_counter()
        with self._synth_lock:
            # Re-ensure under the lock — a concurrent /unload holds `_synth_lock`
            # to null `_base`; see synthesize(). No-op on the warm path.
            self._ensure_base_loaded()
            wavs, sr = self._base.generate_voice_clone(
                text=texts, language=langs, voice_clone_prompt=prompts
            )
        gen_ms = (time.perf_counter() - gen_start) * 1000.0
        # Hard invariant: one wav per input item, in order. A mismatch means a
        # library API drift — fail loudly rather than silently misalign audio
        # with sentences (which would scramble the chapter).
        if len(wavs) != len(items):
            raise RuntimeError(
                f"generate_voice_clone returned {len(wavs)} wavs for "
                f"{len(items)} items — batch demux would misalign."
            )
        # Batch-path perf log. The single /synthesize path logs a per-call
        # `qwen synth: … rtf=` line; without a batch equivalent the FAST batched
        # path — the one that actually drives chapter generation — is invisible,
        # so the only rtf in the log is the slow per-sample audition path (~8),
        # not the batched chapter throughput (target ~1). `rtf` here is the
        # AGGREGATE gen_ms / Σ audio_ms over the whole batch (one forward, N
        # sentences) — a throughput figure, not a per-sentence one. Same `rtf=`
        # token as the single line so a grep across the log catches both;
        # `batch synth` vs `synth` distinguishes them.
        audio_ms = sum(_audio_duration_ms(w, int(sr)) for w in wavs)
        n_voices = len({item.get("voice") for item in items})
        log.info(
            "qwen batch synth: items=%d voices=%d text_len=%d load_ms=%.1f "
            "gen_ms=%.0f audio_ms=%.0f rtf=%.2f",
            len(items), n_voices, sum(len(t) for t in texts), load_ms,
            gen_ms, audio_ms, (gen_ms / audio_ms if audio_ms > 0 else 0.0),
        )
        pcms = [_float_audio_to_int16_le(w) for w in wavs]
        return SynthBatchResult(
            pcms=pcms, sample_rate=int(sr), gen_ms=gen_ms, audio_ms=audio_ms
        )


class WhisperEngine:
    """ASR (speech-to-text) for the per-sentence content-QA gate (srv-31).

    Transcribes one synthesised sentence's PCM so the SERVER can word-error-rate
    the transcript against the manuscript text and catch a "fluent but wrong
    words" generation — the one defect class the signal-based segment QA
    (`segment-qa.ts`: dead-RMS / silence-run / duration-drift) provably can't
    see. This engine only TRANSCRIBES; the WER policy lives in TypeScript
    (`segment-asr-qa.ts`) where the expected text + thresholds already are.

    Deliberately NOT in the synth `ENGINES` map: it consumes audio and emits
    text, so it doesn't share the `Engine.synthesize` contract.

    VRAM story (8 GB box): CPU-first by default (`ASR_DEVICE=cpu`) so the
    "every sentence" pass costs ZERO VRAM and never competes with synth on the
    GPU. `ASR_DEVICE=cuda` opts into the GPU — a `tiny`/`base` int8 model is
    only ~150–400 MB, fits the ~1–2 GB generation headroom, and is gated by the
    server's weighted VRAM semaphore (`engine-vram-cost.ts`, cost `asr`) plus
    the idle-evict watchdog below. Decode is deterministic + hallucination-
    resistant (greedy, temperature 0, no cross-sentence carryover, VAD filter)
    so a QA verdict is idempotent run-to-run and Whisper doesn't invent words on
    near-silence.
    """

    name = "whisper"
    # faster-whisper expects 16 kHz mono float32; synth PCM is 24 kHz int16.
    TARGET_SAMPLE_RATE = 16000

    def __init__(self) -> None:
        self._model: Any = None
        self._loading: bool = False
        # Serialises concurrent cold loads (mirrors the synth engines' pattern).
        self._load_lock: asyncio.Lock = asyncio.Lock()
        # CTranslate2 inference isn't guaranteed reentrant; serialise forwards
        # the same way QwenEngine guards its Base model with `_synth_lock`.
        self._infer_lock = threading.Lock()
        # Monotonic timestamp of the last transcribe — drives the idle watchdog.
        self._last_used: float = 0.0
        self._device = (os.environ.get("ASR_DEVICE", "cpu").strip().lower() or "cpu")
        self._model_name = (os.environ.get("ASR_MODEL", "base").strip() or "base")

    def _compute_type(self) -> str:
        """int8 on CPU (fast, tiny); int8_float16 on GPU (small VRAM, fast).
        Override via ASR_COMPUTE_TYPE for a roomier card."""
        default = "int8_float16" if self._device == "cuda" else "int8"
        return (os.environ.get("ASR_COMPUTE_TYPE", default).strip() or default)

    def _ensure_loaded(self) -> None:
        if self._model is not None:
            return
        try:
            from faster_whisper import WhisperModel  # type: ignore
        except ImportError as e:
            raise RuntimeError(
                f"Failed to import faster-whisper ({e}). Install with: "
                "`.\\.venv\\Scripts\\python.exe -m pip install faster-whisper` "
                "in server/tts-sidecar."
            ) from e
        log.info(
            "Loading Whisper ASR model=%s device=%s compute=%s ...",
            self._model_name, self._device, self._compute_type(),
        )
        self._model = WhisperModel(
            self._model_name, device=self._device, compute_type=self._compute_type()
        )
        log.info("Whisper ASR loaded (model=%s device=%s).", self._model_name, self._device)

    @staticmethod
    def _pcm_to_float32_16k(pcm: bytes, sample_rate: int) -> Any:
        """int16 LE mono PCM → float32 [-1, 1] resampled to 16 kHz. Linear
        interpolation is plenty for ASR and avoids a scipy dependency."""
        import numpy as np  # type: ignore

        samples = np.frombuffer(pcm, dtype="<i2").astype(np.float32) / 32768.0
        if sample_rate != WhisperEngine.TARGET_SAMPLE_RATE and samples.size > 0:
            duration = samples.size / float(sample_rate)
            target_n = int(round(duration * WhisperEngine.TARGET_SAMPLE_RATE))
            if target_n > 0:
                src = np.linspace(0.0, samples.size - 1, target_n)
                samples = np.interp(src, np.arange(samples.size), samples).astype(np.float32)
        return samples

    def transcribe(
        self, pcm: bytes, sample_rate: int, language: Optional[str] = None
    ) -> dict[str, Any]:
        """Transcribe one sentence's PCM. Returns the text plus Whisper's
        intrinsic signals — `avg_logprob` (lower = less confident),
        `no_speech_prob` (higher = more likely silence), `compression_ratio`
        (higher = repetition/loop hallucination) — aggregated worst-case across
        segments so the server can tell "audio is wrong" from "transcript is
        untrustworthy" without re-deriving them."""
        self._ensure_loaded()
        assert self._model is not None
        audio = self._pcm_to_float32_16k(pcm, sample_rate)
        with self._infer_lock:
            self._last_used = time.monotonic()
            segments, info = self._model.transcribe(
                audio,
                language=language,
                beam_size=1,                     # greedy
                temperature=0.0,                 # deterministic → idempotent verdicts
                condition_on_previous_text=False,  # no cross-sentence carryover hallucination
                vad_filter=True,                 # drop non-speech so silence isn't "transcribed"
            )
            segs = list(segments)
        text = " ".join((s.text or "").strip() for s in segs).strip()
        logprobs = [s.avg_logprob for s in segs if s.avg_logprob is not None]
        no_speech = [s.no_speech_prob for s in segs if s.no_speech_prob is not None]
        compression = [s.compression_ratio for s in segs if s.compression_ratio is not None]
        return {
            "text": text,
            "language": getattr(info, "language", language),
            # Worst-case aggregation: the weakest segment governs the verdict.
            "avg_logprob": (min(logprobs) if logprobs else None),
            "no_speech_prob": (max(no_speech) if no_speech else None),
            "compression_ratio": (max(compression) if compression else None),
        }

    def unload(self) -> bool:
        """Drop the model + reclaim. Idempotent. Returns True iff a model was
        actually freed (so the watchdog can log only real frees)."""
        if self._model is None:
            return False
        self._model = None
        _reclaim_host_and_vram()
        log.info("Whisper ASR model unloaded.")
        return True

    def maybe_free_idle(self, ttl_seconds: float) -> bool:
        """Free the model once it has idled past the TTL — mirrors
        `QwenEngine.maybe_free_idle_design`. Matters mainly on the cuda path
        (reclaims VRAM); on cpu it just frees host RAM. No-op while in use."""
        if self._model is None:
            return False
        if self._last_used and (time.monotonic() - self._last_used) < ttl_seconds:
            return False
        return self.unload()


# ASR is a standalone singleton (not a synth `Engine`) — audio in, text out.
ASR = WhisperEngine()


class SpeakerEngine:
    """ECAPA-TDNN speaker embedding (srv-36). Defaults to CPU (zero VRAM); the
    optional cuda path (srv-47, SPK_DEVICE=cuda) is VRAM-semaphore-gated on the
    Node side and idle-evicted here. NOT in the synth ENGINES map — like
    WhisperEngine it consumes audio and emits a vector."""
    TARGET_SR = 16000

    def __init__(self):
        self._model = None
        self._load_lock = asyncio.Lock()
        self._infer_lock = threading.Lock()
        # Monotonic timestamp of the last embed — drives the idle watchdog.
        self._last_used: float = 0.0
        self.device = os.environ.get("SPK_DEVICE", "cpu")

    def _load_on(self, device: str):
        """Synchronous ECAPA load on a concrete device. Run via to_thread."""
        from speechbrain.inference.speaker import EncoderClassifier
        return EncoderClassifier.from_hparams(
            source="speechbrain/spkrec-ecapa-voxceleb",
            run_opts={"device": device},
        )

    async def ensure_loaded(self):
        if self._model is not None:
            return
        async with self._load_lock:
            if self._model is not None:
                return
            # srv-47: a requested cuda device that isn't actually present
            # degrades to cpu rather than crashing.
            if self.device == "cuda":
                try:
                    import torch  # type: ignore
                    if not torch.cuda.is_available():
                        log.warning("SPK_DEVICE=cuda but no CUDA device — using cpu.")
                        self.device = "cpu"
                except Exception:
                    self.device = "cpu"
            try:
                self._model = await asyncio.to_thread(self._load_on, self.device)
            except Exception as e:
                # A poison-class load failure corrupts the shared CUDA context —
                # re-raise so the /embed fence marks poison + recycles. Any other
                # cuda failure (cuDNN/driver mismatch on a "present" GPU) demotes
                # to cpu once and reloads.
                if self.device == "cuda" and not _CUDA_POISON_RE.search(f"{e}"):
                    log.warning("ECAPA cuda load failed (%s) — demoting to cpu.", e)
                    self.device = "cpu"
                    self._model = await asyncio.to_thread(self._load_on, self.device)
                else:
                    raise

    def embed(self, pcm: bytes, sample_rate: int) -> list[float]:
        if self._model is None:
            raise RuntimeError("call await ensure_loaded() before embed()")
        import torch
        audio = np.frombuffer(pcm, dtype="<i2").astype(np.float32) / 32768.0
        if sample_rate != self.TARGET_SR:  # numpy resample (no torchaudio dep)
            n = int(round(len(audio) * self.TARGET_SR / sample_rate))
            audio = np.interp(np.linspace(0, len(audio), n, endpoint=False),
                              np.arange(len(audio)), audio).astype(np.float32)
        t = torch.from_numpy(audio).unsqueeze(0)
        with self._infer_lock, torch.no_grad():
            emb = self._model.encode_batch(t).squeeze().cpu().numpy().astype(np.float32)
        self._last_used = time.monotonic()
        norm = float(np.linalg.norm(emb))
        return (emb / norm if norm > 0 else emb).tolist()

    def unload(self) -> bool:
        """Drop the model + reclaim. Idempotent. Returns True iff a model was
        actually freed (so the watchdog can log only real frees)."""
        if self._model is None:
            return False
        self._model = None
        _reclaim_host_and_vram()
        log.info("ECAPA speaker model unloaded.")
        return True

    def maybe_free_idle(self, ttl_seconds: float) -> bool:
        """Free the model once it has idled past the TTL. Reclaims VRAM only on
        the cuda path — a NO-OP on cpu, where the ~1 s reload churn isn't worth
        freeing ~80–200 MB of host RAM. No-op while recently used."""
        if self.device != "cuda" or self._model is None:
            return False
        if self._last_used and (time.monotonic() - self._last_used) < ttl_seconds:
            return False
        return self.unload()


# SPK is a standalone singleton (not a synth `Engine`) — audio in, embedding out.
SPK = SpeakerEngine()


ENGINES: dict[str, Engine] = {
    "coqui": CoquiEngine(),
    "kokoro": KokoroEngine(),
    "qwen": QwenEngine(),
}


# Default seconds of voice-design inactivity before the watchdog frees the
# transient Qwen VoiceDesign model. Override via QWEN_DESIGN_IDLE_TTL.
_DESIGN_IDLE_TTL_DEFAULT = 120.0
# Handle to the background idle watchdog task so shutdown can cancel it.
_design_idle_task: "Optional[asyncio.Task[None]]" = None
# fs-45 v1 — one-way, process-lifetime flag. Set the first time VoiceDesign is
# loaded; the sticky CUDA reserved pool stays design-sized afterward, so the
# Node telemetry only samples qwen:synth/coqui from a process where this is False.
_QWEN_DESIGN_EVER_LOADED = False


def _design_idle_ttl() -> float:
    """Resolve QWEN_DESIGN_IDLE_TTL (seconds) with a safe default + floor. A
    zero/negative/tiny TTL would thrash (free immediately, reload next design),
    defeating warm reuse — clamp to the default below the 5 s floor."""
    try:
        ttl = float(os.environ.get("QWEN_DESIGN_IDLE_TTL", _DESIGN_IDLE_TTL_DEFAULT))
    except (TypeError, ValueError):
        return _DESIGN_IDLE_TTL_DEFAULT
    return ttl if ttl >= 5.0 else _DESIGN_IDLE_TTL_DEFAULT


async def _qwen_design_idle_watchdog() -> None:
    """Periodically free each Qwen engine's transient VoiceDesign model once it
    has idled past the TTL — reclaiming ~4–5 GB after a cast-review session goes
    quiet, while leaving rapid back-to-back designs warm (the user's stated
    preference). The free runs in a worker thread (unload_design waits on the
    engine's threading `_synth_lock`) so the event loop and /health stay live."""
    ttl = _design_idle_ttl()
    interval = min(30.0, max(5.0, ttl / 4))
    while True:
        try:
            await asyncio.sleep(interval)
            for engine in ENGINES.values():
                if isinstance(engine, QwenEngine):
                    freed = await asyncio.to_thread(engine.maybe_free_idle_design, ttl)
                    if freed:
                        log.info("Qwen VoiceDesign freed after >%.0fs idle (watchdog).", ttl)
        except asyncio.CancelledError:
            raise
        except Exception as e:  # a watchdog must never die on a transient error
            log.warning("Qwen design idle watchdog tick failed (%s).", e)


@app.on_event("startup")
async def _start_design_idle_watchdog() -> None:
    """Launch the Qwen VoiceDesign idle watchdog (see _qwen_design_idle_watchdog)."""
    global _design_idle_task
    _design_idle_task = asyncio.create_task(_qwen_design_idle_watchdog())
    log.info("Qwen VoiceDesign idle watchdog started (ttl=%.0fs).", _design_idle_ttl())


@app.on_event("shutdown")
async def _stop_design_idle_watchdog() -> None:
    global _design_idle_task
    if _design_idle_task is not None:
        _design_idle_task.cancel()
        try:
            await _design_idle_task
        except asyncio.CancelledError:
            pass
        _design_idle_task = None


# Default seconds of ASR inactivity before the watchdog frees the Whisper model
# (srv-31). Mirrors the Qwen VoiceDesign idle-evict. Mainly reclaims VRAM on the
# ASR_DEVICE=cuda path; on cpu it just frees host RAM. Override via ASR_IDLE_TTL.
_ASR_IDLE_TTL_DEFAULT = 120.0
_asr_idle_task: "Optional[asyncio.Task[None]]" = None


def _asr_idle_ttl() -> float:
    """Resolve ASR_IDLE_TTL (seconds) with a safe default + 5 s floor — a tiny
    TTL would thrash (free immediately, reload next sentence), defeating the
    warm-across-a-chapter reuse the per-sentence pass relies on."""
    try:
        ttl = float(os.environ.get("ASR_IDLE_TTL", _ASR_IDLE_TTL_DEFAULT))
    except (TypeError, ValueError):
        return _ASR_IDLE_TTL_DEFAULT
    return ttl if ttl >= 5.0 else _ASR_IDLE_TTL_DEFAULT


async def _asr_idle_watchdog() -> None:
    """Free the Whisper ASR model once it idles past the TTL — reclaims VRAM
    (cuda path) / host RAM (cpu) between chapters without churning it mid-pass.
    The free runs on a worker thread so the event loop and /health stay live."""
    ttl = _asr_idle_ttl()
    interval = min(30.0, max(5.0, ttl / 4))
    while True:
        try:
            await asyncio.sleep(interval)
            freed = await asyncio.to_thread(ASR.maybe_free_idle, ttl)
            if freed:
                log.info("Whisper ASR freed after >%.0fs idle (watchdog).", ttl)
        except asyncio.CancelledError:
            raise
        except Exception as e:  # a watchdog must never die on a transient error
            log.warning("ASR idle watchdog tick failed (%s).", e)


@app.on_event("startup")
async def _start_asr_idle_watchdog() -> None:
    global _asr_idle_task
    _asr_idle_task = asyncio.create_task(_asr_idle_watchdog())
    log.info("Whisper ASR idle watchdog started (ttl=%.0fs).", _asr_idle_ttl())


@app.on_event("shutdown")
async def _stop_asr_idle_watchdog() -> None:
    global _asr_idle_task
    if _asr_idle_task is not None:
        _asr_idle_task.cancel()
        try:
            await _asr_idle_task
        except asyncio.CancelledError:
            pass
        _asr_idle_task = None


@app.on_event("startup")
async def _start_device_probe() -> None:
    """side-14 — resolve per-engine devices in the background. Runs on a worker
    thread (torch import takes seconds); /health reports devices_state='pending'
    until it lands. Fire-and-forget: a probe failure degrades to 'error'."""
    asyncio.create_task(asyncio.to_thread(_run_device_probe))


# --- Host-memory watchdog: soft reclaim + hard process-recycle ---
#
# Logs process RSS each tick (the leak curve — greppable as `sidecar memory:`).
# Two thresholds:
#   * SOFT (SIDECAR_RSS_WARN_MB): force a gc+empty_cache. This reclaims the
#     design-cycle leak (plan 141) but NOT the dominant leak — confirmed
#     2026-05-30: the real driver is VARIABLE-INPUT-SHAPE host-workspace
#     accumulation during generation (fixed-shape batches hold flat; variable
#     ones climb the floor unbounded; CUDA stays flat — pytorch #32596 / the
#     Qwen-leak research report). gc/empty_cache reclaim ~0 against it.
#   * HARD (SIDECAR_RESTART_MB): self-exit so the server's sidecar supervisor
#     (srv-15) respawns a FRESH process — the report-endorsed "process recycling"
#     mitigation, the only thing that reliably bounds a native variable-shape
#     host leak. srv-16 (skip-completed-on-resume) means only the single in-flight
#     chapter re-renders. Keyed on COMMITTED-PRIVATE bytes, not RSS: that's the
#     OOM-relevant metric — the 2026-05-30 crash was ~54 GB committed-private on a
#     64 GB box while RSS lagged ~1.7-1.9x lower, so an RSS-keyed ceiling would
#     have fired too late (private hits the cliff long before RSS reaches it).
#     (This replaces the earlier "never self-exit" stance, correct ONLY before
#     srv-15 added respawn — a bare exit used to just stall the run.)
_MEM_WATCHDOG_INTERVAL = 60.0  # how often to LOG the memory line + run the reclaim
# How often to SAMPLE + evaluate the ceilings — finer than the log cadence so a
# transient committed spike between batches (the leak oscillates ~8→39 GB per
# batch) is OBSERVED and trips the soft recycle promptly, instead of a
# once-a-minute sample landing in a trough and missing it (the 2026-06-02 run
# grazed the soft ceiling for minutes without ever flipping recycle_pending).
_MEM_WATCHDOG_SAMPLE_INTERVAL = 15.0
_mem_watchdog_task: "Optional[asyncio.Task[None]]" = None
_restart_scheduled = False
# srv-17c — drain-before-recycle. `_restart_pending` flips True the moment a
# recycle is scheduled; while it's set, /synthesize + /synthesize-batch fast-fail
# with a (non-poisoned) 503 so no NEW chapter enters the dying process and the
# server's in-worker recovery rides out the respawn. `_inflight_synth` counts
# live synth calls (incremented on the event loop around each to_thread offload);
# the recycle drains it to 0 (bounded by SIDECAR_DRAIN_GRACE_MS) before exiting so
# the in-flight chapter finishes here instead of failing. Both are read by the
# drain thread — a plain int read is atomic under the GIL, eventual consistency
# is all the drain needs.
_restart_pending = False
_inflight_synth = 0
# side-11 item 2 — SOFT recycle signal. Set True by the watchdog once committed
# crosses SIDECAR_RECYCLE_SOFT_MB (below the HARD SIDECAR_RESTART_MB ceiling).
# Advisory only: it does NOT drain or exit — it is surfaced in /health so the
# generation worker can trigger a CLEAN recycle (POST /recycle) at the next
# chapter boundary, before the hard watchdog would fire mid-chapter. Plain bool
# read under the GIL, no lock (same reasoning as _restart_pending above).
_recycle_pending = False


def _disable_mkldnn() -> bool:
    """Whether to set `torch.backends.mkldnn.enabled = False` at model load
    (side-11 variable-shape host-leak probe — see `_apply_torch_perf_flags`).
    Default OFF (opt-in); `SIDECAR_DISABLE_MKLDNN` in {1,true,yes,on} enables it,
    anything else (incl. garbage) keeps it off."""
    raw = os.environ.get("SIDECAR_DISABLE_MKLDNN", "").strip().lower()
    return raw in ("1", "true", "yes", "on")


def _mem_warn_threshold_mb() -> float:
    """RSS (MB) above which the watchdog forces a gc+empty_cache reclaim + warns.
    Default 8192. Override SIDECAR_RSS_WARN_MB; <=0 keeps per-tick logging but
    disables the (largely futile against the variable-shape leak) reclaim."""
    try:
        return float(os.environ.get("SIDECAR_RSS_WARN_MB", "8192"))
    except (TypeError, ValueError):
        return 8192.0


def _process_commit_mb() -> Optional[float]:
    """Committed-private memory in MB — the OOM-relevant metric the recycle keys
    on. The 2026-05-30 crash was ~54 GB committed-private on a 64 GB box while RSS
    sat ~1.7-1.9x lower, so keying on RSS would fire too late. Windows:
    pmem.private. Elsewhere: memory_full_info().uss (the cross-platform private
    analog). None when unavailable — the caller falls back to RSS."""
    if _PROC is None:
        return None
    try:
        private = getattr(_PROC.memory_info(), "private", None)  # Windows pmem.private
        if private is not None:
            return private / 1_000_000.0
    except Exception:
        pass
    try:
        return _PROC.memory_full_info().uss / 1_000_000.0  # Linux / macOS
    except Exception:
        return None


def _cuda_vram_mb() -> tuple[Optional[float], Optional[float], Optional[float]]:
    """(allocated, reserved, total) device VRAM in MB, or (None, None, None) when
    CUDA is unavailable. `reserved` is the caching allocator's footprint — the
    metric the VRAM recycle keys on. On Windows torch has no `expandable_segments`
    (logged at load), so a fragmented reserved pool that creeps past the physical
    card spills into the NVIDIA sysmem fallback and collapses RTF; `empty_cache()`
    can't compact it back, so only a fresh process resets it. That's why a
    reserved-VRAM ceiling (not allocated) is the right recycle trigger.

    Vendor-neutral (AMD phase 2): a ROCm torch build reports `torch.cuda.is_
    available()` True (HIP aliases the CUDA API), so memory_reserved /
    get_device_properties read the AMD card and the VRAM recycle protects ROCm
    boxes the same as NVIDIA. A box with no torch-visible GPU (DirectML-only, or
    torch CUDA/ROCm unavailable) returns (None, None, None) → the ceilings below
    derive to 0 (disabled) and the host-RAM watchdog governs instead (the
    unknown-VRAM fail-safe — never guess a ceiling that could fire on a healthy box)."""
    try:
        import torch  # type: ignore

        if not torch.cuda.is_available():
            return (None, None, None)
        allocated = torch.cuda.memory_allocated() / 1_000_000.0
        reserved = torch.cuda.memory_reserved() / 1_000_000.0
        total = torch.cuda.get_device_properties(0).total_memory / 1_000_000.0
        return (allocated, reserved, total)
    except Exception:
        return (None, None, None)


# Reserved-VRAM recycle fractions of device total (defaults; absolute MB env
# overrides below). Soft flags a clean boundary recycle; hard self-exits. Both
# key on RESERVED crossing the card — the spill trigger on Windows.
_VRAM_SOFT_FRACTION = 0.90
_VRAM_HARD_FRACTION = 0.98


def _vram_recycle_soft_threshold_mb(total_mb: Optional[float]) -> float:
    """Reserved-VRAM (MB) at which the watchdog sets `recycle_pending` (the SAME
    flag the host soft-recycle uses, so the server's chapter-boundary recycle
    fires unchanged). Default = `_VRAM_SOFT_FRACTION` × device total (auto-scales
    to the card). Override SIDECAR_VRAM_RECYCLE_SOFT_MB (absolute MB);
    <=0 / garbage with no readable total → 0 (disabled)."""
    env = os.environ.get("SIDECAR_VRAM_RECYCLE_SOFT_MB")
    if env is not None:
        try:
            return float(env)
        except (TypeError, ValueError):
            pass
    if total_mb and total_mb > 0:
        return _VRAM_SOFT_FRACTION * total_mb
    return 0.0


def _vram_restart_threshold_mb(total_mb: Optional[float]) -> float:
    """Reserved-VRAM (MB) HARD ceiling → self-exit (code 43) so the supervisor
    respawns a fresh CUDA context (the only thing that resets a spilled pool).
    Default = `_VRAM_HARD_FRACTION` × device total. Override
    SIDECAR_VRAM_RESTART_MB (absolute MB); <=0 / garbage with no readable
    total → 0 (disabled)."""
    env = os.environ.get("SIDECAR_VRAM_RESTART_MB")
    if env is not None:
        try:
            return float(env)
        except (TypeError, ValueError):
            pass
    if total_mb and total_mb > 0:
        return _VRAM_HARD_FRACTION * total_mb
    return 0.0


def _mem_restart_threshold_mb() -> float:
    """Committed-private (MB) at which the sidecar self-exits for the supervisor
    to respawn it (process recycling). Default = 70% of total physical RAM so it
    scales with the box (~45 GB on 64 GB) — below the ~85% commit cliff that
    crashed the run on 2026-05-30 (private ~54 GB), with margin for the watchdog's
    60 s sampling. Override SIDECAR_RESTART_MB (absolute MB); <=0 disables
    recycling. Returns 0 (disabled) when psutil can't read total RAM and no
    override is set — never guess a ceiling that might fire on a healthy box."""
    env = os.environ.get("SIDECAR_RESTART_MB")
    if env is not None:
        try:
            return float(env)
        except (TypeError, ValueError):
            pass
    if psutil is not None:
        try:
            return 0.70 * psutil.virtual_memory().total / 1_000_000.0
        except Exception:
            return 0.0
    return 0.0


def _mem_recycle_soft_threshold_mb() -> float:
    """Committed-private (MB) at which the sidecar sets `recycle_pending` in
    /health (the side-11 item-2 SOFT signal — does NOT exit). The generation
    worker reads it and triggers a CLEAN recycle at the next chapter boundary,
    so the recycle lands between chapters and EARLIER than the hard ceiling
    (sustained RTF). Default 0 (DISABLED) — opt-in until a live GPU run tunes it
    (same default-OFF convention as SIDECAR_DISABLE_MKLDNN). Override
    SIDECAR_RECYCLE_SOFT_MB (absolute MB); <=0 / garbage → 0 (disabled).
    Recommended live value: a few GB below SIDECAR_RESTART_MB."""
    try:
        return float(os.environ.get("SIDECAR_RECYCLE_SOFT_MB", "0"))
    except (TypeError, ValueError):
        return 0.0


def _should_restart(commit_mb: float, threshold_mb: float) -> bool:
    """Pure decision: recycle when a positive ceiling is set and committed
    memory meets it."""
    return threshold_mb > 0 and commit_mb >= threshold_mb


def _should_soft_recycle(commit_mb: float, soft_mb: float, hard_mb: float) -> bool:
    """Pure decision for the SOFT recycle signal (side-11 item 2): flag a
    pending recycle when a positive soft ceiling is set and committed meets it,
    but ONLY while still below the hard ceiling. At/above the hard ceiling the
    watchdog's existing hard branch owns the exit, so the two thresholds never
    race."""
    return soft_mb > 0 and commit_mb >= soft_mb and not _should_restart(commit_mb, hard_mb)


def _restart_now() -> None:  # pragma: no cover - hard process exit; patched in tests
    os._exit(_RESTART_EXIT_CODE)


def _drain_grace_ms() -> int:
    """Max ms to wait for in-flight synth to drain before a recycle self-exit
    (srv-17c). Default 180000 — comfortably covers a long chapter so the
    in-flight one finishes here instead of failing on the server. 0 disables
    draining → immediate exit (the pre-srv-17c behaviour). Override
    SIDECAR_DRAIN_GRACE_MS; garbage falls back to the default."""
    try:
        return int(os.environ.get("SIDECAR_DRAIN_GRACE_MS", "180000"))
    except (TypeError, ValueError):
        return 180000


# side-13 — cap synth input length. The server sends one item per sentence, so a
# real payload is a few hundred chars; a pathological item (a manuscript-parse
# bug, a run-on "sentence", or a degenerate back-matter blob) can drive unbounded
# CPU/VRAM and hang the synth call for the full 600s server timeout (the
# 2026-05-31 ch29 ChapterSynthTimeoutError). A generous cap fails such input FAST
# with a 400 (non-transient → the server skips the chapter) instead of a 10-min
# hang, and the 400 carries the offending length so the bad input is identifiable.
_DEFAULT_MAX_TEXT_LENGTH = 8000


def _max_text_length() -> int:
    """Max characters allowed in a single synth item's `text`. Default 8000
    (well above any real per-sentence payload); override MAX_TEXT_LENGTH. A
    value <= 0 disables the cap. Garbage falls back to the default."""
    try:
        return int(os.environ.get("MAX_TEXT_LENGTH", str(_DEFAULT_MAX_TEXT_LENGTH)))
    except (TypeError, ValueError):
        return _DEFAULT_MAX_TEXT_LENGTH


def _drain_then_restart(grace_ms: int) -> None:
    """Wait (bounded by `grace_ms`) for `_inflight_synth` to reach 0, then arm the
    flush-delayed hard exit. Runs on a daemon thread so it never needs an event
    loop (the watchdog schedules it; tests call _schedule_restart_exit directly).
    Best-effort: if the grace expires with synth still running we exit anyway —
    the server's srv-17c in-worker recovery re-renders that chapter."""
    waited_ms = 0
    poll_ms = 500
    while grace_ms > 0 and _inflight_synth > 0 and waited_ms < grace_ms:
        time.sleep(poll_ms / 1000.0)
        waited_ms += poll_ms
    if _inflight_synth > 0:
        log.warning(
            "sidecar recycle: drain grace %dms expired with %d synth still in-flight "
            "— self-exiting anyway (the server re-renders the in-flight chapter).",
            grace_ms, _inflight_synth,
        )
    else:
        log.info("sidecar recycle: in-flight synth drained — self-exiting now.")
    threading.Timer(_POISON_EXIT_DELAY_MS / 1000.0, _restart_now).start()


def _schedule_restart_exit(
    metric_mb: float, threshold_mb: float, metric_label: str = "committed memory"
) -> None:
    """Schedule a single hard self-exit so srv-15 respawns a fresh sidecar.
    Idempotent (a later over-ceiling tick won't double-schedule). Flips
    `_restart_pending` (new synth now fast-fails 503) and hands off to a drain
    thread that waits out the in-flight chapter (srv-17c) before the
    flush-delayed exit. `metric_label` names the ceiling that tripped (host
    "committed memory" vs "reserved VRAM") so the log says which one fired."""
    global _restart_scheduled, _restart_pending
    if _restart_scheduled:
        return
    _restart_scheduled = True
    _restart_pending = True
    grace_ms = _drain_grace_ms()
    log.warning(
        "sidecar %s %.0fMB crossed the restart ceiling %.0fMB — "
        "draining %d in-flight synth (grace %dms) then self-exiting (code %d) so the "
        "server respawns a fresh process. Completed chapters are skipped (srv-16); "
        "the in-flight chapter finishes here or is re-rendered by the server "
        "(srv-17c). Raise the ceiling to recycle less often.",
        metric_label, metric_mb, threshold_mb, _inflight_synth, grace_ms, _RESTART_EXIT_CODE,
    )
    threading.Thread(target=_drain_then_restart, args=(grace_ms,), daemon=True).start()


async def _memory_watchdog() -> None:
    """See the block comment above. Never dies on a transient error.

    Watches TWO independent pressures, each with a soft+hard tier:
      * HOST committed-private RAM — the variable-shape side-11 leak (the
        2026-05-30 OOM). Hard self-exits; soft flags `recycle_pending`.
      * RESERVED VRAM — a reload/fragmentation pool creeping past the card and
        spilling into the Windows sysmem fallback (the 2026-06-01 reload spill).
        Same soft/hard tiers, SAME `recycle_pending` flag so the server's
        chapter-boundary recycle fires unchanged.
    Both hard branches are evaluated before either soft branch so a hard ceiling
    never races the soft signal."""
    global _recycle_pending
    warn_threshold = _mem_warn_threshold_mb()
    restart_threshold = _mem_restart_threshold_mb()
    soft_threshold = _mem_recycle_soft_threshold_mb()
    # Rolling peaks across the (slower) log window — reported on the periodic log
    # line so the operator sees how high committed/VRAM spiked between samples,
    # even though the recycle DECISION is made per-sample below.
    commit_peak = 0.0
    vram_peak = 0.0
    elapsed_since_log = 0.0
    while True:
        try:
            await asyncio.sleep(_MEM_WATCHDOG_SAMPLE_INTERVAL)
            mem = _process_mem()
            rss = mem.get("rss_mb", 0.0)
            if not rss:
                continue  # psutil unavailable — nothing to report
            commit = _process_commit_mb()
            _vram_alloc, vram_reserved, vram_total = _cuda_vram_mb()
            vram_soft = _vram_recycle_soft_threshold_mb(vram_total)
            vram_hard = _vram_restart_threshold_mb(vram_total)
            # HARD ceilings first (host then VRAM) — recycling is the only
            # effective lever against the variable-shape leak / spilled pool, so
            # don't waste a tick on the futile soft reclaim once at a ceiling.
            # Host keys on committed-private (the OOM metric), falling back to RSS.
            # Evaluated EACH sample (every _MEM_WATCHDOG_SAMPLE_INTERVAL) so a
            # spike is caught promptly, not once a minute.
            recycle_metric = commit if commit is not None else rss
            commit_peak = max(commit_peak, recycle_metric)
            if vram_reserved is not None:
                vram_peak = max(vram_peak, vram_reserved)
            if _should_restart(recycle_metric, restart_threshold):
                _schedule_restart_exit(recycle_metric, restart_threshold)
                continue
            if vram_reserved is not None and _should_restart(vram_reserved, vram_hard):
                _schedule_restart_exit(vram_reserved, vram_hard, "reserved VRAM")
                continue
            # SOFT recycle: below the hard ceilings, flag a pending recycle so the
            # generation worker recycles cleanly at the next chapter boundary. Set
            # once; no drain, no exit here — the hard branches remain the backstop.
            if _should_soft_recycle(recycle_metric, soft_threshold, restart_threshold):
                if not _recycle_pending:
                    _recycle_pending = True
                    log.warning(
                        "sidecar committed %.0fMB crossed the SOFT recycle threshold "
                        "%.0fMB (hard ceiling %.0fMB) — surfacing recycle_pending in "
                        "/health so the server recycles at the next chapter boundary. "
                        "No exit here (the hard watchdog remains the backstop).",
                        recycle_metric, soft_threshold, restart_threshold,
                    )
            if vram_reserved is not None and _should_soft_recycle(
                vram_reserved, vram_soft, vram_hard
            ):
                if not _recycle_pending:
                    _recycle_pending = True
                    log.warning(
                        "sidecar reserved VRAM %.0fMB crossed the SOFT recycle threshold "
                        "%.0fMB (hard ceiling %.0fMB, card %.0fMB) — surfacing "
                        "recycle_pending so the server recycles at the next chapter "
                        "boundary before the pool spills into host RAM. No exit here.",
                        vram_reserved, vram_soft, vram_hard, vram_total or 0.0,
                    )
            # Throttled (every _MEM_WATCHDOG_INTERVAL): the memory log line, the
            # VRAM-spill alarm, and the (heavier, mostly-futile) gc reclaim — none
            # of which need to run on every fine sample.
            elapsed_since_log += _MEM_WATCHDOG_SAMPLE_INTERVAL
            if elapsed_since_log >= _MEM_WATCHDOG_INTERVAL:
                elapsed_since_log = 0.0
                log.info(
                    "sidecar memory: rss=%.0fMB%s%s",
                    rss,
                    f" committed={commit:.0f}MB (peak {commit_peak:.0f}MB)"
                    if commit is not None
                    else "",
                    f" vram_reserved={vram_reserved:.0f}/{vram_total:.0f}MB (peak {vram_peak:.0f}MB)"
                    if vram_reserved is not None and vram_total is not None
                    else "",
                )
                # Loud, distinct alarm when reserved VRAM has already crossed the
                # physical card: on Windows that means the NVIDIA "CUDA – Sysmem
                # Fallback Policy" is mapping the overflow into host RAM, so the GPU
                # thrashes over PCIe at ~100% util (RTF collapse) instead of OOM-ing.
                # The hard branch above recycles us out of it, but the durable fix is
                # to disable sysmem fallback for python.exe (see the sidecar README).
                if (
                    vram_reserved is not None
                    and vram_total is not None
                    and vram_reserved > vram_total
                ):
                    log.warning(
                        "sidecar VRAM SPILL: reserved %.0fMB exceeds the %.0fMB card — "
                        "NVIDIA sysmem fallback is mapping VRAM into host RAM (GPU is "
                        "thrashing, not OOM-ing). Recycling will clear it; disable "
                        "'CUDA – Sysmem Fallback Policy' for python.exe to prevent it.",
                        vram_reserved, vram_total,
                    )
                if warn_threshold > 0 and rss >= warn_threshold:
                    await asyncio.to_thread(_reclaim_host_and_vram)
                    after = _process_mem().get("rss_mb", rss)
                    log.warning(
                        "sidecar memory crossed %.0fMB (rss=%.0fMB) — forced "
                        "gc+empty_cache reclaimed %.0fMB (now %.0fMB). If this "
                        "recurs the leak is outliving model unload (expected for the "
                        "variable-shape leak; the restart ceiling is the real guard).",
                        warn_threshold, rss, rss - after, after,
                    )
                commit_peak = recycle_metric
                vram_peak = vram_reserved if vram_reserved is not None else 0.0
        except asyncio.CancelledError:
            raise
        except Exception as e:  # a watchdog must never die on a transient error
            log.warning("sidecar memory watchdog tick failed (%s).", e)


@app.on_event("startup")
async def _start_memory_watchdog() -> None:
    """Launch the host-memory watchdog (see _memory_watchdog)."""
    global _mem_watchdog_task
    _mem_watchdog_task = asyncio.create_task(_memory_watchdog())
    restart = _mem_restart_threshold_mb()
    soft = _mem_recycle_soft_threshold_mb()
    _a, _r, vram_total = _cuda_vram_mb()
    vram_soft = _vram_recycle_soft_threshold_mb(vram_total)
    vram_hard = _vram_restart_threshold_mb(vram_total)
    log.info(
        "sidecar memory watchdog started (warn/reclaim at %.0fMB rss; "
        "host soft-recycle at %s, process-recycle at %s; "
        "VRAM soft-recycle at %s, process-recycle at %s).",
        _mem_warn_threshold_mb(),
        f"{soft:.0f}MB committed" if soft > 0 else "DISABLED",
        f"{restart:.0f}MB committed" if restart > 0 else "DISABLED",
        f"{vram_soft:.0f}MB reserved" if vram_soft > 0 else "DISABLED",
        f"{vram_hard:.0f}MB reserved" if vram_hard > 0 else "DISABLED",
    )


@app.on_event("shutdown")
async def _stop_memory_watchdog() -> None:
    global _mem_watchdog_task
    if _mem_watchdog_task is not None:
        _mem_watchdog_task.cancel()
        try:
            await _mem_watchdog_task
        except asyncio.CancelledError:
            pass
        _mem_watchdog_task = None


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


def _qwen_package_installed() -> bool:
    """True if the `qwen_tts` package is importable WITHOUT importing it (no
    torch pull, no weight load). Cheap enough to call on every /health poll."""
    try:
        import importlib.util

        return importlib.util.find_spec("qwen_tts") is not None
    except Exception:
        # A broken/partial install can make find_spec raise — treat as absent.
        return False


def _coqui_package_installed() -> bool:
    """True if the `TTS` (Coqui) package is importable without importing it."""
    try:
        import importlib.util

        return importlib.util.find_spec("TTS") is not None
    except Exception:
        return False


def _kokoro_package_installed() -> bool:
    """True if the `kokoro_onnx` package is importable without importing it."""
    try:
        import importlib.util

        return importlib.util.find_spec("kokoro_onnx") is not None
    except Exception:
        return False


def _whisper_package_installed() -> bool:
    """True if the `faster_whisper` package is importable without importing it."""
    try:
        import importlib.util

        return importlib.util.find_spec("faster_whisper") is not None
    except Exception:
        return False


def _qwen_hub_cache_dir() -> str:
    """Resolve the Hugging Face hub cache the same way huggingface_hub does, so
    the weights probe looks exactly where QwenEngine.from_pretrained downloads
    to: HF_HUB_CACHE → HF_HOME/hub → $XDG_CACHE_HOME/huggingface/hub →
    ~/.cache/huggingface/hub. (install-qwen3.mjs prefetches into this same
    default cache — see its comment about an earlier HF_HOME bug.)"""
    hub = os.environ.get("HF_HUB_CACHE")
    if hub:
        return hub
    home = os.environ.get("HF_HOME")
    if home:
        return os.path.join(home, "hub")
    base = os.environ.get("XDG_CACHE_HOME") or os.path.join(os.path.expanduser("~"), ".cache")
    return os.path.join(base, "huggingface", "hub")


_QWEN_WEIGHT_SUFFIXES = (".safetensors", ".bin", ".gguf", ".pt")


def _qwen_weights_present() -> bool:
    """True if the Base model snapshot holds at least one real weight file in
    the HF cache. Requires a weight blob (not just metadata) so a half-finished
    download doesn't read as `ready`."""
    repo_dir = os.path.join(
        _qwen_hub_cache_dir(), "models--" + QwenEngine.BASE_MODEL.replace("/", "--")
    )
    snapshots = os.path.join(repo_dir, "snapshots")
    if not os.path.isdir(snapshots):
        return False
    try:
        for _root, _dirs, files in os.walk(snapshots):
            for fname in files:
                if fname.endswith(_QWEN_WEIGHT_SUFFIXES):
                    return True
    except OSError:
        return False
    return False


def _qwen_install_state(qwen_loaded: bool) -> str:
    """One of: 'not-installed' (pip package absent) | 'weights-missing'
    (package present, Base weights not downloaded) | 'ready' (package + weights
    present, not resident) | 'loaded' (Base model resident in memory). Side-
    effect free + cheap so /health can compute it every poll."""
    if qwen_loaded:
        return "loaded"
    if not _qwen_package_installed():
        return "not-installed"
    if not _qwen_weights_present():
        return "weights-missing"
    return "ready"


# --- side-14: per-engine device ground-truth -------------------------------
# A background startup probe imports torch/onnxruntime ONCE and caches what
# device each engine WOULD resolve to, using each engine's own resolver so the
# prediction can't drift from load-time reality. /health composes the map at
# read time with loaded-engine actuals overriding predictions. The probe adds
# torch's ~300-500 MB committed footprint at boot — paid anyway the moment a
# torch engine loads, and far below every recycle ceiling.
_device_probe: dict[str, Optional[str]] = {"kokoro": None, "coqui": None, "qwen": None}
_device_probe_state: str = "pending"  # 'pending' | 'ready' | 'error'


def _torch_is_hip(torch_module: Any) -> bool:
    """True when torch is a ROCm/HIP build (torch.version.hip set). On AMD the
    runtime device string is still 'cuda' (HIP aliases the CUDA API), so this is
    how we tell rocm apart from cuda for honest reporting."""
    try:
        return bool(getattr(getattr(torch_module, "version", None), "hip", None))
    except Exception:
        return False


def _ort_providers_to_family(providers: Any) -> str:
    """Map an ONNX Runtime provider list to a device family, in bind-priority
    order (the accelerated EP that actually takes the session). DirectML (AMD-
    Windows) → directml, CUDA → cuda, ROCm → rocm, else cpu."""
    provs = list(providers)
    if "DmlExecutionProvider" in provs:
        return "directml"
    if "CUDAExecutionProvider" in provs:
        return "cuda"
    if "ROCMExecutionProvider" in provs:
        return "rocm"
    return "cpu"


def _normalize_device_family(raw: Optional[str], torch_module: Any = None) -> Optional[str]:
    """'cuda:0'/'cuda:1' → 'cuda'; mps/cpu/rocm/directml pass through; anything
    else (None, '', an unresolved 'auto' pref) → None so callers fall back to
    prediction. When a HIP torch build is supplied, a 'cuda' family is reported
    honestly as 'rocm' (the AMD device string is 'cuda' but it's really ROCm)."""
    if not raw:
        return None
    fam = str(raw).strip().lower().split(":", 1)[0]
    if fam == "cuda" and _torch_is_hip(torch_module):
        return "rocm"
    return fam if fam in ("cuda", "rocm", "directml", "mps", "cpu") else None


def _predict_kokoro_device(ort_module: Any) -> Optional[str]:
    """Mirror kokoro-onnx's auto-selection from the available EPs: DirectML →
    directml, CUDA → cuda, ROCm → rocm, else cpu. Tolerates a broken/absent
    onnxruntime (→ cpu)."""
    try:
        providers = list(ort_module.get_available_providers())
    except Exception:
        return "cpu"
    return _ort_providers_to_family(providers)


def _compute_device_predictions(
    torch_module: Any, ort_module: Any
) -> dict[str, Optional[str]]:
    """Per-engine would-be devices. Modules are injected for testability (same
    pattern as CoquiEngine._resolve_runtime_options). Never raises."""
    out: dict[str, Optional[str]] = {"kokoro": None, "coqui": None, "qwen": None}
    if ort_module is not None:
        out["kokoro"] = _predict_kokoro_device(ort_module)
    if torch_module is not None:
        qwen = ENGINES.get("qwen")
        pref = (
            qwen._device_pref
            if isinstance(qwen, QwenEngine)
            else os.environ.get("QWEN_DEVICE", "auto")
        )
        out["qwen"] = _normalize_device_family(
            _resolve_torch_device(pref, torch_module), torch_module
        )
        coqui = ENGINES.get("coqui")
        if isinstance(coqui, CoquiEngine):
            out["coqui"] = _normalize_device_family(
                coqui._resolve_runtime_options(torch_module)["device"], torch_module
            )
    return out


def _run_device_probe() -> None:
    """Blocking probe body — run via asyncio.to_thread from the startup hook.
    Imports the heavy modules HERE so module import (and therefore boot +
    /health) stays instant. torch.cuda.is_available() / backends.mps.
    is_available() query availability WITHOUT creating a CUDA context or
    allocating VRAM — never call anything heavier here. Must never raise."""
    global _device_probe, _device_probe_state
    ort_module = None
    torch_module = None
    try:
        import onnxruntime as ort_module  # type: ignore  # noqa: F811
    except Exception as e:
        log.warning("Device probe: onnxruntime unavailable (%s).", e)
    try:
        import torch as torch_module  # type: ignore  # noqa: F811
    except Exception as e:
        log.warning("Device probe: torch unavailable (%s).", e)
    try:
        _device_probe = _compute_device_predictions(torch_module, ort_module)
        _device_probe_state = "ready" if torch_module is not None else "error"
        log.info(
            "Device probe complete: %s (state=%s).", _device_probe, _device_probe_state
        )
    except Exception as e:  # belt-and-braces — predictions already never raise
        _device_probe_state = "error"
        log.warning("Device probe failed (%s) — devices_state=error.", e)


def _kokoro_session_device(engine: "KokoroEngine") -> Optional[str]:
    """Actual ONNX Runtime providers of the LOADED Kokoro session → family.
    kokoro-onnx internals drift across releases, so every access is guarded;
    None → caller keeps the prediction."""
    try:
        sess = getattr(engine._kokoro, "sess", None)
        if sess is None:
            return None
        providers = list(sess.get_providers())
        return _ort_providers_to_family(providers)
    except Exception:
        return None


@app.get("/health")
def health() -> dict[str, Any]:
    """Liveness + load-state probe. `model_loaded` / `loading` / `device` let
    the Node proxy render the right state in the Coqui Load/Stop pill;
    `kokoro_loaded` / `kokoro_loading` do the same for the Kokoro pill.
    Both engines' state fan out from this single response so the frontend's
    consolidated useTtsLifecycle hook stays on one /health poll per tick.

    `poisoned: true` signals "this process needs to be restarted before
    synthesis will work again" — set the first time ANY engine hits a
    context-fatal CUDA error (see `_process_poisoned` / `_CUDA_POISON_RE`). The
    UI shows a red banner; the supervised self-exit respawns a fresh process."""
    coqui = ENGINES.get("coqui")
    model_loaded = False
    loading = False
    device: Optional[str] = None
    _vram_alloc, _vram_reserved, _vram_total = _cuda_vram_mb()
    # Process-wide — a CUDA context is shared by every engine, so poison is not
    # Coqui-specific (a Qwen / Kokoro CUDA error corrupts it just the same).
    poisoned = _process_poisoned
    if isinstance(coqui, CoquiEngine):
        model_loaded = coqui._tts is not None
        loading = coqui._loading
        device = coqui._resolved_device if model_loaded else None
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
    # Install-state (distinct from load-state): lets the Node proxy tell
    # "Qwen not installed" apart from "installed but cold", which drives the
    # conditional default (Qwen-when-installed) + the install-check warning.
    qwen_package_installed = _qwen_package_installed()
    qwen_weights_present = _qwen_weights_present()
    qwen_install_state = _qwen_install_state(qwen_loaded)
    # side-14 — per-engine device map: loaded engines report their ACTUAL
    # device; unloaded ones the startup probe's prediction. Same resolvers on
    # both paths, so they only disagree if availability was misread — in which
    # case loaded truth wins. Composed at read time so engine load/unload and
    # probe completion are order-independent.
    devices = dict(_device_probe)
    if isinstance(coqui, CoquiEngine) and model_loaded:
        devices["coqui"] = _normalize_device_family(coqui._resolved_device) or devices["coqui"]
    if isinstance(kokoro, KokoroEngine) and kokoro_loaded:
        devices["kokoro"] = _kokoro_session_device(kokoro) or devices["kokoro"]
    if isinstance(qwen, QwenEngine) and qwen_loaded:
        devices["qwen"] = _normalize_device_family(qwen._device) or devices["qwen"]
    return {
        "ok": True,
        "protocol_version": SIDECAR_PROTOCOL_VERSION,
        "__version__": __sidecar_version__,
        "engines": sorted(ENGINES.keys()),
        "model_loaded": model_loaded,
        "loading": loading,
        "kokoro_loaded": kokoro_loaded,
        "kokoro_loading": kokoro_loading,
        "qwen_loaded": qwen_loaded,
        "qwen_design_ever_loaded": _QWEN_DESIGN_EVER_LOADED,
        "qwen_loading": qwen_loading,
        "qwen_package_installed": qwen_package_installed,
        "qwen_weights_present": qwen_weights_present,
        "qwen_install_state": qwen_install_state,
        "coqui_package_installed": _coqui_package_installed(),
        "kokoro_package_installed": _kokoro_package_installed(),
        "whisper_package_installed": _whisper_package_installed(),
        # ASR (srv-31) load state — its own pair, same pattern as the synth
        # engines, so the one-poll invariant holds. `asr_device` lets an
        # operator confirm whether transcription is on the GPU or CPU.
        "asr_loaded": ASR._model is not None,
        "asr_device": ASR._device,
        "spk_loaded": SPK._model is not None,
        "spk_device": SPK.device,
        "devices": devices,
        "devices_state": _device_probe_state,
        "device": device,
        "poisoned": poisoned,
        # `poison_reason` (raw exception text) is deliberately NOT surfaced here —
        # it would leak a stack-trace fragment to any /health caller (CodeQL
        # py/stack-trace-exposure). The trigger lives in the server-side log +
        # the internal `_process_poison_reason` global only.
        # side-11 item 2 — SOFT recycle signal. `recycle_pending` flips True once
        # committed crosses SIDECAR_RECYCLE_SOFT_MB OR reserved VRAM crosses the
        # VRAM soft ceiling (below either hard ceiling); the generation worker
        # reads it off this same poll and triggers a clean boundary recycle.
        # `committed_mb` / `vram_reserved_mb` / `vram_total_mb` (may be None) give
        # the boundary decision observability without a separate /debug/memory hit.
        "recycle_pending": _recycle_pending,
        "committed_mb": _process_commit_mb(),
        "vram_reserved_mb": _vram_reserved,
        "vram_total_mb": _vram_total,
        # EFFECTIVE hard recycle ceilings (committed RAM / reserved VRAM, MB) —
        # what this process will actually self-exit (code 43) at, after resolving
        # env + auto defaults. The Node spawn-gate compares these against its
        # configured ceilings to detect a sidecar started under a DIFFERENT
        # config (e.g. a dev launch with no .env → auto ceiling) and refuse to
        # adopt it. None when disabled / VRAM total unreadable.
        "mem_restart_mb": (_mem_restart_threshold_mb() or None),
        "vram_restart_mb": (_vram_restart_threshold_mb(_vram_total) or None),
    }


@app.get("/debug/memory")
def debug_memory() -> dict[str, Any]:
    """On-demand memory readout for leak diagnosis — pairs with the per-tick
    `sidecar memory:` log line so the host-RAM curve is observable without
    attaching a profiler. Reports process RSS/private bytes, Python GC stats,
    each engine's resident-model + cache footprint, and torch CUDA
    alloc/reserved, so you can see WHICH layer is holding memory. (Added after
    the 2026-05-30 host-RAM leak.)"""
    out: dict[str, Any] = {"process": _process_mem()}
    # Surface the SAME metric the hard-recycle keys on (committed-private, the
    # OOM-relevant signal) so the leak-slope bench (scripts/bench-tts.py
    # --mem-sample) can state its success bar in the recycle's own units rather
    # than RSS. `_process_mem` already carries `private_mb` on Windows; this adds
    # the cross-platform name (uss elsewhere) under one key.
    commit = _process_commit_mb()
    if commit is not None:
        out["process"]["committed_mb"] = commit
    out["gc"] = {
        "counts": list(gc.get_count()),
        "garbage": len(gc.garbage),
        "tracked_objects": len(gc.get_objects()),
    }
    engines: dict[str, Any] = {}
    qwen = ENGINES.get("qwen")
    if isinstance(qwen, QwenEngine):
        with qwen._cache_lock:
            prompt_cache_entries = len(qwen._prompt_cache)
        engines["qwen"] = {
            "base_loaded": qwen._base is not None,
            "design_loaded": qwen._design is not None,
            "prompt_cache_entries": prompt_cache_entries,
        }
    coqui = ENGINES.get("coqui")
    if isinstance(coqui, CoquiEngine):
        engines["coqui"] = {"model_loaded": coqui._tts is not None}
    kokoro = ENGINES.get("kokoro")
    if isinstance(kokoro, KokoroEngine):
        engines["kokoro"] = {"model_loaded": kokoro._kokoro is not None}
    engines["whisper"] = {"model_loaded": ASR._model is not None, "device": ASR._device}
    out["engines"] = engines
    cuda: dict[str, Any] = {}
    try:
        import torch  # type: ignore

        if torch.cuda.is_available():
            cuda = {
                "allocated_mb": torch.cuda.memory_allocated() / 1_000_000.0,
                "reserved_mb": torch.cuda.memory_reserved() / 1_000_000.0,
                # total card size — `reserved_mb` crossing this is the spill line
                # the VRAM recycle keys on (see _cuda_vram_mb / _memory_watchdog).
                "total_mb": torch.cuda.get_device_properties(0).total_memory / 1_000_000.0,
            }
    except Exception:
        pass
    out["cuda"] = cuda
    return out


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

    # srv-17c drain fence (same as /synthesize): while a recycle is draining, the
    # model is still resident, so the per-engine branches below would answer
    # `ready` INSTANTLY — but /synthesize fast-fails 503 until the respawn. That
    # split made the server's readiness gate (ensureSidecarEngineReady → /load)
    # see `ready` and march a queued chapter straight into a 503, dropping every
    # chapter a free worker picked up during the ~2-min drain window (the
    # 2026-05-31 cascade). Report not-ready here too so the gate POLLS through
    # the drain+respawn instead of trusting a model that won't accept synth yet.
    if _restart_pending:
        return JSONResponse(
            {"detail": "Voice engine is recycling to free memory; retry shortly."},
            status_code=503,
        )

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
                return error_response(e, log, status=500)
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
                return error_response(e, log, status=500)
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
            return error_response(e, log, status=500)
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


@app.post("/recycle")
async def recycle() -> JSONResponse:
    """Server-triggered CLEAN recycle (side-11 item 2). The generation worker
    POSTs this at a chapter boundary after seeing `recycle_pending` in /health,
    so the leak-forced recycle lands BETWEEN chapters rather than mid-chapter at
    the hard ceiling. Reuses the hard watchdog's drain->exit path verbatim:
    `_schedule_restart_exit` flips `_restart_pending` (new synth fast-fails 503),
    drains `_inflight_synth` bounded by SIDECAR_DRAIN_GRACE_MS, then os._exit(43)
    so srv-15 respawns a fresh process; the server's readiness gate rides out the
    respawn. Idempotent — a second call (or a concurrent hard tick) is a no-op via
    the `_restart_scheduled` guard. Returns 202 immediately; the drain runs on a
    daemon thread."""
    commit = _process_commit_mb() or 0.0
    _schedule_restart_exit(commit, commit)
    return JSONResponse({"status": "recycling", "committed_mb": commit}, status_code=202)


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
    voice_uuid = body.get("voiceUuid") if isinstance(body.get("voiceUuid"), str) else None
    if not isinstance(voice_id, str) or not voice_id.strip():
        raise HTTPException(status_code=400, detail="`voiceId` is required.")
    if not isinstance(instruct, str) or not instruct.strip():
        raise HTTPException(status_code=400, detail="`instruct` is required.")
    _cap = _max_text_length()
    if _cap > 0 and len(instruct) > _cap:
        raise HTTPException(
            status_code=400,
            detail=f"`instruct` too long ({len(instruct)} chars > {_cap} cap).",
        )
    if _cap > 0 and isinstance(calibration_text, str) and len(calibration_text) > _cap:
        raise HTTPException(
            status_code=400,
            detail=f"`calibrationText` too long ({len(calibration_text)} chars > {_cap} cap).",
        )

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
            voice_uuid,
        )
    except Exception:
        log.exception("/qwen/design-voice failed (voiceId=%s)", voice_id)
        return JSONResponse({"detail": "Internal error."}, status_code=500)

    return Response(
        content=result.pcm,
        media_type=f"audio/L16;codec=pcm;rate={result.sample_rate}",
        headers={"X-Sample-Rate": str(result.sample_rate)},
    )


@app.post("/qwen/evict-voice")
async def qwen_evict_voice(req: Request) -> Response:
    """Drop a designed voice from the in-memory clone-prompt cache so the next
    synth re-reads its embedding from disk.

    Used by the server's voice-design 'promote' step (plan 161), which moves a
    previewed embedding onto a stable voiceId behind the sidecar's back. Without
    this, a voiceId already resident in `_prompt_cache` from an earlier
    generation would keep serving the OLD embedding (the cache has no on-disk
    mtime check — it's only evicted on (re)design of that id or a full unload).
    Idempotent: a miss is a no-op `evicted: false`."""
    try:
        body = await req.json()
    except Exception:
        raise HTTPException(status_code=400, detail="Body must be JSON.")
    voice_id = body.get("voiceId")
    if not isinstance(voice_id, str) or not voice_id.strip():
        raise HTTPException(status_code=400, detail="`voiceId` is required.")
    qwen = ENGINES.get("qwen")
    evicted = False
    if isinstance(qwen, QwenEngine):
        with qwen._cache_lock:
            evicted = qwen._prompt_cache.pop(voice_id.strip(), None) is not None
    return JSONResponse({"ok": True, "evicted": evicted})


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
    _cap = _max_text_length()
    if _cap > 0 and len(text) > _cap:
        raise HTTPException(
            status_code=400,
            detail=f"`text` too long ({len(text)} chars > {_cap} cap).",
        )

    engine = ENGINES[engine_id]

    # Cross-request poison fence. A CUDA device-side assert corrupts the
    # whole CUDA context for the lifetime of this Python process — every
    # subsequent CUDA call (including the next /synthesize) raises the same
    # error. Without this gate, the Node side hits the same 500 once per
    # chapter and the cascade detector takes ~2 chapters to bail. With it,
    # we fail fast and give the Node side a single fatal classification
    # that surfaces a clear "restart the sidecar" banner.
    if _process_poisoned:
        # The poison trigger (raw exception text) is logged server-side via
        # _mark_cuda_poisoned's caller; it is NEVER echoed into the response
        # body (CodeQL py/stack-trace-exposure).
        return JSONResponse(
            {
                "detail": (
                    "Voice engine is in a poisoned CUDA state from a prior CUDA "
                    "error and must be restarted. A fresh process is being "
                    "respawned automatically; retry once /health responds again."
                ),
                "poisoned": True,
            },
            status_code=503,
        )

    # srv-17c drain fence: while a recycle is draining, fast-fail new synth with
    # a NON-poisoned 503 so no fresh chapter enters the dying process. The server
    # classifies this as transient (5xx, not poisoned) and its in-worker recovery
    # waits out the respawn — the in-flight chapter already counted below drains.
    if _restart_pending:
        return JSONResponse(
            {"detail": "Voice engine is recycling to free memory; retry shortly."},
            status_code=503,
        )

    global _inflight_synth
    _inflight_synth += 1
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
        # Internal-only — feeds CUDA-poison detection + the server-side log,
        # never a response body (the body stays generic below).
        err_str = f"{e}"
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
        if _CUDA_POISON_RE.search(err_str):
            log.error(
                "CUDA poisoned — scheduling self-exit so the supervisor "
                "respawns a fresh process. Trigger: engine=%s model=%s voice=%s "
                "text_preview=%r",
                engine_id, model, voice, truncated,
            )
            _mark_cuda_poisoned(err_str)
            return JSONResponse(
                {"detail": "Internal error.", "poisoned": True},
                status_code=503,
            )

        return JSONResponse({"detail": "Internal error."}, status_code=500)
    finally:
        _inflight_synth -= 1  # srv-17c: clears the recycle drain regardless of outcome

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


@app.post("/transcribe")
async def transcribe(req: Request) -> Response:
    """ASR content-QA (srv-31). Transcribe one synthesised sentence's PCM so the
    server can word-error-rate the transcript against the manuscript text and
    catch a "fluent but wrong words" generation.

    Body: raw int16 LE mono PCM (the same bytes /synthesize emits). Headers:
    `X-Sample-Rate` (required) and optional `X-Language` (Whisper language hint;
    non-English books pass their language or the WER is meaningless). Returns
    JSON `{ text, language, avg_logprob, no_speech_prob, compression_ratio }`.

    Offloaded to a worker thread like /synthesize so /health stays sub-50 ms
    while a transcribe runs. Honours the same poison + recycle-drain fences."""
    if _process_poisoned:
        # Trigger text is server-side log only — never echoed to the response.
        return JSONResponse(
            {
                "detail": (
                    "Voice engine is in a poisoned CUDA state and must be restarted."
                ),
                "poisoned": True,
            },
            status_code=503,
        )
    if _restart_pending:
        return JSONResponse(
            {"detail": "Voice engine is recycling to free memory; retry shortly."},
            status_code=503,
        )

    pcm = await req.body()
    if not pcm:
        raise HTTPException(status_code=400, detail="empty PCM body")
    try:
        sample_rate = int(req.headers.get("X-Sample-Rate", "0"))
    except (TypeError, ValueError):
        sample_rate = 0
    if sample_rate <= 0:
        raise HTTPException(status_code=400, detail="X-Sample-Rate header (>0) is required.")
    language = req.headers.get("X-Language") or None

    try:
        result = await asyncio.to_thread(ASR.transcribe, pcm, sample_rate, language)
    except Exception as e:
        # Internal-only — CUDA-poison detection + server-side log, never a body.
        err_str = f"{e}"
        log.exception("transcribe failed (sample_rate=%d bytes=%d)", sample_rate, len(pcm))
        # Same CUDA-poison fence as /synthesize — a device-side assert here
        # corrupts the shared context just the same.
        if _CUDA_POISON_RE.search(err_str):
            _mark_cuda_poisoned(err_str)
            return JSONResponse({"detail": "Internal error.", "poisoned": True}, status_code=503)
        return JSONResponse({"detail": "Internal error."}, status_code=500)
    return JSONResponse(result)


@app.post("/embed")
async def embed(req: Request) -> Response:
    """Speaker embedding (srv-36). Accepts raw int16 LE mono PCM and returns a
    192-d unit-norm ECAPA-TDNN embedding for speaker-similarity scoring.

    Body: raw int16 LE mono PCM. Header: `X-Sample-Rate` (required).
    Returns JSON `{ "embedding": float[192], "dim": 192, "sample_rate": 16000 }`.

    Offloaded to a worker thread so /health stays sub-50 ms while an embed
    runs. Honours the same poison + recycle-drain fences as /transcribe."""
    if _process_poisoned:
        return JSONResponse(
            {
                "detail": (
                    "Voice engine is in a poisoned CUDA state and must be restarted."
                ),
                "poisoned": True,
            },
            status_code=503,
        )
    if _restart_pending:
        return JSONResponse(
            {"detail": "Voice engine is recycling to free memory; retry shortly."},
            status_code=503,
        )

    pcm = await req.body()
    if not pcm:
        raise HTTPException(status_code=400, detail="empty PCM body")
    try:
        sample_rate = int(req.headers.get("X-Sample-Rate", "0"))
    except (TypeError, ValueError):
        sample_rate = 0
    if sample_rate <= 0:
        raise HTTPException(status_code=400, detail="X-Sample-Rate header (>0) is required.")

    await SPK.ensure_loaded()
    try:
        embedding = await asyncio.to_thread(SPK.embed, pcm, int(sample_rate))
    except Exception as e:
        err_str = f"{e}"
        log.exception("embed failed (sample_rate=%d bytes=%d)", sample_rate, len(pcm))
        if _CUDA_POISON_RE.search(err_str):
            _mark_cuda_poisoned(err_str)
            return JSONResponse({"detail": "Internal error.", "poisoned": True}, status_code=503)
        return JSONResponse({"detail": "Internal error."}, status_code=500)
    return JSONResponse({"embedding": embedding, "dim": len(embedding), "sample_rate": SPK.TARGET_SR})


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
        _cap = _max_text_length()
        if _cap > 0 and len(item["text"]) > _cap:
            raise HTTPException(
                status_code=400,
                detail=f"item {i}: `text` too long ({len(item['text'])} chars > {_cap} cap).",
            )

    engine = ENGINES["qwen"]

    # Same process-wide poison fence as /synthesize: once the CUDA context is
    # corrupted, every batched forward re-raises until a fresh process — fail
    # fast with the structured 503 so the Node side surfaces the restart banner
    # instead of retrying into the dead context.
    if _process_poisoned:
        return JSONResponse(
            {
                "detail": (
                    "Voice engine is in a poisoned CUDA state from a prior CUDA "
                    "error and must be restarted. A fresh process is being "
                    "respawned automatically; retry once /health responds again."
                ),
                "poisoned": True,
            },
            status_code=503,
        )

    # srv-17c drain fence — same as /synthesize: a recycling sidecar fast-fails
    # new batches with a non-poisoned 503 so the server's in-worker recovery
    # rides out the respawn instead of a fresh batch entering the dying process.
    if _restart_pending:
        return JSONResponse(
            {"detail": "Voice engine is recycling to free memory; retry shortly."},
            status_code=503,
        )

    global _inflight_synth
    _inflight_synth += 1
    try:
        # Offload like /synthesize so /health stays responsive while the
        # (potentially multi-second) batched forward runs on a worker thread.
        result = await asyncio.to_thread(engine.synthesize_batch, model, items)
    except Exception as e:
        # Internal-only — forensic log + CUDA-poison detection, never a body.
        err_str = f"{e}"
        # Forensic beacon: model + item count + the failing message.
        log.exception(
            "batch synth failed (engine=qwen model=%s items=%d): %s",
            model, len(items), err_str,
        )
        # A CUDA error here corrupts the shared context exactly as in /synthesize
        # — flag poison + schedule the supervised restart (was Coqui-only, which
        # left the Qwen batch path wedging the whole run).
        if _CUDA_POISON_RE.search(err_str):
            _mark_cuda_poisoned(err_str)
            return JSONResponse({"detail": "Internal error.", "poisoned": True}, status_code=503)
        return JSONResponse({"detail": "Internal error."}, status_code=500)
    finally:
        _inflight_synth -= 1  # srv-17c: clears the recycle drain regardless of outcome

    import json as _json

    # genMs/audioMs ride in the header so the server can surface a LIVE per-batch
    # RTF (gen_ms ÷ audio_ms) as each batch lands — the per-chapter rollup is too
    # coarse to act on. Additive keys; older clients ignore them.
    header = _json.dumps(
        {
            "sampleRate": result.sample_rate,
            "lengths": [len(p) for p in result.pcms],
            "genMs": round(result.gen_ms, 1),
            "audioMs": round(result.audio_ms, 1),
        },
        separators=(",", ":"),
    )
    frame = header.encode("utf-8") + b"\n" + b"".join(result.pcms)
    return Response(
        content=frame,
        media_type="application/octet-stream",
        headers={"X-Sample-Rate": str(result.sample_rate)},
    )


