"""#4456 -- a resident CT2 Whisper has no torch device (`_model` exposes no
`.parameters()`), so `_engine_actual_card` gave it `index: None` and the REAL
`_is_resident` mapped that to cuda:0, whatever card ASR_DEVICE pinned. These
tests drive the real `_is_resident` and `_engine_actual_card` (test_a4 in
test_admission_protects_own_model.py monkeypatches `_is_resident`, so it could
not see this)."""
from __future__ import annotations

import asyncio
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


# --- Qwen: same no-index branch (`Qwen3TTSModel` has no `.parameters()`) -----


class _QwenWrapper:
    """`Qwen3TTSModel`-shaped: no `.parameters()`."""


def _qwen(monkeypatch, device):
    eng = object.__new__(main.QwenEngine)
    eng._base = _QwenWrapper()
    eng._base17 = None
    eng._design = None
    eng._device = device
    monkeypatch.setitem(main.ENGINES, "qwen", eng)
    return eng


def _wire_two_cards(monkeypatch, free_by_idx):
    pc = main._placement
    monkeypatch.setattr(
        pc,
        "probe",
        lambda: [
            {"kind": "cuda", "index": i, "label": "g", "totalMb": 16000, "freeMb": mb}
            for i, mb in free_by_idx.items()
        ],
    )
    monkeypatch.setattr(pc, "footprints", main.FootprintTable())
    monkeypatch.setattr(pc, "ledger", main.ReservationLedger())
    monkeypatch.setattr(pc, "reserve_mb", lambda: 500)
    monkeypatch.setattr(pc, "_protected_steps", {}, raising=False)
    monkeypatch.setattr(pc, "_admit_lock", asyncio.Lock())
    monkeypatch.setattr(pc, "reclaim", lambda dk: False)
    monkeypatch.setattr(pc, "_last_reclaim", {})
    return pc


def _reserve(pc, model, pinned=None):
    async def body():
        async with pc.reservation(
            "qwen", model, {}, cpu_capable=False, heavy=True, pinned=pinned
        ) as adm:
            return adm

    return asyncio.run(body())


def test_qwen_on_cuda1_reports_card_1(monkeypatch):
    eng = _qwen(monkeypatch, "cuda:1")
    assert main._engine_actual_card(eng)["index"] == 1
    assert main._is_resident("qwen") == "cuda:1"


def test_warm_qwen_on_cuda1_is_admitted_to_cuda1_not_the_tight_cuda0(monkeypatch):
    _qwen(monkeypatch, "cuda:1")
    pc = _wire_two_cards(monkeypatch, {0: 300, 1: 12000})
    assert _reserve(pc, "0.6b") == {"device": "cuda:1"}


def test_cold_17b_pinned_to_cuda1_is_admitted_to_cuda1(monkeypatch):
    _qwen(monkeypatch, "cuda:1")
    pc = _wire_two_cards(monkeypatch, {0: 12000, 1: 12000})
    assert _reserve(pc, "1.7b", pinned="cuda:1") == {"device": "cuda:1"}
