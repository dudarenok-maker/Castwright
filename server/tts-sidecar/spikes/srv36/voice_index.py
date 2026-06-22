"""Pure file-walk + characterId->voiceUuid join for the Phase-2 cross-book spike."""
from __future__ import annotations
import json
from pathlib import Path
from typing import Iterator


def iter_series_books(books_root: str) -> Iterator[dict]:
    root = Path(books_root)
    for author_dir in sorted(p for p in root.iterdir() if p.is_dir()):
        for series_dir in sorted(p for p in author_dir.iterdir() if p.is_dir()):
            for book_dir in sorted(p for p in series_dir.iterdir() if p.is_dir()):
                audio = book_dir / "audio"
                segs = sorted(audio.glob("*.segments.json")) if audio.is_dir() else []
                if not segs:
                    continue  # not rendered
                yield {"series": series_dir.name, "bookId": book_dir.name, "slug": book_dir.name,
                       "segments_path": str(segs[0]), "cast_path": str(book_dir / "cast.json")}


def resolve_voice_uuid(character_id: str, cast: dict) -> str | None:
    for c in cast.get("characters", []):
        if c.get("id") == character_id:
            v = c.get("voice") or {}
            return v.get("voiceUuid") or v.get("voiceId") or character_id
    return None
