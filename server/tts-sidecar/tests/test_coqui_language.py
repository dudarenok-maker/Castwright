"""test_coqui_language.py — per-request Coqui `language` param (fs-60).

Coqui previously read a single boot-time COQUI_LANGUAGE env var for every
synth call. This pins that /synthesize now accepts a per-request `language`
field that overrides the boot-time default, and that omitting it still
falls back to the env var (backward-compat for every existing English caller).
"""

from __future__ import annotations

import sys
from pathlib import Path
from typing import Optional

SIDECAR_ROOT = Path(__file__).resolve().parent.parent
if str(SIDECAR_ROOT) not in sys.path:
    sys.path.insert(0, str(SIDECAR_ROOT))

from fastapi.testclient import TestClient  # noqa: E402
import main  # noqa: E402


class _FakeCoquiEngine(main.CoquiEngine):
    """Captures the `language` argument synthesize() actually received,
    without loading the real ~3 GB XTTS model."""

    name = "coqui"

    def __init__(self) -> None:
        super().__init__()
        self.received_language: Optional[str] = None

    def synthesize(self, model: str, voice: str, text: str, language: Optional[str] = None) -> "main.SynthResult":
        self.received_language = language or self._language
        return main.SynthResult(pcm=b"\x00\x00", sample_rate=24000, substituted_from=None)


def test_synthesize_passes_request_language_to_coqui(monkeypatch) -> None:
    fake = _FakeCoquiEngine()
    monkeypatch.setitem(main.ENGINES, "coqui", fake)
    monkeypatch.delitem(main.ENGINES, "kokoro", raising=False)
    with TestClient(main.app) as client:
        r = client.post(
            "/synthesize",
            json={"engine": "coqui", "model": "xtts_v2", "voice": "Claribel Dervla", "text": "hi", "language": "ru"},
        )
    assert r.status_code == 200
    assert fake.received_language == "ru"


def test_synthesize_omitted_language_falls_back_to_env_default(monkeypatch) -> None:
    monkeypatch.setenv("COQUI_LANGUAGE", "en")
    fake = _FakeCoquiEngine()
    monkeypatch.setitem(main.ENGINES, "coqui", fake)
    monkeypatch.delitem(main.ENGINES, "kokoro", raising=False)
    with TestClient(main.app) as client:
        r = client.post(
            "/synthesize",
            json={"engine": "coqui", "model": "xtts_v2", "voice": "Claribel Dervla", "text": "hi"},
        )
    assert r.status_code == 200
    assert fake.received_language == "en"
