"""On-box driver for the Phase-2 cross-book spike. Operator-run."""
from __future__ import annotations
import json, sys
from pathlib import Path
from spikes.srv36.voice_index import iter_series_books, resolve_voice_uuid

def build_inventory(books_root: str) -> dict:
    series = {}
    for s in iter_series_books(books_root):
        cast = json.loads(Path(s["cast_path"]).read_text("utf-8")) if Path(s["cast_path"]).exists() else {}
        sv = series.setdefault(s["series"], {"name": s["series"], "books": [], "keys": {}})
        sv["books"].append({"bookId": s["bookId"], "slug": s["slug"]})
        segs = json.loads(Path(s["segments_path"]).read_text("utf-8")).get("segments", [])
        for seg in segs:
            cid = seg.get("characterId")
            if not cid:
                continue
            # storageKey is NOT persisted (segments-io.ts:54); resolve voiceUuid via cast.json join
            vu = resolve_voice_uuid(cid, cast)
            kind = "voiceUuid" if cast and (next((c for c in cast.get("characters", [])
                    if c.get("id") == cid and (c.get("voice") or {}).get("voiceUuid")), None)) else "voiceId"
            rec = sv["keys"].setdefault(vu, {"key": vu, "character_id": cid, "key_kind": kind, "recurs_in_books": set()})
            rec["recurs_in_books"].add(s["bookId"])
    out = {"series": []}
    for sv in series.values():
        keys = [{**k, "recurs_in_books": sorted(k["recurs_in_books"])} for k in sv["keys"].values()]
        out["series"].append({"name": sv["name"], "books": sv["books"], "keys": keys})
    return out

if __name__ == "__main__":
    inv = build_inventory(sys.argv[1])
    Path("spikes/srv36/results/crossbook_inventory.json").write_text(json.dumps(inv, indent=2), "utf-8")
    for s in inv["series"]:
        multi = [k for k in s["keys"] if len(k["recurs_in_books"]) >= 2]
        print(f"{s['name']}: {len(s['books'])} books, {len(multi)} voiceUuid keys recurring in >=2 books "
              f"(kinds: {sorted({k['key_kind'] for k in multi})})")
