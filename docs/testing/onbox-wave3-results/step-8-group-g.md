# Wave 3 step 8 — G1, G2

Issue: Castwright#2500 · Chain: Castwright#2497 step 8 of 10 · Plan of record: `docs/testing/onbox-wave3-plan.md` §4 (step 8)

Worktree: `wt-2497-onbox-wave3-run` @ `052a365c` (HEAD at run time, unchanged — no source diff, docs-only).

## Summary verdicts

| Row | Verdict | One-line why |
|---|---|---|
| G1 | **STILL OWED-blocked** — both distinct debts | PR #2488 has not merged and #2465 is still open; a live dispatch after #2235 was quarantined shows the exact silent-drop failure #2465 describes, in real time, not just in theory. |
| G2 | **STILL OWED** | No release has been cut since PR #2168 (the fix under test) merged; no opportunity to observe it has existed yet. |

---

## G1 · Quarantine-lane health report — first live dispatch (ops-32, [#1864](https://github.com/dudarenok-maker/Castwright/issues/1864), PR [#1873](https://github.com/dudarenok-maker/Castwright/pull/1873)) · **two distinct debts**

**Re-resolved 2026-08-20** against the register (`docs/testing/onbox-acceptance-register.md` L3313-3384) and the wave-3 plan's own G1 row (§4.6, §7). The register text itself is now stale on one point — it says "the flaky register carries one row today (#1981...)" — the live file has since grown a second, quarantined row. That staleness is exactly what this re-resolution catches below.

### PR #2488's live state (checked first, per the issue)

```
$ gh pr view 2488 --repo dudarenok-maker/Castwright --json number,title,state,mergedAt,url
{"mergedAt":null,"number":2488,"state":"OPEN",
 "title":"fix(scripts): parse the register's real test-cell format and fail loud on a silent zero",
 "url":"https://github.com/dudarenok-maker/Castwright/pull/2488"}

$ gh issue view 2465 --repo dudarenok-maker/Castwright --json number,title,state,closedAt
{"closedAt":null,"number":2465,"state":"OPEN",
 "title":"quarantine-health parseRegister drops every real register row, so the weekly cron is a permanent no-op"}
```

**Not merged; #2465 still open. G1 is STILL OWED-blocked on both debts**, per the plan's §7.

### Debt 1 — `gh issue view` under real `GH_TOKEN` — still unreachable, and now caught live

The live flaky register today:

```
$ cat docs/testing/flaky-register.md   # (relevant rows only)
| #1981 — a stale cast PUT does not erase a concurrently /assign-planted voice | ... | Not quarantined — still gates |
| #2235 — revokes the older same-format manifest when a re-export of the same format finishes | ... | Quarantined — routes through `quarantinedIt` (2026-08-13); runs only under `RUN_QUARANTINE=1` |
```

`#2235` has been a **real quarantined row** since 2026-08-13 (commit `6a45834b`, "fix(server): quarantine the flaky #2235 export revoke test"). The precondition the register calls "a real quarantined flaky test present in `docs/testing/flaky-register.md` at dispatch time" has therefore existed for a week.

Recent live dispatches of `.github/workflows/quarantine-health.yml`:

```
$ gh run list --repo dudarenok-maker/Castwright --workflow=quarantine-health.yml --limit 10 \
    --json databaseId,event,status,conclusion,createdAt,headSha
[{"conclusion":"success","createdAt":"2026-08-17T03:43:26Z","databaseId":31992063988,"event":"schedule","headSha":"1d9ea75c4f44f0f1884a9ea2119e9087b4e8956f"},
 {"conclusion":"success","createdAt":"2026-08-10T04:24:52Z","databaseId":31355401008,"event":"schedule","headSha":"a6e8454e8c8ca366963e68c3861f96885ea26aa8"},
 {"conclusion":"success","createdAt":"2026-08-03T06:14:03Z","databaseId":30789513665,"event":"schedule","headSha":"72fa4b58cbae77e02da2a36d00ef9c89659a7223"}]
```

**Exactly the trap this row's own text warns about.** The 2026-08-17 dispatch (`databaseId 31992063988`) ran off `head_sha 1d9ea75c4f44f0f1884a9ea2119e9087b4e8956f`, which is a **descendant** of the #2235 quarantine commit:

```
$ git merge-base --is-ancestor 6a45834b 1d9ea75c4f44f0f1884a9ea2119e9087b4e8956f && echo "IS ANCESTOR - fix present"
IS ANCESTOR - fix present
```

So a real quarantined row (`#2235`) was present in the checkout that dispatch ran against. Its job summary — the **report's actual content**, not the conclusion:

```
$ gh run view 31992063988 --repo dudarenok-maker/Castwright --log | grep -A2 "Quarantine lane health"
npm run quarantine:health  2026-08-17T03:44:11.0551160Z # Quarantine lane health report
npm run quarantine:health  2026-08-17T03:44:11.0551465Z
npm run quarantine:health  2026-08-17T03:44:11.0552389Z No quarantined tests are currently registered in `docs/testing/flaky-register.md` — nothing to run. Clean no-op.
```

**A green run is not evidence; the report's actual content is** — and the content is wrong. `conclusion: success` is masking a live quarantined row (`#2235`) that `parseRegister` silently dropped, which is #2465 manifesting in production, not a hypothetical. Because the run took the empty-register early-return path (`rows.length === 0` at `scripts/quarantine-health.mjs:776`), it never reached the post-loop `gh issue view` calls — that half of this debt is **still unexercised**, and cannot be exercised while the parser drops the only row that would reach it.

**Debt 1 verdict: STILL OWED.** Not because the precondition is missing — it isn't, and hasn't been for a week — but because #2465/PR #2488 makes every dispatch since 2026-08-13 an unreliable observation of it. The fix landing is what unblocks this, exactly as the plan says.

### Debt 2 — genuine `intermittent` classification on real cross-run nondeterminism

Same blocker. `#2235`'s row description ("intermittent under full-suite box contention... fails on its first attempt and passes on retry") is the right shape of test for this debt, and it has been quarantined since 2026-08-13 — but every scheduled dispatch since then has silently dropped it before `classifyEntry` ever sees it (same evidence as Debt 1: the 2026-08-17 run's clean-no-op summary). This debt shares Debt 1's precondition per the register's own text (L3360-3363) and remains unreachable for the identical reason.

**Debt 2 verdict: STILL OWED**, same grounds.

**Both debts recorded separately, per the issue's instruction — they are STILL OWED for the same root cause (PR #2488 unmerged) but were independently re-checked against live data, not assumed to share a fate.**

---

## G2 · The published release body now comes from the committed file, not the tag annotation ([#2137](https://github.com/dudarenok-maker/Castwright/issues/2137), PR [#2168](https://github.com/dudarenok-maker/Castwright/pull/2168))

**Re-resolved 2026-08-20** against the register (`docs/testing/onbox-acceptance-register.md` L3386-3401) and the plan's own G2 row (§4.6).

**When the fix under test actually landed:**

```
$ gh pr view 2168 --repo dudarenok-maker/Castwright --json state,mergedAt,title
{"mergedAt":"2026-08-06T07:46:44Z","state":"MERGED",
 "title":"fix(ops,scripts): publish the release body from the notes the release gate validated"}
```

**Releases cut since then:**

```
$ gh release list --repo dudarenok-maker/Castwright --limit 5
Castwright v1.14.0  Latest  v1.14.0  2026-07-23T22:53:38Z
Castwright v1.13.0          v1.13.0  2026-07-12T05:52:53Z
Castwright v1.12.3          v1.12.3  2026-07-11T06:07:37Z
Castwright v1.12.0          v1.12.0  2026-07-10T14:02:10Z
Castwright v1.11.0          v1.11.0  2026-07-08T14:59:16Z
```

`v1.14.0` — the latest and only candidate anywhere near the fix — was tagged **2026-07-23**, two weeks **before** PR #2168 merged (2026-08-06). Its published body was produced by the pre-fix `release.yml`, so it cannot exercise this row: reading its published body and diffing it against the committed notes file would test the old, already-known-broken path, not the fix. No tag has been pushed since the fix landed. **No release-cut opportunity to observe G2 has existed yet.**

**G2 verdict: STILL OWED.** Nothing to paste from a published body vs. committed file — there is no post-fix release to read. This is unchanged from the plan's own framing (opportunistic, no fixed unblock date) and is not something this chain should manufacture (box-safety: a false-positive here blocks a real release).

---

## Box-safety confirmation

- No sidecar venv anywhere on the box was touched — this step is read-only `gh`/`git` calls.
- No book data, server, sidecar, or model was touched, started, or stopped.
- No other lane's process was touched.
- No `--apply`/`--write`/`--fix` mode was exercised.
- No workflow was dispatched by this run — every run cited above (`31992063988`, `31355401008`, `30789513665`) was a pre-existing scheduled dispatch, read only. No minutes were spent triggering anything.
- No tag or release was pushed to manufacture G2's opportunity — box-safety forbids it and this row's own text says so.

## Re-resolution note

Dated **2026-08-20**. Both rows' owed text was re-read directly from `docs/testing/onbox-acceptance-register.md` at this worktree's current HEAD (`052a365c`), matching the wave-3 plan's own citations. **Nothing excluded** — G1's two debts are recorded separately per the issue's instruction; the live 2026-08-17 dispatch is new evidence beyond what the plan cited (which stopped at the 2026-08-10 run) and sharpens the verdict from "the fix will unblock this" to "the bug is actively dropping a real row today," without changing the STILL OWED-blocked verdict itself. G2's verdict is unchanged from the plan; the check now additionally confirms no post-fix release-cut opportunity has occurred.
