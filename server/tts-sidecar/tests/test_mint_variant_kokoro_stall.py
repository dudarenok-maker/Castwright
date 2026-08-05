"""#2070 review R5 — `mint_variant`'s `unload_design()` call must not stall
every Kokoro synth for the length of its (now up to ~150s) design-contention
wait.

`unload_design()` (#2070) waits for an in-flight design to clear instead of
killing it. `mint_variant` calls it to evict a lingering VoiceDesign before
its own 1.7B-Base load — and, before this fix, did so FROM INSIDE
`with _DEVICE_LEDGER.card_lock(...), self._base17_activity(), _VD_KOKORO.design():`.
`_VdKokoroArbiter.design()` sets `_design_active` for the WHOLE span of that
`with` block, and `_VdKokoroArbiter.kokoro_synth()` blocks while it's set — so
a wait held inside that block stalled every Kokoro synth for however long
`unload_design()` waited, exactly during a bulk "Design full cast" run (design
→ mint → design → mint …) where this eviction fires routinely.

These tests drive `mint_variant` with the REAL `unload_design()` (not mocked,
unlike `test_qwen_design_base17_exclusion.py`'s eviction test) against a
manually-held `_design_in_flight` claim, so `unload_design()` genuinely waits
— and assert a concurrent Kokoro synth is NOT blocked during that wait."""
from __future__ import annotations

import sys
import tempfile
import threading
import time
import types
from pathlib import Path

import numpy as np
import pytest

SIDECAR_ROOT = Path(__file__).resolve().parent.parent
if str(SIDECAR_ROOT) not in sys.path:
    sys.path.insert(0, str(SIDECAR_ROOT))

import main  # noqa: E402


@pytest.fixture(autouse=True)
def _reset_vd_kokoro_coupling():
    """Mirrors test_design_kokoro_exclusion.py's fixture — pin shares_device
    so this file's assertions hold regardless of what an earlier test's real
    `TestClient(main.app)` startup hook left it as."""
    prior = main._VD_KOKORO._shares_device
    main._VD_KOKORO._shares_device = True
    yield
    main._VD_KOKORO._shares_device = prior


def _quiet_kokoro() -> None:
    kok = main.ENGINES.get("kokoro")
    if isinstance(kok, main.KokoroEngine):
        kok._kokoro = None


def _wire_mint_variant_internals(monkeypatch, qeng: "main.QwenEngine") -> None:
    """Mocks everything mint_variant needs EXCEPT unload_design — same recipe
    as test_qwen_design_base17_exclusion.py's test_mint_variant_evicts_resident_design."""
    class _FakeTokenizer:
        def decode(self, codes):
            return [np.zeros(6000, dtype="float32")], 24000

    class _FakeInner:
        speech_tokenizer = _FakeTokenizer()

    class _FakeBase17:
        model = _FakeInner()

        def create_voice_clone_prompt(self, ref_audio, ref_text):
            return {"prompt17": True}

    def _fake_ensure_base17_for_mint(device=None):
        qeng._base17 = _FakeBase17()

    monkeypatch.setattr(qeng, "_ensure_base17_for_mint", _fake_ensure_base17_for_mint)

    class _FakeBase:
        def create_voice_clone_prompt(self, ref_audio, ref_text):
            return {"prompt": True}

        def generate_voice_clone(self, text, language, voice_clone_prompt):
            return [np.zeros(10, dtype="float32")], 24000

    qeng._base = _FakeBase()
    monkeypatch.setattr(qeng, "_ensure_base_loaded", lambda device=None: None)
    monkeypatch.setattr(
        qeng,
        "_icl_instruct_synth",
        lambda icl, ref_text, instruct, lang: (np.zeros(6000, dtype="float32"), 24000),
    )
    monkeypatch.setattr(
        qeng,
        "_load_voice_prompt",
        lambda voice: ([types.SimpleNamespace(ref_code=None, ref_text="x")], "English", True),
    )
    qeng._voices_dir = tempfile.mkdtemp()
    base_pt, _ = qeng._voice_paths("qwen-base")
    Path(base_pt).write_bytes(b"stub")
    monkeypatch.setattr("torch.save", lambda *a, **k: None)


def test_mint_variant_does_not_stall_kokoro_while_waiting_on_an_in_flight_design(monkeypatch) -> None:
    """Mutation that must fail it — breaks the PRODUCER: move the
    `if self._design is not None: self.unload_design()` call back INSIDE the
    `with _DEVICE_LEDGER.card_lock(...), self._base17_activity(),
    _VD_KOKORO.design():` block (the pre-fix shape). `kokoro_acquired.wait()`
    below would then time out — the Kokoro synth stays blocked for as long as
    the simulated design stays in flight, because `_VD_KOKORO._design_active`
    is set BEFORE `unload_design()` ever starts waiting.
    """
    # mint_variant() -> _ensure_base17_for_mint() does an unconditional
    # `import torch` (main.py), and `_wire_mint_variant_internals` also
    # monkeypatches the real `torch.save` — both need the real package.
    pytest.importorskip("torch")
    qeng = main.QwenEngine()
    _quiet_kokoro()
    qeng._design = object()  # resident — unload_design() won't no-op immediately
    _wire_mint_variant_internals(monkeypatch, qeng)

    design_in_flight_entered = threading.Event()
    release_design_in_flight = threading.Event()

    def hold_in_flight_design():
        with qeng._design_in_flight.claim():
            design_in_flight_entered.set()
            release_design_in_flight.wait(timeout=5)

    holder = threading.Thread(target=hold_in_flight_design, daemon=True)
    holder.start()
    assert design_in_flight_entered.wait(2), "the simulated in-flight design never claimed"

    mint_done = threading.Event()
    mint_errors: list[BaseException] = []

    def run_mint():
        try:
            qeng.mint_variant(
                "qwen-base", "qwen-base__angry", "Delivered angrily.", "english", "Hello there.",
            )
        except BaseException as e:  # noqa: BLE001 - surfaced via mint_errors
            mint_errors.append(e)
        finally:
            mint_done.set()

    mint_thread = threading.Thread(target=run_mint, daemon=True)
    mint_thread.start()

    # Give mint_variant time to reach unload_design()'s wait loop (poll
    # interval 0.5s default — 0.2s here is comfortably before its first poll
    # would have any chance of observing the claim already released).
    time.sleep(0.2)
    assert not mint_done.is_set(), "mint_variant finished before the simulated design released — test bug"

    # The core assertion: while unload_design() is genuinely waiting, the
    # Kokoro<->VoiceDesign arbiter must NOT be held — a concurrent Kokoro
    # synth must be able to proceed immediately, not queue behind the wait.
    assert main._VD_KOKORO._design_active is False, (
        "the Kokoro-design arbiter is held DURING unload_design()'s wait — "
        "every Kokoro synth is stalled for the length of that wait"
    )
    kokoro_acquired = threading.Event()

    def do_kokoro():
        with main._VD_KOKORO.kokoro_synth():
            kokoro_acquired.set()

    kokoro_thread = threading.Thread(target=do_kokoro, daemon=True)
    kokoro_thread.start()
    assert kokoro_acquired.wait(1.0), (
        "a Kokoro synth was blocked while mint_variant waited on the in-flight design"
    )
    kokoro_thread.join(timeout=2)

    release_design_in_flight.set()
    holder.join(timeout=5)
    mint_thread.join(timeout=5)
    assert mint_done.is_set(), "mint_variant did not finish after the design released"
    assert mint_errors == [], f"mint_variant raised: {mint_errors!r}"
    assert qeng._design is None, "unload_design() should have cleared _design once the wait resolved"
