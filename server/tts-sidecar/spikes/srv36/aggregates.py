"""Pure F1/F3/F4/F5 aggregates for the stochastic-drift spike."""
from __future__ import annotations
import numpy as np
from spikes.srv36.metrics import eer, spread_stats

FLOOR_STD_MAX = 0.07
FLOOR_P05_MIN = 0.50
SEP_EER_MAX = 0.25
LEN_STD_OK = 0.05


def f1_floor(clean_sims) -> dict:
    s = spread_stats(clean_sims)
    return {"spread": s, "floor_ok": bool(s["std"] <= FLOOR_STD_MAX and s["p05"] >= FLOOR_P05_MIN)}


def f3_separability(clean_sims, misfire_sims) -> dict:
    e = eer(genuine=clean_sims, impostor=misfire_sims)
    return {"eer": e, "separable": bool(e["eer"] <= SEP_EER_MAX)}


def residual_value(acoustic_flagged_keys, gate_flagged_keys, confirmed_real) -> dict:
    missed = set(acoustic_flagged_keys) - set(gate_flagged_keys)
    denom = max(1, len(set(acoustic_flagged_keys)))
    return {"missed_by_gates": missed, "residual_fraction": confirmed_real / denom,
            "confirmed_real": int(confirmed_real)}


def f5_length_coverage(length_to_sims: dict, seg_durations, floor: float) -> dict:
    per_len = {float(k): float(np.std(v)) for k, v in length_to_sims.items()}
    scorable = sorted(L for L, st in per_len.items() if st <= LEN_STD_OK)
    d = np.asarray(seg_durations, np.float64)
    return {"std_by_length": per_len, "min_scorable_sec": (scorable[0] if scorable else None),
            "coverage": float(np.mean(d >= floor)) if d.size else 0.0}
