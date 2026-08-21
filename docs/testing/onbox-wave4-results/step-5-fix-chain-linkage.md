# Wave 4 step 5 evidence — wiring the fix-blocked rows into their fix chains

Issue: [#2554](https://github.com/dudarenok-maker/Castwright/issues/2554). Track B of wave 4 (#2551), on-box register campaign #2435.

## Re-verification of the five chains, before any edit

Per the brief's own requirement to re-check every number and status before touching anything. Pasted real command output below, run 2026-08-21 immediately after claiming #2554.

### Defect parents — all still open

```
$ gh api graphql -f query='{ repository(owner:"dudarenok-maker", name:"Castwright") {
  d2533: issue(number:2533){ number state }
  d2534: issue(number:2534){ number state }
  d2535: issue(number:2535){ number state }
  d2536: issue(number:2536){ number state }
  d2537: issue(number:2537){ number state } } }'
{"data":{"repository":{
  "d2533":{"number":2533,"state":"OPEN"},
  "d2534":{"number":2534,"state":"OPEN"},
  "d2535":{"number":2535,"state":"OPEN"},
  "d2536":{"number":2536,"state":"OPEN"},
  "d2537":{"number":2537,"state":"OPEN"}}}}
```

### Task children

```
$ gh api graphql -f query='{ repository(owner:"dudarenok-maker", name:"Castwright") {
  t2549: issue(number:2549){ number state title }
  t2547: issue(number:2547){ number state title }
  t2544: issue(number:2544){ number state title }
  t2545: issue(number:2545){ number state title }
  t2542: issue(number:2542){ number state title }
  t2540: issue(number:2540){ number state title } } }'
{"data":{"repository":{
  "t2549":{"number":2549,"state":"OPEN","title":"...add packageFault to GET /api/models/inventory items"},
  "t2547":{"number":2547,"state":"OPEN","title":"...re-pin onnxruntime-gpu to a CUDA-12-built version"},
  "t2544":{"number":2544,"state":"OPEN","title":"...log ORT marker deletion on the silent path"},
  "t2545":{"number":2545,"state":"OPEN","title":"...correct the A41 clobbered-venv manufacture recipe"},
  "t2542":{"number":2542,"state":"CLOSED","title":"...add surname-tolerant name comparator to merge-analysis-cast"},
  "t2540":{"number":2540,"state":"OPEN","title":"...make alignSentences needle-search dash-invariant"}}}}
```

### Verify children — state + board Status

```
$ gh api repos/dudarenok-maker/Castwright/issues/2550 --jq '{number,title,state,assignees:[.assignees[].login]}'
{"assignees":[],"number":2550,"state":"open","title":"...add packageFault to GET /api/models/inventory items"}
$ gh api repos/dudarenok-maker/Castwright/issues/2548 --jq '{number,title,state,assignees:[.assignees[].login]}'
{"assignees":[],"number":2548,"state":"open","title":"...re-pin onnxruntime-gpu to a CUDA-12-built version"}
$ gh api repos/dudarenok-maker/Castwright/issues/2546 --jq '{number,title,state,assignees:[.assignees[].login]}'
{"assignees":[],"number":2546,"state":"open","title":"...ORT marker deletion logging + A41 recipe fix"}
$ gh api repos/dudarenok-maker/Castwright/issues/2543 --jq '{number,title,state,assignees:[.assignees[].login]}'
{"assignees":["dudarenok-maker"],"number":2543,"state":"closed","title":"...add surname-tolerant name comparator to merge-analysis-cast"}
$ gh api repos/dudarenok-maker/Castwright/issues/2541 --jq '{number,title,state,assignees:[.assignees[].login]}'
{"assignees":[],"number":2541,"state":"open","title":"...make alignSentences needle-search dash-invariant"}

$ gh api graphql -f query='{ repository(owner:"dudarenok-maker", name:"Castwright") {
  v2550: issue(number:2550){ projectItems(first:5){nodes{fieldValueByName(name:"Status"){ ... on ProjectV2ItemFieldSingleSelectValue { name } }}}}
  v2548: issue(number:2548){ projectItems(first:5){nodes{fieldValueByName(name:"Status"){ ... on ProjectV2ItemFieldSingleSelectValue { name } }}}}
  v2546: issue(number:2546){ projectItems(first:5){nodes{fieldValueByName(name:"Status"){ ... on ProjectV2ItemFieldSingleSelectValue { name } }}}}
  v2541: issue(number:2541){ projectItems(first:5){nodes{fieldValueByName(name:"Status"){ ... on ProjectV2ItemFieldSingleSelectValue { name } }}}} } }'
{"data":{"repository":{
  "v2550":{"projectItems":{"nodes":[{"fieldValueByName":{"name":"Agent Waiting"}}]}},
  "v2548":{"projectItems":{"nodes":[{"fieldValueByName":{"name":"Agent Waiting"}}]}},
  "v2546":{"projectItems":{"nodes":[{"fieldValueByName":{"name":"Agent Waiting"}}]}},
  "v2541":{"projectItems":{"nodes":[{"fieldValueByName":{"name":"Agent Waiting"}}]}}}}}
```

**Finding: #2543 (the #2536 chain's verify child) was already closed** — verdict PASS, PR #2562 opened against `fix/server-2536-surname-comparator`, not merged. Confirmed via its own AGENT DONE comment (2026-08-20T23:23:00Z) and timeline (`closed`, `state_reason: completed`, 2026-08-20T23:22:43Z). All four other verify children (#2550, #2548, #2546, #2541) are open, unclaimed, `Agent Waiting` — safe to edit per the brief's own rule.

## Actions taken

### 1. Filed four re-run children

| New issue | Sub-issue of | Board Status set |
|---|---|---|
| [#2568](https://github.com/dudarenok-maker/Castwright/issues/2568) — on-box re-run: A39, A40 after #2534 lands | #2534 | Agent Waiting (`9124b538`) |
| [#2569](https://github.com/dudarenok-maker/Castwright/issues/2569) — on-box re-run: A41 after #2535 lands | #2535 | Agent Waiting |
| [#2570](https://github.com/dudarenok-maker/Castwright/issues/2570) — on-box re-run: B3, B4 after #2536 lands | #2536 | Agent Waiting |
| [#2571](https://github.com/dudarenok-maker/Castwright/issues/2571) — on-box re-run: E11 after #2537 lands | #2537 | Agent Waiting |

#2533 deliberately got no re-run child (unblocks no register row; A27 reads the separate `models-status.ts` endpoint).

Each carries: which row(s) it discharges (cited from the register, not restated), which fix-chain branch to work on (found via `git worktree list`, not hard-coded), the "do not start until the verify child promotes you" gate, the rebase-before-edit + recompute-the-owed-total instructions, the fail-closed governing rule, and the standard box-safety block.

### 2. Appended promotion sections

- [#2548](https://github.com/dudarenok-maker/Castwright/issues/2548) (#2534's verify) — appended, points at #2568.
- [#2546](https://github.com/dudarenok-maker/Castwright/issues/2546) (#2535's verify) — appended, points at #2569.
- [#2541](https://github.com/dudarenok-maker/Castwright/issues/2541) (#2537's verify) — appended, points at #2571.
- [#2550](https://github.com/dudarenok-maker/Castwright/issues/2550) (#2533's verify) — **deliberately untouched**, no row to promote.
- [#2543](https://github.com/dudarenok-maker/Castwright/issues/2543) (#2536's verify) — **could not be edited, already closed.** Recorded in `docs/testing/onbox-wave4-linkage.md` under "The #2536 exception": #2570 is filed and ready (trigger condition — PASS + PR open — already true), but nothing will auto-promote it; needs a manual `gh project item-edit` flip once PR #2562's state is reconfirmed. Command given in the linkage doc.

Each append used `gh api ... --jq '.body'` to fetch the current body then `gh api --method PATCH ... -f body=@file` to write the appended version — no existing text was rewritten, only appended.

### 3. Wrote `docs/testing/onbox-wave4-linkage.md`

Full defect → chain → verify child → re-run child → register row(s) table, the #2536 exception explained in full, what happens if a promotion is missed on any of the other three chains, and the two rows this wave does not touch (A40's remaining check, A42, G2).

## What this step did not do

- No register file (`onbox-acceptance-register.md` or any `onbox-sitting-*.md`) touched.
- No source file touched.
- No fix implemented, reviewed, or altered.
- No child in `Agent Working` edited.
- Nothing promoted to `Agent Todo` — every new child starts `Agent Waiting`, per scope. #2570's eligibility for a manual promotion is recorded, not acted on, in the linkage doc.
