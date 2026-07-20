"""Tests for `FootprintTable` — the per-(engine,model,config) peak-under-load
VRAM estimate that capacity-aware admission reserves (task 2 of the
vram-aware-placement plan). Seeds mirror the maintained `docs/local-llm.md`
and are COLD-START PRIORS only: once enough real per-op observations have
been recorded, the learned windowed p95 supersedes the seed (up OR down)."""
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
    # Cold start (no observations yet): the seed is a realistic per-op decode
    # peak, not the old grossly-inflated ~6144 value — well below the old
    # 5600 floor, and equal to the maintained SEED_FOOTPRINTS_MB entry.
    t = main.FootprintTable()
    peak = t.peak_mb("qwen", "qwen-0.6b", {"batch": 32, "tokenBudget": 3600})
    assert peak < 5600
    assert peak == main.SEED_FOOTPRINTS_MB["qwen"]


def test_learned_p95_decays_not_max():
    # A burst of realistic low observations followed by a single spike (e.g.
    # a co-residency moment) should NOT pin the reservation at the spike —
    # the windowed p95 excludes it as a tail outlier once enough samples
    # exist, unlike the old up-only max ratchet. 50 low + 1 spike gives the
    # nearest-rank p95 comfortable margin to land inside the low cluster
    # (a single outlier in 51 samples is well outside the top 5%).
    t = main.FootprintTable()
    for _ in range(50):
        t.record("coqui", None, {}, 1900)
    t.record("coqui", None, {}, 7000)
    peak = t.peak_mb("coqui", None, {})
    assert peak < 7000
    assert peak < 2200  # tracks the low cluster, not the spike


def test_seed_used_until_min_samples():
    t = main.FootprintTable()
    seed = t.peak_mb("coqui", None, {})
    assert seed == main.SEED_FOOTPRINTS_MB["coqui"]
    # Fewer than _FOOTPRINT_MIN_SAMPLES observations: still the seed.
    for _ in range(main._FOOTPRINT_MIN_SAMPLES - 1):
        t.record("coqui", None, {}, seed - 500)
    assert t.peak_mb("coqui", None, {}) == seed
    # One more observation crosses the min-samples threshold: the learned
    # p95 (below the seed) takes over — proving the seed is a cold-start
    # prior, not a floor.
    t.record("coqui", None, {}, seed - 500)
    learned = t.peak_mb("coqui", None, {})
    assert learned == seed - 500
    assert learned < seed


def test_nonpositive_observation_ignored():
    t = main.FootprintTable()
    for _ in range(main._FOOTPRINT_MIN_SAMPLES):
        t.record("coqui", None, {}, 0)
    # None of those zeros should have entered the window.
    assert t.peak_mb("coqui", None, {}) == main.SEED_FOOTPRINTS_MB["coqui"]


def test_seed_parity_with_local_llm_doc():
    # REAL parity: parse the numbers out of the maintained doc and compare.
    doc = REPO_ROOT.joinpath("docs/local-llm.md").read_text(encoding="utf8")
    # the doc carries a machine-parseable block, e.g. "<!-- footprint:qwen=6144 -->"
    parsed = {m[0]: int(m[1]) for m in re.findall(r"<!--\s*footprint:([\w.]+)=(\d+)\s*-->", doc)}
    assert parsed, "doc must carry footprint:<engine>=<mb> anchors"
    for k, v in parsed.items():
        assert main.SEED_FOOTPRINTS_MB[k] == v, f"{k}: seed {main.SEED_FOOTPRINTS_MB[k]} != doc {v}"
