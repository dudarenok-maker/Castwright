# B103 on-box evidence (2026-11-26, #4707)

Server: this worktree, port 8130, `ANALYZER_PHASE1_MIN_LAG_CHAPTERS=0`. Ollama 0.40.5, `qwen3.5:4b` digest `2a654d98e6fb`, RTX 4070 Laptop 8 GB.
Book: scratch file = Coalfall chapter one repeated 12x under distinct headings, 41,856 bytes, 7,824 words, 12 chapters; imported with `POST /api/import` + `POST /api/books` (book `castwright__standalones__b103-drain-book`, manuscript `mns_VtKg7HE7vb`).
Run: `POST /api/manuscripts/<id>/analysis {"phase0Model":"qwen3.5:4b","phase1Model":"qwen3.5:4b","fresh":true}` (pipelined; Phase 1 only begins once Phase 0 has finished ~5 min in).
Files: `a-*` = (a) Pause, `b-*` = (b) halt.
