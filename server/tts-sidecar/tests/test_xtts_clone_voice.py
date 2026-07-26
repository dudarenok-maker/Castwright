"""CoquiEngine cloned-voice latents plumbing (fs-38 Wave 3c, task 7).

This task only establishes the artifact directory + path helper that later
tasks (clone-voice ingest, synth-time lookup) will write to and read from —
`self._voices_dir` (env-overridable, sibling convention to
`QwenEngine`'s `QWEN_VOICES_DIR`) and `_voice_paths(voice_id) ->
(pt_path, json_path)`. No endpoint exists yet, so these tests instantiate
`CoquiEngine` directly (its `__init__` never touches torch, so no
sys.modules stub is needed — same pattern as test_coqui_device.py).
"""
from __future__ import annotations

import os
import sys
from pathlib import Path

SIDECAR_ROOT = Path(__file__).resolve().parent.parent
if str(SIDECAR_ROOT) not in sys.path:
    sys.path.insert(0, str(SIDECAR_ROOT))

import main  # noqa: E402


def test_voices_dir_defaults_next_to_sidecar(monkeypatch) -> None:
    """No XTTS_VOICES_DIR set → falls back to <sidecar>/voices/xtts, the
    sibling convention to QwenEngine's legacy_voices_dir default."""
    monkeypatch.delenv("XTTS_VOICES_DIR", raising=False)
    eng = main.CoquiEngine()
    expected = os.path.join(os.path.dirname(main.__file__), "voices", "xtts")
    assert eng._voices_dir == expected


def test_voices_dir_honours_env_override(tmp_path, monkeypatch) -> None:
    """XTTS_VOICES_DIR set (the Node side points it at <workspace>/voices/xtts)
    → CoquiEngine uses it verbatim, not the sidecar-relative default."""
    override = str(tmp_path / "workspace-voices-xtts")
    monkeypatch.setenv("XTTS_VOICES_DIR", override)
    eng = main.CoquiEngine()
    assert eng._voices_dir == override


def test_key_prefix_constant() -> None:
    assert main.CoquiEngine.XTTS_KEY_PREFIX == "xtts-"


def test_voice_paths_ascii_id_is_identity(monkeypatch) -> None:
    """An already-filename-safe id round-trips byte-for-byte — no hash
    suffix — mirroring QwenEngine._voice_paths's ASCII fast path."""
    monkeypatch.delenv("XTTS_VOICES_DIR", raising=False)
    eng = main.CoquiEngine()
    pt_path, json_path = eng._voice_paths("xtts-abc")
    assert pt_path == os.path.join(eng._voices_dir, "xtts-abc.pt")
    assert json_path == os.path.join(eng._voices_dir, "xtts-abc.json")


def test_voice_paths_lossy_sanitisation_stays_injective(monkeypatch) -> None:
    """Two distinct non-ASCII voice ids that `re.sub` would otherwise both
    flatten to the same run of underscores must resolve to DIFFERENT
    filenames — each gets its own stable sha1-derived suffix, so a purge (or
    a later re-derive) of one voice's latents can never collide with, or
    silently clobber, the other's."""
    monkeypatch.delenv("XTTS_VOICES_DIR", raising=False)
    eng = main.CoquiEngine()
    pt_a, json_a = eng._voice_paths("xtts-Ёлка")
    pt_b, json_b = eng._voice_paths("xtts-Йлка")
    assert pt_a != pt_b
    assert json_a != json_b
    # Both still land under the configured voices dir with the expected
    # extensions — the hash suffix changes the stem, not the shape.
    for p in (pt_a, pt_b):
        assert os.path.dirname(p) == eng._voices_dir
        assert p.endswith(".pt")
    for p in (json_a, json_b):
        assert p.endswith(".json")
