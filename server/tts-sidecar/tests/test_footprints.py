"""Tests for `FootprintTable` — the per-(engine,model,config) peak-under-load
VRAM estimate that capacity-aware admission reserves (task 2 of the
vram-aware-placement plan). Seeds mirror the maintained `docs/local-llm.md`;
on-box observations ratchet the estimate up only, never down."""
from __future__ import annotations

import re
import sys
from pathlib import Path

# Add the sidecar root to sys.path so `import main` works regardless of
# pytest's collection directory — same pattern as test_smoke.py / test_capacity.py.
SIDECAR_ROOT = Path(__file__).resolve().parent.parent
if str(SIDECAR_ROOT) not in sys.path:
    sys.path.insert(0, str(SIDECAR_ROOT))

import main  # noqa: E402

# Repo root is 4 parents up from this file:
# server/tts-sidecar/tests/test_footprints.py -> server/tts-sidecar/tests ->
# server/tts-sidecar -> server -> <repo root>.
REPO_ROOT = Path(__file__).resolve().parents[3]


def test_peak_is_above_weight_size():
    t = main.FootprintTable()
    assert t.peak_mb("qwen", "qwen-0.6b", {"batch": 32, "tokenBudget": 3600}) >= 5600  # real decode peak, not weight size


def test_ratchets_up_only():
    t = main.FootprintTable()
    base = t.peak_mb("coqui", None, {})
    t.record("coqui", None, {}, base + 400)
    assert t.peak_mb("coqui", None, {}) == base + 400
    t.record("coqui", None, {}, base - 400)
    assert t.peak_mb("coqui", None, {}) == base + 400


def test_seed_parity_with_local_llm_doc():
    # REAL parity: parse the numbers out of the maintained doc and compare.
    doc = REPO_ROOT.joinpath("docs/local-llm.md").read_text(encoding="utf8")
    # the doc carries a machine-parseable block, e.g. "<!-- footprint:qwen=6144 -->"
    parsed = {m[0]: int(m[1]) for m in re.findall(r"<!--\s*footprint:([\w.]+)=(\d+)\s*-->", doc)}
    assert parsed, "doc must carry footprint:<engine>=<mb> anchors"
    for k, v in parsed.items():
        assert main.SEED_FOOTPRINTS_MB[k] == v, f"{k}: seed {main.SEED_FOOTPRINTS_MB[k]} != doc {v}"
