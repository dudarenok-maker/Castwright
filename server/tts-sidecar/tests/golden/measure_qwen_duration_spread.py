"""Ad-hoc on-box measurement tool, written for register row A101 (#1994,
now discharged and removed from docs/testing/onbox-acceptance-register.md —
the ID stays retired, never reused).

Qwen decoding is stochastic with no seed, so `qwen-duration-baseline.json`'s
`tolerance` needs to be derived from a real N-repeat measurement of each
`qwen-duration-fixture.json` line's duration spread, not guessed. This
script does ONLY that measurement — it does not write
`qwen-duration-baseline.json` (that stays `--bless`'s job, mechanical
`entries` refresh only) and does not touch `tolerance` itself; it prints and
optionally saves the spread so an operator can hand-set `tolerance`. A101's
own measurement (2026-08-28, RTX 5070 Ti, voice `cw_gpu_17b`, N=10) is
recorded in `qwen-duration-baseline.json`'s `_comment` and in the register's
changelog. Re-run this script (and hand-derive a fresh `tolerance`) if the
fixture lines, the model, or the designed voice change.

Usage (from the sidecar venv):
    server/tts-sidecar/.venv/Scripts/python.exe \\
        server/tts-sidecar/tests/golden/measure_qwen_duration_spread.py \\
        --repeats 10 --out spread-report.json

Respects GOLDEN_QWEN_VOICE the same way the golden test does (falls back to
the first designed voice `QwenEngine.list_voices()` finds). Pin the GPU via
QWEN_DEVICE (e.g. QWEN_DEVICE=cuda:1) before running, same as any other
sidecar entry point — NOT CUDA_VISIBLE_DEVICES, which shadows the per-engine
picker (see main.py's `_warn_if_cuda_env_shadow_active`).
"""
from __future__ import annotations

import argparse
import json
import os
import statistics
import sys
import time
from pathlib import Path

SIDECAR_ROOT = Path(__file__).resolve().parents[2]
if str(SIDECAR_ROOT) not in sys.path:
    sys.path.insert(0, str(SIDECAR_ROOT))

import main  # noqa: E402

from tests.golden.compare import measure_pcm  # noqa: E402
from tests.golden.prereq import pick_designed_voice  # noqa: E402

GOLDEN_DIR = Path(__file__).resolve().parent
FIXTURE_PATH = GOLDEN_DIR / "qwen-duration-fixture.json"
QWEN_MODEL = "0.6b"


def _load_fixture() -> dict:
    with open(FIXTURE_PATH, "r", encoding="utf-8") as f:
        return json.load(f)


def _resolve_voice(engine: "main.QwenEngine") -> str:
    voice = pick_designed_voice(engine.list_voices(), os.environ.get("GOLDEN_QWEN_VOICE"))
    if voice is None:
        raise SystemExit(
            "no designed Qwen voice on this box and no GOLDEN_QWEN_VOICE set — "
            "design one first (Qwen voices are per-workspace bespoke)."
        )
    return voice


def measure(engine: "main.QwenEngine", voice: str, fixture: dict, repeats: int) -> dict:
    lines = fixture["lines"]
    results: dict = {}

    # Warm-up: first real call also validates the engine/voice before the
    # timed loop below, same reasoning as the golden test's synthesise_or_skip
    # use, minus the pytest.skip wrapping (this is a script, not a test).
    warm = engine.synthesize(QWEN_MODEL, voice, lines[0]["text"])
    print(f"warm-up ok: {measure_pcm(warm.pcm, warm.sample_rate)['duration_sec']:.3f}s")

    for line in lines:
        durations: list[float] = []
        t0 = time.monotonic()
        for _ in range(repeats):
            res = engine.synthesize(QWEN_MODEL, voice, line["text"])
            m = measure_pcm(res.pcm, res.sample_rate)
            durations.append(m["duration_sec"])
        wall = time.monotonic() - t0

        mean = statistics.fmean(durations)
        stdev = statistics.pstdev(durations) if len(durations) > 1 else 0.0
        max_abs_dev = max(abs(d - mean) for d in durations)
        max_frac_dev = max_abs_dev / mean if mean > 0 else 0.0

        results[line["id"]] = {
            "n": repeats,
            "durations_sec": [round(d, 4) for d in durations],
            "mean_sec": round(mean, 4),
            "stdev_sec": round(stdev, 4),
            "max_abs_dev_sec": round(max_abs_dev, 4),
            "max_frac_dev": round(max_frac_dev, 4),
            "wall_sec": round(wall, 1),
        }
        print(
            f"{line['id']:>22}: mean={mean:.3f}s stdev={stdev:.3f}s "
            f"max_frac_dev={max_frac_dev:.3%} ({repeats} reps, {wall:.1f}s wall)"
        )

    overall_max_frac_dev = max(r["max_frac_dev"] for r in results.values())
    print(f"\noverall max fractional deviation across all lines: {overall_max_frac_dev:.3%}")
    print(
        "Suggested tolerance (overall max + headroom, e.g. x1.3-1.5): "
        f"~{overall_max_frac_dev * 1.3:.3f}-{overall_max_frac_dev * 1.5:.3f}"
    )

    return {
        "voice": voice,
        "model": QWEN_MODEL,
        "repeats": repeats,
        "lines": results,
        "overall_max_frac_dev": round(overall_max_frac_dev, 4),
    }


def main_measure() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repeats", type=int, default=10, help="syntheses per fixture line (default 10)")
    parser.add_argument("--out", type=Path, default=None, help="optional path to write the JSON report")
    args = parser.parse_args()

    fixture = _load_fixture()
    engine = main.QwenEngine()
    voice = _resolve_voice(engine)
    print(f"voice={voice} model={QWEN_MODEL} repeats={args.repeats} lines={len(fixture['lines'])}")

    report = measure(engine, voice, fixture, args.repeats)

    if args.out:
        with open(args.out, "w", encoding="utf-8") as f:
            json.dump(report, f, indent=2)
            f.write("\n")
        print(f"\nWrote {args.out}")


if __name__ == "__main__":
    main_measure()
