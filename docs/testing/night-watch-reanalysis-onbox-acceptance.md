---
status: draft
---

# Ночной дозор re-analysis — on-box acceptance run sheet

> Register row: [C2](onbox-acceptance-register.md)

Discharged register rows **C2** ([#2187](https://github.com/dudarenok-maker/Castwright/issues/2187),
plan [247](../features/247-dialogue-structure-attribution.md)) and narrowed **C3**
([#2253](https://github.com/dudarenok-maker/Castwright/issues/2253)) — as those rows were
numbered at the time of the 2026-08-12/13 run recorded below. #2187's own claim (the
alignment/floor check, §2's "the actual #2187 claim") already **PASSED** in that run — the
aligner fix shipped in `b2be5b7b`. #2187 stays open on GitHub **solely as a bookkeeping
step**: per §4 "Recording the outcome" below, closing it is bundled into the PR that closes
out this run sheet's still-owed session, not because it substantively depends on that
session's result. Group C discharges were positional and renumbered under the pre-#2599
register rule (IDs are stable and never reused from 2026-08-27): the surviving row is **today's C2**
([#2253](https://github.com/dudarenok-maker/Castwright/issues/2253), formerly this file's C3),
which is what the header line above names. The cloud pass (**C1**,
[#1685](https://github.com/dudarenok-maker/Castwright/issues/1685)) is a separate, still-owed
session this run sheet was NOT run against — Session B below records it as not yet run.

Of the two historical rows, neither needed TTS, GPU synthesis, or the sidecar, and the
narrowed row (C3, today's C2) needed local Ollama. C1 — a separate, still-owed session, not
one of the two historical rows — needs the free-tier `GEMINI_API_KEY` instead.

---

## 0 · Protect the 2026-08-06 analysis — do this first

**The existing analysis is the qwen36 pass of 2026-08-06, and it is not
reproducible.** It carries a partly-curated cast (35 members after merges, from a
larger detected roster) and 3.1 MB of manuscript edits. Nothing in this run sheet
overwrites it, but the protection is verified rather than assumed.

### 0.1 The baseline, measured 2026-08-11

Confirm these still match before starting. If any has moved, something re-ran and the
C2 comparison figures below are stale.

| | |
|---|---|
| `manuscriptId` | `mns_oyK7Po6BiT` |
| Analysis cache | `server/handoff/cache/mns_oyK7Po6BiT.json` — **3,704,853 bytes**, mtime **2026-08-06 20:49** |
| `.audiobook/cast.json` | 140,846 B — **35** members, `castConfirmed: false` |
| `.audiobook/manuscript-edits.json` | 3,099,754 B |
| `.audiobook/dropped-quotes.json` | 115,866 B |

`analysisProvenance` in `.audiobook/state.json`:

```json
{ "engine": "local", "model": "qwen36-cw-iq4-32k:latest",
  "at": "2026-08-06T10:50:14.714Z", "structureEngineVersion": 1, "scope": "book",
  "chaptersCovered": 9,
  "report": { "alignedPct": 47.3871311766797, "confirmed": 580, "corrected": 1279,
              "flagged": 6568, "escalated": 22, "escalationAccepted": 130 } }
```

> **`state.json`'s mtime is later than the rest — that is not a newer analysis.** It
> was rewritten 2026-08-11 by the chapter-`uuid` backfill migration. Every other field
> is byte-identical to `state.json.bak.1`; the only delta is a `uuid` added to each of
> the 9 chapter entries. The analysis content is unambiguously from 2026-08-06.

### 0.2 Cold backup

The cache lives **outside** the workspace, so a workspace backup does not include it.
Copy both halves:

```powershell
$stamp = Get-Date -Format 'yyyyMMdd-HHmm'
$dest  = "C:\AudiobookWorkspace\_backup\night-watch-$stamp"
New-Item -ItemType Directory -Force $dest | Out-Null

Copy-Item "C:\Claude\Projects\Audiobook-Generator\server\handoff\cache\mns_oyK7Po6BiT.json" $dest
Copy-Item -Recurse "C:\AudiobookWorkspace\books\Сергей Лукьяненко\The Night Watch Tetralogy\Ночной дозор\.audiobook" "$dest\.audiobook"

# Verify the cache copy is byte-identical — not merely present.
(Get-FileHash "$dest\mns_oyK7Po6BiT.json").Hash -eq `
  (Get-FileHash "C:\Claude\Projects\Audiobook-Generator\server\handoff\cache\mns_oyK7Po6BiT.json").Hash
```

That last line must print `True`. A backup verified only by `Test-Path` is not a backup.

### 0.3 Why the re-import is safe — three verified mechanisms

Read these once; they are why the rest of the sheet does not tiptoe.

| Mechanism | Where | Effect |
|---|---|---|
| `manuscriptId = 'mns_' + nanoid(10)` | `routes/import.ts`, `routes/manuscripts.ts:39` | Every import gets a fresh random id |
| Cache keyed by `manuscriptId` **only** | `store/analysis-cache.ts` header | A new id ⇒ a new cache file. `mns_oyK7Po6BiT.json` is never opened |
| Directory collision **409s**, writes nothing | `routes/import.ts` — `if (existsSync(bookDir)) return res.status(409)…{ error: 'slug_collision' }` | Re-importing under the same title *cannot* clobber the library book. It fails closed and suggests `Ночной дозор (2)` |

Series memory needs no thought: `workspace/series-memory.ts` is a pure module with no
file I/O — the view is derived at scan time, not persisted, so a temporary duplicate in
the same series corrupts nothing and vanishes when the throwaway is deleted.

**The one rule that follows from the table:** give each throwaway import a *distinct
title*. Same title ⇒ 409 and you have wasted a step; distinct title ⇒ fully isolated
book directory, cache, cast, and edits.

### 0.4 What is still worth not doing

- Do **not** run with `fresh: true` against the **library** book. That is the one action
  that overwrites `mns_oyK7Po6BiT.json` in place, and no mechanism above protects you.
- Do not delete the throwaway imports until both rows are recorded — their
  `analysisProvenance` blocks *are* the evidence.

---

## 1 · Pre-flight

Both hard gates below were **failing** on 2026-08-11 at 13:04 and are the reason this
sheet stalls before section 2. Re-check both; neither is optional.

### 1.1 HARD GATE — the eGPU must be on the CUDA bus

`qwen36-cw-iq4-32k` is a **15 GB** model. The only internal card is the RTX 4070 Laptop
at **8,188 MiB**. Without the 16 GB RTX 5070 Ti eGPU (cuda:1, PCI `05:00.0`), Ollama
partially offloads to CPU — the run still *completes*, which is the trap, but its
wall-clock is not the number C2 is asking for and is not comparable with the 2026-08-06
pass, which had the eGPU.

```powershell
nvidia-smi --query-gpu=index,name,memory.total,memory.free --format=csv
```

Two cards must be listed. **`Get-PnpDevice` is not evidence** — WDDM reported
`Status: OK` for the 5070 Ti at the same moment NVML reported
`Unable to determine the device handle for GPU1: 0000:05:00.0: GPU is lost.` Windows
seeing the card is not CUDA being able to use it.

Recovery, no reboot needed (documented, worked 2026-06-27):

1. `Win+Ctrl+Shift+B` — restarts the WDDM stack. Re-check `nvidia-smi -L`.
2. Still lost → **elevated** disable/enable:
   ```powershell
   Disable-PnpDevice -InstanceId 'PCI\VEN_10DE&DEV_2C05&SUBSYS_2C056688&REV_A1\BBB63063392DB04800' -Confirm:$false
   Start-Sleep 5
   Enable-PnpDevice  -InstanceId 'PCI\VEN_10DE&DEV_2C05&SUBSYS_2C056688&REV_A1\BBB63063392DB04800' -Confirm:$false
   ```
3. Verify `memory.total` actually reports the 16 GB — being *listed* is not recovery.
4. If disable/enable does not clear it, the Thunderbolt/OcuLink link is down: re-plug or
   reboot.

Root cause is `nvlddmkm` Event 153 correlated with Modern Standby. **Keep the box awake
for the whole session** or it can drop again mid-run.

### 1.2 HARD GATE — the box must be quiet

The original wording here was "no generation running", and it was too narrow: on
2026-08-11 there was no render at all, but **four concurrent `verify:fast:scoped`
batteries** were running out of sibling worktrees (`wt-2128-audio-currency`,
`wt-book-language-resolution`) plus several Playwright `npx` processes. That contends
for exactly the CPU a partially-offloaded Ollama run needs, and C2 records wall-clock.

```powershell
Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object { $_.CommandLine -match 'vitest|verify-cache|playwright' } |
  Select-Object ProcessId, CommandLine
```

Must come back empty. Other Claude Code sessions run these without warning, so re-check
immediately before starting, not once at the top of the session.

> Do not start a commit while that list is non-empty either — concurrent pre-commit
> hooks on this box wedge at 0 % CPU rather than queueing.

### 1.3 The rest

1. **Ollama has `qwen36-cw-iq4-32k:latest`** — `ollama list`. *(Verified 2026-08-11: present, 15 GB.)*
2. **Copy the source EPUB** out to somewhere convenient for upload:
   `…\The Night Watch Tetralogy\Ночной дозор\manuscript.epub`.
3. **Confirm the #2187 aligner is actually in the running build** before spending hours
   on a run that measures the old code:
   ```sh
   git merge-base --is-ancestor b2be5b7b HEAD && echo "aligner fix present"
   ```
   *(Verified 2026-08-11 against `57aeedfa` on `main`: present.)* Section 2.4 gives a
   second, empirical check that does not depend on this one being right.

---

## 2 · Session A — C2 (local, structure engine)

**Run C2 first, at shipped defaults.** C1's second half calibrates
`analyzer.stage2.localInputFraction` downward; that knob changes stage-2 chunking and
therefore the stage-2 output the cross-examiner flags. Measuring C2 after C1 has moved
it measures a configuration that does not ship.

### 2.1 Import the throwaway

Import `manuscript.epub` via the UI with title **`Ночной дозор (C2 throwaway)`**,
author and series as you like — anything that differs from the live book's title.
Record the new `manuscriptId` from its `.audiobook/state.json`; it is the cache file
this session will write.

### 2.2 Settings

Account → analyzer settings: engine **local**, model **`qwen36-cw-iq4-32k`**, structure
engine **on**, `analyzer.structure.escalation` = **`local`**.

Two more, both load-bearing for a *local* measurement (see the 2026-08-11
attempt-2 log for why each was missing):

- **`allowCloudFallback: false`** in `~/.castwright/user-settings.json` — back the
  file up first. With it on, a queued Ollama call that stalls before first byte
  is classified `LocalUnreachableError` and silently completes on Gemini,
  contaminating both the flagged counts and the wall-clock. Off, the same
  condition fails loudly, which is what a measurement wants. **Env cannot
  override this** — only the settings file can.
- **`DISABLE_AUTOSTART_SIDECAR=1`** in the environment that launches the app —
  this one *does* beat the saved setting, and keeps the sidecar off the 16 GB
  card Ollama needs 14 GB of.

### 2.3 Run

Analyse the throwaway with **`fresh: true`**. A resumed run serves cached chapters and
measures nothing — the failure mode is that it looks like a clean green pass.

Start a wall-clock timer. Target 5 is *+2–5 h at `'local'`* and has never been
measurable, because escalation was being skipped chapter-wide.

### 2.4 The free positive control — check this at chapter 1, not at the end

Each chapter logs:

```
[analysis:structure] ch=1 aligned=96% confirmed=… corrected=… flagged=… escalated=… escalationAccepted=…
```

**`aligned=` is a control on the whole run.** The 2026-08-06 pass recorded 47.4% book-level
and chapters 5–8 at 3.7/1.7/66.4/73.5%. Offline replay of the same corpus through the
shipped aligner puts every chapter over the 80% floor and the book at 96.0%.

- `aligned=` in the high 90s ⇒ the #2187 fix is live; the flagged numbers mean something.
- `aligned=` back in the 40s–70s, or this line instead:
  ```
  [analysis:structure] ch=5 below alignment floor (4%) — escalation skipped
  ```
  ⇒ **stop.** You are running a build without `b2be5b7b`, and every downstream number is
  the old measurement. Nothing after this point is worth recording.

This costs one chapter instead of the full run, and it is the difference between a
measurement and a re-run of history.

### 2.5 What to record, per chapter

| Field | Target | 2026-08-06 baseline |
|---|---|---|
| confidence < 0.75 share (1a — **review burden**) | **no bar** (#2267 withdrew the ≤44% bar on 2026-08-12; 1a no longer carries a structural claim) | record it as an observation only — it says how much of the chapter the review UI highlights, nothing about the source |
| `maxMergedTurnsInParagraph` (1c — **legibility**) | **< 10 per chapter** (plan 247 target 1c) | offline replay reads ch3 6, and 58–133 for the other eight chapters — so **eight chapters are expected to breach**, and that breach is the intended "re-convert this source" signal, not a regression |
| `unresolved` share (1b reading 2) | no fixed bar — read alongside `flagged`/`alignedPct`/`flagOnly` | not yet measured; the bucket did not exist at the 2026-08-06 baseline |
| `flagged` / victim rate (1b readings 1, 3) | victim rate **≤ 4%** (n=30) (plan 247 target 1b) | 6,568 book-level; ch9 alone **488**, the only chapter over the old absolute bar (retained as history — the absolute bar is no longer the criterion) |
| `aligned` | > 80% floor, expect ~92–99% | 47.4% book, ch5–8 below floor |
| `escalated` / `escalationAccepted` | non-zero — confirm escalation **runs** | 22 / 130, skipped chapter-wide |
| wall-clock | target 5: +2–5 h | never measurable |

Chapter 9 is the calibration point: it aligned at 95% on the old run, ran the full
engine, and landed at 488. If the fix works, the other eight chapters should now look
like chapter 9 rather than like their old selves.

**C2 passes** when the 1b victim rate lands at or below **4%**, `unresolved` reads
alongside `flagged`/`alignedPct`/`flagOnly` rather than being read alone, and
`escalated` is non-zero throughout. The confidence<0.75 share (1a) is **recorded but
does not gate** — #2267 withdrew its bar on 2026-08-12 after it was measured to miss
every degraded chapter of this book while flagging three healthy chapters of an
English one.

**1c is recorded, and is expected to breach on this book.** Eight of nine chapters
hold 58–133 merged dialogue turns inside a single paragraph. That is a finding about
the *source*, not the engine: it says this EPUB needs re-converting (#2254). It does
**not** fail C2, because C2 grades the engine. Record the per-chapter 1c figures so the
re-conversion, when it happens, has a before number to beat.

---

## 2A · Offline replay — what it settles without a run (2026-08-11)

Before spending 2–5 h, the deterministic half of the structure pass was replayed
offline over the 2026-08-06 cache. **It answers C2's primary criterion exactly**,
and it changed what the remaining debt is.

### 2A.1 Why the replay is sound

In `routes/analysis.ts` the block runs `alignSentences` → `crossExamine`, and
*only then* `escalateFlaggedWindows`, which assigns nothing but `escalated` /
`escalationAccepted` (verified: nothing outside tests assigns `.flagged =`). So
`alignedPct` / `confirmed` / `corrected` / **`flagged`** are fully determined by
the deterministic pass, which is pure over three inputs we already hold:

| Input | Source |
|---|---|
| per-chapter sentences | Aug 6 cache `mns_oyK7Po6BiT.json` (raw stage-2, pre-edit) |
| roster | `stage1.characters` in the same cache |
| chapter bodies | re-parse `manuscript.epub` via `parseManuscript` (deterministic) |

**Tooling control:** ch9 cleared the floor on the OLD aligner and ran the full
engine to 488 flagged. The replay lands it at **471** (Δ −17) and 96.7% vs 95.0%
— it reproduces the chapter the fix should barely have moved, so the rows below
are trustworthy. *A replay that could not reproduce ch9 would be measuring
itself, not the aligner.*

**What it is not:** the production path. It holds the Aug 6 LLM output fixed and
varies only the aligner — a cleaner causal A/B than a fresh run, but a fresh run
would generate different sentences and so somewhat different counts.

### 2A.2 Results

| ch | aligned (was) | flagged | sentences | rate | vs ~500 |
|---|---|---|---|---|---|
| 1 | 98.0% | 687 | 2,777 | 24.7% | **fails** |
| 2 | 97.8% | 812 | 2,111 | 38.5% | **fails** |
| 3 | 99.1% | 308 | 850 | 36.2% | passes |
| 4 | 99.7% | 178 | 892 | 20.0% | passes |
| 5 | 94.6% (3.7%) | 326 | 1,736 | 18.8% | passes |
| 6 | 92.7% (1.7%) | 392 | 1,682 | 23.3% | passes |
| 7 | 92.0% (66.4%) | 366 | 1,867 | 19.6% | passes |
| 8 | 95.7% (73.5%) | 511 | 1,543 | 33.1% | **fails** |
| 9 | 96.7% (95.0%) | 471 | 1,611 | 29.2% | passes |

**Book: aligned 47.4% → 96.0%; flagged 6,568 → 4,051 (−38%); chapters below the
80% floor 4 → 0.** The #2187 fix works: escalation would now run on every
chapter instead of being skipped on 5–8.

### 2A.3 Three findings that outrank the pass/fail

1. **Target 1 (`flagged` ≤ ~500/chapter) is mis-shaped.** It is absolute, but
   chapters vary 3× in length: `corr(flagged, sentence count) = 0.772` vs
   `corr(flagged, flag rate) = 0.549`. Ch1 has the third-*best* flag rate in the
   book and fails; ch3 has nearly the worst and passes because it is short.
2. **Chapters can pass by giving the engine less to see.** ~90% of all flags are
   `unanchored-*` (model named a speaker, no structural evidence either way).
   Ch5 yields only **101 speech spans from 702 dash-dialogue sentences (14%)**
   against ch1's 444/777 (57%), because 88% of ch5's characters sit in
   paragraphs over 500 chars. So `flagged` measures **engine engagement, not
   correctness** — which makes it unsound as an acceptance metric, and no full
   run would have shown this, since a run reports the same number.
3. **The EPUB has degraded paragraph structure in ch4–8** — 70–89% of characters
   in >500-char paragraphs (ch3: 7%), ch7's first paragraph alone 5,716 chars,
   ch5 with 521 mid-paragraph dialogue dashes against 64 paragraph-initial.
   Upstream of #2187, in manuscript ingestion.

**Withdrawn (2026-08-11).** This section previously recorded that finding (3)
was refuted as a cause of the narrator collapse (`corr = −0.073`). That
correlation was computed on the **model's** `characterId` column, which is the
engine's *input*, not its output. Re-measured on the engine's output column,
ch5's dash lines are **69.7% narrator against the model's 11.4%**, and the
degradation drives the collapse directly: **879 lines book-wide** are rewritten
character→narrator, unflagged, and booked as `corrected` successes. Zero on
every structurally-intact chapter, 58.3% on ch5.

Fixed by the dialogue-convention invariant in `cross-examine.ts` (#2253);
design of record
`docs/superpowers/specs/2026-08-11-dialogue-convention-invariant-design.md`.
A tag-span length bound was also prototyped and measured a **complete no-op**
(879 → 879) — un-tagging a span leaves it `narration`, which demotes too. Do
not re-propose it.

### 2A.4 What still needs the real run

Only `escalated` / `escalationAccepted` (proof escalation *executes*, not merely
that it would) and the wall-clock target 5. Both need §2 as written.

### 2A.5 What #2253 adds to the observation (2026-08-11)

The dialogue-convention invariant (#2253, `docs/superpowers/specs/2026-08-11-dialogue-convention-invariant-design.md`)
shipped after 2A.1-2A.4 were written and is corpus-verified only by two offline
replays over the 2026-08-06 cache (`server/handoff/cache/replay-experiment.mts`,
gitignored, throwaway) — `HARM TOTAL victims=41` at both the production 80% floor
and forced to 100% (down from the pre-fix baseline's 879, not to 0 — the rescue
guard now also requires roster membership, and the 41 off-roster lines were
never actually recoverable; `reconcileSentenceCharacterIds` demotes them to
`narrator` downstream regardless), all 17 workspace-book structure hashes unchanged. What
offline replay over a cache **cannot** show, and what this row now also owes on
top of §2A.4:

- `[analysis:structure]` log lines show `unresolved=` populated, and `flagged=`
  at conflict scale (order 10²/chapter, matching 2A.2's `flagged` column) rather
  than the old 10³ narrator-collapse scale — proof the bucket split (Tasks 5-6)
  and the invariant (Tasks 2-3) both reach a *live* stage-2 model output, not
  just the frozen Aug-6 one.
- Ch5's dash-opening sentences are no longer silently rewritten to `narrator` —
  spot-check a handful against the 30-item hand-labelled sample in
  `docs/superpowers/plans/2026-08-11-dialogue-convention-invariant.md`'s
  "Measured Baselines" appendix.
- `state.json`'s `analysisProvenance.report` carries a populated `unresolved`
  key (not absent — absent means "predates the split" per the plan's Global
  Constraints, and nothing may default it to 0).

Hardware: same as §2 above — local Ollama with `qwen36-cw-iq4-32k`, ~14 GB VRAM
free, sidecar suppressed (`DISABLE_AUTOSTART_SIDECAR=1`). Batches naturally with
the rest of this run sheet's Session A rather than needing a session of its own.

---

## 3 · Session B — C1 (cloud pass, then local calibration)

Two independent halves. The cloud half is short; the local half is iterative.

### 3.1 The `.env` trap — change this or the pass dies on the content filter

`server/.env:17` reads:

```
GEMINI_MODEL=gemini-3.5-flash-lite
```

That **overrides the RECITATION-safe code default**. The last-resort fallback in
`analyzer/index.ts` and `routes/analysis.ts` is already `gemma-4-31b-it`, so it is this
`.env` line — not the code — that has to change:

```
GEMINI_MODEL=gemma-4-31b-it
```

This is not theoretical. On 2026-08-06 a queued Ollama call timed out into the cloud
fallback and `gemini-3.5-flash-lite` returned `PROHIBITED_CONTENT` on a stage-2
chapter-1 section of this exact book. `gemma-*` has its own free-tier bucket
(30 RPM / 14,400 RPD) and is RECITATION-filter-immune. Restart the server after editing.

### 3.2 Cloud half

Import a second throwaway — title **`Ночной дозор (C1 throwaway)`** — and analyse it
end to end on `gemma-4-31b-it` with engine **gemini**, `fresh: true`.

**Include the script-review pass.** That is the pass that actually 429'd in the original
incident: all 22 logged failures were `task: script-review`. A run that skips it does not
exercise the thing the row is about.

Record: whether a per-minute 429 is **retried** rather than misclassified as
daily-quota exhaustion. Watch the rate-limiter (`analyzer/rate-limit.ts`) gate both the
primary call and the retry.

### 3.3 Local calibration half

Back to engine **local**. `analyzer.stage2.localInputFraction` ships at **0.3**. Step it
down (0.25, 0.2, …) and re-run until a full local re-analysis completes with **zero**
stage-2 truncation drops. Record the working value — that number is the deliverable.

Use a fresh throwaway per iteration, or `fresh: true` each time; a resumed run will not
re-exercise the truncation path.

---

## 4 · Recording the outcome

Per the Before-shipping checklist step 3, all three surfaces move in the same PR:

1. **This run sheet** — fill in the `Result:` lines below.
2. **`onbox-acceptance-register.md`** — remove the discharged row(s), recompute the owed
   total and Group C's glance/header counts.
3. **`onbox-acceptance-register-live-view.html`** — the same edits by hand, then publish
   *that file* to the recorded `url`
   (`adf22b7b-12dd-49fe-874c-4a340585b26a`), never a fresh publish and never the `.md`.

Before publishing, save the currently-live page locally and run
`npm run check:onbox-register -- --against-published <saved copy>`. It is one-directional
— it fails only if the live page has a row yours lacks. **Also read the live summary strip
by eye**: a live total *higher* than `main`'s means someone published from a branch, and no
tooling reports that.

If C2 passes, **close #2187** in the same PR (`Closes #2187`). It has no other open work.

### Session log

**2026-08-11 13:04 — attempt 1, STALLED at pre-flight. No analysis run; nothing measured.**

Completed and durable:

- §0.1 baseline re-verified — every figure matches, including the 3,704,853-byte cache at
  its 2026-08-06 20:49 mtime. `state.json`'s later mtime confirmed as the chapter-`uuid`
  backfill only.
- §0.2 cold backup taken to `C:\AudiobookWorkspace\_backup\night-watch-20260811-1304`,
  cache SHA-256 verified identical (`B485DC43…FDDC`), all 13 `.audiobook` files copied.
- §1.3 items 1 and 3 verified (Ollama model present; `b2be5b7b` an ancestor of `57aeedfa`).

Blocked on:

- **§1.1 — RTX 5070 Ti eGPU off the CUDA bus.** `nvidia-smi` reports GPU1 `0000:05:00.0`
  lost; only the 8 GB 4070 enumerates. Needs `Win+Ctrl+Shift+B` or the elevated
  disable/enable — this session is **not** elevated, so it cannot perform the recovery.
- **§1.2 — box contended.** Four `verify:fast:scoped` batteries plus Playwright runs
  active in sibling worktrees.

**2026-08-11 14:00 — attempt 2. Pre-flight PASSED; ran the offline replay (§2A)
instead of the full analysis. Both rows still owed, but C2's remaining debt is
now only escalation counts + wall-clock.**

Pre-flight, all re-verified after the reboot:

- §1.1 **cleared** — both cards enumerate and the 5070 Ti reports real
  `memory.free` (15,995 MiB), not merely a list entry. `qwen36-cw-iq4-32k` is
  14 GB, so it fits with ~1.9 GiB headroom — the eGPU is load-bearing, not a
  preference.
- §0.1 baseline re-measured byte-for-byte: cache 3,704,853 B @ 2026-08-06 20:49,
  cast 140,846, edits 3,099,754, dropped-quotes 115,866. Backup intact (14 files,
  6.9 MB).
- §1.3.3 `b2be5b7b` confirmed an ancestor of HEAD.

Three gaps in this sheet, found by executing it:

1. **§1.2's process query false-positives on idle Playwright MCP servers.** Eight
   matched, all at 0.14–0.52% of one core — they are stdio servers held by other
   Claude sessions, not test batteries. Judge by CPU, not by name match.
2. **§2.2 never gated `allowCloudFallback`, and it should.** `AbortError` before
   first byte is classified `LocalUnreachableError` (`ollama.ts:888`), the *sole*
   fallback trigger — so a queued local call that stalls silently routes to
   Gemini and contaminates a "local" measurement. It **cannot** be suppressed by
   env: `getResolvedAllowCloudFallback()` returns the cached setting whenever
   settings are loaded and only consults `ANALYZER_ALLOW_CLOUD_FALLBACK`
   otherwise. Set it to `false` in `~/.castwright/user-settings.json` for the
   session (back it up first) and revert in §5.
3. **Suppress the sidecar with `DISABLE_AUTOSTART_SIDECAR=1`**, which *is*
   checked before the cached setting. Otherwise it takes VRAM on the very card
   Ollama needs. Note `LAN_HTTPS=1` in `server/.env` puts the app on
   `https://localhost:5173` with the server on `:8443`, not `:8080`.

Also: Ollama auto-updated 0.32.6 → 0.32.7 on first invocation after the reboot.
A deferred auto-update is a landmine under a multi-hour measured run — trigger it
deliberately at pre-flight rather than discovering it at hour three.

**2026-08-12 10:00 → 2026-08-13 09:20 — attempt 3, the real run. COMPLETE, 9/9
chapters.** Throwaway `mns_rKjCHx0vrS` ("Ночной дозор (C2C3 run 2)"), build
`52a8fb97` (= `6f215063` plus the #2287 analyzer-timeout fix), local Ollama
`qwen36-cw-iq4-32k`, structure engine on, `allowCloudFallback: false`.
**12 h 27 m** of compute in two sittings — 10 h 00 for ch1–7, then a deliberate
overnight pause and 2 h 27 for ch8–9. Resumed with `fresh: false`, which serves
the seven cached chapters and continues at 8.

Two attempts died before this one and both causes are now sheet gaps below:
attempt 1 was killed at hour six by *another session merging into `main`* under a
`tsx watch` server in the shared checkout; the run that succeeded used a pinned,
non-watch worktree on plain HTTP :8080.

Seven further gaps this attempt exposed, all folded into the sections above:

1. **§1.2's quiet-box gate checks CPU but not *writes* to the checkout.** What
   actually killed attempt 1 was a merge, not load. Require an isolated, pinned,
   **non-watch** checkout — not merely an idle one.
2. **Do not commit during a measured run.** The pre-commit hook detects the GPU
   load, throttles to `LOW_CONCURRENCY=1`, then flakes — and contends for CPU
   with the thing being measured.
3. **An SSE client's `curl --max-time` bounds the *observation*, not the run.**
   A 10 h `--max-time` expired mid-ch7 and was briefly misread as the run ending;
   the server-side job survived the client disconnect and completed. Proved by
   ch7 landing in the cache afterwards.
4. **§1.1's premise is false: the eGPU does not make the model fit.** Ollama
   reports **14.2 GiB** available on the 5070 Ti against a **16 GB** model, so
   ~5 GB spills permanently to the 8 GB card over PCIe. The §1.1 figure of
   15,995 MiB `memory.free` is what `nvidia-smi` reports, not what Ollama can
   allocate. This is most of the wall-clock miss.
5. **A UTF-8 BOM in `user-settings.json` silently defeats §2.2.** PowerShell's
   `Out-File -Encoding utf8` writes `EF BB BF`; the settings parse then fails and
   the server falls back to `DEFAULT_USER_SETTINGS`, where `allowCloudFallback`
   is **`true`** — precisely the contamination §2.2 exists to prevent, arrived at
   by following §2.2. Write it with `[System.IO.File]::WriteAllText($p, $json,
   (New-Object System.Text.UTF8Encoding $false))` and **verify the live value off
   the API**, not off the file.
6. **The setting is cached in-process** (`user-settings.ts:342`) — editing the
   file mid-session changes nothing until the server restarts.
7. **Target 1c never emitted.** No `scope=book merged=` line appeared on the
   resumed run. Since pause/resume is the only practical way to survive a 12 h
   analysis, a metric that only emits on an unbroken run cannot be an acceptance
   criterion. Tracked as its own row.

### Results

- **C2 — flagged ≤ ~500/chapter:** _Result:_ **NOT MET, and the criterion is
  unsound** (offline replay, §2A, 2026-08-11). 6/9 chapters pass; ch1 687, ch2
  812, ch8 511 fail. Book-level 6,568 → 4,051 (−38%). Because `flagged` is never
  mutated by escalation, this figure is final — a full run reports the same
  number. See §2A.3 finding 1: the absolute per-chapter bar tracks chapter length
  (r=0.772) more than difficulty (r=0.549). **Re-specify the target before
  re-testing.**
- **C2 — alignment / floor (the actual #2187 claim):** _Result:_ **PASS** —
  book 47.4% → **96.0%**, chapters below the 80% floor **4 → 0**, so escalation
  is no longer skipped chapter-wide. Ch5 3.7% → 94.6%, ch6 1.7% → 92.7%.
  Control: ch9 reproduces at 471 vs the recorded 488.
- **C2 — escalation runs, escalated/accepted counts:** _Result:_ **PASS**
  (live run, 2026-08-13). Escalation **executes** on all nine chapters —
  `flagOnly` false throughout, `escalated` non-zero everywhere. **61 windows
  attempted, 21 lines applied**, book-wide.

  ```
  ch  aligned  confirmed  corrected  flagged  unresolved  escalated  accepted
   1     98%       1517       1125        0          59         15         1
   2     98%       1219        881        0          42          7         0
   3     99%        493        339        0          10          6         0
   4     99%        525        368        0           9          4         0
   5     95%        799        818        0          87          7         0
   6     91%       1001        517        0         146          3         1
   7     94%        810        907        0         122          5         4
   8     90%        790        572        0         164          8        15
   9     98%        963        595        0          31          6         0
  ```

  **Read the last two columns carefully — they are in different units.**
  `escalated` is `EscalationOutcome.attempted`, a count of **windows**;
  `escalationAccepted` is `.applied`, a count of **individual lines**
  (`escalation.ts:22`). So ch8's `escalated=8 escalationAccepted=15` is not a
  contradiction — eight windows carried fifteen accepted lines between them. The
  log line at `analysis.ts:2267` prints both without saying so, which reads as
  impossible; that is a defect in the line, not in the numbers.

- **C2 — wall-clock vs target 5:** _Result:_ **MISSED, by roughly 2.5–6×.**
  **12 h 27 m** against a +2–5 h target: 10 h 00 for ch1–7 and 2 h 27 for ch8–9
  after an overnight pause. Per chapter 35 m – 233 m; ≈121 s per 1,000 chars.
  The dominant cause is §1.1's false premise — the 16 GB model does not fit the
  5070 Ti's 14.2 GiB, so ~5 GB spills over PCIe for the whole run. Re-testing
  this target means either a card that actually holds the model or a smaller
  quantisation; re-running the same configuration will reproduce the miss.

- **C3 — `unresolved` populated, `flagged` at conflict scale:** _Result:_
  **PASS.** `unresolved` is populated on every chapter (9–164, 670 book-wide),
  and `flagged` is **0** everywhere — under the "order 10²/chapter, not 10³" bar
  rather than over it. `flagged=0` is a real reading, not a dead metric (five
  unit tests assert `report.flagged === 1`): it means no model-vs-evidence
  conflict landed on a **named roster character**. It says nothing about the
  victim rate, because victims land in `corrected`.

- **C3 — ch5's dash-opening sentences no longer rewritten to `narrator`:**
  _Result:_ **FAIL.** ch5 went **69.7% → 87.2%** narrator on dash-opening lines;
  book-wide **87.4%** (4131/4725) against a 30.3% baseline. This is the named
  criterion and it did not hold end to end.

  The engine is **exonerated** and this should not be re-litigated: replaying
  today's engine over the 2026-08-06 cached stage-2 output reproduces **30.4%**
  vs the recorded 30.3%, so the cause is upstream of `crossExamine`, in this
  run's stage-2 output and/or roster. Filed as
  [#2306](https://github.com/dudarenok-maker/Castwright/issues/2306) with the
  A/B, the six ruled-out hypotheses, and the confound that has to be settled
  first — `stage2DurationsEngine` records the *selected* engine, not the engine
  that served each call, so it cannot tell a pure-local run from one that
  silently failed over to Gemini.

- **C3 — target 1c legibility (`scope=book merged=`):** _Result:_ **NOT
  EMITTED.** No such line appeared on the resumed run. Pause/resume is the only
  practical way to survive a 12 h analysis, so a metric that emits only on an
  unbroken run cannot serve as an acceptance criterion.

- **C2/C3 — model-quality events observed (recorded, not a criterion):** four
  stage-2 attribution coverage-check failures, all on ch8, all the same
  `repeat-loop` at offset 19, across **two server lifetimes** — deterministic,
  not sampling variance — plus one Ollama output truncation. ch8 did eventually
  clear after ~2.5 h. Fixed under
  [#2304](https://github.com/dudarenok-maker/Castwright/issues/2304).
- **C1 — cloud pass on `gemma-4-31b-it` incl. script-review:** _Result:_
- **C1 — per-minute 429 retried, not misclassified:** _Result:_
- **C1 — working `localInputFraction` for zero truncation drops:** _Result:_

---

## 5 · Rollback

Nothing here writes to the library book, so rollback is deletion, not restore:

1. Delete the throwaway books from the library once results are recorded.
2. Delete their cache files under `server/handoff/cache/` (keyed by their own
   `manuscriptId`s — recorded in 2.1 and 3.2).
3. **Revert `server/.env:17`** to `GEMINI_MODEL=gemini-3.5-flash-lite` if that is what you
   want day to day. Easy to forget; it silently changes every later cloud analysis.
3b. **Revert `allowCloudFallback` to `true`** in `~/.castwright/user-settings.json`
   (§2.2). Left off, a later local-analysis run hard-fails instead of falling
   back to cloud — a surprising failure days after the session that caused it.
4. Confirm the baseline is intact — the 0.1 table, re-measured. In particular
   `mns_oyK7Po6BiT.json` should still be 3,704,853 bytes with its 2026-08-06 mtime.
