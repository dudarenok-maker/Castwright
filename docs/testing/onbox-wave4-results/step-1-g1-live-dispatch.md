# Step 1 — G1: live `quarantine-health.yml` dispatch

Issue: Castwright#2558 (wave 4 step 1 of #2551, campaign #2435).

## 1. Preconditions (checked before dispatch)

### `gh run list --workflow quarantine-health.yml` — newest run predates `ff4fec58`

```
$ gh run list --workflow quarantine-health.yml --repo dudarenok-maker/Castwright --limit 5
completed	success	Quarantine Lane Health	Quarantine Lane Health	main	schedule	31992063988	49s	2026-08-17T03:43:26Z
completed	success	Quarantine Lane Health	Quarantine Lane Health	main	schedule	31355401008	1m1s	2026-08-10T04:24:52Z
completed	success	Quarantine Lane Health	Quarantine Lane Health	main	schedule	30789513665	37s	2026-08-03T06:14:03Z
```

Newest run `31992063988` is 2026-08-17T03:43:26Z. PR #2488 merged `ff4fec58` at
2026-08-20T06:45:02Z. `31992063988` predates the merge by 3 days. Confirmed.

### `origin/main` contains `ff4fec58`

```
$ git fetch origin main
From https://github.com/dudarenok-maker/Castwright
 * branch              main       -> FETCH_HEAD
$ git merge-base --is-ancestor ff4fec58 origin/main && echo "CONTAINS ff4fec58"
CONTAINS ff4fec58
```

### `parseRegister` against the real register, run locally

```
$ node check-parseregister.mjs
[
  {
    "testName": "a stale cast PUT does not erase a concurrently /assign-planted voice",
    "file": "server/src/routes/book-state-preserve-voices.test.ts",
    "issueNumbers": [
      2226
    ]
  },
  {
    "testName": "revokes the older same-format manifest when a re-export of the same format finishes",
    "file": "server/src/routes/export.test.ts",
    "issueNumbers": [
      2235
    ]
  }
]
```

Non-empty (2 entries). Precondition satisfied — the fix is live and dispatching
now takes the non-empty path for the first time in this workflow's life.

## 2. Dispatch

```
$ gh workflow run quarantine-health.yml --repo dudarenok-maker/Castwright --ref main
https://github.com/dudarenok-maker/Castwright/actions/runs/32426439853
```

```
$ gh run view 32426439853 --repo dudarenok-maker/Castwright --json status,conclusion,event,createdAt
{"conclusion":"","createdAt":"2026-08-20T22:55:36Z","event":"workflow_dispatch","status":"queued"}
```

Run id: **32426439853**. `event: workflow_dispatch`. `createdAt` (2026-08-20T22:55:36Z)
is after the `ff4fec58` merge (2026-08-20T06:45:02Z) — post-fix run, confirmed
before reading results.

Watched to completion: `npm run quarantine:health` job finished in **1m1s**,
overall run **conclusion: success**.

## 3. Job summary and log — pasted evidence

Full log saved and grepped from `gh run view 32426439853 --log`. Relevant
excerpt (job `npm run quarantine:health`, step `Quarantine lane health report`):

```
2026-08-20T22:56:09.5248621Z npm run quarantine:health
2026-08-20T22:56:09.5284965Z env:
2026-08-20T22:56:09.5287822Z   GH_TOKEN: ***
2026-08-20T22:56:09.6683902Z quarantine-health: run 1/5
2026-08-20T22:56:15.1878256Z quarantine-health: run 2/5
2026-08-20T22:56:20.3980647Z quarantine-health: run 3/5
2026-08-20T22:56:25.7039598Z quarantine-health: run 4/5
2026-08-20T22:56:30.9520027Z quarantine-health: run 5/5
2026-08-20T22:56:36.8749675Z # Quarantine lane health report
2026-08-20T22:56:36.8750499Z Ran the quarantine lane 5 time(s). Bucket legend:
...
2026-08-20T22:56:36.8762085Z | Test | File | Bucket | Passed / found | Tracking issue | Issue state |
2026-08-20T22:56:36.8762889Z |------|------|--------|-----------------|-----------------|-------------|
2026-08-20T22:56:36.8764328Z | `a stale cast PUT does not erase a concurrently /assign-planted voice` | `server/src/routes/book-state-preserve-voices.test.ts` | always-passes | 5/5 | #2226 | CLOSED |
2026-08-20T22:56:36.8765761Z | `revokes the older same-format manifest when a re-export of the same format finishes` | `server/src/routes/export.test.ts` | always-passes | 5/5 | #2235 | CLOSED |
2026-08-20T22:56:36.8767840Z **2 row(s) cite a CLOSED tracking issue** — orphaned debt with no owner; see the table above.
```

## 4. Verdicts

### Debt 1 — did the run reach the `gh issue view` calls, and did they authenticate?

**DISCHARGED.** The report table's "Issue state" column shows `CLOSED` for
both `#2226` and `#2235` — a live value that can only come from a real,
authenticated `gh issue view` (or equivalent GH API) call per row (the script's
own doc comment on the `plan.outcome === 'empty'` branch confirms the prior
behaviour returned before this point was ever reached). `GH_TOKEN` was
injected into the step's env (masked as `***` in the log, standard Actions
behaviour) and the calls plainly succeeded — no auth error, no fallback
"unknown" state, a real per-issue value for both rows. This is the first
dispatch in the workflow's life to reach and execute this code path; every
prior real dispatch took the empty-register early return before these calls
existed to run.

### Debt 2 — which bucket did #2235 land in?

**STILL OWED.** Report table row: `#2235 | always-passes | 5/5 | CLOSED`. All
5 runs passed; no failure was observed. Per the acceptance criteria,
`always-passes` does **not** discharge the debt — it means this dispatch's 5
runs did not reproduce the full-suite-box-contention race the register
describes, not that the test isn't flaky. `unknown` was not the result
(5/5 usable runs, a real verdict was rendered), so this is a genuine
non-discharging outcome, not a runner failure. What would discharge it next
time: a dispatch whose 5 repeated runs of this quarantine lane produce a mix
of pass and fail for this specific test — i.e., an `intermittent` bucket.
Since the flakiness is described as contention-dependent, a dispatch that
happens to run concurrently with other load on the runner (or a future
change to the runner's repeat count/concurrency) is more likely to surface
it than a quiet run.

## 5. Stale prose noted (not edited — folded by step 6)

- `docs/testing/onbox-acceptance-register.md` G1, the paragraph preceding the
  wave-3 correction note, still reads "the flaky register carries one row
  today (`#1981`)" as background framing. The register in fact carries **two**
  rows today: `#1981` (tracking issue #2226, "Not quarantined — still gates")
  and `#2235` (tracking issue #2235, "Quarantined"). Wave-3's own correction
  note already flagged `#2235` as the newly-quarantined row on 2026-08-20, but
  the older "one row" framing above it was never corrected and is now doubly
  stale.
- New information this dispatch surfaced that the register text doesn't yet
  reflect: **both** tracking issues cited by the quarantine lane — `#2226` and
  `#2235` — are reported **CLOSED** by the live `gh issue view` calls, and the
  job summary itself flags this as "orphaned debt with no owner." Neither
  `flaky-register.md` nor the G1 acceptance-register row mentions this. This
  is new evidence for step 6 to fold, not something this step is scoped to
  act on (`docs/testing/flaky-register.md` edits are explicitly out of
  scope for this step).

## Acceptance checklist

- [x] Preconditions checked and pasted before dispatch, including a non-empty
      `parseRegister` return.
- [x] New run id `32426439853`, post-`ff4fec58` (`createdAt` 2026-08-20T22:55:36Z
      vs. merge 2026-08-20T06:45:02Z), `event: workflow_dispatch`.
- [x] Debt 1 and debt 2 each carry an independent verdict with pasted log
      evidence.
- [x] Debt 2 still owed — this section states precisely what would discharge
      it next time.
- [x] Nothing outside `docs/testing/onbox-wave4-results/` modified by this step.
