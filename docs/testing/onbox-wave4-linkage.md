# Wave 4 step 5 — fix-chain → register-row linkage map

Written by wave 4 step 5 ([#2554](https://github.com/dudarenok-maker/Castwright/issues/2554)), part of the on-box register campaign (#2435, wave 4 = #2551). This is the recovery map for the cross-chain wiring that step 5 set up: if any automated flip below is missed, this table is how a human or a later agent finds the loose end without re-deriving the whole campaign from scratch.

> **Row IDs below are as-of wave 4 and have since renumbered.** Register IDs are
> positional: PR #2626 discharged rows and shifted the survivors, so `A39`,
> `A40`, `A41`, `B3`, `B4` and `E11` in the table below no longer name the rows
> they named when this map was written. They are deliberately left as written —
> this is a dated snapshot of the wiring, and rewriting it would falsify the
> record. **Resolve any row here by its subject, not its number**, against the
> current register.

**Read this together with `docs/testing/onbox-acceptance-register.md`** — the register rows are the source of truth for acceptance criteria; this document only tracks which issue does what and how the pieces connect.

## The wiring, defect by defect

| Defect | Chain (task → verify) | Verify child state at filing (2026-08-21) | Re-run child (new) | Register row(s) discharged | How the discharge lands |
|---|---|---|---|---|---|
| [#2533](https://github.com/dudarenok-maker/Castwright/issues/2533) — `GET /api/models/inventory`'s `installState` can't distinguish broken from missing | [#2549](https://github.com/dudarenok-maker/Castwright/issues/2549) task → [#2550](https://github.com/dudarenok-maker/Castwright/issues/2550) verify | Open, `Agent Waiting`, unclaimed | **none** — see below | *none* — A27 reads the finer `models-status.ts` endpoint, not this endpoint | n/a |
| [#2534](https://github.com/dudarenok-maker/Castwright/issues/2534) — `onnxruntime-gpu` 1.27 silently falls back to CPU on CUDA 12.4 | [#2547](https://github.com/dudarenok-maker/Castwright/issues/2547) task → [#2548](https://github.com/dudarenok-maker/Castwright/issues/2548) verify | Open, `Agent Waiting`, unclaimed | [#2568](https://github.com/dudarenok-maker/Castwright/issues/2568) — `Agent Waiting`, sub-issue of #2534 | **A39** (third check — Kokoro/`CUDAExecutionProvider`), **A40** (final check only, same GPU-provider sub-check) | #2548 carries a promotion section: on PASS + PR opened, flip #2568 to `Agent Todo` |
| [#2535](https://github.com/dudarenok-maker/Castwright/issues/2535) — a clobbered venv takes the silent `'deleted'` path, never logs `'clobbered'` | [#2544](https://github.com/dudarenok-maker/Castwright/issues/2544) + [#2545](https://github.com/dudarenok-maker/Castwright/issues/2545) tasks → [#2546](https://github.com/dudarenok-maker/Castwright/issues/2546) verify | Open, `Agent Waiting`, unclaimed | [#2569](https://github.com/dudarenok-maker/Castwright/issues/2569) — `Agent Waiting`, sub-issue of #2535 | **A41** | #2546 carries a promotion section: on PASS + PR opened, flip #2569 to `Agent Todo` |
| [#2536](https://github.com/dudarenok-maker/Castwright/issues/2536) — `merge-analysis-cast.ts` mints near-duplicate roster ids on name-token drift | [#2542](https://github.com/dudarenok-maker/Castwright/issues/2542) task (closed) → [#2543](https://github.com/dudarenok-maker/Castwright/issues/2543) verify | **Already closed** — verdict PASS, PR [#2562](https://github.com/dudarenok-maker/Castwright/pull/2562) opened (`fix/server-2536-surname-comparator` → `main`), not yet merged, at the time step 5 read it | [#2570](https://github.com/dudarenok-maker/Castwright/issues/2570) — `Agent Waiting`, sub-issue of #2536 | **B3**, **B4** | **Manual — see "The #2536 exception" below.** No promotion section exists on #2543; it was already closed before step 5 could edit it. |
| [#2537](https://github.com/dudarenok-maker/Castwright/issues/2537) — `alignSentences` breaks dash-invariance on real data | [#2540](https://github.com/dudarenok-maker/Castwright/issues/2540) task → [#2541](https://github.com/dudarenok-maker/Castwright/issues/2541) verify | Open, `Agent Waiting`, unclaimed | [#2571](https://github.com/dudarenok-maker/Castwright/issues/2571) — `Agent Waiting`, sub-issue of #2537 | **E11** item (2) only | #2541 carries a promotion section: on PASS + PR opened, flip #2571 to `Agent Todo` |

### #2533 gets no re-run child

Per step 5's own brief: #2533's chain (#2549/#2550) unblocks no register row — A27 reads the finer-grained `models-status.ts` endpoint, not the `installState` field #2533 is about. This is deliberate, not an oversight. #2550 was **not** edited with a promotion section, also deliberately — there is nothing for it to promote.

## The #2536 exception

Every other chain follows the intended mechanism: the verify child gets an appended "promote the on-box re-run" section, and whichever agent closes that verify child with a PASS is the one who flips the re-run child to `Agent Todo`, so the discharge rides the same PR as the fix.

**#2536's chain broke that mechanism by finishing first.** Its verify child #2543 ran, passed, opened PR #2562, and closed — all before wave 4 step 5 got to read the board. Step 5's own brief explicitly forbids editing a closed verify child's body (the same rule that protects a claimed or `Agent Working` verify child from a collision applies here: the issue is no longer "live" in a state where an edit is safe or meaningful). So #2543 carries no promotion section, and nothing will automatically flip #2570 to `Agent Todo`.

**What to do about it:** #2570 is filed correctly (Agent Waiting, sub-issue of #2536, full brief). Its trigger condition — verify PASSED, PR opened — is **already satisfied**. Whoever reads this document next (a human, the operator, or a later heartbeat doing cleanup) should:

1. Confirm PR #2562 is still open (or find out it merged — if it merged, #2570 can run immediately against `main` instead of the fix branch, and its brief should be read with that substitution in mind).
2. Flip #2570 to `Agent Todo` (`9d9fa565`) by hand:
   ```bash
   ITEM_ID=$(gh api graphql -F owner=dudarenok-maker -F repo=Castwright -F num=2570 -f query='
     query($owner:String!,$repo:String!,$num:Int!){ repository(owner:$owner,name:$repo){
       issue(number:$num){ projectItems(first:10){ nodes{ id } } } } }' \
     --jq '.data.repository.issue.projectItems.nodes[0].id')

   gh project item-edit --id "$ITEM_ID" --project-id PVT_kwHOEOX6_c4Bcf9a \
     --field-id PVTSSF_lAHOEOX6_c4Bcf9azhXISes --single-select-option-id 9d9fa565
   ```

Until that flip happens, B3 and B4 stay owed even though their fix has already landed in an open PR — the debt is real and correctly recorded as owed, not silently lost, but it will sit idle until someone (or something) does this one manual step.

## What happens if a fix lands without its re-run being promoted

For the four chains with a working promotion section (#2534, #2535, #2537's chains), the mechanism is self-contained: the verify child's own closing agent reads the promotion section and flips the re-run child. If that step is somehow skipped anyway (verify child closed by a run that didn't read its own body carefully, or a human closed it by hand outside the normal flow), the symptom is simple: the fix's PR is open or merged, but the corresponding re-run child (#2568, #2569, or #2571) is still sitting in `Agent Waiting`. The recovery is the same manual flip shown in the #2536 exception above, substituting the relevant issue number — the row stays honestly **STILL OWED** in the register in the meantime, which is the correct fail-closed state, not a silent loss.

## Rows this wave does not touch

- **A40 is not fully unblocked by #2534.** #2568 only re-runs A40's shared GPU-provider sub-check (Kokoro reporting `CUDAExecutionProvider`). A40's other, larger criterion — a real in-app click-through of Model Manager → Qwen → Install, confirming no `WinError 5` — is a separate operator row that needs a human at the actual app UI. It stays owed after #2534 closes, and is handed off to [#2561](https://github.com/dudarenok-maker/Castwright/issues/2561) per this issue's own successor chain, not to any re-run child filed here.
- **A42 and G2 both discharge at the next release cut**, not by any fix in this wave. A42 needs a real installed release directory (not a dev checkout) to exercise the in-app upgrade path; G2 is scoped to the next tagged release's published body. Neither is blocked by #2533–#2537, and neither gets a re-run child here.

## Summary of what step 5 filed

- Four re-run children: #2568 (A39 third check + A40 final check, sub-issue of #2534), #2569 (A41, sub-issue of #2535), #2570 (B3+B4, sub-issue of #2536), #2571 (E11 item 2, sub-issue of #2537). All `Agent Waiting` at filing.
- Three verify children amended with a promotion section: #2548, #2546, #2541. #2550 deliberately left untouched (#2533 unblocks no row). #2543 could not be amended — already closed before this step ran; see "The #2536 exception" above.
- No register file touched. No source file touched.
