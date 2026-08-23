# Fold step for #2623 — ORT marker rows into the register and live view (Castwright#2625)

Sole writer of the register and live view for the three ORT run children of
this branch:

- Castwright#2621 — `docs/testing/onbox-wave5-results/step-ort-a-a37-a38.md`
  (A36 "fresh NVIDIA bootstrap" and A37 "in-app Qwen3 install", by title —
  the brief's stale "A37/A38")
- Castwright#2620 — `docs/testing/onbox-wave5-results/step-ort-b-a39.md`
  (A38 "refuses — not repairs — a clobbered venv" by title, the brief's
  stale "A39")
- Castwright#2619 — `docs/testing/onbox-wave5-results/step-ort-c-a40.md`
  (A39 "in-app upgrade path on a real installed release" by title, the
  brief's stale "A40")

## Verdicts taken as input, unchanged

| Row (by title) | Id at claim time | Verdict from run child |
|---|---|---|
| ORT marker — fresh NVIDIA bootstrap | A36 | STILL OWED — new, distinct root cause found (inside `kokoro-onnx`'s own provider auto-detect, not `install-ort.mjs`) |
| ORT marker — the reported bug: in-app Qwen3 install | A37 | STILL OWED — blocked by box-wide sidecar port contention (not attempted, not failed) |
| ORT marker refuses — not repairs — a clobbered venv | A38 | **DISCHARGED** — refuse-and-log branch fires exactly as designed against a real copy of the live sidecar venv; provably touches nothing on disk |
| The in-app upgrade path applies the marker on a real installed release | A39 | STILL OWED — BLOCKED, no packaged release directory exists on this box |

No verdict was re-derived or second-guessed; each run child's own evidence
file is the source of truth for its row.

## What changed

1. **A38 (clobbered venv) removed entirely** from
   `docs/testing/onbox-acceptance-register.md`, per the owner's
   remove-outright-on-discharge ruling. No outcome note left in its place.
2. **A36, A37, and the new A38** (in-app upgrade path, renumbered from A39)
   each got a dated 2026-08-23 note recording what was attempted and what
   stopped it (root cause for A36, port contention for A37, no release
   directory for the addition row).
3. **Group A renumbered contiguously**: old A39 → A38, A40 → A39, A41 → A40,
   A42 → A41, A43 → A42, A44 → A43. Matched every row by title before
   renumbering, per the branch's standing "match by identity, not by number"
   rule. Two prose cross-references updated: the E-04 note's "register row
   A40" → "A39" (the Russian-XTTS row), and the E7 note's "A32/A42" →
   "A32/A41" (the respawn-budget row).
4. **Totals re-derived by counting `###` headings per `##` group** (not by
   subtraction): Group A now 43 (was 44); the owed total (sum of Groups
   A/B/C/D/E/G/H, excluding Blocked/Unconfirmed by the register's own
   convention) is now 65 (was 66). Every other group's count was recounted
   and is unchanged (B=2, C=4, D=3, E=9, G=2, H=2, Blocked=5, Unconfirmed=2).
5. **"At a glance" table and the dated correction note** updated to match.
6. **`docs/testing/onbox-acceptance-register-live-view.html`** hand-edited
   (not regenerated): removed the A38 `<details>` block, renumbered the
   `<span class="num">` ids for the same rows, added matching dated `<div
   class="flag">` notes to A36/A37/A38(new), fixed the same two prose
   cross-references, and updated both the glance-table row and the Group A
   section header from 44 to 43 rows, and the top summary strip's "Owed" stat
   from 66 to 65.
7. **`docs/testing/ort-marker-onbox-acceptance.md`** (the run sheet) updated:
   the criterion↔row mapping table, a new §8.6 recording the discharge, §9.3's
   "Result" filled in (previously templated `_(fill in)_`), and the §10
   disposition summary, for all four rows this fold covers.

## Not touched

A40 (now an unrelated Russian-XTTS row, #2026) — confirmed by title before
starting and left alone. No source file was edited. No release was cut.

## Verification

```
$ npm run check:onbox-register
check:onbox-register: OK — docs/testing/onbox-acceptance-register.md and docs/testing/onbox-acceptance-register-live-view.html agree.
```

## Live view — not published

Per the issue's own instructions, the live view file was edited but **not**
published to the canonical artifact URL. Publishing is a manual operator step
after merge.

## Finding carried forward, not fixed (per the issue's own instruction)

A36/A37's evidence establishes that PR #2617's cuDNN/preload fix is **not
sufficient** to reach a working `CUDAExecutionProvider` for Kokoro on this
box, even once the `[cuda]` extras are added: `kokoro-onnx==0.5.0`'s own
`Kokoro.__init__` auto-detects via `importlib.util.find_spec("onnxruntime-gpu")`,
which is always `None` (the pip distribution installs into the `onnxruntime`
import namespace, not a separately-importable module), so it always
constructs with `providers=["CPUExecutionProvider"]` explicitly — CUDA is
never even offered to onnxruntime. This is a third, distinct root cause from
both #2534 and #2600, inside `kokoro-onnx`'s own package, not
`install-ort.mjs` or `preload_dlls()`. Per the fold brief's "Not in scope,"
this is reported here as a finding, not fixed.

Run by: claude (Castwright#2625).
Date: 2026-08-23.
