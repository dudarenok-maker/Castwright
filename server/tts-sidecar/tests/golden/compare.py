"""Pure comparison helpers for the golden-audio regression harness (ops-11).

Deliberately import-light — only the stdlib `array`/`math`, NO torch / onnx /
numpy / kokoro. That keeps `test_golden_compare.py` runnable inside the normal
fast `test:sidecar` tier (no model, no GPU), so the gate LOGIC always has cheap
paired coverage even though the real-model golden tests are opt-in.

Audio contract (mirrors server/src/tts/pcm.ts): raw 16-bit signed little-endian
MONO PCM. duration = sample_count / sample_rate; sample_count = len(pcm) // 2.

The harness asserts on duration / sample-count within a tolerance (portable
across machines) rather than a raw content hash (Kokoro is ONNX-deterministic in
LENGTH on the same weights, but sample VALUES drift across GPU/driver/hardware,
so a byte hash would flake — see docs/features/<N>-golden-audio-regression.md).
"""
from __future__ import annotations

import array
import math
from typing import Optional

BYTES_PER_SAMPLE = 2  # 16-bit
INT16_FULL_SCALE = 32768.0


def measure_pcm(pcm: bytes, sample_rate: int) -> dict:
    """Sample count + duration of a raw 16-bit mono PCM buffer."""
    sample_count = len(pcm) // BYTES_PER_SAMPLE
    duration_sec = sample_count / sample_rate if sample_rate > 0 else 0.0
    return {
        "sample_rate": sample_rate,
        "sample_count": sample_count,
        "duration_sec": duration_sec,
    }


def rms(pcm: bytes) -> float:
    """Mean normalised RMS over the whole buffer, in [0, 1]. A near-zero value
    means the engine returned (near-)silence. Mirrors the dead-RMS signal in
    server/src/tts/segment-qa.ts (the full gate is Node-only)."""
    sample_count = len(pcm) // BYTES_PER_SAMPLE
    if sample_count == 0:
        return 0.0
    samples = array.array("h")
    samples.frombytes(pcm[: sample_count * BYTES_PER_SAMPLE])
    if sys_byteorder_is_big():
        samples.byteswap()  # frombytes is native-endian; PCM is LE
    sum_squares = 0.0
    for s in samples:
        n = s / INT16_FULL_SCALE
        sum_squares += n * n
    return math.sqrt(sum_squares / sample_count)


def sys_byteorder_is_big() -> bool:
    import sys

    return sys.byteorder == "big"


def _within(actual: float, expected: float, tol: float) -> bool:
    """True when `actual` is within `tol` (fractional) of `expected`. A zero
    expected only matches a zero actual."""
    if expected == 0:
        return actual == 0
    return abs(actual - expected) / abs(expected) <= tol


def compare_to_baseline(measured: dict, baseline: dict, tol: float = 0.02) -> list[str]:
    """Return a list of human-readable mismatches between a freshly measured
    sample and its committed baseline. Empty list == pass.

    - sample_rate must match EXACTLY (a rate change is never within tolerance).
    - sample_count (and the derived duration) must be within `tol` fractional.
    """
    reasons: list[str] = []

    m_rate = measured.get("sample_rate")
    b_rate = baseline.get("sample_rate")
    if m_rate != b_rate:
        reasons.append(f"sample_rate {m_rate} != baseline {b_rate}")

    m_count = float(measured.get("sample_count", 0))
    b_count = float(baseline.get("sample_count", 0))
    if not _within(m_count, b_count, tol):
        pct = (abs(m_count - b_count) / b_count * 100) if b_count else float("inf")
        reasons.append(
            f"sample_count {int(m_count)} vs baseline {int(b_count)} "
            f"({pct:.1f}% off, tol {tol * 100:.0f}%)"
        )

    return reasons


def model_sha256(path: str) -> Optional[str]:
    """SHA-256 of a model weight file, or None if absent. Recorded in the
    baseline metadata so an intentional weights bump is legible (a mismatch
    explains 'you upgraded the model')."""
    import hashlib
    import os

    if not os.path.isfile(path):
        return None
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()
