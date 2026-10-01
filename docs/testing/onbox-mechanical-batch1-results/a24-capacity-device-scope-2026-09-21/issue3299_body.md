## What

Drive the real on-box observation for register row **A24**
(`docs/testing/onbox-acceptance-register.md:3558-3717`), then record the result back
into the register at that same location.

ONLY bullet 5 (added post-#2678/PR #2797, needs the 2-card boot): repeat the design-wins-contention scenario with the resident VoiceDesign on ONE card and the denied Base 0.6B render on a DIFFERENT card. Confirm the wait extension does NOT fire cross-device (PR #2797's deviceKey-qualified fix) -- the render should fail/retry on its own card's ordinary timeline, not wait out the ~200s design budget for a design it can never be unblocked by. The most recent note (2026-09-06/09) confirmed this only via capacity-retry.test.ts (26 tests), NOT via a live squeeze, because this box's asymmetric card sizes were deemed impractical to force live at that time -- attempt the live squeeze now while both cards are present; if it is still genuinely impractical, record exactly why (a valid, recorded negative result, not a failure to attempt). Every OTHER bullet on this row (1-4, 6, and the still-owed wedged-design bullet 3) is OUT OF SCOPE for this child -- those are single-card and covered by a different child if at all.

## Background you need

- **Read lines 3558-3717 of `docs/testing/onbox-acceptance-register.md` in full before
  doing anything.** That text is the complete, authoritative spec for this row — the
  header, prior partial-run history, what is already confirmed, and exactly what remains
  open. Do not re-attempt anything an existing note already marks CONFIRMED / PASS /
  DISCHARGED — do the specific remaining gap only, per the "What" section above.
- This row's own stated prerequisites (\*Needs:\*/\*Criteria:\*/\*Cost:\* line from the
  register): a live sidecar with Qwen VoiceDesign installed on TWO cards
- Context flag: 2-card

## The approach

1. Read the full row (lines 3558-3717).
2. Confirm your understanding of the remaining gap matches the "What" section above (the
   register may have moved since this brief was written — trust the committed file, not
   this brief, if they disagree, and note the discrepancy in your commit).
3. If the remaining gap needs a **human decision** (more than one defensible fix/behaviour)
   or a **human ear** (an audio judgment only a person can make) — both cases occur in this
   batch and are called out explicitly in "What" where they do — do NOT attempt that part
   yourself. Record it plainly in the register note instead (name the decision, or name the
   exact files/timestamps queued for a listen), file a tracking issue if one doesn't already
   exist, and stop there.
4. Otherwise, drive the real scenario on this box per the row's own steps.
5. Record the observed result — real numbers, real log lines, pass/fail, with evidence —
   directly into the register at row A24's location, as a new dated blockquote note
   (`> **2026-09-20 — ...**`) appended after the existing ones, in the same style already
   used throughout the file. Do not delete or rewrite prior notes.
6. If the observation shows a real, reproducing defect (not just an unmet-but-expected
   bar), do not fix it — file a bug/chore issue per CLAUDE.md's incidental-findings
   protocol and cite it in your register note.

## Where the work happens

- Worktree: `C:\Claude\Projects\wt-onbox-batch-1`
- Branch: `chore/ops-onbox-batch-1`
- **Do not create another worktree and do not work in the primary checkout**
  (`C:\Claude\Projects\Audiobook-Generator`). If this is the first child in the chain to
  run and the worktree does not exist yet, create it yourself first, from the primary
  checkout: `node scripts/wt-new.mjs chore/ops-onbox-batch-1`. Then `cd` into `C:\Claude\Projects\wt-onbox-batch-1` for
  everything else. If it already exists (an earlier child created it), just `cd` into it
  — do not recreate it.
- Commit your register edit on this branch. **Do not open a PR** — the final
  `[claude][verify]` child opens the one PR for this whole parent.

## Acceptance

- The remaining gap named in "What" above has been driven for real, OR (if it needed a
  human decision/listen) that has been named and recorded/filed, not silently skipped.
- `docs/testing/onbox-acceptance-register.md` row A24 carries a new, dated blockquote
  note with the observed result or the recorded hand-off.
- No other row in the register changed.
- Your commit lands on branch `chore/ops-onbox-batch-1` in the shared worktree above.

## Key files

- `docs/testing/onbox-acceptance-register.md:3558-3717` (row A24)
- server/src/gpu/capacity-retry.ts, server/tts-sidecar/main.py (_DESIGN_CONTENTION_WAIT_S_DEFAULT)

## Not in scope

- Every OTHER row in the register — do not touch any row besides A24.
- Fixing any code defect you find — file it per CLAUDE.md's incidental-findings protocol
  instead (fresh issue, labelled per CLAUDE.md), and cite the filed issue in your register
  note. This parent's children read and record; a separate fix-agent round handles fixes.
- Opening a PR.

## Commit gate — read before your first commit or push

The commit gate changed 2026-09-05 (Castwright#2997): `pre-commit` now lints only staged
files (near-instant) and `pre-push` runs its two guards plus `test:sidecar`
(scope-gated to `server/tts-sidecar/**`, ~6.85 min when that path is in scope, near-zero
otherwise). **Never run `git commit` or `git push` detached or backgrounded unless this
section tells you to** — every lane runtime kills a single foreground command at 30
seconds, and this repo's commit/push now normally complete well inside that. If your diff
touches `server/tts-sidecar/**`, the **push** step can take up to ~6.85 min — launch that
push detached and poll for it; every other commit/push in this chain runs in the
foreground normally. Never use `--no-verify`.

## On completion — enable the next step yourself

1. Flip the NEXT child to **Agent Todo** (option ID `9d9fa565`, never `9124b538`):

```
gh api graphql -F owner=dudarenok-maker -F repo=Castwright -F num=3300 -f query='
  query($owner:String!,$repo:String!,$num:Int!){ repository(owner:$owner,name:$repo){
    issue(number:$num){ projectItems(first:10){ nodes{ id } } } } }' \
  --jq '.data.repository.issue.projectItems.nodes[0].id'

gh project item-edit --id <ITEM_ID> --project-id PVT_kwHOEOX6_c4Bcf9a \
  --field-id PVTSSF_lAHOEOX6_c4Bcf9azhXISes --single-select-option-id 9d9fa565
```

2. Post a comment `AGENT DONE` on THIS issue summarizing what you observed and recorded
   (or what you handed off, and to whom/where).
3. Close this issue.

**Order matters: flip the successor FIRST, then post AGENT DONE, then close** — a crash
between steps then leaves the queue able to continue instead of stalled.

