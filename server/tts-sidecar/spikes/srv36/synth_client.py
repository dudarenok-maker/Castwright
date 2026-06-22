"""Sidecar /synthesize request builder + renderer (srv-36 Phase-2).

Provides a thin client to the TTS sidecar /synthesize endpoint.
- build_request: pure, returns POST body dict
- render: executes the HTTP call (operator-run, requires live sidecar)
"""
from __future__ import annotations
import json
import urllib.request
from typing import Any


def build_request(text: str, voice_cfg: str) -> dict[str, Any]:
    """Build a POST body for /synthesize.

    Parameters
    ----------
    text : str
        Text to synthesize.
    voice_cfg : str
        Voice storage key (e.g., "qwen-abc").

    Returns
    -------
    dict
        POST body: {"text": text, "engine": "qwen", "voice": voice_cfg}
    """
    return {"text": text, "engine": "qwen", "voice": voice_cfg}


def render(text: str, voice_cfg: str, sidecar_url: str = "http://localhost:9000") -> tuple[bytes, int]:
    """Render text via the sidecar /synthesize endpoint.

    Parameters
    ----------
    text : str
        Text to synthesize.
    voice_cfg : str
        Voice storage key.
    sidecar_url : str
        Base URL of the sidecar (default localhost:9000).

    Returns
    -------
    tuple[bytes, int]
        (PCM audio bytes, sample rate in Hz)

    Raises
    ------
    Exception
        If the sidecar is unreachable or returns an error.
    """
    body = build_request(text, voice_cfg)
    body_json = json.dumps(body).encode("utf-8")
    req = urllib.request.Request(
        f"{sidecar_url}/synthesize",
        data=body_json,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req) as resp:
        sample_rate = int(resp.headers.get("X-Sample-Rate", 16000))
        pcm_bytes = resp.read()
    return pcm_bytes, sample_rate
