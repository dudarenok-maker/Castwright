# B101 on-box evidence (2026-11-26, #4706)

Sides: current `chore/ops-onbox-batch-2` (main after #3349) on port 8130; base = first parent `802bab81` of PR #3349's merge commit `369b644e`, throwaway detached worktree on port 8131 with its own workspace (removed afterwards).
Book: `server/src/__fixtures__/the-coalfall-commission.md` lines 7-62 only ("Chapter One — The Knock", 3,477 bytes, one chapter) imported as a scratch book per side. Reason: in the full fixture the parser makes "Chapter 1" a 38-char title stub and the 12 k-char third chapter's 4B cast pass did not finish in 4+ min (run paused by hand).
Driver: `POST /api/manuscripts/<id>/analysis {"model":..., "fresh":true}`; `run.sh` was a throwaway curl wrapper.

Local, `qwen3.5:4b` (digest 2a654d98e6fb), Ollama 0.40.5:
| side | run | characters | attributed sentences | wall |
|---|---|---|---|---|
| current | 1 | 5 | 55 | 93 s |
| current | 2 | 5 | 55 | 92 s |
| base | 1 | 5 | 55 | 101 s |
| base | 2 | 5 | 56 | 86 s |

Files: `sse-messages-<side>-local-run<N>.txt`, `eval-stats-current.jsonl`, `eval-stats-base.jsonl` (tokens/s records, ~62-71 tok/s), Gemini failures: `gemini-generate-failed-*.txt`, `gemini-stream-timing-current.txt`, `sse-messages-*gem*.txt`.
