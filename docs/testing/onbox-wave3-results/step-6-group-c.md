# Wave 3 step 6 — Group C, one *Ночной дозор* re-analysis session (C1, C2, C3, C4)

Issue: Castwright#2502 · Chain: Castwright#2497 step 6 of 10 · Plan of record: `docs/testing/onbox-wave3-plan.md` §4 (step 6), §6 (the #2288 hold)

Worktree: `wt-2497-onbox-wave3-run` @ `2efa8c1c` (HEAD at run time, unchanged — no source diff, docs-only). No analysis session was started this pass — see below.

## GPU contention check (before starting)

```
$ nvidia-smi
GPU 0  NVIDIA GeForce RTX 4070 ...   697MiB /  8188MiB   0% util
GPU 1  NVIDIA GeForce RTX 5070 Ti    209MiB / 16303MiB   0% util
```
Both cards idle (no resident Ollama model, no other lane's generation in progress). GPU was **not** the blocker for this pass.

## Summary verdicts

| Row | Verdict | One-line why |
|---|---|---|
| C1 | **STILL OWED** | Blocked on a genuinely missing credential: this worktree's `server/.env` has no `GEMINI_API_KEY`. The primary checkout's `server/.env` was **not** read, copied, or otherwise consulted for its value — per the issue's own instruction and the #2345 secret-leak precedent, that channel is forbidden, and no other channel (process env, secrets store) made the key available. |
| C2 | **STILL OWED-blocked** | The register's own hold (L2638-2642) names #2288 as the blocker for the full local re-run; live check today confirms #2288 is still OPEN. |
| C3 | **STILL OWED-blocked** | Rides C2's session (register L2826-2829); same block. |
| C4 | **STILL OWED-blocked** | "Best taken in the same session as C2/C3" (register L2844); same block. |

**No analysis session — cloud or local — was run this pass.** All four rows are blocked on preconditions this worktree does not control (a credential deliberately withheld from this worktree, and an open upstream issue), not on anything this step could have worked around. This is the outcome the wave-3 plan itself anticipated for step 6 given the live #2288 state (§6, §8) — the plan explicitly says step 6 "records blocked state... rather than [failing]" is the correct shape for step 8's analogous case, and the same principle applies here: recording an honest block is not a failure to run the step.

---

## C1 · Free-tier Gemma cloud pass completes end to end ([#1685](https://github.com/dudarenok-maker/Castwright/issues/1685)) — STILL OWED

**Re-resolved 2026-08-20** against the register (`docs/testing/onbox-acceptance-register.md` L2679-2734) and the wave-3 plan's own C1 row (L51). Nothing in either doc has changed since the plan's 2026-08-20 re-derivation; this is the same-day re-check the issue asks for, run again independently.

**Blocker — missing `GEMINI_API_KEY` in this worktree:**

```
$ grep -n "GEMINI_API_KEY\|GEMINI_MODEL" server/.env
# no GEMINI_API_KEY, no secrets, nothing.
$ env | grep -i GEMINI
(no match)
```

The register's own text (L2706-2707) says the key is "already configured in `server/.env` — a credential this run exercises, not a blocker" — but that is true of the **primary checkout's** `server/.env`, not this worktree's isolated copy, which deliberately carries no secrets (its own header line says so). The parent issue is explicit that the fix for this is **not** to copy the primary checkout's `server/.env` into this worktree (a named secret-leak shape, #2345) — so the correct, honest outcome when no other channel supplies the key is to record C1 as STILL OWED naming the missing credential, which is what this does.

**No other channel was checked-and-found**: the shell's own environment carries no `GEMINI_*` variable either (checked above), and no secrets-manager or vault integration exists in this repo to query. This confirms, independently, the same blocker `docs/testing/onbox-wave3-results/step-5-group-b.md` already recorded for B1's step 1 (same missing key, different row) — consistent, not coincidental: this worktree was provisioned once, without the key, for every step in this chain.

**Nothing excluded.** The row's full remaining scope (re-analyze `gemma-4-31b-it` end to end including the script-review pass, confirm completion with no dropped chapters/no hang under real throttling, doubling as the cloud arm of #2306's A/B) is unchanged from the register and the plan — none of it was narrowed or dropped by this re-resolution; it simply could not be started.

**Explicit statement per the issue's acceptance criteria:** the primary checkout's `server/.env` was **not** read, opened, or copied at any point in this pass.

---

## C2 · Dialogue-convention invariant end to end ([#2253](https://github.com/dudarenok-maker/Castwright/issues/2253)) — STILL OWED-blocked

**Re-resolved 2026-08-20** against the register (L2736-2777) and the plan's §6 dependency analysis (L346-374). The register's Group C header (L2638-2642) states, verbatim:

> "Hold the full 12-hour re-run — the in-flight speaker-separation work (#2288, #2279) changes dialogue segmentation, so a pass taken before it lands measures a moving target and has to be repeated. Wait for it, then take C2 and C3 in one session."

**Live re-check today, not trusted from the plan's own 2026-08-20 timestamp alone** (the plan and this issue were both dated the same day, so this is an independent same-day confirmation, not a re-use of a stale number):

```
$ gh api repos/dudarenok-maker/Castwright/issues/2288 --jq '{number,title,state,closed_at}'
{"closed_at":null,"number":2288,"state":"open",
 "title":"srv — findQuoteRuns lets a gap-seeded quote run swallow the next dialogue turn (blocks all quotePairs widening)"}
```

**#2288 is still OPEN.** The hold is still in effect. C2's remaining scope (re-run Ночной дозор, confirm `unresolved=` populated and `flagged=` at conflict scale in `[analysis:structure]` logs, ch5 dash-opening sentences no longer rewritten to `narrator`, `state.json`'s `analysisProvenance.report.unresolved` populated) is unchanged and was not attempted — starting the 12h27m-class local re-run now would measure a moving target per the register's own reasoning, exactly the outcome the hold exists to prevent.

**Nothing excluded.** No part of C2's remaining criteria was narrowed, dropped, or substituted.

---

## C3 · A deterministic stage-2 failure actually clears when the span is halved ([#2304](https://github.com/dudarenok-maker/Castwright/issues/2304)) — STILL OWED-blocked

**Re-resolved 2026-08-20** against the register (L2779-2829). C3 "batches with the C2 re-run... this row needs no session of its own" (L2826-2829) — it rides the same local Ollama re-analysis of Ночной дозор that C2 needs, so it is blocked by the same #2288 hold confirmed live above, not by any prerequisite of its own.

The reproducer (ch8, `repeat-loop` at offset 19) and the specific log-line criteria (retry halting on the repeated signature by attempt 3, the `re-attributing a <N>-char section` line, ch8's sentence count coming out whole) are unchanged from the register and were not exercised — no re-analysis ran.

**Nothing excluded.**

---

## C4 · The dialogue-collapse guard fires on a real collapse and stays quiet on a healthy book ([#2325](https://github.com/dudarenok-maker/Castwright/issues/2325), [#2342](https://github.com/dudarenok-maker/Castwright/issues/2342)) — STILL OWED-blocked

**Re-resolved 2026-08-20** against the register (L2833-2848). "Best taken in the same session as C2/C3 rather than as its own long run" (L2844) — same block.

Both halves of this row's criterion remain unexercised, and are recorded here as **two separate, still-owed observations** exactly as the issue requires (a guard is only proven by both):

- **Collapse case (fires on a real collapse):** not observed this pass — needs the same blocked local re-analysis session, on the currently-collapsed `en`-language import or a fresh throwaway import exhibiting the collapse.
- **Healthy-book case (stays quiet on a healthy book):** not observed this pass — same blocker. The register's own text (L2835) additionally notes only **one** cached analysis on this box currently has an evaluable speech population for this metric (4,240 speech halves), so even once #2288 clears, this half may need a second Cyrillic (or other dash-convention) book imported — flagged here as a re-resolution note, not acted on (out of scope: "editing the register").

**Nothing excluded.**

---

## Session statement (issue acceptance requirement)

**No session ran.** Book, engine, and analysis-run identity therefore do not apply to any of C1-C4 this pass: C1 was blocked before any cloud call was made (missing credential), and C2/C3/C4 were blocked before any local re-analysis was started (#2288 open). This satisfies the issue's "session is stated" requirement by stating, accurately, that there is no session to report — a fabricated or partial session would misstate what happened.

## Box-safety confirmation

- GPU: checked idle before starting (above), never engaged, left exactly as found.
- No server, sidecar, or model was started, stopped, or evicted.
- No other lane's process was touched.
- Primary checkout `server/.env` was not read or copied (C1, above).
- No real book data was mutated (no analysis ran at all).
- `server/handoff/outbox/*-stage2-ch*.json` preservation note (register L2674-2677) does not apply — no run produced any such files this pass.

## Re-resolution note

Dated **2026-08-20**. All four rows' owed text was re-read directly from `docs/testing/onbox-acceptance-register.md` at this worktree's current HEAD (`2efa8c1c`), and both live blockers (`GEMINI_API_KEY` absence, `#2288` open state) were independently re-checked today rather than trusted from the wave-3 plan's same-day citations. **Nothing excluded** — no row's remaining scope was narrowed, reassigned, or dropped by this pass; both blockers are exactly what the register and the plan already named, confirmed still live.
