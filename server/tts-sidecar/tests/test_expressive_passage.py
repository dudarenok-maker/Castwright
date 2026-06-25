"""Shape guard for the #1098 expressive-prose A/B fixture
(tests/golden/expressive_passage.json).

The fixture itself is rendered on the box in Phase 2; this weight-free test just
keeps it well-formed so it can't silently rot — every sentence carries the four
fields the A/B runner reads, emotions are real Emotion-enum values, and the whole
five-emotion spread is present (the entire point of the fixture is a MIXED batch,
so a passage that lost an emotion would defeat it)."""
from __future__ import annotations

import json
from pathlib import Path

# The five Emotion-enum values (openapi Sentence.emotion). neutral is the default.
VALID_EMOTIONS = {"neutral", "whisper", "angry", "excited", "sad"}
# The expressive emotions the A/B must exercise (neutral alone wouldn't be a test).
EXPRESSIVE_EMOTIONS = VALID_EMOTIONS - {"neutral"}

FIXTURE = Path(__file__).resolve().parent / "golden" / "expressive_passage.json"


def _load() -> dict:
    return json.loads(FIXTURE.read_text(encoding="utf-8"))


def test_fixture_exists_and_parses() -> None:
    data = _load()
    assert isinstance(data.get("sentences"), list) and data["sentences"], "non-empty sentences[]"


def test_every_sentence_has_the_four_ab_fields() -> None:
    for s in _load()["sentences"]:
        assert isinstance(s.get("id"), int), f"id must be int: {s!r}"
        assert isinstance(s.get("text"), str) and s["text"].strip(), f"text required: {s!r}"
        assert s.get("emotion") in VALID_EMOTIONS, f"bad emotion: {s!r}"
        # The rich instruct (A/B option c) must be present and non-trivial.
        assert isinstance(s.get("instruct"), str) and len(s["instruct"]) >= 8, f"instruct required: {s!r}"


def test_ids_are_unique() -> None:
    ids = [s["id"] for s in _load()["sentences"]]
    assert len(ids) == len(set(ids)), f"duplicate sentence ids: {ids}"


def test_covers_the_full_emotion_spread() -> None:
    """A MIXED batch is the whole point — every expressive emotion must appear."""
    seen = {s["emotion"] for s in _load()["sentences"]}
    missing = EXPRESSIVE_EMOTIONS - seen
    assert not missing, f"fixture is missing expressive emotion(s): {sorted(missing)}"
    assert "neutral" in seen, "fixture should include neutral narration beats for contrast"


def test_consecutive_emotion_transitions_exist() -> None:
    """Listening for FLOW needs transitions — assert the passage isn't grouped by
    emotion (which would read as five blocks, not a scene)."""
    emotions = [s["emotion"] for s in _load()["sentences"]]
    transitions = sum(1 for a, b in zip(emotions, emotions[1:]) if a != b)
    assert transitions >= 6, f"too few emotion transitions for a flowing scene: {transitions}"
