"""#4456 -- a resident CT2 Whisper has no torch device (`_model` exposes no
`.parameters()`), so `_engine_actual_card` gave it `index: None` and the REAL
`_is_resident` mapped that to cuda:0, whatever card ASR_DEVICE pinned. These
tests drive the real `_is_resident` and `_engine_actual_card` (test_a4 in
test_admission_protects_own_model.py monkeypatches `_is_resident`, so it could
not see this)."""
from __future__ import annotations

import sys
from pathlib import Path

SIDECAR_ROOT = Path(__file__).resolve().parent.parent
if str(SIDECAR_ROOT) not in sys.path:
    sys.path.insert(0, str(SIDECAR_ROOT))

import main  # noqa: E402


class _Ct2Model:
    """CT2-like: no `.parameters()`, so the torch introspection finds nothing."""


def _whisper(monkeypatch, device):
    eng = object.__new__(main.WhisperEngine)
    eng._model = _Ct2Model()
    eng._device = device
    eng._requested_device = device
    monkeypatch.setattr(main, "ASR", eng)
    return eng


def test_ct2_whisper_on_cuda1_reports_card_1(monkeypatch):
    eng = _whisper(monkeypatch, "cuda:1")
    assert main._engine_actual_card(eng)["index"] == 1
    assert main._is_resident("asr") == "cuda:1"
    assert main._own_resident_tier("asr", None, {}) == ("asr", 0, "cuda:1")


def test_ct2_whisper_on_cpu_stays_non_gpu(monkeypatch):
    eng = _whisper(monkeypatch, "cpu")
    assert main._engine_actual_card(eng)["index"] is None
    assert main._is_resident("asr") is None
