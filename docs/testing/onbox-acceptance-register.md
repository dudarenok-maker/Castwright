# On-box acceptance register

Shipped behaviour that can only be proven on real hardware — a live GPU, a real
sidecar, a real analyzer, a real book, a real phone — and that was **not** proven
at PR time.

A row here is a debt: the code is merged and users have it, but nobody has
watched it work. Empty register = done.

This exists because complex work routinely cannot be accepted inside its own PR.
The box is often contended, an acceptance run can take hours, and a PR should not
sit open waiting for one. **Owed acceptance never blocks a merge — it converts
into a row here.** What is not acceptable is the debt evaporating silently, which
is exactly what happened before this file existed: the sweep that produced this
register found debt going back to **2026-06-01** recorded nowhere but in plan-doc
prose.

The governing rule lives in [`CLAUDE.md`](../../CLAUDE.md) under "Testing
discipline" and as Before-shipping checklist step 3. In short:

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

> **How this register goes stale, and how to check.** Its first version was built
> by reading plan headers and issue bodies at face value, and three entries were
> wrong within a day — a prerequisite named as a blocker that was already
> satisfied, a "still draft" PR that had merged six weeks earlier, and a step
> count out of date since before the register was written. Plan prose and issue
> bodies are frequently **not updated after later work discharges them**. Before
> scheduling a session, spot-check each row against closed issues and merged PRs
> touching the same subject. A stale row is worse than a missing one: it sends
> you to run something already done.

---

## At a glance

| Group | Setup | Rows |
|---|---|---|
| **A** | The GPU box (single 8 GB for most; the 2-card boot for a few) | 18 |
| **B** | Local Ollama analyzer only, no TTS sidecar | 2 |
| **C** | One *Ночной дозор* re-analysis session | 3 |
| **D** | Multi-language TTS render + ASR | 2 |
| **E** | Not the GPU box (a phone, a Mac, a browser) | 5 |
| **F** | A real Android device, optionally + a head unit | 1 |
| — | **Blocked** (hardware absent) | 1 |
| — | **Unconfirmed** (not debts until substantiated) | 2 |

**31 owed.** Oldest: **2026-06-01** (plans 160, 161, 165).

---

## Group A — the GPU box

Most rows need only a **single GPU with Qwen resident**. A few specifically need
the **2-card boot** (8 GB RTX 4070 + 16 GB RTX 5070 Ti over OcuLink) — and the
eGPU is **not hot-pluggable**, so do all 2-card work in one sitting and all
single-card work in another rather than interleaving.

### A1 · fs-38 Wave 3 — voice cloning · **51 tests, entirely unexecuted**

The run sheet `docs/testing/fs38-wave3-onbox-acceptance.md` is complete and has
never been run — every `Result:` line still reads `☐ P ☐ F ☐ B ☐ N/A`, §7.1's
tables blank. PR #1837 shipped the template, not results.

Starred, highest-risk: **C-01** revoke mid-derive leaves no live `.pt` and
`revokedAt` survives · **C-08** a transient failure does not brick a voice ·
**C-10** revoke does total erasure including the original recording · **C-17**
designed-voice self-heal preserves persona · **C-12** a killed mid-write leaves
no truncated `.pt`.

C-08 and C-12 deliberately kill the sidecar mid-write — nothing else in flight.
D-01 deliberately runs two concurrent book renders sharing one cloned voice.

*Also needs:* Whisper weights, ECAPA `/embed`, `voices.library.enabled=true`, the
Coalfall fixture with ≥2 speaking characters/chapter, and the 9 audio fixtures in §4.
*Plans:* 267, 268 — both `status: active`, Ship notes empty. *Cost:* multi-hour.

### A2 · Capacity-aware GPU placement (plan 264) · **two distinct debts**

**The gate to `stable`/archive** is the plan header's own words (`:14-22`): the
**evict-under-contention rows 6–8** — cold-`/load` device steer, `design_voice`
evicts Ollama, GPU-ASR 503→evict→retry — were *not* force-driven on-box and
"rest on automated coverage for now." Deferred by choice, **not blocked**;
runnable on demand.

**Separately owed:** walkthrough **step 9**, the on-box confirmation of the
#1730 cross-card device-steer fix. The code merged (PR #1732, 2026-07-19) but
its confirmation never ran. The plan calls this "still owed before the
concurrent-multi-card flag flip." **2-card boot only.**

⚠️ *The plan contradicts itself* — the same paragraph lists `S6` among the items
already exercised on-box **and** item 6 among the rows not force-driven. Treat
6–8 as owed per the closing sentence, which is the more authoritative statement,
and fix the plan text while you are in there.

*Step 3* (eGPU fault-drop) is genuinely observe-only — yanking an OcuLink cable
is a hard crash. Mark Blocked/N-A unless it happens on its own.

*Criteria:* `docs/features/264-vram-aware-gpu-placement.md:129-179`, header `:9-22`.

### A3 · srv-57 Multi-GPU Wave 2 · **2-card boot**

Ten unchecked items in [#1230](https://github.com/dudarenok-maker/Castwright/issues/1230).
Real per-card UUIDs from torch · a starved card self-exits with code 43, `/health`
showing the breach first · `QWEN_DEVICE`/`KOKORO_DEVICE` on different cards run
concurrently, same-card pinning still blocks · three code-43 exits in ten minutes
**twice** — once card-specific (trips the streak guard), once not (manual-investigation
path).

Task 16/16.5 (auto-revert on a repeated bad pin) is designed but **unbuilt**, gated
on item 1 — it consumes the `tripEvent()` item 1 exercises.

### A4 · Audition engine + tier fidelity ([#1849](https://github.com/dudarenok-maker/Castwright/pull/1849))

Verified by tests and CI; never listened to.

- A character overridden to **Kokoro** in a **Coqui** book previews in Kokoro.
- A preview on a book set to **1.7B** renders at 1.7B, not 0.6B.
- Design a voice in **My voices**, then Play — first play is instant, no second
  synthesis (the design/play cache pairing that was made real; the two sides
  previously hashed different filenames).
- Force a capacity failure with **Coqui resident** — the error names Coqui and
  where its Stop button is, not just "free VRAM".

*Needs:* Kokoro, Coqui and both Qwen tiers, plus enough VRAM pressure for a real
capacity refusal. *Cost:* short.

### A5 · fs-60 XTTS per-language engine eligibility (plan 249)

Plan header: "**Live-GPU acceptance owed** (mock-mode e2e only)… This plan's
status stays `active`, not `stable`, until that walkthrough runs" (`:9,51`).

Five steps (`:53-66`): an undesigned character on a Russian book shows the
Coqui-fallback banner (not a hard block) · the engine picker offers Coqui · the
voice-readiness gate offers "Proceed anyway" · a **real render** shows a
"Fallback (Coqui)" pill · the same on a still-unsupported language (Chinese)
keeps the old hard block.

*Needs:* real sidecar, 8 GB-class GPU, a Russian book with an undesigned
character, and enough VRAM pressure to exercise Qwen/Coqui evict-and-reload.

### A6 · Bulk voice-design recycle resilience (plan 200)

Shipped direct-to-`main` **2026-06-10** (`274522d0`, closes bug #690). Ship notes:
"**Live-GPU acceptance … is the only remaining check.**"

On the 8 GB box with the sidecar started via `start-prod.bat` (so `.env` ceilings
are actually in effect): "Design full cast" over a multi-voice cast completes end
to end; then force a `/recycle` mid-run and confirm the pill rides through the
respawn rather than stalling.

*Note:* the flow gets exercised informally (bugs #1156, #1532, #1557, #1570 were
all found through real use) — but never this specific forced-recycle walkthrough.

### A7 · Design full cast — bulk Qwen voice design (plan 195)

Shipped 2026-06-07 (`7f0d5f4b`, PR #637); PR #638 filled the Ship-notes SHA but
left the acceptance bullet open (`:78-82`).

Pill survives navigation and a reload mid-run (resumes) · terminal summary counts
are right · series propagation reaches a sibling book · VRAM headroom holds across
a long run — **the exact combination that caused the plan-108 OOM** · a 2nd-tab
single design serialises correctly against a bulk run.

### A8 · GPU residency safety + coexistence (plan 222)

Five-step "USER-RUN, live GPU — OWED" walkthrough (`:54-59`). **Distinct from
B1/plan 216** — that one is the device probe, live ETA and truncation recovery;
this one is eviction and refusal behaviour. Don't conflate them.

8 GB box VRAM steady during analysis (no sawtooth) · eviction before sidecar load
at generation start · a clean **409 "GPU busy"** refusal instead of an OOM ·
eviction before voice design · and **no** eviction on a 12/16 GB box (step 5 needs
the roomier card).

*Shipped* 2026-06-16, PRs #839/#840/#841.

### A9 · Batch the QA re-record loops (plan 228)

"Acceptance (manual, on-box) — **OWED**" (`:95-100`). Regenerate a QA-flagging Qwen
chapter with the full gate stack on and confirm **RTF lands near ~1.2**, down from
~1.9.

*Never claimed done even at merge:* PR #1072's own body says "On-box RTF acceptance
(~1.2 target) to be confirmed on the next clean multi-chapter render."

### A10 · Per-character re-record / splice (plan 176)

"Manual (owed — live GPU + sidecar)" (`:50,55,59`). Still `status: active` as of a
2026-07-24 correction commit that says "Still owed: live-GPU re-record acceptance."

Rendered book → a character's profile → Fix audio → **+3 dB gain** across all
chapters: verify louder, duration unchanged, `.previous.*` written, A/B works,
chapter stays ≈ −16 LUFS. Then **re-record one chapter's lines** and verify timing
integrity — no seam, no doubled title. *Merged* 2026-06-03, PR #500.

### A11 · Structured failure taxonomy (plan 173, fs-19)

"Live multi-failure acceptance owed" (`:9,45`). Force **≥2 distinct real failure
modes** — stop the sidecar mid-run (`sidecar-unreachable`), oversubscribe VRAM
(`vram-spill`) — and confirm the friendly message plus remediation line on both
the row and the toast. *Shipped* 2026-06-03 (`affa489`, closes #469).

### A12 · Post-synthesis audio QA gate (plan 174, srv-27)

"Live acceptance owed … with a deliberately degraded render" (`:9,40`). Craft a
near-silent / clipped / truncated chapter and confirm the amber **"Suspect"** badge
appears on both the Generate and Listen rows. *Shipped* 2026-06-03 (`84a45ff`,
closes #465).

### A13 · Per-run resource telemetry + admin trend panel (plan 175, fs-20)

"Live acceptance owed … after a multi-chapter run on the GPU box" (`:9,44`).
Confirm `#/admin` → "Resource trends" shows RTF / QA / VRAM / wall-time rows and
the sparkline actually tracks RTF. *Shipped* 2026-06-03 (`ee22859`, closes #470).

### A14 · Qwen VoiceDesign persona-prompt rewrite (plan 160) · **oldest debt here**

"Code shipped, **GPU audition validation owed to the user**" (`:9`). Regenerate a
persona → Design voice → audition, and confirm the new pitch/purpose-clause wording
actually changes the rendered voice. *First landed* **2026-06-01**.

### A15 · A/B "current vs proposed" voice audition (plan 161)

"GPU audition validation owed" (`:9`). A non-destructive re-design — **Cancel must
leave the live `.pt` untouched** — plus an audible delta on approve. Directly
downstream of A14; run them together. *First landed* **2026-06-01**.

### A16 · fe-16 Qwen auto-load on a Russian book (plan 165)

Ship notes: "live GPU acceptance is the only owed item." Open a real Russian book's
cast view; confirm the Qwen banner shows and Qwen auto-loads with the analyzer
evicted.

⚠️ *Frontmatter says `status: active` while the body's own `> Status:` line says
`stable`* — worth reconciling while you are there. *Shipped* **2026-06-01**.

### A17 · Emotion-chip preview from the manuscript (plan 180, fe-31)

"Live GPU acceptance owed: the **audible** difference between a designed variant and
the base voice can only be confirmed on a real sidecar" (`:48`). Ship notes still a
placeholder — no shipped date recorded.

### A18 · Device-pin resolution survives a respawn ([#1870](https://github.com/dudarenok-maker/Castwright/pull/1870), closes [#1857](https://github.com/dudarenok-maker/Castwright/issues/1857)) · **2-card boot**

`buildSidecarEnv` now hands the sidecar the raw `cuda-uuid:` literal instead of a
translated `cuda:N`, so the sidecar re-resolves the pin against live torch
enumeration on every spawn. Verified by unit tests and CI; **never watched on real
cards.** The behaviour that matters most is the one no test can reach — a respawn
after the index actually changes.

- Pin Qwen to a specific card in Advanced settings, restart the server, and force a
  supervisor respawn (`POST /api/sidecar/restart`, or let a recycle fire). The engine
  lands on the **pinned** card both times.
- Then change the enumeration order — swap the cards, or set `CUDA_DEVICE_ORDER` —
  and confirm a respawn still finds the pinned card by UUID rather than failing
  `_validate_cuda_index` or landing on the wrong one. **This is the regression the
  change exists to prevent**, and it was previously reachable only when the user had
  opened Advanced settings during that server session.
- Pin `tts.qwen.codecDevice` to a card and confirm the codec is actually placed there.
  Before #1870 the pin was silently ignored — the literal failed inside torch's
  `.to()` and rolled back to CPU.
- Point the codec pin at a card that is **not** present and confirm the sidecar logs
  `QWEN_CODEC_DEVICE=… did not match any visible GPU` and leaves the codec on **cpu**
  — not on the model's card, which is what `auto` would have done.

*Needs:* both cards, and the ability to change enumeration order between boots (the
eGPU is not hot-pluggable, so batch this with A2 step 9 and A3). *Cost:* short.

---

## Group B — local Ollama analyzer only

A real Ollama daemon and a long (~110k-char) chapter. No TTS engine resident. Both
rows have a **CPU-only sub-case** — the only checks here that want the analyzer
*off* the GPU. Run those two together, and consider folding in E4.

### B1 · Analysing view honesty for local analyzers (plan 216)

Six steps (`:124-142`). A per-phase Gemini recitation-block falls back to local Qwen
with chip, swap, ticker and log all agreeing · a ~110k-char chapter's ETA reads
realistic minutes and **tightens within ~10s** of streaming, not at chapter-end · a
dense single-paragraph chapter that used to hard-fail with "truncated the response
(length)" now completes · **CPU-only:** the first-chapter ETA seeds slow (~15 chars/s)
rather than assuming GPU speed · `LiveChapterTicker` renders every in-flight chapter
at K=4 with a monotonic per-phase bar.

### B2 · Per-model analyzer keep-alive (plan 263)

**Eight** steps at `:242-299` — an earlier version of this register said seven and
missed step 8, which has been in the file since 2026-07-17.

Driven from the Model Manager with `ollama ps` open in a second terminal. **Step 4 is
the regression worth confirming:** with keep-alive at `0`, the model stays pinned
during a run, but a manual Load pill *outside* a run still warms with a 30s floor
rather than appearing to do nothing. `-1` keeps it resident indefinitely; the reset
(↺) restores the flat default. **Step 8:** a voice design with a custom analyzer
model and no override keeps persona keep-alive at `300`, unregressed by the per-model
resolver. **CPU-only:** a `RAM_HEAVY_MODELS` clamp overrides a configured positive
keep-alive back to `0`.

---

## Group C — one *Ночной дозор* re-analysis session

Three rows re-analyze the **same manuscript** for different reasons. One local pass
plus one cloud pass, captured with scene-break output, attribution output and
truncation/429 telemetry all in mind, discharges all three. No TTS or GPU synthesis.

Book: `C:\AudiobookWorkspace\books\Сергей Лукьяненко\The Night Watch Tetralogy\Ночной дозор`.

### C1 · Manuscript scene separator — Russian re-run (plan 261)

Plan 261 could not measure this book in its original round: it was mid-re-analysis
and its `manuscript-edits.json` was deleted by the reparse (`:203-206`). The
marker-anchored rule change is claimed to *mechanically* eliminate the old
~92k-character forward-overshoot — that claim is what the re-run confirms. Failure
here is always cosmetic: a divider off by a sentence, never data corruption.

### C2 · srv-59 deterministic dialogue-structure attribution (plan 247)

"Manual acceptance walkthrough (on-box, owed post-merge)" (`:247-249,338-340`).
Re-analyze the same book — 9 chapters, 14,065 sentences — on the default pipeline.
Ship notes: "Not yet shipped: on-box acceptance is owed post-merge." Core engine
merged PR #1482 (2026-07-09); still unrun as of 2026-07-21.

### C3 · Cloud request sizing + local input-fraction calibration ([#1685](https://github.com/dudarenok-maker/Castwright/issues/1685))

Three unchecked items. Uses the free-tier `GEMINI_API_KEY` **already configured** in
`server/.env` — a credential this run exercises, not a blocker.

Re-analyze end-to-end on `gemma-4-31b-it` **including the script-review pass** — the
pass that actually 429'd in the original incident (all 22 logged failures were
`task: script-review`) — and confirm a per-minute 429 is retried rather than
misclassified as daily-quota. Then calibrate `analyzer.stage2.localInputFraction`
(ships at 0.3) downward until a full local re-analysis completes with **zero**
stage-2 truncation drops, and record the working value.

---

## Group D — multi-language TTS render + ASR

### D1 · Non-English ASR content-QA calibration ([#1527](https://github.com/dudarenok-maker/Castwright/issues/1527), [#1084](https://github.com/dudarenok-maker/Castwright/issues/1084))

Render real audio in es/ru (then fr/de), run the ASR content-QA gate against it,
inspect the WER distribution per language, and set `qa.asr.maxWer.{es,fr,de,ru}` from
observed data — they currently all inherit the English-tuned `0.4` default.

Two named residual risks: gendered-number mismatch rate (es/fr/ru "one", ru "two"),
and Russian oblique-case declension mismatches. Also whether Whisper's German output
matches the single-fused-token assumption for compound numbers.

*Prerequisite satisfied:* the fs-61 per-language Coalfall demo books **are**
voice-designed — PR #1568 (merged 2026-07-13) ships "a language-matched Qwen cast
designed from the same English personas" for each of the five samples, 0 `.pt`
collisions across 101 files. Largely an unattended batch: render, then inspect.

### D2 · fs-61 zh/ja placeholder voices ([#1600](https://github.com/dudarenok-maker/Castwright/issues/1600))

The Qwen VoiceDesign pipeline is merged, but the **zh/ja** Coalfall placeholder
artifacts were never produced. Run the shipped pipeline against them. Distinct from
D1's five languages, which are done.

---

## Group E — not the GPU box

### E1 · ops-16 Pinokio installer ([#822](https://github.com/dudarenok-maker/Castwright/issues/822)) · **macOS is the gap**

PR #821 **merged 2026-06-15** (`90bc51eb`) — shipped code with acceptance debt, not
an unmerged feature. The issue body still says "draft PR #821" because it was filed
90 seconds before the merge and never updated. The 6-item matrix is all checked.

Real Windows on-box testing has substantially happened since: four closed bugs
(#1458, #1484, #1508, #1528, closed 2026-07-08→11) found and fixed real
Pinokio-runtime issues — module format, `shell.run` cwd resolution, the reserved
`pinokio/` folder name — and #1513 fixed the `server/.env` load path, now confirmed
in `pinokio-scripts/start.js`.

**What genuinely remains:** **macOS has had zero on-box exercise on any axis**
(install, venv-from-conda, API spelling are all Windows-only confirmations); plus two
Windows items never explicitly re-confirmed — **native Stop actually reaping the
sidecar**, and **Pinokio's bundled Node ≥ 22.22**.

> **Escalated 2026-07-27 by [#1859](https://github.com/dudarenok-maker/Castwright/issues/1859).**
> That Node threshold was **20.19** until react-router 8 raised the product floor to
> **22.22**, so this item went from "probably fine, never checked" to a live risk. It
> now matters more, for two compounding reasons:
>
> 1. `pinokio-scripts/install.js` step 1 conda-installs `ffmpeg mkcert` only — **never
>    `nodejs`** — so Castwright runs on whatever Node the Pinokio *kernel* ships. That
>    file has carried an unimplemented TODO on exactly this point since it was written.
> 2. **`engines.node` does not enforce anything.** npm emits `EBADENGINE` and exits 0
>    without `engine-strict`, and this repo sets no `.npmrc` (see
>    `docs/features/164-deps-ci-hygiene.md:31`). So a too-old Pinokio Node does not
>    fail the install — it installs cleanly and fails later, somewhere unrelated.
>
> **What to observe, concretely:** on a machine with Pinokio installed, run
> `node --version` using Pinokio's own bundled node (not the system one — resolve it
> the way `shell.run` does, from the kernel's bundled runtime). Record the exact
> version and the Pinokio version it came with, on **both** Windows and macOS, since
> the kernels may differ. If it is below 22.22, add `nodejs` to `install.js` step 1's
> conda install and re-run a full Install → Start pass.
>
> Criteria live in `docs/features/218-pinokio-installer.md` open-verification item 2
> (threshold updated in the same PR). **The release notes for 1.15.0 deliberately do
> not promise Pinokio users this is handled** — an earlier draft did, and it was
> unsupported.

*Needs* a clean macOS machine with Pinokio, plus a short Windows follow-up. Budget
20–40 min for the macOS install alone.

### E2 · LAN HTTPS on by default (plan 250)

"## On-box acceptance (owed)" (`:43-48`). Fresh install boots HTTPS on :8443 with the
cert-provisioned log line · the Open-Web-UI tab loads with no cert warning · **a real
phone** installs the mkcert root CA and completes pairing over `castwright.local` ·
forcing `LAN_HTTPS=0` or deleting the certs degrades to loopback HTTP without a crash.
*Shipped* 2026-07-12 after four review rounds.

### E3 · Pair from `castwright.local` (plan 256)

"On-box acceptance owed — pair a real phone from `https://castwright.local/#/admin`"
(`:48-52`). Authorize a device from the friendly hostname with no 403 · name-first
pairing from the Listen tab shows the chosen name in the admin list · a bare-LAN-IP
request still gets the loopback-only 403 guidance.

**Same session as E2** — shares the phone + host setup, and E2 is what made
`castwright.local` the natural URL this depends on.

### E4 · fe-51 engine-recommendation CPU caveat (plan 259)

"On-box acceptance item (real hardware, not mock mode) — owed" (`:183-191`). The
wizard's CPU caveat claims a low/no-VRAM user can force Qwen onto CPU via the
voice-engine device setting and still render — slow, not crashing. Never confirmed on
real hardware. The plan names its own fallback if it turns out false: soften
`CAVEAT_VRAM` at `server/src/tts/engine-recommendation.ts:34`.

*Needs a real box but specifically the **CPU** path* — pairs naturally with Group B's
CPU-only sub-cases.

### E5 · fe-39 touch press-feedback — DevTools smoke-check ([#1795](https://github.com/dudarenok-maker/Castwright/pull/1795))

The behavioural touch-flash is confirmed by construction but not by an automated test
(jsdom cannot compile the variant); a one-time DevTools touch-emulation check is the
spec's accepted proof. Four controls: continue-listening play badge, "Add book" tile,
wizard "Review ›" chip, voice-library drag icon. Minutes, any machine.

---

## Group F — a real Android device

### F1 · Android companion app — v1 live-device acceptance (plan 188) · **an entire untested axis**

Plan 188 carries "**Live device acceptance owed**" on essentially every shipped
module — app-3, 4, 5, 6, 7, 8, 13, 14 (`:41-49`, repeated in the Ship-notes table
`:796-816`), app-9 "Live device/head-unit acceptance owed" (`:51`), app-10 "On-device
acceptance (owed post-merge)" (`:504-508`). Status line: "build track: **complete** …
The other remaining work is the **batched live-device/head-unit acceptance pass**."

All the Dart unit and widget tests are green and CI-covered. **Zero of it has been
proven on a physical phone.**

**v1 core, single end-to-end scenario** (`:622-630`): pair a phone to the server via
QR (token + CA fingerprint auto-verified, no OS cert install) → browse the library by
author/series/book → download 2 books → play offline with background, lock-screen and
Bluetooth controls plus a sleep timer → switch between the 2 books, each resuming at
its own position → regenerate one chapter of book A on the server → return to home
Wi-Fi → the app auto-syncs only that chapter and pushes the in-car listening position
back to the server.

**app-9, head unit:** Android Auto / CarPlay media-browse tree navigation and playback
from a real head unit.

**app-10, stream over LAN** (`:504-508`): an undownloaded chapter with "Stream over
LAN" on starts instantly, mid-chapter seek works, lock-screen transport works, it
survives backgrounding, and no OS cert-install prompt appears; with streaming off or
off-Wi-Fi, a "download to play" message rather than a stall.

*Needs* a real Android phone (the plan names a Pixel 10 Pro), the GPU server reachable
on the same LAN, and — for app-9 — a real Android Auto / CarPlay head unit. Not
batchable with any other group.

---

## Blocked — hardware not available

### AMD GPU support Phase 2 ([#1335](https://github.com/dudarenok-maker/Castwright/issues/1335))

Waves A–G were built and merged **dormant** — the code path exists but has never run
against real ROCm hardware. A dormant capability, not an active bug. This box is
dual-NVIDIA; this will not move until AMD/ROCm hardware exists.

---

## Unconfirmed — not debts until substantiated

Kept separate on purpose. Listing a suspicion as debt is how a register stops being
trusted.

- **fs-38 Wave 1** (designed-voice authoring, PR #1800) — no explicit owed callout
  beyond a generic "Live-GPU acceptance" line in plan 194 that is about cloning
  generally (Wave 3's concern), not marked outstanding the way 267/268/264/216/263
  are. Closed bugs #1802/#1833/#1836 show live "My voices" use, consistent with it
  being exercised informally. Not confirmed either way.
- **Ollama concurrency (K>1) real-VRAM validation** — PR #1707 fixed a case where K
  never took effect and ships `peak==K` telemetry so a future run self-verifies. The
  UI half is B1's K=4 step. If a separate `n_slots=1` physics check is owed, its
  written criteria were not found in this repo — do not double-count it.

---

## Deliberately not in this register

- [#1826](https://github.com/dudarenok-maker/Castwright/issues/1826) — its bar is an
  automated interleaving regression test, not a manual walkthrough.
- [#964](https://github.com/dudarenok-maker/Castwright/issues/964) (fs-48 Fish Audio)
  and [#1334](https://github.com/dudarenok-maker/Castwright/issues/1334) (fs-73 Cast
  Pass) — parked or unbuilt. Pre-implementation criteria, not debt on shipped code.
- [#819](https://github.com/dudarenok-maker/Castwright/issues/819) — `moscow:wont`.
- Archived plans whose prose still says "owed" but whose debt was discharged via a
  separate, un-cross-referenced issue — confirmed closed for plans 210 (#752), 214
  (#397), 219 (#823), 193 (#476), and 181 (#1670/#927/#515/#517).

This register is for **manual, hardware-dependent verification of shipped code**.
Automated-test gaps belong in the plan's test section or an issue.
