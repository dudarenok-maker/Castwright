"""test_install_state.py — /health per-engine package-importability booleans.

Pins the B1 correctness fix:
- /health exposes coqui_package_installed, kokoro_package_installed,
  whisper_package_installed (mirroring the existing qwen_package_installed).
- qwen_weights_present is reported INDEPENDENTLY of qwen_package_installed
  (the short-circuit bug that hid the package-missing case is removed).
"""
from __future__ import annotations

import sys
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

SIDECAR_ROOT = Path(__file__).resolve().parent.parent
if str(SIDECAR_ROOT) not in sys.path:
    sys.path.insert(0, str(SIDECAR_ROOT))

import main  # noqa: E402


@pytest.fixture
def client(monkeypatch):
    """Minimal client — patch out eager preloads so /health reflects cold state."""
    monkeypatch.delitem(main.ENGINES, "kokoro", raising=False)
    with TestClient(main.app) as c:
        yield c


# ── New keys are present ────────────────────────────────────────────────


def test_health_exposes_coqui_package_installed(client: TestClient) -> None:
    """/health body must contain coqui_package_installed (bool)."""
    body = client.get("/health").json()
    assert "coqui_package_installed" in body
    assert isinstance(body["coqui_package_installed"], bool)


def test_health_exposes_kokoro_package_installed(client: TestClient) -> None:
    """/health body must contain kokoro_package_installed (bool)."""
    body = client.get("/health").json()
    assert "kokoro_package_installed" in body
    assert isinstance(body["kokoro_package_installed"], bool)


def test_health_exposes_whisper_package_installed(client: TestClient) -> None:
    """/health body must contain whisper_package_installed (bool)."""
    body = client.get("/health").json()
    assert "whisper_package_installed" in body
    assert isinstance(body["whisper_package_installed"], bool)


# ── Monkeypatching the module-level helpers affects /health ─────────────


def test_coqui_package_installed_reflects_monkeypatch(
    client: TestClient, monkeypatch
) -> None:
    """When _coqui_package_installed is patched to False, the key reports False."""
    monkeypatch.setattr(main, "_coqui_package_installed", lambda: False)
    body = client.get("/health").json()
    assert body["coqui_package_installed"] is False


def test_kokoro_package_installed_reflects_monkeypatch(
    client: TestClient, monkeypatch
) -> None:
    """When _kokoro_package_installed is patched to False, the key reports False."""
    monkeypatch.setattr(main, "_kokoro_package_installed", lambda: False)
    body = client.get("/health").json()
    assert body["kokoro_package_installed"] is False


def test_whisper_package_installed_reflects_monkeypatch(
    client: TestClient, monkeypatch
) -> None:
    """When _whisper_package_installed is patched to False, the key reports False."""
    monkeypatch.setattr(main, "_whisper_package_installed", lambda: False)
    body = client.get("/health").json()
    assert body["whisper_package_installed"] is False


# ── Short-circuit fix: qwen_weights_present independent of package ──────


def test_qwen_weights_present_independent_of_package(
    client: TestClient, monkeypatch
) -> None:
    """qwen_weights_present must be reported even when qwen_package_installed
    is False — the short-circuit bug returned False unconditionally when the
    package was absent, hiding the package-missing case from the Node side."""
    monkeypatch.setattr(main, "_qwen_package_installed", lambda: False)
    monkeypatch.setattr(main, "_qwen_weights_present", lambda: True)
    body = client.get("/health").json()
    assert body["qwen_package_installed"] is False
    assert body["qwen_weights_present"] is True, (
        "qwen_weights_present must be True even when qwen_package_installed "
        "is False — the package-missing state requires both to be visible"
    )


# ── coqui_version (fs-38 Wave 3c Task 19 — the current-coqui-version oracle) ──


def test_health_exposes_coqui_version(client: TestClient) -> None:
    """/health body must contain coqui_version (str | None). This is the
    Node-side clone-voice resolver's currentArtifactVersion('coqui') oracle —
    without it the resolver can never detect a stale coqui clone."""
    body = client.get("/health").json()
    assert "coqui_version" in body
    assert body["coqui_version"] is None or isinstance(body["coqui_version"], str)


def test_coqui_version_reflects_monkeypatch(client: TestClient, monkeypatch) -> None:
    """When _coqui_installed_version is patched to a concrete version string,
    /health forwards it verbatim — same shape as the other engine booleans
    above (test_coqui_package_installed_reflects_monkeypatch)."""
    monkeypatch.setattr(main, "_coqui_installed_version", lambda: "0.27.5")
    body = client.get("/health").json()
    assert body["coqui_version"] == "0.27.5"


def test_coqui_installed_version_returns_none_without_importing_tts(monkeypatch) -> None:
    """_coqui_installed_version must use importlib.metadata (no `import TTS`)
    — the same non-importing cost class as _coqui_package_installed, so a
    30-second /health poll never eats TTS's own (torch-pulling) import cost.
    Simulates the package genuinely not being installed (importlib.metadata
    raises PackageNotFoundError) and asserts a clean None, not an exception
    surfacing as a 500 from /health."""
    import importlib.metadata

    def _raise_not_found(name: str) -> str:
        raise importlib.metadata.PackageNotFoundError(name)

    monkeypatch.setattr(importlib.metadata, "version", _raise_not_found)
    assert main._coqui_installed_version() is None


def test_coqui_installed_version_reads_the_coqui_tts_distribution(monkeypatch) -> None:
    """Pins the exact distribution name read: pip package `coqui-tts` (the
    import name is `TTS`, a different string) — a regression here would
    silently read the wrong package's version, or raise on every poll."""
    import importlib.metadata

    seen: list[str] = []

    def _fake_version(name: str) -> str:
        seen.append(name)
        return "9.9.9"

    monkeypatch.setattr(importlib.metadata, "version", _fake_version)
    result = main._coqui_installed_version()
    assert seen == ["coqui-tts"]
    assert result == "9.9.9"
