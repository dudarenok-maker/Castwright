# On-box acceptance register

Shipped behaviour that can only be proven on real hardware — a live GPU, a real
sidecar, a real analyzer, a real book, a real phone — and that was **not** proven
at PR time.

A row here is a debt: the code is merged and users have it, but nobody has
watched it work. Empty register = done.

`npm run check:onbox-register` (CI: `.github/workflows/onbox-register-check.yml`,
ops-43) mechanically checks this file's own internal arithmetic — glance-table
counts against body row headings, and the stated total against the glance
table — on every PR that touches it. It cannot tell you a row is missing,
only that the ones already here don't add up.

This exists because complex work routinely cannot be accepted inside its own PR.
The box is often contended, an acceptance run can take hours, and a PR should not
sit open waiting for one. **Owed acceptance never blocks a merge — it converts
into a row here.** What is not acceptable is the debt evaporating silently, which
is exactly what happened before this file existed: the sweep that produced this
register found debt going back to **2026-06-01** recorded nowhere but in plan-doc
prose.

## Live view (update this, never re-publish)

<!-- CANONICAL ARTIFACT — do not mint a new one. -->

**https://claude.ai/code/artifact/adf22b7b-12dd-49fe-874c-4a340585b26a**

The page at that URL is rendered from **one specific file in this repo**:

> ### [`onbox-acceptance-register-live-view.html`](onbox-acceptance-register-live-view.html)
>
> Publish **that** file, with the URL above passed as `url`.

Artifact URLs are server-assigned UUIDs — they cannot be renamed, aliased, or
re-slugged — so **that exact URL is the artifact's identity**. Publishing
without it mints a *second*, competing register and orphans this one.

**The live view is a hand-authored HTML page, not a rendering of this file —
never publish this `.md` to that URL.** Passing the right `url` is *not*
sufficient. Publishing this markdown keeps the URL and destroys the page,
replacing the styled register with default markdown rendering: no summary strip,
a self-referential "Live view" section, and dead relative links. **Nothing errors
when this happens.** It happened four times between 2026-07-31 and 2026-08-01, to
four different PR-shipping agents that each read a paragraph like the one above
and concluded they had complied. The live view is tracked in this repo — rather
than living in whichever session scratchpad last built it — precisely so the
right file is always to hand.

The live view carries derived figures — owed count, per-group counts, oldest
debt — that must be **recomputed** on every edit. Rows can be right while the
summary strip lies. `npm run check:onbox-register` verifies the owed total, the
per-group counts and the row IDs across both files, so **adding or removing a
row here and missing the live view fails CI**. Know its edges, because two of
them are wide:

- **A wording-only edit does not fail.** Rewording a row, recording a run
  result, changing a hardware note or a criteria link — the most common edit
  this register gets — changes nothing the check compares. The live view mirrors
  that prose in its own row bodies and will silently fall behind.
- **The rest of the summary strip is unchecked** — oldest debt, and the
  group/blocked/unconfirmed tallies. Recompute those by hand.
- **The published page is invisible to `check:onbox-register`'s no-flag run.**
  It only ever reads the two TRACKED files, so "was it published at all, and
  was it the right file?" is procedure, not that gate — see the merge step
  below, which gives the specific stale-snapshot race mechanical teeth via a
  second, explicit mode, but still can't verify by itself that someone ran it.

**The concurrency hazard this closes (#1931).** Before the live view was
tracked here, on 2026-07-28 two concurrent sessions each correctly added a
different row (A20, E8) and republished from their own hand-built snapshot —
the second republish was built from a snapshot taken *before* the first
session's row had landed, so the surviving page had one row present and the
other silently gone, with nothing to notice. That was possible because the
live view lived nowhere but a session's own build of it. Tracking both files
in git and gating their agreement via `npm run check:onbox-register` on every
PR closes the git-side half: the live view a PR merges is no longer a
hand-built snapshot racing another session's, it is the file *inside* the
merge, checked against this register before either can land.

**The residual hazard, and the merge step that closes it.** Git-side safety
does not by itself close the ORIGINAL incident, because publishing is a step
that happens *after* merge, outside git — so the same race reopens one level
up. Two lanes can each merge a correct, agreeing live-view edit: git resolves
both rows into the tracked `.html`, and `check:onbox-register` is green on
both PRs. Lane A publishes its merge. Lane B, having fetched/built its own
copy of the *published* page before A's merge landed, publishes from a build
that is now stale relative to what's live — and the artifact loses A's row
again, invisibly, exactly like 2026-07-28, because the no-flag
`check:onbox-register` run only ever compares the two TRACKED files; the
published page itself is outside its reach (no network access from a required
CI check — the same call this design already made for the tracked-pair
comparison, see the edge list above). The merge step that closes this, run
**immediately before every publish**, not only after a suspected race:

1. Fetch the page currently live at the canonical URL above and save it to a
   local file — this is the CURRENTLY-published register, which may be ahead
   of what you are about to publish.
2. Run
   `npm run check:onbox-register -- --against-published <saved-file>`. Unlike
   `check:onbox-register`'s no-flag run, this comparison is deliberately
   ONE-DIRECTIONAL: your register having rows the live page doesn't have yet
   is the normal reason you're publishing, not a defect, so it is never
   reported here. A row (or group) the live page has that your register
   lacks is reported ONLY when `origin/main`'s own copy of this register
   still has it too — the signature of another lane having already
   published ahead of you. When `origin/main` also lacks it, the row was a
   deliberate discharge (by this change or an already-merged one), not a
   race, and is not reported: discharging a row (and, since rows renumber
   contiguously, often renumbering the survivors) always makes the
   still-live page look "ahead" of your working copy in this exact shape,
   and that is expected. **The command fetches `origin/main` itself, fresh,
   every run — you do not need to `git fetch` by hand first.** It then reads
   `FETCH_HEAD`, deliberately NOT the local `origin/main` ref: `git fetch
   origin main` only guarantees it writes `FETCH_HEAD` — whether it also
   updates `refs/remotes/origin/main` depends on this checkout's
   `remote.origin.fetch` refspec actually mapping `refs/heads/main`, which a
   narrowed refspec can skip while the fetch still exits 0, leaving
   `origin/main` silently stale even though the fetch just "succeeded". If
   you ever need to reproduce this baseline by hand for debugging, run
   `git fetch origin main` followed by `git show FETCH_HEAD:<path>` — NOT
   `git show origin/main:<path>`, which can read stale (or, in a narrowly-
   configured clone, entirely unresolvable) content even immediately after a
   successful fetch. It follows that this step needs network access to
   `origin`, with no offline fallback: you're about to publish to a remote
   URL anyway, so an operator who can't reach the network here can't
   complete step 4 either.
3. **If it fails**, do NOT publish. There are two distinct failure shapes,
   named in the error text:
   - **A row/group named as already live and BEHIND** — this message has TWO
     different causes, and they need opposite fixes; check which one applies
     before you act:
     - **Another lane's row, already merged into `main`.** Pull the latest
       `main` (the row that's already live should already be merged there
       via its own PR), confirm `npm run check:onbox-register` (no flag) is
       green, and re-run step 2 against the SAME saved copy from step 1 to
       confirm it now passes. It should — `main` pulling in the missing row
       is what resolves this, not another fetch of the live page.
     - **Your OWN change discharged this row, and it just hasn't merged
       yet.** Publishing (step 4) happens BEFORE this PR merges to `main` —
       that is the normal order, not a mistake — so `origin/main` cannot yet
       know your branch removed the row: the baseline can only recognise a
       discharge that has already landed there. Every pre-merge discharge
       therefore trips this exact same message, and pulling `main` will not
       help (there's nothing to pull yet). Instead, re-run step 2 with
       `--discharging <ID>[,<ID>...]` naming the row(s) you deliberately
       removed, e.g. `npm run check:onbox-register -- --against-published
       <saved-file> --discharging E10` or `--discharging E10,E11` for more
       than one.

       **The rule for which IDs to name is arithmetic, never trial-and-error:
       name exactly as many IDs from a group as rows you actually discharged
       from that group — never "whichever IDs the error message lists," and
       never "keep adding IDs until the command goes green."** Padding
       `--discharging` until the check passes is the exact failure mode this
       check exists to catch (the #1931/A44 incident this whole mechanism was
       built to close): a group with one genuine competing-lane addition on
       top of your own discharge will always leave one leftover ID after you
       have named your true count, and appeasing that leftover — naming it
       too, just because the check is still red — silently deletes another
       lane's live row at publish time. **If, after naming your true count
       for a group, the check still reports a leftover for that group, STOP.
       Do not name that ID too.** It is not yours to discharge: another lane
       published a row into that same group, and the fix is to merge it in
       (see "Another lane's row, already merged into `main`," above) before
       you publish — not to add its ID to `--discharging`. The tool's own
       error text already says this ("merge it in before publishing"); when
       the doc and the tool disagree, trust the tool, not the instinct to
       make it stop complaining.

       Two shapes, both governed by that same count rule — knowing which one
       you're in tells you how the IDs will be spelled, not how many to name:
       - **A middle row of a group that still has survivors (the
         renumbering wrinkle).** Rows renumber contiguously within a group,
         so discharging a MIDDLE row does NOT make that row the one
         reported — every row after it shifts down to fill the gap, so it's
         the group's HIGHEST id that vanishes from the live page instead. If
         your true count for this group is 1, the single ID the error names
         is correct — but it's correct *because your true count is 1*, not
         because the error said so. If your true count is N, expect to name
         N ids this way (the shifted id can change each time you re-run);
         never name an (N+1)th id just because the check is still red after N.
       - **A whole group with NO survivors left** — e.g. discharging a
         single-row group's only row (Group F's sole row, F1, is a real,
         live example of exactly this shape). There is nothing left to
         renumber, so every row the group's live-page section still lists
         reads as live-only. Name exactly the rows you discharged — for a
         one-row group, that's one ID, not "every ID the error currently
         lists for this group." A second live-only ID surviving after you've
         named your one is proof another lane independently published into
         the same now-otherwise-empty group, not evidence you actually
         discharged two rows.

       Either way, naming an ID that turns out not to be live-only at all (a
       typo, or copied from the wrong discharge) is itself a refusal, not a
       silent no-op — the point is to keep a genuinely competing-lane row
       from slipping through unreported, not to mute the check wholesale.
   - **"Cannot verify"** — the check refuses to guess whether an extra row
     is a discharge or a race, and fails closed instead. This is NOT the
     same as the register being behind: pulling `main` on your own machine
     doesn't fix it, in either of the two shapes below.
     - **A git call failed** — the command's own `git fetch origin main`, or
       the `git show FETCH_HEAD:<path>` that reads what it just fetched,
       failed (network unreachable, no credentials, `origin` misconfigured
       or unresolvable, a timeout). The error names which one
       (`fetch` or `show`) — run that command by hand to see the underlying
       error, fix whatever it reports (network, auth, the remote), then
       re-run step 2.
     - **No git call failed, but the baseline is malformed** — `origin/main`'s
       OWN copy of this register is internally inconsistent (a count
       mismatch, a contiguity gap, a duplicate group letter, a sub-lettered
       row heading, a glance-table row with no matching body section, ...),
       so the fetch and the read both succeeded but the content they got
       back can't be trusted. The error names no `fetch`/`show` failure in
       this shape — that absence is itself the signal. Run
       `npm run check:onbox-register` against a checkout of `main` (not your
       branch) to see which specific check fails, then fix THAT on `main`
       first (its own PR) before retrying step 2 here — this can't be fixed
       from your branch, only from `main`.

   **Known limitation:** a row that's live and still genuinely owed but was
   never actually merged into `main` at all (e.g. published straight from a
   branch that never merged, or from a PR later reverted) is not
   distinguishable from a deliberate discharge — it silently reads as
   discharged rather than being flagged. Accepted trade-off, not an
   oversight; see `checkLiveView`'s own header comment in
   `scripts/check-onbox-register.mjs` (#2199 review round 3, A3).
4. Only once step 2 passes, publish the tracked `.html`, with the canonical
   URL above as `url`.

This is deliberately a MANUAL procedure with mechanical support, not a fully
automatic gate: CI cannot run it (no credentials to fetch the published
artifact, and a network dependency inside a required status check is its own
failure mode). `--against-published` exists so step 3's "does the live page
have something I don't?" judgement is a command's exit code, not an
eyeballed diff — it does not, and cannot, make the four steps happen on
their own. An early version of this check compared both directions
symmetrically, which inverted the diagnosis (failed on every ordinary
publish and told the operator to delete the rows they were about to ship) —
fixed before this landed. A later version still fired on every legitimate
row discharge, because removing a row is invisible in that same direction
too: the still-live page always looks "ahead" of a register that just
discharged a row from it. It now disambiguates the two by checking whether
`origin/main`'s own copy of the register also lacks the row before reporting
it (#2199); see the `checkLiveView` function's own header comment in
`scripts/check-onbox-register.mjs` for the reasoning. The `origin/main` copy
that comparison reads is fetched fresh by the command itself immediately
before reading it, not taken from whatever the local `origin/main` ref
already happened to point at — an operator whose local ref predated a merge
would otherwise see that merge's row as absent from both their own register
and their stale baseline, which reads identically to a deliberate discharge
and would have let the exact #1931 race straight back through. See
`resolveBaselineText`'s own header comment in
`scripts/check-onbox-register.mjs` for that half of the reasoning.

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
- **All three surfaces move in the same PR** — this file, the per-feature run
  sheet, and the live view above. Recording the state is a merge gate even
  though *running* the acceptance is not.

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

> **A precondition missing from an isolated worktree is not a missing
> precondition, 2026-08-21.** Worktrees deliberately carry no secrets and no
> pre-seeded fixtures by design — a `GEMINI_API_KEY` absent from a worktree's
> `server/.env`, or a workspace with 0 books, says nothing about whether the
> credential or fixture exists elsewhere. Recording a row as "blocked: no
> such credential/fixture exists" from inside an isolated worktree is a
> category error (B1 and C1 both carried exactly this error before being
> corrected the same day). The honest record from an isolated run is "not
> available **to this run**," never "does not exist" — leave the actual
> existence question to whoever runs from an environment that can see it.

---

## At a glance

| Group | Setup | Rows |
|---|---|---|
| **A** | The GPU box (single 8 GB for most; the 2-card boot for a few) | 45 |
| **B** | Local Ollama analyzer only, no TTS sidecar | 2 |
| **C** | One *Ночной дозор* re-analysis session | 4 |
| **D** | Multi-language TTS render + ASR | 3 |
| **E** | Not the GPU box (a phone, a Mac, a browser) | 9 |
| **G** | GitHub Actions itself (no physical hardware — the runner IS the prerequisite) | 2 |
| **H** | No hardware — needs a real CJK manuscript (all-kana, and full-length Han), not yet in this repo's corpus | 2 |
| — | **Blocked** (hardware absent) | 5 |
| — | **Unconfirmed** (not debts until substantiated) | 2 |

**67 owed.** Oldest: **2026-06-01** (plans 160, 161, 165) — unaffected by this wave; A14/A15 (the oldest debt) were not touched.

> **Correction, 2026-08-22 (merge with `main`, #2551 wave 4 close-out).**
> **66 → 67.** Two independent changes landed on `main` while this branch
> worked in isolation, both folded in here. First, PR #2585 (commit
> `02dcb5cf`, merged 2026-08-21) discharged and removed the Cast/analysis
> `characterId` drift row (`main`'s B3, this branch's B2,
> [#2040](https://github.com/dudarenok-maker/Castwright/issues/2040)) after
> [#2536](https://github.com/dudarenok-maker/Castwright/issues/2536)'s
> fix (PR #2562) landed. Per the repo owner's ruling that discharged rows are
> removed outright, not annotated (2026-08-22), that row is dropped entirely
> rather than merged in with an outcome note — its evidence lives in
> `docs/testing/onbox-wave4-results/step-7-b3-b4-rerun.md` and the run sheet
> `cast-id-drift-onbox-acceptance.md`, not in this file. The survivor,
> *Stage-1 returns cast names in the manuscript's own script*
> ([#2313](https://github.com/dudarenok-maker/Castwright/issues/2313)), renumbers
> B3→B2; its sibling row's own remaining defect (new id-survivor, `#2584`)
> **stays owed**, unaffected. **B** 3→2. Second, PR #2588 (closes
> [#2586](https://github.com/dudarenok-maker/Castwright/issues/2586), merged
> 2026-08-22) added a new row for the `speaker-qa.txt` reqHash fix's
> one-time real-venv `pip-in-place` reinstall (both hash producers,
> `venv-migration.mjs` and `zip-validate.ts`) — behaviour only a real venv
> can prove. That row landed on `main` as A48 (appended after the old,
> pre-wave-4 A47); folded into this branch's contiguous renumbering it
> becomes **A45**, immediately after this wave's last surviving A row (A44).
> **A** 44→45. Total re-derived by counting `###` group headings in the
> merged body (not by arithmetic subtraction): **66 → 67.** No other group
> changed.

> **Correction, 2026-08-21 (wave 4, #2551 step 6).** Old total **74** →
> new total **67**. Arithmetic: **A** 47→44 (−3: A22 retired, A27
> discharged, A43 discharged — see their former rows' evidence in each
> section's history); **B** 4→3 (−1: B2 retired — steps 1-6 discharged wave
> 3, step 8 discharged live this wave, step 7 moved to Blocked); **E** 11→9
> (−2: E6 and E8 moved to Blocked — hardware not available); **F** 1→0,
> group removed entirely (Android companion app v1 confirmed live end to
> end by the repo owner, 2026-08-21 — see plan 188's Ship notes). **C, D, G,
> H unchanged.** Rows renumbered contiguously within each shrunk group per
> this file's own convention (old A23→A22 … old A47→A44; old B3→B2, old
> B4→B3; old E7→E6, old E9→E7, old E10→E8, old E11→E9) — cross-references
> throughout the body were updated to match. **Not a retirement, only a
> correction/shrink, so no count change:** A2 (rows 6-8 ruled not owed by
> the repo owner, row narrows to step 9 alone), A16 (stale ⚠️ dropped), A29
> (renamed A27; blocker re-derived live, unchanged disposition), A31 (was
> A33; §8.8 discharged, §8.7 stays owed), A38 (was A40; partially run,
> stays owed), B1 (blocker corrected), C1 (blocker corrected), E4 (blocker
> corrected — box contention, not hardware), E5 (1 of 4 controls
> discharged), E6-new (was E7; further split), G1 (debt 1 discharged, debt
> 2 stays owed). **Blocked** 2→5 (+3: B2-step-7's CPU-only
> `RAM_HEAVY_MODELS` clamp, E8, E6). **Unconfirmed** unchanged at 2.

> **Correction, 2026-08-20 (rework of wave-3's own recording, `#2497`).** These
> totals were rechecked against wave 3's actual dispositions rather than left
> unchanged: A29 (renumbered A27 this wave) was mislabeled DISCHARGED (see its row) and is corrected here
> to STILL OWED, so it does **not** leave the owed count — 74 is unchanged,
> not stale. No wave-3 row's disposition otherwise moves a row into or out of
> this count; E7 (renumbered E6 this wave)'s rendered half moving from the
> wave-3 agent-runnable set to
> the operator's `onbox-sitting-device-browser.md` pack (see E6's row) is a
> re-binning within the 74, not a change to the total. Same arithmetic-check
> pattern as `onbox-sitting-plan.md`'s own 2026-08-20 correction.

> **Recompute, 2026-08-21 (wave-4 step 8, A37/A38/A39 re-run, `#2569`).** A39's
> filed defect is fixed and independently verified (see its row). The box-level
> CUDA 12.4 vs. CUDA 13.x/cuDNN 9.x gap (`#2534`) has been resolved by PR #2576
> (which re-pinned `ONNXRUNTIME_GPU_CONSTRAINT` to `>=1.26,<1.27`), and the
> shared Kokoro GPU-provider sub-check for A37/A38 was re-run against the fixed
> pin (wave-4 step 8, 2026-08-21) — but **still fails on a different, distinct
> root cause**: `onnxruntime-gpu` 1.26.0 requires `nvidia-cudnn-cu12~=9.0` via
> its optional `[cudnn]` extra, which `install-ort.mjs` never requests. A39's
> row accordingly remains STILL OWED on the same basis (the shared re-check still
> fails, same new root cause), and so does A37 (see their rows for the detailed
> re-run findings and evidence). This does **not** leave the owed count — 67 is
> recomputed fresh here, not carried forward, and stays unchanged.

---

## Group A — the GPU box

Most rows need only a **single GPU with Qwen resident**. A few specifically need
the **2-card boot** (8 GB RTX 4070 + 16 GB RTX 5070 Ti over OcuLink) — and the
eGPU is **not hot-pluggable**, so do all 2-card work in one sitting and all
single-card work in another rather than interleaving.

### A1 · fs-38 Wave 3 — voice cloning (now incl. 3c) · **20 of 60 run (2026-07-29, 2026-07-31) · ~40 still owed · 3 run-2 results retracted**

**Partially discharged.** First execution 2026-07-29 by Claude Code on the
dual-GPU box, SHA `2503bca6`, clean tree, real sidecar + real Qwen weights, no
mock mode. **16 tests executed: 15 pass, 1 blocked.** Results are recorded in
the run sheet `docs/testing/fs38-wave3-onbox-acceptance.md` (§2 preconditions
filled, per-test `Result:` lines and §7.1 completed for the tests run). PR #1837
shipped the template (3a/3b1/3b2, 51 tests); Wave 3c added **Section E** (9
tests) — 6 of 9 now run across runs 2 and 3, E-03/E-06/E-07 still owed; see
below.

**The run found one Critical defect, now fixed.** Every freshly cloned Qwen
voice returned HTTP 500 on its first synthesis until the sidecar restarted —
including the clone wizard's own completion-screen audition, i.e. the first
thing a user does after cloning. `clone_voice` cached a bare prompt where
`_load_voice_prompt` unpacks a `(prompt, language)` tuple
(`ValueError: not enough values to unpack`). Filed as **#1941**, fixed in
**PR #1942**, verified live on-box (clone → immediate synth in the same process
now returns 200). *This is the case for this register existing:* the feature's
central path was broken on shipped `main`, and no automated suite could see it
because unit tests mock the engine and no pytest exercised clone→synth in one
process against the real cache.

**Discharged (do not re-run):** A-01…A-06 (ingest + the full quality-gate tier
set — including the 60s truncation landing at 2,880,044 bytes, delta 0), A-10
(write-time consent guard: 422/400/404, nothing written), A-11 (`/revoke`
stamps `revokedAt`, rest of consent intact, entry survives), A-12 (sample route
403s a revoked clone, healthy control 200), B-01 (route + on-disk half —
UI assertions still owed), B-04 (ECAPA cosine is real: three distinct finite
values, two clones of the same fixture gave 0.8914 vs 0.8813 — not a mock
constant), B-07 (assign writes both qwen **and** coqui slots per Task 24, drops
the stale `variants` map, leaves `voiceUuid` untouched; all 13 characters
diffed, only the target changed), **C-10** ⭐ (total erasure on revoke — 7
artifacts across 3 locations all gone including both cached mp3s and the
original recording; wildcard sweep 0 files; entry + `voice.json` survive with
`revokedAt`), **C-11** (409-with-usage then `{deleted:true}`, entry dir removed,
both cast slots cascade-cleared), C-19 first half (1.7B tier renders a cloned
voice; its erasure is covered by C-10).

**Also proven — the wave's central claim, measured not asserted.** A cloned
voice renders inside a real book: `wren`'s segments re-recorded into Coalfall
ch.3, `characterSnapshots.wren.resolvedVoiceName` = the clone's storage key,
segments carrying `asr.verdict: ok` / **WER 0**. Speaker identity via the
production `/embed`: 20s audition vs human source **0.822**; in-book segments
**0.564** and **0.706**; designed-voice control **0.158**. The by-ear
confirmation (B-03, E-06) is still owed — a human must listen.

**Resolved without on-box acceptance — B-06 (#1945, 2026-07-30).** B-06's own
measurement was already conclusive: the clone-fidelity cosine scores
clone-vs-source *faithfulness*, so degrading the source degrades the clone
equally and the number does not fall (measured: clean 0.891, band-limited
0.881, two speakers overlaid 0.773; a genuinely different speaker measured
0.158). **Disposition:** `CLONE_FIDELITY_MIN = 0.3` is kept as a documented
catastrophe-only backstop, not recalibrated or deleted — see
`server/src/tts/clone-fidelity.ts`'s header comment. B-06's manual step (which
could never pass as written) is retired in favour of an automated test,
`server/src/routes/voice-library.clone-fidelity.test.ts`, which stubs the
`/embed` boundary directly and asserts both sides of the threshold in CI. No
further on-box run is owed for this item — it no longer needs real hardware
to prove.

**Run 2 — 2026-07-31, SHA `b5479e9c`, clean tree.** Four more discharged, all in
Section E: **E-01** ⭐ (clone → Coqui-routed Russian book → generate: the first
`voices\xtts\xtts-$U.{pt,json}` ever written on this box, `resolvedVoiceName` =
`xtts-$U`, Whisper auto-detect **`ru`** at `avg_logprob` **−0.368**), **E-02** ⭐
(sample 200 → revoke → sample **403** with the exact copy, and the
previously-cached audition URL now **404**), **E-08** (re-confirmed on two more
assigns), and **E-09** — which run 1 could only mark `N/A` because no XTTS
artifact had ever existed. Its first real exercise: 5 files across 3 locations
pre-revoke, **0 remaining** after, both `voices\xtts\` paths included, entry dir
left holding only `voice.json`.

**Run 2 found two defects, both open.**
[**#1967**](https://github.com/dudarenok-maker/Castwright/issues/1967) is the
serious one and it **blocks Section E on any stock box**: every XTTS clone
derive fails because `torchcodec` cannot load without *shared* FFmpeg libraries,
and the normal Windows install (`winget install Gyan.FFmpeg`) is a static build
shipping `ffmpeg.exe` alone. The install docs assert the sidecar "never calls
`torchaudio.load`" — it does, on exactly this path — which is why the installer
drops `torchcodec` in with `--no-deps` and never provisions its native
dependency. Section E above was only reachable after staging PyAV's own bundled
FFmpeg set into the `torchcodec` package directory; that workaround is still in
place on this box (run sheet §7.3).
[**#1969**](https://github.com/dudarenok-maker/Castwright/issues/1969) is why
A23 below is not fully discharged.

**RETRACTED — three run-2 results were wrong, and the cause is
[#1972](https://github.com/dudarenok-maker/Castwright/issues/1972).** A
per-character re-record picks its target segments from `segments.json` but
resolves their sentences — and so the voice — from the **analysis cache**, by
sentence id. Once analysis has run since the render the two disagree, and the
re-record renders another character's line in the requested character's voice.
`resolvedVoiceName` still reports the assigned voice, because it was re-derived
from the cast record rather than recorded from the render.

Every retracted result had been read from that field:

- **A23** — identity half withdrawn. Its German chapter measured **0.949**
  against the chapter's own narrator. The **language** claim stands: it was
  measured from the audio by Whisper, which does not consult the cast, and is
  independently confirmed at the `/synthesize` boundary.
- **E-01** — identity half withdrawn (13 of 21 targeted segments divergent).
  The derive, the artifacts and the language all stand.
- **C-17** — its `F` is withdrawn entirely. The self-heal was never *reached*,
  so the test was never exercised. It is not-run, not failing.

Reproduced with a **healthy** designed voice, and on two books that diverged for
unrelated reasons — one from pre-#1598 attribution damage, one from ordinary
re-segmentation. **The precondition is only "analysis has run since the last
render."** Full chapter generation is unaffected. No test caught it because none
asserts which voice reached the provider.

**Still owed (~40), and why:**
- **Browser/mic (4):** A-07 (recorder webm/opus), A-08 (mic-denial fallback),
  A-09 (consent gates Continue), B-02 (record-path clone). Need a real browser
  with a real microphone.
- **By ear (2):** B-03, E-06. No instrument substitutes; ECAPA cosines above are
  the objective half only.
- **Section E — 6 of 9 now run (2026-07-31/08-01, across runs 2 and 3);
  E-03, E-06 and E-07 still owed, but no longer blocked.**
  **Run 3 (2026-08-01)** added E-01's first genuine exercise — **P**
  (mechanism), **by-ear NEGATIVE**. Owner: *"2 does not sound like 4 much,
  cross language is not working well."* Mechanism passes, perceptual
  identity does not: a controlled experiment isolated the cause to the
  **source clip's language**, not XTTS cloning — a clone built from a
  Russian clip scored **0.7824** against its own source in the same chapter
  where the English-sourced clone scored **0.2321** (caveat: the RU floor is
  contaminated, narrator vs RU source already 0.577, because Qwen Russian
  voices cluster). It also passed **E-05** (audition vs render **0.5515**
  against floors of 0.105 / 0.051), and reproduced **E-04** (**F**)
  deliberately: same cloned voice/engine/`language: ru`, only length
  differs — a 46-char line returned 200, a 245-char line 500. Cause: `spacy`
  absent from the sidecar venv and undeclared in every `requirements/*.txt`,
  while `main.py` hardcodes `enable_text_splitting=True`. Filed
  [#2017](https://github.com/dudarenok-maker/Castwright/issues/2017), fixed
  in [PR #2039](https://github.com/dudarenok-maker/Castwright/pull/2039).
  Run 3 also produced [#2023](https://github.com/dudarenok-maker/Castwright/issues/2023)
  (an orphaned `characterId` renders silently in the narrator's voice) and
  [#2026](https://github.com/dudarenok-maker/Castwright/issues/2026)
  (Russian XTTS quality — register row A41). The #1944 blocker below is
  genuinely
  gone — Coqui loaded cleanly in a post-`/embed` process during run 2, logging
  `Coqui ready — 58 speakers in manifest`. A *second*, separate blocker sat
  behind it — the clone **derive** failed without shared FFmpeg libraries
  (#1967) — and that is now fixed and merged (PR #1978, 2026-07-31), so
  E-03…E-07 are runnable on a stock static-FFmpeg box without any hot patch.
  **E-04 specifically is no longer blocked on a fix** — the code-level fix for
  its `ImportError` shape (#2017) landed in PR #2039 — so what remains of its
  debt is a re-run of the reproduction (46-char control, 245-char Russian
  line) on real Coqui weights, not an outstanding bug. Their first run doubles as A25 item 1. History of the
  first blocker follows, kept because it is what the run-2 result confirms:
  Coqui/XTTS could not load in a
  sidecar that had already served ECAPA `/embed`, and cloning always calls
  `/embed` for the fidelity check. **Acceptance run on the dev box**, both
  halves on `cuda:1` on a dedicated port so the live sidecar was untouched,
  and with `COQUI_PIN_IMPORT_ORDER=0` throughout so the `sys.modules` disarm —
  not the boot-order pin — was the thing under test:

  | Tree | `/embed` | `POST /load {coqui}` |
  |---|---|---|
  | `main` @ `0edde146` (before) | 200 | **500** — `ImportError: Lazy import of LazyModule(… speechbrain.integrations.k2_fsa …) failed` |
  | `fix/sidecar-speechbrain-lazy-proxies` @ `d6af415d` (after) | 200 | **200** — `{"status":"ready"}`, `Coqui ready — 58 speakers in manifest` |

  The after-run's log records the pin explicitly skipped and names all 7
  evicted proxies, so the disarm is what carried it. `coqui_import_ok` went
  `null → true` on the real import.

  **What this does NOT discharge:** Section E's nine tests themselves — they
  are now runnable and remain owed. Nor the pin's own default-on path, which
  was deliberately disabled for this run; it is covered by unit tests only,
  and since PR #1962 it is additionally gated on the XTTS weights being
  present, so Qwen-only and Kokoro-only installs never exercise it at all.

  **Superseded advice:** the old note here said to treat
  `coqui_package_installed: true` with suspicion when planning, because that
  `find_spec` probe never imports and is how this row was once mis-scoped as
  unblocked. Still true of that field — but `/health` now also carries a
  sticky `coqui_import_ok` reflecting a real import attempt, which is the one
  to read. Note #1963: `models-status`'s `importable` is still the old
  find_spec value.
- **C-02, D-02 and any full-book work — BLOCKED by the side-11 host-memory
  leak.** Two full-chapter render attempts died: one at the QA gate (ASR could
  not get VRAM alongside Kokoro), one with `recycle-storm` after the sidecar
  recycled 3× (committed memory peaked at 29,395 MB). The sidecar's own log
  names it: *"expected for the variable-shape leak; the restart ceiling is the
  real guard"*. **Workaround, qualified since [#1972](https://github.com/dudarenok-maker/Castwright/issues/1972):**
  the per-character re-record (splice) path renders one character's lines
  without the full-chapter memory churn — that is how the central claim above
  was proven — but it now REFUSES on a chapter whose `segments.json` and the
  current analysis disagree (exactly the shape both fixture books in this run
  hit). It only stays usable as a workaround when the two agree; when they
  don't, re-run analysis first (so the splice becomes usable again), or fall
  back to a full chapter generation — which the side-11 leak still blocks, but
  which is at least immune to the splice's own attribution defect.
- **The rest of Section C (18) and Section D (3):** not reached. C-08/C-12
  (deliberate mid-write sidecar kills) and C-01/E-03 (revoke racing an in-flight
  derive) are untouched and remain the highest-risk unproven behaviour here.
- **C-05 (one of the 18 above) now has two recorded sub-observations owed, not
  a new row:** [#2023](https://github.com/dudarenok-maker/Castwright/issues/2023)
  / PR #2041 split it into C-05a (a healthy cloned narrator refuses an
  orphaned-characterId line) and C-05b (a designed narrator's substitution is
  recorded + surfaced) — see the run sheet's `Result (C-05a)`/`Result (C-05b)`
  lines. Sharpens what C-05 needs to test; the Section C headcount is unchanged.

**Two findings that are NOT defects, recorded so they are not re-filed.** (1)
`ASR_DEVICE` and `ASR_COMPUTE_TYPE` in `server/.env` must agree — flipping the
device to `cpu` while `ASR_COMPUTE_TYPE=int8_float16` remains pinned makes every
`/transcribe` 500. `_compute_type()` is correct; nothing enforces the pairing.
**Fixed for the Advanced Configuration path by [#2180](https://github.com/dudarenok-maker/Castwright/issues/2180):**
`PUT /api/config` rejects a `qa.asr.device` / `qa.asr.computeType` save that
would leave this pair mismatched, checked against the resulting effective
config (not just the incoming patch); `POST /api/config/reset` (every
Advanced Settings row's per-key Revert, plus a group/`qa-gates` or `all`
reset) checks the same resulting-effective-config rule before clearing
anything, so a Revert click can't reopen the pair either (independent review
of PR #2205, finding F1 — the reset path was still an open bypass when #2180
first shipped). So the UI can no longer produce this state. A hand-edited
`server/.env` still bypasses save-time validation by design and can still
reach this combination — that residue is explicitly out of scope for #2180
(belongs with #2131's sidecar-side surfacing work instead).
(2) `npm start` appears to launch two sidecars but does not — the venv
`python.exe` is a launcher that re-execs the base interpreter as a child. Only
one holds :9000. Separately, `npm run stop` repeatedly reported
`[GONE] tts pid=… (already exited)` for a pid matching neither live process, so
its pid tracking drifts across restarts — minor, unfiled.

**Also opened by this run:** #1943 (consent record cannot name the real
attester — `attestedBy` is overwritten with `personName`, which inverts
`guardian-of-minor`).

Starred, highest-risk — **C-10 is now discharged (passed 2026-07-29)**; the rest
remain: **C-01** revoke mid-derive leaves no live `.pt` and `revokedAt` survives ·
**C-08** a transient failure does not brick a voice · **C-17**
designed-voice self-heal preserves persona · **C-12** a killed mid-write leaves
no truncated `.pt` · **E-01** clone → cast on Coqui → generate · **E-02**
audition-then-revoke refuses Play on the Coqui path · **E-06** the one place
D-B's synthetic-clip-vs-catalogue quality question can actually be judged, by
ear · **E-07** a forced designed-derive failure still renders the chapter
(fail-soft, the opposite policy from cloned's fail-loud).

**E-01 was attempted and is blocked, not failed.** A Coqui splice reported
`splice_complete` but wrote no `voices\xtts\` artifacts and left
`characterSnapshots.wren.voiceEngine` as `qwen` — the character's own
`ttsEngine: 'qwen'` overrides the requested `modelKey`. To attempt Section E,
first flip the target character's engine to coqui (or use the Russian Coalfall
twin, which routes there natively), **and** start from a sidecar that has never
called `/embed` (#1944). Reassuringly, the post-splice audio still measured as
the cloned speaker (0.66 / 0.61 vs source), so **no silent substitution
occurred** — the never-substitute guarantee held even on the path that failed to
reach XTTS.

C-08 and C-12 deliberately kill the sidecar mid-write — nothing else in flight.
D-01 deliberately runs two concurrent book renders sharing one cloned voice.
E-03 deliberately races a revoke against an in-flight Coqui derive.

*Also needs:* Whisper weights, ECAPA `/embed`, the
Coalfall fixture with ≥2 speaking characters/chapter, the 9 audio fixtures in §4,
and (for Section E) a Coqui-capable sidecar plus a non-English (e.g. Russian)
book fixture that actually routes to Coqui.
*Prerequisites confirmed present on the box 2026-07-29:* Qwen 0.6B/1.7B-Base +
VoiceDesign, `faster-whisper-base`, ECAPA `spkrec-ecapa-voxceleb`, coqui-tts
0.27.5 + xtts_v2 weights, both GPUs (the eGPU was attached, so 2-card rows are
runnable), and Coalfall already imported and analysed in 7 languages incl. the
Russian twin. **The §4 audio fixtures now exist** at `C:\fixtures\fs38\` —
public-domain LibriVox, two distinct narrators, F-1…F-9 built and verified
against the `clone-quality.ts` thresholds — so a follow-up session does not need
to rebuild them. Note the box runs `LAN_HTTPS=1`, so the server is on
`https://localhost:8443`, **not** the `http://localhost:8080` the run sheet's
§3 probes assume.
*Plans:* 267, 268, 271 — all `status: active`, Ship notes now record this
partial run. *Cost:* multi-hour; the 2026-07-29 session spent roughly half its
time on the three environment blockers above rather than on tests.

**Six checks added by the post-32 follow-up campaign, same box/setup as
above — batch them into the same session:**

1. **The `preparing-voice` phase (#1813).** Render a chapter with a
   Repairable cloned voice or a self-healing designed voice (same setup as
   C-06/C-07/E-01) and confirm the Generate screen shows a "Preparing
   voice — `{character}`" step, with its own pill, *before* synthesis
   begins — mirroring the existing `recovering` phase, replacing the
   multi-second silent pause `docs/testing/fs38-wave3-onbox-acceptance.md`'s
   KL-f documents. Then render a chapter for a character with no library
   voice at all and confirm the phase never appears. Not yet folded into
   that run sheet's own step list or KL-f's now-stale "expected" text —
   update both when this is next revised.
2. **A cloned voice actually rendering on XTTS end to end** — the wave's
   central claim, already exercised by E-01 above but worth restating
   concretely: play the rendered chapter and confirm the dialogue is
   recognisably the cloned speaker, not a stock catalogue voice, and that
   `cast.json` records the character's `overrideTtsVoices.coqui.libraryUuid`
   matching the clone's uuid with `provenance: 'cloned'`.
3. **Revoke-then-render.** Revoke consent for a voice already cast on
   Coqui, then render a chapter that uses it (same shape as C-01/C-02 on
   the Qwen side, E-02/E-03 on Coqui), and confirm the chapter fails loud —
   `UnresolvableClonedVoiceError`, zero audio produced for that chapter —
   rather than silently substituting a stock catalogue voice.
4. **VRAM partitioning across a mixed chapter — no existing test names
   this explicitly.** Cast one character in a chapter to a Qwen cloned/
   designed voice and another to a Coqui cloned/designed voice in the same
   book, then watch `nvidia-smi` through the resolver pre-pass while that
   chapter renders. Qwen and Coqui must never both hold GPU memory
   resident at the same time — the pre-pass partitions cloned-voice derives
   by engine specifically to preserve this serialization (`fix(server):
   partition cloned-voice derives by engine to preserve VRAM
   serialization`). A spike showing both models resident simultaneously is
   a regression, not a variance.
5. **The `voice_language_mismatch` advisory reaches the screen on all three
   streams.** The frame is emitted by `generation.ts`, `chapter-splice.ts`,
   and (since `f879407c`) `chapter-qa-repair.ts` when a non-English book's
   reused DESIGNED voice is cleared for a baked-manifest-language mismatch.
   Only mock-mode coverage exists for the two newer frontend consumers, so
   confirm on the box: open a **non-English** book that has at least one
   reused designed voice designed for a *different* language, then (a) run a
   per-character re-record from the cast profile drawer's "Fix … audio", and
   (b) hit the repair button on a `suspect` chapter row in the Listen view.
   Each must raise ONE amber toast reading "…designed voice(s) were cleared
   because they were designed for a different language…", naming the cleared
   character — once per run, not once per chapter — and the run must still
   complete rather than fail. An English-only book must raise no such toast
   on either path. Server-side emission is already covered by
   `server/src/routes/chapter-qa-repair.test.ts`; what is owed here is that
   the real (non-mock) stream reaches the real toast stack.
6. **Preview plays on the ready engine, not always Qwen.** The My-voices card's
   Preview button used to always request the Qwen artifact; a voice whose Qwen
   copy is stale/failed but whose Coqui copy is ready 409'd on every Preview
   even though it could genuinely play. Confirm on the box: get a cloned or
   designed voice into a state where `engines.qwen.status` is not `ready` but
   `engines.xtts.status` is `ready` (e.g. a revoked-then-restored Qwen leg, or
   a Coqui-only clone with no Qwen derive yet), then press Preview on its
   My-voices card and confirm real Coqui audio plays instead of a 409 toast. A
   voice with both engines ready should still preview on Qwen (the primary
   engine, and the one carrying the session's 1.7B tier pin). Only mock-mode
   coverage exists (`voice-library-card.test.tsx`); what is owed is the real
   sidecar round trip.

*Pass/fail criteria for all six:* `docs/features/271-fs38-wave3c-xtts.md`.
*Hardware:* the same single 8 GB box as the rest of Group A, XTTS weights
installed (`install-coqui.mjs`/`.ps1`/`.sh`), no additional prerequisites
beyond what A1 already lists above.

### A2 · Capacity-aware GPU placement (plan 264) — walkthrough step 9, cross-card device steer · **2-card boot only**

**Owed:** walkthrough **step 9**, the on-box confirmation of the #1730
cross-card device-steer fix. The code merged (PR #1732, 2026-07-19) but its
confirmation never ran. The plan calls this "still owed before the
concurrent-multi-card flag flip." **2-card boot only.**

*Step 3* (eGPU fault-drop) is genuinely observe-only — yanking an OcuLink cable
is a hard crash. Mark Blocked/N-A unless it happens on its own.

*Criteria:* `docs/features/264-vram-aware-gpu-placement.md:129-179`, header `:9-22`.

> **Ruling, 2026-08-21 — rows 6–8 are NOT owed; scope narrowed.** The
> evict-under-contention rows (cold-`/load` device steer, `design_voice`
> evicts Ollama, GPU-ASR 503→evict→retry) were previously carried here as an
> ambiguous second debt. Plan 264 itself frames them as "deferred by choice,
> not blocked" — rest on automated coverage for now, runnable on demand, not
> a debt owed to this register. The repo owner confirmed this reading
> 2026-08-21. This row's scope narrows to step 9 alone; the row does not
> leave the register, since step 9 is still genuinely owed. **The prior ⚠️
> about plan 264 contradicting itself (S6 listed as both force-driven and
> not force-driven) is resolved** — Castwright#2559 fixed the plan text
> (removed `S6` from the force-driven list), see
> `docs/features/264-vram-aware-gpu-placement.md`.

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

*Shipped* **2026-06-01**.

> **Correction, 2026-08-21.** The prior ⚠️ ("frontmatter says `status: active`
> while the body's own `> Status:` line says `stable`") is stale — Castwright#2559
> fixed plan 165's frontmatter (now `status: stable`) and archived it to
> `docs/features/archive/165-fe-15-16-language-and-revision-e2e.md`. This row
> names the plan by number only, with no path, so the archive move does not
> break anything here.

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

### A19 · Mixed Qwen+Coqui evict fails soft ([#1893](https://github.com/dudarenok-maker/Castwright/issues/1893)) · **single 8 GB card**

fs-60's mid-chapter `/unload` is now best-effort: a failed evict logs a warning and
the Coqui phase renders anyway, instead of aborting the chapter. Unit tests prove the
chapter survives the failure; what they **cannot** reach is the consequence that
motivated the old fail-loud behaviour — Coqui loading while Qwen is still resident on
a card too small for both. Worth watching once, because the failure mode if the
judgement is wrong is a sidecar OOM, which is worse than the abort it replaced.

> **Observation 2026-07-31 — NOT a discharge, but the first real datapoint.** A mixed
> Qwen+Coqui render was run on the 8 GB card incidentally, while discharging A25 item 1:
> the Russian Coalfall chapter 2 with twelve designed-Qwen characters and `oduvan` forced
> onto a cloned XTTS voice. **The evict was NOT forced to fail** — this is the ordinary
> path, not A19's scenario — and the chapter still died:
>
> ```
> chapter_failed  errorCode: "vram-spill"
> "The GPU ran out of video memory (VRAM) mid-render — too many models were resident at once."
> ```
>
> So of the three outcomes this row asks you to distinguish, the *unforced* case already
> lands on **"a sidecar OOM that fails the chapter with its own message"** — cleanly
> classified and remediated, not a crash or a recycle storm. Repeated with
> `modelKey: coqui-xtts-v2` at run level and it spilled again, because a character's own
> `ttsEngine` still routes it: the run-level key does not force single-engine.
>
> What this does **not** tell us is A19's actual question — whether a *failed evict* makes
> it worse — since the evict here was never made to fail. But it does mean the co-residency
> hazard is reachable on this card **without** any evict failure at all, which is worth
> knowing before running the forced case. Note the box also had two agent pytest suites
> holding ~2 GB of cuda:0 at the time, so this is a contended-card datapoint, not a clean one.

> **Correction 2026-08-01 — that datapoint was contention, not a card-size limit.** The
> caveat above understated it. Re-run on a **quiet** box the same mixed Qwen+Coqui chapter
> **completed 71/71** with `audioEngines {qwen: 3, coqui: 1}`. Measured footprints via
> `POST /load` + `/health`:
>
> | state | cuda:0 | cuda:1 |
> |---|---|---|
> | Qwen 0.6B alone | 0 MB | 1,845 MB |
> | Qwen **+** Coqui, both resident | 0 MB | **3,758 MB** |
> | sidecar fresh, **nothing loaded** | **5,743 MB** | 393 MB |
>
> Both engines together are **3.7 GB** — they fit an 8 GB card with room to spare. That
> last row is the tell: a brand-new sidecar with zero models resident, and cuda:0 already
> two-thirds full. The holder was another worktree's real-GPU Qwen pytest suite
> (`wt-1975-batch-inlock-load`, ~5.4 GB across **both** cards). The refusal itself was
> correct and self-describing — `NoCapacityError … deviceKey: 'cuda:0', blockers: []`, where
> `blockers: []` means "something I cannot see holds this card", since the placement
> controller only knows its own engines.
>
> **So A19's question is still entirely open** — the unforced case does *not* reliably spill
> on an 8 GB card, and the earlier reading that it did was measuring a foreign process.
> Caveat in the other direction: our own peak across a 1,588-sample trace was **6,727 MB**
> (Qwen + Coqui + Whisper ASR together), which on an 8 GB card leaves little headroom — so
> co-residency is genuinely tight, just not the 6.7 GB-at-idle that was observed.
>
> **Box policy since 2026-08-01 (owner's call):** renders are pinned to the 16 GB 5070 Ti
> via `COQUI_DEVICE=cuda:1` / `QWEN_DEVICE=cuda:1` / `ASR_DEVICE=cuda:1` in the git-ignored
> `server/.env`, leaving cuda:0 free for other worktrees' PR suites. **A19's forced-evict run
> must temporarily undo those pins**, or it will not exercise the single-8 GB-card scenario
> this row is about.

- Render a chapter that genuinely mixes Qwen and Coqui — a non-English book (the
  Russian Coalfall chapter) with one designed-Qwen character and one undesigned
  character that falls back to Coqui. Force the evict to fail: point
  `SIDECAR_URL` at a proxy that 500s `POST /unload` and passes everything else
  through, or stop the sidecar's unload path by hand.
- Confirm the chapter **completes** and the server log carries
  `fs-60 Qwen→Coqui evict failed; continuing into the Coqui phase`.
- The thing actually being judged: whether the sidecar then survives Qwen+Coqui
  co-residency on 8 GB. Record which it is — clean completion, a sidecar OOM error
  that fails the chapter with its own message, or a crash/recycle storm. **The third
  outcome means the fail-soft policy needs revisiting** (retry-then-abort rather than
  warn-and-continue) — file it back on #1893.
- Also confirm pausing the run **during** a stalled evict stops it promptly rather
  than waiting out the 10-minute ceiling — the abort is forwarded to the fetch now.

**Run this with A5** — same card, same Russian-book-with-an-undesigned-character setup,
and A5 already owes the evict-and-reload sequencing this row stresses. Doing them in one
sitting costs barely more than either alone.

*Needs:* the 8 GB card only, a non-English book with a mixed cast, and a way to make
`/unload` fail. *Criteria:* #1898; the fail-soft rationale is in the comment at the call
site in `server/src/tts/synthesise-chapter.ts`, and plan 249's accepted limitation #4
records what it weakened. *Cost:* short.

### A20 · Idle Coqui is reclaimed under VRAM pressure ([#1894](https://github.com/dudarenok-maker/Castwright/issues/1894)) · **single 8 GB card**

The sidecar's admission path now frees a resident-but-idle XTTS before reporting
`noCapacity`. Unit tests prove the branch fires and that it never evicts for a Coqui
op; what they cannot reach is whether reclaiming ~3 GB actually admits the blocked
operation on real hardware, and whether the 30 s TTL is tuned for real chapter gaps.

- **Run pinned to ONE card** — `CUDA_VISIBLE_DEVICES=0`. This box is dual-GPU
  (`cuda:0` 4070 8 GB, `cuda:1` 5070Ti 16 GB) and `_worst_device_key` picks the card
  with the **most** headroom, so an unpinned run calls `idle_evict("cuda:1")` while
  Coqui sits on `cuda:0`, `_same_card` declines, and the row passes or fails for
  entirely the wrong reason.
- Load Coqui from the UI, then start a Qwen-only render that would not otherwise fit.
  Confirm the render **proceeds** and the sidecar log carries `Coqui model unloaded.`
  Record whether the reclaimed ~3 GB actually admitted the op, or was immediately
  taken by something else.
- Then render a mixed Qwen+Coqui book and watch the chapter boundaries. **An
  evict→reload cycle repeating across chapters means `COQUI_IDLE_TTL` is too short**
  (each reload costs ~90 s); a render that still fails `NoCapacityError` with an idle
  Coqui resident means it is too long. Record which, with the observed interval
  between the evict and the next Coqui use, so the default can be moved off 30 s with
  evidence rather than a guess.
- Also confirm the Stop-button crash fix: press **Stop** on Coqui while a chapter is rendering
  through it. The chapter must continue to completion — before #1894 this could kill
  it with `AttributeError: 'NoneType' object has no attribute 'tts'`. Also record
  what the **Stop control itself** reports: `CoquiEngine.unload()` now acquires
  `_synth_lock` before dropping the model, so it blocks for the length of the
  in-flight forward — tens of seconds to minutes. Since #1921,
  `POST /api/sidecar/unload` carries its own 90 s budget (not the 2 s probe
  budget), and the pill shows a disabled "Stopping…" state for the whole wait.
  The expected observation is now: the Stop control shows "Stopping…" with the
  button disabled, and it completes without an error banner, once the in-flight
  forward and the unload both finish. Record whether that held, and how long
  the eventual unload actually took.

**Run this with A19 and A5** — same card, same mixed-cast book, and A19 already stages
the Qwen+Coqui co-residency this row's first bullet needs.

*Needs:* the 8 GB card only, pinned via `CUDA_VISIBLE_DEVICES=0`, and a mixed-cast
non-English book. *Criteria:* the spec at
`docs/superpowers/specs/2026-07-28-coqui-residency-eviction-design.md` §6; the TTL
rationale is in the comment on `_COQUI_IDLE_TTL_DEFAULT` in `tts-sidecar/main.py`.
*Cost:* short.

### A21 · Real-book QA/badge agreement after the loudness measurement hoist (plan [274](../features/archive/274-loudness-measurement-provenance.md), [#1922](https://github.com/dudarenok-maker/Castwright/issues/1922), [#1923](https://github.com/dudarenok-maker/Castwright/issues/1923))

Everything is proven in-repo with real ffmpeg (no GPU) against a recorded-PCM fixture
— what that cannot reach is a full multi-chapter render of genuinely synthesised
speech, where the hoisted `ebur128` measurement runs against real TTS output rather
than a single committed clip.

- Render a full book (any engine). For every chapter, confirm the Suspect badge's
  true-peak reason (when present) and the Listen-view loudness badge's dBTP figure
  quote the **same number** — they can no longer be two different readings of the
  same chapter.

*Needs:* a working TTS engine + a real book. *Criteria:* plan 274 §6 row 1.
*Cost:* short (rides along with any other real-book render session).

### A22 · Measurement-failure path renders as untrusted, not as a fabricated reading (plan [274](../features/archive/274-loudness-measurement-provenance.md))

T2/T6 cover the fail-soft fallback and the grandfather predicate at unit level with a
forced (mocked) `measureLoudnessFile` failure. Not yet observed: the real, hard-to-force
failure path on a live render.

- Force (or catch) a chapter whose real `ebur128` re-measurement fails on a genuine
  render. Confirm the sidecar carries `measurementSource: 'loudnorm'` and that both
  the Listen-view badge and the report-card row show "No measurement" rather than a
  fabricated figure.

*Needs:* a working TTS engine + a real book; this failure is hard to force naturally,
so treat it as opportunistic (catch one if ffmpeg genuinely fails during a render)
rather than something to engineer. *Criteria:* plan 274 §6 row 3. *Cost:* short,
opportunistic.

### A23 · A cloned voice renders a non-English book in the book's language (plan [275](../features/275-clone-voice-language.md), [#1951](https://github.com/dudarenok-maker/Castwright/issues/1951))

> **PARTIALLY evidenced 2026-07-31 — NOT discharged.** Corrected after
> [#1972](https://github.com/dudarenok-maker/Castwright/issues/1972) was
> understood; the original entry claimed a full discharge and was wrong.
>
> **What still stands — the fix works, proven at the synthesis boundary.** Three
> direct `POST /synthesize` calls on the same cloned voice, raw PCM transcribed
> with Whisper auto-detect and embedded with `/embed`:
>
> | Call | detected | `avg_logprob` | cos vs source clip |
> |---|---|---|---|
> | English text + `language: English` | `en` | −0.258 | 0.865 |
> | **German text + `language: German`** | **`de`** | −0.699 | **0.809** |
> | German text, language omitted (pre-fix) | `en` | −0.904 | 0.876 |
>
> Row 3 reproduces the shipped bug live — German in, English phonetics out,
> transcript garbage. Row 2 is the fix, with the cloned identity intact at 0.809
> against a ~0.03 different-speaker floor. This is real evidence and does not
> depend on the splice path.
>
> **What is withdrawn.** The row's actual criterion is *"render a non-English
> **chapter** with a cloned voice and transcribe the output"*. That chapter
> render used a splice re-record, so most of what was measured was **narrator**
> audio, not the clone — the rendered lines scored **0.949** against the
> chapter's own narrator. The `de` / −0.233 figure is therefore a measurement of
> the wrong audio: it shows the chapter rendered in German, not that *a cloned
> voice* did. `resolvedVoiceName` said otherwise, and that is the field #1972
> falsifies.
>
> **To finish this row:** re-run the chapter-level criterion once #1972 has
> landed, on a book whose `segments.json` and analysis agree — or via a full
> chapter generation, which is unaffected by the defect. The remaining
> sub-checks (designed self-heal → restart → identical; the QA
> `voice-mismatch` check, blocked on
> [#1969](https://github.com/dudarenok-maker/Castwright/issues/1969)) are
> unchanged.

Before this fix a cloned Qwen voice rendered **every** book, in every language, as
English — `QwenEngine.synthesize` took the caller's language and ignored it, and a
clone's manifest always said `"English"`. The unit and pytest coverage asserts the
*mechanism* (the right language reaches `generate_voice_clone`). Only a real render
proves the *outcome*, and the outcome is what the bug destroyed.

The criterion is deliberately outcome-level, because a mechanism-level assertion is
exactly what would have let the original defect ship: the batch path carries the
language separately from the title beat, and a fix covering only one of them passes
every mechanism test while leaving the whole book wrong.

- Cast a **cloned** voice onto a character with dialogue in a non-English book and
  render one chapter. Transcribe the output through the sidecar's `/transcribe` with
  Whisper **auto-detect** (send no `x-language`). **Pass = the detected language is
  the book's, and `avg_logprob` is better than ≈ −0.5.** Measured 2026-07-30 on the
  pre-fix build for reference: detected `en`, `avg_logprob` **−1.303**,
  unintelligible; with the language corrected, `de` at **−0.366**; a natively
  designed German control scored **−0.201**.
- Confirm `characterSnapshots.<id>.resolvedVoiceName` is still the clone's storage
  key — the never-substitute guarantee must hold while the language changes.
- **Check the chapter title too, not just the sentences.** The title beat is the only
  `/synthesize` call in an otherwise batched chapter, so a regression there hides
  behind correct-sounding body audio.
- Render with a **designed self-healed** voice, restart the sidecar, render again —
  the two must be audibly identical. This is the cache-vs-disk divergence half;
  before the fix the warm cache and the on-disk manifest disagreed, so a restart
  silently changed the output.
- **Then open the chapter's QA report and check the cloned character has no
  `voice-mismatch` rows.** The speaker-drift detector compares each segment against
  a reference the server renders itself (`auditionCentroid`), and that reference now
  carries the book's language too — an English reference against a German chapter
  would flag the voice as drifting when nothing is wrong. Only reachable with a
  character thin enough on in-book anchors to trigger the audition fallback (a
  few-line character is the easy way), so treat it as opportunistic within this same
  render rather than something to engineer.

*Needs:* a single GPU with Qwen resident, a non-English book, and ASR available
(`ASR_DEVICE` and `ASR_COMPUTE_TYPE` must agree — a `cpu` device with a pinned
`int8_float16` makes every `/transcribe` 500). **Run with A1's remaining Section C/D
items** — same box, same book, same sidecar session. *Criteria:* plan 275
§"On-box acceptance". *Cost:* one chapter render plus a sidecar restart.

### A24 · `/health` stays live through a contended eviction on the default Qwen path (plan [273](../features/archive/273-sidecar-lock-event-loop.md), [#1919](https://github.com/dudarenok-maker/Castwright/issues/1919)) · **single 8 GB card**

Automated tests prove each eviction step — and the reclaim that follows it — now
runs on a worker thread rather than the asyncio event loop. What they cannot reach
is whether `/health`, and every other in-flight request, actually stays responsive
when a real multi-GB `gc.collect()`/`empty_cache()` and a real contended
`_synth_lock` are in play — on the **default** Qwen path, with no opt-in env var.
Run sheet: [`sidecar-evict-latency-onbox-acceptance.md`](sidecar-evict-latency-onbox-acceptance.md).

- **Run pinned to ONE card** — `CUDA_VISIBLE_DEVICES=0` (runnable alongside
  A19/A5/A20 in the same session). `SEG_CAPACITY_ADMISSION=1` (the default) and
  Qwen as the generation engine (also the default).
- Run a cast-review **voice design** so Qwen VoiceDesign is warm-resident
  (`QWEN_DESIGN_IDLE_TTL` keeps it ~120 s), then start a Qwen **chapter render** —
  each sentence's forward holds `_synth_lock` for its duration.
- While that render is in flight, trigger a second admission on the same card
  (`POST /load` for coqui, or `/xtts/clone-voice`). Its `qwen.design` eviction
  step's fast-out passes (nothing is *designing*), so it blocks on `_synth_lock`
  held by the in-flight Base forward — the exact race #1919 describes.
- From a second shell, poll `GET /health` every 250 ms **throughout** — from
  before the render starts until the second admission resolves — and record the
  **maximum inter-response gap, in milliseconds.** Before this fix the expected
  gap is on the order of one Qwen forward pass (seconds); after, it should stay
  under roughly 500 ms, bounded by the poll interval rather than by the render.
- Also confirm the evict **actually frees the VRAM** — the second admission
  succeeds rather than 503-ing `noCapacity`. A near-zero `/health` gap because the
  evict silently declined and did nothing would look like a pass and isn't one.
- **Optional second pass** with `SEG_ASR_ENABLED=1` + `ASR_DEVICE=cuda` to exercise
  the `asr` eviction step too. Not required for this row to clear.

*Needs:* the 8 GB card only, pinned via `CUDA_VISIBLE_DEVICES=0`, a book with a
designed Qwen voice in progress plus a second admission target (a Coqui `/load` or
an XTTS clone). *Criteria:* plan 273 §7. *Cost:* short.

### A25 · Cloned-voice derive on Coqui no longer needs torchcodec ([#1967](https://github.com/dudarenok-maker/Castwright/issues/1967)) · **single 8 GB card + a real static-FFmpeg box; item 4 needs a Pinokio install**

**The hot patch was reverted on 2026-07-31 and the dev box is now a genuine static-FFmpeg box again** — `ffmpeg 8.1.1-full_build-www.gyan.dev` on PATH, and the 25 copied FFmpeg DLLs removed from `site-packages/torchcodec/`. Note the revert is *not* "delete every non-hash-suffixed `*.dll`" as first written: `libtorchcodec_core4-8.dll` and `libtorchcodec_custom_ops4-8.dll` are torchcodec's **own** extensions, have no hash-suffixed twin, and must stay. The copied set is exactly those non-hash-suffixed files that *do* have a hash-suffixed twin. With #1967 merged the hot patch is no longer needed to unblock A1's Section E.

**Partially discharged — items 1 and 3 are now DONE (2026-07-31); items 2 and 4 remain.** What ran, and what it proved:

- `import torchcodec` → `RuntimeError: Could not load libtorchcodec … FFmpeg is not properly installed`. The box is genuinely broken, so nothing below is a vacuous pass.
- `torchaudio`'s own loader on a reference WAV → same failure. This is the pre-fix path.
- **The real, installed `TTS.tts.models.xtts.load_audio`** — the exact function `get_conditioning_latents` calls — fails unpatched and returns a correct `(1, 22050)` tensor under `patched_xtts_load_audio()`. This is the seam #1967 is about, tested against the shipped upstream function rather than a fake.
- `tests/test_xtts_audio_io.py` on that box → **10 passed, 2 skipped**, the skips being the fidelity tier correctly opting out when torchaudio's loader cannot run. That skip behaviour had never been exercised on a real static-FFmpeg box before; it was only inferred.

**Still owed** is everything that needs the sidecar and a real voice — see items 1–4.

- **1. Static-FFmpeg derive — DISCHARGED 2026-07-31.** Ran on the reverted box against a sidecar the server genuinely supervised. The derive **completed** through the full `CoquiEngine.clone_voice` path and wrote both artifacts into a directory that was **empty** beforehand, so no cached `.pt` could have short-circuited it:

  ```
  18:12:59.558 [sidecar] Cloned + cached Coqui voice 'xtts-0abceba4-…' from caller clip.
  xtts-0abceba4-5eba-4d8f-8bdf-46bee14c931d.pt    135,509 B
  xtts-0abceba4-5eba-4d8f-8bdf-46bee14c931d.json      172 B
  ```

  No `derive-failed`, no `Cloned voice(s) unavailable`. The rendered audio is the clone and not a substitute — **0.229** cosine against the source clip versus a **0.014** different-speaker floor, measured through the production `/synthesize` → `/embed` path rather than read off `resolvedVoiceName`.

  **Three preconditions were verified, not assumed** — each is a way this acceptance can be faked:
  1. *The box is really static-FFmpeg.* `import torchcodec` still fails. The 25 stray hash-suffixed FFmpeg DLLs the first revert left inside `site-packages/torchcodec/` were also removed (62.6 MB); torchcodec's own 10 extensions are intact.
  2. *The sidecar is post-merge.* The running one had been orphaned by a recycle storm — `POST /api/sidecar/restart` returned **409**, i.e. nothing supervised it, so its vintage was unknown. Restarted the stack; `/restart` then returned **200**. **Treat a 409 as "this sidecar may be any age."**
  3. *No cache existed to short-circuit the derive.* `voices/xtts/` was empty.

  **Deviation, deliberate:** the hand-off brief suggests reusing E-01's splice setup. A **full chapter generation** was used instead, because [#1972](https://github.com/dudarenok-maker/Castwright/issues/1972) — found the same day — makes the splice unsafe on that book (13 of 21 targeted segments divergent), and that contamination is exactly why E-01's original identity claim had to be retracted.

  **This does NOT discharge E-01.** The chapter itself failed *after* the derive with `vram-spill` (mixed Qwen+Coqui on the 8 GB card — see A19), so "the chapter renders" and the by-ear check remain owed there.

  A separate finding came out of it: a clone rendered in a language other than its source clip's loses most of its speaker identity on XTTS — 0.600 (English) → 0.229 (Russian), same derive. Filed as [#1998](https://github.com/dudarenok-maker/Castwright/issues/1998).

- **2. Latent equivalence — PARTIALLY DISCHARGED.** Decode equivalence was **measured** during PR #1978's review, on the still-hot-patched box, by running both decoders side by side against the same WAV: **max difference 0.0**, mono and stereo-downmix alike, so the replacement is bit-identical to the loader it replaces rather than merely similar. What remains is the *audible* end of it — derive the same cloned voice with and without the `patched_xtts_load_audio()` wrap on a shared-FFmpeg box and confirm the rendered output is equivalent. Cheap once item 1 can run.
- **3. Install-time verification — DISCHARGED 2026-07-31.** Both failure directions now run on a real install, and they produce **different** messages, which was the whole point of the marker line:

  | Scenario | exit | marker in stdout | branch selected |
  |---|---|---|---|
  | control — healthy | **0** | true | PASS, no failure branch |
  | **loader drift** (rebound to a wrong signature) | **1** | **true** | **MSG-1** — "patch could not be applied", names `coqui-tts 0.27.5`, points at #1967 |
  | **unrelated crash** (`import TTS` raises) | **1** | **false** | **MSG-2** — neutral "verification could not run" |

  Direction 2 correctly did **not** get MSG-1 — the specific defect this item existed to rule out. Drift message verbatim: `RuntimeError: XTTS reference-audio patch cannot be applied: unexpected load_audio signature ('some_other_name', 'and_another', 'extra') (coqui-tts 0.27.5).`

  Driven through the **real** `COQUI_VERIFY_CODE` and the **real** branch predicate from `install-coqui.mjs:222-232`; perturbations injected via `PYTHONPATH` only (a `sitecustomize.py` rebinding `load_audio`, and a shadow `TTS/__init__.py` raising `ImportError`), so the shared venv was never mutated. The guard's other drift shape (attribute missing) is already unit-covered by `test_raises_when_load_audio_missing`; the on-box-unique part was the marker-driven branch selection, which is what ran.

- **4. Pinokio's torchcodec outcome.** On a real Pinokio install, run `import torchcodec` inside the nested `.venv` that `pinokio/install.js` provisions and record whether it succeeds or fails — genuinely unknown at design time (design spec §11): conda-forge's ffmpeg is built shared, but a *nested* venv created from the conda interpreter does not automatically inherit loadable access to the conda env's `Library/bin` DLLs, so shared-ness there does not imply loadable here. #1967's fix makes the answer moot for *behaviour* either way — a Coqui clone derives correctly on Pinokio regardless — but the outcome itself is still owed as a recorded fact; see the correction note on `docs/superpowers/specs/2026-06-15-pinokio-installer-design.md:83`. **Batch with E1**, which already owns the Pinokio box.

*Needs:* items 1 and 3 want the 8 GB card with a real Coqui install — the dev box already satisfies item 1's static-FFmpeg prerequisite since the 2026-07-31 revert, so item 1 now needs only a post-merge sidecar and a consented sample; item 2's remaining half wants a box with a genuinely shared FFmpeg; item 4 wants a real Pinokio install (batch with E1). *Criteria:* [`docs/superpowers/specs/2026-07-31-xtts-clone-torchcodec-ffmpeg-design.md`](../superpowers/specs/2026-07-31-xtts-clone-torchcodec-ffmpeg-design.md) §12. *Cost:* short per item — the coordination cost of reverting the shared hot patch is now spent.

---

### A26 · Stranded VRAM pool reclaimed on the admission-failure path ([#1976](https://github.com/dudarenok-maker/Castwright/issues/1976), PR [#1993](https://github.com/dudarenok-maker/Castwright/pull/1993)) · **single 8 GB card**

Unit tests inject a fake `probe()` and a fake `reclaim` hook, proving the CALL
SEQUENCE (idle-evict first, reclaim once on failure, cooldown, the
in-use skip) — none of them touch a real CUDA allocator, so whether an actual
stranded `torch.cuda.empty_cache()` pool comes back on real hardware, and
whether the two new guards (C1, PR #1993 review) behave under real timing,
is unproven.

- Render a chapter to completion, let the engine report unloaded, and confirm
  (via `nvidia-smi` and `GET /api/sidecar/health`'s new
  `vramReservedMbByDevice`) that a reserved-but-unallocated pool is left
  behind on the render card, matching #1976's own measured shape (~3.9 GB on
  an 8 GB card).
- With that stranded pool present and nothing resident, issue an op that
  would otherwise be refused (an ASR `/transcribe`, or a voice design). It
  must be **admitted**, and `nvidia-smi` on that card must drop to
  near-baseline afterward — the #1976 acceptance criterion this row exists
  to close.
- Confirm the two C1 guards don't misfire on real hardware: (a) start a
  genuine render (so the render's engine holds a live reservation) and, from
  a second client, issue a refused op on the SAME card — the reclaim must
  NOT fire mid-render (watch for `stranded-cache reclaim` in the sidecar log;
  it must not appear while the render is in flight); (b) issue two refused
  ops on the same card within 30 s of each other and confirm the reclaim log
  line appears only once, not twice.
- This PR's `Closes #1976` was narrowed to `Refs #1976` in review (M5) — the
  render/unload-completion reclaim (#1976's other acceptance criterion) is a
  SEPARATE, not-yet-built lever tracked on its own follow-up issue. Do not
  treat this row's discharge as closing #1976 itself.

*Needs:* the 8 GB card only, a chapter render, and something to run past it
(ASR or a design) once it finishes. *Criteria:* PR #1993's description +
the C1/M3 review findings quoted above. *Cost:* short — rides along with A19
and A20, which already stage a mixed-engine render on this same card.

---

### A27 · `qa.asr.model` reaches the sidecar AND every server-side reader (PR #2008, closes [#1988](https://github.com/dudarenok-maker/Castwright/issues/1988), [#1989](https://github.com/dudarenok-maker/Castwright/issues/1989)) · **no GPU needed, sidecar venv only**

Registering `ASR_MODEL` as the `qa.asr.model` registry knob made a UI-set
override reach the sidecar via the generic restart-sidecar env-injection loop,
but the PR's own independent review found it did **not** reach the server's
own Node-side Whisper-model readers — `whisperRepoDir()` / `whisperModelPresent()`
/ `detectWhisperInstallStateOnDisk()` (`model-paths.ts`, `whisper-install-detect.ts`)
cached `process.env.ASR_MODEL` in a module-load-time constant, so Model
Manager's sizing, install-state, and **Remove** all still targeted `base`
regardless of what was actually configured and loaded. This was verified as a
real defect (not just a review claim) by reverting the fix and watching the
paired tests go red — see the PR's mutation-verification comment — but the
full failure mode needs the real sidecar + a real Hugging Face download to
observe end to end, which no unit test can substitute for.

- **Prerequisite:** comment out `ASR_MODEL` in `server/.env` first, if it's
  set. `server/.env.example`'s generated block ships `ASR_MODEL=base`
  uncommented; on a box seeded from that file, the value is present as a real
  env var, and `resolver.ts` gives env unconditional precedence with
  `locked: true` — Advanced Configuration would show the knob disabled with
  an env pill, making step 1 below unperformable.
- Set **Content-QA (Whisper) model** to a non-default value (e.g. `small`) in
  Advanced Configuration and let the sidecar restart. Confirm from the sidecar
  log / `/health` that `faster-whisper` actually loaded `small`, not `base`.
- Open Model Manager: the Whisper row must report `small`'s on-disk size and
  path, not `base`'s.
- Click **Remove**. It must delete the `small` snapshot directory and leave
  any pre-existing `base` snapshot untouched — the inverse of the pre-fix
  behaviour, which deleted `base` and left the model actually in use on disk.
- Run the in-app installer (Account → Models → Whisper → Install) with
  `small` configured and confirm `install-whisper.mjs` fetches `small` (its
  `[install-whisper]` step lines / the resulting HF cache snapshot name), not
  `base` — pinning that the installer spawn now receives an explicit
  `--model` flag carrying the live value rather than falling back to its own
  `process.env.ASR_MODEL || 'base'` default. Confirm the install card's own
  copy also names `small`, not a hard-coded `base` (m1 fix).
- **Separately**, confirm the documented CLI path
  (`node server/tts-sidecar/scripts/install-whisper.mjs`, no flags) fetches
  `base` in this scenario, not `small` — it has no access to
  `user-settings.json`, so it cannot see the UI override; only the in-app
  installer (which always passes `--model`) reflects the configured model.
  This is expected, not a defect — it's why the script's usage comment now
  says to pass `--model` explicitly for a UI-configured, non-default model.

*Needs:* the sidecar venv with `faster-whisper` installable, network access
for the HF download of a second model size, and write access to the HF hub
cache to seed/inspect both `base` and the configured model's snapshots. No GPU
required. *Criteria:* this row plus PR #2008's description of the failure
scenario. *Cost:* short — one restart-sidecar cycle, one install run, one
Remove click.

> **Wave-3 step 3, 2026-08-20 — STILL OWED (partial discharge).** Run against
> the live sidecar venv (read-only), isolated on port :9111 so the box's
> shared :9000 sidecar was never touched. Every downstream reader is
> DISCHARGED with real command+output: config reach (`PUT /api/config`),
> Model Manager reflecting the override before download, a real Hugging Face
> download of Whisper `small`, Model Manager reflecting it post-download,
> Remove (deletes `small`, leaves `base`), the in-app installer path
> (`--model small`), and the documented bare-CLI path (correctly falls back
> to `base`). **What's still owed — not a caveat, the reason this row stays
> open:** `ASR_MODEL=small` was set by hand on a standalone sidecar rather
> than driven live through the Node supervisor's real restart-sidecar
> env-injection loop (blocked by this box's single-instance :9000
> constraint); the registry wiring itself was only confirmed by reading
> `server/src/config/registry.ts` and `spawn-sidecar.ts`'s source, not
> executed end-to-end through the supervisor. **Correction, 2026-08-20:** a
> verify pass found this row had been mislabeled DISCHARGED on the strength
> of that source-read alone — a read is not the same as exercising the live
> path, and the row is corrected here to STILL OWED until the supervisor's
> actual env-injection loop is driven for real. Full evidence:
> `docs/testing/onbox-wave3-results/step-3-sidecar-install-config-reach.md`.
>
> **Wave-4 step 4, 2026-08-21 — blocker RE-DERIVED LIVE, not inherited from a
> source read.** This worktree started its own server (own HTTP port, own
> `.env`, no port override reaching the sidecar) and confirmed live that the
> box's single-instance `:9000` sidecar is always **adopted**, never spawned:
> the server log read "already listening on :9000 ... skipping spawn ...
> adopted". `buildSidecarEnv` and the other restart-sidecar env-injection
> knobs only run on an owned spawn (`spawn-sidecar.ts`) — the adopt branch
> returns before that code path is ever reached. So the registry
> env-injection loop is structurally unreachable from this worktree without
> either disturbing the shared sidecar (forbidden) or waiting for it to go
> down (not arrangeable). This confirms, live, the same conclusion wave-3
> reached by reading source only — the row's disposition is unchanged (STILL
> OWED), but the evidence is now first-hand. Every other reader (resolver,
> Model Manager, Remove, both installer paths) stays discharged from wave 3,
> unaffected. Full evidence:
> `docs/testing/onbox-wave4-results/step-4-b2-step8-and-a29-blocker.md` Part 2.

---

### A28 · Golden-audio bless guards don't rubber-stamp an honest bless, and `_make_kokoro` exercises a real engine (PR [#2032](https://github.com/dudarenok-maker/Castwright/pull/2032), closes [#1995](https://github.com/dudarenok-maker/Castwright/issues/1995), [#2003](https://github.com/dudarenok-maker/Castwright/issues/2003), [#1987](https://github.com/dudarenok-maker/Castwright/issues/1987)) · **Kokoro weights present; single 8 GB card is enough**

PR #2032 (hardened further by the independent pre-merge review that produced
this row) closes three "a gate that silently stopped asserting" defects in
`server/tts-sidecar/tests/golden/compare.py`'s bless guards and in
`test_golden_regression.py`'s `_make_kokoro`. All three files' pure-function
gating tests (`test_golden_compare.py`, `test_instruct_bless_gating.py`,
`test_make_kokoro_gating.py`) are mutation-verified and run in the fast
`test:sidecar` tier — but two behaviours only a real bless run against real
weights can prove, and neither was exercised on real hardware for this PR:

- **A guard that never blocks honest work.** Every guard added/hardened here
  (`bless_guard`'s G1/G2, `bless_guard_thresholds`'s tolerances check and its
  new `previously_blessed` disambiguation) is proven only against synthetic
  fixtures. The thing that would make it a *rubber stamp in the other
  direction* — refusing a bless that changed nothing real, or demanding
  `GOLDEN_REBLESS_THRESHOLDS=1`/`GOLDEN_REBLESS_CONTENT=1` on a routine,
  uncontended re-bless — has never been observed end to end.
- **`_make_kokoro` against a real `KokoroEngine`.** `test_make_kokoro_gating.py`
  pins the classifier wiring (`synthesise_or_skip` / `prereq.py`) with a
  stubbed engine; #1987's actual claim — a genuine CUDA/model-corruption
  failure during Kokoro warm-up now FAILS the test instead of reading as a
  green SKIP — has not been forced against the real engine.

- **Prerequisite:** Kokoro weights installed
  (`server/tts-sidecar/voices/kokoro/kokoro-v1.0.onnx` +
  `voices-v1.0.bin`), sidecar venv bootstrapped. A single 8 GB card is
  sufficient (Kokoro is the ~1 GB fallback engine); CUDA is not required —
  `ASR_DEVICE=cpu`/CPU Kokoro also exercises this.
- Run `npm run test:golden-audio -- --bless --sidecar-only` on a clean,
  **uncontended** box (check `nvidia-smi` first — this PR's `--bless`
  contention warning should print nothing). Confirm it completes and writes
  `kokoro-baseline.json` / `instruct-baseline.json` **without**
  `GOLDEN_REBLESS_CONTENT=1`, `GOLDEN_REBLESS_THRESHOLDS=1`, or
  `GOLDEN_REBLESS_MEASUREMENTS=1` set on a routine, uncontended re-bless.
  **Amended by #2045 F1/F2, then again by #2060/#2061/#2062/#2069** (the
  `identity`/`loudness_dbfs` guard, added by #2035 after this row was
  written, was noise-tolerant-and-WRITTEN as of #2045; #2060/D4 later
  changed the WRITE side, not the accept side): `kokoro-baseline.json`'s
  `transcript`/`text_edits`, `instruct-baseline.json`'s `tolerances` block,
  AND — since #2060/D4 — `instruct-baseline.json`'s `identity`/
  `loudness_dbfs` figures too must ALL stay BYTE-IDENTICAL on a routine
  re-bless (or the guard is broken). "Figures MAY move by run-to-run
  noise" was true before D4 and is **no longer a meaningful thing to
  check** — a within-epsilon noise-sized move is still ACCEPTED (not
  refused, no flag needed), it just no longer REWRITES the committed
  reference, so the file staying byte-identical is now the EXPECTED
  outcome for `identity`/`loudness_dbfs` too, not evidence on its own that
  anything happened. What real hardware is uniquely placed to confirm
  instead is the ECHO: the console should still print a `[golden-bless]
  identity moved within epsilon ... (noise -- reference unchanged) -- ...`
  / `[golden-bless] loudness_dbfs moved ...` line whenever this run's raw
  measurement differs AT ALL from the committed figure (real hardware
  noise makes a nonzero diff near-certain, even though the file itself
  won't change) — the echo is the part a `git diff` alone can't confirm,
  and it's the accept-path half of the guard real hardware is uniquely
  placed to exercise (both the ROUTINE-bless-doesn't-need-the-flag half
  AND the noise-gets-echoed-but-not-written half need a REAL measurement
  pair with real noise between them — a synthetic fixture can only assert
  the arithmetic, never that actual noise clears epsilon on a real box). A
  byte-identical block with an echo present is the guard working; a
  byte-identical block with NO echo at all just means this run's raw
  measurement happened to land exactly on the committed figure — don't
  read bare byte-identical output alone as proof the guard fired; the
  echo is the falsifiable signal. `blessed_at`-adjacent housekeeping
  fields may still move as before.
- **This run is also the only thing that retires the identity epsilon's
  open question** (#2066). `IDENTITY_COSINE_EPSILON` moved 0.015 → 0.005
  because 0.015 was derived from an unrelated ceiling (`identity_cosine_max`
  = 0.15) rather than from measured noise. 0.005 is ≈3.6× the **single**
  run-to-run delta recorded anywhere in the repo (`metadata.notes`' ~0.0014)
  — one observed figure, on one leaf, while the guard refuses on the `max`
  across five. Nothing in-repo measures the per-leaf distribution. So record
  the **actual per-leaf deltas** you observe here, not just pass/fail: if any
  single leaf routinely clears 0.005, the constant is too tight and this
  gate refuses honest work. That measurement is the deliverable.
- Then force one refusal for real: hand-edit a committed baseline to null out
  its `transcript` (or delete its `tolerances` key) exactly as a bad
  merge-resolution would, re-run the same `--bless` command, and confirm it
  refuses with the expected `GOLDEN_REBLESS_*` message and leaves the file
  byte-identical to before the attempt — then revert the hand-edit.
  This is the "#2003/#1995 shape, on a real file, via the real CLI entry
  point" check the unit tests can only approximate with `tmp_path` fixtures.
- **Amended by #2045 F1/F2, then #2060/D1:** also force one WINDOW-sized
  refusal on `instruct-baseline.json`'s `identity` block (hand-edit one
  committed `identity.cosine.<emotion>` figure by clearly more than
  `IDENTITY_COSINE_EPSILON`, e.g. +0.05), re-run the same `--bless`
  command, and confirm it refuses (not just accepts-and-echoes) with the
  expected `GOLDEN_REBLESS_MEASUREMENTS` message — **not**
  `GOLDEN_REBLESS_THRESHOLDS`, which the #2060 flag split now reserves for
  `tolerances` alone — and leaves the file byte-identical — then revert
  the hand-edit. This is the boundary the noise-tolerant epsilon exists to
  draw; the routine-bless bullet above only exercises the accept side.
- Run `npm run test:golden-audio -- --sidecar-only --engine=kokoro -m golden`
  (i.e. `test_golden_regression.py`'s real `_make_kokoro`-backed tests) once
  normally (expect pass), then deliberately break the engine (e.g. rename
  the `.onnx` weight file mid-run, or force a CUDA OOM by holding VRAM) and
  confirm the run now **FAILS** rather than SKIPping — the #1987 defect this
  PR closed. Restore the weights afterward.

*Needs:* Kokoro weights on disk, a box quiet enough that `--bless` measures a
stable, reproducible value (no concurrent GPU work), and permission to
hand-edit a baseline JSON for the refusal drill (revert before committing).
*Criteria:* this row; PR #2032's own mutation-verification table is the
synthetic-fixture half of the evidence, this row is the real-file half.
*Cost:* short — one clean bless, one deliberately-broken bless, one
deliberately-broken Kokoro run; well under an hour total.

---

### A29 · Cast-time clone-readiness gate — the fixes actually fix ([#1980](https://github.com/dudarenok-maker/Castwright/issues/1980), plan [276](../features/archive/276-cast-time-derivability-warning.md)) · **single 8 GB card + a real cloned voice**

The gate's *verdict* is heavily tested — a fixture table, a co-oracle contract
test binding it to the render's own oracle, an e2e walkthrough. What no suite
proves is that pressing the buttons **repairs the render**. Every automated
layer stops at the API response; none of them derives an artifact or synthesises
a line.

Two specific gaps, one of them structural:

- **`derive-failed` / "Retry derive" is unreachable in mock mode.**
  `mockCloneVoice` unconditionally stamps `engines.qwen.status: 'ready'`, and no
  exported mock mutator can move a slot to `'failed'`. So the e2e spec
  (`e2e/clone-readiness-gate.spec.ts`) covers `no-transcript` and the two silent
  controls and **cannot** cover this CTA at all. It is untested outside unit
  level by construction, not by omission.
- **"Add transcript" is only proven to persist.** The server test asserts the
  write; nothing asserts that a Qwen derive then *succeeds* against the
  corrected text — which is the entire premise of the CTA.

Run:

- Ingest a clip **without** a transcript, assign it while the session engine is
  Coqui (expect 200 + #1933's advisory), then switch the session engine to Qwen
  and press "Approve cast & start generating". The gate must name the character,
  Qwen, and the missing transcript, and offer **Add transcript**.
- Use the CTA. Then **render a chapter** and confirm the cloned voice actually
  speaks on Qwen — the derive succeeded against the user-supplied text. Capture
  the resolved voice key from `characterSnapshots`, not just the absence of an
  error.
- Force a genuine `failed` slot (a real derive failure — e.g. attempt a Qwen
  derive against an empty transcript on-box), confirm the gate reports
  **derive-failed**, press **Retry derive**, and confirm the predicate
  re-evaluates to the *underlying* cause (`no-transcript`) rather than reporting
  healthy. Plan 276 Decision 7 argues this is why the CTA cannot loop; nothing
  automated exercises it against a real stamp.
- **Control:** with the session engine switched back to Coqui, the same cast
  must produce **no** gate. Steps above pass equally well against a check that
  always warns.

*Needs:* the 8 GB card, a real sidecar, and a real cloned voice with a real
master clip. *Criteria:* the run sheet
[`clone-readiness-gate-onbox-acceptance.md`](clone-readiness-gate-onbox-acceptance.md);
walkthrough steps 1-7 in plan 276. *Cost:* short if it rides along with A1's
cloning session, which already stages a real clone on this card.

### A30 · Cast/analysis `characterId` drift — Wave 1 resolver ([#2040](https://github.com/dudarenok-maker/Castwright/issues/2040), [implementation plan](../superpowers/plans/2026-08-01-cast-character-identity.md)) · **single 8 GB card, Qwen resident**

Wave 1 ships a **read-time** fix only: `buildCastResolver` resolves a frozen
segment's `characterId` through a separator/case normaliser before the code
falls back to the narrator. It is fully unit- and route-tested against
synthetic fixtures. What no automated suite proves is the thing the feature
is *for* — that re-rendering an already-drifted chapter on the real workspace
now puts the character's own voice on their lines rather than the
narrator's. A read-only, dry-run resolver check already ran against the real
20-book workspace (design spec §6: 68 of 188 orphaned segments recover via
the normalised-id tier alone, with an empty history) — **that measured id
resolution, not a render.** This row is the render.

Real, already-affected fixture (confirmed 2026-08-02, not synthetic):
*Playing with Fire* (Derek Landy) at `C:\AudiobookWorkspace\books\Derek
Landy\Skulduggery Pleasant\Playing with Fire`. `the-torment` (67 segments,
cast id `the_torment`, a **tuned Qwen 1.7B voice**) and `lightning-dave` (1
segment, cast id `lightning_dave`) both recover under the normalised-id
tier — RC2's underscore-vs-hyphen split. `pool-player-2` (6 segments, cast id
`pool_player`) shares chapter 16 with `lightning-dave` and is the row's
built-in **negative control**: its `-2` collision suffix must still defeat
resolution, unchanged, since that needs Wave 2/3.

- Re-render chapter 19 (`the-torment`, 37 of its 67 segments) and chapter 16
  (`lightning-dave` + `pool-player-2` together). Confirm the fresh
  `segments.json` gains a `characterSnapshots` entry for `the-torment` /
  `lightning-dave` naming their own voice (Torment's tuned
  `qwen-YaC5ot82IqTLpeDbHd77F`, not `qwen-narrator`), and that
  `renderedFallbackEngine: "kokoro"` — present on every affected segment
  today — is gone from those two.
- **Listen.** Torment's line at chapter 19 `groupIndex: 25` ("Kill the
  child.") must be audibly a different voice from the narrator, not merely a
  different id in the JSON.
- Confirm `pool-player-2` is unchanged: still `renderedFallbackEngine:
  "kokoro"`, no snapshot entry. A resolution here would mean the resolver is
  matching more aggressively than designed.
- Cross-check the Cast screen's orphaned-id banner (#2023) no longer names
  `the-torment` / `lightning-dave` for this book after the two re-renders,
  while still naming `pool-player-2`.

*Needs:* the 8 GB card, a real sidecar with Qwen resident, and the real
workspace book above (back up its two affected chapter files before
re-rendering). *Criteria:* the run sheet
[`cast-id-drift-onbox-acceptance.md`](cast-id-drift-onbox-acceptance.md).
*Cost:* short — two single-chapter re-renders on an already-imported,
already-analysed book.

---

### A31 · Cast/analysis `characterId` drift — Wave 3 repair pass `--apply` run ([#2040](https://github.com/dudarenok-maker/Castwright/issues/2040), [implementation plan](../superpowers/plans/2026-08-01-cast-character-identity.md)) · **no GPU needed; real workspace + server stopped**

Wave 1 (A30) and Wave 2 (the characterId-drift re-analysis, now discharged) are proven or pending against a single already-drifted
chapter/book each. Wave 3's `scripts/repair-cast-id-drift.mjs` is the pass meant
to sweep the **whole** 20-book workspace at once.

> **PARTIALLY DISCHARGED — `--apply` was run 2026-08-05** (Claude Code session on
> the dev box, dudarenok-maker), against `main` @ `f3d6ae0f`. The write path is
> now proven; **§8.7 (does the fix reach actual audio — re-render *Заказ
> Коалфолла* ch2 and listen) and §8.8 (Cast-screen banner cross-check) are still
> owed**, so this row stays open for those two. The third item this row used
> to list as owed — a fresh dry run confirming the #2107 fix's numbers — has
> since been run (read-only, never `--apply`) and is folded into the #2107
> writeup below.
>
> **Wave-3 step 9, 2026-08-20 — OPERATOR.** Per
> `docs/testing/onbox-wave3-plan.md` §2 (itself re-deriving this row's own
> §8.7/§8.8 text above): §8.7 needs a real TTS render of *Заказ Коалфолла*
> ch2 plus human listening, and §8.8 needs a live-browser Cast-screen
> cross-check — neither is agent-runnable. This row joins
> `onbox-sitting-cloning-identity.md`'s row list alongside A30 (wave-3 step 4
> re-confirmed the verdict without new evidence; nothing else about this row
> changed). The live-view publish reflecting this move is still owed to the
> operator.
>
> **What was observed.** The liveness rail refused first, against a *real*
> `npm run dev` — which bound **LAN HTTPS 8443 only, never 8080**, so it was the
> `LAN_HTTPS_PORT` half of the probe that caught it (exit 1, nothing written; a
> probe covering only the default 8080 would have missed this server). With the
> server stopped, `--apply` recorded exactly the 3 predicted aliases across
> **2** books — `mayrin → mairin`, `coalfall → coalfall-dragon` (*Заказ
> Коалфолла*), `lady-alina → dame-alina` (*Everblaze*). No other book gained a
> `cast-id-history.json` (0 → 2 workspace-wide). All **20** `cast.json` files
> byte-unchanged (md5 before/after). The immediate dry re-run showed auto-records
> **3 → 0**, skipped **0 → 3**, report-only **93 / 161 unchanged** — the write is
> durable.
>
> **Two defects filed from the run, neither blocking the write itself:**
> [#2107](https://github.com/dudarenok-maker/Castwright/issues/2107) — **FIXED,
> then WIDENED by an independent review + owner decision**
> (`scripts/repair-cast-id-drift.mjs`, `fix/scripts-2107-rerender-rows`) — the
> re-render list dropped **17 rows / 120 segments → 13 / 93** afterwards, losing
> exactly the 27 segments the new aliases cover, whose audio is still
> narrator-substituted on disk (the list is documented as unconditional on
> auto-record status, and `120` was this row's stated damage figure at the time).
> Root cause: `collectSegmentOrphans` built its resolver WITH the on-disk
> `cast-id-history.json`, and any id that resolved via ANY successful tier hit a
> blanket `continue` — treated identically to a genuine live `'exact'` match,
> even though the `'history'`/`'normalised-history'` tiers depend on
> `supersededBy`, a table that can gain an entry (this script's own prior
> `--apply` run, here) strictly AFTER the segment's audio was frozen to disk. A
> first-round fix moved only those two tiers into `orphans`, keeping
> `'normalised-id'` exempt on the reasoning that it depends only on the CURRENT
> live cast list, never on `supersededBy`. **Independent review found that a
> non-sequitur** — it proves no *rename* happened, not that the rendered bytes
> are correct — and pointed at THIS row's own A30 evidence: *Playing with
> Fire*'s `the-torment`/`lightning-dave` both recover under `'normalised-id'`
> today, but were rendered **before Wave 1's resolver existed at all**, when
> `resolveGroup` substituted the narrator regardless of tier. There is no
> per-segment evidence on the real workspace to discriminate a genuinely-fine
> `'normalised-id'` match from a stale one — `renderedFallbackCharacterId` and
> `characterSnapshots` are absent from all 84,642 real segments, only
> `renderedFallbackEngine` (77 segments) exists — so the owner widened the fix:
> **only `'exact'` means the rendered bytes are fine; the other three tiers all
> list.** Over-reporting is the safe failure direction for a one-shot repair
> tool. This also changes what `--apply` *writes* (a related gap: the
> "already-recorded" skip compared raw strings against `supersededBy` while the
> resolver itself compares normalised — now fixed to match on the same
> footing, latent-not-live on the real workspace today). **Measured via a fresh
> dry run against the real workspace (read-only, never `--apply`):** re-render
> candidates move from 17/120 to **23 rows / 188 segments** (188 = the original
> full-workspace orphan count — the arithmetic check that this is now the
> complete set); auto-recordable aliases move from 0 (the three real aliases
> are already recorded and correctly skip) to **2 / 68 segments**
> (`the-torment`/`lightning-dave`, previously invisible under the removed
> `autoReconciled` bucket); reported-for-human-decision moves from 93/161 to
> **91 ids / 93 segments** (161 − 68 = 93 segments, 93 − 2 = 91 ids — the whole
> delta is `the-torment`/`lightning-dave` moving out of report-only). Full
> console output archived with the PR.
>
> **Fix round 2 (independent review, 2026-08-05) found two more defects in
> the #2107 fix itself, both now closed:** (1) the "already recorded" skip's
> normalised-footing fix from round 1 (`supersededByNormKey`, a hand-built
> map) was itself an instance of this wave's recurring shape — it diverged
> from the real resolver on normalised collisions, tier precedence, and dead
> alias targets, each a **false skip** that would drop an id off the
> human-decision list entirely. Deleted; the guard now asks the real,
> history-aware resolver (`historyResolver`, threaded from `main()`, not
> reconstructed) whether an id resolves via `'history'`/`'normalised-history'`
> directly. (2) the widening opened an undeclared write path: Tier A (name)
> runs before Tier B (id shape), and nothing checked a Tier A candidate
> against what the id already resolves to today — a stale cache entry naming
> a different character could repoint real segments' attribution onto the
> wrong live character, durably. A new guard withholds and reports that
> conflict instead of writing it. **Both were verified latent, not live, on
> the real workspace** — a fresh dry run (read-only, never `--apply`, same
> command as above) reports the identical **23 rows / 188 segments**,
> **2 / 68 segment** auto-recordable aliases, and **91 ids / 93 segments**
> report-only; neither real auto-record (`lightning-dave -> lightning_dave`
> Tier A, `the-torment -> the_torment` Tier B) trips the new conflict guard,
> since both already agree with their own live id-shape resolution.
>
> **Fix round 3 (independent review, 2026-08-05) found the round-2 fix
> itself defaulted fail-OPEN, closed:** `historyResolver` (threaded through
> `main()`) defaulted a missing value to `{ resolve: () => undefined }` when
> omitted — but `planBookRepairs` no longer reads `history.supersededBy`
> directly at all (that was the whole point of the round-2 fix), so a
> caller that omitted the resolver while still passing a fully populated
> `history` got **zero protection** from either guard, with no error.
> `undefined` from `.resolve()` means both "asked, nothing resolves" and
> "never asked" — the tenth instance of this wave's recurring shape, one
> level up from round 2's own fix. Measured on the round-2 conflict-guard
> probe: omitting the resolver auto-recorded a 67-segment durable repoint
> onto the wrong character; omitting it with `history.supersededBy`
> populated also went silently past the already-recorded skip. Fixed the
> same way `cacheAvailable`'s own pre-#2093 fail-open default was fixed:
> default to building the REAL resolver from the args already in scope
> (`buildCastResolver(liveCast, history)` — the identical construction
> `collectSegmentOrphans` uses), so an omitted `historyResolver` is a
> (redundant) optimisation for the production path, never a correctness
> hole for any other caller. Also printed the re-render list's segment
> total (`188`) in the summary line alongside the row count (`23`), which
> previously required an operator to sum every row by hand to get the
> figure this row's own arithmetic check depends on. **Verified latent, not
> live** — a third fresh dry run reports the identical **23 rows / 188
> segments** (now printed directly rather than hand-summed).
> [#2108](https://github.com/dudarenok-maker/Castwright/issues/2108) — **FIXED**
> (PR #2102, before this branch was cut) — a wrong `WORKSPACE_DIR` used to scan
> **0** books and still print `books missing analysis-cache evidence: 0` and
> exit **0** from `--apply`, because the script does not read `server/.env`, so
> a bare command hits an empty `<home>/AudiobookWorkspace`. `--apply` now
> refuses outright on a zero-book scan (`shouldRefuseApplyForEmptyScan`,
> `scripts/tests/repair-cast-id-drift.test.mjs`) — this note used to still
> describe it as open; corrected here.
>
> **Revision-sensitive:** the numbers above are against the **pre-#2102** global
> cache gate. **#2102 has since landed**: `books missing analysis-cache evidence`
> now reads **1** (*Unlocked* has a cache that parses and names nobody) and
> `books with an auto-record withheld: 0` is the line that actually gates
> `--apply` (see the current dry-run figures below, which already reflect
> post-#2102 code). Note for the record that *Unlocked* is not "nothing to
> repair" — it carries **34 orphaned segments** across ch63/ch67 under
> `unknown-male`; what makes withholding safe there is that a reserved
> fold-bucket **source** is never auto-recorded regardless of evidence, which
> fires before the ambiguity veto matters at all.
>
> **Four more filed issues fixed 2026-08-05
> ([#2097](https://github.com/dudarenok-maker/Castwright/issues/2097),
> [#2135](https://github.com/dudarenok-maker/Castwright/issues/2135),
> [#2130](https://github.com/dudarenok-maker/Castwright/issues/2130),
> [#2134](https://github.com/dudarenok-maker/Castwright/issues/2134)),
> after a round-2 review caught #2134's first fix backwards:**
>
> - **#2134 round 1 (guard 4/ranker inert on drifted ids) turned
>   `classifySnapshotEvidence`'s new `'no-evidence'` outcome into a VETO —
>   round 2 review found that backwards and reverted it to an annotation.**
>   `characterSnapshots` is a file-level map written ONLY for an id that was
>   LIVE in `cast.json` at render time. Every id this loop considers is, by
>   definition, NOT live today (that is what makes it an orphan) — so for
>   this population, snapshot presence/absence is not neutral: **presence**
>   means the id WAS live at render (audio already correct, drift happened
>   after) and **absence** means the narrator was substituted (the actual
>   A30 damage this pass exists to fix). A veto on absence therefore blocks
>   exactly the aliases that repair real damage and passes exactly the ones
>   that needed no repair — replayed against the real workspace with
>   `supersededBy` emptied, the round-1 veto would have blocked **two of the
>   three aliases already applied and accepted on this box**
>   (`mayrin`→`mairin`, `coalfall`→`coalfall-dragon`) while letting the
>   already-fine `lady-alina`→`dame-alina` alias through. `'no-evidence'`
>   now flows through to auto-record, carrying an honest "guard 4 not
>   evaluable" annotation on the row and console line instead of either a
>   false claim of verification (the pre-#2134 state) or a wrong block (the
>   round-1 fix). `'conflict'` (real, disagreeing snapshot evidence for a
>   named id) is unaffected and still downgrades to report-only. **Net
>   effect: the fresh dry run's figures are IDENTICAL to the pre-#2134
>   baseline** — auto-recordable **2 aliases / 68 segments**, report-only
>   **91 ids / 93 segments**, re-render **23 rows / 188 segments** — because
>   round 1's veto and round 2's fix cancel out for this real data; what
>   changed is honesty (the console line now says plainly when guard 4 had
>   nothing to verify), not the write decision.
> - **#2097 + #2135 (evidence that can't be read must count as UNKNOWN, not
>   CLEAN) — confirmed sound by round-2 review; NOT live on the real
>   workspace today, no figure change.** `collectBooks` now counts and names
>   any dropped book (`'not-yet-analysed'` vs `'unreadable'`, the latter
>   refusing `--apply`); `collectBakNameEntries` now returns `bakAvailable`,
>   gating a per-book `withheldForMissingBak` auto-record guard the same way
>   `cacheAvailable` already gates cache. Round 2 also closed five smaller
>   gaps found by review: `collectBooks`'s shape check now uses
>   `Array.isArray`, not truthiness (a truthy non-array `characters` field
>   used to be silently accepted and later crashed `planBookRepairs`); its
>   `readdirSync` calls are now guarded the same way its bak sibling's is
>   (an unreadable author/series directory used to throw out of `main()`
>   uncaught); `collectBakNameEntries`'s `characters` field is now
>   `Array.isArray`-checked too (a string silently iterated to zero entries,
>   an object threw); and a suspected (unverified — not reproducible on this
>   box) gap where `fs.existsSync` swallows `EACCES` the same as "doesn't
>   exist" is closed defensively via a tri-state file read that
>   distinguishes `ENOENT` from every other read failure. The fresh dry run
>   reports **books scanned: 20** (no drops — every book's
>   `cast.json`/`state.json` is readable), **books with unreadable
>   cast.json.bak.* evidence: 0**, and **books with an auto-record withheld
>   for missing bak evidence: 0** — matching #2135's own real-workspace scan
>   (41 bak files, 0 unparseable). **Correction (round 3 review,
>   2026-08-05): the "confirmed sound" claim above was itself wrong.**
>   `collectBooks`'s discriminator required BOTH `cast.json` AND
>   `state.json` to be genuinely missing before granting the legitimate
>   `'not-yet-analysed'` reason — but `state.json` is written at import
>   time, before any analysis, and `cast.json` is created only later, during
>   analysis stage 1 (reparse re-creates the identical shape: it deletes
>   `cast.json` and keeps `state.json`), so a book between import and first
>   analysis has `state.json` present and `cast.json` absent — misclassified
>   as `'unreadable'`, refusing `--apply` for the entire workspace over one
>   freshly-imported, otherwise-healthy book. Fixed by judging each file
>   independently: only a file that is PRESENT but unreadable or
>   wrong-shaped counts as lost evidence; a file that is genuinely missing
>   never does, whichever file it is. **Not live on the real workspace
>   today** — none of the 20 books are mid-import — so no figure moves.
> - **#2130 (a resolver tier rename would go undetected) — relocated after
>   round 2 review found the original fix couldn't fire in CI at all, for
>   two independent reasons: the job that runs it never builds the server,
>   and (separately fatal) that job's own scope condition doesn't even run
>   on a `server/src`-only diff.** The coupling test now lives at
>   `server/src/store/cast-resolve.repair-pass-contract.test.ts`, in the
>   **server** test suite — vitest transpiles `cast-resolve.ts` straight
>   from source (no `server/dist` build needed) and that suite already runs
>   on every `server/src/` change, closing both gaps at once. Proven twice:
>   renamed `'exact'` to `'exact-id'` in `cast-resolve.ts`, ran the new test
>   with `server/dist` entirely absent (confirming no build is needed) and
>   watched it go red, then reverted. Test-only, no script behaviour change,
>   no figure change.
>
> Dry run command: `WORKSPACE_DIR=C:/AudiobookWorkspace
> CACHE_DIR=<primary-checkout>/server/handoff/cache node
> scripts/repair-cast-id-drift.mjs` (no `--apply`).

> **Further revision, #2092/#2089 Task 9 (pair-scoped reject filter):** the
> `--apply` run recorded above predates this fix and involved zero rejected
> pairs — no book in the real workspace has ever had a `rejectedPairs` (or
> even legacy id-wide `rejected`) entry, since the Cast-screen "Not the same
> character" action had not shipped to a real run of the app yet. None of the
> auto-record/report-only/skipped figures above change as a result of this
> fix. What changes going forward: the repair script's own skip used to be
> id-wide (any rejection anywhere blocked that id from ever auto-recording
> again); it is now pair-scoped, so a reject against one candidate no longer
> withholds a DIFFERENT, later candidate for the same orphaned id. This only
> has real bite once a real book has an actual rejected pair on disk — a
> future `--apply` run against a workspace with a live rejection should be
> spot-checked against this row's own "3 aliases / 93 reported / 17 re-render
> rows" baseline to confirm a since-corrected reject doesn't reappear as
> withheld.

Every number below comes from the pass's dry-run mode, which writes
nothing. No automated test can substitute for the real run: the pure helpers
(candidate ranking, ambiguity/reserved-source guards, the re-render list shape)
are unit-tested against synthetic fixtures, and the liveness probe was verified
live against dummy listeners (see `task-18-report.md`) — but nothing has ever
exercised the actual `--apply` write path against the real
`C:\AudiobookWorkspace\books` tree.

**Dry-run result (independent-review Critical C1 fix applied, re-measured
2026-08-05 with `CACHE_DIR` correctly pointed at the checkout that ran this
workspace's analysis):**

- **3 auto-recordable aliases, 27 segments** — `mayrin` → `mairin` (8 segments)
  and `coalfall` → `coalfall-dragon` (13 segments), both in *Заказ Коалфолла*;
  `lady-alina` → `dame-alina` (6 segments) in *Everblaze*. Each is an
  unambiguous, non-reserved exact name or id match with real rendered damage
  behind it. Unchanged by the round-2 fixes below.
- **93 ids reported for a human decision, 161 segments** (was misreported as
  93 segments before the round-2 fix — see below) — includes the three
  reserved fold-bucket rows a pre-review-round-1 version of the script would
  have wrongly auto-recorded: *Exile*'s `unknown-male` (21 segments, spanning
  chapters 7/33/60 — the analysis cache separately names that bucket Timkin,
  Brant, Dwarf, Rex **and** Lord Cassius across the book) and `unknown-female`
  (14 segments), plus *Unlocked*'s `unknown-male` (34 segments). The remaining
  24 (`pool-player-2` 6, `sir-harding` 1, `silveny` 17) have no usable name
  signal anywhere in the cache or a `cast.json.bak.*`. Also includes *Playing
  with Fire*'s `the-torment` (67 segments) and `lightning-dave` (1 segment) —
  A30's own already-affected fixture (above): both already auto-reconcile live
  via the normalised-id tier, so a round-2 review fix corrected their reported
  reason from the misleading "zero rendered segments — no damage to repair"
  (which contradicted the Cast banner's own auto-reconciled section for the
  same ids) to "already auto-reconciles … already fixed, no separate alias
  needed" — this is the 68-segment (67+1) delta between the old 93 and the
  corrected 161. Neither is itself damage — both already render under their
  live id today — which is why the re-render/damage total below is unchanged
  at 120: the 161 report-only figure now mixes genuinely-orphaned segments
  with a couple of already-fine ones the script merely name-matched, and is
  no longer a proxy for "segments still needing repair".
- **17 re-render rows, 120 segments** — unconditional on auto-record status;
  writing an alias fixes metadata attribution, not the audio bytes already on
  disk. This, not the report-only total above, is the actual damage figure.
  **Superseded (#2107, widened by independent review + owner decision,
  2026-08-05, after the write below) — see the PARTIALLY DISCHARGED banner
  at the top of this row: the post-fix, post-`--apply` figure is 23 rows /
  188 segments, and `the-torment`/`lightning-dave` (68 of those segments)
  also move from "auto-reconciles, no alias needed" into a genuine 2-alias
  auto-record.** This bullet is left as originally measured — it was the
  pre-`--apply`, pre-#2107-fix baseline and is still accurate as that.
- **0 books modified, 0 `cast-id-history.json` files written** — confirmed by
  a workspace-wide file search before and after every dry run.
- **1 book missing analysis-cache evidence, 0 books with an auto-record
  withheld because of it** — these are now two DIFFERENT numbers (owner-
  decided policy, review round 2, 2026-08-05), and **only the second one
  gates `--apply`**. *Unlocked*'s cache file
  (`server/handoff/cache/mns_dLurz4I544.json`) exists and parses as valid
  JSON, but names **zero** characters (neither `stage1.characters` nor any
  `chapterCast` entry — both are optional per the schema, and this file
  happens to have neither populated) — found by independent review (Critical
  C1) after the #2093 residual-1 fix first shipped gating only on "exists and
  parses": the cross-source ambiguity veto doesn't consume "did it parse", it
  consumes the cache's actual name/id entries, so a validly-parsing,
  evidence-free file is exactly as blind to the veto as a missing one.
  `isCacheAvailable` now also requires at least one name/id entry that
  `buildNameIndex` itself would keep, not merely one `cacheEntriesOf` treats
  as string-shaped (pre-merge review I1 closed a further gap — an entry
  like `{id:"sandor", name:""}` used to pass the raw `cacheEntriesOf` check
  while `buildNameIndex`, what guard 2 actually reads, silently drops it;
  zero of the real workspace's 80 cache files exhibit this shape today).
  Re-measuring the SAME real cache directory (76 files parse, 0 unparseable,
  10 parse with zero character entries) surfaces this one book. **This is
  expected and does NOT block `--apply`** — but **not because *Unlocked* has
  nothing orphaned.** It does: **`unknown-male`, 34 segments across ch63/ch67**
  (confirmed both by a live pre-merge-review scan and by the real `--apply`
  run above). The reason it doesn't block: `unknown-male` is a **reserved
  fold-bucket SOURCE id**, and guard 1 refuses to auto-record from a
  reserved source unconditionally, firing *before* the cache-availability
  gate is ever reached — so *Unlocked*'s blind ambiguity veto never actually
  stood between the pass and a real candidate. `--apply` refuses only when a
  book's blind veto DID withhold a real candidate — that count is separately
  reported and currently reads `0`. The trigger that WOULD change this: a
  **non-reserved** orphaned id in *Unlocked* with a real Tier A/B name/id
  match (from a future re-render or re-analysis) — and, per pre-merge review
  I2, a match with **zero rendered segments** would NOT trigger it either
  (guard 3 refuses those regardless of cache evidence, before the cache gate
  is reached). Re-check before trusting the `0` if *Unlocked* changes.

- **Precondition: `CACHE_DIR` must point at the real analysis cache**, not a
  fresh worktree's own (git-ignored, per-checkout — see the script's module
  doc comment). Run the dry run first and confirm the summary reads `books
  with an auto-record withheld for missing cache evidence: 0` — `--apply`
  now refuses outright otherwise (round-2 review fail-closed fix for the
  cross-source ambiguity veto's blind spot when cache evidence is absent;
  #2093 residual 1, strengthened by independent-review Critical C1,
  tightened `isCacheAvailable` to require the file exist, parse, AND name at
  least one character; then re-scoped by owner-decided policy, review round
  2, so the refusal gates on an actual withheld candidate, not merely a book
  whose cache happens to be unusable). **A nonzero `books missing
  analysis-cache evidence` count is expected and does NOT by itself block
  `--apply`** — as measured today it reads `1` (*Unlocked*, see above), while
  the gating `books with an auto-record withheld…` line reads `0`, so this
  precondition IS currently satisfied. Don't stop just because the first
  number is nonzero — check the second one.
- **Precondition (#2108): `WORKSPACE_DIR` must actually point at the real
  20-book workspace.** Confirm the summary reads `books scanned: 20`
  alongside the cache-evidence lines above — a wrong `WORKSPACE_DIR` (the
  script defaults to `<home>/AudiobookWorkspace`, which does not exist)
  scans **0** books and, before this fix, printed a clean-looking `books
  missing analysis-cache evidence: 0` and exited `--apply` with code `0`
  having written nothing — an empty tree reading as a healthy one, on
  exactly the line this precondition told the operator to trust. `--apply`
  now refuses outright when `books scanned` is `0`, and the dry-run summary
  calls out a zero-book scan explicitly instead of rendering a row of clean
  zeros.
- Stop any real server bound to the configured probe port(s) (default `8080`
  and the LAN HTTPS `8443`) **or their auto-rebind range** (up to 19 ports
  above each default, matching `listenWithAutoRebind` — #2090) — `--apply`
  refuses outright while any of them answers, since the write is
  out-of-process and no in-process lock covers it. Confirm
  the refusal fires first, against the *real* dev server (not only a dummy
  listener): start `cd server && npm run dev`, run `--apply`, confirm it exits
  1 naming the reachable port and writes nothing, then stop the server.
- Run `cd server && npm run build`, then
  `node scripts/repair-cast-id-drift.mjs --apply` against the real workspace
  with the same `WORKSPACE_DIR`/`CACHE_DIR` as every prior dry run.
- Confirm `.audiobook/cast-id-history.json` now exists for *Заказ Коалфолла*
  with `supersededBy` containing `mayrin: "mairin"` and
  `coalfall: "coalfall-dragon"`, and for *Everblaze* with `supersededBy`
  containing `"lady-alina": "dame-alina"` — and that **no other book** in the
  workspace gained a `cast-id-history.json` file.
- Confirm every book's `cast.json` is byte-unchanged (mtime + diff) — the pass
  writes only the history side-table, never the cast itself.
- Re-run the script in dry-run mode immediately after. Confirm the three
  now-recorded aliases no longer appear in the auto-record list (already
  resolved through the history) and the 93 report-only ids are unchanged —
  proving the write was durable, not merely printed once.
- Re-render *Заказ Коалфолла* chapter 2 (the `mayrin`/`coalfall` orphaned
  chapter) and confirm the same shape A30 pins: the fresh `segments.json`
  gains `characterSnapshots` entries for `mayrin`/`coalfall` naming Мэйрин's
  and Коалфолл's own live voices, not the narrator — **listen** to confirm
  audibly, not only from the JSON.
- Cross-check the Cast screen for both affected books: the auto-reconciled
  section now names `mayrin`/`coalfall`/`lady-alina`; the needs-your-decision
  section still names the 93 remaining ids untouched by this run (spot-check
  `unknown-male` in *Exile* as the negative control — a reserved-bucket source
  must still refuse to auto-record, unchanged).

*Needs:* no GPU or TTS engine — the pass itself only reads the analysis cache
and any `cast.json.bak.*` files and writes `cast-id-history.json`. Needs the
real 20-book workspace, a completed `server` build, and the ability to stop any
locally-running Castwright server for the duration of the `--apply` call.
Re-rendering the confirmation chapter needs the 8 GB card + Qwen resident, same
as A30. *Criteria:* the run sheet
[`cast-id-drift-onbox-acceptance.md`](cast-id-drift-onbox-acceptance.md) §8
(Wave 3). *Cost:* short — one script invocation against an already-imported,
already-analysed workspace, then one chapter re-render.

> **Wave-4 step 5e, 2026-08-21 — §8.8 DISCHARGED live; §8.7 is now this row's
> sole remaining debt.** §8.8 (Cast-screen banner cross-check) was run in a
> real browser: *Заказ Коалфолла*'s auto-reconciled bucket names `mayrin`/
> `coalfall` exactly as expected, labelled "audio is current"; the negative
> control (*Exile*'s `unknown-male`, a reserved fold-bucket source) still sits
> in needs-your-decision, unmoved. Everblaze's `lady-alina` half is
> corroborated by the real `cast-id-history.json` file (read directly) rather
> than a live Everblaze Cast-screen render, since Everblaze was not one of
> the books copied into this pass's throwaway workspace. **§8.7 (re-render
> *Заказ Коалфолла* ch2 and listen — a real TTS render plus human audio
> judgement) is explicitly out of scope for an agent and stays owed to the
> operator** — it needs a human to listen. This is the row's sole remaining
> debt. Full evidence:
> `docs/testing/onbox-wave4-results/step-5e-cast-screen-browser-rows.md`.
> `docs/testing/onbox-sitting-cloning-identity.md` still correctly lists this
> row for §8.7.

### A32 · Supervisor respawn survives a refused spawn attempt ([#2037](https://github.com/dudarenok-maker/Castwright/issues/2037)) · **single 8 GB card, live sidecar**

Unit tests (`server/src/tts/sidecar-supervisor.test.ts`,
`server/src/tts/spawn-sidecar.test.ts`) fully pin the fix's logic: a refused
spawn attempt — a foreign-looking listener on the port, most commonly the
just-exited child's own socket still in TCP teardown — now feeds the same
backoff/cap budget an ordinary child exit already uses, instead of the old
unconditional `isRecycling = false` that silently ended supervision. What no
unit test can reach is the *real* race: whether a real OS socket actually
stays bound for a real window after the child process exits, and whether the
fix's backoff schedule (`[2s, 5s, 15s]`, capped at 5 attempts ≈ 52s total)
outlasts that window on real hardware — the reported incident measured the
port still held 4s after exit and free only "minutes later," and the
implementation brief deliberately declined to widen the backoff without a
real measurement behind it (D1).

- With a chapter actively rendering, kill the sidecar's OS process directly —
  **not** via `POST /api/sidecar/restart` (see the note below) — e.g.
  `taskkill /PID <pid> /T /F` against the pid in `.run/tts.pid`, or end the
  process from Task Manager.
- Grep the running server's own log for a fresh `[sidecar] spawned pid=` line
  appearing on its own, with no operator action, within the backoff window.
  Confirm the pid differs from the one killed.
- While recovery is in flight, poll `GET /api/setup/models-status` and confirm it
  never reports the TTS engine ready while no sidecar is listening on
  `:9000` — that silent "reports healthy while nothing is there" gap is
  exactly what #2037 shipped.
- Confirm the in-flight chapter either rides out the respawn (existing retry
  behaviour) or fails cleanly and is resumable — not stuck forever.
- If the box's real teardown-to-free window turns out to exceed the ~52s
  backoff budget, that is a follow-up issue with a real measurement behind
  it, not a reason to widen the backoff on the strength of this run alone.

**Do not use `POST /api/sidecar/restart` to check this** — it restarts the
sidecar itself rather than passively observing it, which is the same
operational trap that produced the #2037 outage in the first place.

*Needs:* a live sidecar, a book mid-render, and OS-level process-kill access.
*Criteria:* the acceptance bullets above; the code-level contract is
`scheduleRespawnAttempt` in `server/src/tts/sidecar-supervisor.ts` and
`onSpawnRefused` in `server/src/tts/spawn-sidecar.ts`. *Cost:* short — one
kill, one log grep, one status poll.

### A33 · Design-wins VRAM contention timeout is sized against a REAL 0.6B cold load ([#2070](https://github.com/dudarenok-maker/Castwright/issues/2070)) · **single 8 GB card**

Unit tests (`server/tts-sidecar/tests/test_design_contention.py`) fully pin
the logic with a simulated `_design_in_flight` claim: `unload_design()` now
waits (bounded, 150s) for an in-flight design to clear instead of nulling it,
and raises a typed `DesignContentionTimeoutError` if the wait expires. What no
unit test can reach is whether 150s is actually the right bound against a
REAL cold 0.6B Base load plus a real VoiceDesign forward on this box — the
figure was sized off the design path's own documented ~120s server budget,
not a fresh on-box measurement of the specific race window #2064's review
flagged.

- Start a voice design (cast review → Design a new voice), and — timed to
  land mid-design, before the design's own forward completes — trigger an
  ordinary chapter render on a *different* voice from another tab/session.
  Confirm the render's synth call **waits** for the design to finish (no
  error, just a delayed start) rather than the design failing with "VoiceDesign
  model was unloaded before this design could render."
- Confirm the design itself completes normally and its audition plays.
- If practical, force a genuinely wedged design (e.g. a killed/hung sidecar
  thread while `_design_in_flight` is still claimed) and confirm the waiting
  synth times out into the new `design_in_flight` 503 rather than hanging
  forever — and that it does so somewhere in the 150s neighbourhood, not
  immediately and not never.

*Needs:* a live sidecar with Qwen VoiceDesign installed, and a way to trigger
two overlapping requests (a second browser tab/session is enough). *Criteria:*
`unload_design`'s docstring in `server/tts-sidecar/main.py`; the sizing
rationale is in the `_DESIGN_CONTENTION_WAIT_S_DEFAULT` comment immediately
above `class QwenEngine`. *Cost:* short — one overlapped request pair.

### A34 · ASR warm-reservation figure vs. a real resident `/transcribe` peak ([#2094](https://github.com/dudarenok-maker/Castwright/issues/2094)) · **`ASR_DEVICE=cuda`, single 8 GB card**

Unit tests (`test_footprints.py`, `test_transcribe_embed_admission.py`,
`test_asr_footprint_measurement.py`) pin that a resident ASR reservation now
books the separate `asr.warm` key (128 MB seed) instead of the cold `asr` key
(400 MB), that `admit()`/`reservation()` agree, and that the MEASUREMENT
mechanism itself (a device-wide free-memory delta via
`PlacementController._device_free_mb`, not the torch-allocator peak
CTranslate2 sits outside of) is real and correctly guarded against
contamination — all proven with a scripted `_device_free_mb` sequence, no
real allocator. Not yet observed: whether 128 MB is actually enough headroom
for a real resident Whisper `base`/int8_float16 forward's activation memory
on a contended card (too low → a real, avoidable `noCapacity` refusal that
this fix was supposed to eliminate), and whether the learned `asr.warm` p95
converges to something sane once real device-wide-free-memory observations
accumulate on a box that ISN'T contended by a foreign process (the one
contamination vector `ledger.engines_holding` can't see, since it only knows
this process's own reservations).

- With `ASR_DEVICE=cuda` and content-QA enabled (`SEG_ASR_ENABLED=1`), render
  a chapter so ASR loads and goes resident, then trigger several more
  `/transcribe` calls back-to-back (a re-record round is the natural trigger).
  Confirm none of them 503 `noCapacity` on a card that has genuine room.
- Watch `FootprintTable`'s learned `asr.warm` p95 settle after ≥5 real
  observations (`_FOOTPRINT_MIN_SAMPLES`) — record what it converges to, so
  the 128 MB seed can be revisited with evidence rather than left as a guess
  indefinitely. A sane figure (double digits to low hundreds of MB) confirms
  the measurement mechanism is producing real signal on a clean box; a
  suspiciously large one (hundreds of MB to GB) points at contamination the
  ledger-based guard couldn't see (a process outside this sidecar).
- The device-wide contamination question #2094's own filing raised is now
  PARTIALLY addressed (the ledger-based guard discards a reading when another
  SIDECAR engine holds a concurrent reservation) but not fully closed — a
  foreign, non-sidecar process on the same card remains invisible to it. This
  row is where that residual gets its first real evidence.

*Needs:* `ASR_DEVICE=cuda`, `SEG_ASR_ENABLED=1`, a real book render with
content-QA on, ideally on an UNCONTENDED card (no other process holding VRAM)
for the cleanest read. *Criteria:* the `asr.warm` seed comment in
`SEED_FOOTPRINTS_MB` and `_device_free_mb`'s docstring (`server/tts-sidecar/main.py`)
and `docs/local-llm.md`'s footprint table. *Cost:* short — rides along with
any other GPU-ASR session (A20 already needs `ASR_DEVICE=cuda`-adjacent
capacity behaviour; batch together).

### A35 · Catastrophic-WER override actually catches a real Coqui language-collapse ([#2055](https://github.com/dudarenok-maker/Castwright/issues/2055)) · **Coqui/XTTS resident, ASR content-QA on**

`classifyTranscript`'s new logic is fully pinned in
`server/src/tts/segment-asr-qa.test.ts` with injected transcripts/signals — a
FLUENT, full-length, catastrophically-wrong-content transcript (WER ≥
`Math.max(catastrophicWer, maxWer)`) now overrides the "untrustworthy →
inconclusive" backstop into `drift`, while a near-empty/filler-padded
transcript, a short (<6-word) reference, and a merely-imperfect transcript are
all unaffected — each shape independently mutation-verified, including a
Russian near-silence-hallucination repro (`"Продолжение следует"`) invisible
to the English-only `HALLUCINATION_PATTERNS` list. Not yet observed: whether
this actually fires on a REAL #2026-style Coqui language-collapse (fluent
audio, wrong language, plausible duration) without a real false-positive rate
that starts re-recording perfectly good lines — `CATASTROPHIC_WER` (default
0.85, now the live registry knob `qa.asr.catastrophicWer` — retunable from
this row's own findings without a release), the 6-word reference floor, and
the 0.5 heard/expected ratio floor are all judgement calls, not
on-box-measured constants.

- With ASR content-QA on (`SEG_ASR_ENABLED=1`) and a Russian (or French/
  Spanish) book on the Coqui engine, reproduce #2026's language-collapse per
  its own repro recipe (short Russian lines, repeated synthesis — intermittent,
  not every run). Confirm a genuine collapse now gets caught and re-recorded
  (segment carries `asr.verdict: drift`, reason mentioning "catastrophically
  wrong"), where before this fix it would have read `inconclusive` and shipped
  unflagged.
- Across the same render (or a longer, healthy-content one), confirm the new
  override does **not** fire on ordinary hard-to-transcribe-but-correct lines
  — an invented character name, a foreign phrase, background noise — i.e. no
  new false-positive re-record rate versus the pre-#2055 baseline.

*Needs:* a Coqui-capable sidecar, ASR content-QA enabled, a non-English book
(Russian ideal — matches #2026's own repro). *Criteria:* the `CATASTROPHIC_WER`
comment in `server/src/tts/segment-asr-qa.ts`; #2026's own repro recipe.
*Cost:* short-to-medium — the collapse is intermittent, so budget a few
repeated renders of the same short lines, not one pass.

### A36 · Sidecar auto-scaled RAM/VRAM recycle thresholds now actually apply on a fresh install (#2179, PR #2210) · **single 8 GB card is enough**

`.env.example` used to ship `SIDECAR_RESTART_MB=0` / `SIDECAR_VRAM_RECYCLE_SOFT_MB=0`
/ `SIDECAR_VRAM_RESTART_MB=0` as literal, active env assignments — and each of the
three threshold functions in `main.py` treats a **present** `0` (or any parseable
value) as an explicit override, not as "unset." Since #2179 comments the generated
`.env.example` block out instead of emitting it active, a fresh install now leaves
all three **absent**, so the sidecar self-computes 70% of total physical RAM (hard
restart), 90% of the resident card's total VRAM (soft recycle), and 98% of the
card's total VRAM (hard restart) — three lifecycle behaviours that were silently
disabled on every install that copied `.env.example` verbatim (Pinokio, and the
documented manual/`INSTALL.md` path) until this fix, and are now live. None of this
is exercised by any pytest/vitest suite — the three threshold functions are unit-
tested for their env-present/absent MATH, not for whether a real sidecar process
ever crosses a live threshold and actually exits/recycles.

- Confirm a fresh install (a `server/.env` written from the current
  `.env.example` — i.e. all three of `SIDECAR_RESTART_MB` /
  `SIDECAR_VRAM_RECYCLE_SOFT_MB` / `SIDECAR_VRAM_RESTART_MB` absent from the
  environment) computes and uses the auto thresholds at sidecar startup (70%
  of total RAM; 90%/98% of the resident card's total VRAM) rather than
  treating them as disabled.
- Drive committed RAM up toward the ~70% ceiling (a long multi-chapter run,
  or a synthetic host-memory hog alongside the sidecar) and confirm the
  sidecar self-exits with code 43 for the supervisor to respawn, rather than
  never recycling.
- Drive reserved VRAM up toward the 90% soft threshold and confirm `/health`
  sets `recycle_pending` and a clean chapter-boundary recycle fires (not a
  mid-chapter hard exit); then, on a card where the soft recycle didn't
  already relieve the pressure, continue up toward the 98% hard threshold
  and confirm the hard self-exit fires instead of an uncontrolled OOM.
- Watch for thrash: across an ordinary render, the auto thresholds must not
  fire routinely — a card sitting in the high-80s/90s% reserved as a normal
  batch peak (see the `_TORCH_ACTIVE_RESERVED_MB` torch-managed-card
  carve-out in `main.py`) should not trip a recycle storm now that the
  ceiling is live where it was previously inert.

*Needs:* a fresh install (or a `server/.env` with the three vars removed) so
the auto path is actually reached; the single 8 GB card is enough; a way to
push committed RAM/reserved VRAM toward the thresholds (a long render, or a
synthetic memory/VRAM hog run alongside it). *Criteria:*
`_mem_restart_threshold_mb` / `_vram_recycle_soft_threshold_mb` /
`_vram_restart_threshold_mb` in `server/tts-sidecar/main.py` (`:8265-8284`,
`:8154-8185`); the #2210 PR body and `0b0e7694`'s commit message record the
before/after values. *Cost:* short-to-medium — the VRAM-pressure legs need a
way to actually saturate the card, which may need a synthetic hog rather
than a real render.

---

### A37 · ORT marker — fresh NVIDIA bootstrap ([#2192](https://github.com/dudarenok-maker/Castwright/issues/2192), plan [282](../features/282-ort-pip-consistency-marker.md)) · **no GPU needed, sidecar venv only**

Design doc §On-box acceptance, criterion 1. A from-scratch `bootstrap-venv.mjs`
run on the nvidia profile is unit-tested at the seam
(`bootstrap-venv-helpers.test.ts`'s ordering assertions), but a real pip venv's
version string, real PEP-427 directory escaping, and a real `pip check`/Kokoro
provider report have never confirmed the write actually lands correctly on a
genuinely fresh box — every other row here starts from an already-bootstrapped
venv (self-heal) or a deliberately broken one (clobbered), neither of which
exercises `installForProfile`'s write branch on a first-ever install.

- Wipe (or freshly clone into) the sidecar venv and run a genuine from-scratch
  bootstrap on the nvidia profile — not an upgrade, not the boot-time self-heal.
- Inspect `site-packages` for `onnxruntime-<version>.dist-info` at the version
  `onnxruntime-gpu` actually installed.
- Run `pip check` — expect exit 0.
- Load Kokoro and confirm it reports `CUDAExecutionProvider`.

*Needs:* the existing NVIDIA dev box, willingness to rebuild the venv from
scratch. *Criteria:* design doc §On-box acceptance item 1; run sheet §3 in
`docs/testing/ort-marker-onbox-acceptance.md`.

> **Wave-3 step 2, 2026-08-20 — STILL OWED, blocker now fixed.** Ran a genuine from-scratch
> `bootstrap-venv.mjs` on the nvidia profile against a throwaway venv (live
> venv untouched, byte-verified). Marker present at the correct version
> (`INSTALLER: castwright-ort-marker`) and `pip check` exit 0 — both
> **DISCHARGED**. The third check — Kokoro reporting `CUDAExecutionProvider`
> — **failed**: `get_available_providers()` lists it, but constructing an
> inference session with it errors (`Error 126`) and silently falls back to
> CPU. Root cause was a box-level gap: this box has only CUDA 12.4 system-wide
> while `onnxruntime-gpu` 1.27 needed CUDA 13.x/cuDNN 9.x runtime libraries.
> This blocking dependency is now resolved by PR #2576, which re-pinned
> `ONNXRUNTIME_GPU_CONSTRAINT` to `>=1.26,<1.27` (CUDA-12 line). The row
> stays STILL OWED pending the GPU-provider re-check against the fixed pin;
> see evidence doc `docs/testing/onbox-wave3-results/step-2-ort-marker.md`.

> **Wave-4 step 8, 2026-08-21 — STILL OWED, re-run after #2534's fix landed.**
> Re-ran the Kokoro GPU-provider check against `onnxruntime-gpu` 1.26.0 (the
> version #2576's re-pin resolves to), commit `6e4eac6c0129b68e8ff47db7b1503f31344248ab`
> (now on `main` via `4bb738d2`). `get_available_providers()` still lists
> `CUDAExecutionProvider`, but actual `InferenceSession` construction — both
> directly and through `kokoro_onnx.Kokoro` — still falls back to
> `CPUExecutionProvider`. **This is not the #2534 defect recurring**: the
> root cause is now confirmed as a *different*, more specific gap —
> `onnxruntime-gpu` 1.26.0's own wheel metadata requires `nvidia-cudnn-cu12~=9.0`
> only via its optional `[cudnn]` extra, which `install-ort.mjs` never
> requests (and installs with `--no-deps` besides), so no cuDNN 9 runtime is
> ever placed anywhere onnxruntime's CUDA provider will find it. A `cudnn64_9.dll`
> exists on this box only bundled inside other packages' own directories
> (`torch/lib`, `ctranslate2`), which onnxruntime does not search — confirmed
> by adding `torch/lib` to the process DLL search path as a diagnostic, which
> did not fix it either. Zero discharges this run — see evidence doc
> `docs/testing/onbox-wave4-results/step-8-a39-a40-rerun.md`. **Follow-up filed:**
> [#2600](https://github.com/dudarenok-maker/Castwright/issues/2600) — `install-ort.mjs` never requests the cuDNN 12 runtime that
> `onnxruntime-gpu 1.26.x` requires for CUDA execution, leaving Kokoro to
> silently fall back to CPU (distinct from #2534, which fixed the CUDA-13-vs-12
> mismatch itself).

### A38 · ORT marker — the reported bug: in-app Qwen3 install ([#2192](https://github.com/dudarenok-maker/Castwright/issues/2192), plan [282](../features/282-ort-pip-consistency-marker.md)) · **no GPU needed, sidecar venv only**

Design doc §On-box acceptance, criterion 2 — **this is #2192 itself**, the alpha
tester's exact scenario, with the app running. Every other row for this feature
proves a mechanism; this one is the acceptance criterion the issue was actually
filed against, and it has not been separately re-confirmed since the fix landed
(the self-heal proof in §5 exercises boot, not an in-app package install).

- Start the app normally (NVIDIA profile, a bootstrapped sidecar venv).
- From the app UI, install Qwen3 (Model Manager → the Qwen engine's Install
  action) — the exact step the original report describes failing.
- Confirm the install completes with **no** `WinError 5` / `Accès refusé` on any
  `.dll` under `site-packages/onnxruntime/capi/`.
- Load Kokoro afterward and confirm it still reports `CUDAExecutionProvider` — the
  install must not have silently swapped the GPU runtime for CPU en route.

*Needs:* the existing NVIDIA dev box, the app running. *Criteria:* design doc
§On-box acceptance item 2; run sheet §4 in
`docs/testing/ort-marker-onbox-acceptance.md`.

> **Wave-3 step 2, 2026-08-20 — STILL OWED, not run, blocker now fixed.** Needs the full app
> running plus a real click-through of Model Manager → Qwen → Install
> against a throwaway copy of the sidecar venv — scoped as its own session
> rather than rushed alongside A37/A39 in the same heartbeat. The blocker that
> prevented full discharge (the CUDA13/cuDNN9 gap A37 found) is now resolved by
> PR #2576, which re-pinned `ONNXRUNTIME_GPU_CONSTRAINT` to `>=1.26,<1.27`
> (CUDA-12 line). The row remains STILL OWED because neither the app-level test
> nor the Kokoro GPU-provider check have been re-run against the fixed pin; see
> evidence doc `docs/testing/onbox-wave3-results/step-2-ort-marker.md`.

> **Wave-4 step 8, 2026-08-21 — STILL OWED, GPU-provider sub-check re-run, in-app
> install still not attempted.** Re-ran only the shared Kokoro GPU-provider
> sub-check (this row's final check) against the #2534-fixed pin
> (`onnxruntime-gpu` 1.26.0, commit `6e4eac6c0129b68e8ff47db7b1503f31344248ab`,
> now on `main` via `4bb738d2`) — same procedure and result as A37 above:
> `get_available_providers()` reports `CUDAExecutionProvider`, actual session
> construction still falls back to CPU, root cause confirmed as the missing
> `nvidia-cudnn-cu12` `[cudnn]` extra, not a #2534 recurrence. Zero discharges;
> see evidence doc `docs/testing/onbox-wave4-results/step-8-a39-a40-rerun.md`.
> The in-app Qwen3 install click-through part of this row remains untouched —
> out of scope for this re-run (see #2561) — and would hit the same cuDNN gap
> on its own Kokoro-afterward check even once attempted.

> **Wave-4 step 5c, 2026-08-21 — STILL OWED, partially run.** The core #2192
> repro — clicking Install on Qwen3-TTS Base (0.6B) in Model Manager — ran
> genuinely in a real browser, against this worktree's own bootstrapped venv,
> and completed cleanly with **no `WinError 5`**. Screenshots captured. The
> follow-on check (confirm Kokoro still reports `CUDAExecutionProvider` after
> install) could **not** be validated: this box's TTS sidecar binds a single
> hardcoded `:9000` port shared across every worktree, another live agent
> lane already held it for the whole session, and `POST /api/sidecar/restart`
> 409'd as a result — a structural box-contention limitation this run,
> distinct from the already-filed #2534 CUDA13/cuDNN9 gap. Full evidence:
> `docs/testing/onbox-wave4-results/step-5c-a40.md`.

### A39 · ORT marker refuses — not repairs — a clobbered venv ([#2192](https://github.com/dudarenok-maker/Castwright/issues/2192), plan [282](../features/282-ort-pip-consistency-marker.md)) · **no GPU needed, sidecar venv only**

Design doc §On-box acceptance, criterion 6. `ensureOrtMarker`'s refuse-and-log
branch (the clobbered-box row of the design doc's five-state table) is fully
unit-tested against synthetic fixtures (`server/src/tts/ort-ensure-marker.test.ts`)
but has never run against a **real** clobbered venv — a box where a real plain
`onnxruntime` dist-info survives alongside the GPU distribution's dist-info (pip
uninstalls by name and never knew the two collided), but the actual files on disk
are the GPU build. This is the population #2192 itself names as the largest affected
group, and the state a wrong ownership predicate would entomb silently (see the
design doc's §The three venv states).

- **Manufacture the state deliberately**, on a scratch/throwaway venv (or a copy of
  the sidecar venv) with the intent to run the repair command afterward — this is
  destructive to a working GPU install. The corrected recipe (verified 2026-08-21,
  see the dated note below) starts from a venv that has plain `onnxruntime`
  installed and then force-reinstalls the GPU build **over** it: pip's
  upgrade-detection keys on the package NAME, so installing two distributions that
  share the `onnxruntime/` import namespace under different names does not trigger
  a replacement, and the plain package's dist-info survives on disk:
  ```powershell
  python -m venv <venv>
  <venv>\Scripts\pip install onnxruntime==1.28.0
  <venv>\Scripts\pip install --force-reinstall --no-deps onnxruntime-gpu==1.27.0
  ```
  (Versions pinned for reproducibility — plain at 1.28.0, GPU at 1.27.0, so the
  two dist-info folder names are distinguishable by directory listing alone,
  matching the unit test fixture.)
  Confirm both a **real** `onnxruntime-1.28.0.dist-info` (INSTALLER `pip`, non-empty
  RECORD) and `onnxruntime_gpu-1.27.0.dist-info` coexist with **different version
  numbers** — this is the discriminating check that proves the code either correctly
  refused to write a marker OR incorrectly wrote one. A marker and the real plain dist-info
  would be named identically if they were at the same version, making name-based detection useless. Also confirm
  that `site-packages/onnxruntime/` holds the GPU build's files
  (`capi/build_and_package_info.py` reports `package_name = 'onnxruntime-gpu'`).

> **Recipe corrected, 2026-08-21 — as part of [#2545](https://github.com/dudarenok-maker/Castwright/issues/2545) (task to address [#2535](https://github.com/dudarenok-maker/Castwright/issues/2535), the defect). Verified in ort-marker-onbox-acceptance.md §8.5.**
> The row's original recipe (`pip install --force-reinstall onnxruntime` over a
> venv already holding `onnxruntime-gpu`) does NOT reach `'clobbered'`: it
> overwrites `site-packages/onnxruntime/capi/build_and_package_info.py` to report
> `package_name = 'onnxruntime'`, so `detectOrtOwner` correctly reports `'plain'`
> and `ensureOrtMarker` takes the silent `'deleted'` branch instead. The corrected
> plain-then-GPU ordering (1.28.0 plain, 1.27.0 GPU) was verified against the real
> `detectOrtOwner`/`findPlainOrtDistInfos` from
> `server/tts-sidecar/scripts/install-ort.mjs` on a throwaway venv: it reports
> `detectOrtOwner === 'swap'` and `findPlainOrtDistInfos.length === 1` with
> discriminable versions (1.28.0 vs 1.27.0 in directory names), and
> `ensureOrtMarker` returns `'clobbered'` — exactly the refuse-and-log branch this
> row is meant to exercise (see §8.5 for complete verification).
- **Boot the server.** Expect `ensureOrtMarker` to return `'clobbered'`: a log line
  naming the condition and the exact remedy commands (PowerShell form: `$env:CASTWRIGHT_ACCELERATOR_PROFILE='nvidia'; node server/tts-sidecar/scripts/install-ort.mjs <venv-python>` or POSIX form: `CASTWRIGHT_ACCELERATOR_PROFILE=nvidia node server/tts-sidecar/scripts/install-ort.mjs <venv-python>`),
  and **no** new `onnxruntime-<version>.dist-info` marker written over the real
  distribution. `pip check` stays clean (nothing else in this throwaway venv depends on
  `onnxruntime` to have broken requirements) — the discriminating check is the `'clobbered'` return value and the
  log line naming the condition and remedy, confirming the box is refuse-and-logged
  rather than silently healed at the wrong version.
- **Run the named remedy command** and confirm it actually repairs the box: the
  swap re-runs, `onnxruntime-gpu` is reinstalled, and a legitimate marker is
  written afterward (`pip check` clean, Kokoro reports `CUDAExecutionProvider`
  again).

*Needs:* the existing NVIDIA dev box, no GPU activity required, ~10 minutes
including the repair. *Criteria:* design doc §On-box acceptance item 6, the
eight-state table and "the clobbered box takes the loud path" in
`docs/features/282-ort-pip-consistency-marker.md`; run sheet §8 in
`docs/testing/ort-marker-onbox-acceptance.md`.

> **Wave-3 step 2, 2026-08-20 — STILL OWED, real defect found.** Manufactured
> the state exactly per this row's own recipe on a throwaway copy
> (`pip install --force-reinstall onnxruntime` over an existing
> `onnxruntime-gpu`) and booted a real server against it. **No `[ort-marker]`
> log line at all** — the server booted silently as if nothing were wrong.
> Root cause: `detectOrtOwner` reads
> `build_and_package_info.py`'s `package_name` first, which post-reinstall
> genuinely reads `'onnxruntime'`, so it correctly returns `owner: 'plain'`,
> not `'swap'` — `ensureOrtMarker` never reaches the `'clobbered'` branch
> this row expects and instead takes the silent `'deleted'` path (not
> logged). The named remedy command itself was independently verified and
> works correctly when run directly. Two things are true at once and both
> are real: either the row's own manufacture recipe doesn't reach the state
> the design doc's five-state table means by "clobbered," or the `'deleted'`
> branch being silent is a gap on its own regardless of the recipe — a
> decision on both is owed to a fix agent, not resolved here. Full evidence:
> `docs/testing/onbox-wave3-results/step-2-ort-marker.md`. Filed as
> [#2535](https://github.com/dudarenok-maker/Castwright/issues/2535)
> (see #2535).

> **Wave-4 A39 re-run, 2026-08-21 — STILL OWED.** Re-ran this row's own recipe on a
> **fresh** throwaway venv (not the sidecar's own — no venv under
> `server/tts-sidecar/.venv` was touched; that path's `python.exe` mtime was
> confirmed unchanged before and after this run) against branch
> `fix/sidecar-2535-ort-marker-fix`, at committed HEAD `fe77babd` but with a
> **local, uncommitted edit to `install-ort.mjs`** containing the corrected
> clobbered-state message (later committed as `bd09fcfa`), fixing silent-defect
> #2535. The recorded log message matches the 452-character wording from that
> uncommitted edit (later bd09fcfa's wording), not the 262-character wording
> from prior merge commit 51420399. Manufactured plain-then-GPU, confirmed `detectOrtOwner === 'swap'`
> and one real plain dist-info present, then booted the real worktree server
> (`tsx watch`, `SIDECAR_VENV_DIR` pointed at the throwaway venv, port 8290 —
> free and not shared with another lane). **Result: the `'clobbered'` log
> line fired correctly**, naming the condition and the exact remedy command,
> and no marker was written over the real distribution (`pip check` stayed
> clean, matching the pinned-version case rather than wave-3's mismatched
> 1.29.0 one — nothing for boot to silently "fix" either way). Ran the named
> remedy command directly against the throwaway venv: it uninstalled both
> packages, reinstalled `onnxruntime-gpu==1.27.0` (`--no-deps`), and wrote a
> legitimate marker — post-repair, `owner === 'swap'` with **zero** real plain
> dist-infos (`findPlainOrtDistInfos.length === 0`), `pip check` clean. The
> silent-`'deleted'` defect #2535 was filed against is gone: the loud
> `'clobbered'` path fires exactly where wave-3 found it silent.
> **CRITICAL NOTE:** This wave-4 run was performed with the INCORRECT recipe
> version (1.27.0/1.27.0 — both the same version). This is a separate defect
> from the ordering issue wave-3 step 2 exposed (which used different versions:
> 1.29.0 plain and 1.27.0 GPU). The wave-4 run therefore did NOT fully verify
> the fix against the intended manufactured state where the two packages have
> different versions. The corrected recipe verification with 1.28.0 plain and
> 1.27.0 GPU is in Wave-5 below.
> Evidence: `docs/testing/onbox-wave4-results/step-1-a41-rerun.md`. Run by:
> claude (Castwright#2569).

> **Wave-5 A39 verification, 2026-08-21 — STILL OWED, but the filed defect is
> fixed and verified.** Re-ran this row against the CORRECTED recipe (1.28.0
> plain, 1.27.0 GPU) on a **fresh** throwaway venv to properly exercise the
> fix against the intended manufactured state. **Pre-repair:** fresh venv with
> correct versions; `detectOrtOwner === 'swap'` (GPU build's files own the
> namespace); `findPlainOrtDistInfos.length === 1` (one real plain dist-info);
> directory listing shows both `onnxruntime-1.28.0.dist-info` (real plain,
> named by version) and `onnxruntime_gpu-1.27.0.dist-info` (GPU build) with
> DIFFERENT version numbers — crucially different from wave-4's run which
> showed both at 1.27.0. **ensureOrtMarker behavior:** returns `'clobbered'`
> and logs the condition with remedy command. No marker written over the real
> distribution (directory listing unchanged, `pip check` clean). **Repair:**
> ran the named remedy command directly: uninstalled both packages, reinstalled
> `onnxruntime-gpu==1.27.0` (`--no-deps`). Post-repair: `owner === 'swap'`;
> `findPlainOrtDistInfos.length === 0` (stale real plain dist-info removed,
> only marker remains); directory listing shows `onnxruntime-1.27.0.dist-info`
> (marker written) and `onnxruntime_gpu-1.27.0.dist-info` (GPU build); `pip
> check` clean. **Disposition:** ✓ PASS for the fix. The `'clobbered'` return
> value fires exactly as intended against the correct manufactured state where
> the two packages have different versions, the remedy command repairs the box
> correctly, and the marker is written only after the swap succeeds. **Not
> independently re-confirmed:** Kokoro reporting `CUDAExecutionProvider`
> post-repair. `get_available_providers()` still lists it (as wave-3 also
> saw), but constructing a real inference session was not re-attempted here —
> the box-level CUDA 12.4 vs. CUDA 13.x/cuDNN 9.x gap (`#2534`) has been
> resolved by PR #2576 (which re-pinned `ONNXRUNTIME_GPU_CONSTRAINT` to
> `>=1.26,<1.27`). GPU-provider re-check (wave-4 step 8, same procedure as A37):
> re-ran against the fixed pin (ONNXRUNTIME 1.26.0 via PR #2576), still fails but
> on a new, distinct root cause — `onnxruntime-gpu` 1.26.0 requires
> `nvidia-cudnn-cu12~=9.0` via optional `[cudnn]` extra, never requested by
> `install-ort.mjs` (not the #2534 defect recurring). Per that outcome this row
> stays **STILL OWED** on the GPU-provider check basis — the row's own criteria
> include the CUDA-provider re-check — but the population #2192 named as
> largest-affected is no longer left in the silent failure mode.
> Evidence: `docs/testing/ort-marker-onbox-acceptance.md` §8.5. Run by: claude
> (Castwright#2578, wave-5, round-2 review correction).

### A40 · The in-app upgrade path applies the marker on a real installed release ([#2192](https://github.com/dudarenok-maker/Castwright/issues/2192), plan [282](../features/282-ort-pip-consistency-marker.md)) · **no GPU needed, sidecar venv only; not one of the design doc's six criteria**

**Not in the design doc's §On-box acceptance table.** Filed anyway: Task 8 wired
`upgrade/apply.ts`'s `pipInstall` marker handling (delete before the first
`run(...)`, write as the function's last statement, delete-then-rethrow on a
failed swap step) with a new dependency-injection seam added specifically because
the real body had zero prior test coverage
(`server/src/upgrade/apply-ort-marker.test.ts`) — but real `spawn`, a real
`venvDir`, and a real packaged release directory have never driven it. A
genuinely different consumer of the same `planOrtSwap` output than
`bootstrap-venv.mjs` (A37), so that row passing proves nothing about this one.

- Take a real installed Castwright release (not the dev checkout — the packaged
  `release/` layout `upgrade/apply.ts` targets), on NVIDIA, with a marker already
  present from a prior bootstrap or self-heal.
- Trigger the in-app upgrade (Account → Check for updates → Install, or the
  equivalent CLI path) to a release whose sidecar requirements changed enough to
  re-run `pipInstall`.
- Confirm the marker is deleted before the overlay install fires, and rewritten
  (at the freshly-installed version) only after the swap steps succeed — inspect
  `onnxruntime-<version>.dist-info`'s METADATA before/after, or watch for its
  brief absence via a log/timestamp check if the window is too fast to catch by
  hand. Confirm `pip check` is clean afterward.
- If practical, force a swap-step failure (e.g. an interrupted network mid-swap)
  and confirm the marker is deleted rather than left lying about a runtime that
  was never reinstalled.

*Needs:* a real installed release directory (not a dev worktree) and a way to
trigger its upgrade path; the existing NVIDIA dev box otherwise. *Criteria:* the
delete-first/write-last ordering invariant in
`docs/features/282-ort-pip-consistency-marker.md`, and the `pipInstall` anchors in
the design doc's §Changed files; run sheet §9 in
`docs/testing/ort-marker-onbox-acceptance.md`.

> **Wave-3 step 2, 2026-08-20 — STILL OWED, not run.** Needs a real installed
> Castwright release directory (`release/` layout).
> `docs/testing/onbox-wave3-results/step-2-ort-marker.md`.

### A41 · Russian XTTS quality — leading-dash pause by ear, Coqui degeneracy guard live, neuter -ее invariant ([#2026](https://github.com/dudarenok-maker/Castwright/issues/2026), PR #2050) · **Coqui/XTTS resident, Russian text; no clone needed**

PR #2050 fixed one of #2026's three defects (the leading dialogue em-dash) and
deliberately shipped no register row here, because concurrent PR #2039 was
actively editing this same file (annotating the E-04 row above). #2039 merged
2026-08-01; this row is that deferred debt, tracked on
[#2057](https://github.com/dudarenok-maker/Castwright/issues/2057).

The complete criteria already exist in
`docs/testing/fs38-wave3-onbox-acceptance.md`'s `#2026 — additional acceptance
criteria: Russian XTTS quality` section and are **not** restated here —
summarised below.

- **Leading em-dash pause, by ear.** `softenDashes`
  (`server/src/tts/text-normalize.ts`) rewrites a leading `—` to `... ` on the
  theory a leading ellipsis pauses where a leading comma didn't. Pinned only
  as a wire-text transform (`text-normalize.test.ts`); never confirmed on real
  audio. Compare a line opening with `—` against the same line with no
  leading punctuation, and against an interior-dash sentence — the original
  issue's own reference points: **+0.14 s** for the leading dash (i.e. no
  audible pause) versus **+1.53 s** for an interior one.
- **`tts.coqui.degenGuard` live** (`_coqui_synth_is_degenerate`,
  `server/tts-sidecar/main.py`; registry key `server/src/config/registry.ts:736`).
  Pinned only by a scripted-fake pytest, never run against the real XTTS
  model. Observe (a) it does **not** false-positive on ordinary 2–3 word
  Russian lines at normal speaking pace — its 20 ms/speakable-char floor was
  reused verbatim from Qwen's own calibration and never independently
  measured for Coqui's actual healthy short-utterance duration; (b) if a live
  repro of the original collapse can be captured, whether the retry actually
  recovers it. **A negative on (b) may be correct behaviour, not a
  failure** — the guard's own docstring is explicit that it can only catch an
  implausibly SHORT render, and both historical collapses (`Хорошее олово.` →
  Finnish, `Тёплое море.` → English) were fluent, plausible-duration
  utterances outside its detection envelope.
- **Neuter `-ее` standing invariant.** No local fix was attempted — the
  mispronunciation is baked into the trained XTTS v2 checkpoint's own Russian
  G2P, not a text-preprocessing bug. Confirm it **still reproduces** on
  `main`, so a future `coqui-tts` upgrade has a baseline to check against.
  Not a sign-off. Pairs with #2056.

**Different mechanism from A35 (#2055) — do not merge with item 2 above.** A35
covers the server-side ASR/WER override `qa.asr.catastrophicWer` in
`classifyTranscript`; this row's item 2 is the sidecar-side duration heuristic
`tts.coqui.degenGuard`. Same symptom (a Russian line collapsing into another
language), different guard, different layer of the stack. These were
conflated once already during triage.

*Needs:* a Coqui-capable sidecar with XTTS resident, a Russian book or line
(no clone needed — every #2026 defect reproduces on the stock catalogue voice
`Damien Black`). *Criteria:* `docs/testing/fs38-wave3-onbox-acceptance.md`'s
`#2026 — additional acceptance criteria: Russian XTTS quality` section.
*Cost:* short — a handful of `/synthesize` probes plus one attempt at
reproducing the degenerate collapse.

### A42 · Named-entity decode reaches the TTS engine on a real EPUB ([#2310](https://github.com/dudarenok-maker/Castwright/issues/2310), plan [`docs/superpowers/plans/2026-08-13-entity-decode-layer.md`](../superpowers/plans/2026-08-13-entity-decode-layer.md)) · **single 8 GB card**

PR shipped `decodeNamedEntities` (`server/src/parsers/html-utils.ts`), widening
`stripHtml`/`extractFirstHeading`/`epub.ts`'s `decodeEntities` from a
five-entity hand-rolled list to the complete HTML5 named set. Every layer of
the fix is proved by unit and end-to-end tests fixing the sentence text
explicitly (`html-utils.test.ts`, `entity-dialogue-e2e.test.ts`) — what those
tests cannot prove is that a real, EPUB-sourced entity survives the whole
pipeline the same way. Design spec's own "What I could not establish": whether
the stage-2 analyzer model echoes a surviving entity into its returned
sentence text, which decides whether the *body-line* symptom reproduced at all
before this fix (a second thread observed, on a live run, that the current
model sometimes strips a leading dash rather than echoing it verbatim — that
would mean the body-path symptom already didn't reproduce pre-fix on today's
model, which is a finding about the analyzer, not a failure of this fix).

- **Lead with the chapter-title beat — the only criterion no model behaviour
  can mask** (design spec Finding 0). On an EPUB whose first chapter heading
  carries named entities (e.g. `<h1>L&rsquo;&Eacute;t&eacute;</h1>`), confirm
  the spoken title beat says "L'Été" cleanly — no "ampersand … semicolon", no
  gibberish.
- **Secondary: a Spanish, French, or Russian EPUB using `&mdash;`/`&ndash;` or
  accented named entities in body text.** Confirm a dash-opened dialogue line
  renders with a pause (not spoken "ampersand n dash semicolon" or similar),
  accented words render as the correct letters (not "e acute" spoken aloud),
  and the manuscript view shows real glyphs rather than raw entity text.
  **Record whether this symptom reproduced at all pre-fix** — per the design
  spec, that is itself new information about the analyzer chain, not a gate on
  this fix.
- No real es/fr/ru EPUB with named (as opposed to numeric) HTML entities was
  available in this workspace at design time — confirm one exists among the
  on-box corpus, or construct a minimal one from a real chapter with `&mdash;`
  hand-substituted for a literal dash, if none does.

*Needs:* a real EPUB (or a hand-modified one) carrying named HTML entities in
its heading and/or body, a working analyzer + TTS pipeline. *Criteria:* the
two bullets above. *Cost:* short — one import + one chapter-title listen, plus
one body-line listen if a suitable entity-laden EPUB is available.

### A43 · Respawn budget deadline and exhaustion under sustained refusal ([#2106](https://github.com/dudarenok-maker/Castwright/issues/2106), PR #2398) · **single 8 GB card, live sidecar**

When the sidecar exits and respawning runs into a refused spawn (a foreign process occupying `:9000`), the supervisor's crash-loop cap must still accrete monotonically toward exhaustion, and the deadline timer must actually kill a hung listener-enumeration probe. Unit tests (`server/src/tts/sidecar-supervisor.test.ts`, `server/src/tts/spawn-sidecar.test.ts`) fully verify the refusal→cap accounting logic: a slow attempt (one that outlives `QUICK_DEATH_MS`) no longer masquerades as a long-lived child and resets the counter — instead the budget accrues regardless of attempt latency, and a cap on `consecutiveFailures` prevents infinite refusal loops. What no unit test can reach is the *real* race on a contended box: whether `LISTENER_PID_DEADLINE_MS = 5000` milliseconds is actually enough headroom for the listener-enumeration probe (`lsof` on POSIX, Windows PowerShell `Get-NetTCPConnection` query) to complete before the deadline fires on real hardware under contention, and whether the deadline timer truly kills a hung probe so the supervisor can proceed to the next backoff instead of blocking forever. Two scenarios test these separately: a foreign listener for the budget-exhaustion half (exercises the not-ours refusal path), and a manually-started sidecar under prod policy for the deadline-timer half (exercises the stale-replace path where the deadline callback is active).

**Scenario 1: Supervisor crash-loop cap (foreign listener, not-ours refusal path)**

- With a chapter actively rendering, kill the sidecar's OS process directly (e.g. `taskkill /PID <pid> /T /F` against the pid in `.run/tts.pid`, or end the process from Task Manager) — **not** via `POST /api/sidecar/restart`, for the same reason as A32.
- Immediately after kill, start a foreign listener on `:9000` that does NOT respond like a valid sidecar (e.g. `nc -l 9000` on POSIX, which accepts TCP but doesn't answer HTTP; or an HTTP server that returns a non-200 status or malformed body). This ensures the spawn attempt fails the identity check and enters the not-ours refusal path (`spawn-sidecar.ts:681`).
- Grep the running server's own log for the supervisor counter monotonically advancing across multiple refused attempts. Expected log format: `[sidecar] supervisor: spawn refused: <reason>; respawning in <delayMs>ms (attempt <K>/<max>).` Confirm the attempt counter increases (1, 2, 3, 4, 5) and that no single slow probe resets it back to 1.
- Confirm the respawned sidecar eventually surfaces as `'crashed'` on `GET /api/setup/models-status` once the counter exhausts. Expect the exhaustion log: `[sidecar] supervisor: <N> rapid spawn refusals (<reason>) in a row — giving up respawn. TTS is DOWN; restart the server to recover.` (Backoff schedule: `DEFAULT_BACKOFFS_MS = [2s, 5s, 15s]` with last repeating, cap `DEFAULT_MAX_CONSECUTIVE_FAILURES = 5`, total ≈52s across 5 attempts per `server/src/tts/sidecar-supervisor.ts:45-46`.)
- **Recovery from exhaustion:** Once exhausted, `scheduleRespawnAttempt` returns without scheduling a respawn (see `server/src/tts/sidecar-supervisor.ts:265-271`). Recovery paths differ:
  - *Before exhaustion:* If the foreign listener is stopped BEFORE the counter reaches 5, the next scheduled backoff delay will elapse and the next spawn attempt will succeed (listener is now gone). Confirm the sidecar starts and surfaces as ready within the backoff window for the current attempt count.
  - *After exhaustion:* If the foreign listener is stopped AFTER the counter exhausts and the `giving up respawn` log appears, stopping the listener alone does **not** trigger a respawn — the counter is locked at 5+ and `scheduleRespawnAttempt` returns immediately. Recovery requires one of: (1) `POST /api/sidecar/restart` via the UI or API (resets `consecutiveFailures` to 0 and calls `spawnOnce()`), or (2) a server restart, which resets all state. Test recovery by calling `POST /api/sidecar/restart` after stopping the listener and confirm the sidecar respawns and surfaces as ready.

**Scenario 2: Deadline timer for hung PID probe (manually-started sidecar, stale-replace path)**

- In a fresh or parallel session (or after restarting the server), start a fresh sidecar manually — e.g. `cd server/tts-sidecar && python main.py` in a separate terminal — so the server process does not own its PID. Before running the server, set the environment variable `SIDECAR_NEVER_ADOPT=1` (in PowerShell: `$env:SIDECAR_NEVER_ADOPT = '1'`) to trigger the prod-policy path (`spawn-sidecar.ts:685-686`).
- With a chapter actively rendering on the server with `SIDECAR_NEVER_ADOPT=1`, the health probe will detect the already-listening sidecar. Because prod policy is active and the sidecar is healthy (fresh protocol version, no leak), the server will treat it as unfit to adopt and attempt to replace it via the stale-replace path (`spawn-sidecar.ts:694`).
- Grep the server log for the UNFIT message. Expected log: `[sidecar] UNFIT sidecar on :9000 (prod policy: spawning a fresh owned sidecar instead of adopting a pre-existing one) — replacing it with a fresh process to avoid inheriting…` On a responsive box, verify the PID lookup completes well under the 5000ms deadline. The log should show the new sidecar spawning without a deadline-timeout message.
- If the deadline does fire (rare, indicates system contention or slow enumeration), confirm it appears in logs as: `[sidecar] probe for the PID on :9000 timed out — the supervisor will retry on backoff. Monitor logs if this persists.` Verify that the supervisor does NOT hang indefinitely; instead it proceeds to the next backoff attempt.
- Confirm the newly-spawned sidecar becomes owned (PID recorded in `.run/tts.pid`) and surfaces as ready on `GET /api/setup/models-status`.
- Cleanup: the manually-started sidecar was already killed by the server as part of the replace above, so its terminal should show it exited on its own — there is nothing left to stop. Restore `SIDECAR_NEVER_ADOPT` to its prior state (unset, or `'0'`) and restart the server, so the next run adopts a healthy pre-existing sidecar normally instead of replacing it.

*Needs:* a live sidecar, a book mid-render, OS-level process-kill access, ability to bind a foreign listener on `:9000`, ability to start a fresh sidecar manually, and ability to set environment variables on the server. *Criteria:* the bullets above; the code-level contracts are `scheduleRespawnAttempt` in `server/src/tts/sidecar-supervisor.ts` (budget exhaustion) and the deadline timer in `server/src/tts/spawn-sidecar.ts` at line 694 (`findListenerPid`'s `deadlineMs` parameter). *Cost:* ~2 minutes — Scenario 1 takes ~1 minute (one sidecar kill, one foreign listener binding, supervisor observation); Scenario 2 takes ~1 minute (one manual sidecar start, one SIDECAR_NEVER_ADOPT run, deadline observation). Can run sequentially or in separate sessions.
### A44 · Reassigning a character's voice no longer scores it against the old speaker's persisted audition centroid ([#1969](https://github.com/dudarenok-maker/Castwright/issues/1969), PR #2402) · **single 8 GB GPU + qwen or coqui resident + a cloneable voice**

PR #2402 fixes the #1969 `voice-mismatch` false-positive: the render-integrity
gate now rebuilds a character's persisted audition centroid reference when its
voice is reassigned, so correct new-voice lines are no longer flagged
`voice-mismatch`/`severity: severe` against the old speaker's stale reference
(`resolveCharacterReference` no longer returns a persisted `audition` row
unconditionally, and the `CharacterCentroid` in `centroids-io.ts` now records
the voice it was built from). Only mock/unit coverage exists — what those
cannot prove is that the rebuilt reference, not the failed flag, is what a real
render produces. Confirm on the box: assign a character to one voice and render
it once so `render-integrity.centroids.json` persists an `audition` row (a
character thin enough on in-book anchors to take the audition-reference path);
reassign it to a clearly different (cloned) voice; re-render. The new voice's
lines must **not** be flagged `voice-mismatch`/severe — the persisted centroid
must be **rebuilt for the new voice**, not reused against the old speaker's.

*Needs:* a single 8 GB GPU with Qwen or Coqui resident, plus a cloneable voice.
*Criteria:* the two bullets above. *Cost:* short — one render, one
reassignment, one re-render. Records A23's final sub-check ("no
`voice-mismatch` rows").

### A45 · The `speaker-qa.txt` reqHash fix actually drives a one-time `pip-in-place` reinstall on a real venv ([#2586](https://github.com/dudarenok-maker/Castwright/issues/2586), PR #2588) · **no GPU needed, sidecar venv only**

PR #2588 hashes `speaker-qa.txt` into `reqHash` (`resolveRequired` in
`venv-migration.mjs`, AND — after pass-3/pass-4 review caught the first landing
missing it — `zip-validate.ts`'s separate `validateUpgradeZip` producer, which
the in-app zip-upload upgrade route and `apply.ts`'s `pipInstall` gate both
read). The decision logic (`decideVenvAction`/`classifyVenvState`) is
exhaustively unit-tested against synthetic stamps, and the two hash producers
are now pinned equal against each other by a test that builds matching
requirements content on disk and in a real zip (`zip-validate.test.ts`). What
none of that proves is that a REAL venv with a stamp recorded under the old
2-file hash actually gets `pip-in-place`'d — not `noop`, not a full rebuild —
and that the resulting environment carries `speaker-qa.txt`'s current pins
(`speechbrain==1.1.0`, `huggingface_hub==0.36.2` as of this PR) afterward.

Two real reinstall paths write two different files, so the criteria below are
per-path — don't conflate them. `.req-hash` (`upgrade/apply.ts:298-308`) is
written **only** by the in-app zip-upload path; `.venv-stamp.json` is written
**only** by `bootstrap-venv.mjs`'s own path (Pinokio's Update action). Neither
run writes the other file, so "both files now record the new hash" is not a
real, checkable outcome — pick one path and check the one file it owns.

The zip-upload path also needs a real pre-existing `.req-hash` to compare
against, not a fresh one: `apply.ts:134`'s gate is
`ctx.reqHash && ctx.reqHash !== steps.readReqHash()`, so on a venv with **no**
prior `.req-hash` file at all, any non-null `ctx.reqHash` triggers
`pip-in-place` regardless of whether `speaker-qa.txt` is in the hash — that
run would pass a naive "did pip-in-place happen" check even with this PR
fully reverted, and prove nothing about the fix. Seed a real OLD 2-file hash
first (below) so the run being tested is a genuine hash-mismatch, not a
first-ever-write.

**Path A — Pinokio Update (`.venv-stamp.json`):**
- Take a real sidecar venv whose `.venv-stamp.json` predates this PR (`reqHash`
  computed from `[overlay, base]` only — any pre-#2588 install qualifies).
- Run Pinokio's Update action (`pinokio-scripts/update.js`, which runs
  `bootstrap-venv.mjs`).
- Confirm the run performs a `pip-in-place` install (not a full rebuild, not a
  `noop`) — `python-tag`/`profile` are unchanged, so `decideVenvAction` should
  classify strictly on the `reqHash` mismatch.
- Confirm `speaker-qa.txt`'s pins (`speechbrain`, `huggingface_hub`) are
  present at their pinned versions afterward, and that `.venv-stamp.json` now
  records the new 3-file hash so a second Update run is a `noop`.

**Path B — in-app zip-upload upgrade (`.req-hash`):**
- Run the zip-upload upgrade once against a build that predates this PR (or
  hand-write a `.req-hash` file containing the old `[overlay, base]` hash) so
  a real prior value exists to mismatch against.
- Run the zip-upload upgrade again (Account → Application updates → stage a
  release zip → Apply, driving `upgrade/apply.ts`) against a build carrying
  this PR's `speaker-qa.txt`-inclusive hash.
- Confirm this second run performs a `pip-in-place` install specifically
  because of the `reqHash` mismatch (not merely because `.req-hash` was
  absent — that's the false-positive path above) and that `speaker-qa.txt`'s
  pins land in the venv afterward.
- Confirm `.req-hash` now records the new 3-file hash so a third run is a
  `noop`.

*Needs:* sidecar venv only, no GPU. *Criteria:* Path A's four bullets OR
Path B's four bullets — one path is sufficient, they exercise the same
`decideVenvAction`/`classifyVenvState` logic through different producers.
*Cost:* one pip-in-place reinstall, once, on an old-stamped venv.

## Group B — local Ollama analyzer only

A real Ollama daemon and a long (~110k-char) chapter. No TTS engine resident. B1 has a **CPU-only sub-case** — the only check here that wants the analyzer *off* the GPU (the analogous B2-step-7 CPU-only case retired to "Blocked — hardware not available" this wave). Consider folding in E4. B2 rides the characterId-drift re-analysis's own real book fixture instead of the generic chapter and has no CPU-only case.

### B1 · Analysing view honesty for local analyzers (plan 216)

Six steps (`:124-142`). A per-phase Gemini recitation-block falls back to local Qwen
with chip, swap, ticker and log all agreeing · a ~110k-char chapter's ETA reads
realistic minutes and **tightens within ~10s** of streaming, not at chapter-end · a
dense single-paragraph chapter that used to hard-fail with "truncated the response
(length)" now completes · **CPU-only:** the first-chapter ETA seeds slow (~15 chars/s)
rather than assuming GPU speed · `LiveChapterTicker` renders every in-flight chapter
at K=4 with a monotonic per-phase bar.

> **Wave-3 step 5, 2026-08-20 — STILL OWED, not run.** Blocked on two
> verified preconditions this worktree does not have: no `GEMINI_API_KEY`
> (step 1 needs a genuine Gemini recitation-block → Qwen fallback; the
> worktree's own `.env` deliberately carries no secrets) and no ready-made
> ~110k-char / dense-single-paragraph fixture (steps 2-4's fixtures are both
> far short — 15.6k/6.2k chars — and the isolated workspace is empty).
> Nothing attempted beyond confirming these blockers. Re-resolution note:
> step 5 (`LiveChapterTicker` at K=4) is itself browser/visual-shaped, worth
> flagging back as a partial exception to this row's blanket
> "agent-runnable" framing. `docs/testing/onbox-wave3-results/step-5-group-b.md`.
>
> **Correction, 2026-08-21 — both stated blockers above are wrong; the real
> blocker is narrower.** The repo owner confirms: (1) "no `GEMINI_API_KEY`"
> was a **worktree-isolation artifact, not a missing precondition** —
> worktrees deliberately carry no secrets by design, and the key exists in
> the primary checkout where this row should actually run; (2) "no
> ready-made ~110k-char/dense-single-paragraph fixture" is false and
> backwards — ***Ночной дозор*** (Night Watch) carries a paragraph of exactly
> that size and is in fact **the book the original issue came from**. This
> row's real remaining blocker: **step 5 (`LiveChapterTicker` at K=4) is
> browser-shaped**, not agent-runnable, and belongs with the operator packs —
> added to `docs/testing/onbox-sitting-device-browser.md`'s row list (see
> that pack's own minute-total correction). **Also:** this row's criteria
> predate recent paragraph-separation/turn-taking-attribution fixes (most
> recently PR #2518, "stop the tag-clause guard eating a colon-introduced
> turn", merged 2026-08-20, design in #2426/#2334) and **must be re-derived
> against current `main` before this row is run** — a run against the
> criteria as currently written would not be trustworthy. Re-derivation is
> itself owed, not attempted here.

### B2 · Stage-1 returns cast names in the manuscript's own script ([#2313](https://github.com/dudarenok-maker/Castwright/issues/2313), PR #2317)

`buildStage1ChapterInbox` never bound `name`/`aliases` to the book's script. `languagePreamble` already bound `tone`/`role`/`description`/`attributes` for a non-English book and still does — names were the one identifying field left free, and they drifted: *Ночной дозор*'s cast lists handed to stage-2 went from **0 of 75 Latin-named** (2026-08-06) to **42 of 71, 59%** (2026-08-13) across two runs of the same book with the same model weights and the same prompt; chapter 2 came back 15/15 Latin. A controlled 5× replay of the recorded stage-1 prompt reproduced 100% Latin 5/5 against the recorded response's 0/3.

The fix is a prompt instruction, so **the three unit tests prove the rule renders — not that the model obeys it.** That gap is the whole reason this row exists: the defect was non-deterministic model behaviour, and only a real analyzer on a real non-English book can show the roster comes back in Cyrillic.

**Fold this into the characterId-drift re-analysis** (run sheet [`cast-id-drift-onbox-acceptance.md`](cast-id-drift-onbox-acceptance.md) §7; that row's evidence retired from this register per the owner's discharged-row ruling) — it re-analyses *Заказ Коалфолла* (ru), which is exactly the fixture this needs, so both checks discharge from one re-analysis. Observe, on that same run:

- Every character's `name` in the resulting `cast.json` is in **Cyrillic**, matching how the book's prose spells it — zero Latin transliterations (`Мэйрин`, not `Mairin`). The pre-fix failure looks like a roster that is *readable* but Latin.
- Every `id` is still **ASCII kebab-case** — the carve-out. A roster that came back with a Cyrillic *id* (`борис-игнатьевич`, observed on the 2026-08-06 run) is a failure of this row even if every name is correct, because ids are the join key.
- **No character gained a second id.** The characterId-drift re-analysis already checks `mairin` / `coalfall-dragon` survive; this row adds that the roster has no *near-duplicate pair* (e.g. both `mairin` and `mayrin`, or a name-corrected character appearing twice). That is the split-identity risk the carve-back clause exists to prevent, and it is the one way this change could make things worse rather than better.
- Note the roster size against the recorded 13-character baseline — a drop would mean the added block cost recall.

If the run instead happens on a book whose language was never declared (imported before fs-2, or left undecided at the confirm screen), that is a **more** valuable observation, not a less valuable one: those books get an empty `languagePreamble`, so this block is their only protection.

*Needs:* a real analyzer (local Ollama or Gemini) and a real non-English book — no TTS/GPU rendering. *Criteria:* this row. *Cost:* none beyond the characterId-drift re-analysis, if run together.

> **Wave-3 step 5, 2026-08-20 — STILL OWED, same run as the characterId-drift
> re-analysis.** Rode that re-analysis of *Заказ Коалфолла* per this row's own
> instruction. All Cyrillic names (zero Latin transliterations) and
> all-ASCII-kebab-case ids **passed**. **"No character gained a second id"
> FAILED** — exactly the near-duplicate pair (`brann-wire`/`berrin-wire`
> duplicating `brann-weir`/`berrin-weir`) this row's own text names as the
> worst-case outcome; full evidence and root cause:
> `docs/testing/onbox-wave3-results/step-5-group-b.md`. Roster size moved
> 13→16, not "still 13" as the row anticipated as the default case. Same
> defect as the characterId-drift row, filed as
> [#2536](https://github.com/dudarenok-maker/Castwright/issues/2536)
> (see #2536).

> **Wave-4 step 7, 2026-08-21 — STILL OWED, new defect (not #2536), after
> #2536's fix merged.** Re-ran the same fixture (Castwright#2570) against code
> including PR #2562. Cyrillic-names and no-second-id criteria **passed**
> (the near-duplicate pair was itself cleaned up this run, via the
> characterId-drift re-analysis's own discharge — see
> `docs/testing/onbox-wave4-results/step-7-b3-b4-rerun.md`).
> **"Every id is ASCII kebab-case" FAILED again, for a different reason**: the
> established id `oduvan` was retired IN FAVOUR OF a freshly-minted Cyrillic
> id `одуван` (`cast-id-history.json`: `"oduvan": "одуван"` — backwards from
> the direction three other retirements took in the same run). Not a
> surname-drift case, not a `safeId`/transliteration bug (Cyrillic ids are
> correct-by-design for genuinely new characters, plan 219) — the defect is
> the retirement direction choice for an already-matched character. Filed as
> [#2584](https://github.com/dudarenok-maker/Castwright/issues/2584). Full
> evidence: `docs/testing/onbox-wave4-results/step-7-b3-b4-rerun.md`. **Row
> stays owed.**

---

## Group C — one *Ночной дозор* re-analysis session

**Four rows.** The **local pass ran 2026-08-06** by Claude Code on the dual-GPU
box — 9 chapters, **15,069 sentences**, `qwen36-cw-iq4-32k` via local Ollama,
structure engine on, `analyzer.structure.escalation = 'local'`, no mock mode —
and discharged **C1** (plan 261, scene separators) and **C2** (plan 247, srv-59
attribution). Results are recorded in each plan's acceptance section, and the
headline finding is filed as
[#2187](https://github.com/dudarenok-maker/Castwright/issues/2187).

In short: **C1 passed** (24 separators, 22 flagged, median separator→opener
distance 5 chars — the `* * *` glyph itself; the ~92k forward-overshoot is
mechanically gone). **C2's targets were missed** (flagged 6,568 vs ≤~500) because
chapters 5–8 fell below the hardcoded 80% alignment floor and degraded to
flag-only; chapter 9, which aligned at 95%, ran the full engine and landed
flagged=**488, under target**. The aligner — not the engine — is the bottleneck.

Since then the #2187 aligner fix landed, adding a **new C2** — one more local
re-analysis to confirm plan 247's targets end to end — and #2253's convention
invariant added a third row. **Both ran 2026-08-12/13 and are discharged**; see
below. (Row IDs are positional and renumber on discharge, so a given ID has
named several different rows over this group's life. The C2 discharged in the
paragraph above was the srv-59 attribution row; the C2 discharged in the
paragraph below is the post-#2187 one; the C2 that remains is what was C3.)

**The 2026-08-12/13 run — 9/9 chapters, and it discharged two rows at once.**
Throwaway `mns_rKjCHx0vrS`, build `52a8fb97`, local Ollama `qwen36-cw-iq4-32k`,
structure engine on, `allowCloudFallback: false`, **12 h 27 m** of compute across
an overnight pause. Full per-chapter figures and the seven run-sheet gaps it
exposed are in
[`night-watch-reanalysis-onbox-acceptance.md`](night-watch-reanalysis-onbox-acceptance.md)
§4. Headline outcomes:

- **Escalation executes on all nine chapters** — the post-#2187 C2's principal
  owed item, and the thing offline replay explicitly could not prove. 61 windows
  attempted, 21 lines applied. **Discharged.**
- **Wall-clock missed target 5 by ~2.5–6×** — 12 h 27 m against +2–5 h. Cause
  identified, so this is a recorded outcome rather than a re-run: the 16 GB model
  does not fit the 5070 Ti's 14.2 GiB usable, and ~5 GB spilled over PCIe for the
  whole run. Re-testing needs different hardware or a smaller quantisation.
- **The bucket split is live** — `unresolved` populated on every chapter (670
  book-wide), `flagged` 0 throughout, i.e. under its bar rather than over it.
- **But the end-to-end outcome criterion FAILED**: 87.4% of dash-opening dialogue
  was attributed to `narrator` (4131/4725) against a 30.3% baseline. The
  dialogue-structure engine is **exonerated** by replay — today's engine over the
  2026-08-06 cached stage-2 output reproduces 30.4% — so the cause is upstream,
  filed as [#2306](https://github.com/dudarenok-maker/Castwright/issues/2306).
  That is why the row below survives with narrowed scope instead of discharging.

The cloud row remains (renumbered **C1** now that the other two are discharged;
it was C3 before 2026-08-06 and is referenced under that ID in
[#1685](https://github.com/dudarenok-maker/Castwright/issues/1685)). It needs the
separate **cloud** pass, which the local run did not exercise. No TTS or GPU
synthesis.

Book: `C:\AudiobookWorkspace\books\Сергей Лукьяненко\The Night Watch Tetralogy\Ночной дозор`.

> **Hold the full 12-hour re-run — the in-flight speaker-separation work**
> ([#2288](https://github.com/dudarenok-maker/Castwright/issues/2288),
> [#2279](https://github.com/dudarenok-maker/Castwright/issues/2279)) **changes dialogue
> segmentation**, so a pass taken before it lands measures a moving target and has to
> be repeated. Wait for it, then take C2 and C3 in one session.
>
> **#2306's cause is still NOT identified (2026-08-13).** A strong candidate was
> raised and then refuted by measurement, and both halves are recorded here so it
> is not raised a third time.
>
> The candidate: this run was driven over the API and its confirm payload carries
> no `language` field (`book-req3.json`, on disk), so the book persisted as
> `state.language = "en"` while `POST /import` had detected `ru` seconds earlier.
> Marked `en` a book gets no `languagePreamble`, and
> `conventionsFor('en').dialogueOpen` is `null`, which makes the #2253 convention
> invariant inert. The correlation is real and verified — the 2026-08-06 book that
> attributed well is `ru`; the 2026-08-12 book that collapsed is `en`, same
> manuscript and same engine.
>
> **The mechanism does not survive testing.** Replaying the captured ch3 chunk-1
> prompt varying ONLY `StageCall.language` gives 0.0% narrated on both `ru` and
> `en`; pushing the captured raw model output through `crossExamine` with
> `dialogueOpen: undefined` (the `en` configuration) gives 5.6%, against a
> recorded 94.8%. Neither path reproduces the collapse. Every `en` book was
> created by the same harness in the same sessions as the collapsed runs, so
> `state.language` may be a marker of provenance rather than the operative
> difference.
>
> The language default is fixed anyway (#2335) — stamping a Russian book English
> is wrong on its own terms — but it is **not** recorded here as #2306's cause.
>
> The earlier roster-reconcile hypothesis is also withdrawn: the run's own logs
> record zero demotions on that path, and controlled replays of the real chunker
> attribute the collapsed chapter at 0.5%. It remains a latent hazard that did
> not fire here.
>
> **Preserve `server/handoff/outbox/*-stage2-ch*.json` before tearing down a run's
> checkout** — #2324 now numbers each call's forensics, so a chunked chapter no
> longer overwrites its own prompts and responses as it runs (which is why only
> last chunks survived this one).

### C1 · Free-tier Gemma cloud pass completes end to end ([#1685](https://github.com/dudarenok-maker/Castwright/issues/1685))

**Narrowed 2026-08-13 from three items to one** — see
[#1685](https://github.com/dudarenok-maker/Castwright/issues/1685#issuecomment-5274602285)
for the full reasoning. Two items came out:

- **429 classification — already covered offline.** `gemini.test.ts` carries four
  tests over this exact behaviour against the real payload shapes, including both
  historical misclassifications: the #1682 case (`free_tier` in the metric name
  matching the daily marker, `:551`) and the #1695 case (the free tier's 15-req/min
  cap colliding with a `\d{1,3}` heuristic, `:583`). The latter asserts the call
  happened **twice** — it proves the retry, not merely the absence of a throw. A
  live run would only detect fixture drift in those payloads, which is a far weaker
  claim than the item made.
- **`localInputFraction` calibration — obsolete.** The shipped `0.3` produced
  **one** stage-2 truncation across nine chapters of the hardest book available;
  truncation already *recovers* via the adaptive re-split (`stage2-chunk.ts`, #528)
  rather than dropping, so the knob is prevention for a cured failure; and lowering
  it means smaller chunks, more calls, longer wall-clock — pushing the wrong way on
  the one target that just missed by 2.5–6×. The value is per-model and
  per-`num_ctx` besides, so it would not survive the next model.

**What remains** is the systems property no unit test reaches: re-analyze end to end
on `gemma-4-31b-it` — **including the script-review pass**, the one that actually
429'd in the original incident (all 22 logged failures were `task: script-review`) —
and confirm the book **completes** with no dropped chapters and no hang under real
throttling, with the limiter, the retries and the fallback interacting over hours.
Uses the free-tier `GEMINI_API_KEY` **already configured** in `server/.env` — a
credential this run exercises, not a blocker.

**Its remaining draw is that it doubles as the cloud arm of
[#2306](https://github.com/dudarenok-maker/Castwright/issues/2306)'s control** — and
with #2306's cause still open and the **stage-2 output** now the leading suspect,
that A/B is the sharpest test available rather than a spare one. Two candidates have
been eliminated offline (`isConventionRescue`'s roster gate moves 0.1 points;
`reconcileSentenceCharacterIds`'s demotion is potent at 38.0% → 76.3% but logged
**zero** demotions in the actual run), which is what promoted the A/B back up.

**Two things the 2026-08-06 local pass established for this row, before anyone
sets it up again:**

- **`gemini-*` really does RECITATION-block this book — observed, not inherited.**
  Mid-run, a queued Ollama call timed out into the cloud fallback and
  `gemini-3.5-flash-lite` returned `PROHIBITED_CONTENT` on a stage-2 chapter-1
  section. That is exactly why this row specifies `gemma-4-31b-it`.
- **`server/.env` sets `GEMINI_MODEL=gemini-3.5-flash-lite`, which overrides the
  RECITATION-safe code default.** The last-resort fallback in `analyzer/index.ts`
  and `routes/analysis.ts` is already `gemma-4-31b-it`, so it is the `.env` line —
  not the code — that must change for this row, or the pass silently runs on the
  wrong model and dies on the filter.

**Run it against a throwaway re-import, not the library book.** The analysis cache
is keyed by `manuscriptId` only (`server/src/store/analysis-cache.ts` header), so
re-analyzing the existing entry would overwrite the qwen36 sentences, `cast.json`
and `state.json` that the 2026-08-06 pass produced and that the owner is keeping
for cast + generation.

> **Wave-3 step 6, 2026-08-20 — STILL OWED, not run.** Blocked on a
> genuinely missing credential: this worktree's `server/.env` has no
> `GEMINI_API_KEY` and no other channel (shell env, secrets store) supplied
> one. The primary checkout's `server/.env` was deliberately **not** read,
> opened, or copied at any point (a named secret-leak shape, #2345) — the
> honest outcome when no channel supplies the key is to record this row as
> still owed, not to route around the isolation. Nothing in the row's
> remaining scope was narrowed or dropped.
> `docs/testing/onbox-wave3-results/step-6-group-c.md`.
>
> **Correction, 2026-08-21.** The wave-3 note above is wrong to call this row
> "blocked on a missing `GEMINI_API_KEY`" — the row's own text a few
> paragraphs above already says the key is "already configured in
> `server/.env` — a credential this run exercises, not a blocker." The
> wave-3 agent ran inside an isolated worktree whose `.env` deliberately
> carries no secrets and mistook its own local absence for a property of the
> row (the same class of error B1's 2026-08-21 correction names). C1 is
> STILL OWED because the multi-hour cloud re-analysis has not been run — not
> because of a missing credential; the credential exists and the row is
> runnable at any time in an environment that has it (i.e. not an isolated
> worktree). The 2026-08-20 blocker note was a worktree-isolation artifact,
> not a property of the row. The #2345 caution above about not copying
> `server/.env` into worktrees stays correct — only the "therefore blocked"
> conclusion was wrong. **Cross-check against the recent paragraph-
> separation/turn-attribution fixes (PR #2518 etc., flagged for B1):**
> whether these change what C1's cloud re-analysis measures, given C1 is
> described as "partly the cloud arm of #2306's control," could not be
> determined from this row's own criteria text alone — flagged here as
> itself unresolved, for a human to check, rather than guessed at.

### C2 · Dialogue-convention invariant end to end ([#2253](https://github.com/dudarenok-maker/Castwright/issues/2253))

**Partially discharged 2026-08-13** — see the run summary above. Two of this
row's four criteria passed on the live run and do **not** need re-running:
`unresolved` is populated per chapter, and `flagged` sits under its bar, so the
bucket split reaches a real stage-2 output. Escalation's behaviour under the
split was also observed. What follows is the narrowed remainder.

**What is already proven, and does NOT need re-running:** the fix itself, at
corpus scale. Two offline replays over the 2026-08-06 cache
(`server/handoff/cache/replay-experiment.mts`, gitignored, throwaway) measured
`HARM TOTAL victims=41` — down from the pre-fix baseline's 879, not to 0,
because the rescue guard now also requires roster membership and 41 lines
(`борис-игнатьевич` ×17, `егор` ×24) carry off-roster ids that
`reconcileSentenceCharacterIds` demotes to `narrator` downstream regardless,
so they were never actually recoverable — at both the production 80%
alignment floor and forced to 100%, and all 17 workspace-book
structure hashes unchanged (parser untouched, confirmed by construction and by
diff). Unit and regression coverage for the invariant, the bucket split and
every `EngineReport` consumer ships in the same PR.

**What is still owed:** this PR ships engine behaviour proven only by replay
over one book's *cached* analysis. What replay cannot prove is that a real
end-to-end analysis run produces the same buckets, and that `escalated`/
`escalationAccepted` behave with the new bucket split. Re-run Ночной дозор
analysis and confirm: `[analysis:structure]` log lines show `unresolved=`
populated and `flagged=` at conflict scale (order 10²/chapter, not 10³); ch5's
dash-opening sentences are no longer rewritten to `narrator`; `state.json`'s
`analysisProvenance.report` carries a populated `unresolved`. Full criteria:
`docs/testing/night-watch-reanalysis-onbox-acceptance.md` §2A.5, and plan 247's
re-specified target 1.

**Residual risk not covered by this row:** the invariant activates for
Russian, Spanish and French (`lang/es.ts`, `lang/fr.ts` both carry a non-null
`dialogueOpen`), but Ночной дозор is Russian-only. Spanish and French ship on
unit coverage plus the identical-convention argument, not corpus measurement —
no Spanish or French book exists in the workspace to measure against. This row
does not change that; it is not blocked on acquiring one.

Same setup as C2: local Ollama, `qwen36-cw-iq4-32k`, ~14 GB VRAM free, sidecar
suppressed (`DISABLE_AUTOSTART_SIDECAR=1`), no TTS. Batches naturally with C2's
session rather than needing its own.

> **Wave-3 step 6, 2026-08-20 — STILL OWED-blocked.** The GPU itself was
> idle and not the blocker. Live-rechecked today (independent of the plan's
> same-day citation): `#2288` — "findQuoteRuns lets a gap-seeded quote run
> swallow the next dialogue turn" — is still **OPEN**, so the register's own
> hold (naming #2288 as the thing that changes dialogue segmentation) is
> still in effect. Starting the 12h27m-class local re-run now would measure
> a moving target, exactly the outcome the hold exists to prevent. Nothing
> in the row's remaining scope was narrowed.
> `docs/testing/onbox-wave3-results/step-6-group-c.md`.

### C3 · A deterministic stage-2 failure actually clears when the span is halved ([#2304](https://github.com/dudarenok-maker/Castwright/issues/2304))

**What the unit tests already prove, and does NOT need re-running:** the wiring.
A repeated failure signature stops the retry loop, the stop escalates to
`splitSpanForRetry`, and it does so on **both** chunking routes — each mutation-
verified, each with a control that reddens when the fix is made unconditional.

**What is still owed** is the premise underneath all of that: *that a real model,
degenerating deterministically on a real span, produces a different answer when
the span is halved.* Every test above uses a fake model that succeeds on smaller
input **by construction**, so they prove the split is reached, never that it
helps. If the degeneration is a property of the *content* rather than the span
length, the split re-runs twice and fails twice, and the chapter is no better off
— just slower.

The reproducer is already known and specific, which is the only reason this is
cheap: Ночной дозор **ch8**, `repeat-loop` at offset **19**, which reproduced
identically five times across two server lifetimes on 2026-08-12/13. Observe:

- the analyzer log shows the retry **halting on the repeated signature** before
  the `coverageRetries` budget is spent — *"the same attribution failure
  reproduced exactly on attempt N"*. Do **not** pin N to 2: for the ch8 shape
  (attempt 1 a plain truncation, attempts 2+ an identical repeat-loop) the stop
  lands on **attempt 3**, because the first repeat is the first thing there is
  anything to match against. Any N below the budget is a pass;
- the log then shows **`re-attributing a <N>-char section as <M> smaller ones
  (split depth D)`**. This line exists only because nothing else can see the
  split: it happens inside a recursion that fires neither `onChunk` nor
  `onSectionDone`, and `chunkCount` is fixed before any of it runs — so on a
  multi-chunk chapter, which ch8 is, **both of those counters read identically
  whether the escalation fires or is reverted outright**. An earlier draft of
  this row asked for exactly those counters and would have recorded a PASS on a
  null observation;
- **ch8's sentence count is whole**, not the partial take. This is the criterion
  that matters; the two above establish that the mechanism under test is what
  produced it, rather than luck.

Absence of the re-split line is **not** a failure on its own — the split
declines for an indivisible span or at `maxSplitDepth`, and `onExhausted` fires
either way. If the stop line appears without the split line, record that: it
means the chapter reached the depth limit, which is its own result.

Record the outcome either way. A **negative** result here is valuable and must
not be quietly dropped: it would mean the escalation costs model calls without
recovering the chapter, and that the remedy for this failure class has to be
something other than a shorter prompt.

Same setup as C1/C2, and it **batches with the C2 re-run** — that run replays
this exact book and chapter, so this row needs no session of its own. Note C2 is
itself waiting on [#2306](https://github.com/dudarenok-maker/Castwright/issues/2306);
this row is not, and can be taken on any local re-analysis that reaches ch8.

> **Wave-3 step 6, 2026-08-20 — STILL OWED-blocked.** Rides C2's session
> per this row's own text; blocked by the same live-confirmed #2288-open
> state. The ch8 `repeat-loop`-at-offset-19 reproducer and its specific
> log-line criteria are unchanged and were not exercised — no re-analysis
> ran. `docs/testing/onbox-wave3-results/step-6-group-c.md`.

---

### C4 · The dialogue-collapse guard fires on a real collapse and stays quiet on a healthy book ([#2325](https://github.com/dudarenok-maker/Castwright/issues/2325), [#2342](https://github.com/dudarenok-maker/Castwright/issues/2342))

**Why this cannot be closed by the unit tests.** The guard's whole calibration rests on **one** Cyrillic book, nine chapters, two runs — the 2026-08-06 pass (per-chapter narrated speech halves 32.4 18.0 3.8 39.3 3.2 2.0 27.6 33.8 20.8, **max 39.3%**) and the 2026-08-12/13 collapse (93.1 93.7 94.8 97.5 86.5 72.2 84.3 74.6 91.8, **min 72.2%**). The 60% threshold sits in a 33-point gap between two runs of the *same book*. Every automated test feeds the guard a fixture built to breach or not breach it; none can say whether a *different* real Russian, French or Spanish book lands in that gap. Replaying the metric over all 82 cached analyses on this box found **exactly one** with an evaluable speech population (4,240 speech halves, 19.9% narrated); the only other two Cyrillic books hold **19** and **15** speech halves, both under the 20 floor. No offline work can widen this — a second dash-language book has to be imported.

**Observe, on a real local re-analysis:**

- a **healthy** dash-convention book completes with no `attribution-collapse` chapter failure, and the per-chapter narrated-speech share logged for each chapter sits below 60%. Record the actual percentages — the distribution is worth far more than a pass/fail, because it is what says whether 60% has real headroom or got lucky;
- the guard's **retry** fires on a section that breaches, and the kept take is the *less* collapsed one (#2342 made the scoring see the collapse dimension at all — confirm the better take survived, not merely that a retry happened);
- a chapter that still breaches reports **`attribution-collapse`** with the cast-focused copy, **not** `attribution-incomplete`'s "did not cover every sentence / a retry usually fills the gaps" — that copy was factually wrong for this failure class until #2342, and this is the only place the corrected wiring is exercised end to end;
- the **marker-loss** control does not false-positive: the source's dash-opening count and the attributed speech-half count are logged for at least one chapter, and the second is well above half the first. Both real runs measured ~246→213 and ~241→209, so near-parity is expected and a ratio approaching 0.5 is what to escalate.

**Hardware prerequisite:** no GPU needed — local Ollama analyzer only, as with the rest of Group C. Best taken in the same session as C2/C3 rather than as its own long run.

**Where the criteria live:** the max-39.3%/min-72.2% per-chapter narrated-speech-half figures this row cites are stated directly above, in this row (**Why this cannot be closed by the unit tests**) — no source file duplicates them at that granularity, so this row is their canonical home, not a pointer away from it. [`server/src/analyzer/stage2-coverage.ts`](../../server/src/analyzer/stage2-coverage.ts) carries two DIFFERENT calibration figures of its own, not this row's numbers: the module header's 95.7%/67.9% (lines ~160-161) is the same book's WHOLE-BOOK, ALL-SENTENCE narrator share, not the per-chapter SPEECH-HALF share the 60% threshold actually gates — reading 67.9% as "under the 60% threshold" would be wrong, since the good run's per-chapter figure this row measured is 3.2-39.3%, comfortably clear; and the `markersLost` comment's 246→213/241→209 (lines ~389-390) is an unrelated dialogue-marker-recovery calibration, not a narrated-share number at all. There is no dedicated plan doc for #2325/#2342, and plan 247 (dialogue-structure attribution) mentions neither the issue nor this calibration, so it was never the right pointer. Related but distinct: the #1984 attribution-collapse *visibility* strand measures and surfaces collapse; this guard *acts* on it during analysis. They share a name and nothing else — do not discharge one against the other.

**Not discharged by:** a green `npm run test:server`. The guard's tests are fixture-driven by construction; that is the point of this row.

> **Wave-3 step 6, 2026-08-20 — STILL OWED-blocked.** "Best taken in the
> same session as C2/C3" — same live-confirmed #2288-open block. Both
> halves of this row's criterion (fires on a real collapse; stays quiet on
> a healthy book) remain unexercised, recorded as two separate still-owed
> observations per this row's own requirement that a guard is only proven
> by both. Re-resolution note, not acted on: even once #2288 clears, the
> healthy-book half may need a second Cyrillic/dash-convention book
> imported, since replaying the metric over this box's 82 cached analyses
> found only one with an evaluable speech population.
> `docs/testing/onbox-wave3-results/step-6-group-c.md`.

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

### D3 · The re-open bound's recovered turn actually sounds right when voiced ([#2315](https://github.com/dudarenok-maker/Castwright/issues/2315), plan [`docs/superpowers/plans/2026-08-13-primary-pair-straddle.md`](../superpowers/plans/2026-08-13-primary-pair-straddle.md))

The re-open bound (`scanQuoteRuns`, `server/src/analyzer/dialogue-structure/parser.ts`)
changes run boundaries on real books in all seven supported languages — 1,231
corpus paragraphs, dominated by `zh` (744) and `fr` (232). Every test in the PR
scores the recovered span's *text* (never lost, never mid-word) and, separately,
whether the tag-clause guard keeps a speaker attached — neither measures whether
the recovered turn *sounds* acceptable once voiced, which is a judgement only a
real render + a human ear can make.

**What to observe:** generate a chapter of a `zh` or `ja` book that contains a
continuation paragraph — the design doc's worked example
(`docs/superpowers/specs/2026-08-13-primary-pair-straddle-design.md` § "What it
fixes, on real books") quotes two, one already in the Gutenberg corpus this PR's
own instruments read. Confirm the previously-swallowed inner turn now renders as
its **own** speech turn, in the character's own cast voice rather than merged
into the narration/tag reading of the turn before it, and that the boundary
doesn't land mid-word or drop a syllable. A `ru` or `de` chapter containing one
of the 3/97 `ru`/`de` corpus paragraphs this PR changes is a secondary, lower-
priority check — `zh`/`ja` carry the bulk of the real-book delta (744+75 of
1,231) and are also the two scripts with no case distinction for the CJK-blind
part of defect 2's corpus proxy, so they are the shapes least covered by any
other instrument in the PR.

No hardware prerequisite beyond a working TTS engine (Kokoro/Coqui/Qwen, any) —
listed here rather than under Group A because the debt is about *listening*
to real output, not about VRAM or a specific card.

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
sidecar**, and **confirming the pinned Node is the one actually used**.

> **Escalated 2026-07-27 by [#1859](https://github.com/dudarenok-maker/Castwright/issues/1859);
> the pin landed in a follow-up chore.** The Node question used to be "which Node does
> Pinokio's bundled kernel ship, and is it ≥ 22.22" — that's now moot: `install.js`
> step 1 conda-installs `nodejs=24` (matching `.nvmrc`/CI), and `update.js` re-asserts
> the same pin so a pre-existing install picks it up on its next Update rather than
> staying on whatever Node it started with. `pinokio-scripts/lib/node-pin.test.js`
> pins both the pin itself and that it satisfies `package.json`'s `engines.node` floor
> in code, so a future floor raise without a matching pin bump fails that test — this
> register row is now about what a test can't reach: the real Pinokio runtime.
>
> **What to observe, concretely:** on a machine with Pinokio installed, run a fresh
> Install, then from a `shell.run` step (or the Pinokio terminal, once the conda env is
> active) run `node --version` and confirm it reports **24.x**, not whatever Pinokio's
> kernel bundles — conda envs prepend to PATH, so the pinned Node should shadow the
> bundled one, but that shadowing is unverified outside this repo's reasoning. Then
> confirm Install → Start still completes end to end (this pin adds a package to the
> conda env; a bad channel/solve would surface here, not in any local test).
>
> **The mid-life-upgrade path, and the lag you should EXPECT rather than report as a
> bug.** Pinokio loads `update.js` from the release the user currently has checked out
> and iterates the `run[]` it loaded; `resolve-release.js` `git checkout`s the new tag
> *inside* that run, replacing the file on disk without affecting the loaded array. So
> updating **from a pre-pin release runs the OLD `update.js`** — no pin step — and does
> that update's `npm ci`/build on Pinokio's bundled Node. **This is expected.** The pin
> takes effect from the *next* Update.
>
> Concretely: take an install from a pre-pin release, Update once, and check
> `node --version` — reporting the **bundled** version here is the correct result, not a
> failure. Update a second time and it should report **24.x**. A tester who sees the
> first result and files "the pin doesn't work" has found the documented behaviour, not
> a defect. What genuinely wants confirming is that the second Update converges, and
> that `node_modules` still works across that Node-major swap (native-module ABI is the
> nominal risk, though every native artifact in both trees is a prebuilt N-API binary,
> and `npm ci` deletes and rebuilds `node_modules` anyway — so this should self-heal;
> unproven on-box).
>
> Criteria live in `docs/features/218-pinokio-installer.md` open-verification item 2
> (updated in the same PR). **The release notes for 1.15.0 deliberately do not promise
> Pinokio users this is handled** — an earlier draft did, and it was unsupported; the
> current entry describes the pin without claiming on-box confirmation.

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

> **Correction, 2026-08-21.** The owner ruled E4 is runnable, not
> hardware-blocked like E6/E8/B2-step-7 — `tts.qwen.device` is a real
> user-facing registry knob (`server/src/config/registry.ts:676-682`), not a
> machine-level hardware constraint. **Wave-4 step 5f attempt, STILL OWED:**
> port `:9000` was already held by another lane's live sidecar process for
> the whole session (confirmed via `Get-NetTCPConnection`), so this row could
> not be safely isolated this run without restarting a sidecar process this
> worktree does not own — recorded STILL OWED for that reason, not for any
> hardware limitation. Full evidence:
> `docs/testing/onbox-wave4-results/step-5f-e4-cpu-caveat.md`.

### E5 · fe-39 touch press-feedback — DevTools smoke-check ([#1795](https://github.com/dudarenok-maker/Castwright/pull/1795))

The behavioural touch-flash is confirmed by construction but not by an automated test
(jsdom cannot compile the variant); a one-time DevTools touch-emulation check is the
spec's accepted proof. Four controls: continue-listening play badge, "Add book" tile,
wizard "Review ›" chip, voice-library drag icon. Minutes, any machine.

> **Wave-4 step 5d, 2026-08-21 — 1 of 4 controls DISCHARGED, shrinks.** Driven
> via real synthesized touch (CDP `Input.dispatchTouchEvent` on a
> `hasTouch:true` Pixel-7-profile context, the same path `page.touchscreen`/
> `.tap()` use). The wizard **"Review ›" chip** is **DISCHARGED**: a
> measurably distinct mid-press color plus a real click-through confirmed.
> The other three controls (continue-listening play badge, "Add book" tile,
> voice-library drag icon) are **STILL OWED** — this worktree's workspace has
> 0 books (no `GEMINI_API_KEY` configured, by design, so no book could be
> analyzed to populate them), a genuine environment limitation, not a
> missing or broken control. Full evidence:
> `docs/testing/onbox-wave4-results/step-5d-e5-e7-observations.md`.

### E6 · fe-57 venv-bootstrap progress card — the fix nothing automated can prove ([#1883](https://github.com/dudarenok-maker/Castwright/issues/1883), plan [270](../features/270-openapi-setup-surface.md))

`src/components/venv-bootstrap.tsx` declared `status: 'installing'` — a value
`server/src/tts/venv-bootstrap.ts` **never emits** (its states are `detecting` /
`bootstrapping` / `installed` / `error`; `'installing'` is the sibling ollama/coqui/kokoro
vocabulary, copied here by mistake). So the in-progress branch was dead in production: through
a real multi-minute venv bootstrap the card never rendered and the user saw the idle
"Set up the voice engine runtime" button the whole time. **The suite stayed green because the
component's own tests mocked `'installing'` too** — a placebo over a wire value the server
cannot produce.

The fix is now typed against the generated contract, so that class of drift is a compile
error, and an `it.each(['detecting','bootstrapping'])` regression pins the card. **But every
one of those tests mocks `fetch`.** No automated test has ever driven this component from a
real bootstrap job, which is precisely how the bug survived in the first place.

Needs a box with **no** `server/tts-sidecar/.venv` (delete it, or a fresh clone). Any machine,
no GPU. ~2 GB download, several minutes — that duration is the point.

Observe:

1. Setup Wizard → voice-engine step with the venv absent → the "Set up the voice engine
   runtime" button.
2. Click it. **Within ~1.5 s the progress card must appear** — spinner, "Setting up the voice
   engine runtime…", and a live `job.step` line. Before this fix, nothing happened here.
3. Watch the step text **change** as the job advances (`Starting venv bootstrap…` → pip
   output). This proves the poll loop and the card are wired to the same job, not just that a
   card rendered once.
4. Let it finish → the green "Voice engine runtime ready" card, and `onBootstrapped` refetches
   so the parent's status flips without a reload.
5. **The `detecting` window is brief** — if you miss it, that is fine; step 2 covers the
   pre-terminal render. Do not report a missed `detecting` frame as a failure.
6. Failure path, if cheap to induce (e.g. no Python 3.12 on PATH): the red "Setup failed" card
   with the server's message, and a working "Try again".

> **Wave-3 step 7, 2026-08-20 — split, server half DISCHARGED, rendered half
> OPERATOR.** The job/poll wiring underneath the card (`POST
> /api/setup/venv/bootstrap`, `GET /api/setup/venv/bootstrap/:id`) was run
> for real against a genuinely absent venv (this worktree's own, never
> deleted from a live one) — a real 8m49s `bootstrap-venv.mjs` subprocess
> with distinct polled step values across the whole run and a genuine
> terminal `installed` state, independently confirmed via `detect` and the
> filesystem. This is the exact wiring the row's own text says "no
> automated test has ever driven... from a real bootstrap job," proven
> not-mocked. **Observations 1, 2, 4, 5, 6 remain owed** — they are rendered-
> page states (spinner, card timing, green ready card, refetch-without-
> reload, failure card) with no API-only substitute stated in the row.
> **Still owed to the operator** — observations 1, 2, 4, 5, 6 above have not
> been run; this row is not discharged, only its server/poll half is.
> **Correction, 2026-08-20:** this row previously stated the join to
> `onbox-sitting-device-browser.md` as if it had already happened; it had
> not — the pack's own row list and minute total were never updated to
> include E7 (confirmed empty diff against the pack file across all of wave
> 3). That gap is fixed in the same round: E7 is now folded into
> `onbox-sitting-device-browser.md` alongside E1, E2, E3, E5, E6, E9, E10,
> and `onbox-sitting-plan.md` §2.1/§2.2 are corrected to move E7's
> rendered-half debt from the wave-3 agent-runnable set to that operator
> pack — the same pattern already used for A33/A43.
> `docs/testing/onbox-wave3-results/step-7-e7-e8.md`.
>
> **Wave-4 step 5d, 2026-08-21 — split further, shrinks.** Observations 1, 2,
> the timing/no-flash behaviour, 4 (green ready card), and 5 (refetch
> without reload) are all **DISCHARGED** live, via a real ~8m55s
> `bootstrap-venv.mjs` subprocess against a genuinely absent venv, in a real
> browser tab held open the whole run. Two genuine findings, not failures,
> flagged alongside: (a) `sidecarVenvPresent()` can read "ready" before pip
> install actually finishes — a follow-up worth its own issue, not a fail of
> this row; (b) the auto-transition on completion lands on the setup
> **summary board**, not a lingering ready-card inside the step-voice
> drill-down — a UX note, not evidence against "no reload". **Observation 6
> (the failure path, e.g. no Python 3.12 on PATH) was NOT attempted** —
> inducing a real failure now would mean breaking a venv that just finished a
> real 9-minute install, or interrupting a live subprocess, both of which
> risk the shared box. Observation 6 is this row's one remaining debt. Full
> evidence: `docs/testing/onbox-wave4-results/step-5d-e5-e7-observations.md`.

---

### E7 · ORT marker — the Pinokio update path ([#2192](https://github.com/dudarenok-maker/Castwright/issues/2192), plan [282](../features/282-ort-pip-consistency-marker.md)) · **group with E1**

Design doc §On-box acceptance, criterion 4: `pinokio-scripts/update.js` — named
specifically, not `install.js` — as "the deployment shape that reported the bug."
`update.js` and `install.js` both invoke `bootstrap-venv.mjs` directly with **no
server process at all**, but they are not interchangeable: `update.js` loads from
the *currently checked-out* release and iterates its `run[]`, per the Pinokio
installer's own documented one-update-lag behaviour (see E1) — a fresh-install
pass does not stand in for an update pass. Every other on-box row for this feature
runs through the dev server, a different process entirely; this is the only row
that proves the out-of-process invocation applies the marker identically rather
than taking some code path only the server-mediated call exercises.

- On a machine with Pinokio and an **existing** (pre-fix) install (Windows, the
  original reporter's platform, is the priority; **group with E1**, which already
  owns the Pinokio box), run Update on the nvidia profile.
- **This PR changes no `requirements/*.txt`, so on this release Update takes the
  `noop` branch**: `bootstrap-venv.mjs`'s `classifyVenvState` sees an unchanged
  `reqHash`, `main()` returns before ever calling `runInstall`, and no marker is
  written by Update at all — that is expected, by design, not a failure. Confirm
  instead that `pip check` is unchanged from its pre-Update state, then that the
  marker arrives (and `pip check` goes clean) at the **next server boot** via
  `ensureOrtMarker`'s self-heal — the same mechanism criterion 3 already proved,
  reached through the Update entry point. A future release that *does* touch
  `requirements/*.txt` takes the `pip-in-place` branch instead, and on that
  branch `pip check` should be clean immediately after Update, with no server
  ever having started — written directly by `bootstrap-venv.mjs`'s own call to
  `applyOrtMarkerWrite`.
- From within the app once it does start, install Qwen3 (the original bug's own
  repro) and confirm no `WinError 5`.
- **In the same session, also run a fresh Install** (`install.js`) and confirm the
  same outcome — a second shape of this criterion, not a separate row. `install.js`
  has no prior stamp, so it always takes the `pip-in-place`-shaped path (marker
  written immediately, no boot needed) regardless of which branch Update took.

*Needs:* a machine with Pinokio installed, an existing pre-fix install, nvidia
profile. *Cost:* 20–40 minutes, sharing setup with E1. *Criteria:* design doc
§On-box acceptance item 4; run sheet §6 in
`docs/testing/ort-marker-onbox-acceptance.md`.

### E8 · revoke is loopback-only — the forwarder boundary and the copy that replaces the button ([#2269](https://github.com/dudarenok-maker/Castwright/issues/2269), PR [#2280](https://github.com/dudarenok-maker/Castwright/pull/2280), plan [225](../features/225-lan-browser-device-auth.md)) · **group with E2/E3**

`DELETE /api/devices/:id` is now gated to true loopback. Nothing automated reaches
the real boundary: the server test **fabricates** a request object with
`req.ip = '127.0.0.2'`, and the frontend test **stubs** `window.location`. Both are
correct unit tests and neither has ever seen the actual `:443` forwarder, which is
what makes the host's own browser non-loopback in the first place
(`lan-port-forwarder.ts` dials upstream with `localAddress: '127.0.0.2'`, and it is
host-blind, so a phone on `castwright.local` is indistinguishable from the desktop
there). The narrowing is also user-visible, and the replacement copy is the only
thing standing between an owner and "the button vanished with no explanation."

- From **`https://localhost:<port>`** (the direct port, NOT the `:443` shortcut):
  Revoke a device — it succeeds and the row drops out of the list. This is the one
  address the feature leaves working; if it fails, the gate is too tight.
- From **`https://localhost/`** (port 443, through the forwarder): the Revoke
  button still **renders** — `isLoopbackHost()` is a hostname-only client-side
  heuristic that cannot see the forwarder — and pressing it returns 403. Confirm
  the error shown is the actionable sentence naming the direct-port address, **not**
  a raw `revoke failed (403)`, **and that the port in it is the one you actually
  bound** (see the run-with-a-non-default-port note below).
- From **`https://castwright.local` on a phone**: no Revoke control on any row, and
  the explanation renders **once below the device list, not once per row**. Check
  this with **at least 3 paired devices** — per-row rendering was the shape caught
  in review, and with one device the bug is invisible. Confirm it is legible at
  phone width and does not crush the label/date columns.
- **The security half, and the reason the row exists:** from a paired phone (or any
  LAN device holding a valid credential), call `DELETE /api/devices/<the host's own
  record id>` directly — the id is in `GET /api/devices`, which that device can
  read. Expect **403**, and confirm afterwards via the host UI that the host's
  record is **still live, not revoked**. Before #2269 this succeeded and locked the
  owner out of their own install.

**Run this with a NON-DEFAULT `LAN_HTTPS_PORT`** — e.g. `LAN_HTTPS_PORT=9443`.
This is not a nicety, it is what makes two of the bullets above mean anything.
Every one of these hint strings hardcoded `https://localhost:8443` until
[#2278](https://github.com/dudarenok-maker/Castwright/issues/2278) (PR
[#2294](https://github.com/dudarenok-maker/Castwright/pull/2294)) made them read
the actually-bound port. **On a default-port box the old hardcoded string and the
new dynamic one render identically**, so the run would pass without proving the
fix — the same trap the automated tests avoid by pinning 9443 rather than 8443.
A non-default port also exercises the case the fix exists for: an operator who
moved the port had, until #2278, no way to discover the one address revoke works
from. (Note production auto-rebind can move the port again beyond whatever you
set; the bound value is the one in the server's own startup line.)

*Needs:* the LAN HTTPS server running with the `:443` forwarder actually bound
(`npm run start:lan`; no elevation required on Windows — see plan 283's ship
notes), a **non-default `LAN_HTTPS_PORT`** per the note above, plus a phone or
second machine paired over `castwright.local`. *Cost:* 15–20 minutes; shares its
whole setup with E2 and E3, so run the three together. *Criteria:* PR
[#2280](https://github.com/dudarenok-maker/Castwright/pull/2280) body and PR
[#2294](https://github.com/dudarenok-maker/Castwright/pull/2294) body; plan 225
§Invariants item 6.

### E9 · `measure-attribution.mjs` against the real workspace ([#1984](https://github.com/dudarenok-maker/Castwright/issues/1984) Wave 1, [plan](../superpowers/plans/2026-08-13-attribution-collapse-visibility-wave1.md)) · **real workspace, no GPU needed**

New read-only `scripts/measure-attribution.mjs` — every unit test mocks its
inputs; nothing automated runs it against the real `C:\AudiobookWorkspace`
library, and the spec's own acceptance criteria are stated as properties of
that run, not of a fixture. Partially run 2026-08-13 from a **feature
worktree**, which is the reason this row exists rather than closes:
`server/handoff/cache/` is per-checkout and git-ignored (CLAUDE.md's own
`CACHE_DIR` note), so a worktree's freshly-built `server/dist` reads an empty
cache for every book until its analyses are copied in from the checkout that
actually ran them — every book that has never been re-analysed in the
worktree itself reads `ok (not analysed)`, indistinguishable from a
genuinely-fresh import.

**What was observed** (21 of 23 real books' caches copied in, read-only, from
the primary checkout; copies deleted afterward — nothing written to
`C:\AudiobookWorkspace`, and the primary checkout's own `server/handoff/cache/`
was only ever read, never written): a row for every book, none blank; both
live CJK books (`煤落的委托`, `コールフォールの依頼`) at `spokenTotal > 0`;
`dashOnlySpoken` non-zero on both Russian books (`Юный дрессировщик` 17,
`Ночной дозор` 1719); `orphanSpoken` non-zero on several books, concentrated
in the *Coalfall Commission* family (0–62 across its seven language
editions); `unattributedSpeech` printed for every book. **Re-verified
2026-08-13** after a #2328 review-gate fix to `orphanSpoken` (it was
double-counting per unresolvable model id sharing one split span, instead
of once per span — finding 1): across this same corpus the fix moved
exactly one book's figure (`Ночной дозор (Tetralogy)`, 30→29), everything
else above is unchanged; see the acceptance doc's own §1/§5 for the
corrected per-book table and D13 percentages. **`modelNarrator` and
`demotedNarrator` read 0 on every book — this is the D18 trap doing its job,
not the R-9C1 finding recurring:** none of these 21 caches have been
re-analysed since `priorCharacterId` shipped, so every narrator-speech span
correctly lands in `unknownOriginNarrator` (verified non-zero, e.g. 193 of
193 on `Юный дрессировщик`) rather than being defaulted to `modelNarrator`.
The mutation-tested proof that site 1 (`reconcileSentenceCharacterIds`) *is*
instrumented lives in `server/src/routes/analysis.test.ts`, not in this run —
this row is what's left: confirming a **freshly re-analysed** real book
actually produces a non-zero `demotedNarrator`/`modelNarrator` split, which
requires GPU time this pass did not spend.

**Item (1) DISCHARGED 2026-08-14** — the full run from the primary checkout at
`df49a261`, read-only, no copied caches, so every book's `hasCacheFile`/`state`
reflects its real analysis history. All 23 books rowed; 21 measurable, and the
two `ok (not analysed)` rows are genuinely un-analysed C2/C3 throwaways rather
than the worktree artifact that forced the 2026-08-13 caveat. **Twenty of 23
books are identical in every column to the partial run**; the three that moved
(`Everblaze` +1 spoken, `Keeper of the Lost Cities` +1 spoken, and
`Ночной дозор (Tetralogy)` across eight columns, `spoken` 1928→2122 and
`orphan` 29→32) are the parser work merged in between — **measured not to be
#2286**, which moved nothing in this corpus on either side of its merge. The
same run completed the **D13 re-gate**, whose verdict is *drop the `drifted`
state* — the owner confirmed this 2026-08-14, closed as #2357: see the run
sheet §5 and spec §D13 re-gated → *Re-gate outcome*.

**Still owed:** (2) the dash-stripped re-run invariance check (Task 9's paired
assertion — run twice, second time over scratch-path copies of each cache with
every leading dash stripped, diff every field of every row); (3) re-analysing
one book post-D18 to confirm `demotedNarrator`/`modelNarrator` actually
populate outside a unit fixture. **Both need GPU/analysis time this pass did
not spend**, which is why the row stays rather than closing.

*Needs:* a checkout (or worktree with `server/handoff/cache/` populated from
one) whose cache holds the real 20-book library's analyses, `cd server && npm
run build`, then `WORKSPACE_DIR=C:\AudiobookWorkspace node
scripts/measure-attribution.mjs`. *Cost:* under 5 minutes once `server/dist`
exists. *Criteria:* spec §On-box acceptance
(`docs/superpowers/specs/2026-08-06-attribution-collapse-visibility-design.md`).

> **Wave-3 step 4, 2026-08-20 — item (2) run, criterion FAILS on real
> data.** Both passes run for real (straight, then dash-stripped over a
> scratch-path copy of every cache file, originals restored and verified
> byte-identical after). 22 of 23 books: zero diffs, every measured field
> identical. **`Ночной дозор` (the corpus's heaviest dash-convention book):
> 14 fields diverge** (`narratorIdSpoken` 229→223, `share` moved, `splitSpeech`
> 337→346, five chapters' per-chapter columns shifted). This is a real,
> reproducible property gap, not harness noise — 22/23 byte-identical rules
> out a broken diff, and the one failing book is the corpus's own worst case
> for the property being tested. Root cause (routed to a fix agent, not
> fixed here): `alignSentences`
> (`server/src/analyzer/dialogue-structure/aligner.ts:317,360`) locates its
> needle by substring-searching the **cached** sentence's normalized text in
> the chapter body — stripping the leading dash changes the needle without
> changing the body, shifting which offsets it locates at. Item (2) is
> therefore **STILL OWED** (the criterion fails, not merely unrun). **Item
> (3)** (post-D18 re-analysis) rides Group B/C's session per the plan and
> was not this step's job — not attempted. Run sheet's own `Result:` line
> updated: `docs/testing/attribution-collapse-visibility-onbox-acceptance.md`
> §4. `docs/testing/onbox-wave3-results/step-4-real-workspace-scripts.md`.
> Filed as [#2537](https://github.com/dudarenok-maker/Castwright/issues/2537)
> (see #2537).
>
> **2026-08-21 — Root-cause fix landed in PR #2577** (commits 40bee7ff..3053f5dd on
> branch fix/server-2537-dash-invariant-align). Item (2), the dash-stripped
> re-run invariance check, **remains owed** — the fix addresses the root cause
> (`alignSentences` needle-search not dash-invariant) and new unit tests pass,
> but on-box re-verification on the real workspace is still required to confirm
> the 14-field divergence observed on `Ночной дозор` is actually closed. Paired
> assertion in Task 9 — run twice, second time over scratch-path copies of each
> cache with every leading dash stripped, diff every field of every row.
>
> **2026-08-21 — On-box re-run against the landed fix (#2571), criterion
> STILL FAILS.** Both passes re-run for real against commit `d9eb03ad`
> (`fix/server-2537-dash-invariant-align`, rebased onto `origin/main`,
> containing PR #2577's full fix series) — straight, then dash-stripped over
> a scratch-path copy of every cache file, originals restored and verified
> byte-identical after. 22 of 23 books: zero diffs, unchanged from wave 3.
> **`Ночной дозор` still diverges: `narratorIdSpoken` 229→223, `share`
> 0.1302→0.1273, `unattributedSpeech` 9→7, `splitSpeech` 337→346,
> `tagNarratorSpan` 544→536, plus per-chapter shifts in chapters 1, 6, 7, 8**
> — the same field names, same direction, same magnitude as wave 3's pre-fix
> numbers. The fix is confirmed present and built into the `server/dist`
> actually exercised (`aligner.ts`/`aligner.js` both carry the dash-invariant
> needle-search code from #2537/#2540), and its own synthetic unit test and
> the #2541 parent-acceptance checklist both passed — but neither reaches
> whatever in this book's real 2,122-sentence, 1,940-dash-only-span structure
> still produces a divergent match. **Item (2) is therefore still owed, not
> discharged.**
>
> **2026-08-23 — pass-2 addendum on #2577:** an earlier draft of this entry
> called this "a residual real-data gap … not the original defect recurring
> unfixed" — that framing overstated what this run showed (removed above,
> not restated here since it no longer applies). It was measured against
> `d9eb03ad`, which predates the
> fix's final mechanism (attempt 4, commit `5a60b088`) — a later mechanism
> that itself needed two more blocking-regression fixes (P1/P2) found in
> subsequent review passes of the same PR. Whether this book's divergence is
> closed by the fix as it now stands is unconfirmed; item (2) stays owed
> pending a fresh on-box re-run against the current commit, not `d9eb03ad`.
> Evidence: `docs/testing/onbox-wave4-results/step-1-e11-item2-rerun.md`.

## Group G — GitHub Actions itself

Not physical hardware — the prerequisite is a real dispatch of a specific workflow
on the real GitHub Actions runner, which local execution cannot substitute for
(a fresh `ubuntu-latest` image, real `GH_TOKEN`/`gh` wiring, real `apt-get`).

### G1 · Quarantine-lane health report — first live dispatch (ops-32, #1864, PR #1873) · **two distinct debts**

PR #1873's own body discloses both under "Known gaps — stated rather than
glossed" rather than leaving them to be rediscovered later.

**Partially discharged — the trigger-side dispatch question is answered; the
`gh issue view` half is not.** The Monday 03:00 UTC cron has now dispatched
the workflow for real, twice (`event: schedule`, 2026-08-03 and 2026-08-10;
latest run id `31355401008`), both `conclusion: success`. Its `Install
ffmpeg` step succeeded on the real runner, and the job summary rendered
exactly the clean no-op this row anticipated:

> \# Quarantine lane health report
>
> No quarantined tests are currently registered in
> `docs/testing/flaky-register.md` — nothing to run. Clean no-op.

`.github/workflows/quarantine-health.yml` parses as valid YAML and
`scripts/quarantine-health.mjs` is verified standalone (46 unit tests,
mutation-checked); the live dispatch now additionally confirms the job
doesn't crash on the real runner, which was the open half of this question.

**Still unverified (as of wave 3): `gh issue view` actually authenticating via
the injected `GH_TOKEN`.** Both real runs at that point took the
empty-register early-return path (`plan.outcome === 'empty'` →
`scripts/quarantine-health.mjs:979`, before the post-loop `gh issue view`
calls). `docs/testing/flaky-register.md` carries two data rows today (#1981
and #2235), but #1981 is marked "Not quarantined — still gates" and only
#2235 is quarantined, so only #2235 passes through the quarantine-lane
report. The run log does show `GITHUB_TOKEN Permissions:
Issues: read`, so the wiring is plausible — but that is not proof the call
actually works on a non-empty `gh issue view` invocation.
`continue-on-error: true` and exclusion from every required check still mean
a failure here cannot block anything.

**Genuine `intermittent` classification is exercised only by unit tests over
synthetic run sequences** — no real cross-run nondeterminism has been forced
through the classifier. This needs an *actual* flaky quarantined test
present in `docs/testing/flaky-register.md` at dispatch time, which the
empty register doesn't provide today — the first dispatch alone won't
discharge this half. **What to observe, next time a genuinely flaky test is
quarantined:** its row in the report's table lands in the `intermittent`
bucket (a real mix of passed/failed across the 5 runs), not `always-passes`
or `never-passes` — confirming the bucket that is this tool's entire reason
to exist actually fires on real data, not just the synthetic sequences in
`scripts/tests/quarantine-health.test.mjs`.

**Net: this row shrinks but does not come out.** The trigger-side dispatch
question above is answered — the workflow runs clean on the real runner —
but its residual (`gh issue view` under real auth) now shares a single
precondition with the second debt below: a real quarantined row in
`docs/testing/flaky-register.md`. Neither remaining half can move until one
exists.

*Why this sits here and not as a plain automated-test-gap issue* (per this
file's own closing rule below): this is NOT closable by writing more unit
tests — `classifyEntry` is already fully unit- and mutation-tested against
every synthetic sequence that matters. What's missing is a real occurrence
of cross-run nondeterminism, which by construction can't be manufactured or
asserted inside a unit test; the only way to discharge it is to observe live
data once it exists, the same shape as any other row in this register, just
triggered by an external event (a future genuine flake) rather than a
hardware prerequisite. One honest caveat: unlike G1's first debt, this half
does NOT strictly require the GitHub Actions runner — a local
`node scripts/quarantine-health.mjs` run against a real flaky register row
would equally discharge it. It stays grouped under G1 anyway because it
shares G1's dispatch-triggered, opportunistic-timing framing and "what to
observe" shape, not because Group G's runner criterion technically applies
to it.

*Needs:* a real quarantined flaky test (naturally occurring, not
manufactured) — the shared precondition left for both remaining halves.
*Cost:* opportunistic — piggy-back
on the next real quarantine event rather than manufacturing one.

> **Wave-3 step 8, 2026-08-20 — STILL OWED-blocked, both debts, on new live
> evidence.** This row's "flaky register carries one row today (#1981)" text
> above is now stale — corrected here rather than silently: `#2235` has been
> a real quarantined row since 2026-08-13, so the precondition both debts
> share has existed for a week. But `gh pr view 2488` shows PR #2488 (parses
> the register's real test-cell format) is still **OPEN** and `gh issue view
> 2465` (parseRegister drops every real register row) is still **OPEN**.
> Live-checked, not theoretical: the 2026-08-17 scheduled dispatch
> (`databaseId 31992063988`, off a commit descending from #2235's own
> quarantine commit) reported a clean "nothing to run" no-op — `#2465`
> silently dropping a real quarantined row **in production, today**. Because
> the run took the empty-register path, the post-loop `gh issue view` calls
> were never reached — debt 1 remains unreachable — and the `intermittent`
> classification (debt 2) is blocked for the identical reason. Both verdicts
> unchanged from STILL OWED-blocked; the live dispatch sharpens the evidence
> from "the fix will unblock this" to "the bug is actively dropping a real
> row today." `docs/testing/onbox-wave3-results/step-8-group-g.md`.
>
> **Correction, 2026-08-20 (rework of wave-3's own recording, `#2497`).** The
> step-8 note above captured PR #2488 and issue #2465 as **OPEN** roughly 15
> seconds before #2488 actually merged, and step 9's fold carried that stale
> "OPEN" forward without rechecking. Live-rechecked now: PR #2488 **MERGED**
> 2026-08-20T06:45:02Z (`gh pr view 2488`), and issue #2465 **CLOSED** the
> same second (`gh issue view 2465`) — see [#2488](https://github.com/dudarenok-maker/Castwright/pull/2488),
> [#2465](https://github.com/dudarenok-maker/Castwright/issues/2465). Blocking
> precondition (b) — the `parseRegister` fix landing — has therefore cleared.
> This does **not** discharge G1: neither debt has actually been re-observed
> under the fixed code yet — the two real dispatches captured above both
> predate the merge, and no scheduled or manual dispatch has run since. The
> row's disposition changes from **STILL OWED-blocked** to **STILL
> OWED — unblocked**: the next real dispatch (the following Monday 03:00 UTC
> cron, or an earlier manual `workflow_dispatch`) against the still-live
> `#2235` quarantined row is what would actually discharge debt 1 (`gh issue
> view` under real auth) and, opportunistically, debt 2 (`intermittent`
> classification on real data).
>
> **Wave-4 step 1, 2026-08-21 — debt 1 DISCHARGED, debt 2 STILL OWED.** A
> genuine post-fix manual dispatch (run id `32426439853`, `event:
> workflow_dispatch`, created 2026-08-20T22:55:36Z, after PR #2488's
> `ff4fec58` merged) confirmed a non-empty `parseRegister` return before
> dispatching, then reached the post-loop `gh issue view` calls for the first
> time in this workflow's life: the job summary table shows real `CLOSED`
> values for both `#2226` and `#2235`, a live value only a real, authenticated
> `gh issue view` call can produce. **Debt 1 is DISCHARGED.** **Debt 2 is
> STILL OWED**: the run's 5 repeats of `#2235` all landed `always-passes`
> (5/5) — a real verdict, not an `unknown`/runner failure, but per this row's
> own criteria a clean 5/5 does not discharge the `intermittent` bucket
> (needs an actual pass/fail mix). What would discharge it next: a dispatch
> that happens to run concurrently with other runner load, more likely to
> surface the contention-dependent race. **New finding, not yet reflected
> anywhere else:** the job summary itself flags both `#2226` and `#2235` as
> "orphaned debt with no owner" — both tracking issues are CLOSED while their
> quarantine-lane rows are still live. Full evidence:
> `docs/testing/onbox-wave4-results/step-1-g1-live-dispatch.md`.

### G2 · The published release body now comes from the committed file, not the tag annotation ([#2137](https://github.com/dudarenok-maker/Castwright/issues/2137), PR #2168)

`release.yml` validated `docs/release-notes-next.md` at the tag ref but published
the tag's *annotation* — a different string, with nothing verifying the two
agreed. This PR sources the body from the committed file, runs the same
BOM / conflict-marker / mojibake checks against the annotation, and **fails the
release closed** when file and annotation diverge.

**Every part of that is unexercised until a real tag push.** `scripts/release-body.mjs`
is covered standalone by `scripts/tests/release-body.test.mjs` (throwaway git repos,
real annotations), but the live path — the workflow step actually invoking it on
`ubuntu-latest`, the `actions/checkout` + "Restore annotated tag" dance leaving
`%(contents)` readable, `docs/release-notes-next.md` actually being present in that
checkout, and `gh release create --notes-file release/tag-notes.md` receiving the
file this step wrote — is not.

**This row carries more risk than most in this register: a false positive BLOCKS
the release outright.** The divergence check is fail-closed by design, so a
normalisation bug or a checkout that lacks the notes file does not degrade the
body — it stops the cut. That is the correct posture, and it is precisely why the
first live run needs watching rather than assuming.

Pre-merge evidence, gathered rather than asserted — the **shipped**
`resolveReleaseBody()` replayed against the last 12 real tags (not the test
suite's own fixtures; the production function fed each tag's real annotation and
real committed file):

- `v1.14.0`, `v1.13.0`, `v1.12.3`, `v1.12.2`, `v1.12.1`, `v1.12.0`, `v1.11.0`,
  `v1.10.0`, `v1.9.0` → **publish from FILE**. The normal path, 9 consecutive
  recent releases.
- `v1.8.0` → **BLOCKED**. Annotation is the bare placeholder `Castwright v1.8.0`
  (18 B); file is 3,060 B of the *previous* cycle's notes, headed
  `# Castwright v1.7.0`. Publishing the file would have shipped v1.7.0's notes.
- `v1.7.0` → **BLOCKED**. File 3,060 B vs annotation 6,757 B — the same stale
  file, against an annotation carrying the real notes.
- `v1.6.0` → file absent at that ref → **publish from ANNOTATION** (rule 2).

All four rules exercised against real history. Note that **two** historical
releases genuinely diverged: at v1.7.0 and v1.8.0 the published body was not the
file the gate had validated. This issue is not hypothetical, and the nine
consecutive agreements since suggest the modern cut path is sound — so a spurious
block on the next cut is unlikely, but not proven until observed.

**What to observe, at the next real release cut:**

1. The `publish` job's release-body step exits 0 and logs which source it chose —
   expected: **the file**, not the annotation.
2. The published GitHub release body is the full notes, not the one-line
   `Castwright vX.Y.Z` placeholder and not empty. Compare it against
   `git show <tag>:docs/release-notes-next.md`; they must match.
3. The annotation checks ran and passed — visible in the step's output, not
   silently skipped.
4. If the step instead **fails**, that is a real signal, not noise: read the
   message, which names both sources and their sizes, and decide whether the tag
   or the file is wrong before overriding anything.

*Needs:* nothing beyond a real `vX.Y.Z` tag push — i.e. the next release cut.
*Cost:* zero extra; it is observed as part of a cut that was happening anyway.
*Discharges when:* one real release publishes with a body sourced from the file
and the observations above are recorded here.

> **Wave-3 step 8, 2026-08-20 — STILL OWED, no opportunity yet.** PR #2168
> (the fix under test) merged 2026-08-06. Live-checked: `v1.14.0`, the
> latest and only candidate anywhere near the fix, was tagged 2026-07-23 —
> **two weeks before** the fix merged, so its published body was produced by
> the pre-fix path and cannot exercise this row. No tag has been pushed
> since. Unchanged from opportunistic framing; no manufacture attempted
> (box-safety: a false positive here blocks a real release).
> `docs/testing/onbox-wave3-results/step-8-group-g.md`.

---

## Group H — no hardware, needs a real CJK manuscript this corpus lacks

Not a hardware prerequisite at all — the blocker is a real-book fixture this
repo's corpus doesn't currently have. `detectManuscriptLanguageFromChapters`
needs no GPU, sidecar, or analyzer; it is a pure function over chapter text,
runnable on any machine (`npx tsx` against a real manuscript's chapters, or a
dry-run `npm run repair:book-language` pass over a real imported book).

### H1 · Kana-trigram richness gate holds at real-book scale for an all-kana (no kanji) Japanese manuscript (#2256 round 3, finding 3(b)/C5)

`server/src/tts/prose-units.ts`'s kana tokenizer (overlapping character
trigrams, replacing per-character tokenization) is verified only against an
own hand-authored synthetic all-kana fixture — 30 distinct hiragana base
words composed into 1,500 sentences, `detect-language.test.ts`'s
`finding 3(b)` fixture — not a genuine all-kana book. The fix closes the
SPECIFIC real
failure the original #2256 finding reported (a real book at N≈4,843
characters, old per-character scheme measured R=1.72, refused) using the
finding's own reported number as an anchor, but this repo cannot reproduce
that exact book to re-measure it directly, and the synthetic fixture's
margin is known to be vocabulary-dependent and thinner than Han-based CJK's
(round-3 finding C5 additionally found the richness gate is close to inert
for kana beyond what `dedupeProseUnits` already catches — see
`prose-units.ts`'s own finding-3(b) block for the honest numbers, all of
which round 4 re-measured against the fixture actually in the tree).

**What to observe, once a real all-kana Japanese manuscript is available**
(a children's book or early-reader text with no kanji at all is the
realistic shape — this repo's two real Coalfall Commission translations at
`C:\AudiobookWorkspace\books\Castwright\Standalones\{煤落的委托,
コールフォールの依頼}\manuscript.md` are real CJK text but MIXED kanji+kana,
not the all-kana case this row is about):

1. Run the manuscript's chapters through `detectManuscriptLanguageFromChapters`
   (or a full `POST /api/import`) and record the result — expected:
   `{ language: 'ja', supported: true, fallback: false }`.
2. Separately call `guiraudR` on the same (deduped, per
   `dedupeProseUnits`) winning sample and record the actual value against
   `LEXICAL_RICHNESS_FLOOR` (3) — a real number at real scale, not the
   30-word synthetic fixture's.
3. If the book has multiple chapters, note the total combined character
   count the richness gate actually saw (no cap applies post-#2256 round 3 —
   see `prose-units.ts`'s finding-3(a) retraction) — the margin at that
   real scale is the actual thing this row exists to confirm.

*Needs:* a real, legally usable all-kana (no kanji) Japanese manuscript —
no GPU, sidecar, or analyzer.
*Cost:* one `detectManuscriptLanguageFromChapters` call plus recording the
observed `R`/`digitTokenShare` numbers here.
*Discharges when:* a real all-kana manuscript has been run through
detection, the result and the observed `R` are recorded in this row (or a
dedicated run sheet this row is updated to point at), and either the
current trigram fix is confirmed sufficient at real scale or a follow-up
issue is filed with the real numbers that show it isn't.

### H2 · Lexical-richness floor still clears on a FULL-LENGTH real Han (Chinese) book (#2256 round 4, finding B3)

`voteLanguage` measures the two lexical gates over the whole joined winning
sample with **no length cap** — round 2 added one, round 3 removed it
because the cap made the verdict chapter-order-dependent. Removing it is
right for that reason, which is measured. What is NOT measured is the thing
the cap was originally added for: Guiraud's R is `V / sqrt(N)`, and `V`
saturates while `N` keeps growing, so R decays with book length.

Round 3 recorded a direct measurement of "the corpus's 815k-char worst case
→ R≈4.4" as the justification for removing the cap. **Round 4 could not
reproduce that number from anything in this repo, and it has been deleted
rather than restated.** What this repo can actually reach:

- the two real Coalfall Commission translations (read-only,
  `C:\AudiobookWorkspace\books\Castwright\Standalones\{煤落的委托,
  コールフォールの依頼}\manuscript.md`) — R = **12.078** (zh, 4,425 Han
  characters, 795 distinct) and **27.302** (ja mixed, 7,797 chars);
- no synthetic substitute: a 30-word-pool zh narrative at 21,711 characters
  measures R = **1.581** and is *refused*, because a hand-authored pool
  reaches ~250 distinct Han characters where real Chinese prose reaches
  thousands. A synthetic large-N fixture measures its own vocabulary, not
  the gate.

So the largest real Han sample this repo can measure is ~4.4k characters,
one to two orders of magnitude short of a book.

**What to observe, once a full-length real Chinese manuscript is available:**

1. Import it (or run `detectManuscriptLanguageFromChapters` over its
   chapters) and record the result — expected
   `{ language: 'zh', supported: true, fallback: false }`.
2. Record the **combined character count** of the joined winning sample the
   gates actually saw (every winning chapter's `prepareSample` output, each
   capped at 20,000 chars, joined) and the **observed `guiraudR`** on it,
   against `LEXICAL_RICHNESS_FLOOR` (3).
3. Record the **distinct-Han-character count** at that scale. That is the
   `V` in `V / sqrt(N)` and it is the whole question: at N = 400,000, R
   clears the floor only if V is above ~1,900.

*Needs:* one real, legally usable full-length Chinese (Han) manuscript —
no GPU, sidecar, or analyzer.
*Cost:* one detection call plus recording three numbers here.
*Discharges when:* a full-length real Han book has been run through
detection and its N, V and R are recorded in this row — either confirming
the uncapped gate clears the floor at book scale, or showing it does not,
in which case a follow-up issue owns re-introducing a length correction
that is NOT a chapter-order-dependent prefix.

---

## Blocked — hardware not available

### AMD GPU support Phase 2 ([#1335](https://github.com/dudarenok-maker/Castwright/issues/1335))

Waves A–G were built and merged **dormant** — the code path exists but has never run
against real ROCm hardware. A dormant capability, not an active bug. This box is
dual-NVIDIA; this will not move until AMD/ROCm hardware exists.

### ORT pip-consistency marker — AMD box ([#2192](https://github.com/dudarenok-maker/Castwright/issues/2192), plan [282](../features/282-ort-pip-consistency-marker.md))

Design doc §On-box acceptance, criterion 5: "no marker is written" on AMD.
`planOrtSwap('amd', …)` resolves to plain `onnxruntime` (`accelerator-profile.mjs`),
so the AMD profile takes the `marker.action === 'delete'` branch — the same branch
cpu and apple take, both of which this box CAN exercise. What is genuinely
AMD-specific and unverified is the ordering that branch exists to protect: the
AMD→ROCm-failure→CPU fallback inside `bootstrap-venv.mjs`'s `installForProfile`
(`cpu.txt` carries an **explicit** `onnxruntime` line the fallback needs to actually
install; a stale marker present at that moment would make pip silently skip it).
That fallback only fires on real AMD hardware attempting a ROCm bootstrap that then
fails over to CPU — nothing on a dual-NVIDIA box can reach it. Dormant, not broken:
the delete-at-entry ordering (invariant 3 in the plan doc) is unit-tested via the
injected `runPip`/marker seam, just never against a real ROCm→CPU fallback. This box
is dual-NVIDIA; this will not move until AMD/ROCm hardware exists. Run sheet §7 in
`docs/testing/ort-marker-onbox-acceptance.md` has the recipe ready for when it does.

### CPU-only `RAM_HEAVY_MODELS` clamp (plan 263, B2 step 7)

Formerly step 7 of B2 (per-model analyzer keep-alive). A `RAM_HEAVY_MODELS`
clamp is meant to override a configured positive keep-alive back to `0` when
the analyzer runs CPU-only. Dormant on this box: two resident NVIDIA GPUs
mean `accelerator` in `server/src/analyzer/ollama.ts` structurally resolves
to `'cuda'`, and forcing `'cpu'` would require disabling GPU visibility,
risking other lanes' concurrent work — not attempted. This box is
dual-NVIDIA; this will not move until a CPU-only box exists, or one where
GPU visibility can safely be disabled.

### E8 · ops-36 golden-assembly on a second ffmpeg build ([#1880](https://github.com/dudarenok-maker/Castwright/issues/1880), plan [272](../features/272-golden-assembly-comparison.md))

**1. What is dormant.** The cross-build half of the ops-36 design — whether
L1/L2/L3's hard assertions survive a genuinely different ffmpeg build, and
what L4-loose's RMS-error actually is when the encoder really differs. What
is *not* dormant: the LOOSE branch itself was forced during the ops-36
demonstration with a synthetic banner mismatch plus 2.0 LU of drift and
rejected at 24.79% RMS-error against a 16% tolerance. Only the
genuinely-different-encoder case is unproven.

**2. Why this box cannot reach it.** Verified by wave-3 step 7
(`docs/testing/onbox-wave3-results/step-7-e7-e8.md`): no Docker, no WSL, no
container runtime of any kind on this box, and the only other `ffmpeg.exe`
present (the WinGet package) is the same `8.1.1-full_build-www.gyan.dev`
binary already on `PATH` — not a different build. The tier also sits outside
`verify.yml`, so CI never exercises it either.

**3. What would change that.** A second machine with a different ffmpeg
build (e.g. a BtbN Windows build vs. this box's gyan.dev one, or a clearly
different version), or a CI leg on a runner whose ffmpeg differs from this
box's. This box is single-ffmpeg; this will not move until one of those two
options exists.

**4. Alternative considered and rejected, recorded so it is not
rediscovered.** A portable ffmpeg build unpacked to a scratch directory and
prepended to `PATH` for the duration of one command would change the banner
on *this* box, since every server ffmpeg call spawns the bare string
`'ffmpeg'` (`server/src/export/build-m4b.ts:336`,
`server/src/routes/clip.ts:104`, `server/src/audio/measure-loudness.ts:83`),
which resolves through `PATH`. **The owner ruled on 2026-08-21 that this does
not satisfy the row's intent** — the row means a different environment, not
a different binary on the same one. Recorded here as a neutral decision so a
future reader can reverse it deliberately rather than stumble into it.

### E6 · ops-35 ffmpeg floor — below-floor + Re-check walkthrough ([#1877](https://github.com/dudarenok-maker/Castwright/issues/1877), plan [269](../features/269-ffmpeg-version-floor.md))

**1. What is dormant.** The below-floor preflight exit (`npm run test:server`
must exit 1 against ffmpeg 4.4, printing the host OS's upgrade command); the
amber outdated Setup Wizard card (`data-testid="step-ffmpeg-outdated"`) plus
`GET /api/setup/readiness` reporting `ready: true` with
`blockers.ffmpeg.status === 'warn'`; the Admin diagnostics `warn` row and the
top-bar Admin health dot going and staying amber; and the Re-check-without-
restarting-the-server flip back to green — plan 269's invariant 6, described
in the row as "the most interesting part." Also owed and not coverable on
this box: the Pinokio `"ffmpeg>=6"` constraint on a real conda env, install
and update.

**2. Why this box cannot reach it.** Every unit test drives the floor through
a **mocked** `spawnSync`, so nothing has been exercised against a real old
ffmpeg binary — and per wave-3 step 7's verification (shared with E8, above),
this box has no ffmpeg swap available and no container runtime of any kind,
so there is no way to put a genuinely-below-floor ffmpeg on `PATH` here.

**3. What would change that.** A box or container where ffmpeg can be
downgraded to a real pre-floor build — the row itself names a 22.04
container with archive ffmpeg 4.4 as the cheapest route.

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
