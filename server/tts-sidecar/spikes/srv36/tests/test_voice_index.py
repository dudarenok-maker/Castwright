import json
from pathlib import Path
from spikes.srv36.voice_index import iter_series_books, resolve_voice_uuid

def _mk(tmp, author, series, book, segs, cast):
    d = tmp / author / series / book / "audio"; d.mkdir(parents=True)
    (d / f"{book}.segments.json").write_text(json.dumps(segs), "utf-8")
    (tmp / author / series / book / "cast.json").write_text(json.dumps(cast), "utf-8")

def test_iter_series_books_discovers_rendered_books(tmp_path):
    _mk(tmp_path, "shannon-messenger", "keeper", "book1",
        {"segments": [{"characterId": "sophie", "sentenceIds": [1]}]},
        {"characters": [{"id": "sophie", "voice": {"voiceUuid": "u-soph"}}]})
    books = list(iter_series_books(str(tmp_path)))
    assert len(books) == 1 and books[0]["series"] == "keeper" and books[0]["slug"] == "book1"
    assert Path(books[0]["segments_path"]).exists() and Path(books[0]["cast_path"]).exists()

def test_resolve_voice_uuid_joins_character_to_cast():
    cast = {"characters": [{"id": "sophie", "voice": {"voiceUuid": "u-soph", "voiceId": "sophie"}}]}
    assert resolve_voice_uuid("sophie", cast) == "u-soph"

def test_resolve_voice_uuid_falls_back_to_voiceid():
    cast = {"characters": [{"id": "keefe", "voice": {"voiceId": "keefe"}}]}  # legacy, no uuid
    assert resolve_voice_uuid("keefe", cast) == "keefe"
