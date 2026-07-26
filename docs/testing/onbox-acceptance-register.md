# On-box acceptance register

Shipped behaviour that can only be proven on real hardware — a live GPU, a real
sidecar, a real analyzer, a real book — and that was **not** proven at PR time.

A row here is a debt: the code is merged and users have it, but nobody has
watched it work. Empty register = done.

This exists because complex work routinely cannot be accepted inside its own PR.
The box is often contended, an acceptance run can take hours, and a PR should not
sit open waiting for one. **Owed acceptance never blocks a merge — it converts
into a row here.** What is not acceptable is the debt evaporating silently, which
is exactly what happened before this file existed.

The governing rule lives in [`CLAUDE.md`](../../CLAUDE.md) under "Testing
discipline" and as a Before-shipping checklist step. In short:

- **Add a row** in the same PR that ships the unverified behaviour. Not later.
- **Remove a row** only when one of two things has actually happened:
  1. the acceptance was **run on the box** and the result recorded, or
  2. **the repo owner explicitly confirms** it was exercised on a live book or
     books during normal use.
- Either way, record *what was observed*, by whom, and when — in the plan's Ship
  notes, the run sheet, or the issue. "Tests pass, so it's presumably fine" is
  never a reason to remove a row.

Rows are grouped by **hardware prerequisite**, not by feature, because the point
is to batch: one uncontested session should discharge everything that shares a
setup rather than repeatedly loading and evicting models.

---

## Index

| # | Item | Group | Source of criteria | Added |
|---|---|---|---|---|
| 1 | fs-38 Wave 3 — voice cloning (3a + 3b1 + 3b2), 51 tests | A | `docs/testing/fs38-wave3-onbox-acceptance.md` | 2026-07-27 |
| 2 | Capacity-aware GPU placement — 9-step walkthrough | A | `docs/features/264-vram-aware-gpu-placement.md:129-179` | 2026-07-27 |
| 3 | srv-57 Multi-GPU Wave 2 — 10-item checklist | A | [#1230](https://github.com/dudarenok-maker/Castwright/issues/1230) | 2026-07-27 |
| 4 | Audition engine + tier fidelity | A | [#1849](https://github.com/dudarenok-maker/Castwright/pull/1849) test plan | 2026-07-27 |
| 5 | Analysing view honesty for local analyzers — 6 steps | B | `docs/features/216-analysing-local-analyzer-honesty.md:124-142` | 2026-07-27 |
| 6 | Per-model analyzer keep-alive — 7 steps | B | `docs/features/263-per-model-keepalive.md:242-295` | 2026-07-27 |
| 7 | Manuscript scene separator — Russian re-run | C | `docs/features/261-manuscript-scene-separator.md:203-206` | 2026-07-27 |
| 8 | Cloud request sizing + local input-fraction calibration | C | [#1685](https://github.com/dudarenok-maker/Castwright/issues/1685) | 2026-07-27 |
| 9 | Non-English ASR content-QA calibration (`maxWer`) | D | [#1527](https://github.com/dudarenok-maker/Castwright/issues/1527), [#1084](https://github.com/dudarenok-maker/Castwright/issues/1084) | 2026-07-27 |
| 10 | ops-16 Pinokio installer — open verifications | E | [#822](https://github.com/dudarenok-maker/Castwright/issues/822) | 2026-07-27 |
| 11 | fe-39 touch press-feedback — DevTools smoke-check | E | [#1795](https://github.com/dudarenok-maker/Castwright/pull/1795) body | 2026-07-27 |

---

## Group A — the dual-GPU box, GPU-exclusive

Shared setup: the 2-card box (`cuda:0` RTX 4070 8 GB, `cuda:1` RTX 5070 Ti 16 GB
over OcuLink), `SEG_CAPACITY_ADMISSION=1`, Qwen weights resident.

The eGPU is **not hot-pluggable** — attaching or removing it needs a reboot. So
do all 2-card work in one sitting and all 8-GB-alone work in another, rather than
interleaving them.

### 1. fs-38 Wave 3 — voice cloning

The run sheet at `docs/testing/fs38-wave3-onbox-acceptance.md` is complete and
**entirely unexecuted** — every `Result:` line still reads `☐ P ☐ F ☐ B ☐ N/A`,
and §7.1's tables are blank. PR #1837 shipped the template, not results.

51 tests across 3a ingest/consent, 3b1 first Qwen clone, 3b2 resolver/lifecycle,
plus 4 cross-cutting. The starred ones carry the most risk: revoke-mid-derive
leaving no live `.pt` (C-01), a transient failure not bricking a voice (C-08),
revoke doing total erasure including the original recording (C-10), designed-voice
self-heal preserving persona (C-17).

Also needs: Whisper weights present (ingest calls `/transcribe` unconditionally),
ECAPA `/embed` reachable, `voices.library.enabled=true`, the Coalfall fixture
analysed with ≥2 speaking characters per chapter, and the 9 prepared audio
fixtures in §4.

C-08 and C-12 deliberately kill the sidecar mid-write — run those with nothing
else in flight. D-01 deliberately runs two concurrent book renders sharing one
cloned voice.

Plans: `docs/features/267-fs38-wave3-voice-clone.md`,
`docs/features/268-fs38-wave3b2-resolver.md` — both `status: active`, Ship notes
empty, pending this run.

### 2. Capacity-aware GPU placement

Nine steps in `docs/features/264-vram-aware-gpu-placement.md:129-179`. The plan
header says admission is already default-on but the plan "stays `active` (not yet
archivable) pending on-box acceptance" — so the flag shipped ahead of its proof.

Step 9 is the one explicitly named still-owed: 2-card boot, concurrent
`design_voice` + `mint_variant` landing on *different* cards with no cross-card
clobber. It is 2-card-only; a single-card run never exercises it.

Step 3 (eGPU fault-drop) **cannot be forced safely** — yanking an OcuLink cable is
a hard crash. Mark it Blocked/N-A unless it happens on its own.

### 3. srv-57 Multi-GPU Wave 2

Ten unchecked items in [#1230](https://github.com/dudarenok-maker/Castwright/issues/1230):
real per-card UUIDs from torch, a starved card self-exiting with code 43 and
`/health` showing the breach first, `QWEN_DEVICE`/`KOKORO_DEVICE` on different
cards running concurrently, same-card pinning still blocking, and forcing three
code-43 exits in ten minutes twice — once card-specific (trips the streak guard),
once not (takes the manual-investigation path).

Task 16/16.5 (auto-revert on a repeated bad GPU pin) is designed but **unbuilt**,
gated on item 1 passing — it consumes the `tripEvent()` that item 1 exercises.

### 4. Audition engine + tier fidelity

Shipped in [#1849](https://github.com/dudarenok-maker/Castwright/pull/1849)
(closes #1812, #1839, #1841, #1842). Verified by tests and CI; never heard.

- A character overridden to **Kokoro** in a **Coqui** book previews in Kokoro.
- A preview on a book set to **1.7B** renders at 1.7B, not 0.6B.
- Design a voice in **My voices**, then Play it — the first play is instant, with
  no second synthesis. This is the design/play cache pairing that was made real;
  before, the two sides hashed different filenames.
- Force a capacity failure with **Coqui resident** — the error names Coqui and
  tells the user where its Stop button is, rather than saying only "free VRAM".

Needs Kokoro, Coqui and both Qwen tiers available, and enough VRAM pressure to
provoke a genuine capacity refusal.

---

## Group B — local Ollama analyzer only, no TTS sidecar

Both items want a real Ollama daemon and a long (~110k-char) chapter. Neither
needs a TTS engine resident.

Both also have a **CPU-only sub-case** — plan 216 step 5 (first-chapter ETA seeds
slow rather than assuming GPU speed) and plan 263 step 7 (a `RAM_HEAVY_MODELS`
clamp overriding a configured keep-alive). These are the only checks in the whole
register that want the analyzer *off* the GPU. Run them together.

### 5. Analysing view honesty for local analyzers

Six steps in `docs/features/216-analysing-local-analyzer-honesty.md:124-142`,
including a per-phase Gemini recitation-block falling back to local Qwen with the
chip, swap, ticker and log all agreeing; a realistic per-chapter ETA that tightens
within ~10s of streaming; and `LiveChapterTicker` rendering every in-flight
chapter at Ollama concurrency K=4.

### 6. Per-model analyzer keep-alive

Seven steps in `docs/features/263-per-model-keepalive.md:242-295`, driven from the
Model Manager with `ollama ps` open in a second terminal. The regression worth
confirming is step 4: with keep-alive set to `0`, the model stays pinned during a
run, but a manual Load pill outside a run still warms with a 30s floor rather than
appearing to do nothing.

---

## Group C — one *Ночной дозор* re-analysis session

Items 7 and 8 both re-analyze the **same manuscript** for different reasons. One
local pass plus one cloud pass, captured with both scene-break output and
truncation/429 telemetry in mind, discharges both. No TTS or GPU synthesis needed.

Book: `C:\AudiobookWorkspace\books\Сергей Лукьяненко\The Night Watch Tetralogy\Ночной дозор`.

### 7. Manuscript scene separator — Russian re-run

Plan 261 could not measure this book in its original round: it was mid-re-analysis
and its `manuscript-edits.json` was deleted by the reparse
(`docs/features/261-manuscript-scene-separator.md:203-206`). The marker-anchored
rule change is claimed to mechanically eliminate the old ~92k-character
forward-overshoot; that claim is what the re-run confirms. Failure here is always
cosmetic — a divider off by a sentence, never data corruption.

### 8. Cloud request sizing + local input-fraction calibration

[#1685](https://github.com/dudarenok-maker/Castwright/issues/1685), three unchecked
items. Needs a free-tier `GEMINI_API_KEY`. Re-analyze end-to-end on
`gemma-4-31b-it` **including the script-review pass** — that is the pass that
actually 429'd in the original incident (all 22 logged failures were
`task: script-review`) — and confirm a per-minute 429 is retried rather than
misclassified as daily-quota. Then calibrate `analyzer.stage2.localInputFraction`
(ships at 0.3) downward until a full local re-analysis completes with **zero**
stage-2 truncation drops, and record the working value.

---

## Group D — multi-language TTS render + ASR calibration

### 9. Non-English ASR content-QA calibration

[#1527](https://github.com/dudarenok-maker/Castwright/issues/1527) /
[#1084](https://github.com/dudarenok-maker/Castwright/issues/1084). Render real
audio in es/ru (then fr/de), run the ASR content-QA gate against it, inspect the
WER distribution per language, and set `qa.asr.maxWer.{es,fr,de,ru}` from the
observed data — they currently all inherit the English-tuned `0.4` default.

Two named residual risks to validate specifically: gendered-number mismatch rate
(es/fr/ru "one", ru "two"), and Russian oblique-case declension mismatches. Also
whether Whisper's German output matches the single-fused-token assumption for
compound numbers.

Needs Whisper resident and the fs-61 per-language Coalfall demo books —
**confirm those are voice-designed first**; that prerequisite is itself
unverified (see Unconfirmed below). Largely an unattended batch: render, then
inspect the distribution afterwards.

---

## Group E — not the GPU box

### 10. ops-16 Pinokio installer — open verifications

The 6-item acceptance matrix in
[#822](https://github.com/dudarenok-maker/Castwright/issues/822) is **already
all checked** — the install/start/wizard/update/stop/reset lifecycle passed. What
remains is the "Open verifications" list: whether `start.js`'s foreground launch
picks up `server/.env`/`WORKSPACE_DIR` and native Stop reaps the sidecar
(flagged highest-risk), whether Pinokio's bundled Node is ≥20.19, whether
`python -m venv` works from a conda interpreter on all three OSes, and the exact
Pinokio API spelling.

Needs clean Windows **and** macOS machines with Pinokio — a different hardware
axis entirely. Budget 20–40 min per OS just for install (conda provision +
`npm ci` + ~2.5 GB torch) before the rest.

### 11. fe-39 touch press-feedback — DevTools smoke-check

[#1795](https://github.com/dudarenok-maker/Castwright/pull/1795)'s own body: the
behavioural touch-flash is confirmed by construction but not by an automated test
(jsdom cannot compile the variant), and a one-time manual DevTools
touch-emulation check is the spec's accepted behavioural proof.

Four controls: the continue-listening play badge, the "Add book" tile, the wizard
"Review ›" chip, the voice-library drag icon. Minutes, any machine, any time.

---

## Blocked — hardware not available

### AMD GPU support Phase 2

[#1335](https://github.com/dudarenok-maker/Castwright/issues/1335). Waves A–G
were built and merged **dormant** — the code path exists but has never run against
real ROCm hardware. This is a dormant capability, not an active bug.

This dev box is dual-NVIDIA. Genuinely cannot be batched with anything here, and
will not move until AMD/ROCm hardware exists to run it on.

---

## Unconfirmed — looked owed, evidence insufficient

Kept separate on purpose: these are not debts until someone substantiates them.

- **fs-61 per-language Coalfall demo books** — five EPUBs are believed to exist,
  but whether they are already voice-designed was not verified. Item 9 depends on
  this being true.
- **fs-38 Wave 1** (designed-voice authoring, PR #1800) — no explicit owed callout
  in `docs/features/194-voice-cloning.md` beyond a generic "Live-GPU acceptance"
  line that is not marked outstanding the way 267/268/264/216/263 are. Probably
  exercised informally through ordinary Qwen-design use; not confirmed.
- **Ollama concurrency (K>1) real-VRAM validation** — PR #1707 already fixed a
  case where K never took effect, and ships `peak==K` telemetry so a future run
  self-verifies. Plan 216 step 6 covers the UI half (item 5 above). If a separate
  `n_slots=1` physics check is owed, its written acceptance criteria were not
  found in this repo — do not double-count it.

---

## Deliberately not in this register

- **[#1826](https://github.com/dudarenok-maker/Castwright/issues/1826)** (serialize
  voice-library entry writes) — its acceptance bar is an automated interleaving
  regression test, not a manual walkthrough.
- **[#964](https://github.com/dudarenok-maker/Castwright/issues/964)** (fs-48 Fish
  Audio) — parked and unbuilt. Pre-implementation criteria for a feature that does
  not exist, not debt on shipped code.
- **[#819](https://github.com/dudarenok-maker/Castwright/issues/819)** (side-16,
  Kokoro on DirectML) — labelled `moscow:wont`. Surfaced by keyword search; not
  acceptance debt.

This register is for **manual, hardware-dependent verification of shipped code**.
Automated-test gaps belong in the plan's test section or an issue.
