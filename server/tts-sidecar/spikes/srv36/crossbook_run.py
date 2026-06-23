"""On-box driver for the Phase-2 cross-book spike. Operator-run."""
from __future__ import annotations
import json, sys
from pathlib import Path
from spikes.srv36.voice_index import iter_series_books, resolve_voice_uuid
from spikes.srv36.crossbook import assemble_measured, evaluate_axes, malformed_gates

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
    if len(sys.argv) > 1 and sys.argv[1] == "--report":
        # Load per-gate spike results and thresholds, compute per-axis go/no-go verdicts
        per_gate = {}
        results_dir = Path("spikes/srv36/results")
        for gate_name in ["g1", "g2", "g3", "g4", "g5", "g6"]:
            result_file = results_dir / f"crossbook_{gate_name}.json"
            if result_file.exists():
                per_gate[gate_name] = json.loads(result_file.read_text("utf-8-sig"))

        thresholds_file = Path("spikes/srv36/crossbook_thresholds.json")
        if not thresholds_file.exists():
            print("ERROR: spikes/srv36/crossbook_thresholds.json not found", file=sys.stderr)
            sys.exit(1)
        thresholds = json.loads(thresholds_file.read_text("utf-8-sig"))

        bad = malformed_gates(per_gate)
        if bad:
            print(
                f"WARNING: result file(s) present but missing expected keys — verdict may be wrong: "
                + ", ".join(bad),
                file=sys.stderr,
            )

        measured = assemble_measured(per_gate)
        verdict = evaluate_axes(measured, thresholds)
        print(json.dumps(verdict, indent=2))
    elif len(sys.argv) > 2 and sys.argv[2] == "--counts":
        # GPU-free sizing: python -m spikes.srv36.crossbook_run <BOOKS_ROOT> --counts [series] [target]
        # Counts clean >=3s dialogue segments per recurring voiceUuid per book so
        # you can decide whether the re-render has enough lines for stable centroids.
        from spikes.srv36 import crossbook_measure as m
        books_root = sys.argv[1]
        series = sys.argv[3] if len(sys.argv) > 3 and not sys.argv[3].isdigit() else None
        target = next((int(a) for a in sys.argv[3:] if a.isdigit()), 20)
        counts = m.count_clean_segments(books_root, series)
        recurring = {vu: r for vu, r in counts.items() if len(r["by_book"]) >= 2}
        print(f"{len(recurring)} voiceUuid key(s) recur in >=2 books "
              f"(target >={target} clean >=3s segments per book for a stable centroid):")
        for vu, r in sorted(recurring.items(), key=lambda kv: min(kv[1]["by_book"].values())):
            worst = min(r["by_book"].values())
            flag = "OK  " if worst >= target else "THIN"
            books_str = "  ".join(f"{b}={n}" for b, n in sorted(r["by_book"].items()))
            print(f"  [{flag}] {r['character_id']:<22} {books_str}   ({vu})")
        thin = sorted(r["character_id"] for r in recurring.values()
                      if min(r["by_book"].values()) < target)
        if not recurring:
            print("NO recurring voiceUuid keys across >=2 books — re-render the SAME "
                  "characters in both books (carried voiceUuid via series-reuse).",
                  file=sys.stderr)
        elif thin:
            print(f"render more chapters featuring: {', '.join(thin)}", file=sys.stderr)
        else:
            print("all recurring characters meet the target — ready to run --g1..--g6.",
                  file=sys.stderr)
    elif len(sys.argv) > 2 and sys.argv[2].startswith("--g"):
        # Measurement gate: python -m spikes.srv36.crossbook_run <BOOKS_ROOT> --gN [series]
        from spikes.srv36 import crossbook_measure as m
        books_root, gate = sys.argv[1], sys.argv[2]
        series = sys.argv[3] if len(sys.argv) > 3 else None

        if gate == "--g0":
            cfg_path = m.RESULTS / "g0_keys_cfg.json"
            if not cfg_path.exists():
                print("ERROR: prepare results/g0_keys_cfg.json first — "
                      '{"<voiceUuid>": {"text": "<audition text>", "voice": "qwen-<voiceUuid>"}}. '
                      "OPERATOR: confirm the audition-text source + sidecar /synthesize contract.",
                      file=sys.stderr)
                sys.exit(1)
            keys_cfg = json.loads(cfg_path.read_text("utf-8"))
            print(json.dumps(m.run_g0(keys_cfg), indent=2, default=str))
        else:
            by_book = m.collect_series(books_root, series)
            n_books = len(by_book)
            recurring = len(m._recurring_keys(by_book))
            print(f"collected {n_books} books, {recurring} voiceUuid keys recurring >=2 books",
                  file=sys.stderr)
            if gate == "--g1":
                g0 = m.RESULTS / "crossbook_g0.json"
                floor = (json.loads(g0.read_text("utf-8")).get("floor_std_median")
                         if g0.exists() else None)
                if floor is None:  # absent file/key — NOT a legitimate zero floor (review M-1)
                    print("WARNING: no G0 floor (run --g0 first); using 1.0 placeholder — "
                          "G1 stds are NOT trustworthy until G0 runs.", file=sys.stderr)
                    floor = 1.0
                print(json.dumps(m.run_g1(by_book, floor), indent=2, default=str))
            elif gate == "--g2":
                ac = m.RESULTS / "crossbook_audition_centroids.json"
                centroids = json.loads(ac.read_text("utf-8")) if ac.exists() else {}
                if not centroids:
                    print("WARNING: no audition centroids (run --g0 first); G2 will be empty.",
                          file=sys.stderr)
                print(json.dumps(m.run_g2(by_book, centroids), indent=2, default=str))
            elif gate == "--g6":
                print(json.dumps(m.run_g6(by_book), indent=2, default=str))
            elif gate == "--g4":
                print(json.dumps(m.run_g4(by_book), indent=2, default=str))
            elif gate == "--g3":
                print(json.dumps(m.run_g3(by_book), indent=2, default=str))
            else:
                print(f"unknown gate {gate} (use --g0..--g6, or --g5 via blind_listen.py)",
                      file=sys.stderr)
                sys.exit(1)
    else:
        inv = build_inventory(sys.argv[1])
        Path("spikes/srv36/results/crossbook_inventory.json").write_text(json.dumps(inv, indent=2), "utf-8")
        for s in inv["series"]:
            multi = [k for k in s["keys"] if len(k["recurs_in_books"]) >= 2]
            print(f"{s['name']}: {len(s['books'])} books, {len(multi)} voiceUuid keys recurring in >=2 books "
                  f"(kinds: {sorted({k['key_kind'] for k in multi})})")
