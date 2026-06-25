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


def test_design_route_posts_progress_when_token_present(monkeypatch):
    import main
    import numpy as np
    from fastapi.testclient import TestClient  # matches test_batch_synthesis.py; used WITHOUT `with` so lifespan/preload never fires

    class _FakeQwen(main.QwenEngine):
        def __init__(self):
            pass  # skip the real heavy __init__; the route only calls design_voice

        def design_voice(self, voice_id, instruct, language, calibration_text, voice_uuid=None, report_progress=None, mint_method=None, fallback_for=None):
            if report_progress:
                report_progress("loading-model")
                report_progress("designing")
            return main.SynthResult(pcm=np.zeros(4, dtype="<i2").tobytes(), sample_rate=24000)

    monkeypatch.setitem(main.ENGINES, "qwen", _FakeQwen())

    posted = []
    monkeypatch.setattr(main, "_post_progress", lambda url, token, phase: posted.append((url, token, phase)))

    client = TestClient(main.app)
    res = client.post("/qwen/design-voice", json={
        "voiceId": "qwen-x", "instruct": "warm",
        "progressToken": "tok123", "progressUrl": "http://127.0.0.1:8080/api/internal/design-progress",
    })
    assert res.status_code == 200
    assert posted == [
        ("http://127.0.0.1:8080/api/internal/design-progress", "tok123", "loading-model"),
        ("http://127.0.0.1:8080/api/internal/design-progress", "tok123", "designing"),
    ]
