"""Reads f1..f5 results -> go/no-go (spec §2.1/§2.2). F4 is the decisive gate."""
from __future__ import annotations
import json
from pathlib import Path

HERE = Path(__file__).resolve().parent
RESULTS = HERE / "results"
RESIDUAL_BAR = 0.15
COVERAGE_BAR = 0.50


def decide(f1: dict, f3: dict, f4: dict, f5: dict) -> dict:
    reasons = []
    floor = bool(f1.get("floor_ok"))
    sep = bool(f3.get("separable"))
    resid = float(f4.get("residual_fraction", 0.0)) >= RESIDUAL_BAR
    cov = float(f5.get("coverage", 0.0)) >= COVERAGE_BAR
    if not floor:
        reasons.append("F1 stochastic floor is too wide — a correct voice already scatters "
                       "as much as a misfire; no acoustic check can work.")
    if not sep:
        reasons.append("F3 cannot separate real misfires from clean renders above the floor.")
    if not resid:
        reasons.append(f"F4 residual value below {RESIDUAL_BAR:.0%} — acoustic only re-flags "
                       "what ASR + audio-QA already catch (redundant).")
    if not cov:
        reasons.append(f"F5 coverage below {COVERAGE_BAR:.0%} — most dialogue inconclusive.")
    go = floor and sep and resid and cov
    if go:
        reasons.append("Tight floor, real misfires separable, and acoustic catches drift the "
                       "existing gates miss (human-confirmed) → real residual value.")
    return {"recommendation": "go" if go else "no-go", "reasons": reasons}


def write_findings() -> dict:
    f = {n: json.loads((RESULTS / f"{n}.json").read_text()) for n in ("f1", "f3", "f4", "f5")}
    d = decide(f["f1"], f["f3"], f["f4"], f["f5"])
    md = [
        "# srv-36 Phase 0 — Findings (stochastic drift)", "",
        f"## Recommendation: **{d['recommendation'].upper()}**", "",
        *[f"- {r}" for r in d["reasons"]], "",
        "## Measured numbers",
        f"- F1 stochastic floor: `{f['f1'].get('spread')}` floor_ok=`{f['f1'].get('floor_ok')}`",
        f"- F3 in-domain EER (clean vs REAL misfires): `{f['f3'].get('eer')}` separable=`{f['f3'].get('separable')}`",
        f"- F4 residual value: fraction=`{f['f4'].get('residual_fraction')}` confirmed_real=`{f['f4'].get('confirmed_real')}` (drift the gates missed)",
        f"- F5 min scorable sec / coverage: `{f['f5'].get('min_scorable_sec')}` / `{f['f5'].get('coverage')}`", "",
        "_Anchor = the measured in-domain EER above, NOT VoxCeleb 0.9%._",
    ]
    (HERE / "FINDINGS.md").write_text("\n".join(md), encoding="utf-8")
    return d
