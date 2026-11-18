# Paragraph-degradation signal — on-box acceptance run sheet

> **This is a working document.** Fill in the `Result:` lines AS you run this on
> the box, with the owner's library and a live local Ollama analyzer. Do not
> pre-fill them.
>
> Register row: [`onbox-acceptance-register.md` **B110**](onbox-acceptance-register.md) (Group B, local Ollama analyzer, no TTS).
> Design of record: [`docs/superpowers/specs/2026-11-13-paragraph-degradation-signal-design.md`](../superpowers/specs/2026-11-13-paragraph-degradation-signal-design.md) (§4.4 is this procedure, §4.3 the tools, §4.6 the row).
> Regression plan: [`docs/features/292-paragraph-degradation-signal.md`](../features/292-paragraph-degradation-signal.md)
> Issue: [#2254](https://github.com/dudarenok-maker/Castwright/issues/2254). #2254 closes only when the owner discharges row B110.

---

## 0. Prerequisites

- A local Ollama on the owner's default analysis model. Pass its name to the runner as `--model` and **record it here**: `Model: ____________`.
- `analyzer.structure.enabled = true`, `allowCloudFallback: false`. The runner reads the owner's saved analyzer settings (the saved settings file and `server/.env`; escalation included) without writing them, and records every `analyzer.*` effective value, the reasoning level, a digest of the request payload (never its values), the capacity and the effective chunk budget in every capture.
- The owner's library (Calibre and the workspace) on the box.
- **No re-imports of library books.** The scanner and the runner read text and a pinned roster, and write only their reports, captures and text dumps to a scratch directory **outside the workspace**. They read the workspace without the scan's self-heal, so nothing under it is written (the runner sets `CASTWRIGHT_VRAM_SAMPLE=0`, which stops the analyzer transport appending VRAM telemetry under `<workspace>/.telemetry/`). The one other thing it writes is the stage runner's handoff files, `server/handoff/{inbox,outbox}/ab-<id>-stage2*`: git-ignored, outside the workspace, with ids that cannot collide with a real job. Make the scratch directory first, for example `D:\scratch\pd2254`, and use it for every `--out` and `--scratch` below.
- The gate: #4165 has merged (met: closed 2026-11-15). Record the build the run used (`git rev-parse HEAD`): `Build: ____________`.

All commands run from the `server` directory of the checkout, through tsx:

```
node node_modules/tsx/dist/cli.mjs scripts/<script>.mts <args>
```

`Result:` _______________________________________________________________

---

## 1. Library legibility scan (the false-positive check)

The scanner parses every file with `parseManuscript`, the import path, so it measures the **imported text**. Formats: EPUB, MOBI, AZW3, PDF, Markdown and plain text. Each file is parsed in its own child process (60 s limit), so one bad EPUB cannot kill the scan; a file that throws, dies or times out is reported **unparsed** with its error message, and the scan goes on. Files with other extensions (for example `.fb2`) are listed **unsupported**, never spawned.

```
node node_modules/tsx/dist/cli.mjs scripts/paragraph-degradation-scan.mts --library <libraryDir> --out <scratch>\scan
```

It writes `scan.json` and `scan.md` under `--out`, and nothing outside it.

Then read the flagged chapters (every chapter at 10 or more turn openers; the scanner prints each one's worst imported paragraph, first 400 characters and count). For each, judge **merged** or **clean** by reading that imported paragraph. Write the judgements to a file as `{ "<file path>#<chapterId>": "merged" | "clean" }` and re-run with it, so the summary states the label outcome:

```
node node_modules/tsx/dist/cli.mjs scripts/paragraph-degradation-scan.mts --library <libraryDir> --out <scratch>\scan --judgements <scratch>\judgements.json
```

A chapter judged **clean** on its imported text (for example legitimate several-speaker replies in one paragraph) is a **breach**: record the chapter, its count and its format; the threshold decision goes to the owner. One breach is expected: the library's clean 12-opener monologue paragraph. An **extractor-merged (#4217)** chapter is a **true positive**, not a breach.

### What to record

- [ ] Per-book maximum legibility; each flagged chapter's worst paragraph judged merged or clean.
- [ ] Every breach (a clean-judged chapter at 10 or more): chapter, count, format.
- [ ] Chapters labelled **extractor-merged (#4217)**, listed as true positives. (A MOBI's what-if is not computed; a book whose chapter lists do not pair is "what-if not aligned" and gets no label.)
- [ ] Line-wrapped books (any format), each with the arm that flagged it (share ≥ 2% of non-blank lines, or count ≥ 10 continuation lines), and their breaches counted.
- [ ] The stray-break result of every book with continuation lines, line-wrapped or not (isolation result and largest neighbour window).
- [ ] Unparsed files with each error message, and unsupported files by extension, **on the build recorded above**.
- [ ] Each book's dash-turn density (total and per 1,000 words).
- [ ] The clean dialogue-dense ru dash books, by title. A book qualifies at 25 or more dash turns per 1,000 words and 1,000 or more dash turns, detected or declared ru, parsed, not a PDF, not flagged by the share arm, passing the stray-break check, with no chapter at 10 or more.
- [ ] Non-ru Cyrillic books, listed apart.
- [ ] The label outcome. `MERGED_TURNS_DEGRADED` loses its provisional label only when **both** hold: no breach in any scanned book (line-wrapped or not), and at least one clean, dialogue-dense ru dash book scanned. It loses the label in a follow-up commit that cites this row and names that book. Otherwise it stays provisional, and you record **which condition failed**.

### The 26-book corpus (#2254 corpus comment)

The #2254 corpus comment ([issuecomment-5276379461](https://github.com/dudarenok-maker/Castwright/issues/2254#issuecomment-5276379461)) gives only the composition: **14 ru EPUBs, 8 ru pre-Calibre TXT, 4 en EPUBs** (26 books). It does **not** give titles, so none are listed here. Fill in each title and confirm it was scanned:

| # | Kind | Title | Scanned? |
|---|---|---|---|
| 1 | ru EPUB | | |
| 2 | ru EPUB | | |
| 3 | ru EPUB | | |
| 4 | ru EPUB | | |
| 5 | ru EPUB | | |
| 6 | ru EPUB | | |
| 7 | ru EPUB | | |
| 8 | ru EPUB | | |
| 9 | ru EPUB | | |
| 10 | ru EPUB | | |
| 11 | ru EPUB | | |
| 12 | ru EPUB | | |
| 13 | ru EPUB | | |
| 14 | ru EPUB | | |
| 15 | ru TXT (pre-Calibre) | | |
| 16 | ru TXT (pre-Calibre) | | |
| 17 | ru TXT (pre-Calibre) | | |
| 18 | ru TXT (pre-Calibre) | | |
| 19 | ru TXT (pre-Calibre) | | |
| 20 | ru TXT (pre-Calibre) | | |
| 21 | ru TXT (pre-Calibre) | | |
| 22 | ru TXT (pre-Calibre) | | |
| 23 | en EPUB | | |
| 24 | en EPUB | | |
| 25 | en EPUB | | |
| 26 | en EPUB | | |

`Result (step 1):` _______________________________________________________________

---

## 2. 1A and the class report on real data: Ночной дозор

No fresh whole-book analysis and no cache. The runner captures a few chapters live, one at a time, from a pinned roster, and replays the engine on and off over each saved capture with no model.

### 2a. Dump the chapter text

The text source is the **hydrated record's** chapter bodies (the strings analysis reads), dumped read-only, byte for byte, with no self-heal. **Exclude ch3** (the one clean chapter); dump every other chapter id of the book (the book has 9 chapters, so ids 1, 2, 4, 5, 6, 7, 8, 9; check the ids on the box):

```
node node_modules/tsx/dist/cli.mjs scripts/paragraph-degradation-scan.mts --dump <bookDir> --chapters 1,2,4,5,6,7,8,9 --out <scratch>\ndozor
```

It writes `ch<id>.txt` per chapter and `dump.json` under `--out`. Do not edit or normalise the files: the runner and the measurement read exactly these strings.

### 2b. The manifest and the pinned roster

Copy the book's `.audiobook\cast.json` to `<scratch>\ndozor\cast.json` (a copy, so the roster stays pinned for every capture and every replay). Write `<scratch>\ndozor\manifest.json`, one entry per dumped chapter:

```json
[
  { "chapterId": 1, "chapterTextPath": "<scratch>\\ndozor\\ch1.txt", "rosterPath": "<scratch>\\ndozor\\cast.json" },
  { "chapterId": 2, "chapterTextPath": "<scratch>\\ndozor\\ch2.txt", "rosterPath": "<scratch>\\ndozor\\cast.json" }
]
```

(and so on for every dumped id, none for ch3).

### 2c. Capture

```
node node_modules/tsx/dist/cli.mjs scripts/paragraph-degradation-ab.mts --manifest <scratch>\ndozor\manifest.json --model <model> --scratch <scratch>\ab --language ru
```

The runner walks the manifest in descending hidden-turn order (on the EPUB as parsed: ch5, ch8, ch6, ch7, ch1; ch3 is excluded), capturing live, one chapter at a time. Each capture is saved to `<scratch>\ab\capture-ch<id>.json` the moment it returns, before anything is measured. It prints each chapter's wall-clock and, after the first, an estimate for the rest; that estimate replaces the table below. After each capture it reports the chapter's alignment and `flagOnly`.

- **Pick rule.** A chapter below the **80%** alignment floor leaves the pick (a swap), and the runner takes the next candidate in hidden-turn order, using its kept capture if it has one. It stops at three chapters clear of the floor, or after **two swaps** (at most five chapters taken). A swapped-out chapter's capture is kept and its control still runs; its 1A counts are reported apart and never count toward the verdict (its changed sentences enter neither `n` nor the blind sheet).
- **Fewer than three.** If the swap cap is reached with only one or two chapters clear, 1A is computed on those and the outcome says how many and why.
- **Captured, not used.** A chapter with a kept, non-defective capture that the walk does not reach is neither picked nor swapped out. It is listed with that status; its control still gates the verdict, and its counts sit outside it.
- **`<scratch>\ab\pick.json`** records every chapter's status and the outcome (`three`, `fewer-than-three: N`, `not-computed`, `stopped-for-owner`).

If a capture dies mid-run (a crash, a power cut), continue with:

```
node node_modules/tsx/dist/cli.mjs scripts/paragraph-degradation-ab.mts --manifest <scratch>\ndozor\manifest.json --model <model> --scratch <scratch>\ab --language ru --resume
```

`--resume` keeps every saved chapter, restores the shared structure budget from the most recent saved capture and captures only the chapter that died.

**Same model, always.** Every re-capture uses the same analyzer model and the owner's saved analyzer settings as the first. **The runner refuses a different `--model`, and refuses a change to any of these** and writes nothing: the effective value of every `analyzer.*` registry key (the Ollama URL, `num_ctx`, `num_gpu`, the input fractions, the coverage ratios, the structure knobs, and so on), the reasoning level, the saved request payload (kept as a sha256 digest, never its values: it can hold an api key), the capacity, and the effective stage-2 chunk budget (what a chapter is cut to, not the configured cap). The refusal names the differing keys; a changed payload reads `payload (changed)`. A setting outside those (an environment variable with no `analyzer.*` key, say) is not checked. The analyzer is built on the Ollama URL production resolves (env, then the saved Admin override, then the default); a URL that carries credentials, or does not parse, is refused before anything runs, naming `analyzer.ollama.url` and never its value (fetch refuses such a URL, so production cannot use one). Change a setting mid-run and the way forward is a new scratch directory.

### 2d. If a capture is defective, or nothing clears the floor

- **A capture defect is found** (for example what `onStages` recorded): fix it, then capture the affected chapters again. The pick re-walks from the head with the swap cap reset, reusing every non-defective capture:

  ```
  node node_modules/tsx/dist/cli.mjs scripts/paragraph-degradation-ab.mts --manifest <scratch>\ndozor\manifest.json --model <model> --scratch <scratch>\ab --language ru --recapture <id,id> --reason "<why>"
  ```

  A defective capture is listed **superseded**, with its round.
- **None clears the floor: 1A is *not computed*.** Record it, and check the captures for a defect. If one is found, fix it and `--recapture` as above. If none is found, make **one** same-model **re-roll** (Stage 2 samples at temperature 0.2 with no seed, so a second capture can align differently). It is allowed only after a not-computed outcome, **once in the row's life**, and it supersedes every capture and captures afresh every chapter it takes:

  ```
  node node_modules/tsx/dist/cli.mjs scripts/paragraph-degradation-ab.mts --manifest <scratch>\ndozor\manifest.json --model <model> --scratch <scratch>\ab --language ru --reroll --reason "<why>"
  ```

- **Still not computed after the re-roll, no defect found:** record the reason. The run **stops for the owner** and the row stays open.

### 2e. Measure from the saved captures (no model)

The capture run already measures once the walk settles. To measure again from the saved captures alone, with no model and no analyzer (for example after fixing the replay):

```
node node_modules/tsx/dist/cli.mjs scripts/paragraph-degradation-ab.mts --from-captures --manifest <scratch>\ndozor\manifest.json --scratch <scratch>\ab --language ru
```

It writes `<scratch>\ab\report.json` and `report.md`: per captured chapter, the control (recovery on, which must deep-equal the capture's own result, else the chapter is **void**), the recovery-on and recovery-off replays, the 1A counts by class, the narrator share on vs off, and the confident-decision class report. An unknown confident reason fails the measurement before anything is written.

- **Void.** Any captured chapter's control failing (swapped-out and captured-but-not-used chapters included) makes the verdict **void**: the row does not discharge, and the verdict is not computed on the chapters that passed. If the replay is at fault, fix it and re-measure every chapter from the saved captures (no model time). If the capture is at fault, fix it and capture the affected chapters again, on the same model.

### 2f. The blind hand-check

A non-void measurement writes `<scratch>\ab\blind-sheet.md` (and `blind-key.json`, the key; do not open it). For each item you see the sentence and its line in the recovery-off parse with the line either side, and **no speaker from either arm or from the engine**.

- `Speaker:` the true speaker, a roster id from the sheet's list or `narrator`; or `can't tell`; or `two speakers`.
- **Mixed sentence** (narration plus a turn, such as `Антон обернулся. — Ты кто?`): write the **turn's** speaker and put `x` in `Mixed:`. Mixed sentences are counted apart.
- **Two speakers** (`— Да? — Нет.`): write `two speakers` and leave `Mixed:` empty. It outranks mixed (`Антон обернулся. — Да? — Нет.` is **two speakers**). It scores neutral and is counted apart.
- `n` is the number of sentences whose post-crossExamine speaker differs, on vs off, across the picked chapters. If `n ≤ 30`, every one is on the sheet (a census). If `n > 30`, 30 are drawn uniformly without replacement with a fixed seed that the report records.

Then score the filled-in sheet, which derives each judgement without you ever seeing which answer came from which arm:

```
node node_modules/tsx/dist/cli.mjs scripts/paragraph-degradation-ab.mts --score <scratch>\ab\blind-sheet.md --scratch <scratch>\ab
```

### 2g. The verdict

Let `I`, `R` and `U` be the improvements, regressions and neutrals judged. In order:

1. Any chapter's control void: **void** (does not discharge).
2. No captured chapter clears the floor: **not computed** (does not discharge; see 2d).
3. `n = 0`: *recovery changes no speaker*.
4. **Census** (`n ≤ 30`): the counts are the answer, with no test. *Improves the speakers* when `I − R ≥ 3`; *makes them worse* when `R − I ≥ 1`; otherwise *no clear direction*.
5. **Sample** (`n > 30`): the same two claims about all `n`, tested exactly against the 30. *Improves* at one-sided p < **0.025**; *makes them worse* at one-sided p < **0.10**; otherwise *no clear direction*. The report prints `n`, `I`, `R`, `U` and the estimated improved and regressed counts.

**How blocker 1 closes:**

- *Recovery improves the speakers*: the issue's effect claim stands, with its size (exact in a census, estimated in a sample).
- *Recovery changes no speaker* or *no clear direction*: the effect claim is downgraded to a metric or acceptance improvement.
- *Recovery makes them worse*: the claim is downgraded, and a design item on recovery's evidence rule is filed then, not designed here.
- **Void** or **not computed**: the row does not discharge.

**Every outcome except a void or not-computed 1A discharges the row.** Record the tables, the verdict, the class report, the scan, who and when, and post them on #2254.

### 2h. What to record

- [ ] The verdict, and whether it came from a census or a sample, with `n`, `I`, `R`, `U` (and the seed and p-values for a sample).
- [ ] Each captured chapter's hidden-turn count, dash-opening paragraph count, alignment, `flagOnly` and status (picked, swapped out, captured but not used, superseded), the control result, and each re-capture or re-roll with its cause, its model and the pick it settled.
- [ ] If the swap cap was reached with fewer than three chapters clear: how many 1A rests on.
- [ ] 1A per picked chapter: sentences whose post-crossExamine speaker differs, on vs off, over all sentences and over turn sentences; narrator share over turn sentences, on vs off; confirmed, corrected, flagged and unresolved each way; each changed sentence's class (a)–(d).
- [ ] The mixed and two-speaker sentence counts.
- [ ] Each swapped-out and each captured-but-not-used chapter's 1A counts, in their own table, outside the verdict.
- [ ] The class report: confident decisions on turn sentences by class and reason, including `narration-demote` overrides (no verdict).
- [ ] Chunk shape and escalation's share (`final` vs `deterministic`).
- [ ] Each chapter's wall-clock as the runner printed it.

### On-box cost

Estimated on the **2026-09-05** model (`qwen38-cw-iq3-80k` on the 5070 Ti). They hold only for that model; if the owner's model differs, they do not carry over, and the runner's own per-chapter estimate replaces this table. Wall-clock, not GPU time.

| Step | Work | Wall-clock |
|---|---|---|
| 1 · library scan | parse only | none (no model) |
| 2 · capture, no swap | 3 chapters (ch5, ch8, ch6), one live capture each, one at a time; replays and measurement need no model | ≈ 1.1–2.8 h |
| 2 · first swap (likely) | ch7, ≈ 14,051 words | ≈ 1.1 h at ch8's rate |
| 2 · second swap | ch1, ≈ 17,860 words | ≈ 1.4 h at ch8's rate |
| 2 · one capture round | with the likely first swap; worst case with both | ≈ 1.6–3.9 h; worst case ≈ 5.3 h per round |
| 2 · with the one re-roll | a not-computed round, then a same-model re-roll of up to five more captures | worst case ≈ 10.6 h (two rounds of ≈ 5.3 h) |
| 2 · a capture-defect re-capture | only the chapters a re-walk reaches whose capture the defect affected | at most one more round, ≤ ≈ 5.3 h |
| 2 · hand-check | up to 30 owner judgements | owner time, no GPU |

`Result (step 2):` _______________________________________________________________

---

## 3. Closing the row

- [ ] The scan (step 1) is recorded, including the label outcome and, if the label stays provisional, which condition failed.
- [ ] The 1A outcome (step 2) is recorded and is **not** void and **not** not-computed.
- [ ] The tables, the verdict, the class report, the scan, who and when are posted on #2254.

`Done by / date:` _______________________________________________________________
