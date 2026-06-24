"""Phase-progress callback wiring for design_voice / mint_variant (GPU-free)."""
import sys
import tempfile
from pathlib import Path

SIDECAR_ROOT = Path(__file__).resolve().parent.parent
if str(SIDECAR_ROOT) not in sys.path:
    sys.path.insert(0, str(SIDECAR_ROOT))


def test_design_voice_reports_phases_in_order(monkeypatch):
    import main

    qeng = main.QwenEngine()

    class _FakeDesign:
        def generate_voice_design(self, text, language, instruct):
            import numpy as np
            return [np.zeros(10, dtype="float32")], 24000

    class _FakeBase:
        def create_voice_clone_prompt(self, ref_audio, ref_text):
            return {"prompt": True}

        def generate_voice_clone(self, text, language, voice_clone_prompt):
            import numpy as np
            return [np.zeros(10, dtype="float32")], 24000

    qeng._design = _FakeDesign()
    qeng._base = _FakeBase()
    monkeypatch.setattr(qeng, "_ensure_design_loaded", lambda: None)
    monkeypatch.setattr(qeng, "_ensure_base_loaded", lambda: None)
    qeng._voices_dir = tempfile.mkdtemp()
    monkeypatch.setattr("torch.save", lambda *a, **k: None)
    # Kokoro not resident → no freeing-vram phase.
    main.ENGINES["kokoro"]._kokoro = None

    seen = []
    qeng.design_voice(
        "qwen-narrator-preview", "A warm voice.", "english", "Hi.",
        report_progress=seen.append,
    )

    assert seen == ["loading-model", "designing", "distilling", "rendering"]


def test_mint_variant_reports_phases_in_order(monkeypatch):
    import main
    import numpy as np

    qeng = main.QwenEngine()

    class _RefCode:
        def to(self, device):
            return self

    class _Item:
        ref_code = _RefCode()
        ref_text = "Hi."

    class _Tok:
        def decode(self, items):
            return [np.zeros(10, dtype="float32")], 24000

    class _Model:
        speech_tokenizer = _Tok()

    class _FakeBase17:
        model = _Model()

        def create_voice_clone_prompt(self, ref_audio, ref_text):
            return {"prompt": True}

    class _FakeBase:
        def create_voice_clone_prompt(self, ref_audio, ref_text):
            return {"prompt": True}

        def generate_voice_clone(self, text, language, voice_clone_prompt):
            return [np.zeros(10, dtype="float32")], 24000

    qeng._base17 = _FakeBase17()
    qeng._base = _FakeBase()
    monkeypatch.setattr(qeng, "_ensure_base17_loaded", lambda: None)
    monkeypatch.setattr(qeng, "_ensure_base_loaded", lambda: None)
    monkeypatch.setattr(qeng, "_load_voice_prompt", lambda v: ([_Item()], "english", True))
    monkeypatch.setattr(qeng, "_icl_instruct_synth", lambda *a, **k: (np.zeros(10, dtype="float32"), 24000))
    monkeypatch.setattr(qeng, "_base17_activity", lambda: __import__("contextlib").nullcontext())
    monkeypatch.setattr("os.path.isfile", lambda p: True)
    qeng._voices_dir = tempfile.mkdtemp()
    monkeypatch.setattr("torch.save", lambda *a, **k: None)
    main.ENGINES["kokoro"]._kokoro = None

    seen = []
    qeng.mint_variant(
        "qwen-base", "qwen-base__angry", "furious", "english", "Hi.",
        report_progress=seen.append,
    )

    assert seen == ["loading-model", "anchoring", "performing", "distilling", "rendering"]
