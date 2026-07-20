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


def test_design_family_keys_separate_from_synth():
    # #1738: the rare heavy design-family ops (mint / design) must NOT share the
    # frequent plain-synth 1.7B window. `_key` splits them by the `op` cfg tag;
    # a plain synth (no `op`) stays on the shared `qwen.1.7b` key.
    assert main.FootprintTable._key("qwen", "qwen3-tts-1.7b", {}) == "qwen.1.7b"
    assert main.FootprintTable._key("qwen", "1.7b", {"op": "mint"}) == "qwen.1.7b.mint"
    assert main.FootprintTable._key("qwen", "1.7b", {"op": "design"}) == "qwen.1.7b.design"
    # An unknown op falls back to the shared synth key rather than inventing one.
    assert main.FootprintTable._key("qwen", "1.7b", {"op": "bogus"}) == "qwen.1.7b"


def test_design_family_windows_are_independent():
    # #1738 core: a flood of light synth observations must NOT pull down the
    # separately-learned mint reservation. Before the split both fed one window
    # and the mint inherited the ~3900 synth p95 (under-reserving its ~5654 real
    # peak); after the split each key learns its own.
    t = main.FootprintTable()
    for _ in range(main._FOOTPRINT_MIN_SAMPLES + 20):
        t.record("qwen", "qwen3-tts-1.7b", {}, 3900)  # frequent light synth
    for _ in range(main._FOOTPRINT_MIN_SAMPLES):
        t.record("qwen", "1.7b", {"op": "mint"}, 5654)  # rare heavy mint
    assert t.peak_mb("qwen", "qwen3-tts-1.7b", {}) == 3900
    assert t.peak_mb("qwen", "1.7b", {"op": "mint"}) == 5654  # not dragged to 3900
    # Design has seen nothing yet: still its own cold-start seed, untouched by
    # either synth or mint traffic.
    assert t.peak_mb("qwen", "1.7b", {"op": "design"}) == main.SEED_FOOTPRINTS_MB["qwen.1.7b.design"]


def test_design_family_seeds_fit_bare_8gb_headroom():
    # LOWER-BOUND guard, not a production guarantee: on a BARE 8 GB card (free
    # ~7068 MB idle, minus the ~409 MB 5%-reserve = ~6659 headroom) both
    # design-family cold-start seeds must admit, so a first-ever design/mint on
    # an empty 8 GB box isn't spuriously refused before its window warms. Both
    # are measured-backed (mint ~5654 MB, design ~5440 MB, #1742), so 6144 fits
    # with margin. A real box with a resident analyzer/Kokoro has LESS free than
    # this — that case relies on idle-evict, not on the seed fitting outright;
    # this guard just stops a future seed bump silently breaking the bare case.
    bare_headroom_8gb = 7068 - main._device_reserve_mb(8188, 500)
    assert main.SEED_FOOTPRINTS_MB["qwen.1.7b.mint"] < bare_headroom_8gb
    assert main.SEED_FOOTPRINTS_MB["qwen.1.7b.design"] < bare_headroom_8gb


def test_seed_parity_with_local_llm_doc():
    # REAL parity: parse the numbers out of the maintained doc and compare.
    doc = REPO_ROOT.joinpath("docs/local-llm.md").read_text(encoding="utf8")
    # the doc carries a machine-parseable block, e.g. "<!-- footprint:qwen=6144 -->"
    parsed = {m[0]: int(m[1]) for m in re.findall(r"<!--\s*footprint:([\w.]+)=(\d+)\s*-->", doc)}
    assert parsed, "doc must carry footprint:<engine>=<mb> anchors"
    for k, v in parsed.items():
        assert main.SEED_FOOTPRINTS_MB[k] == v, f"{k}: seed {main.SEED_FOOTPRINTS_MB[k]} != doc {v}"
