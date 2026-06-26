"""Resident-VRAM exclusion between the 1.7B-VoiceDesign and 1.7B-Base models.

On an 8 GB card the three heavy Qwen models — 0.6B-Base (`_base`, ~1.2 GB),
1.7B-Base (`_base17`, ~3.4 GB) and 1.7B-VoiceDesign (`_design`, ~3.4-5 GB) —
cannot all co-reside. The synth path already evicts `_design` before using
`_base17` (synthesize/synthesize_batch → unload_design). These tests pin the
SYMMETRIC eviction on the DESIGN side, which a bulk "Design full cast" run hits:

  - A base design (`design_voice`) loads VoiceDesign + 0.6B and must evict any
    resident 1.7B-Base left over from the previous variant mint.
  - A variant mint (`mint_variant`) loads 1.7B-Base + 0.6B and must evict any
    resident VoiceDesign left over from the previous base design.

Without these, scope='both' interleaves the two heavy 1.7B models on the card,
crossing the VRAM recycle ceiling → OOM-protection self-exit once per voice
(the sawtooth the operator observed). See the cast-design bulk loop in
server/src/routes/cast-design.ts (buildTaskList orders base → variants).
"""
from __future__ import annotations

import sys
import tempfile
import types
from pathlib import Path

import numpy as np

SIDECAR_ROOT = Path(__file__).resolve().parent.parent
if str(SIDECAR_ROOT) not in sys.path:
    sys.path.insert(0, str(SIDECAR_ROOT))

import main  # noqa: E402


def _quiet_kokoro() -> None:
    """Ensure no resident Kokoro so the Kokoro-eviction branch is a no-op and
    doesn't interfere with the model under test (other tests may leave it set)."""
    kok = main.ENGINES.get("kokoro")
    if isinstance(kok, main.KokoroEngine):
        kok._kokoro = None


def test_design_voice_evicts_resident_base17(monkeypatch):
    """design_voice must evict a resident 1.7B-Base before the VoiceDesign load —
    the two 1.7B models can't co-reside on the 8 GB card. Reproduces the second
    half of the bulk-design OOM: the previous variant mint left `_base17`
    resident, and the next character's base design would stack VoiceDesign on
    top of it."""
    qeng = main.QwenEngine()
    _quiet_kokoro()

    # Pretend the 1.7B-Base is resident (left over from a prior mint).
    qeng._base17 = object()
    evicted = {"called": False}

    def _fake_unload_base17():
        evicted["called"] = True
        qeng._base17 = None  # simulate the real unload clearing the model

    monkeypatch.setattr(qeng, "unload_base17", _fake_unload_base17)

    captured = {"base17_resident_during_design": None}

    class _FakeDesign:
        def generate_voice_design(self, text, language, instruct):
            captured["base17_resident_during_design"] = qeng._base17 is not None
            return [np.zeros(10, dtype="float32")], 24000

    class _FakeBase:
        def create_voice_clone_prompt(self, ref_audio, ref_text):
            return {"prompt": True}

        def generate_voice_clone(self, text, language, voice_clone_prompt):
            return [np.zeros(10, dtype="float32")], 24000

    qeng._design = _FakeDesign()
    qeng._base = _FakeBase()
    monkeypatch.setattr(qeng, "_ensure_design_loaded", lambda: None)
    monkeypatch.setattr(qeng, "_ensure_base_loaded", lambda: None)
    qeng._voices_dir = tempfile.mkdtemp()
    monkeypatch.setattr("torch.save", lambda *a, **k: None)

    qeng.design_voice("qwen-narrator-preview", "A warm voice.", "english", "Hello there.")

    assert evicted["called"] is True, "resident 1.7B-Base must be evicted before the VoiceDesign load"
    assert captured["base17_resident_during_design"] is False, (
        "1.7B-Base must NOT be resident during the VoiceDesign forward (OOM on 8 GB)"
    )


def test_mint_variant_evicts_resident_design(monkeypatch):
    """mint_variant must evict a resident VoiceDesign before loading the 1.7B-Base
    — mirrors the synth path's unload_design(). Reproduces the first half of the
    bulk-design OOM: the base design left `_design` resident, and the very next
    variant mint would stack the 1.7B-Base on top of it."""
    qeng = main.QwenEngine()
    _quiet_kokoro()

    # Pretend the VoiceDesign model is resident (left over from a base design).
    qeng._design = object()
    evicted = {"called": False}

    def _fake_unload_design():
        evicted["called"] = True
        qeng._design = None  # simulate the real unload clearing the model

    monkeypatch.setattr(qeng, "unload_design", _fake_unload_design)

    captured = {"design_resident_at_base17_load": None}

    class _FakeTokenizer:
        def decode(self, codes):
            return [np.zeros(6000, dtype="float32")], 24000

    class _FakeInner:
        speech_tokenizer = _FakeTokenizer()

    class _FakeBase17:
        model = _FakeInner()

        def create_voice_clone_prompt(self, ref_audio, ref_text):
            return {"prompt17": True}

    def _fake_ensure_base17_for_mint():
        # The eviction must already have happened by the time the 1.7B-Base loads.
        if captured["design_resident_at_base17_load"] is None:
            captured["design_resident_at_base17_load"] = qeng._design is not None
        qeng._base17 = _FakeBase17()

    monkeypatch.setattr(qeng, "_ensure_base17_for_mint", _fake_ensure_base17_for_mint)

    class _FakeBase:
        def create_voice_clone_prompt(self, ref_audio, ref_text):
            return {"prompt": True}

        def generate_voice_clone(self, text, language, voice_clone_prompt):
            return [np.zeros(10, dtype="float32")], 24000

    qeng._base = _FakeBase()
    monkeypatch.setattr(qeng, "_ensure_base_loaded", lambda: None)
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
    # The base .pt must exist on disk for the mint's isfile() guard to pass.
    base_pt, _ = qeng._voice_paths("qwen-base")
    Path(base_pt).write_bytes(b"stub")
    monkeypatch.setattr("torch.save", lambda *a, **k: None)

    qeng.mint_variant(
        "qwen-base", "qwen-base__angry", "Delivered angrily.", "english", "Hello there.",
    )

    assert evicted["called"] is True, "resident VoiceDesign must be evicted before the 1.7B-Base load"
    assert captured["design_resident_at_base17_load"] is False, (
        "VoiceDesign must NOT be resident when the 1.7B-Base loads (OOM on 8 GB)"
    )
