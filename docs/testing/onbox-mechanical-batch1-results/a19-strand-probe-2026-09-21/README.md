# A19 strand probe — 2026-09-21 (#3302)

Harness: `a19_experiment.py` (+ `fill_foreign.py`, an external `cudaMalloc`
filler) drives a dedicated sidecar on port **9101** against four trigger
shapes and reads `vram_reserved_mb_by_device` after an explicit
`POST /unload` (strand = >= 800 MiB reserved with nothing resident).

Two complete runs this date, same outcome:

- `run1/` — 02:28:35 -> 02:40:10 (caveat: this run's `strand_read` events
  mis-parsed the nested health payload as `null`; the raw `snapshot` events
  carry the true values and are quoted in the register).
- top level — 02:42:22 -> 02:51:31, corrected reader (parsed values shown).

Rerun: `server/tts-sidecar/.venv/Scripts/python.exe a19_experiment.py all`
from this directory. Phases also selectable: `exp1`, `exp2c`, `exp2b`, `exp3`.
Verdict: no strand reproduced; `exp3` (the #1993 guard test) auto-skips
because there was no stranded pool to guard.
