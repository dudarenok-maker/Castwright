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


def _coqui_install_present(monkeypatch) -> None:
    """Stand in for an install that ACTUALLY USES Coqui — package importable
    AND the XTTS v2 weights on disk. The weights are the real gate (#1962
    review finding 2): the ~2 GB `model.pth` only exists if someone
    deliberately installed Coqui from the Model Manager (#1965 — coqui-tts is
    opt-in, not an ordinary always-present dependency; the package check still
    runs, the weights check just narrows it further)."""
    monkeypatch.setattr(main, "_coqui_package_installed", lambda: True)
    monkeypatch.setattr(main, "_coqui_weights_present", lambda: True)


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
    _coqui_install_present(monkeypatch)
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
    _coqui_install_present(monkeypatch)
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


def test_pin_skips_when_coqui_weights_are_absent(monkeypatch, caplog) -> None:
    """The gate that keeps Qwen-only / Kokoro-only installs from paying for
    this (#1962 review finding 2). The ~2 GB XTTS `model.pth` only exists if
    someone deliberately installed Coqui, so the weights are the durable
    "this install uses Coqui" signal — stricter than package-presence, which
    can linger after the weights are purged (#1965).

    Measured cost of getting this wrong: the pin holds the listening socket
    closed for 14.6 s versus 2.9 s without it (uvicorn binds only after
    lifespan startup returns), i.e. ~12 s of unreachable sidecar at every
    boot for a collision the install cannot hit."""
    monkeypatch.setenv("COQUI_PIN_IMPORT_ORDER", "1")
    monkeypatch.setattr(main, "_coqui_package_installed", lambda: True)
    monkeypatch.setattr(main, "_coqui_weights_present", lambda: False)
    _reset_import_ok(monkeypatch)
    calls: list[str] = []
    monkeypatch.setattr(main, "_import_tts_api_for_pin", lambda: calls.append("import"))

    with caplog.at_level(logging.INFO, logger="sidecar"):
        asyncio.run(main._pin_coqui_import_order())

    assert calls == [], (
        "weights absent means this install does not use Coqui -- the eager "
        "import must be skipped even with the knob explicitly ON"
    )
    assert main._COQUI_IMPORT_OK is None, (
        "skipping is not an import attempt, so the sticky health field must "
        "stay None rather than claiming a verdict"
    )
    assert any("weights absent" in r.getMessage() for r in caplog.records)


def test_pin_import_failure_does_not_abort_startup(monkeypatch, caplog) -> None:
    """An unexpected import failure (the exact case this pin exists to avoid
    needing) must log a warning and let `_lifespan` continue — never crash
    sidecar boot. `_disarm_speechbrain_lazy_modules` + the per-request lazy
    import remain as fallbacks."""
    monkeypatch.setenv("COQUI_PIN_IMPORT_ORDER", "1")
    _coqui_install_present(monkeypatch)
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
