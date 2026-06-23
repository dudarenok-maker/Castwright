"""Regression: the sidecar must parse JSON request bodies that carry 3-byte
typographic characters delivered as single-byte Windows ANSI (cp1252), not just
strict multi-byte UTF-8.

The bug: a client that sends an em-dash (U+2014), smart-quote (U+201C/U+201D),
apostrophe (U+2019) or ellipsis (U+2026) as the cp1252 byte 0x97 / 0x93 / 0x94 /
0x92 / 0x85 (instead of the proper UTF-8 sequence) made `json.loads(bytes)` raise
UnicodeDecodeError ("invalid start byte"), which the routes swallowed into a
generic 400 `{"detail":"Body must be JSON."}`. That broke live emotion-variant
minting (/qwen/mint-variant), the re-mint migration, and any /synthesize body
carrying smart quotes / em-dashes. See `_read_json_body` in main.py.

These tests fail pre-fix (400 "Body must be JSON.") and pass post-fix: the body
parses and the request reaches the route's own validation/engine logic, which
returns a DIFFERENT status (409 "base voice not designed" for the missing voice)
— anything except the parse-stage 400.
"""
from __future__ import annotations

import sys
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

SIDECAR_ROOT = Path(__file__).resolve().parent.parent
if str(SIDECAR_ROOT) not in sys.path:
    sys.path.insert(0, str(SIDECAR_ROOT))

import main  # noqa: E402

PARSE_FAILED_DETAIL = "Body must be JSON."


@pytest.fixture()
def client() -> TestClient:
    return TestClient(main.app)


def _mint_body(emotion_bytes: bytes) -> bytes:
    """A /qwen/mint-variant body whose emotionInstruct contains `emotion_bytes`
    raw (so we control the exact wire encoding). The base voice intentionally
    does not exist, so a SUCCESSFUL parse lands on the route's 409
    'not designed' branch — never the parse-stage 400."""
    return (
        b'{"baseVoiceId":"__nope__","variantVoiceId":"__nope2__",'
        b'"emotionInstruct":"angry ' + emotion_bytes + b' edge"}'
    )


def _post_mint(client: TestClient, body: bytes):
    return client.post(
        "/qwen/mint-variant",
        content=body,
        headers={"Content-Type": "application/json"},
    )


def _assert_parsed(resp) -> None:
    """The body parsed iff we did NOT get the parse-stage 400."""
    is_parse_400 = (
        resp.status_code == 400
        and resp.headers.get("content-type", "").startswith("application/json")
        and resp.json().get("detail") == PARSE_FAILED_DETAIL
    )
    assert not is_parse_400, (
        f"body failed to parse (status {resp.status_code}, "
        f"detail {resp.json().get('detail') if resp.headers.get('content-type','').startswith('application/json') else resp.text!r})"
    )


@pytest.mark.parametrize(
    "label, emotion_bytes",
    [
        ("utf8 em-dash (U+2014)", b"\xe2\x80\x94"),
        ("cp1252 em-dash (0x97)", b"\x97"),
        ("cp1252 en-dash (0x96)", b"\x96"),
    ],
)
def test_dash_bodies_parse(client: TestClient, label: str, emotion_bytes: bytes) -> None:
    _assert_parsed(_post_mint(client, _mint_body(emotion_bytes)))


def test_cp1252_smart_quotes_apostrophe_ellipsis_parse(client: TestClient) -> None:
    # don't  “stop” …  → apostrophe 0x92, smart quotes 0x93/0x94, ellipsis 0x85
    body = (
        b'{"baseVoiceId":"__nope__","variantVoiceId":"__nope2__",'
        b'"emotionInstruct":"don\x92t \x93stop\x94\x85"}'
    )
    _assert_parsed(_post_mint(client, body))


def test_genuinely_malformed_json_still_400(client: TestClient) -> None:
    """A real syntax error must still surface as the parse-stage 400 — the
    cp1252 fallback only rescues an encoding mismatch, never bad JSON."""
    resp = _post_mint(client, b"{not valid json}")
    assert resp.status_code == 400
    assert resp.json().get("detail") == PARSE_FAILED_DETAIL


def test_read_json_body_helper_recovers_cp1252() -> None:
    """Unit-level pin on the shared helper, independent of the HTTP layer."""
    import asyncio

    class _FakeReq:
        def __init__(self, raw: bytes) -> None:
            self._raw = raw

        async def body(self) -> bytes:
            return self._raw

    async def parse(raw: bytes):
        return await main._read_json_body(_FakeReq(raw))

    # UTF-8 and cp1252 em-dash both round-trip to the same em-dash string.
    assert asyncio.run(parse(b'{"x":"a \xe2\x80\x94 b"}'))["x"] == "a — b"
    assert asyncio.run(parse(b'{"x":"a \x97 b"}'))["x"] == "a — b"
    # cp1252 typographic set recovers to the intended Unicode characters.
    assert asyncio.run(parse(b'{"x":"\x93hi\x94"}'))["x"] == "“hi”"
    assert asyncio.run(parse(b'{"x":"don\x92t"}'))["x"] == "don’t"
    assert asyncio.run(parse(b'{"x":"wait\x85"}'))["x"] == "wait…"
    # Genuinely malformed still raises.
    with pytest.raises(ValueError):
        asyncio.run(parse(b"{nope}"))
