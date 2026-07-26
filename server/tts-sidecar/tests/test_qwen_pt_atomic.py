"""QwenEngine base .pt atomic-write coverage (fs-38 Wave 3b2, Task 1).

`clone_voice`/`design_voice` persist the distilled clone prompt to
<voiceId>.pt on disk. Today that write is a bare `torch.save(prompt,
pt_path)` — a crash/kill mid-write leaves a torn file on the LIVE path
(the #1804 corruption class the resolver's re-derive would otherwise hit).
This pins the fix: torch.save must target a temp sibling, and only
os.replace may promote it onto the real .pt path — mirroring the existing
1.7B persist at `_load_voice_prompt_17b`.

Reuses the sys.modules-injected fake qwen_tts/torch fixture from
test_qwen3.py (same bootstrap pattern as test_qwen_clone_voice.py).
"""
from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
from test_qwen3 import fake_qwen_runtime  # noqa: E402,F401  (pytest fixture)


def engine_torch_save_spy(engine, saved_paths):
    """Wrap the fake torch.save (injected into sys.modules by
    fake_qwen_runtime) so every call's target path is recorded, without
    changing its behavior. Returns the original save so the caller can
    restore it if needed."""
    fake_torch = sys.modules["torch"]
    real_save = fake_torch.save

    def _spy(obj, path):
        saved_paths.append(str(path))
        return real_save(obj, path)

    fake_torch.save = _spy
    return real_save


def test_clone_voice_writes_pt_via_atomic_replace(fake_qwen_runtime, monkeypatch):
    """The base .pt must be written to a temp path then os.replace'd, never
    torch.save'd directly onto the live path (corruption window, #1804)."""
    engine = fake_qwen_runtime["engine"]
    saved_paths = []
    engine_torch_save_spy(engine, saved_paths)
    real_os_replace = os.replace
    replaced = []
    monkeypatch.setattr(
        "main.os.replace",
        lambda a, b: (replaced.append((a, b)), real_os_replace(a, b))[1],
    )

    import numpy as np
    engine.clone_voice("clone-atomic", np.zeros(24000, "<i2").astype("float32"), 24000, "hi", None)

    # torch.save target was a temp sibling, and os.replace moved it onto the final .pt
    assert saved_paths, "torch.save was never called"
    assert all(not p.endswith(f"{os.sep}clone-atomic.pt") for p in saved_paths), \
        "torch.save wrote the live .pt directly — no temp file"
    assert any(dst.endswith(f"{os.sep}clone-atomic.pt") for _src, dst in replaced), \
        "os.replace never promoted a temp file onto clone-atomic.pt"
