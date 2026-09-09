# Step 9 (final) — verify steps 1-8, fold the register, open the PR

Castwright#2954. Parent #2950, campaign #2435. Verifies steps 1-8's evidence
against the parent issue's own checks, folds each of the six register rows
individually, and records the register-arithmetic result.

## Verification

Step 1 (`step-1-a2.md`) read directly: real hardware evidence (curl transcripts,
`nvidia-smi` output before/during/after a concurrent fire), a clear verdict,
and an explicit accounting of what step 9's parenthetical (ASR/SPK on separate
cards) does not cover. Confirmed A2 discharges cleanly.

Steps 2-8 were independently audited by re-reading each evidence doc against
the parent issue's own per-check criteria, and — for step 3's mutation-test
claim specifically — by redoing the mutation myself (flipping the
card-specific vs. not-card-specific guard in `runAutoRevert`, confirming all
four paired tests redden, then reverting the source file exactly, leaving the
worktree clean). Verdicts:

| Check | Row | Verdict |
|---|---|---|
| 1 (step 1) | A2 | PASS — discharge |
| 2 (steps 2-4) | A3 | PARTIAL — checklist and built+tested task 16/16.5 both pass; the real-hardware trigger does not reach `runAutoRevert` in production (`start.ps1` absorbs the code-43 streak before Node's own supervisor observes three distinct exits) → **narrow, not discharge**, per the issue's own rule |
| 3 (step 5) | A12 | PASS as a narrowing — bullets 1/3/4 confirmed for real on both cards, bullet 2 (reboot-gated) correctly left untouched |
| 4 (step 6) | E7 | PASS — all four sub-checks (noop branch, self-heal at next boot, fresh Install `pip-in-place`, Qwen3 no `WinError 5`) confirmed for real → discharge |
| 5 (step 7) | E11 | PASS — genuine CRLF-mangled precondition, LF normalization confirmed, no spurious reinstall, fresh Install also normalizes → discharge |
| 6 (step 8) | A18 item 4 | PASS — `import torchcodec` run for real in the nested venv, outcome (success, CPU wheel) recorded as fact → discharge item 4 alone |
| 7 | register arithmetic | PASS — `npm run check:onbox-register` green after the fold |

## Fold applied (per row, individually)

- **A2** — DISCHARGED, row removed entirely. `docs/testing/onbox-acceptance-register.md`.
- **A3** — NARROWED. 9 of 10 checklist items and the build+tests confirmed;
  row narrows to the one remaining gap (wire the streak-trip signal through
  `start.ps1`'s own restart loop so `runAutoRevert` fires on real hardware).
- **A12** — NARROWED. Bullets 1/3/4 struck through as confirmed; bullet 2
  (enumeration-order swap) stays open, worded to explain the exclusion is
  contention risk against the box's other live lanes, not a hardware gap.
- **E7** — DISCHARGED, row removed entirely.
- **E11** — DISCHARGED, row removed entirely.
- **A18** — item 4 alone marked DISCHARGED with the recorded fact
  (`import torchcodec` succeeds, CPU wheel); items 1/3 untouched (already
  discharged 2026-07-31); item 2 untouched (still owed, unchanged wording).
  Row stays open (item 2 remains).

Both the "At a glance" table and the "Last change" log in
`onbox-acceptance-register.md` were updated by hand for the count deltas
(Group A 39→38, Group E 13→11, owed 65→62). The live-view HTML
(`onbox-acceptance-register-live-view.html`) was reconciled with
`npm run register:build` (which regenerates only the derived count regions
and row shells from the markdown — row body content for A3/A12/A18/A18-item-4
was hand-authored first, then the build script folded in the generated
figures around it) and verified green with `npm run check:onbox-register`.

A stale cross-reference in the Group E intro paragraph (`E1/E7/E9/E10/E11/…`
group list) was also corrected, since E7 and E11 no longer exist as rows.

## Not touched

No source code changed by this step — read-only verification and register
fold only, per the issue's own standing rules. The mutation-test re-run
(check 2 above) reverted its temporary source change before this step ended;
`git status` on the worktree is clean of any non-register change.
