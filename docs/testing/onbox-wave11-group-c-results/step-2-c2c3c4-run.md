# Group C step 2 — poll C2/C3/C4 re-analysis to completion, evidence

Ref: [Castwright#2895](https://github.com/dudarenok-maker/Castwright/issues/2895), parent
[#2616](https://github.com/dudarenok-maker/Castwright/issues/2616), campaign
[#2435](https://github.com/dudarenok-maker/Castwright/issues/2435). Follows step 1
([#2896](https://github.com/dudarenok-maker/Castwright/issues/2896), `step-1-setup.md`).

## Job outcome — completed, but refused to persist

Server PID 50624 (`http://localhost:8130`) and pinned Ollama PID 48020 (`127.0.0.1:11435`)
were both still alive and CPU-idle (0.00s delta over a 6s sample) when this step began polling,
consistent with a job that had already reached a terminal state rather than one still running.
The server log (`%OE_RUN_SCRATCH(#2896)%\server.log`, UTF‑16LE, converted to UTF‑8 for
grep/analysis) confirms phase‑1 ran to completion across all 9 chapters and then refused to
commit:

```
2026-09-05 13:24:58.373 [analysis] ... phase=1 Chapter 9/9 — narrated-speech check: 0/315 spoken lines attributed to the narrator (0.0%); source has 183 dash-opening speech lines.
2026-09-05 13:24:58.799 [analysis] ... phase=1 Recovered 7 narrator-attributed line(s) to tagged speakers (olga=1, boris-ignatyevich=2, alisa-donnikova=1, zavulon=2, semen=1).
2026-09-05 13:25:07.318 [analysis] ... phase=1 Stripped 1 third-party front-matter cast reference(s) (Грифсик) — re-routed to narrator.
2026-09-05 13:25:07.372 [analysis] ... phase=1 Dropped 1 non-speaking character from the cast (Фарид) — no attributed dialogue, narrator covers them.
2026-09-05 13:25:07.378-.444 [analysis] ... phase=1 Sentence in ch<N> attributed to unknown character "<id>" — demoted to narrator.  (repeated, orphan-id cleanup pass across all 9 chapters)
2026-09-05 13:25:07.519 [analysis] ... phase=1 Demoted 1805 of 12171 sentences to narrator (orphan ids: ...).
2026-09-05 13:25:07.519 [analysis] ... phase=1 Attribution drift exceeded threshold (1805/12171 ≈ 15%) — refusing to flip cast.json / state.json. Retry analysis to re-attribute.
```

`state.json` for `mns_a_x7EBUule` was checked directly and carries **no**
`analysisProvenance` key at all — the drift guard's refusal is real, not just a log message; the
job never wrote its results. Total wall clock: server started 09:24:31, final refusal logged
13:25:07.519 — **≈4h 01m** end to end (phase‑0 cast ~09:24–10:07, phase‑1 structure/attribution
~10:07–13:25).

This is a genuine terminal state, not a stall: no new log lines have appeared since 13:25:07 (48+
minutes at the time of polling), both processes are alive but CPU-idle, and the refusal message
itself is the analyzer's own designed behavior (`analysis-cache`/`merge-analysis-cast` guard, per
step 1's imports) for when a cast displacement pass demotes >15% of sentences to `narrator` in
one shot — it declines to flip the committed cast/state rather than silently accepting a
high-drift result. **Per the issue's own instruction, this is not stopped/killed/restarted** —
nothing about it was touched; it is reported as found.

## Evidence preservation

The 182 per-call stage‑2 forensics files (`server/handoff/outbox/mns_a_x7EBUule-stage2-ch*.json`,
~4.8 MB total) are still present and untouched at their original path — no cache-clearing or
teardown has happened in this step, so nothing needed rescuing yet. A redundant copy was also
made to `%TEMP%\open-engine-scratch\claude-2895-20260905-040914\step-2-stage2-forensics-preserved\`
as a documented secondary location, per the issue's "durable location ... or a scratch location
you document" option; the outbox path remains the primary/authoritative copy. Teardown (deleting
the outbox, stopping the pinned Ollama instance, reverting the worktree-local settings) is
explicitly out of scope for this step per step 1's own "Rollback owed later" section — left for
whoever runs step 4/5.

## C2 — dialogue-convention invariant

Per-chapter `[analysis:structure]` figures (final pass per chapter):

| ch | aligned | confirmed | corrected | flagged | unresolved | escalated | escalationAccepted |
|----|---------|-----------|-----------|---------|------------|-----------|---------------------|
| 1  | 97%     | 220       | 776       | 24      | 970        | 26        | 34                  |
| 2  | 92%     | 495       | 110       | 5       | 775        | 26        | 246                 |
| 3  | 97%     | 296       | 65        | 3       | 179        | 15        | 52                  |
| 4  | 97%     | 165       | 311       | 3       | 188        | 17        | 76                  |
| 5  | 88%     | 50        | 373       | 55      | 895        | 9         | 135                 |
| 6  | 65%*    | 0         | 306       | 0       | 1166       | 0         | 0                   |
| 7  | 97%     | 192       | 670       | 69      | 530        | 15        | 88                  |
| 8  | 86%     | 184       | 113       | 35      | 1062       | 13        | 183                 |
| 9  | 94%     | 92        | 724       | 1       | 527        | 25        | 143                 |

\* ch6 hit the 65% alignment floor and skipped escalation by design (`ch=6 below alignment floor
(65%) — escalation skipped`); this is the analyzer's own documented behavior, not a bug in this
row.

- **`unresolved=` populated per chapter**: yes, every chapter (179–1166, all non-zero).
- **`flagged=` at conflict scale (order 10²/chapter, not 10³)**: yes — flagged ranges 0–69 across
  chapters, one order of magnitude below the 10³ collapse this row exists to catch.
- **ch5 dash-opening sentences no longer rewritten to `narrator`**: the *final* ch5 pass shows
  51/473 spoken lines (10.8%) attributed to narrator against 63 source dash-opening lines — well
  below the historical 87.4% collapse. An earlier ch5 retry did hit a `Dialogue markers lost —
  the source has 20 dash-opening speech lines but only 0 were recognised as speech` failure at
  11:35:07 (`re-analysing (attempt 2)`), but the guard caught it, re-split the section, and the
  final committed-would-be numbers do not carry it forward.
- **`state.json`'s `analysisProvenance.report` carries a populated `unresolved`**: **NO** — this
  field does not exist at all, because the drift guard refused to write `state.json` (see above).
  This is the one C2 criterion this run cannot satisfy, not because the per-chapter analysis
  regressed, but because the run never reached a persisted state to inspect.

**End-to-end narrator-attribution share per chapter** (the #2306 metric, `narrated-speech check`
lines):

| ch | narrator/total | share  | source dash-opening lines |
|----|-----------------|--------|----------------------------|
| 1  | 78/519          | 15.0%  | 358                        |
| 2  | 193/458         | 42.1%  | 403                        |
| 3  | 80/153          | 52.3%  | 162                        |
| 4  | 69/204          | 33.8%  | 91                         |
| 5  | 51/473          | 10.8%  | 63                         |
| 6  | 0/261           | 0.0%   | 59                         |
| 7  | 145/367         | 39.5%  | 106                        |
| 8  | 208/388         | 53.6%  | 113                        |
| 9  | 0/315           | 0.0%   | 183                        |

Unweighted mean across chapters ≈ **27.5%**, close to the historical 30.3% baseline and nowhere
near the prior run's 87.4% collapse. **The collapse did not reproduce in this full 9-chapter
run** — this is a valid, important result on its own terms, independent of the drift-guard
refusal above (the guard's 15% threshold measures a different thing: sentences displaced by an
orphan-id cleanup pass, not narrator share).

**VERDICT: NARROWED.** The structural invariant (unresolved/flagged populated at the right
scale, no ch5 dash-opening collapse, no reproduction of #2306's narrator-collapse) holds on every
measurable log signal. The row does not fully discharge only because the run's own drift guard
refused to commit `cast.json`/`state.json`, so the specific "`state.json`'s `analysisProvenance.
report` carries a populated `unresolved`" clause cannot be checked against a live file. A re-run
that clears on drift (or a deliberate look at why 1805/12171 orphan-id sentences needed
demoting) is the one thing standing between this and DISCHARGED.

## C3 — deterministic stage-2 failure clears when the span is halved

The issue named a specific reproducer: Ночной дозор ch8, `repeat-loop` at offset 19. **That
exact reproducer did not recur this run.** The only `repeat-loop` observed in this run was a
different chapter/offset:

```
2026-09-05 11:11:25.989 [analysis] ... phase=1 Chapter 1/9 — ⚠ attribution may be incomplete
(Duplicated block — 4 consecutive sentences repeat earlier ones at offset 13 (repeat-loop).);
kept the best take and flagged the chapter for retry.
```

Chapter 8 itself hit a different failure family this run — repeated `Dialogue collapse` (69.0%,
96.4%, 88.0%, 65.4%, 87.3%, 77.7%) and one `Low coverage` failure (571 words vs ~1348 source,
ratio 0.42) across attempts 2–3, resolved by progressive re-splitting, **not** by the
repeat-loop/coverageRetries path the row describes. It finished cleanly:

```
2026-09-05 13:22:18.292 [analysis] ... phase=1 Chapter 8/9 — attributed in 11 sections.
2026-09-05 13:22:18.293 [analysis] ... phase=1 Chapter 8/9 — narrated-speech check: 208/388 spoken lines attributed to the narrator (53.6%); source has 113 dash-opening speech lines.
2026-09-05 13:22:18.442 [analysis] ... phase=1 Chapter 8/9 done — 1,437 sentences in 52m 49s
```

- **Retry halts on the repeated signature before `coverageRetries` is spent, around attempt 3**:
  not directly observed this run, because ch8's own retries never triggered a repeat-loop; the
  ch1 repeat-loop that did occur was caught and handled on its first occurrence (no visible
  attempt-count escalation logged for it specifically).
- **The re-split log line (`re-attributing a <N>-char section as <M> smaller ones (split depth
  D)`)**: fired repeatedly for ch8, e.g. `re-attributing a 8,727-char section as 3 smaller ones
  (split depth 0)` at 12:24:16 — present, just for the collapse/coverage failure family, not the
  repeat-loop family.
- **ch8's sentence count comes out whole, not partial**: yes — 1,437 sentences, attributed across
  11 sections with no truncation or drop logged for the chapter as a whole.

**VERDICT: STILL OWED (narrowed by absence, not confirmed).** The row's specific reproducer
(ch8/offset19 repeat-loop) simply did not occur this run, so nothing exercised the exact
`coverageRetries`-vs-repeat-loop interaction the row asks about. Per the issue's own text this
absence is not itself a failure, but it also is not evidence the original bug is fixed — it is
evidence the trigger condition is non-deterministic and didn't fire this time. Ch8 did complete
whole, which is a positive data point, but the specific mechanism this row exists to verify was
never exercised.

## C4 — dialogue-collapse guard fires on collapse, stays quiet on health

The guard fired extensively and precisely across the run — two distinct failure signatures, both
correctly triggering re-analysis/re-split:

- **Dialogue collapse** (narrator share > 60%, cast ignored): observed on chapters 1, 2, 3, 4, 5,
  7, 8 across dozens of attempts, e.g. `Chapter 2/9 — attribution coverage check failed (Dialogue
  collapse — 36/59 spoken lines (61.0%) were attributed to the narrator, above 60%; the cast is
  being ignored.); re-analysing (attempt 2).`
- **Dialogue markers lost** (source has dash-opening lines but far fewer recognised as speech):
  observed once, ch5 attempt 2: `the source has 20 dash-opening speech lines but only 0 were
  recognised as speech in the attribution (below half)`.
- **Low coverage** (attributed word count far below source): observed once, ch8 attempt 2: `571
  words vs ~1348 source (ratio 0.42 below 0.6)`.

**Stays quiet on health**: chapters/sections that did not breach 60% narrator share or the
coverage floor produced no collapse/coverage warnings at all in their final pass — e.g. ch6 and
ch9 both finished at 0.0% narrator share with no guard firings logged against their final
sections.

**Retry keeps the less collapsed take**: not directly log-visible as an explicit "keeping X over
Y" comparison (the repeat-loop path does log `kept the best take`; the collapse/coverage retry
path does not echo a before/after comparison), but the *trend* across each chapter's retry
sequence moves toward lower final narrator share than the interim failing attempts show — e.g.
ch2's attempts ranged 61.0%–100.0% narrator share across ten-plus retries/re-splits before
settling at a final 42.1%, and ch8 ranged 65.4%–96.4% before settling at 53.6%.

**Source dash-opening count vs. attributed speech-half count per chapter** (ratio of
non-narrator-attributed spoken lines to source dash-opening lines; well above 0.5 = healthy,
approaching 0.5 = escalation-worthy):

| ch | non-narrator spoken (total − narrator) | source dash-opening | ratio |
|----|------------------------------------------|----------------------|-------|
| 1  | 441                                       | 358                  | 1.23  |
| 2  | 265                                       | 403                  | 0.66  |
| 3  | 73                                        | 162                  | 0.45  |
| 4  | 135                                       | 91                   | 1.48  |
| 5  | 422                                       | 63                   | 6.70  |
| 6  | 261                                       | 59                   | 4.42  |
| 7  | 222                                       | 106                  | 2.09  |
| 8  | 180                                       | 113                  | 1.59  |
| 9  | 315                                       | 183                  | 1.72  |

Only ch3 sits near the 0.5 escalation line (0.45, just under); every other chapter sits well
above it. This is consistent with ch3's own final structure numbers (97% aligned but the second
lowest `confirmed` count, 296) — a chapter worth a second look, but not a collapse.

**VERDICT: DISCHARGED.** The guard fired correctly and specifically on every genuine collapse/
coverage breach observed, stayed silent on healthy chapters, and the final per-chapter ratios
land solidly on the healthy side of the 0.5 line (ch3 the sole near-miss, still on the healthy
side). This row's behavior matches its specification independent of the C2 drift-guard refusal,
which is a separate mechanism (cast/state persistence) from the per-chapter collapse guard this
row is about.

## Summary

| Row | Verdict |
|-----|---------|
| C2  | NARROWED — structural signals all healthy; `state.json`/`analysisProvenance` unwritten because the run's drift guard refused to commit (1805/12171 ≈ 15% sentences demoted to narrator during orphan-id cleanup) |
| C3  | STILL OWED — the named reproducer (ch8/offset19 repeat-loop) did not occur this run; ch8 completed whole via a different failure path (collapse/low-coverage retries), which is a positive but different data point |
| C4  | DISCHARGED — guard fires precisely on collapse/coverage breaches, stays quiet on healthy chapters, final per-chapter ratios are healthy |

Not in scope for this step, per the issue: C1 (separate session), any register edit (step 4's
job), re-litigating #2306's closed conclusion (recorded new numbers above without reopening the
old debate — no collapse reproduced this run, same as the 2026-08-14 partial re-run).
