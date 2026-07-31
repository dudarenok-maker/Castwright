"""#1965 — sticky, real-import-attempt `*_import_ok` flags for kokoro, qwen
and whisper (Coqui already had one from #1944).

The defect these close: `_kokoro_package_installed()` and friends are
`find_spec`-only probes. `find_spec` never executes the module, so it reports
"installed" for a package that is present on disk and genuinely cannot import
— the #1944 speechbrain lazy-proxy shape. /health then advertises an engine
the next render cannot start.

Two properties of the #1944/#1962 template are load-bearing and are what these
tests exist to pin:

  1. **The catch is `BaseException`, not `ImportError`.** The second documented
     shape of the #1944 collision is a duplicate kernel-registration
     `RuntimeError`, which is NOT an `ImportError`. An `ImportError`-only
     `except` leaves the flag at `None` (or at a stale `True`) while the engine
     is unstartable — i.e. it re-creates the exact defect. That is #1962 review
     finding 3, fixed once for Coqui and now for the other three. Every
     `*_non_importerror_*` test below FAILS (real assertion, not a collection
     error) if the catch is narrowed back to `ImportError`.
  2. **Failures re-raise.** Recording must never swallow the diagnostic. The
     pre-existing ImportError→RuntimeError remediation wrapping is preserved
     (and chained via `__cause__`); a non-ImportError propagates UNCHANGED.

The flags are opportunistic — recorded at the import chokepoint each engine
already runs on its own cold-load path. There is no eager probe (Coqui's
startup pin costs a measured +11.7 s of unreachable boot; per-engine that is
not worth paying), so `None` remains the common value and means "nothing has
tried yet", never "broken".
"""
from __future__ import annotations

import sys
import types
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient

SIDECAR_ROOT = Path(__file__).resolve().parent.parent
if str(SIDECAR_ROOT) not in sys.path:
    sys.path.insert(0, str(SIDECAR_ROOT))

import main  # noqa: E402


# ── helpers ────────────────────────────────────────────────────────────────


class _StopHere(Exception):
    """Sentinel raised from the first statement AFTER the import chokepoint so
    a success-path test stops there instead of running a real model load."""


def _module_with(name: str, **attrs: Any) -> types.ModuleType:
    mod = types.ModuleType(name)
    for k, v in attrs.items():
        setattr(mod, k, v)
    return mod


class _RaisingModule(types.ModuleType):
    """A module whose attribute access raises a NON-ImportError.

    This is the #1944 collision's second shape reduced to its essentials: the
    package imports fine, then something in the chain blows up with a plain
    `RuntimeError`. Dunder lookups still raise `AttributeError` so the import
    machinery behaves normally right up to the `from X import Y` binding —
    which is the frame under test.
    """

    def __init__(self, name: str, exc: BaseException) -> None:
        super().__init__(name)
        self.__dict__["_exc"] = exc

    def __getattr__(self, item: str) -> Any:
        if item.startswith("__") and item.endswith("__"):
            raise AttributeError(item)
        raise self.__dict__["_exc"]


@pytest.fixture(autouse=True)
def _reset_flags(monkeypatch):
    """All four flags are sticky module-level globals that persist across
    tests in-process. Reset every one before each test, or a test could pass
    off a previous test's leftover value (and the `is None` assertions in
    particular would be worthless)."""
    monkeypatch.setattr(main, "_COQUI_IMPORT_OK", None)
    monkeypatch.setattr(main, "_KOKORO_IMPORT_OK", None)
    monkeypatch.setattr(main, "_QWEN_IMPORT_OK", None)
    monkeypatch.setattr(main, "_WHISPER_IMPORT_OK", None)


# ── kokoro ─────────────────────────────────────────────────────────────────


def _kokoro_engine() -> Any:
    """A KokoroEngine pinned at a weights path that cannot exist, so
    `_ensure_loaded` stops at the weights check immediately after the import
    chokepoint — no ONNX session, no 330 MB of weights, and deterministic on a
    box that DOES have Kokoro installed."""
    engine = main.KokoroEngine()
    engine._model_path = str(SIDECAR_ROOT / "does-not-exist" / "kokoro.onnx")
    return engine


def test_kokoro_successful_import_records_true(monkeypatch) -> None:
    monkeypatch.setitem(
        sys.modules, "kokoro_onnx", _module_with("kokoro_onnx", Kokoro=object)
    )

    with pytest.raises(RuntimeError, match="Kokoro model not found"):
        _kokoro_engine()._ensure_loaded("v1")

    assert main._KOKORO_IMPORT_OK is True


def test_kokoro_importerror_records_false_and_reraises(monkeypatch) -> None:
    """A `kokoro_onnx` without `Kokoro` makes `from kokoro_onnx import Kokoro`
    raise ImportError without needing the real package absent."""
    monkeypatch.setitem(sys.modules, "kokoro_onnx", _module_with("kokoro_onnx"))

    with pytest.raises(RuntimeError, match="Failed to import kokoro-onnx") as exc:
        _kokoro_engine()._ensure_loaded("v1")

    assert main._KOKORO_IMPORT_OK is False
    assert isinstance(exc.value.__cause__, ImportError), (
        "the remediation RuntimeError must still chain the real ImportError"
    )


def test_kokoro_non_importerror_records_false_and_propagates_unchanged(
    monkeypatch,
) -> None:
    """#1962 review finding 3, for Kokoro. A duplicate kernel-registration
    RuntimeError out of the import chain is NOT an ImportError. With an
    `except ImportError`, it escapes before anything is recorded and
    `kokoro_import_ok` stays None while the engine is unstartable."""
    boom = RuntimeError("duplicate kernel registration for wait_tensor")
    monkeypatch.setitem(sys.modules, "kokoro_onnx", _RaisingModule("kokoro_onnx", boom))

    with pytest.raises(RuntimeError) as exc:
        _kokoro_engine()._ensure_loaded("v1")

    assert main._KOKORO_IMPORT_OK is False, (
        "a non-ImportError import failure must still be recorded -- an "
        "`except ImportError` here leaves the flag at None while /health "
        "keeps advertising an engine that cannot start (#1962 finding 3)"
    )
    assert exc.value is boom, (
        "a non-ImportError must propagate UNCHANGED, not be re-wrapped in the "
        "kokoro-onnx install-hint RuntimeError, or its own diagnostic is lost"
    )


# ── qwen ───────────────────────────────────────────────────────────────────


@pytest.fixture
def qwen_torch(monkeypatch):
    """A fake `torch` for the qwen chokepoint plus a hard stop on the first
    statement after it. `_load_qwen_model` only needs `import torch` to return
    before it reaches the qwen_tts import; everything past that is real model
    loading we deliberately never enter."""
    monkeypatch.setitem(sys.modules, "torch", _module_with("torch"))

    def _stop(_torch: Any) -> None:
        raise _StopHere()

    monkeypatch.setattr(main, "_apply_torch_perf_flags", _stop)


def test_qwen_successful_import_records_true(qwen_torch, monkeypatch) -> None:
    monkeypatch.setitem(
        sys.modules, "qwen_tts", _module_with("qwen_tts", Qwen3TTSModel=object)
    )

    with pytest.raises(_StopHere):
        main.QwenEngine()._load_qwen_model("Qwen/Qwen3-TTS-0.6B")

    assert main._QWEN_IMPORT_OK is True


def test_qwen_importerror_records_false_and_reraises(qwen_torch, monkeypatch) -> None:
    monkeypatch.setitem(sys.modules, "qwen_tts", _module_with("qwen_tts"))

    with pytest.raises(RuntimeError, match="Failed to import qwen_tts") as exc:
        main.QwenEngine()._load_qwen_model("Qwen/Qwen3-TTS-0.6B")

    assert main._QWEN_IMPORT_OK is False
    assert isinstance(exc.value.__cause__, ImportError)


def test_qwen_non_importerror_records_false_and_propagates_unchanged(
    qwen_torch, monkeypatch
) -> None:
    """#1962 review finding 3, for Qwen."""
    boom = RuntimeError("duplicate kernel registration for wait_tensor")
    monkeypatch.setitem(sys.modules, "qwen_tts", _RaisingModule("qwen_tts", boom))

    with pytest.raises(RuntimeError) as exc:
        main.QwenEngine()._load_qwen_model("Qwen/Qwen3-TTS-0.6B")

    assert main._QWEN_IMPORT_OK is False, (
        "a non-ImportError import failure must still be recorded (#1962 "
        "finding 3)"
    )
    assert exc.value is boom, "a non-ImportError must propagate unchanged"


def test_qwen_flag_is_not_set_by_a_torch_failure(monkeypatch) -> None:
    """torch and qwen_tts used to share one `try`, so a missing PyTorch would
    have recorded `qwen_import_ok=False` and sent the operator off to reinstall
    qwen-tts. The imports are separate now: a torch failure must leave the qwen
    flag untouched (None -- nothing has told us anything about qwen_tts)."""
    monkeypatch.setitem(sys.modules, "torch", None)  # halt-on-reimport

    with pytest.raises(RuntimeError, match="Failed to import torch"):
        main.QwenEngine()._load_qwen_model("Qwen/Qwen3-TTS-0.6B")

    assert main._QWEN_IMPORT_OK is None, (
        "a broken PyTorch says nothing about the qwen-tts package -- recording "
        "False here would mis-attribute the fault"
    )


# ── whisper ────────────────────────────────────────────────────────────────


def test_whisper_successful_import_records_true(monkeypatch) -> None:
    class _FakeWhisperModel:
        def __init__(self, name: str, **kw: Any) -> None:
            self.name = name

    monkeypatch.setitem(
        sys.modules,
        "faster_whisper",
        _module_with("faster_whisper", WhisperModel=_FakeWhisperModel),
    )

    main.WhisperEngine()._ensure_loaded()  # must not raise

    assert main._WHISPER_IMPORT_OK is True


def test_whisper_importerror_records_false_and_reraises(monkeypatch) -> None:
    monkeypatch.setitem(
        sys.modules, "faster_whisper", _module_with("faster_whisper")
    )

    with pytest.raises(RuntimeError, match="Failed to import faster-whisper") as exc:
        main.WhisperEngine()._ensure_loaded()

    assert main._WHISPER_IMPORT_OK is False
    assert isinstance(exc.value.__cause__, ImportError)


def test_whisper_non_importerror_records_false_and_propagates_unchanged(
    monkeypatch,
) -> None:
    """#1962 review finding 3, for Whisper. faster-whisper pulls in
    ctranslate2, whose CUDA/cuDNN loader raises plain RuntimeErrors on a
    mismatched runtime -- not ImportError."""
    boom = RuntimeError("Library cudnn_ops64_9.dll is not found")
    monkeypatch.setitem(
        sys.modules, "faster_whisper", _RaisingModule("faster_whisper", boom)
    )

    with pytest.raises(RuntimeError) as exc:
        main.WhisperEngine()._ensure_loaded()

    assert main._WHISPER_IMPORT_OK is False, (
        "a non-ImportError import failure must still be recorded (#1962 "
        "finding 3)"
    )
    assert exc.value is boom, "a non-ImportError must propagate unchanged"


# ── coqui: the clone_voice path that never recorded ───────────────────────


class _ExplodingFinder:
    """A `sys.meta_path` finder that blows up on one module name with an
    arbitrary exception. Needed where `_RaisingModule` can't help: a PLAIN
    `import X` binds the module object without touching any attribute, so the
    failure has to come from the import machinery itself."""

    def __init__(self, name: str, exc: BaseException) -> None:
        self._name = name
        self._exc = exc

    def find_spec(self, fullname: str, path: Any = None, target: Any = None) -> Any:
        if fullname == self._name or fullname.startswith(self._name + "."):
            raise self._exc
        return None


def test_coqui_clone_voice_records_a_broken_import(monkeypatch) -> None:
    """#1965 folded-in defect 1. `clone_voice` does `import TTS` BEFORE
    `_ensure_loaded`, so on a broken Coqui install it is the frame that raises
    -- and it used to raise without recording anything, leaving
    `coqui_import_ok` at None on exactly the #1944 shape it exists to catch.

    Uses the non-ImportError shape deliberately: the recording `except` here is
    `BaseException` for the same reason as everywhere else in this file."""
    boom = RuntimeError("duplicate kernel registration for wait_tensor")
    # `clone_voice`'s own `import torch` runs first and is not what's under
    # test -- stub it so this test never pays for the real torch import.
    monkeypatch.setitem(sys.modules, "torch", _module_with("torch"))
    monkeypatch.setattr(sys, "meta_path", [_ExplodingFinder("TTS", boom)] + sys.meta_path)
    monkeypatch.delitem(sys.modules, "TTS", raising=False)

    with pytest.raises(RuntimeError) as exc:
        main.CoquiEngine().clone_voice(
            voice_id="test-voice",
            ref_audio=None,
            ref_sr=24000,
            audition_text="one two three",
        )

    assert exc.value is boom, "the import failure must propagate unchanged"
    assert main._COQUI_IMPORT_OK is False, (
        "clone_voice's pre-`_ensure_loaded` `import TTS` used to raise without "
        "recording anything -- a clone against a broken Coqui left /health "
        "still claiming the engine was fine"
    )


# ── /health surface ────────────────────────────────────────────────────────


@pytest.fixture
def client(monkeypatch):
    """Minimal client — drop the kokoro engine so /health reflects cold state
    (same shape as test_install_state.py's fixture)."""
    monkeypatch.delitem(main.ENGINES, "kokoro", raising=False)
    with TestClient(main.app) as c:
        yield c


IMPORT_OK_KEYS = (
    "coqui_import_ok",
    "kokoro_import_ok",
    "qwen_import_ok",
    "whisper_import_ok",
)


def test_health_carries_all_four_import_ok_keys(client: TestClient, monkeypatch) -> None:
    """The Node side reads these by name — all four must be present, and
    present as an explicit `null` when no real import has been attempted
    rather than omitted (an absent key and a null one are the same thing on
    the wire, but the Node normalisation is written against null).

    Re-resets AFTER the client fixture: `_reset_flags` runs at setup, before
    TestClient runs the real lifespan, so a preload that did attempt an import
    would otherwise decide this test's outcome."""
    for flag in ("_COQUI_IMPORT_OK", "_KOKORO_IMPORT_OK", "_QWEN_IMPORT_OK",
                 "_WHISPER_IMPORT_OK"):
        monkeypatch.setattr(main, flag, None)

    body = client.get("/health").json()

    for key in IMPORT_OK_KEYS:
        assert key in body, f"/health is missing {key}"
        assert body[key] is None, (
            f"{key} must be null until a REAL import attempt has happened -- "
            "null means 'unknown, fall back to the find_spec probe', never "
            "'broken'"
        )


@pytest.mark.parametrize("value", [True, False])
def test_health_reports_each_import_ok_tri_state(
    client: TestClient, monkeypatch, value: bool
) -> None:
    """Once a real attempt has happened, /health reports its verdict verbatim
    for every engine — no coercion, no collapsing False into null."""
    monkeypatch.setattr(main, "_COQUI_IMPORT_OK", value)
    monkeypatch.setattr(main, "_KOKORO_IMPORT_OK", value)
    monkeypatch.setattr(main, "_QWEN_IMPORT_OK", value)
    monkeypatch.setattr(main, "_WHISPER_IMPORT_OK", value)

    body = client.get("/health").json()

    for key in IMPORT_OK_KEYS:
        assert body[key] is value, f"{key} must report {value}, got {body[key]!r}"


def test_health_import_ok_is_independent_of_the_find_spec_probe(
    client: TestClient, monkeypatch
) -> None:
    """The whole point of the pair: `*_package_installed` (find_spec, never
    executes the module) can say True while `*_import_ok` says False. If these
    two could not disagree the new fields would be redundant."""
    monkeypatch.setattr(main, "_kokoro_package_installed", lambda: True)
    monkeypatch.setattr(main, "_whisper_package_installed", lambda: True)
    monkeypatch.setattr(main, "_KOKORO_IMPORT_OK", False)
    monkeypatch.setattr(main, "_QWEN_IMPORT_OK", False)
    monkeypatch.setattr(main, "_WHISPER_IMPORT_OK", False)

    body = client.get("/health").json()

    assert body["kokoro_package_installed"] is True
    assert body["kokoro_import_ok"] is False
    assert body["whisper_package_installed"] is True
    assert body["whisper_import_ok"] is False
    assert body["qwen_import_ok"] is False
