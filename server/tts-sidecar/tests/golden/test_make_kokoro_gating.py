"""`test_golden_regression._make_kokoro()`'s warm-up gating (#1987).

The blanket `except RuntimeError: pytest.skip(...)` this file's tests pin the
fix for turned a CUDA error, a bad voice substitution, or model corruption
during the warm-up synth into a green SKIP — same placebo class as #1911's
Coqui fix (`tests/golden/prereq.py`'s `engine_absent_reason` /
`synthesise_or_skip`), which `_make_kokoro` now reuses directly for its
warm-up call instead of a bare `except RuntimeError`.

Deliberately NOT marked `@pytest.mark.golden` (unlike `test_golden_regression.py`
itself): this drives `_make_kokoro()` directly with a stubbed `KokoroEngine`
(no real model, no GPU), the same technique `test_golden_sanity_gating.py`
uses to pin the rest of that module's gating logic — calling a function
straight from an imported module is a plain Python call, not a pytest
collection, so the golden module's own `pytestmark` never attaches here.
`_expect_raise`/`_expect_skip_containing` are local, deliberately-duplicated
minis of `test_golden_sanity_gating.py`'s own helpers (not imported, to avoid
any coupling with a file this PR does not touch) — `pytest.skip()` raises
`Skipped`, a `BaseException`, so a naive `pytest.raises(RuntimeError)` would
let a wrongly-skipped case sail through as this test itself reporting SKIP
(green) instead of catching the regression.
"""
from __future__ import annotations

import sys
from pathlib import Path
from typing import Optional

import pytest

SIDECAR_ROOT = Path(__file__).resolve().parents[2]
if str(SIDECAR_ROOT) not in sys.path:
    sys.path.insert(0, str(SIDECAR_ROOT))

import main  # noqa: E402

from tests.golden import test_golden_regression as golden  # noqa: E402


def _expect_raise(fn, exc_type: type, match: str = "") -> None:
    try:
        fn()
    except pytest.skip.Exception as skipped:
        pytest.fail(f"the gate reported SKIP instead of failing: {skipped}")
    except exc_type as exc:  # type: ignore[misc]
        if match and match not in str(exc):
            pytest.fail(f"raised {exc_type.__name__} but not the expected one: {exc}")
        return
    pytest.fail(f"the gate did not raise {exc_type.__name__} at all")


def _expect_skip_containing(fn, needle: str) -> None:
    try:
        fn()
    except pytest.skip.Exception as skipped:
        assert needle in str(skipped), f"skipped for the wrong reason: {skipped}"
        return
    pytest.fail(f"expected the gate to SKIP (reason containing {needle!r}), but it did not")


class _StubKokoroEngine:
    """Minimal stand-in for `KokoroEngine` as `_make_kokoro()` uses it: the
    `_model_path`/`_voices_path` file-presence check, `FALLBACK_VOICE`, and
    `synthesize()` for the warm-up call."""

    FALLBACK_VOICE = "af_heart"

    def __init__(
        self, model_path: Path, voices_path: Path, *, raise_exc: Optional[BaseException] = None
    ) -> None:
        self._model_path = str(model_path)
        self._voices_path = str(voices_path)
        self._raise_exc = raise_exc
        self.calls = 0

    def synthesize(self, model: str, voice: str, text: str) -> "main.SynthResult":
        self.calls += 1
        if self._raise_exc is not None:
            raise self._raise_exc
        return main.SynthResult(pcm=b"\x00\x00" * 100, sample_rate=24000, substituted_from=None)


def _make_stub(tmp_path: Path, *, raise_exc: Optional[BaseException] = None) -> _StubKokoroEngine:
    model_path = tmp_path / "kokoro-v1.0.onnx"
    voices_path = tmp_path / "voices-v1.0.bin"
    model_path.write_bytes(b"")
    voices_path.write_bytes(b"")
    return _StubKokoroEngine(model_path, voices_path, raise_exc=raise_exc)


def test_make_kokoro_propagates_a_real_warm_up_failure(monkeypatch, tmp_path) -> None:
    """THE regression #1987 is about: a CUDA error (or any non-"engine
    absent" RuntimeError) during warm-up must FAIL this test, not report a
    green SKIP. The blanket `except RuntimeError` this replaces would have
    swallowed this exact shape."""
    stub = _make_stub(tmp_path, raise_exc=RuntimeError("CUDA error: device-side assert triggered"))
    monkeypatch.setattr(main, "KokoroEngine", lambda: stub)

    _expect_raise(golden._make_kokoro, RuntimeError, "CUDA error")
    assert stub.calls == 1


def test_make_kokoro_still_skips_when_the_package_is_genuinely_absent(monkeypatch, tmp_path) -> None:
    """The narrowing must not break the legitimate case: weight/package
    files present on disk, but the `kokoro-onnx` package itself missing from
    this venv -- the exact RuntimeError shape `KokoroEngine._ensure_loaded`
    raises for that (main.py) -- still SKIPs."""
    stub = _make_stub(
        tmp_path,
        raise_exc=RuntimeError("Failed to import kokoro-onnx (No module named 'kokoro_onnx')."),
    )
    monkeypatch.setattr(main, "KokoroEngine", lambda: stub)

    _expect_skip_containing(golden._make_kokoro, "not installed on this box")


def test_make_kokoro_passes_on_a_healthy_warm_up(monkeypatch, tmp_path) -> None:
    """Control: a healthy warm-up returns the engine, neither raising nor
    skipping -- the failure/skip cases above are attributable to the
    injected fault, not to the stub itself."""
    stub = _make_stub(tmp_path)
    monkeypatch.setattr(main, "KokoroEngine", lambda: stub)

    try:
        engine = golden._make_kokoro()
    except pytest.skip.Exception as skipped:
        pytest.fail(f"the gate reported SKIP on a healthy engine: {skipped}")
    assert engine is stub
    assert stub.calls == 1
