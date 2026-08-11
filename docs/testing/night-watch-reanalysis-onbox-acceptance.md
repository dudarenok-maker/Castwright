---
status: draft
---

# Ночной дозор re-analysis — on-box acceptance run sheet

Discharges register rows **C1** ([#1685](https://github.com/dudarenok-maker/Castwright/issues/1685))
and **C2** ([#2187](https://github.com/dudarenok-maker/Castwright/issues/2187), plan
[247](../features/247-dialogue-structure-attribution.md)). #2187 is otherwise complete —
the aligner fix shipped in `b2be5b7b` — and stays open **solely** for C2.

Neither row needs TTS, GPU synthesis, or the sidecar. C2 needs local Ollama; C1 needs
the free-tier `GEMINI_API_KEY`.

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
engine **on**, `analyzer.structure.escalation` = **`local`**. Sidecar auto-start off.

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
| `flagged` | **≤ ~500** (plan 247 target 1) | 6,568 book-level; ch9 alone **488**, the only chapter over the floor |
| `aligned` | > 80% floor, expect ~92–99% | 47.4% book, ch5–8 below floor |
| `escalated` / `escalationAccepted` | non-zero — confirm escalation **runs** | 22 / 130, skipped chapter-wide |
| wall-clock | target 5: +2–5 h | never measurable |

Chapter 9 is the calibration point: it aligned at 95% on the old run, ran the full
engine, and landed at 488. If the fix works, the other eight chapters should now look
like chapter 9 rather than like their old selves.

**C2 passes** when every chapter's `flagged` lands near ~500 rather than the 1,200–1,700
the below-floor chapters produced, and `escalated` is non-zero throughout.

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

### Results

- **C2 — flagged ≤ ~500/chapter:** _Result:_
- **C2 — escalation runs, escalated/accepted counts:** _Result:_
- **C2 — wall-clock vs target 5:** _Result:_
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
4. Confirm the baseline is intact — the 0.1 table, re-measured. In particular
   `mns_oyK7Po6BiT.json` should still be 3,704,853 bytes with its 2026-08-06 mtime.
