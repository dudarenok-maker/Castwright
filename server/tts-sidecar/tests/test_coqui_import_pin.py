"""#1944 — `_pin_coqui_import_order`, the startup boot-order pin.

Belt-and-braces alongside `_disarm_speechbrain_lazy_modules`
(test_speechbrain_disarm.py): synchronously `import TTS.api` at sidecar
startup, before ECAPA (or anything else) gets a chance to load speechbrain.
Gated by COQUI_PIN_IMPORT_ORDER (registry key tts.coqui.pinImportOrder),
default ON. conftest.py defaults it to "0" suite-wide (mirroring
PRELOAD_COQUI) so the general test suite never pays for a real `TTS.api`
import as a side effect of spinning up TestClient(main.app) — these tests
stub `_import_tts_api_for_pin` so none of them do a real import either; the
knob's actual behaviour is what's under test, not coqui-tts itself."""
from __future__ import annotations

import asyncio
import logging
import sys
from pathlib import Path

SIDECAR_ROOT = Path(__file__).resolve().parent.parent
if str(SIDECAR_ROOT) not in sys.path:
    sys.path.insert(0, str(SIDECAR_ROOT))

import main  # noqa: E402


def _reset_import_ok(monkeypatch) -> None:
    """Start each test from a clean sticky global — `_COQUI_IMPORT_OK`
    persists across tests in-process, so a test that doesn't reset it could
    pass off a previous test's leftover value."""
    monkeypatch.setattr(main, "_COQUI_IMPORT_OK", None)


def test_pin_skips_when_disabled(monkeypatch) -> None:
    """COQUI_PIN_IMPORT_ORDER=0 → the eager import must NOT run."""
    monkeypatch.setenv("COQUI_PIN_IMPORT_ORDER", "0")
    _reset_import_ok(monkeypatch)
    calls: list[str] = []
    monkeypatch.setattr(main, "_import_tts_api_for_pin", lambda: calls.append("import"))

    asyncio.run(main._pin_coqui_import_order())

    assert calls == []
    assert main._COQUI_IMPORT_OK is None


def test_pin_runs_by_default_when_unset(monkeypatch) -> None:
    """Default (COQUI_PIN_IMPORT_ORDER unset) → the eager import DOES run.
    This is the knob's registry default (true) — the Python fallback here
    must agree, or the two silently drift (a known past bug class in this
    repo, e.g. the PRELOAD_KOKORO fs-60 fix)."""
    monkeypatch.delenv("COQUI_PIN_IMPORT_ORDER", raising=False)
    monkeypatch.setattr(main, "_coqui_package_installed", lambda: True)
    _reset_import_ok(monkeypatch)
    calls: list[str] = []
    monkeypatch.setattr(main, "_import_tts_api_for_pin", lambda: calls.append("import"))

    asyncio.run(main._pin_coqui_import_order())

    assert calls == ["import"], (
        "default (unset) must pin the import order -- matches the registry "
        "knob's default-ON"
    )
    assert main._COQUI_IMPORT_OK is True


def test_pin_explicit_1_runs_the_eager_import(monkeypatch) -> None:
    monkeypatch.setenv("COQUI_PIN_IMPORT_ORDER", "1")
    monkeypatch.setattr(main, "_coqui_package_installed", lambda: True)
    _reset_import_ok(monkeypatch)
    calls: list[str] = []
    monkeypatch.setattr(main, "_import_tts_api_for_pin", lambda: calls.append("import"))

    asyncio.run(main._pin_coqui_import_order())

    assert calls == ["import"]
    assert main._COQUI_IMPORT_OK is True


def test_pin_skips_cleanly_when_coqui_not_installed(monkeypatch) -> None:
    """Even with the knob on, a venv without coqui-tts installed must not
    attempt the import — the `_coqui_package_installed` find_spec probe is
    cheap and avoids a guaranteed-failing import."""
    monkeypatch.setenv("COQUI_PIN_IMPORT_ORDER", "1")
    monkeypatch.setattr(main, "_coqui_package_installed", lambda: False)
    _reset_import_ok(monkeypatch)
    calls: list[str] = []
    monkeypatch.setattr(main, "_import_tts_api_for_pin", lambda: calls.append("import"))

    asyncio.run(main._pin_coqui_import_order())

    assert calls == []
    assert main._COQUI_IMPORT_OK is None


def test_pin_import_failure_does_not_abort_startup(monkeypatch, caplog) -> None:
    """An unexpected import failure (the exact case this pin exists to avoid
    needing) must log a warning and let `_lifespan` continue — never crash
    sidecar boot. `_disarm_speechbrain_lazy_modules` + the per-request lazy
    import remain as fallbacks."""
    monkeypatch.setenv("COQUI_PIN_IMPORT_ORDER", "1")
    monkeypatch.setattr(main, "_coqui_package_installed", lambda: True)
    _reset_import_ok(monkeypatch)

    def _boom() -> None:
        raise ImportError("boom")

    monkeypatch.setattr(main, "_import_tts_api_for_pin", _boom)

    with caplog.at_level(logging.WARNING, logger="sidecar"):
        asyncio.run(main._pin_coqui_import_order())  # must not raise

    assert main._COQUI_IMPORT_OK is False
    assert any(
        "Eager TTS.api import-order pin failed" in r.getMessage() for r in caplog.records
    )
