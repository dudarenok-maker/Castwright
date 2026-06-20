"""fs-1 — TTS sidecar app version.

Rewritten in lockstep with the root + server package.json files by
scripts/bump-version.mjs at release time. Surfaced in /health and read by the
Node server's GET /api/info (next to the server appVersion). Distinct from
SIDECAR_PROTOCOL_VERSION in main.py: the protocol version gates adopt/replace of
a running sidecar, while __version__ is purely informational.
"""

__version__ = "1.9.0"
