# Wave 5 step 6 — fold steps 1-5's verdicts into the register and the live view

Issue: Castwright#2610 (wave 5 of the on-box register campaign, #2435; step 6 of #2606).

## Inputs read (steps 1-5's evidence files, VERDICT lines only)

- `step-1-a27.md` — **A27: DISCHARGED.**
- `step-2-a45.md` — **A45: DISCHARGED.**
- `step-3-e9.md` — **E9: STILL OWED** (reconfirmation only, disposition unchanged).
- `step-4-b2.md` — **B2 (Stage-1 cast names, #2313): DISCHARGED**, for the criteria that step scopes.
- `step-5-triage.md` — a triage step (device-browser pack re-binning + G1/G2 reclassification in `onbox-sitting-plan.md`), no acceptance row run, no register/live-view edit in scope. Not folded here — it never touched the register.

No verdict was ambiguous or missing; every row named above is accounted for.

## What was done

**Discharged rows removed entirely** (owner ruling, 2026-08-22: discharged rows are removed, never annotated with an outcome note and carried):

- **A27** (`qa.asr.model` reaches the sidecar and every server-side reader) — removed from `onbox-acceptance-register.md` and from the live view.
- **A45** (`speaker-qa.txt` reqHash fix drives a one-time `pip-in-place` reinstall) — removed from both files.
- **B2** (Stage-1 returns cast names in the manuscript's own script) — removed from both files. Added an addendum to `cast-id-drift-onbox-acceptance.md` §7.7 (the run sheet B2's own former row text pointed at) recording that step 4's discharge used a *different* fixture (the committed short-chapter fixture, not a *Заказ Коалфолла* re-analysis) and does **not** close [#2584](https://github.com/dudarenok-maker/Castwright/issues/2584), which stays open on its own issue.

**E9 left in place, dated note added** (still owed, no register-shape change): appended a "Wave-5 step 3, 2026-08-23" note to E9's row in both files, recording the reconfirmation from a second checkout and that items (2)/(3) remain untouched.

**Renumbering**, contiguous within each shrunk group, per the file's own convention:
- Group A: old A28→A27 … old A44→A43, old A46→A44 (A27 and A45 removed; every row after each shifts down). Final count: **A1–A44**.
- Group B: old B3→B2 (B2 removed). Final count: **B1–B2**.
- Every cross-reference to a renumbered id in the body of both files was updated to match (verified by grep — no stale `A29`…`A46` or `B3` cross-reference remains in the body; the header's own historical "Correction" blockquotes, which narrate *past* renumbering waves under the numbering that was live *at the time*, were deliberately left untouched — they are history, not live references).

**Totals re-derived by counting**, not by subtracting from 69:
- Group A: counted `###` row headings under `## Group A` → **44**.
- Group B: counted `###` row headings under `## Group B` → **2**.
- Groups C, D, E, G, H: recounted, unchanged (4, 3, 9, 2, 2).
- Blocked (5) and Unconfirmed (2): unchanged, untouched by this step.
- **Grand total: 44 + 2 + 4 + 3 + 9 + 2 + 2 = 66** (was 69; −3 for the three discharged-and-removed rows, E9 does not move the count).

**"At a glance" table** (both files) updated: A 46→44, B 3→2, total 69→66. A new dated correction block was **added** (not edited into an existing one) in the style the file already uses, in both the markdown header and the live view's callout strip, immediately above the prior (2026-08-22) correction.

**Live view** (`onbox-acceptance-register-live-view.html`) — hand-edited, not regenerated from the markdown:
- Removed the A27, A45, and B2 `<details>` blocks; renumbered every A/B `<span class="num">` the same way as the markdown.
- Fixed the Group A/B header row counts (`<span class="gcount">`).
- Fixed the **`<table class="glance">`** row counts for A and B — this is the element `check:onbox-register` actually parses for the live view's glance table; it is a separate element from the `.strip`/`.stat` summary banner near the top, which was also updated (owed 69→66) but is not itself checked.
- Added E9's wave-5 step-3 note as a matching `<div class="flag">`.
- Removed the now-stale sentence in Group B's intro paragraph that described the old B2 (it referenced "rides the characterId-drift re-analysis," which described the discharged row, not the new B2).

## Per-feature run sheets

- **B2**: `cast-id-drift-onbox-acceptance.md` §7.7 got the addendum described above (its `Result:`-style narrative already covers this row's history; there is no separate blank `Result:` line specific to B2's own criteria in that file — it is a shared, prose-narrated run sheet across several rows).
- **A27 / A45**: no dedicated `docs/testing/<feature>-onbox-acceptance.md` file exists for either — both `qa.asr.model` and the `speaker-qa.txt` reqHash fix were tracked directly in the register plus the wave evidence files, with no separate per-feature run sheet ever created. Stating this explicitly rather than silently skipping the step.

## `npm run check:onbox-register`

First run (before fixing the live view's `<table class="glance">`) failed:

```
docs/testing/onbox-acceptance-register-live-view.html does not agree with docs/testing/onbox-acceptance-register.md:

- Live view: glance table says Group A has 46 rows, the register says 44.
- Live view: glance table says Group B has 3 rows, the register says 2.
```

That table (`<table class="glance">`, lines 282-293) is distinct from the `.strip`/`.stat` summary banner and from each group's `<span class="gcount">` — all three needed separate edits. After fixing it:

```
> castwright@1.14.0 check:onbox-register
> node scripts/check-onbox-register.mjs

check:onbox-register: OK — docs/testing/onbox-acceptance-register.md and docs/testing/onbox-acceptance-register-live-view.html agree.
```

## Release notes

**None.** This wave is register bookkeeping only — folding already-recorded acceptance verdicts into the tracked register and its live view. No shipped user-visible behaviour changed as part of this step. (Steps 1, 2 and 4 discharged rows by *observing* already-shipped behaviour on real hardware; they did not change that behaviour, so there is nothing here for a release note either.)

## Not done (explicitly out of scope)

- No acceptance row was run by this step.
- The live view was **not published** — publishing is a manual operator step, after merge, reusing the artifact URL already recorded in the register's own header. Only the tracked `.html` file was edited.
- No PR was opened — step 7 of the wave does that.
