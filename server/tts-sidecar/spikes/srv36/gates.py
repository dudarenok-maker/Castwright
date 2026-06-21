"""Real per-segment gate labels: did the EXISTING ASR + signal-QA gates flag it?"""
from __future__ import annotations


def is_gate_flagged(seg: dict) -> bool:
    asr = (seg.get("asr") or {}).get("verdict")
    qa = (seg.get("qa") or {}).get("status")
    return asr == "drift" or bool(seg.get("suspect")) or qa == "suspect"
