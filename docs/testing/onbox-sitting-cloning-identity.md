# On-box sitting pack — cloning + character-identity (A16, A18, A21, A22, A23, A31, A32)

> **Sitting pack** for wave 2 of `#2435`, step 6 of the `#2453` chain. Covers
> register rows **A16, A18, A21, A22, A23, A31, A32** —
> clone-derive, clone-readiness, `characterId` drift and resolution, Russian
> XTTS quality, and entity decode. The audition-centroid fix section this pack
> also carried (old A34/A35, #1969/PR #2402) is **discharged as of on-box wave
> 9** and removed from the register — kept below for historical context only.
> Follows the
> shared format fixed by [`onbox-sitting-plan.md`](onbox-sitting-plan.md) §5;
> the re-resolution rule of §6 was applied to every row (see
> [`## Excluded on re-resolution`](#excluded-on-re-resolution) — nothing was
> excluded).
>
> **A30 added 2026-08-20**, wave-3 step 9 of `#2497`, per
> `docs/testing/onbox-wave3-plan.md` §§2-3: its remaining debt is a
> real TTS render + human listening (§8.7) and/or a live-browser Cast-
> screen observation (§8.8) — neither is agent-runnable, and it is the same
> character-identity family already anchored here by A29, on the same real
> workspace. Wave-3 step 4 confirmed both verdicts by re-reading the plan's
> own citations; no new evidence was gathered beyond that re-resolution.
>
> **Correction, 2026-08-21 (wave 4, #2551 step 6).** **A43 is DISCHARGED and
> removed from this pack** — wave-4 step 5e ran it fully live in a real
> browser (positive link, dry-run count drop, and the negative case's both
> halves); see `onbox-acceptance-register.md`'s A43 history (retired from
> the register) for the evidence. **A30 §8.8 is also DISCHARGED** (same
> wave-4 step, live Cast-screen banner cross-check) and its step below is
> removed; **only A30 §8.7 (the real render + human listen) remains in this
> pack** — that is browser/audio work no agent can do, so it stays owed to
> the operator.
>
> **Box/card target:** the operator's GPU box, **single 8 GB card**, pinned
> via `CUDA_VISIBLE_DEVICES=0` (A29/A30).
>
> **Running time total (recomputed 2026-08-21):** **170 minutes** for the
> original eight rows (A23 ≈ 30, A25 ≈ 15, A28 ≈ 30, A29 ≈ 20, A39 ≈ 20,
> A40 ≈ 20, A41 ≈ 10, A42 ≈ 25 — matching
> [`onbox-sitting-plan.md`](onbox-sitting-plan.md) §2.1 exactly), **plus
> ≈ 15 minutes for A30 §8.7 alone** (one re-render + listen; §8.8's
> ≈ 15 minutes and A43's ≈ 20 minutes are discharged, dropped from this
> pack's total) — new total **≈ 185 minutes**.

## Preconditions

Stated once for the sitting; do not repeat per row.

- [ ] **Single 8 GB card.** `CUDA_VISIBLE_DEVICES=0`.
- [ ] **A real cloned voice, ingested WITHOUT a transcript**
      (`master.transcript === ''`) — A28's gate needs it in this state at the
      start of the sitting; A28 §4 fills the transcript in, and every later
      row that wants "a cloneable voice" (A23, A42) reuses the now-transcribed
      clone rather than a second ingest.
- [ ] **A non-English book** (A23, A40) — cast the clone above onto a
      character with dialogue in it. `ASR_DEVICE` and `ASR_COMPUTE_TYPE` must
      agree (a `cpu` device with a pinned `int8_float16` makes every
      `/transcribe` 500 — A23 needs a working `/transcribe`).
- [ ] **The real, already-affected workspace book for A29** —
      *Playing with Fire* (Derek Landy, Skulduggery Pleasant) at
      `C:\AudiobookWorkspace\books\Derek Landy\Skulduggery Pleasant\Playing with Fire`.
      Present and untouched — do not run the Wave-3 repair script or any cast
      edit against it before A29's section runs.
      **Back up `16-chapter-twelve-barfight.segments.json`,
      `19-chapter-fifteen-point-blank.segments.json`, and their `.mp3`s**
      before re-rendering, so a bad run can be reverted without re-importing.
- [ ] **An EPUB carrying named HTML entities** in its first-chapter heading
      and/or body (A40) — reuse the non-English book above if it qualifies,
      otherwise hand-substitute `&mdash;`/an accented named entity into a real
      chapter. Confirm one exists in the on-box corpus before the sitting.
- [ ] **A Russian book or line on the stock catalogue Coqui voice
      `Damien Black`** (A39) — no clone needed, every #2026 defect reproduces
      on it.
- [ ] **A genuinely static-FFmpeg box** for A25 — `ffmpeg` on PATH, no hot-
      patched FFmpeg DLLs inside `site-packages/torchcodec/` (confirm
      `import torchcodec` still fails; if it succeeds, the box has drifted
      back to hot-patched and A25 needs re-checking against register.md
      §A25 item 1's three verified preconditions before trusting the result).
- [ ] **A live sidecar and a book mid-render, plus OS-level process-kill
      access** (A41) — `taskkill`/Task Manager, ability to bind a foreign
      listener on `:9000`, ability to start a fresh sidecar manually, and
      ability to set `SIDECAR_NEVER_ADOPT` on the server process.
- [ ] **A30 §8.7 (added 2026-08-20):** the same *Заказ Коалфолла* real
      workspace book already staged for A29-adjacent work (`.audiobook/cast-
      id-history.json` should already carry `mayrin→mairin`,
      `coalfall→coalfall-dragon` from the wave-3 `--apply` run of 2026-08-05
      — confirm present before starting, do not re-run `--apply`).
- [ ] SHA and a clean tree recorded below.

SHA: `____________`  Clean tree: ☐  Date: `__________`  Run by: `__________`

## Procedure

Ordered so the Qwen-resident rows run first (A28 fixes the clone's transcript
that A23 and A42 then reuse), the same non-English book and cast id-drift work
ride the same Qwen residency, the engine swaps once into Coqui/XTTS for the
two Russian/Coqui-derive rows, and the disruptive sidecar-kill row (A41) runs
last, alone, since it deliberately crashes the sidecar twice.

### A21 · Cast-time clone-readiness gate — the fixes actually fix ([#1980](https://github.com/dudarenok-maker/Castwright/issues/1980), plan [276](../features/archive/276-cast-time-derivability-warning.md))

> **Criteria source:** [`clone-readiness-gate-onbox-acceptance.md`](clone-readiness-gate-onbox-acceptance.md)
> §§3–6 — cited, not restated. Re-resolved 2026-08-20: `gh issue view 1980` →
> closed 2026-08-01T04:11:06Z, matches. Plan 276 frontmatter `status: stable`.
> Run sheet's every `Result:` line (§§3–6) is still an unfilled blank, SHA/
> date/run-by line unfilled — no on-box run recorded. STILL OWED. Run **§4
> first** — it is the load-bearing section per the run sheet's own §1 note —
> and its "Add transcript" step is why this row runs before A23/A42: it
> converts the sitting's transcript-less clone into one with a real
> transcript, which those rows then use.

1. Run [`clone-readiness-gate-onbox-acceptance.md`](clone-readiness-gate-onbox-acceptance.md)
   §3 (the gate fires at cast time — Coqui assign, switch to Qwen, Approve
   cast, expect the gate).
   - Result:
2. Run §4 (Add transcript → gate clears → render a chapter → confirm the
   cloned voice actually speaks on Qwen, resolved voice key + by-ear listen).
   - Result:
3. Run §5 (force a genuine `derive-failed` slot, confirm **Retry derive**,
   confirm the predicate re-evaluates to the underlying cause rather than
   clearing to healthy).
   - Result:
4. Run §6 (control — switch back to Coqui, confirm **no gate** fires).
   - Result:

### A16 · A cloned voice renders a non-English book in the book's language (plan [275](../features/275-clone-voice-language.md), [#1951](https://github.com/dudarenok-maker/Castwright/issues/1951))

> **Criteria source:** `onbox-acceptance-register.md` A16 (plan 275
> §"On-box acceptance"). Re-resolved 2026-08-20: `gh issue view 1951` →
> closed 2026-07-30T04:26:44Z; `gh issue view 1972` → closed
> 2026-07-31T09:45:45Z (fixed by PR #1992, "refuse a splice when the render
> and analysis disagree on a segment's owner"); `gh issue view 1969` → closed
> 2026-08-16T03:56:07Z (fixed by PR #2402, "rebuild the audition centroid
> when a character's voice is reassigned"). Both blockers the row's own
> 2026-07-31 correction named are now resolved in code, but plan 275's own
> Ship notes still record Step 2 (self-heal → restart → identical) and
> Step 3/C-17 as **NOT RUN**, and no later run sheet or register annotation
> records a rerun of the chapter-level criterion, the restart check, or the
> QA `voice-mismatch` sub-check since #1972 and #1969 landed. STILL OWED.

5. **Chapter-level criterion.** Render one chapter of the non-English book
   (Preconditions) on the now-transcribed clone from A28. Transcribe the
   output through the sidecar's `/transcribe` with Whisper **auto-detect**
   (no `x-language`). **Pass = detected language is the book's, and
   `avg_logprob` is better than ≈ −0.5.** Reference points from the row's own
   prior measurements: pre-fix `en`/**−1.303**, with language corrected
   `de`/**−0.366**, a natively-designed German control **−0.201**.
   - Result (detected language / avg_logprob):
6. **Title beat.** Confirm the chapter title's `/synthesize` call (the one
   call in an otherwise batched chapter) also renders correctly — a
   regression here hides behind correct-sounding body audio.
   - Result:
7. **`resolvedVoiceName` never substitutes.** Confirm
   `characterSnapshots.<id>.resolvedVoiceName` is still the clone's storage
   key throughout.
   - Result:
8. **Self-heal / restart identical (Step 2, still NOT RUN per plan 275).**
   Render with a designed self-healed voice, restart the sidecar, render
   again. Confirm the two renders are audibly identical.
   - Result:
9. **QA `voice-mismatch` check, opportunistic (Step 3/C-17).** Open the
   chapter's QA report; confirm the cloned character has no `voice-mismatch`
   rows. Only reachable with a character thin enough on in-book anchors to
   trigger the audition fallback — treat as opportunistic within this same
   render, not something to engineer.
   - Result:

### Reassigning a character's voice no longer scores it against the old speaker's persisted audition centroid ([#1969](https://github.com/dudarenok-maker/Castwright/issues/1969), PR #2402)

> **Discharged 2026-08-27 (on-box wave 9)** — the register row this section
> tracked (`onbox-acceptance-register.md`, formerly A34, before that old A42)
> is removed from the register. Reassigned Ivo's voice on the real *The
> Coalfall Commission* book and re-rendered; all 8 of his lines came back
> `qa.status: 'ok'`, zero `voice-mismatch` flags, and the persisted centroid's
> old-voice `audition` reference was confirmed gone (not silently reused)
> rather than rebuilt. See the register's own wave-9 changelog entry for the
> full account. Kept below for historical context only — not re-runnable
> against a current row number.

10. Assign a character thin enough on in-book anchors to take the
    audition-reference path to one voice; render once so
    `render-integrity.centroids.json` persists an `audition` row.
    - Result:
11. Reassign the character to a clearly different, cloned voice (the A28/A23
    clone works); re-render.
    - Result:
12. Confirm the new voice's lines are **not** flagged `voice-mismatch`/
    `severe` — the persisted centroid was rebuilt for the new voice, not
    reused against the old speaker's.
    - Result:

### A22 · Cast/analysis `characterId` drift — Wave 1 resolver ([#2040](https://github.com/dudarenok-maker/Castwright/issues/2040))

> **Criteria source:** [`cast-id-drift-onbox-acceptance.md`](cast-id-drift-onbox-acceptance.md)
> §§3–5 — cited, not restated. Re-resolved 2026-08-20: `gh issue view 2040` →
> closed 2026-08-04T17:40:01Z, matches. The run sheet's §§3–6 `Result:` lines
> are all still unfilled blanks. §9 of that same run sheet (dated
> 2026-08-11) re-rendered a **different** book (*Заказ Коалфолла*, for the
> since-discharged A37 audio-currency row) — it does not touch *Playing with
> Fire* ch19/ch16, the fixture this row names. STILL OWED. No clone needed —
> switch the cast target to the *Playing with Fire* workspace book
> (Preconditions) while Qwen stays resident.

13. Run [`cast-id-drift-onbox-acceptance.md`](cast-id-drift-onbox-acceptance.md)
    §3 (re-render chapter 19 — `the-torment` recovery, `characterSnapshots`
    check, by-ear distinct-voice listen).
    - Result:
14. Run §4 (re-render chapter 16 — `lightning-dave` recovery **and**
    `pool-player-2` negative control in the same chapter).
    - Result:
15. Run §5 (Cast-screen banner cross-check — `the-torment`/`lightning-dave`
    no longer named; `pool-player-2` still named).
    - Result:

### A23 · Cast/analysis `characterId` drift — Wave 3 repair pass `--apply` run ([#2040](https://github.com/dudarenok-maker/Castwright/issues/2040), [implementation plan](../superpowers/plans/2026-08-01-cast-character-identity.md))

> **Criteria source:** [`cast-id-drift-onbox-acceptance.md`](cast-id-drift-onbox-acceptance.md)
> §8.7 — cited, not restated. **Added 2026-08-20**, wave-3 step 9, per
> `docs/testing/onbox-wave3-plan.md` §2. The write path (`--apply`) is
> already DISCHARGED (register row A30, run 2026-08-05) — **do not re-run
> `--apply`**. **§8.8 (Cast-screen banner cross-check) was DISCHARGED live
> by wave-4 step 5e, 2026-08-21** — removed from this pack. Only §8.7 (does
> the fix reach actual audio) remains owed, because it needs a real render +
> human listening — not agent-runnable. Same book/Qwen residency as A29
> above.

26. Run §8.7 — re-render *Заказ Коалфолла* chapter 2 (the `mayrin`/`coalfall`
    orphaned chapter) and confirm the fresh `segments.json` gains
    `characterSnapshots` entries for `mayrin`/`coalfall` naming their own
    live voices, not the narrator. **Listen** to confirm audibly — this is
    the criterion, not just the JSON.
    - Result:

### A32 · Named-entity decode reaches the TTS engine on a real EPUB ([#2310](https://github.com/dudarenok-maker/Castwright/issues/2310), PR #2316)

> **Criteria source:** `onbox-acceptance-register.md` A40. Re-resolved
> 2026-08-20: `gh issue view 2310` → closed 2026-08-13T04:25:10Z; `gh pr view
> 2316` → merged 2026-08-13T04:43:29Z, title matches ("widen named-entity
> decode to the full HTML5 set"). Every layer proved only by unit/e2e tests
> fixing the sentence text explicitly — no run sheet or dated result under
> `docs/testing/` for a real EPUB. STILL OWED. Rides on the non-English book/
> EPUB staged in Preconditions — still the same Qwen/book residency as A23.

16. **Chapter-title beat (design spec Finding 0 — the one criterion no model
    behaviour can mask).** On the EPUB whose first chapter heading carries
    named entities (e.g. `<h1>L&rsquo;&Eacute;t&eacute;</h1>`), confirm the
    spoken title beat says "L'Été" cleanly — no "ampersand … semicolon", no
    gibberish.
    - Result:
17. **Body-line entity, secondary.** On the same or a second es/fr/ru EPUB
    with named entities in body text, confirm a dash-opened dialogue line
    renders with a pause (not "ampersand n dash semicolon" spoken aloud),
    accented words render as the correct letters, and the manuscript view
    shows real glyphs. Record whether this symptom reproduced at all
    pre-fix — per the design spec, that is new information about the
    analyzer chain, not a gate on this fix.
    - Result:

### A31 · Russian XTTS quality — leading-dash pause by ear, Coqui degeneracy guard live, neuter -ее invariant ([#2026](https://github.com/dudarenok-maker/Castwright/issues/2026), PR #2050)

> **Criteria source:** [`fs38-wave3-onbox-acceptance.md`](fs38-wave3-onbox-acceptance.md)
> `#2026 — additional acceptance criteria: Russian XTTS quality` section
> (`:2657-2667`) — cited, not restated. Re-resolved 2026-08-20: `gh issue view
> 2026` → still **OPEN**; `gh pr view 2050` → merged 2026-08-01T03:16:56Z,
> title matches ("pause on a leading dash, add coqui degeneracy guard"); `gh
> issue view 2057` → closed 2026-08-11T02:48:19Z (that issue only tracked
> reconciling the register with this row, not running the acceptance). The
> cited run sheet section's `Result:` line is still the unchecked
> `☐ P ☐ F ☐ B ☐ N/A` template. STILL OWED. **First row in this sitting that
> wants Coqui/XTTS resident instead of Qwen — the one engine swap in this
> pack.** No clone needed; switch to the stock catalogue voice `Damien Black`.

18. Run the cited section's item 1 (leading em-dash pause, by ear — compare
    against no-leading-punctuation and interior-dash controls; reference
    points +0.14 s / +1.53 s).
    - Result:
19. Run item 2 (`tts.coqui.degenGuard` live — confirm no false-positive on
    ordinary short Russian lines; if a live collapse can be captured, confirm
    whether the retry recovers it — a negative on the recovery half may be
    correct behaviour per the guard's own docstring, not a failure).
    - Result:
20. Run item 3 (neuter `-ее` standing invariant — confirm it still
    reproduces on `main`; this is a baseline record, not a sign-off).
    - Result:

### A18 · Cloned-voice derive on Coqui no longer needs torchcodec ([#1967](https://github.com/dudarenok-maker/Castwright/issues/1967))

> **Criteria source:** `docs/superpowers/specs/2026-07-31-xtts-clone-torchcodec-ffmpeg-design.md`
> §12; `onbox-acceptance-register.md` A25 items 1–4. Re-resolved 2026-08-20:
> `gh issue view 1967` → closed 2026-07-31T06:06:03Z, matches. Items 1 and 3
> are already DISCHARGED (register.md:1152-1184, pasted command output) —
> **not re-run here.** Item 2's audible half and item 4 remain STILL OWED.
> **Item 4 (Pinokio `import torchcodec` check) is explicitly batched with row
> E1 in `onbox-sitting-device-browser.md`, which already owns the Pinokio
> box — not run in this sitting.** Only item 2 runs here, on the same
> static-FFmpeg box confirmed in Preconditions, same Coqui residency as A39.

21. **Item 2 — latent equivalence, audible half.** Decode equivalence was
    already measured bit-identical (max difference 0.0) during PR #1978's
    review — not re-run. Derive the same cloned voice with and without the
    `patched_xtts_load_audio()` wrap, on this genuinely shared-FFmpeg box,
    and confirm the rendered output is equivalent by ear.
    - Result:

### A34 · Respawn budget deadline and exhaustion under sustained refusal ([#2106](https://github.com/dudarenok-maker/Castwright/issues/2106), PR #2398)

> **Criteria source:** `onbox-acceptance-register.md` A41 — full scenario
> text already spelled out there (`:2473-2496`), cited not restated except
> for the exact commands below. Re-resolved 2026-08-20: `gh issue view 2106`
> → closed 2026-08-16T03:05:14Z; `gh pr view 2398` → merged
> 2026-08-16T03:05:13Z, title matches ("bound the sidecar respawn budget on
> the refusal path"). Unit tests fully verify the accounting logic but
> cannot reach the real race — no run sheet under `docs/testing/` covers
> #2106/PR #2398 at all. STILL OWED. **Run last, alone** — both scenarios
> deliberately kill the sidecar process, which would otherwise disrupt every
> row above that depends on a stable warm engine.

22. **Scenario 1 — supervisor crash-loop cap.** With a chapter actively
    rendering, kill the sidecar's OS process directly (`taskkill /PID <pid>
    /T /F` against `.run/tts.pid`, or Task Manager — **not**
    `POST /api/sidecar/restart`). Immediately start a foreign, non-HTTP-
    conformant listener on `:9000` (e.g. `nc -l 9000`). Grep the server log
    for the supervisor's refusal counter advancing monotonically (1, 2, 3,
    4, 5) across the `[sidecar] supervisor: spawn refused: ...` lines, then
    for the exhaustion log `[sidecar] supervisor: <N> rapid spawn refusals
    ... — giving up respawn.` once exhausted.
    - Result (counter advanced 1→5, no reset):
    - Result (exhaustion log seen):
23. **Scenario 1 recovery.** Stop the foreign listener, then
    `POST /api/sidecar/restart`; confirm the sidecar respawns and surfaces
    ready on `GET /api/setup/models-status`.
    - Result:
24. **Scenario 2 — deadline timer for a hung PID probe.** Set
    `SIDECAR_NEVER_ADOPT=1`, start a fresh sidecar manually
    (`cd server/tts-sidecar && python main.py`) so the server doesn't own
    its PID, then start the server with a chapter rendering. Grep the log
    for the `UNFIT sidecar on :9000 ... replacing it` message and confirm
    the PID lookup completes well under the 5000 ms deadline (no
    deadline-timeout message on a responsive box). Confirm the new sidecar
    becomes owned (`.run/tts.pid`) and surfaces ready.
    - Result:
25. **Scenario 2 cleanup.** Unset `SIDECAR_NEVER_ADOPT` (or set back to its
    prior value) and restart the server so the next sitting adopts a
    healthy pre-existing sidecar normally.
    - Result:

## Excluded on re-resolution

None excluded. All ten rows were re-resolved against live repo/issue/PR
state and the plan-of-record/run-sheet files themselves on 2026-08-20 and
remain owed:

- **A30** — write path (`--apply`) already DISCHARGED 2026-08-05, not
  re-litigated. §8.7 (render + listen) and §8.8 (Cast-screen cross-check)
  re-confirmed still owed by wave-3 step 4/9 (re-read the plan's own §2
  citation, nothing new found). §8.8 was subsequently DISCHARGED live by
  wave-4 step 5e (2026-08-21); only §8.7 remains, STILL OWED, OPERATOR-only.
- **A43** (historical, as of 2026-08-20) — #2238's acceptance criterion 5 is
  explicitly "linked through the UI"; wave-3 step 4/9 confirmed no
  API-only substitute exists anywhere in the row's own text. STILL OWED
  as of that re-resolution. **DISCHARGED live by wave-4 step 5e
  (2026-08-21)** — removed from this pack's procedure; see the correction
  note at the top of this file.

- **A23** — `gh issue view 1951/1972/1969` all closed as the row describes;
  plan 275 Ship notes still record Step 2 and Step 3/C-17 as NOT RUN, no
  rerun since #1972/#1969 landed. STILL OWED.
- **A25** — `gh issue view 1967` closed, matches. Items 1/3 already
  DISCHARGED in the register text (not re-litigated); item 2's audible half
  and item 4 (batched with E1) remain unrun. STILL OWED.
- **A28** — `gh issue view 1980` closed, matches; plan 276 `status: stable`.
  Run sheet's every `Result:` line still blank. STILL OWED.
- **A29** — `gh issue view 2040` closed, matches. Run sheet §§3-6 blank; §9's
  2026-08-11 run covers a different book for a different (discharged) row.
  STILL OWED.
- **A39** — `gh issue view 2026` still **OPEN**; `gh pr view 2050` merged,
  matches; `gh issue view 2057` closed but only reconciled the register, not
  the acceptance. Cited run-sheet section's Result line still the unchecked
  template. STILL OWED.
- **A40** — `gh issue view 2310` closed; `gh pr view 2316` merged, matches.
  No run sheet or dated result anywhere for a real EPUB. STILL OWED.
- **A41** — `gh issue view 2106` closed; `gh pr view 2398` merged, matches.
  No run sheet under `docs/testing/` at all. STILL OWED.
- **A42** — `gh pr view 2402` merged, matches. Only mock/unit coverage
  exists; no run sheet. STILL OWED.

None of the rows is AMBIGUOUS (that is A2/A16's queue, not this
pack's — the former A22 this note also used to name was retired 2026-08-21,
see `onbox-acceptance-register.md`'s wave-4 correction note) — every cited
plan/issue/PR agrees with its own row text, unlike
A16's genuine frontmatter-vs-body contradiction handled in
`onbox-sitting-vram-contention.md`.

## Teardown

- [ ] Evict Qwen (Base + VoiceDesign) and Coqui/XTTS so the next sitting
      starts cold.
- [ ] Confirm `SIDECAR_NEVER_ADOPT` is unset (A41 Scenario 2 cleanup) and the
      server has been restarted at least once since.
- [ ] Confirm no foreign listener is still bound on `:9000` (A41 Scenario 1).
- [ ] Restore the *Playing with Fire* workspace book from the backups taken
      in Preconditions if either re-render (A29 §§13-14) needs reverting, or
      confirm the new state is intentionally kept.
- [ ] Confirm *Заказ Коалфолла* ch2's re-render (A30 §8.7) is intentionally
      kept or reverted — same backup-before-reverting discipline as A29.
- [ ] Confirm any A25 static-FFmpeg-box changes (env vars, PATH) are left as
      found.
- [ ] Confirm the card returns to baseline (`nvidia-smi` ≈ idle) before
      ending the sitting.
