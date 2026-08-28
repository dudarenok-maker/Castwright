"""KokoroEngine coverage — module load wiring, English-only voice filter,
synthesis happy path, voice fallback, /speakers integration, /synthesize
HTTP surface.

The real `kokoro_onnx` package isn't installed in CI / the dev venv. These
tests stub it via sys.modules so the load path executes without the
~330 MB of weights, then assert on the engine's internal state and on the
HTTP responses.

The English-only filter (KokoroEngine.ENGLISH_VOICE_PREFIXES) is load-bearing
for this project's scope — non-English voices must NEVER reach the picker
UI or the /synthesize request validator. The filter tests pin that
invariant; if you add a new language prefix, extend the assertions here.
"""
from __future__ import annotations

import asyncio
import os
import sys
import types
from pathlib import Path
from typing import Optional

import numpy as np
import pytest
from fastapi.testclient import TestClient

# Same sys.path bootstrap as the other test modules so `import main` works
# regardless of pytest's collection directory.
SIDECAR_ROOT = Path(__file__).resolve().parent.parent
if str(SIDECAR_ROOT) not in sys.path:
    sys.path.insert(0, str(SIDECAR_ROOT))

import main  # noqa: E402


# Representative multilingual catalog spanning every language prefix
# Kokoro v1 ships with — used to verify the English filter drops the rest.
# The English subset (af_*, am_*, bf_*, bm_*) here matches the curated
# names from the project plan; expand if Kokoro adds new names.
_FAKE_VOICE_MANIFEST = [
    # American female (af_)
    "af_heart", "af_bella", "af_nicole", "af_sarah", "af_aoede",
    "af_jessica", "af_kore", "af_alloy", "af_river",
    # American male (am_)
    "am_michael", "am_onyx", "am_adam", "am_eric", "am_liam",
    # British female (bf_)
    "bf_emma", "bf_alice",
    # British male (bm_)
    "bm_george", "bm_lewis",
    # Non-English: Spanish, French, Hindi, Italian, Japanese, Portuguese, Chinese
    "ef_dora", "em_alex",
    "ff_siwis",
    "hf_alpha", "hm_omega",
    "if_sara",
    "jf_alpha", "jm_kumo",
    "pf_dora",
    "zf_xiaobei", "zm_yunjian",
]


class _FakeKokoro:
    """Stand-in for kokoro_onnx.Kokoro. Implements just the surface
    KokoroEngine touches: constructor with model+voices paths, get_voices(),
    create(). The audio array is a one-second flat-zero numpy float32
    buffer at 24 kHz — enough to exercise the int16 conversion."""

    def __init__(
        self,
        model_path: str,
        voices_path: str,
        voices: Optional[list[str]] = None,
    ) -> None:
        self.model_path = model_path
        self.voices_path = voices_path
        # The voices list is parameterisable so tests can inject a specific
        # manifest (full multilingual, English-only, empty, etc.) without
        # monkeypatching the class.
        self._voices = list(voices) if voices is not None else list(_FAKE_VOICE_MANIFEST)
        self.calls: list[tuple[str, str, float, str]] = []

    @classmethod
    def from_session(
        cls, session, voices_path: str, espeak_config=None, vocab_config=None
    ) -> "_FakeKokoro":
        """Support from_session classmethod for the fixed code path."""
        instance = cls.__new__(cls)
        instance.model_path = getattr(session, "_model_path", "")
        instance.voices_path = voices_path
        instance._voices = list(_FAKE_VOICE_MANIFEST)
        instance.calls = []
        return instance

    def get_voices(self) -> list[str]:
        return list(self._voices)

    def create(self, text: str, voice: str, speed: float, lang: str):
        self.calls.append((text, voice, speed, lang))
        # 24 kHz × 1 s × float32 ∈ [-1, 1]. Real kokoro-onnx returns the
        # tuple form (samples, sample_rate); mirror that.
        samples = np.zeros(24000, dtype=np.float32)
        return samples, 24000


@pytest.fixture
def fake_kokoro_module(monkeypatch):
    """Insert a fake `kokoro_onnx` module into sys.modules so
    KokoroEngine._ensure_loaded's `from kokoro_onnx import Kokoro` works
    without the real package. Yields the _FakeKokoro class so tests can
    assert on its constructor args / call log.

    #2631: _ensure_loaded now always resolves a provider list itself (even
    when KOKORO_ORT_PROVIDERS is unset) and builds a real ORT
    InferenceSession before handing it to Kokoro.from_session -- which
    _FakeKokoro exposes. `fake_weight_files` only writes empty placeholder
    files (not valid ONNX models), so the real onnxruntime.InferenceSession
    would fail to load them; stub it out here so every test using this
    fixture keeps exercising _FakeKokoro rather than real ORT.
    """
    from unittest.mock import MagicMock

    fake_mod = types.ModuleType("kokoro_onnx")
    fake_mod.Kokoro = _FakeKokoro  # type: ignore[attr-defined]
    monkeypatch.setitem(sys.modules, "kokoro_onnx", fake_mod)
    monkeypatch.setattr(
        "onnxruntime.InferenceSession",
        MagicMock(return_value=MagicMock(_model_path="")),
    )
    yield _FakeKokoro


class _ProvidersKokoro:
    """Kokoro stub for the KOKORO_ORT_PROVIDERS-honouring path. The
    constructor deliberately does NOT accept a `providers` kwarg, matching
    the real kokoro_onnx==0.5.0 `Kokoro.__init__` signature
    (`(self, model_path, voices_path, espeak_config=None,
    vocab_config=None)`) -- a stub that accepted one would be MORE
    permissive than production and would silently pass a test that calls
    `Kokoro(model_path, voices_path, providers=...)` directly, a call the
    real class raises TypeError on. Production always builds via
    `from_session` now, so this constructor isn't exercised by the fixed
    load path -- kept strict anyway so a regression back to the old
    direct-constructor-with-providers= call would fail here exactly as it
    would against the real package (#2631 review)."""

    def __init__(self, model_path: str, voices_path: str) -> None:
        self._voices = list(_FAKE_VOICE_MANIFEST)

    @classmethod
    def from_session(
        cls, session, voices_path: str, espeak_config=None, vocab_config=None
    ) -> "_ProvidersKokoro":
        """Support from_session classmethod for the fixed code path."""
        instance = cls.__new__(cls)
        instance._voices = list(_FAKE_VOICE_MANIFEST)
        return instance

    def get_voices(self) -> list[str]:
        return list(self._voices)

    def create(self, text: str, voice: str, speed: float, lang: str):
        # Lets the DirectML self-test pass so providers= pass-through is what's
        # exercised (not the fallback path).
        return np.zeros(24000, dtype=np.float32), 24000


@pytest.fixture
def providers_kokoro_module(monkeypatch):
    """A kokoro_onnx stub supporting the from_session() path (see
    _ProvidersKokoro above — its constructor deliberately rejects providers=,
    matching the real kokoro_onnx==0.5.0 signature)."""
    fake_mod = types.ModuleType("kokoro_onnx")
    fake_mod.Kokoro = _ProvidersKokoro  # type: ignore[attr-defined]
    monkeypatch.setitem(sys.modules, "kokoro_onnx", fake_mod)
    yield _ProvidersKokoro


def test_kokoro_honours_injected_ort_providers(
    providers_kokoro_module, fake_weight_files, monkeypatch
) -> None:
    """KOKORO_ORT_PROVIDERS (the server's accelerator-profile injection) is
    used to build the ORT InferenceSession, which is then handed to
    Kokoro.from_session() — not passed as a providers= kwarg to the Kokoro
    constructor, which kokoro_onnx==0.5.0 doesn't accept."""
    from unittest.mock import MagicMock, patch

    # Hermetic: an ambient KOKORO_DEVICE (e.g. cuda:1) would fold a device_id
    # pin into this same session build, adding a second (unexpected here)
    # assertion target and making the test's InferenceSession-call-count
    # assumption environment-dependent (#2631 review M1).
    monkeypatch.delenv("KOKORO_DEVICE", raising=False)

    mock_session = MagicMock()
    mock_session._model_path = str(fake_weight_files["model"])

    # Track from_session calls to verify it's being used. monkeypatch.setattr
    # (not a raw attribute assignment) so the stub is restored automatically
    # at teardown rather than leaking into later tests (#2631 review M4).
    from_session_calls: list = []

    @classmethod
    def tracked_from_session(cls, session, voices_path, espeak_config=None, vocab_config=None):
        from_session_calls.append(session)
        instance = cls.__new__(cls)
        instance._voices = list(_FAKE_VOICE_MANIFEST)
        return instance

    monkeypatch.setattr(providers_kokoro_module, "from_session", tracked_from_session)

    monkeypatch.setenv("KOKORO_ORT_PROVIDERS", '["DmlExecutionProvider", "CPUExecutionProvider"]')

    with patch("onnxruntime.InferenceSession") as mock_ort_session:
        mock_ort_session.return_value = mock_session
        engine = main.KokoroEngine()
        engine._ensure_loaded("v1")

        # Verify the session was created with the right providers
        mock_ort_session.assert_called_once()
        call_args = mock_ort_session.call_args
        assert call_args[1]["providers"] == ["DmlExecutionProvider", "CPUExecutionProvider"]

        # Verify from_session was called
        assert len(from_session_calls) == 1


def test_kokoro_unset_env_prefers_cuda_when_available(
    fake_weight_files, monkeypatch
) -> None:
    """#2631: covers the standalone-launch fallback (KOKORO_ORT_PROVIDERS
    unset -- the server always injects it in the normal server-spawned
    case, so this exercises a sidecar launched directly via
    start.ps1/start.sh, which set nothing). Even there, Kokoro must NOT
    fall through to kokoro-onnx's own broken auto-detect (find_spec(
    'onnxruntime-gpu') is not a valid module identifier, so it always
    resolves to None and forces CPU); it must resolve CUDA-first itself,
    from onnxruntime's own reported availability, and go through
    from_session same as the explicit-providers path."""
    from unittest.mock import MagicMock, patch

    monkeypatch.delenv("KOKORO_ORT_PROVIDERS", raising=False)
    monkeypatch.delenv("KOKORO_DEVICE", raising=False)

    mock_session = MagicMock()
    mock_session._model_path = str(fake_weight_files["model"])

    from_session_calls: list = []

    class _CudaKokoro:
        def __init__(self, model_path: str, voices_path: str) -> None:
            self._voices = list(_FAKE_VOICE_MANIFEST)

        @classmethod
        def from_session(cls, session, voices_path, espeak_config=None, vocab_config=None):
            from_session_calls.append(session)
            instance = cls.__new__(cls)
            instance._voices = list(_FAKE_VOICE_MANIFEST)
            return instance

        def get_voices(self):
            return list(self._voices)

        def create(self, text: str, voice: str, speed: float, lang: str):
            return np.zeros(24000, dtype=np.float32), 24000

    fake_mod = types.ModuleType("kokoro_onnx")
    fake_mod.Kokoro = _CudaKokoro  # type: ignore[attr-defined]
    monkeypatch.setitem(sys.modules, "kokoro_onnx", fake_mod)

    with patch(
        "onnxruntime.get_available_providers",
        return_value=["TensorrtExecutionProvider", "CUDAExecutionProvider", "CPUExecutionProvider"],
    ), patch("onnxruntime.cuda_version", "12.4", create=True), \
         patch("onnxruntime.InferenceSession") as mock_ort_session_class:
        mock_ort_session_class.return_value = mock_session
        engine = main.KokoroEngine()
        engine._ensure_loaded("v1")

        mock_ort_session_class.assert_called_once()
        assert mock_ort_session_class.call_args[1]["providers"] == [
            "CUDAExecutionProvider", "CPUExecutionProvider"
        ]
        assert len(from_session_calls) == 1
        assert engine._kokoro is not None


def test_kokoro_unset_env_cpu_only_runtime_still_loads(
    fake_weight_files, monkeypatch
) -> None:
    """#2631: KOKORO_ORT_PROVIDERS unset on a CPU-only runtime (no CUDA
    build, no CUDA provider reported) must still load Kokoro successfully --
    via from_session with an explicit CPU provider list, never a crash."""
    from unittest.mock import MagicMock, patch

    monkeypatch.delenv("KOKORO_ORT_PROVIDERS", raising=False)
    monkeypatch.delenv("KOKORO_DEVICE", raising=False)

    mock_session = MagicMock()
    mock_session._model_path = str(fake_weight_files["model"])

    from_session_calls: list = []

    class _CpuOnlyKokoro:
        def __init__(self, model_path: str, voices_path: str) -> None:
            self._voices = list(_FAKE_VOICE_MANIFEST)

        @classmethod
        def from_session(cls, session, voices_path, espeak_config=None, vocab_config=None):
            from_session_calls.append(session)
            instance = cls.__new__(cls)
            instance._voices = list(_FAKE_VOICE_MANIFEST)
            return instance

        def get_voices(self):
            return list(self._voices)

        def create(self, text: str, voice: str, speed: float, lang: str):
            return np.zeros(24000, dtype=np.float32), 24000

    fake_mod = types.ModuleType("kokoro_onnx")
    fake_mod.Kokoro = _CpuOnlyKokoro  # type: ignore[attr-defined]
    monkeypatch.setitem(sys.modules, "kokoro_onnx", fake_mod)

    with patch(
        "onnxruntime.get_available_providers",
        return_value=["CPUExecutionProvider"],
    ), patch("onnxruntime.cuda_version", "", create=True), \
         patch("onnxruntime.InferenceSession") as mock_ort_session_class:
        mock_ort_session_class.return_value = mock_session
        engine = main.KokoroEngine()
        engine._ensure_loaded("v1")  # must not raise

        mock_ort_session_class.assert_called_once()
        assert mock_ort_session_class.call_args[1]["providers"] == ["CPUExecutionProvider"]
        assert len(from_session_calls) == 1
        assert engine._kokoro is not None


def test_default_ort_providers_honours_explicit_cpu_even_with_cuda_available(
    monkeypatch,
) -> None:
    """KOKORO_DEVICE=cpu must return CPU-only even when CUDA is fully
    available (in get_available_providers() AND has a cuda_version build) --
    an explicit CPU request is never overridden into CUDA. Regression for
    the `family == "cpu"` early return in `_default_ort_providers`, which
    review-gate mutation testing found survived removal against the then-
    existing suite (#2631 review M2)."""
    from unittest.mock import patch

    monkeypatch.setenv("KOKORO_DEVICE", "cpu")
    engine = main.KokoroEngine()
    with patch(
        "onnxruntime.get_available_providers",
        return_value=["CUDAExecutionProvider", "CPUExecutionProvider"],
    ), patch("onnxruntime.cuda_version", "12.4", create=True):
        assert engine._default_ort_providers() == ["CPUExecutionProvider"]


def test_default_ort_providers_requires_cuda_build_not_just_reported_provider(
    monkeypatch,
) -> None:
    """CUDAExecutionProvider appearing in get_available_providers() is not
    sufficient on its own -- get_available_providers() reflects what ORT was
    compiled with, not what actually has a usable CUDA build behind it. This
    pins that a build with no cuda_version stays CPU-only even though CUDA
    is (falsely) reported available. Regression for the `and has_cuda_build`
    conjunct in `_default_ort_providers`, which review-gate mutation testing
    found survived removal against the then-existing suite (#2631 review
    M2)."""
    from unittest.mock import patch

    monkeypatch.delenv("KOKORO_DEVICE", raising=False)
    engine = main.KokoroEngine()
    with patch(
        "onnxruntime.get_available_providers",
        return_value=["CUDAExecutionProvider", "CPUExecutionProvider"],
    ), patch("onnxruntime.cuda_version", "", create=True):
        assert engine._default_ort_providers() == ["CPUExecutionProvider"]


def test_kokoro_device_env_cuda_index_pins_without_double_build(
    fake_weight_files, monkeypatch
) -> None:
    """KOKORO_DEVICE=cuda:1 with KOKORO_ORT_PROVIDERS unset: the default
    providers resolve to CUDA+CPU, and the indexed pin must be folded into
    the INITIAL session build -- exactly ONE InferenceSession call, with
    provider_options set for device_id=1 from the start. Building an
    unpinned session first (implicitly landing on GPU 0) and rebuilding
    pinned afterward would briefly put a real CUDA context on a card the
    placement ledger never admitted (#2631 review S3)."""
    from unittest.mock import MagicMock, patch

    monkeypatch.delenv("KOKORO_ORT_PROVIDERS", raising=False)
    monkeypatch.setenv("KOKORO_DEVICE", "cuda:1")

    mock_session = MagicMock()
    mock_session._model_path = str(fake_weight_files["model"])

    class _PinKokoro:
        def __init__(self, model_path: str, voices_path: str) -> None:
            self._voices = list(_FAKE_VOICE_MANIFEST)
            self.sess = None

        @classmethod
        def from_session(cls, session, voices_path, espeak_config=None, vocab_config=None):
            instance = cls.__new__(cls)
            instance._voices = list(_FAKE_VOICE_MANIFEST)
            instance.sess = session
            return instance

        def get_voices(self):
            return list(self._voices)

        def create(self, text: str, voice: str, speed: float, lang: str):
            return np.zeros(24000, dtype=np.float32), 24000

    fake_mod = types.ModuleType("kokoro_onnx")
    fake_mod.Kokoro = _PinKokoro  # type: ignore[attr-defined]
    monkeypatch.setitem(sys.modules, "kokoro_onnx", fake_mod)

    with patch(
        "onnxruntime.get_available_providers",
        return_value=["CUDAExecutionProvider", "CPUExecutionProvider"],
    ), patch("onnxruntime.cuda_version", "12.4", create=True), \
         patch("onnxruntime.InferenceSession") as mock_ort_session_class:
        mock_ort_session_class.return_value = mock_session
        engine = main.KokoroEngine()
        engine._ensure_loaded("v1")

        mock_ort_session_class.assert_called_once()
        call_args = mock_ort_session_class.call_args
        assert call_args[1]["providers"] == ["CUDAExecutionProvider", "CPUExecutionProvider"]
        assert call_args[1]["provider_options"] == [{"device_id": 1}, {}]
        assert engine._kokoro.sess is mock_session


def test_kokoro_session_device_drift_reports_unknown_not_false_cpu(
    fake_weight_files, monkeypatch
) -> None:
    """#2647 regression: `_kokoro_session_device` reading the ORT session's
    providers can itself fail -- kokoro-onnx API drift, or any other
    exception -- and returns None in that case. Before this fix,
    `_ensure_loaded` fell back to `resolved_device` (the requested/intent
    device) whenever that happened:

        self._resolved_device = _kokoro_session_device(self) or resolved_device

    which manufactured a confident but FALSE "cpu" claim (or masked a real
    fallback with the cuda intent) — "cpu" was also KokoroEngine.__init__'s
    own placeholder value, so the two meanings were indistinguishable and
    the honest "unknown" reconcile in `_engine_actual_card` was unreachable
    for Kokoro.

    This uses a REAL `KokoroEngine()` (its actual `__init__` sets
    `_resolved_device`) and drives it through the actual `_ensure_loaded`
    load path -- not a hand-built stand-in missing an attribute production
    code always sets -- so the test breaks if `__init__` or the load path's
    handling of `_resolved_device` regresses."""
    from unittest.mock import MagicMock, patch

    # Requested cuda: if a false "cpu" claim leaked through, `fell_back`
    # would wrongly flip True (or a real fallback would wrongly read as
    # "no fallback" via the cuda intent) -- either way the badge would lie.
    monkeypatch.setenv("KOKORO_DEVICE", "cuda:0")

    class _DriftedSession:
        """Simulates kokoro-onnx API drift: the ORT session no longer
        exposes get_providers() the way `_kokoro_session_device` expects."""

        def get_providers(self):
            raise AttributeError("get_providers removed in this kokoro-onnx release")

    class _DriftKokoro:
        def __init__(self, model_path: str, voices_path: str) -> None:
            self._voices = list(_FAKE_VOICE_MANIFEST)
            self.sess = None

        @classmethod
        def from_session(cls, session, voices_path, espeak_config=None, vocab_config=None):
            instance = cls.__new__(cls)
            instance._voices = list(_FAKE_VOICE_MANIFEST)
            instance.sess = _DriftedSession()
            return instance

        def get_voices(self):
            return list(self._voices)

        def create(self, text: str, voice: str, speed: float, lang: str):
            return np.zeros(24000, dtype=np.float32), 24000

    fake_mod = types.ModuleType("kokoro_onnx")
    fake_mod.Kokoro = _DriftKokoro
    monkeypatch.setitem(sys.modules, "kokoro_onnx", fake_mod)

    mock_session = MagicMock()
    mock_session._model_path = str(fake_weight_files["model"])

    with patch(
        "onnxruntime.get_available_providers",
        return_value=["CUDAExecutionProvider", "CPUExecutionProvider"],
    ), patch("onnxruntime.cuda_version", "12.4", create=True), \
         patch("onnxruntime.InferenceSession") as mock_ort_session_class:
        mock_ort_session_class.return_value = mock_session
        engine = main.KokoroEngine()
        engine._ensure_loaded("v1")

        # The load succeeded (a real model is resident) but the ORT session
        # read drifted -- `_resolved_device` must stay at its "unknown" (None)
        # value, never fall back to the requested/intent device.
        assert engine._kokoro is not None
        assert engine._resolved_device is None

        card = main._engine_actual_card(engine)
        assert card is not None
        assert card["family"] == "unknown"
        assert card["fell_back"] is False


def test_kokoro_default_config_admitted_cuda_landing_on_cpu_flags_fell_back(
    fake_weight_files, monkeypatch
) -> None:
    """#2647 (the ticket's actual regression, distinct from the drift test
    above): on the SHIPPED DEFAULT (KOKORO_DEVICE unset), a load the VRAM
    ledger admits onto cuda (`_ensure_loaded(..., device="cuda:0")` — the
    real `/load` route's admission call shape) that silently lands on cpu
    providers must flag `fell_back = True`.

    Before this fix, `_engine_actual_card`'s `requested_fam` came from
    `_requested_device` — written ONCE at `__init__` from `KOKORO_DEVICE` and
    never touched again. On the default (unset) config that is "auto"
    forever, no matter what a per-load admission decides, so
    `requested_fam == "cuda"` could never be true and `fell_back` was dead
    code on every shipped install — the actual bug #2636 introduced. The fix
    compares against `_device` instead, which the admission overwrites for
    THIS load before it runs, and which a successful load leaves holding
    that same concrete decision.

    Uses a REAL `KokoroEngine()` driven through the actual `_ensure_loaded`
    load path (not a hand-built stand-in), so this breaks if `__init__` or
    the load path's admission handling regresses."""
    from unittest.mock import MagicMock, patch

    monkeypatch.delenv("KOKORO_DEVICE", raising=False)  # the shipped default

    class _CpuOnlySession:
        """A real ORT session that only ended up with CPU providers despite
        being asked to build with CUDA+CPU below -- the actual silent-
        fallback shape (#2534/#2600/#2621), not an exception/API-drift."""

        def get_providers(self):
            return ["CPUExecutionProvider"]

    class _SilentFallbackKokoro:
        def __init__(self, model_path: str, voices_path: str) -> None:
            self._voices = list(_FAKE_VOICE_MANIFEST)
            self.sess = None

        @classmethod
        def from_session(cls, session, voices_path, espeak_config=None, vocab_config=None):
            instance = cls.__new__(cls)
            instance._voices = list(_FAKE_VOICE_MANIFEST)
            instance.sess = _CpuOnlySession()
            return instance

        def get_voices(self):
            return list(self._voices)

        def create(self, text: str, voice: str, speed: float, lang: str):
            return np.zeros(24000, dtype=np.float32), 24000

    fake_mod = types.ModuleType("kokoro_onnx")
    fake_mod.Kokoro = _SilentFallbackKokoro
    monkeypatch.setitem(sys.modules, "kokoro_onnx", fake_mod)

    mock_session = MagicMock()
    mock_session._model_path = str(fake_weight_files["model"])

    with patch(
        "onnxruntime.get_available_providers",
        return_value=["CUDAExecutionProvider", "CPUExecutionProvider"],
    ), patch("onnxruntime.cuda_version", "12.4", create=True), \
         patch("onnxruntime.InferenceSession") as mock_ort_session_class:
        mock_ort_session_class.return_value = mock_session
        engine = main.KokoroEngine()
        # The VRAM-ledger admission call shape (see /load's kokoro branch):
        # a concrete `device=` argument overrides the env-derived pref for
        # THIS cold load, even though KOKORO_DEVICE is unset.
        engine._ensure_loaded("v1", device="cuda:0")

        # This load's own intent was cuda:0 (the admission), confirmed on
        # the real attribute _ensure_loaded's publish-on-success writes.
        assert engine._device == "cuda:0"
        # ...but the ORT session actually only carries CPU providers.
        assert engine._resolved_device == "cpu"

        card = main._engine_actual_card(engine)
        assert card is not None
        assert card["family"] == "cpu"
        assert card["fell_back"] is True


def test_cuda_selftest_flags_silent_fallback_and_warns(
    fake_weight_files, monkeypatch, caplog
) -> None:
    """Castwright#2709: the real-session CUDA self-test that rides
    `_ensure_loaded`'s own session construction. Modeled directly on
    `test_kokoro_default_config_admitted_cuda_landing_on_cpu_flags_fell_back`
    above (same fake session/kokoro shapes) — CUDA was requested and reported
    available, but the real session's `get_providers()` comes back CPU-only.
    `_cuda_verification_state` must record verified=False and a real
    `log.warning` must fire (not just "no exception was raised")."""
    import logging
    from unittest.mock import MagicMock, patch

    monkeypatch.delenv("KOKORO_DEVICE", raising=False)  # the shipped default

    class _CpuOnlySession:
        def get_providers(self):
            return ["CPUExecutionProvider"]

    class _SilentFallbackKokoro:
        def __init__(self, model_path: str, voices_path: str) -> None:
            self._voices = list(_FAKE_VOICE_MANIFEST)
            self.sess = None

        @classmethod
        def from_session(cls, session, voices_path, espeak_config=None, vocab_config=None):
            instance = cls.__new__(cls)
            instance._voices = list(_FAKE_VOICE_MANIFEST)
            instance.sess = _CpuOnlySession()
            return instance

        def get_voices(self):
            return list(self._voices)

        def create(self, text: str, voice: str, speed: float, lang: str):
            return np.zeros(24000, dtype=np.float32), 24000

    fake_mod = types.ModuleType("kokoro_onnx")
    fake_mod.Kokoro = _SilentFallbackKokoro
    monkeypatch.setitem(sys.modules, "kokoro_onnx", fake_mod)

    mock_session = MagicMock()
    mock_session._model_path = str(fake_weight_files["model"])
    mock_session.get_providers.return_value = ["CPUExecutionProvider"]

    with patch(
        "onnxruntime.get_available_providers",
        return_value=["CUDAExecutionProvider", "CPUExecutionProvider"],
    ), patch("onnxruntime.cuda_version", "12.4", create=True), \
         patch("onnxruntime.InferenceSession") as mock_ort_session_class:
        mock_ort_session_class.return_value = mock_session
        engine = main.KokoroEngine()
        with caplog.at_level(logging.WARNING, logger="sidecar"):
            engine._ensure_loaded("v1", device="cuda:0")

        assert main._cuda_verification_state["checked"] is True
        assert main._cuda_verification_state["verified"] is False
        assert "CUDAExecutionProvider was requested" in main._cuda_verification_state["detail"]
        assert any(
            "CUDAExecutionProvider was requested" in rec.message
            for rec in caplog.records
        ), f"expected a CUDA self-test warning, got: {[r.message for r in caplog.records]}"


def test_cuda_selftest_verified_true_when_cuda_actually_lands_no_warning(
    fake_weight_files, monkeypatch, caplog
) -> None:
    """Success path counterpart: the real session's first provider IS
    CUDAExecutionProvider, so the self-test must record verified=True and
    must NOT log a warning."""
    import logging
    from unittest.mock import MagicMock, patch

    monkeypatch.delenv("KOKORO_DEVICE", raising=False)

    class _CudaSession:
        def get_providers(self):
            return ["CUDAExecutionProvider", "CPUExecutionProvider"]

    class _CudaLandingKokoro:
        def __init__(self, model_path: str, voices_path: str) -> None:
            self._voices = list(_FAKE_VOICE_MANIFEST)
            self.sess = None

        @classmethod
        def from_session(cls, session, voices_path, espeak_config=None, vocab_config=None):
            instance = cls.__new__(cls)
            instance._voices = list(_FAKE_VOICE_MANIFEST)
            instance.sess = _CudaSession()
            return instance

        def get_voices(self):
            return list(self._voices)

        def create(self, text: str, voice: str, speed: float, lang: str):
            return np.zeros(24000, dtype=np.float32), 24000

    fake_mod = types.ModuleType("kokoro_onnx")
    fake_mod.Kokoro = _CudaLandingKokoro
    monkeypatch.setitem(sys.modules, "kokoro_onnx", fake_mod)

    mock_session = MagicMock()
    mock_session._model_path = str(fake_weight_files["model"])
    mock_session.get_providers.return_value = ["CUDAExecutionProvider", "CPUExecutionProvider"]

    with patch(
        "onnxruntime.get_available_providers",
        return_value=["CUDAExecutionProvider", "CPUExecutionProvider"],
    ), patch("onnxruntime.cuda_version", "12.4", create=True), \
         patch("onnxruntime.InferenceSession") as mock_ort_session_class:
        mock_ort_session_class.return_value = mock_session
        engine = main.KokoroEngine()
        with caplog.at_level(logging.WARNING, logger="sidecar"):
            engine._ensure_loaded("v1", device="cuda:0")

        assert main._cuda_verification_state["checked"] is True
        assert main._cuda_verification_state["verified"] is True
        assert main._cuda_verification_state["detail"] is None
        assert not any(
            "CUDA self-test" in rec.message for rec in caplog.records
        )


def test_cuda_selftest_exception_reading_providers_does_not_leak_raw_exception(
    fake_weight_files, monkeypatch, caplog
) -> None:
    """PR #2719 regression: when session.get_providers() raises an exception,
    the detail field in _cuda_verification_state must NOT contain the raw
    exception text, which could leak stack-trace fragments or file paths to
    /health callers (CodeQL py/stack-trace-exposure). The raw exception must
    be logged for diagnosability, but the detail field must be curated."""
    import logging
    from unittest.mock import MagicMock, patch

    monkeypatch.delenv("KOKORO_DEVICE", raising=False)

    class _BrokenKokoro:
        def __init__(self, model_path: str, voices_path: str) -> None:
            self._voices = list(_FAKE_VOICE_MANIFEST)

        @classmethod
        def from_session(cls, session, voices_path, espeak_config=None, vocab_config=None):
            instance = cls.__new__(cls)
            instance._voices = list(_FAKE_VOICE_MANIFEST)
            return instance

        def get_voices(self):
            return list(self._voices)

        def create(self, text: str, voice: str, speed: float, lang: str):
            return np.zeros(24000, dtype=np.float32), 24000

    fake_mod = types.ModuleType("kokoro_onnx")
    fake_mod.Kokoro = _BrokenKokoro
    monkeypatch.setitem(sys.modules, "kokoro_onnx", fake_mod)

    mock_session = MagicMock()
    mock_session._model_path = str(fake_weight_files["model"])
    # Make get_providers() raise an exception to simulate API drift
    mock_session.get_providers.side_effect = RuntimeError(
        "API drift: get_providers() removed from onnxruntime.InferenceSession"
    )

    with patch(
        "onnxruntime.get_available_providers",
        return_value=["CUDAExecutionProvider", "CPUExecutionProvider"],
    ), patch("onnxruntime.cuda_version", "12.4", create=True), \
         patch("onnxruntime.InferenceSession") as mock_ort_session_class:
        mock_ort_session_class.return_value = mock_session
        engine = main.KokoroEngine()
        with caplog.at_level(logging.WARNING, logger="sidecar"):
            engine._ensure_loaded("v1", device="cuda:0")

        # Verify the state is recorded
        assert main._cuda_verification_state["checked"] is True
        assert main._cuda_verification_state["verified"] is None
        detail = main._cuda_verification_state["detail"]
        assert detail is not None

        # SECURITY CHECK: detail must NOT contain the raw exception text
        # or any trace of the specific error message
        assert "API drift" not in detail, \
            f"Detail leaks raw exception: {detail}"
        assert "get_providers" not in detail, \
            f"Detail leaks method name from exception: {detail}"
        assert "onnxruntime" not in detail.lower(), \
            f"Detail leaks module name from exception: {detail}"

        # DIAGNOSABILITY CHECK: detail must still be informative
        assert "Could not read" in detail, \
            f"Detail is not informative enough: {detail}"
        assert len(detail) > 0, "Detail must be non-empty"

        # RAW EXCEPTION LOG CHECK: the raw exception must be logged
        # for operators to diagnose, just not in the HTTP response
        assert any(
            "Failed to read the real session's providers" in rec.message
            for rec in caplog.records
        ), f"Expected exception log, got: {[r.message for r in caplog.records]}"


def test_cuda_selftest_empty_providers_list_verified_false(
    fake_weight_files, monkeypatch, caplog
) -> None:
    """Castwright#2709 regression: when session.get_providers() returns an
    empty list (API drift or unusual edge case), the self-test must record
    verified=False, not verified=True. Before the fix, the buggy check
    `actual_providers[:1] == ["CPUExecutionProvider"]` would evaluate to
    `[] == ["CPUExecutionProvider"]` (False), and the `else` branch would
    wrongly report verified=True."""
    import logging
    from unittest.mock import MagicMock, patch

    monkeypatch.delenv("KOKORO_DEVICE", raising=False)

    class _EmptyProvidersKokoro:
        def __init__(self, model_path: str, voices_path: str) -> None:
            self._voices = list(_FAKE_VOICE_MANIFEST)
            self.sess = None

        @classmethod
        def from_session(cls, session, voices_path, espeak_config=None, vocab_config=None):
            instance = cls.__new__(cls)
            instance._voices = list(_FAKE_VOICE_MANIFEST)
            instance.sess = _EmptyProvidersSession()
            return instance

        def get_voices(self):
            return list(self._voices)

        def create(self, text: str, voice: str, speed: float, lang: str):
            return np.zeros(24000, dtype=np.float32), 24000

    class _EmptyProvidersSession:
        """Simulates API drift or unusual case: get_providers() returns empty."""
        def get_providers(self):
            return []

    fake_mod = types.ModuleType("kokoro_onnx")
    fake_mod.Kokoro = _EmptyProvidersKokoro
    monkeypatch.setitem(sys.modules, "kokoro_onnx", fake_mod)

    mock_session = MagicMock()
    mock_session._model_path = str(fake_weight_files["model"])
    mock_session.get_providers.return_value = []

    with patch(
        "onnxruntime.get_available_providers",
        return_value=["CUDAExecutionProvider", "CPUExecutionProvider"],
    ), patch("onnxruntime.cuda_version", "12.4", create=True), \
         patch("onnxruntime.InferenceSession") as mock_ort_session_class:
        mock_ort_session_class.return_value = mock_session
        engine = main.KokoroEngine()
        with caplog.at_level(logging.WARNING, logger="sidecar"):
            engine._ensure_loaded("v1", device="cuda:0")

        # Empty provider list means CUDA did not land
        assert main._cuda_verification_state["checked"] is True
        assert main._cuda_verification_state["verified"] is False
        assert main._cuda_verification_state["detail"] is not None
        # Verify a warning was logged
        assert any(
            "CUDA" in rec.message for rec in caplog.records
        ), "Expected a CUDA self-test warning"


def test_cuda_selftest_directml_without_cuda_verified_false(
    fake_weight_files, monkeypatch, caplog
) -> None:
    """Castwright#2709 regression: when session.get_providers() reports
    DirectML and CPU (CUDA absent), the self-test must record verified=False.
    Before the fix, the buggy check `actual_providers[:1] == ["CPUExecutionProvider"]`
    would evaluate to `["DmlExecutionProvider", "CPUExecutionProvider"][:1] ==
    ["CPUExecutionProvider"]` (False), and the `else` branch would wrongly
    report verified=True even though CUDA never landed."""
    import logging
    from unittest.mock import MagicMock, patch

    monkeypatch.delenv("KOKORO_DEVICE", raising=False)

    class _DirectmlOnlyKokoro:
        def __init__(self, model_path: str, voices_path: str) -> None:
            self._voices = list(_FAKE_VOICE_MANIFEST)
            self.sess = None

        @classmethod
        def from_session(cls, session, voices_path, espeak_config=None, vocab_config=None):
            instance = cls.__new__(cls)
            instance._voices = list(_FAKE_VOICE_MANIFEST)
            instance.sess = _DirectmlSession()
            return instance

        def get_voices(self):
            return list(self._voices)

        def create(self, text: str, voice: str, speed: float, lang: str):
            return np.zeros(24000, dtype=np.float32), 24000

    class _DirectmlSession:
        """ORT session that landed on DirectML (e.g. AMD Windows), not CUDA."""
        def get_providers(self):
            return ["DmlExecutionProvider", "CPUExecutionProvider"]

    fake_mod = types.ModuleType("kokoro_onnx")
    fake_mod.Kokoro = _DirectmlOnlyKokoro
    monkeypatch.setitem(sys.modules, "kokoro_onnx", fake_mod)

    mock_session = MagicMock()
    mock_session._model_path = str(fake_weight_files["model"])
    mock_session.get_providers.return_value = ["DmlExecutionProvider", "CPUExecutionProvider"]

    with patch(
        "onnxruntime.get_available_providers",
        return_value=["DmlExecutionProvider", "CUDAExecutionProvider", "CPUExecutionProvider"],
    ), patch("onnxruntime.cuda_version", "12.4", create=True), \
         patch("onnxruntime.InferenceSession") as mock_ort_session_class:
        mock_ort_session_class.return_value = mock_session
        engine = main.KokoroEngine()
        with caplog.at_level(logging.WARNING, logger="sidecar"):
            engine._ensure_loaded("v1", device="cuda:0")

        # DirectML without CUDA means CUDA did not land
        assert main._cuda_verification_state["checked"] is True
        assert main._cuda_verification_state["verified"] is False
        assert main._cuda_verification_state["detail"] is not None
        # Verify a warning was logged
        assert any(
            "CUDA" in rec.message for rec in caplog.records
        ), "Expected a CUDA self-test warning"


def test_cuda_selftest_fires_on_shipped_auto_path_not_just_explicit_device_pin(
    fake_weight_files, monkeypatch, caplog
) -> None:
    """#2719 regression: the CUDA self-test must fire on the shipped default
    `auto` path, not just when device= is explicitly pinned. The existing
    `test_cuda_selftest_flags_silent_fallback_and_warns` and
    `test_cuda_selftest_verified_true_when_cuda_actually_lands_no_warning` both
    pass device="cuda:0" explicitly, bypassing the auto-resolution path that
    EVERY real generation uses (KokoroEngine.synthesize, PRELOAD_KOKORO warm-up,
    admission-off /load all use _ensure_loaded("v1") without device=).

    This test exercises the real shipped path: KOKORO_DEVICE unset, device=
    argument absent, CUDA available per onnxruntime but session lands on CPU
    only (silent fallback). The self-test must detect this and set
    verified=False with a warning, not silently pass because the explicit
    device= override was missing."""
    import logging
    from unittest.mock import MagicMock, patch

    monkeypatch.delenv("KOKORO_DEVICE", raising=False)  # the shipped default
    monkeypatch.delenv("KOKORO_ORT_PROVIDERS", raising=False)

    class _CpuOnlySession:
        """Silent fallback shape: session built with CUDA in the provider list
        but actually only carries CPU providers."""
        def get_providers(self):
            return ["CPUExecutionProvider"]

    class _AutoPathKokoro:
        def __init__(self, model_path: str, voices_path: str) -> None:
            self._voices = list(_FAKE_VOICE_MANIFEST)
            self.sess = None

        @classmethod
        def from_session(cls, session, voices_path, espeak_config=None, vocab_config=None):
            instance = cls.__new__(cls)
            instance._voices = list(_FAKE_VOICE_MANIFEST)
            instance.sess = _CpuOnlySession()
            return instance

        def get_voices(self):
            return list(self._voices)

        def create(self, text: str, voice: str, speed: float, lang: str):
            return np.zeros(24000, dtype=np.float32), 24000

    fake_mod = types.ModuleType("kokoro_onnx")
    fake_mod.Kokoro = _AutoPathKokoro
    monkeypatch.setitem(sys.modules, "kokoro_onnx", fake_mod)

    mock_session = MagicMock()
    mock_session._model_path = str(fake_weight_files["model"])
    mock_session.get_providers.return_value = ["CPUExecutionProvider"]

    with patch(
        "onnxruntime.get_available_providers",
        return_value=["CUDAExecutionProvider", "CPUExecutionProvider"],
    ), patch("onnxruntime.cuda_version", "12.4", create=True), \
         patch("onnxruntime.InferenceSession") as mock_ort_session_class:
        mock_ort_session_class.return_value = mock_session
        engine = main.KokoroEngine()
        with caplog.at_level(logging.WARNING, logger="sidecar"):
            # The shipped default path: no device= argument, auto-resolution
            # resolves to "cuda" (CUDA available) but session lands on CPU only.
            engine._ensure_loaded("v1")

        # Self-test must have run and detected the fallback
        assert main._cuda_verification_state["checked"] is True
        assert main._cuda_verification_state["verified"] is False
        assert "CUDAExecutionProvider was requested" in main._cuda_verification_state["detail"]
        # Verify a warning was logged
        assert any(
            "CUDAExecutionProvider was requested" in rec.message
            for rec in caplog.records
        ), f"expected a CUDA self-test warning on the auto path, got: {[r.message for r in caplog.records]}"


def test_engine_actual_card_kokoro_auto_intent_cpu_result_is_not_fell_back(
    fake_weight_files, monkeypatch
) -> None:
    """#2643 supersedes #2647's "stays literally 'auto' forever" premise for
    Kokoro: NOTHING asked for cuda for this load — no KOKORO_DEVICE env pin,
    no VRAM-ledger admission override, AND no usable CUDA build/device on this
    box — so `_ensure_loaded` resolves the "auto" intent to the concrete card
    it actually attempted, which is "cpu" (constraint 3 of #2643: no CUDA
    available means the intent itself IS cpu). `fell_back` stays False, but
    for the RIGHT reason now: this load's own intent (`_device` == "cpu")
    matches its outcome, not because "auto" can never equal "cuda" in the
    comparison. Contrast
    `test_kokoro_default_config_admitted_cuda_landing_on_cpu_flags_fell_back`
    (an ADMISSION asks for cuda) and
    `test_engine_actual_card_kokoro_auto_resolved_cuda_intent_silently_lands_on_cpu_flags_fell_back`
    below (auto-resolution itself asks for cuda) — both must fire.

    Real `KokoroEngine()` through the actual `_ensure_loaded` load path, same
    standard as the other regression tests in this file. `onnxruntime`'s CUDA
    probe is patched to report no usable GPU so this test's outcome doesn't
    depend on the box it happens to run on."""
    from unittest.mock import MagicMock, patch

    monkeypatch.delenv("KOKORO_DEVICE", raising=False)  # the shipped default
    monkeypatch.delenv("KOKORO_ORT_PROVIDERS", raising=False)

    class _CpuOnlySession:
        def get_providers(self):
            return ["CPUExecutionProvider"]

    class _AutoCpuKokoro:
        def __init__(self, model_path: str, voices_path: str) -> None:
            self._voices = list(_FAKE_VOICE_MANIFEST)
            self.sess = None

        @classmethod
        def from_session(cls, session, voices_path, espeak_config=None, vocab_config=None):
            instance = cls.__new__(cls)
            instance._voices = list(_FAKE_VOICE_MANIFEST)
            instance.sess = _CpuOnlySession()
            return instance

        def get_voices(self):
            return list(self._voices)

        def create(self, text: str, voice: str, speed: float, lang: str):
            return np.zeros(24000, dtype=np.float32), 24000

    fake_mod = types.ModuleType("kokoro_onnx")
    fake_mod.Kokoro = _AutoCpuKokoro
    monkeypatch.setitem(sys.modules, "kokoro_onnx", fake_mod)

    mock_session = MagicMock()
    mock_session._model_path = str(fake_weight_files["model"])

    with patch(
        "onnxruntime.get_available_providers", return_value=["CPUExecutionProvider"],
    ), patch("onnxruntime.InferenceSession") as mock_ort_session_class:
        mock_ort_session_class.return_value = mock_session
        engine = main.KokoroEngine()
        # No device= override -- no admission ever ran for this load.
        engine._ensure_loaded("v1")

        # No usable GPU on this (simulated) box -- the auto intent resolves
        # concretely to "cpu", not the literal string "auto" (#2643).
        assert engine._device == "cpu"
        assert engine._resolved_device == "cpu"

        card = main._engine_actual_card(engine)
        assert card is not None
        assert card["family"] == "cpu"
        assert card["fell_back"] is False


def test_engine_actual_card_kokoro_auto_resolved_cuda_intent_silently_lands_on_cpu_flags_fell_back(
    fake_weight_files, monkeypatch
) -> None:
    """#2643 (the actual remaining gap): the shipped default for EVERY real
    generation path — `KokoroEngine.synthesize`, the PRELOAD_KOKORO warm path,
    and the admission-off `/load` branch — is KOKORO_DEVICE unset AND no
    `device=` argument at all, so `resolved_device` stays "auto" all the way
    into `_ensure_loaded`. Before #2643, nothing ever resolved that "auto"
    into a concrete card before publish, so `_device` stayed the literal
    string "auto" forever and `fell_back` was structurally dead on exactly
    this path (`_parse_device("auto") != "cuda"`).

    Here CUDA IS available (per onnxruntime's own reported build/runtime
    state) -- so auto-resolution's own intent is "cuda" -- but the ORT
    session that actually got built only carries CPU providers (the silent
    fallback shape, same as #2534/#2600/#2621). That is a genuine unrequested
    fallback and must flag `fell_back = True`, exactly like an explicit env
    pin or an admitted `device=` would."""
    from unittest.mock import MagicMock, patch

    monkeypatch.delenv("KOKORO_DEVICE", raising=False)  # the shipped default
    monkeypatch.delenv("KOKORO_ORT_PROVIDERS", raising=False)

    class _CpuOnlySession:
        """The ORT session actually only carries CPU providers despite CUDA
        being offered in the build list below -- the silent-fallback shape."""

        def get_providers(self):
            return ["CPUExecutionProvider"]

    class _SilentFallbackKokoro:
        def __init__(self, model_path: str, voices_path: str) -> None:
            self._voices = list(_FAKE_VOICE_MANIFEST)
            self.sess = None

        @classmethod
        def from_session(cls, session, voices_path, espeak_config=None, vocab_config=None):
            instance = cls.__new__(cls)
            instance._voices = list(_FAKE_VOICE_MANIFEST)
            instance.sess = _CpuOnlySession()
            return instance

        def get_voices(self):
            return list(self._voices)

        def create(self, text: str, voice: str, speed: float, lang: str):
            return np.zeros(24000, dtype=np.float32), 24000

    fake_mod = types.ModuleType("kokoro_onnx")
    fake_mod.Kokoro = _SilentFallbackKokoro
    monkeypatch.setitem(sys.modules, "kokoro_onnx", fake_mod)

    mock_session = MagicMock()
    mock_session._model_path = str(fake_weight_files["model"])

    with patch(
        "onnxruntime.get_available_providers",
        return_value=["CUDAExecutionProvider", "CPUExecutionProvider"],
    ), patch("onnxruntime.cuda_version", "12.4", create=True), \
         patch("onnxruntime.InferenceSession") as mock_ort_session_class:
        mock_ort_session_class.return_value = mock_session
        engine = main.KokoroEngine()
        # No device= override, no env pin -- the real-generation call shape.
        engine._ensure_loaded("v1")

        # Auto-resolution's own intent was cuda (CUDA is usable on this box).
        assert engine._device == "cuda"
        # ...but the ORT session actually only carries CPU providers.
        assert engine._resolved_device == "cpu"

        card = main._engine_actual_card(engine)
        assert card is not None
        assert card["family"] == "cpu"
        assert card["fell_back"] is True


def test_engine_actual_card_kokoro_env_pinned_cuda_silently_lands_on_cpu_flags_fell_back(
    fake_weight_files, monkeypatch
) -> None:
    """Genuine pinned cuda (KOKORO_DEVICE=cuda:0, no admission override) that
    silently lands on cpu must fire `fell_back` -- the sibling of the
    auto-resolved case above, confirming an explicit pin still takes the
    non-"auto" branch of the #2643 fix unchanged."""
    from unittest.mock import MagicMock, patch

    monkeypatch.setenv("KOKORO_DEVICE", "cuda:0")
    monkeypatch.delenv("KOKORO_ORT_PROVIDERS", raising=False)

    class _CpuOnlySession:
        def get_providers(self):
            return ["CPUExecutionProvider"]

    class _SilentFallbackKokoro:
        def __init__(self, model_path: str, voices_path: str) -> None:
            self._voices = list(_FAKE_VOICE_MANIFEST)
            self.sess = None

        @classmethod
        def from_session(cls, session, voices_path, espeak_config=None, vocab_config=None):
            instance = cls.__new__(cls)
            instance._voices = list(_FAKE_VOICE_MANIFEST)
            instance.sess = _CpuOnlySession()
            return instance

        def get_voices(self):
            return list(self._voices)

        def create(self, text: str, voice: str, speed: float, lang: str):
            return np.zeros(24000, dtype=np.float32), 24000

    fake_mod = types.ModuleType("kokoro_onnx")
    fake_mod.Kokoro = _SilentFallbackKokoro
    monkeypatch.setitem(sys.modules, "kokoro_onnx", fake_mod)

    mock_session = MagicMock()
    mock_session._model_path = str(fake_weight_files["model"])

    with patch(
        "onnxruntime.get_available_providers",
        return_value=["CUDAExecutionProvider", "CPUExecutionProvider"],
    ), patch("onnxruntime.cuda_version", "12.4", create=True), \
         patch("onnxruntime.InferenceSession") as mock_ort_session_class:
        mock_ort_session_class.return_value = mock_session
        engine = main.KokoroEngine()
        engine._ensure_loaded("v1")  # no device= override -- the pin alone

        assert engine._device == "cuda:0"
        assert engine._resolved_device == "cpu"

        card = main._engine_actual_card(engine)
        assert card is not None
        assert card["family"] == "cpu"
        assert card["fell_back"] is True


def test_engine_actual_card_kokoro_admitted_cpu_overrides_cuda_pin_not_fell_back(
    fake_weight_files, monkeypatch
) -> None:
    """The ratified COMPLIANCE case: a VRAM-ledger admission onto cpu for
    THIS load, while KOKORO_DEVICE pins cuda:1, must keep winning over
    auto-resolution and must NOT flag `fell_back` -- the ledger's own
    capacity-driven decision is compliance, not a silent fallback. Real
    `KokoroEngine()` + `_ensure_loaded(..., device="cpu")`, the actual
    admission call shape `/load`'s VRAM-ledger branch uses."""
    from unittest.mock import MagicMock, patch

    monkeypatch.setenv("KOKORO_DEVICE", "cuda:1")
    monkeypatch.delenv("KOKORO_ORT_PROVIDERS", raising=False)

    class _CpuOnlySession:
        def get_providers(self):
            return ["CPUExecutionProvider"]

    class _AdmittedCpuKokoro:
        def __init__(self, model_path: str, voices_path: str) -> None:
            self._voices = list(_FAKE_VOICE_MANIFEST)
            self.sess = None

        @classmethod
        def from_session(cls, session, voices_path, espeak_config=None, vocab_config=None):
            instance = cls.__new__(cls)
            instance._voices = list(_FAKE_VOICE_MANIFEST)
            instance.sess = _CpuOnlySession()
            return instance

        def get_voices(self):
            return list(self._voices)

        def create(self, text: str, voice: str, speed: float, lang: str):
            return np.zeros(24000, dtype=np.float32), 24000

    fake_mod = types.ModuleType("kokoro_onnx")
    fake_mod.Kokoro = _AdmittedCpuKokoro
    monkeypatch.setitem(sys.modules, "kokoro_onnx", fake_mod)

    mock_session = MagicMock()
    mock_session._model_path = str(fake_weight_files["model"])

    with patch("onnxruntime.InferenceSession") as mock_ort_session_class:
        mock_ort_session_class.return_value = mock_session
        engine = main.KokoroEngine()
        # The VRAM ledger admitted this load onto cpu -- overrides the
        # KOKORO_DEVICE=cuda:1 pin for THIS cold load only.
        engine._ensure_loaded("v1", device="cpu")

        assert engine._device == "cpu"
        assert engine._resolved_device == "cpu"

        card = main._engine_actual_card(engine)
        assert card is not None
        assert card["family"] == "cpu"
        assert card["fell_back"] is False


def test_kokoro_loads_via_from_session_with_dml_provider_only(
    fake_kokoro_module, fake_weight_files, monkeypatch
) -> None:
    """KOKORO_ORT_PROVIDERS=["DmlExecutionProvider"] (a single entry, no CPU
    tail) still builds via from_session and completes the DirectML
    self-test without raising. Renamed from the old
    test_kokoro_falls_back_when_constructor_rejects_providers, whose name
    and docstring both described a providers=-rejection fallback that this
    test does not exercise -- it sets KOKORO_ORT_PROVIDERS, so it is on the
    explicit-providers path, not a no-providers path (#2631 review M3)."""
    from unittest.mock import patch, MagicMock

    mock_session = MagicMock()
    mock_session._model_path = str(fake_weight_files["model"])

    monkeypatch.setenv("KOKORO_ORT_PROVIDERS", '["DmlExecutionProvider"]')

    with patch("onnxruntime.InferenceSession") as mock_ort_session:
        mock_ort_session.return_value = mock_session
        engine = main.KokoroEngine()
        engine._ensure_loaded("v1")  # must not raise
        assert engine._kokoro is not None


def test_kokoro_uses_from_session_when_providers_specified(
    fake_weight_files, monkeypatch
) -> None:
    """#2631: When KOKORO_ORT_PROVIDERS is set, the engine must create an
    InferenceSession with those providers and pass it to Kokoro.from_session(),
    not pass providers= to Kokoro.__init__ (which doesn't accept that kwarg).
    This test verifies the fix by mocking InferenceSession and from_session
    and asserting both are called correctly."""
    from unittest.mock import MagicMock, patch

    # Hermetic: an ambient KOKORO_DEVICE (e.g. cuda:1) would fold a device_id
    # pin into this same session build, making assert_called_once() fail for
    # a reason unrelated to what this test checks (#2631 review M1).
    monkeypatch.delenv("KOKORO_DEVICE", raising=False)

    # Create a mock InferenceSession class
    mock_session = MagicMock()
    mock_session._model_path = str(fake_weight_files["model"])

    # Track calls to from_session
    from_session_calls: list[tuple] = []

    # Create a fake Kokoro that tracks from_session calls
    class _FromSessionKokoro:
        def __init__(self, model_path: str, voices_path: str) -> None:
            self._voices = list(_FAKE_VOICE_MANIFEST)

        @classmethod
        def from_session(
            cls, session, voices_path, espeak_config=None, vocab_config=None
        ):
            from_session_calls.append((session, voices_path, espeak_config, vocab_config))
            instance = cls.__new__(cls)
            instance._voices = list(_FAKE_VOICE_MANIFEST)
            return instance

        def get_voices(self):
            return list(self._voices)

        def create(self, text: str, voice: str, speed: float, lang: str):
            return np.zeros(24000, dtype=np.float32), 24000

    # Inject the fake Kokoro
    fake_mod = types.ModuleType("kokoro_onnx")
    fake_mod.Kokoro = _FromSessionKokoro
    monkeypatch.setitem(sys.modules, "kokoro_onnx", fake_mod)

    # Set providers
    monkeypatch.setenv("KOKORO_ORT_PROVIDERS", '["CUDAExecutionProvider", "CPUExecutionProvider"]')

    # Patch onnxruntime.InferenceSession to return our mock
    with patch("onnxruntime.InferenceSession") as mock_ort_session_class:
        mock_ort_session_class.return_value = mock_session

        engine = main.KokoroEngine()
        engine._ensure_loaded("v1")

        # Verify InferenceSession was created with the right providers
        mock_ort_session_class.assert_called_once()
        call_args = mock_ort_session_class.call_args
        assert call_args[0][0] == str(fake_weight_files["model"])
        assert call_args[1]["providers"] == ["CUDAExecutionProvider", "CPUExecutionProvider"]

        # Verify from_session was called with the session and voices_path
        assert len(from_session_calls) == 1
        session_arg, voices_path_arg, _, _ = from_session_calls[0]
        assert session_arg is mock_session
        assert voices_path_arg == str(fake_weight_files["voices"])

        # Verify the engine loaded successfully
        assert engine._kokoro is not None


def test_kokoro_cpu_admission_device_overrides_injected_cuda_providers(
    fake_weight_files, monkeypatch
) -> None:
    """#2631 review B1: a capacity-ledger CPU placement decision must win over
    whatever provider list the server injected. The server (spawn-sidecar.ts)
    sets KOKORO_ORT_PROVIDERS unconditionally on every spawn -- CUDA on the
    nvidia profile -- so `_ensure_loaded(..., device="cpu")` (the shape the
    VRAM-admission caller uses when the ledger refuses the GPU) must not let
    that injected list put the session on CUDA anyway. Before the fix,
    `providers = self._resolve_ort_providers() or self._default_ort_providers()`
    ignored the device= argument entirely and always took the injected CUDA
    list."""
    from unittest.mock import MagicMock, patch

    monkeypatch.delenv("KOKORO_DEVICE", raising=False)
    monkeypatch.setenv(
        "KOKORO_ORT_PROVIDERS", '["CUDAExecutionProvider", "CPUExecutionProvider"]'
    )

    mock_session = MagicMock()
    mock_session._model_path = str(fake_weight_files["model"])

    class _AdmissionCpuKokoro:
        def __init__(self, model_path: str, voices_path: str) -> None:
            self._voices = list(_FAKE_VOICE_MANIFEST)

        @classmethod
        def from_session(cls, session, voices_path, espeak_config=None, vocab_config=None):
            instance = cls.__new__(cls)
            instance._voices = list(_FAKE_VOICE_MANIFEST)
            return instance

        def get_voices(self):
            return list(self._voices)

        def create(self, text: str, voice: str, speed: float, lang: str):
            return np.zeros(24000, dtype=np.float32), 24000

    fake_mod = types.ModuleType("kokoro_onnx")
    fake_mod.Kokoro = _AdmissionCpuKokoro
    monkeypatch.setitem(sys.modules, "kokoro_onnx", fake_mod)

    with patch("onnxruntime.InferenceSession") as mock_ort_session_class:
        mock_ort_session_class.return_value = mock_session
        engine = main.KokoroEngine()
        engine._ensure_loaded("v1", device="cpu")

        mock_ort_session_class.assert_called_once()
        assert mock_ort_session_class.call_args[1]["providers"] == ["CPUExecutionProvider"]
        assert "CUDAExecutionProvider" not in mock_ort_session_class.call_args[1]["providers"]


def test_kokoro_unload_restores_device_pin_after_cpu_admission(
    fake_weight_files, monkeypatch
) -> None:
    """#2631 review S4: a CPU admission (`_ensure_loaded(..., device="cpu")`)
    must NOT permanently overwrite a KOKORO_DEVICE=cuda:N pin. Before this
    fix, B1 made `_requested_device` -- which `unload()` never restored --
    double as both the pristine env pin AND the per-load admitted device, so
    a CPU admission stuck there until process restart: every later
    `_ensure_loaded()` (even after `unload()`) kept resolving to CPU-only
    providers, silently discarding the operator's card pin. Mirrors
    CoquiEngine's `_device`/`_requested_device` split, whose
    `_drop_model_locked` restores `self._device = self._requested_device`
    (the #1730 gap-3 fix) on every teardown."""
    from unittest.mock import MagicMock, patch

    monkeypatch.delenv("KOKORO_ORT_PROVIDERS", raising=False)
    monkeypatch.setenv("KOKORO_DEVICE", "cuda:0")

    mock_session = MagicMock()
    mock_session._model_path = str(fake_weight_files["model"])

    class _StickyPinKokoro:
        def __init__(self, model_path: str, voices_path: str) -> None:
            self._voices = list(_FAKE_VOICE_MANIFEST)

        @classmethod
        def from_session(cls, session, voices_path, espeak_config=None, vocab_config=None):
            instance = cls.__new__(cls)
            instance._voices = list(_FAKE_VOICE_MANIFEST)
            return instance

        def get_voices(self):
            return list(self._voices)

        def create(self, text: str, voice: str, speed: float, lang: str):
            return np.zeros(24000, dtype=np.float32), 24000

    fake_mod = types.ModuleType("kokoro_onnx")
    fake_mod.Kokoro = _StickyPinKokoro
    monkeypatch.setitem(sys.modules, "kokoro_onnx", fake_mod)

    with patch(
        "onnxruntime.get_available_providers",
        return_value=["CUDAExecutionProvider", "CPUExecutionProvider"],
    ), patch("onnxruntime.cuda_version", "12.4", create=True), \
         patch("onnxruntime.InferenceSession") as mock_ort_session_class:
        mock_ort_session_class.return_value = mock_session

        engine = main.KokoroEngine()
        # Admission ledger refuses the GPU for this cold load.
        engine._ensure_loaded("v1", device="cpu")
        assert mock_ort_session_class.call_args[1]["providers"] == ["CPUExecutionProvider"]

        engine.unload()
        assert engine._kokoro is None

        # No device= argument this time -- a real lazy /synthesize re-load,
        # which must fall back to the env-derived KOKORO_DEVICE=cuda:0 pin,
        # not the stale "cpu" admission from the previous load.
        engine._ensure_loaded("v1")
        assert mock_ort_session_class.call_count == 2
        assert mock_ort_session_class.call_args[1]["providers"] == [
            "CUDAExecutionProvider", "CPUExecutionProvider"
        ]
        assert mock_ort_session_class.call_args[1]["provider_options"] == [{"device_id": 0}, {}]


def test_kokoro_failed_cold_load_does_not_poison_device_pin(
    monkeypatch, tmp_path
) -> None:
    """#2631 review B2: a FAILED cold load must not permanently overwrite
    `self._device`. Before this fix, `_ensure_loaded` wrote `self._device =
    device` unconditionally at the TOP of the method, before every failure
    point (the weights-missing RuntimeError included) -- so a CPU-admitted
    load (`device="cpu"`, the VRAM ledger refusing the GPU under contention)
    that then fails for an ordinary reason left `_device='cpu'` stuck with
    `_kokoro` still `None`. `unload()`'s `if self._kokoro is None: return`
    idempotence guard then made the restore this fix relies on unreachable
    forever: every later lazy reload (even with KOKORO_DEVICE=cuda:0 set)
    kept building CPU-only providers for the rest of the process lifetime --
    verbatim the outcome S4 was raised to prevent, on the one path S4's own
    fix (which only covers a SUCCEEDING load) doesn't reach."""
    from unittest.mock import MagicMock, patch

    monkeypatch.delenv("KOKORO_ORT_PROVIDERS", raising=False)
    monkeypatch.setenv("KOKORO_DEVICE", "cuda:0")
    model_path = tmp_path / "kokoro-v1.0.onnx"
    voices_path = tmp_path / "voices-v1.0.bin"
    # Weights not installed yet -- install-kokoro.ps1 hasn't run. The path is
    # baked into the engine at __init__, so writing real files here later
    # (below) lets the SAME engine instance load successfully afterward.
    monkeypatch.setenv("KOKORO_MODEL_PATH", str(model_path))
    monkeypatch.setenv("KOKORO_VOICES_PATH", str(voices_path))

    class _StickyPinKokoro:
        def __init__(self, model_path: str, voices_path: str) -> None:
            self._voices = list(_FAKE_VOICE_MANIFEST)

        @classmethod
        def from_session(cls, session, voices_path, espeak_config=None, vocab_config=None):
            instance = cls.__new__(cls)
            instance._voices = list(_FAKE_VOICE_MANIFEST)
            return instance

        def get_voices(self):
            return list(self._voices)

        def create(self, text: str, voice: str, speed: float, lang: str):
            return np.zeros(24000, dtype=np.float32), 24000

    fake_mod = types.ModuleType("kokoro_onnx")
    fake_mod.Kokoro = _StickyPinKokoro
    monkeypatch.setitem(sys.modules, "kokoro_onnx", fake_mod)

    engine = main.KokoroEngine()
    assert engine._device == "cuda:0"

    # A CPU-admitted cold load that then fails: weights not installed.
    with pytest.raises(RuntimeError, match="install-kokoro"):
        engine._ensure_loaded("v1", device="cpu")

    # The failed load must not have touched the pin -- this is the bug:
    # pre-fix, `_device` read 'cpu' here even though nothing loaded.
    assert engine._device == "cuda:0"
    assert engine._kokoro is None

    # unload() must be a genuine no-op with nothing to restore -- nothing
    # was ever poisoned in the first place.
    engine.unload()
    assert engine._device == "cuda:0"
    assert engine._kokoro is None

    # Weights now present (install-kokoro.ps1 ran). The next lazy reload (no
    # device= -- a real /synthesize re-load) must still honour the env pin,
    # not a leftover CPU admission from the failed load above.
    model_path.write_bytes(b"")
    voices_path.write_bytes(b"")

    mock_session = MagicMock()
    mock_session._model_path = str(model_path)

    with patch(
        "onnxruntime.get_available_providers",
        return_value=["CUDAExecutionProvider", "CPUExecutionProvider"],
    ), patch("onnxruntime.cuda_version", "12.4", create=True), \
         patch("onnxruntime.InferenceSession") as mock_ort_session_class:
        mock_ort_session_class.return_value = mock_session
        engine._ensure_loaded("v1")
        assert mock_ort_session_class.call_args[1]["providers"] == [
            "CUDAExecutionProvider", "CPUExecutionProvider"
        ]
        assert mock_ort_session_class.call_args[1]["provider_options"] == [{"device_id": 0}, {}]
        assert engine._device == "cuda:0"


def test_kokoro_importerror_remediation_is_profile_aware(
    fake_weight_files, monkeypatch
) -> None:
    """The kokoro-onnx ImportError remediation names the right ONNX-runtime
    package for THIS box's accelerator profile, not a hard-coded NVIDIA hint."""
    # A kokoro_onnx module that lacks `Kokoro` makes `from kokoro_onnx import
    # Kokoro` raise ImportError without needing the real package absent.
    empty_mod = types.ModuleType("kokoro_onnx")
    monkeypatch.setitem(sys.modules, "kokoro_onnx", empty_mod)
    monkeypatch.setattr(main.os, "name", "nt")  # force the Windows branch on any CI

    monkeypatch.setenv("CASTWRIGHT_ACCELERATOR_PROFILE", "amd")
    with pytest.raises(RuntimeError, match="onnxruntime-directml"):
        main.KokoroEngine()._ensure_loaded("v1")

    monkeypatch.setenv("CASTWRIGHT_ACCELERATOR_PROFILE", "nvidia")
    with pytest.raises(RuntimeError, match="NVIDIA"):
        main.KokoroEngine()._ensure_loaded("v1")

    monkeypatch.setenv("CASTWRIGHT_ACCELERATOR_PROFILE", "cpu")
    with pytest.raises(RuntimeError, match="plain onnxruntime"):
        main.KokoroEngine()._ensure_loaded("v1")


class _DmlKokoro:
    """Kokoro stub for the DirectML self-test: records how many times
    create() ran; create() raises when fail_create is set (simulating the
    DML ConvTranspose failure).

    The constructor deliberately does NOT accept a `providers` kwarg,
    matching the real kokoro_onnx==0.5.0 `Kokoro.__init__` signature
    (`(self, model_path, voices_path, espeak_config=None,
    vocab_config=None)`) -- a stub that accepted one would hide a
    production TypeError behind a test double that is more permissive
    than the real class (#2631 review S2)."""

    instances: list["_DmlKokoro"] = []
    fail_create: bool = False

    def __init__(self, model_path: str, voices_path: str) -> None:
        self.create_calls = 0
        self._voices = list(_FAKE_VOICE_MANIFEST)
        type(self).instances.append(self)

    @classmethod
    def from_session(
        cls, session, voices_path: str, espeak_config=None, vocab_config=None
    ) -> "_DmlKokoro":
        """Support from_session classmethod for the fixed code path."""
        instance = cls.__new__(cls)
        instance.create_calls = 0
        instance._voices = list(_FAKE_VOICE_MANIFEST)
        type(instance).instances.append(instance)
        return instance

    def get_voices(self) -> list[str]:
        return list(self._voices)

    def create(self, text: str, voice: str, speed: float, lang: str):
        self.create_calls += 1
        if type(self).fail_create:
            raise RuntimeError("ConvTranspose not supported on DirectML")
        return np.zeros(24000, dtype=np.float32), 24000


@pytest.fixture
def dml_kokoro_module(monkeypatch):
    _DmlKokoro.instances = []
    _DmlKokoro.fail_create = False
    fake_mod = types.ModuleType("kokoro_onnx")
    fake_mod.Kokoro = _DmlKokoro  # type: ignore[attr-defined]
    monkeypatch.setitem(sys.modules, "kokoro_onnx", fake_mod)
    yield _DmlKokoro


def test_directml_selftest_passes_and_caches(dml_kokoro_module, fake_weight_files, monkeypatch) -> None:
    """DML in the providers → one self-test synth runs; on success a marker is
    written and _dml_status is 'directml'. A SECOND load skips the probe."""
    from unittest.mock import patch, MagicMock

    mock_session = MagicMock()
    mock_session._model_path = str(fake_weight_files["model"])

    monkeypatch.setenv("KOKORO_ORT_PROVIDERS", '["DmlExecutionProvider", "CPUExecutionProvider"]')

    with patch("onnxruntime.InferenceSession") as mock_ort_session:
        mock_ort_session.return_value = mock_session
        engine = main.KokoroEngine()
        engine._ensure_loaded("v1")
        assert engine._dml_status == "directml"
        assert dml_kokoro_module.instances[-1].create_calls == 1  # the self-test synth
        assert os.path.isfile(engine._dml_marker_path())

        # Second engine over the same weights dir: marker present → no probe.
        engine2 = main.KokoroEngine()
        engine2._ensure_loaded("v1")
        assert engine2._dml_status == "directml"
        assert dml_kokoro_module.instances[-1].create_calls == 0  # skipped


def test_directml_selftest_fails_falls_back_to_cpu(dml_kokoro_module, fake_weight_files, monkeypatch) -> None:
    """A failing DML synth rebuilds Kokoro on the CPU EP via from_session
    (honest cpu in /health) -- NOT via `Kokoro(..., providers=...)`, which
    kokoro_onnx==0.5.0's real constructor rejects with a TypeError (#2631
    review S2). Asserting on the InferenceSession call args -- rather than
    on a `.providers` attribute the stub's constructor no longer accepts --
    is what makes this test fail if the fallback regresses to that
    impossible call: `_DmlKokoro.__init__` takes no `providers` kwarg, so a
    stub asserting on it would mask the same bug the real class exposes."""
    from unittest.mock import patch, MagicMock

    mock_session = MagicMock()
    mock_session._model_path = str(fake_weight_files["model"])

    # monkeypatch.setattr (not a raw class-attribute assignment) so this is
    # restored at teardown regardless of test order/failure, rather than
    # relying on dml_kokoro_module's next setup to reset it back to False
    # (#2631 review M4/M5 pattern).
    monkeypatch.setattr(_DmlKokoro, "fail_create", True)
    monkeypatch.setenv("KOKORO_ORT_PROVIDERS", '["DmlExecutionProvider", "CPUExecutionProvider"]')

    with patch("onnxruntime.InferenceSession") as mock_ort_session:
        mock_ort_session.return_value = mock_session
        engine = main.KokoroEngine()
        engine._ensure_loaded("v1")
        assert engine._dml_status == "fallback-cpu"
        # The fallback session (the last InferenceSession build) was built
        # on the CPU EP alone; no marker (DML didn't pass).
        assert mock_ort_session.call_args_list[-1][1]["providers"] == ["CPUExecutionProvider"]
        assert not os.path.isfile(engine._dml_marker_path())


def test_no_directml_selftest_when_dml_absent(dml_kokoro_module, fake_weight_files, monkeypatch) -> None:
    """A CUDA/CPU profile (no DirectML EP) never runs the Kokoro DML self-test."""
    from unittest.mock import patch, MagicMock

    mock_session = MagicMock()
    mock_session._model_path = str(fake_weight_files["model"])

    monkeypatch.setenv("KOKORO_ORT_PROVIDERS", '["CUDAExecutionProvider", "CPUExecutionProvider"]')

    with patch("onnxruntime.InferenceSession") as mock_ort_session:
        mock_ort_session.return_value = mock_session
        engine = main.KokoroEngine()
        engine._ensure_loaded("v1")
        assert engine._dml_status is None
        assert dml_kokoro_module.instances[-1].create_calls == 0


@pytest.fixture
def fake_weight_files(monkeypatch, tmp_path):
    """Create empty weight + manifest files at the paths KokoroEngine
    expects so its `os.path.isfile` checks pass. Real kokoro-onnx would
    fail to load these — but the _FakeKokoro stub doesn't read them, so
    the test only needs the existence check to succeed."""
    model_path = tmp_path / "kokoro-v1.0.onnx"
    voices_path = tmp_path / "voices-v1.0.bin"
    model_path.write_bytes(b"")
    voices_path.write_bytes(b"")
    monkeypatch.setenv("KOKORO_MODEL_PATH", str(model_path))
    monkeypatch.setenv("KOKORO_VOICES_PATH", str(voices_path))
    yield {"model": str(model_path), "voices": str(voices_path)}


# ── KokoroEngine load wiring ─────────────────────────────────────────────

def test_kokoro_load_populates_english_voices_only(fake_kokoro_module, fake_weight_files) -> None:
    """The full Kokoro manifest spans ~8 languages; only af_/am_/bf_/bm_
    voices should reach _voices. Regression: if the prefix tuple drifts
    or the filter is removed, non-English voices would leak into the
    picker and the per-character override UI — that's exactly the
    "clutter" the user explicitly didn't want."""
    engine = main.KokoroEngine()
    engine._ensure_loaded("v1")

    # Every retained voice must match one of the four English prefixes.
    for v in engine._voices:
        assert v.startswith(("af_", "am_", "bf_", "bm_")), (
            f"non-English voice '{v}' leaked through the filter"
        )

    # Specific names from the fake manifest that should survive.
    assert "af_heart" in engine._voices
    assert "bm_george" in engine._voices

    # Names that must be filtered out.
    for foreign in ("ef_dora", "ff_siwis", "hf_alpha", "if_sara", "jf_alpha", "pf_dora", "zf_xiaobei"):
        assert foreign not in engine._voices, f"foreign voice '{foreign}' leaked through filter"


def test_kokoro_load_is_idempotent(fake_kokoro_module, fake_weight_files) -> None:
    """Calling _ensure_loaded a second time is a no-op — the model stays
    the same instance. This matches CoquiEngine's behaviour and is what
    the eager-preload-on-startup pattern relies on."""
    engine = main.KokoroEngine()
    engine._ensure_loaded("v1")
    first = engine._kokoro
    engine._ensure_loaded("v1")
    assert engine._kokoro is first


def test_kokoro_load_fails_loudly_when_kokoro_onnx_missing(fake_weight_files, monkeypatch) -> None:
    """If kokoro-onnx isn't installed, the import raises and we surface
    the install hint. Critical UX: a generic ImportError tells the user
    nothing; this wraps it with the pip command that fixes the problem.

    Simulates the missing module by installing an import hook that
    raises ImportError specifically for `kokoro_onnx`. Works whether or
    not the real package is installed in the test venv — needed because
    once Kokoro is installed in CI / dev venv, a simple sys.modules.pop
    just lets the next import succeed from the on-disk package."""
    sys.modules.pop("kokoro_onnx", None)

    class _BlockKokoroFinder:
        def find_spec(self, name, *_args, **_kwargs):
            if name == "kokoro_onnx":
                raise ImportError("simulated missing kokoro-onnx for test")
            return None

    finder = _BlockKokoroFinder()
    sys.meta_path.insert(0, finder)
    try:
        engine = main.KokoroEngine()
        with pytest.raises(RuntimeError) as excinfo:
            engine._ensure_loaded("v1")
        assert "kokoro-onnx" in str(excinfo.value)
        assert "pip install" in str(excinfo.value)
    finally:
        sys.meta_path.remove(finder)
        sys.modules.pop("kokoro_onnx", None)


def test_kokoro_load_fails_loudly_when_model_file_missing(fake_kokoro_module, monkeypatch, tmp_path) -> None:
    """install-kokoro.ps1 didn't run yet → model file doesn't exist →
    raise with the path + install hint, not a cryptic ONNX error."""
    monkeypatch.setenv("KOKORO_MODEL_PATH", str(tmp_path / "nope.onnx"))
    monkeypatch.setenv("KOKORO_VOICES_PATH", str(tmp_path / "nope.bin"))
    engine = main.KokoroEngine()
    with pytest.raises(RuntimeError) as excinfo:
        engine._ensure_loaded("v1")
    assert "install-kokoro" in str(excinfo.value).lower()


def test_kokoro_load_tolerates_voices_attr_dict_api(fake_weight_files, monkeypatch) -> None:
    """Older kokoro-onnx releases expose voices as a dict attribute instead
    of a get_voices() method. The fallback in _ensure_loaded should handle
    both shapes so a minor-version bump doesn't break the load path."""
    class _OldKokoro:
        def __init__(self, model_path: str, voices_path: str) -> None:
            self.voices = {v: object() for v in _FAKE_VOICE_MANIFEST}

    fake_mod = types.ModuleType("kokoro_onnx")
    fake_mod.Kokoro = _OldKokoro  # type: ignore[attr-defined]
    monkeypatch.setitem(sys.modules, "kokoro_onnx", fake_mod)

    engine = main.KokoroEngine()
    engine._ensure_loaded("v1")
    # English filter must still apply via the dict.keys() path.
    assert "af_heart" in engine._voices
    assert "ef_dora" not in engine._voices


def test_kokoro_load_tolerates_voice_enumeration_failure(fake_weight_files, monkeypatch) -> None:
    """If neither get_voices() nor a voices attribute exists, _voices stays
    empty rather than crashing the load. /speakers will report an empty
    list (signal that the manifest API drifted), but synthesis still works
    because the substitution gate only fires when _voices is non-empty."""
    class _OpaqueKokoro:
        def __init__(self, model_path: str, voices_path: str) -> None:
            pass

    fake_mod = types.ModuleType("kokoro_onnx")
    fake_mod.Kokoro = _OpaqueKokoro  # type: ignore[attr-defined]
    monkeypatch.setitem(sys.modules, "kokoro_onnx", fake_mod)

    engine = main.KokoroEngine()
    engine._ensure_loaded("v1")  # should not raise
    assert engine._voices == []
    assert engine._kokoro is not None


# ── KokoroEngine synthesize ──────────────────────────────────────────────

def test_kokoro_synthesize_returns_pcm_at_native_sample_rate(fake_kokoro_module, fake_weight_files) -> None:
    """Happy path: a known voice produces a SynthResult with int16 LE PCM
    at the model's native rate (24 kHz). The Node side reads the rate
    from the X-Sample-Rate header at the HTTP layer; we test the engine
    output here directly."""
    engine = main.KokoroEngine()
    result = engine.synthesize("v1", "af_heart", "Hello, world.")
    assert result.sample_rate == 24000
    # 1 s of zero-valued audio = 24000 int16 samples = 48000 bytes.
    assert len(result.pcm) == 48000
    assert result.substituted_from is None


def test_kokoro_synthesize_substitutes_unknown_voice(fake_kokoro_module, fake_weight_files) -> None:
    """A voice ID not in the English manifest (here: a non-English ID like
    ef_dora) falls back to af_heart and sets substituted_from. The Node
    side surfaces this as a warning so the upstream catalog can be
    fixed — synthesis still completes for the chapter rather than
    failing the whole render."""
    engine = main.KokoroEngine()
    result = engine.synthesize("v1", "ef_dora", "Bonjour.")
    assert result.substituted_from == "ef_dora"
    # The fake records the actual voice handed to create() — must be
    # af_heart, not the requested ef_dora.
    assert engine._kokoro.calls[-1][1] == "af_heart"


def test_kokoro_synthesize_passes_speed_one_and_language(fake_kokoro_module, fake_weight_files, monkeypatch) -> None:
    """Quality config invariants: speed must always be 1.0 (no speed-up
    that degrades prosody) and the language code reaches the phonemiser.
    KOKORO_LANGUAGE defaults to en-us; an override should flow through."""
    monkeypatch.setenv("KOKORO_LANGUAGE", "en-gb")
    engine = main.KokoroEngine()
    engine.synthesize("v1", "bf_emma", "Hello there.")
    text, voice, speed, lang = engine._kokoro.calls[-1]
    assert speed == 1.0
    assert lang == "en-gb"
    assert voice == "bf_emma"
    assert text == "Hello there."


def test_kokoro_synthesize_handles_create_returning_array_only(fake_weight_files, monkeypatch) -> None:
    """Defensive: a future kokoro-onnx release might drop the (samples,
    sr) tuple form and return just the array. Engine should fall back
    to NATIVE_SAMPLE_RATE rather than crashing on the unpack."""
    class _ArrayOnlyKokoro(_FakeKokoro):
        def create(self, text: str, voice: str, speed: float, lang: str):
            super().create(text, voice, speed, lang)
            return np.zeros(24000, dtype=np.float32)

    fake_mod = types.ModuleType("kokoro_onnx")
    fake_mod.Kokoro = _ArrayOnlyKokoro  # type: ignore[attr-defined]
    monkeypatch.setitem(sys.modules, "kokoro_onnx", fake_mod)
    # See fake_kokoro_module's docstring: _ArrayOnlyKokoro inherits
    # from_session from _FakeKokoro, so _ensure_loaded builds a real ORT
    # session first -- stub it since fake_weight_files isn't a real model.
    from unittest.mock import MagicMock
    monkeypatch.setattr(
        "onnxruntime.InferenceSession",
        MagicMock(return_value=MagicMock(_model_path="")),
    )

    engine = main.KokoroEngine()
    result = engine.synthesize("v1", "af_heart", "Hi.")
    assert result.sample_rate == 24000
    assert len(result.pcm) == 48000


def test_kokoro_unload_drops_state(fake_kokoro_module, fake_weight_files) -> None:
    """unload() drops the kokoro instance + voice list. Subsequent
    _ensure_loaded reinitialises. Matches CoquiEngine's semantics."""
    engine = main.KokoroEngine()
    engine._ensure_loaded("v1")
    assert engine._kokoro is not None
    engine.unload()
    assert engine._kokoro is None
    assert engine._voices == []
    # Re-load works.
    engine._ensure_loaded("v1")
    assert engine._kokoro is not None
    assert "af_heart" in engine._voices


# ── HTTP integration ─────────────────────────────────────────────────────

@pytest.fixture
def kokoro_client(monkeypatch, fake_kokoro_module, fake_weight_files):
    """TestClient with a preloaded KokoroEngine registered. The Coqui
    engine is left untouched — both should coexist in ENGINES."""
    engine = main.KokoroEngine()
    engine._ensure_loaded("v1")
    monkeypatch.setitem(main.ENGINES, "kokoro", engine)
    with TestClient(main.app) as c:
        c.app_state_kokoro = engine  # type: ignore[attr-defined]
        yield c


def test_speakers_includes_kokoro_english_subset(kokoro_client: TestClient) -> None:
    """/speakers must surface Kokoro voices keyed under 'kokoro' AND those
    voices must all be in the English subset. This is the contract the
    Node-side base-voices aggregator depends on — if non-English voices
    leak here, they show up in the picker."""
    r = kokoro_client.get("/speakers")
    assert r.status_code == 200
    body = r.json()
    assert "kokoro" in body
    voices = body["kokoro"]
    assert len(voices) > 0
    for v in voices:
        assert v.startswith(("af_", "am_", "bf_", "bm_")), (
            f"non-English voice '{v}' surfaced via /speakers"
        )
    # The count from the fake manifest matches the curated English subset.
    # If the manifest grows or shrinks, update _FAKE_VOICE_MANIFEST.
    assert len(voices) == 18  # 9 af + 5 am + 2 bf + 2 bm


def test_synthesize_routes_kokoro_engine(kokoro_client: TestClient) -> None:
    """POST /synthesize with engine=kokoro must route to KokoroEngine and
    return clean PCM with the right sample-rate header. The Coqui-specific
    poison fence must NOT fire for Kokoro requests (kokoro is ONNX, not
    PyTorch — different failure mode)."""
    r = kokoro_client.post(
        "/synthesize",
        json={"engine": "kokoro", "model": "v1", "voice": "af_heart", "text": "Hello."},
    )
    assert r.status_code == 200
    assert r.headers["X-Sample-Rate"] == "24000"
    assert r.headers["content-type"].startswith("audio/L16")
    assert len(r.content) == 48000


def test_synthesize_kokoro_substitutes_foreign_voice(kokoro_client: TestClient) -> None:
    """A request for a non-English voice (ef_dora) must complete with
    fallback to af_heart and an X-Voice-Substituted-From header. This
    is the user-visible signal that the upstream catalog has an issue."""
    r = kokoro_client.post(
        "/synthesize",
        json={"engine": "kokoro", "model": "v1", "voice": "ef_dora", "text": "Hola."},
    )
    assert r.status_code == 200
    assert r.headers.get("X-Voice-Substituted-From") == "ef_dora"


# ── Per-engine /load + /unload + /health (Kokoro pill backing) ───────────
#
# These pin the contract behind the new top-bar Kokoro Stop pill: the
# sidecar must accept `engine: 'kokoro'` on /load and /unload, must report
# Kokoro's load state in /health under `kokoro_loaded` / `kokoro_loading`,
# and must keep these orthogonal from Coqui's identically-named pair so
# the consolidated useTtsLifecycle hook can fan out per-engine state from
# a single poll without aliasing.

@pytest.fixture
def kokoro_unloaded_client(monkeypatch, fake_kokoro_module, fake_weight_files):
    """TestClient with a Kokoro engine that's been reset to unloaded AFTER
    the lifespan starts. The startup hook (_preload_default_engines) fires
    when TestClient enters its context manager and would otherwise warm
    Kokoro out from under these tests — we explicitly unload it again so
    each test starts from a clean cold-cache state."""
    engine = main.KokoroEngine()
    monkeypatch.setitem(main.ENGINES, "kokoro", engine)
    with TestClient(main.app) as c:
        engine.unload()
        engine._loading = False
        yield c, engine


def test_health_reports_kokoro_load_state(kokoro_unloaded_client) -> None:
    """/health must expose `kokoro_loaded` and `kokoro_loading` as their own
    fields, distinct from Coqui's `model_loaded` / `loading`. Without this
    separation the frontend pill would alias Coqui state onto Kokoro and
    flip the wrong dot when the user clicks Stop on either engine."""
    client, _engine = kokoro_unloaded_client
    r = client.get("/health")
    assert r.status_code == 200
    body = r.json()
    assert body["kokoro_loaded"] is False
    assert body["kokoro_loading"] is False
    # Coqui fields stay present and distinct.
    assert "model_loaded" in body
    assert "loading" in body


def test_health_reports_protocol_version(kokoro_unloaded_client) -> None:
    """/health must carry `protocol_version` (side-8): the Node server reads it
    at startup to tell a CURRENT sidecar from a STALE one before reusing it. A
    pre-side-8 build omits the field, which the server treats as stale and
    replaces — so a regression that drops this field would silently re-enable
    the stale-sidecar incident (a whole Qwen book falling back to Kokoro)."""
    client, _engine = kokoro_unloaded_client
    body = client.get("/health").json()
    assert body["protocol_version"] == main.SIDECAR_PROTOCOL_VERSION
    assert isinstance(body["protocol_version"], int)


def test_health_reports_version(kokoro_unloaded_client) -> None:
    """/health carries __version__ (fs-1): the sidecar app version (from
    version.py, rewritten in lockstep by bump-version.mjs) that the Node
    server's GET /api/info surfaces next to the server appVersion. Distinct
    from protocol_version, which gates stale-sidecar replacement."""
    client, _engine = kokoro_unloaded_client
    body = client.get("/health").json()
    assert "__version__" in body
    assert isinstance(body["__version__"], str)
    assert body["__version__"] == main.__sidecar_version__


def test_load_kokoro_engine_warms_kokoro(kokoro_unloaded_client) -> None:
    """POST /load with `engine: 'kokoro'` warms the Kokoro engine specifically
    and leaves Coqui alone. The response is the same `{ status: 'ready' }`
    shape as the existing Coqui path so the frontend treats the two
    endpoints identically."""
    client, engine = kokoro_unloaded_client
    assert engine._kokoro is None
    r = client.post("/load", json={"engine": "kokoro"})
    assert r.status_code == 200
    assert r.json() == {"status": "ready"}
    assert engine._kokoro is not None
    # Coqui must NOT have been touched.
    coqui = main.ENGINES.get("coqui")
    assert isinstance(coqui, main.CoquiEngine)
    assert coqui._tts is None


def test_load_kokoro_is_idempotent(kokoro_unloaded_client) -> None:
    """Calling /load twice with engine=kokoro returns ready both times and
    doesn't recreate the underlying Kokoro instance. Matches Coqui's
    behaviour — the UI pill can re-fire Load on every screen entry."""
    client, engine = kokoro_unloaded_client
    client.post("/load", json={"engine": "kokoro"})
    first = engine._kokoro
    r = client.post("/load", json={"engine": "kokoro"})
    assert r.status_code == 200
    assert r.json() == {"status": "ready"}
    assert engine._kokoro is first


def test_unload_kokoro_drops_kokoro_and_leaves_coqui(kokoro_unloaded_client) -> None:
    """POST /unload with engine=kokoro frees Kokoro VRAM without touching
    Coqui. The reverse must also hold: a default /unload (no engine, or
    engine=coqui) does NOT unload Kokoro. That pair of asserts is the
    contract the Kokoro Stop pill ships against."""
    client, kokoro_engine = kokoro_unloaded_client
    # Warm Kokoro first.
    client.post("/load", json={"engine": "kokoro"})
    assert kokoro_engine._kokoro is not None

    # Targeted Kokoro unload drops it.
    r = client.post("/unload", json={"engine": "kokoro"})
    assert r.status_code == 200
    assert r.json() == {"status": "idle"}
    assert kokoro_engine._kokoro is None

    # Re-warm and confirm default /unload (Coqui-targeted) does NOT touch it.
    client.post("/load", json={"engine": "kokoro"})
    assert kokoro_engine._kokoro is not None
    r = client.post("/unload", json={})
    assert r.status_code == 200
    assert r.json() == {"status": "idle"}
    assert kokoro_engine._kokoro is not None, (
        "default /unload (Coqui) leaked into Kokoro — engines must stay isolated"
    )


def test_unload_kokoro_is_idempotent(kokoro_unloaded_client) -> None:
    """Calling /unload with engine=kokoro when Kokoro is already unloaded
    is a clean no-op returning `idle`. The pill's optimistic flip relies on
    this — clicking Stop a second time mustn't 4xx."""
    client, _engine = kokoro_unloaded_client
    r = client.post("/unload", json={"engine": "kokoro"})
    assert r.status_code == 200
    assert r.json() == {"status": "idle"}
    r = client.post("/unload", json={"engine": "kokoro"})
    assert r.status_code == 200
    assert r.json() == {"status": "idle"}


def test_health_after_kokoro_load_unload_cycle(kokoro_unloaded_client) -> None:
    """End-to-end: cold → load → /health shows kokoro_loaded=true →
    unload → /health flips back to false. This is what the in-app pill
    polls every 30 s to render its dot."""
    client, _engine = kokoro_unloaded_client
    assert client.get("/health").json()["kokoro_loaded"] is False
    client.post("/load", json={"engine": "kokoro"})
    assert client.get("/health").json()["kokoro_loaded"] is True
    client.post("/unload", json={"engine": "kokoro"})
    assert client.get("/health").json()["kokoro_loaded"] is False


# ── Eager-preload opt-out (PRELOAD_KOKORO) ───────────────────────────────
#
# The sidecar does NOT eager-load Kokoro at startup by default (fs-60:
# PRELOAD_KOKORO unset → lazy) — this matches the registry default
# tts.preload.kokoro=false, which buildSidecarEnv omits from the child env
# precisely because it's the default, leaving the sidecar to apply its own
# Python default. Those two defaults must agree, so the Python fallback is
# also False. A user who wants the ~1 GB / ~1 s always-hot English engine
# opts in via PRELOAD_KOKORO=1 (Advanced Settings' "Preload Kokoro at
# startup" knob, propagated by the Node server). These tests pin the gate by
# calling the startup hook directly with a spy engine and asserting whether
# _ensure_loaded ran.


def _run_preload_capturing_kokoro(monkeypatch) -> list[str]:
    """Swap in a real KokoroEngine with a stubbed _ensure_loaded (so no real
    weights load) and run the FastAPI startup hook once. Returns the list of
    model args _ensure_loaded was called with — empty when the eager load was
    skipped, ['v1'] when it fired. Coqui stays gated off by conftest's
    PRELOAD_COQUI=0 and Qwen by its own false default, so only the Kokoro
    block under test does any work."""
    engine = main.KokoroEngine()
    calls: list[str] = []
    monkeypatch.setattr(engine, "_ensure_loaded", lambda model: calls.append(model))
    monkeypatch.setitem(main.ENGINES, "kokoro", engine)
    asyncio.run(main._preload_default_engines())
    return calls


def test_preload_skips_kokoro_when_disabled(monkeypatch) -> None:
    """PRELOAD_KOKORO=0 → the startup hook must NOT eager-load Kokoro.
    Kokoro then warms on demand on the first synth (KokoroEngine.synthesize
    calls _ensure_loaded), freeing the ~1 GB VRAM for a Qwen-primary user."""
    monkeypatch.setenv("PRELOAD_KOKORO", "0")
    assert _run_preload_capturing_kokoro(monkeypatch) == [], (
        "Kokoro eager-loaded despite PRELOAD_KOKORO=0"
    )


def test_preload_skips_kokoro_when_unset(monkeypatch) -> None:
    """Default (PRELOAD_KOKORO unset) → the startup hook must NOT eager-load
    Kokoro (fs-60). The sidecar's Python fallback is False so it agrees with
    the registry default tts.preload.kokoro=false, which the Node server omits
    from the child env when at its default. Kokoro warms on demand on first
    synth instead."""
    monkeypatch.delenv("PRELOAD_KOKORO", raising=False)
    assert _run_preload_capturing_kokoro(monkeypatch) == [], (
        "Kokoro eager-loaded with PRELOAD_KOKORO unset — Python default drifted "
        "from the registry's tts.preload.kokoro=false"
    )


def test_preload_loads_kokoro_when_enabled(monkeypatch) -> None:
    """PRELOAD_KOKORO=1 explicitly opts in to the eager load (same as the
    unset default)."""
    monkeypatch.setenv("PRELOAD_KOKORO", "1")
    assert _run_preload_capturing_kokoro(monkeypatch) == ["v1"]


def test_load_unknown_engine_defaults_to_coqui(kokoro_unloaded_client) -> None:
    """An unrecognised engine value (typo, future engine name) falls back
    to Coqui rather than 4xx-ing. Matches the back-compat contract on
    `/load` — existing callers that don't send `engine` at all hit the
    Coqui path, and a malformed value behaves the same way.

    We pretend Coqui is already loaded so the /load route short-circuits
    before triggering a real XTTS load (which would hang the test on a
    multi-GB weight pull). The assertion that matters is Kokoro stays
    untouched."""
    client, kokoro_engine = kokoro_unloaded_client
    coqui = main.ENGINES.get("coqui")
    assert isinstance(coqui, main.CoquiEngine)
    sentinel = object()
    saved_tts = coqui._tts
    coqui._tts = sentinel
    try:
        r = client.post("/load", json={"engine": "nonsense"})
        assert r.status_code == 200
        assert r.json() == {"status": "ready"}
        # Coqui's sentinel is still there — proves we hit the Coqui short
        # circuit, not the Kokoro path or a 4xx.
        assert coqui._tts is sentinel
        # Kokoro must be untouched.
        assert kokoro_engine._kokoro is None
    finally:
        coqui._tts = saved_tts


# ── _kokoro_provider_options pure-helper tests ───────────────────────────
#
# These are PURE unit tests on the module-level helper — no model weights,
# no kokoro-onnx package needed.  They pin the three branches:
#   1. indexed cuda + explicit providers → list[dict] aligned to providers
#   2. indexed cuda + empty providers   → (synthesized_providers, options) tuple
#   3. no index (cpu / cuda / auto)     → None

def test_kokoro_provider_options_indexed_cuda() -> None:
    """An indexed CUDA pin with an explicit providers list returns a parallel
    list[dict] with device_id on the CUDA entry and {} on the CPU entry."""
    providers = ["CUDAExecutionProvider", "CPUExecutionProvider"]
    assert main._kokoro_provider_options("cuda:1", providers) == [{"device_id": 1}, {}]


def test_kokoro_provider_options_synthesizes_when_providers_empty() -> None:
    """Unit-level coverage of `_kokoro_provider_options` itself, called
    directly with an empty providers list -- the server always injects
    KOKORO_ORT_PROVIDERS, so in the running engine `providers` reaching this
    helper is never actually empty (`_default_ort_providers` always returns
    a non-empty list too); this defensive branch would only fire if both of
    those resolved to nothing. The pin must still SYNTHESIZE a CUDA+CPU list
    and return (providers, options) so device_id has a home (#2631 review
    M6 -- corrects the prior docstring's false "NVIDIA default" premise)."""
    assert main._kokoro_provider_options("cuda:1", []) == (
        ["CUDAExecutionProvider", "CPUExecutionProvider"], [{"device_id": 1}, {}]
    )


def test_kokoro_provider_options_none_when_not_indexed() -> None:
    """cpu / plain-cuda / auto — no index, no pin needed: return None so the
    existing ORT session is left completely untouched."""
    assert main._kokoro_provider_options("cpu", ["CPUExecutionProvider"]) is None
    assert main._kokoro_provider_options("cuda", []) is None
    assert main._kokoro_provider_options("auto", []) is None


# ── real-package contract (side-26) ──────────────────────────────────────
#
# Everything above stubs `kokoro_onnx` via sys.modules, so nothing in this
# file would notice upstream renaming the two things the device-pin path
# actually reaches into.  These tests run against the REAL installed package
# and skip when it's absent (CI / a fresh clone before install-kokoro).
#
# Why they matter: the indexed-device pin rebuilds `self._kokoro.sess` inside
# a try/except that only WARNS on failure — so an upstream rename would not
# raise, it would silently drop Kokoro back to an unpinned device.  A pin
# bump must fail here instead.

# NOTE: importorskip lives INSIDE each test, never at module scope — at module
# scope it would skip this entire file on the CI boxes that never install
# kokoro-onnx, silently taking the ~40 stubbed tests above with it.


def _real_kokoro():
    """The real installed kokoro_onnx, or skip. Re-imported per test so a
    leftover sys.modules stub from a fixture can never be mistaken for it."""
    import importlib

    mod = pytest.importorskip("kokoro_onnx", reason="kokoro-onnx not installed")
    try:
        mod = importlib.reload(mod)
    except ModuleNotFoundError:
        # A bare stub module (no __spec__/__file__) left in sys.modules makes
        # reload() fall back to module.__name__ for the spec lookup; if the
        # real package isn't installed, that lookup fails and reload() raises
        # instead of returning the stub. Treat that the same as "stub, not
        # real" — skip cleanly rather than ERROR-ing.
        pytest.skip("kokoro_onnx present only as a test stub (reload found no real package)")
    if not getattr(mod, "__file__", None):
        pytest.skip("kokoro_onnx present only as a test stub")
    return mod


def test_real_kokoro_still_exposes_the_sess_attribute() -> None:
    """The indexed-device pin assigns `self._kokoro.sess = rt.InferenceSession(...)`.
    `sess` is private API, so every kokoro-onnx bump must re-confirm it."""
    import inspect
    import re

    src = inspect.getsource(_real_kokoro().Kokoro.__init__)
    assert re.search(r"self\.sess\s*=", src), (
        "kokoro_onnx.Kokoro no longer assigns `self.sess` — the indexed-device "
        "pin in main.py rebuilds that attribute and fails SILENTLY (warn-only) "
        "if it moves. Update the pin before lifting the kokoro-onnx floor."
    )


def test_real_kokoro_create_keeps_the_positional_signature_we_call() -> None:
    """main.py has two call sites for `create()`, and they are not equivalent.
    `KokoroEngine.synthesize` (the real synthesis hot path, runs on every synth)
    calls `create(text, voice=..., speed=..., lang=...)` by keyword.
    `KokoroEngine._directml_selftest_or_fallback` (the DirectML proof-of-life
    probe — disabled today, see the `amd-rocm.txt` overlay comment and
    `installRecipe` in `scripts/accelerator-profile.mjs`) calls
    `create(text, voice, speed, lang)` fully positionally."""
    import inspect

    sig = inspect.signature(_real_kokoro().Kokoro.create)
    params = list(sig.parameters)
    assert params[:5] == ["self", "text", "voice", "speed", "lang"], (
        f"kokoro_onnx.Kokoro.create signature drifted: {params}"
    )
    # Names/order alone guard the keyword call in `KokoroEngine.synthesize`: a
    # rename of `voice`/`speed`/`lang` breaks that call site even though it's
    # keyword-based. They do NOT prove the positional probe still works: if
    # upstream kept these names/order but made voice/speed/lang keyword-only
    # (`def create(self, text, *, voice, speed, lang, ...)`), the assertion
    # above would still pass while `_directml_selftest_or_fallback`'s positional
    # call would raise TypeError at runtime. Pin the parameter *kind* too — this
    # only guards the (currently disabled) DirectML path, not the live hot path.
    positional_kinds = (
        inspect.Parameter.POSITIONAL_ONLY,
        inspect.Parameter.POSITIONAL_OR_KEYWORD,
    )
    for name in ("voice", "speed", "lang"):
        assert sig.parameters[name].kind in positional_kinds, (
            f"kokoro_onnx.Kokoro.create's '{name}' parameter became keyword-only — "
            "KokoroEngine._directml_selftest_or_fallback calls create() "
            "positionally and would raise TypeError (latent on the disabled "
            "DirectML path, but still shipped code)"
        )


def test_cuda_fallback_recorded_when_api_drift_forces_cpu(
    fake_weight_files, monkeypatch, caplog
) -> None:
    """#2582 regression: when kokoro-onnx lacks Kokoro.from_session (API drift),
    the `else` branch falls back to Kokoro(...), which ALWAYS forces CPU
    regardless of the resolved providers. When CUDA was requested
    (build_providers contains CUDAExecutionProvider), this is a confirmed
    fallback that must be recorded in _cuda_verification_state, not left
    silent. The detail message must distinguish this cause (API drift) from
    the self-test's own "session inspection revealed CPU" cause."""
    import logging
    from unittest.mock import MagicMock, patch

    monkeypatch.delenv("KOKORO_DEVICE", raising=False)

    # Kokoro stub WITHOUT from_session classmethod -- simulates API drift
    class _ApiDriftKokoro:
        """kokoro-onnx without from_session: the else branch path."""
        def __init__(self, model_path: str, voices_path: str) -> None:
            self._voices = list(_FAKE_VOICE_MANIFEST)

        def get_voices(self):
            return list(self._voices)

        def create(self, text: str, voice: str, speed: float, lang: str):
            return np.zeros(24000, dtype=np.float32), 24000

    fake_mod = types.ModuleType("kokoro_onnx")
    fake_mod.Kokoro = _ApiDriftKokoro
    monkeypatch.setitem(sys.modules, "kokoro_onnx", fake_mod)

    mock_session = MagicMock()
    mock_session._model_path = str(fake_weight_files["model"])

    with patch(
        "onnxruntime.get_available_providers",
        return_value=["CUDAExecutionProvider", "CPUExecutionProvider"],
    ), patch("onnxruntime.cuda_version", "12.4", create=True), \
         patch("onnxruntime.InferenceSession") as mock_ort_session_class:
        mock_ort_session_class.return_value = mock_session
        engine = main.KokoroEngine()
        with caplog.at_level(logging.WARNING, logger="sidecar"):
            engine._ensure_loaded("v1", device="cuda:0")

        # The load succeeded (Kokoro is resident) despite the API drift
        assert engine._kokoro is not None

        # _cuda_verification_state must record the confirmed fallback
        assert main._cuda_verification_state["checked"] is True
        assert main._cuda_verification_state["verified"] is False
        detail = main._cuda_verification_state["detail"]
        assert detail is not None

        # Detail must mention API drift as the reason for the fallback
        assert "API drift" in detail, \
            f"Detail must mention API drift, got: {detail}"
        assert "from_session" in detail, \
            f"Detail must mention from_session, got: {detail}"
        assert "always forces CPU" in detail, \
            f"Detail must explain why it forces CPU, got: {detail}"

        # A warning about the API drift must be logged
        assert any(
            "kokoro-onnx has no Kokoro.from_session" in rec.message
            for rec in caplog.records
        ), f"Expected API drift warning, got: {[r.message for r in caplog.records]}"
