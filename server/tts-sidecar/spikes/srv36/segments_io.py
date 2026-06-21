"""Pure readers for the real <slug>.segments.json + PCM slicing."""
from __future__ import annotations
import json


def load_segments(path: str) -> list:
    data = json.loads(open(path, encoding="utf-8").read())
    out = []
    for s in data.get("segments", []):
        out.append({
            "character": s.get("characterId") or s.get("character") or "?",
            "start_sec": float(s.get("startSec", 0.0)),
            "end_sec": float(s.get("endSec", 0.0)),
            "asr": s.get("asr") or {},
            "qa": s.get("qa") or {},
            "suspect": bool(s.get("suspect", False)),
        })
    return out


def seg_key(seg: dict) -> str:
    return f"{seg['character']}:{seg['start_sec']:.3f}-{seg['end_sec']:.3f}"


def slice_pcm(pcm: bytes, sr: int, start_sec: float, end_sec: float) -> bytes:
    s = int(start_sec * sr) * 2
    e = int(end_sec * sr) * 2
    return pcm[s:e]
