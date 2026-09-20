# Castwright#3339 — measuring `transcript_path` extraction feasibility (#3263 direction A)

Empirical findings only. No guard change, no fix, and — per the ticket's own
Output section — **no design recommendation anywhere in this doc**: the
Conclusion states what the numbers are and explicitly declines to choose.
Per the #3246/#3325/#3333 precedent no regression test accompanies this spike,
and that omission is stated explicitly here.

This is the third child of #3263's chain. Its two predecessors each settled one
half of the surrounding question and left this one open:

- `docs/ops/3263-guard-assignment-signal-findings.md` (#3325) — what a
  `PreToolUse` hook can see, and whether the assigned worktree is independently
  identifiable at that boundary. It reported `transcript_path` as *present in
  every payload and readable at hook-fire time* (its Finding 4), then
  explicitly built nothing on it.
- `docs/ops/3263-dispatch-cwd-findings.md` (#3333) — whether a dispatch can be
  aimed at a coordinator-chosen existing worktree. Verdict: the mechanism
  exists (`isolation: "worktree"`) but its one knob is binary, not a path.

#3339 asks whether the assigned root can be **extracted from the transcript
contents** instead. Three questions, answered separately below — Q3 is a
different property from Q2 and is not merged into it:

- **Q1** — is the originating instruction (the turn that names the assignment)
  reliably findable in a transcript, and what distinguishes it from later
  turns? Answer: Finding 1.
- **Q2** — can an extraction heuristic correctly pick the assigned path out of
  the paths a transcript mentions? Answer: Finding 2, with hit/miss per
  transcript.
- **Q3** — is the assigned root always *among* the mentioned roots, and how many
  *other* known checkout roots are also mentioned? Answer: Finding 3.

Every claim below is labelled **observed** (read out of a transcript, or out of
a command's actual output) or **inferred** (reasoned from what was observed,
not itself read).

## Setup

- Worktree: `C:\Claude\Projects\wt-3263-transcript-extraction`, branch
  `docs/docs-3263-transcript-extraction`, created by this spike, branched from
  `main` at `cb83a362`. This spike made exactly one commit on it.
- Parser: `parse-transcripts.mjs`, kept **outside every repo checkout** under
  the OS temp scratch directory
  (`C:\Users\dudar\AppData\Local\Temp\open-engine-scratch\cline-3339-20260920-105131\parse-transcripts.mjs`),
  never committed — same idiom as #3325's `hook-logger.mjs` and #3333's probe
  scripts. It is reproduced in full at the bottom of this doc; that paste is
  this doc's only reproducibility guarantee, which is why acceptance item 4
  exists.
- Verbatim run (from the scratch directory), **observed** output: `node
  parse-transcripts.mjs` → exit code `0`, `194` lines. Scoping one transcript
  also switches the parser into its verbose per-path mode:
  `node parse-transcripts.mjs b5a1be31` → exit code `0`.
- Corpus: **7 transcripts in 2 project directories**, all real sessions from
  the two preceding spikes — 526 KB–564 KB each, 25–35 JSONL entries each.
  Ground truth is taken from those two docs, which state what each session was
  briefed with; that is the only assignment ground truth that exists, and the
  parser reads it **only** in its scoring function (`score()`), never in a
  picking function (observed in the pasted source).

| transcript (session id) | project dir (under `~\.claude\projects\`) | briefed with | doc reference |
|---|---|---|---|
| `9eeee2f0-78ab-46ab-9eb3-91d293b533fd` | `C--Claude-Projects-wt-3263-guard-gap-spike` | assigned root **Y** | #3325 dispatch 1 |
| `5193fe70-26c8-489a-963b-23e5495f56b2` | same | assigned root **Y** | #3325 dispatch 2 |
| `c6bb424b-1396-4473-8f2f-019453ffbcc5` | same | assigned root **Y** | #3325 dispatch 3 |
| `b5a1be31-7f94-4441-b986-c1cebda324f3` | `C--Claude-Projects-wt-3263-cwd-dispatch-spike` | no worktree named | #3333 Finding 1 (quotes this session) |
| `41eacf8a-bc27-4ed5-a66a-7589a9a9928a` | same | no worktree named | #3333 Finding 4 (quotes this session) |
| `380c8b4c-cf38-4f90-b78a-84c3a50e6227` | same | no worktree named | earlier run of #3333's 4-step probe (**inferred** from its own brief text) |
| `913df6a5-9b5f-4c1e-8e34-0c1157e3fcf0` | same | no worktree named | earliest run of the same probe (**inferred** from its own brief text) |

  **Y** = `C:\Users\dudar\AppData\Local\Temp\open-engine-scratch\claude-3325-20260919-225612\probe\wt-y`,
  the throwaway probe worktree #3325 created, briefed and then removed.
- Known checkout roots are resolved **the way the guard does it**, not by
  directory-name convention (Q3's own instruction). Observed: the guard's
  `scripts/hooks/guard-worktree-write.mjs` exports
  `PRIMARY_CHECKOUT_ROOT = 'C:\\Claude\\Projects\\Audiobook-Generator'` and
  `listKnownCheckoutRoots()`, which spawns `git worktree list --porcelain`
  (guard source lines 30 and 43–45). The parser calls the same command the same
  way; **observed** run: 19 roots today (18 worktrees + the primary checkout),
  listed in full in the parser's output.
- Path shape: a candidate is any absolute Windows path literal
  (`[A-Za-z]:[\\/]…`) with **no** shell expansion, a trailing-separator strip,
  and a minimum of two separators. **Observed**: without that minimum the regex
  matches JSON-escape debris — the parser's own counter reports
  `PATH_SHAPE_REJECTS total=56`, e.g. `U:\`, `C:\Program`, `g:\n\n`,
  `s:\n\n-`. All 56 rejects are non-paths; none is a checkout root.
- The extraction heuristics scored in Finding 2, each named as it is reported.
  Every one of them is **blind to the ground-truth `briefed` value** (observed:
  `briefed` is read only in `score()`):
  1. **H1 `lastTurnFirstPath`** — first absolute path in the most recent
     prompt-bearing turn of any kind.
  2. **H2 `lastSdkTurnFirstPath`** — first absolute path in the most recent
     turn whose `promptSource` is `sdk` or `user` (i.e. skipping system /
     task-notification turns).
  3. **H2r** — H2's candidate list filtered to paths under a *declared root*
     (a `git worktree list --porcelain` root, or a root the transcript itself
     declares via its `cwd` field).
  4. **H3 `mostFrequent`** — the absolute path mentioned most often anywhere.
  5. **H4 `mostFrequentDeclaredRootPath`** — the most-mentioned path that
     resolves under a declared root.
  6. **H5 `labeled`** — the first path preceded by a label such as
     `Worktree:`, `assigned worktree`, `working directory`, `cwd`, `dir`,
     searched in the most recent prompt-bearing turn first and then across the
     whole transcript.
## Finding 1 (Q1) — is the originating instruction reliably findable, and what distinguishes it?

**Observed: yes, it is findable, but not by position — and `promptSource` is
the field that identifies it.** A prompt-bearing turn is an entry of
`type: "user"` whose `message.content` is non-empty. There are 1–2 of them per
transcript, and they are the only entries that carry text written *to* the
session rather than produced by it:

| transcript | entries | prompt-bearing turns | sidechain prompt turns | last turn's `promptSource` / `turnOrigin` |
|---|---|---|---|---|
| `9eeee2f0` (#3325 d1) | 29 | 1 | 0 | `sdk` / `sdk` |
| `5193fe70` (#3325 d2) | 30 | 1 | 0 | `sdk` / `sdk` |
| `c6bb424b` (#3325 d3) | 34 | 2 | 0 | **`system` / `task_notification`** |
| `b5a1be31` (#3333) | 30 | 1 | 0 | `sdk` / `sdk` |
| `41eacf8a` (#3333) | 35 | 1 | 0 | `sdk` / `sdk` |
| `380c8b4c` (#3333) | 25 | 1 | 0 | `sdk` / `sdk` |
| `913df6a5` (#3333) | 26 | 1 | 0 | `sdk` / `sdk` |

**Observed — the key set, quoted from a real entry.** On 6 of the 7 transcripts
every prompt-bearing turn carries exactly these 16 keys; `c6bb424b` carries the
same 16 plus `origin` and `queueSkipAttachments` (18). Acceptance item 3:

```
cwd, entrypoint, gitBranch, isSidechain, message, parentUuid, permissionMode,
promptId, promptSource, sessionId, timestamp, turnOrigin, type, userType, uuid,
version
```

**Observed — a real transcript entry, verbatim** (`9eeee2f0` index 4, the turn
that carries that dispatch's brief; the `message.content` value is replaced
with a length marker **by the parser's own sample printer**, not by the
transcript, so the doc can quote the key set without reproducing user text):

```json
{"parentUuid":"96229284-8d11-4933-b968-79f502792eee","isSidechain":false,"promptId":"518cce5d-dc19-41fe-aca0-c6d52d1c1302","type":"user","message":{"role":"user","content":"<redacted: 594 chars of prompt text>"},"uuid":"baa4fc16-ca7f-491e-8475-b5f8be51aaab","timestamp":"2026-09-19T22:58:22.150Z","permissionMode":"bypassPermissions","promptSource":"sdk","turnOrigin":"sdk","userType":"external","entrypoint":"sdk-cli","cwd":"C:\\Claude\\Projects\\wt-3263-guard-gap-spike","sessionId":"9eeee2f0-78ab-46ab-9eb3-91d293b533fd","version":"2.1.278","gitBranch":"docs/docs-3263-guard-gap-spike"}
```

Note the `cwd` and `gitBranch` fields **on the turn entry itself**: this is
which checkout the *session* ran in. For this transcript that is the
dispatching checkout (X), not the briefed tree — consistent with #3325's
Finding 3, and it is why `cwd` alone is not the answer to Q2.

**Observed — the last prompt-bearing turn is not always the originating
instruction.** `c6bb424b` has two. The second (index 30, 950 chars) is
`promptSource: "system"`, `turnOrigin: "task_notification"`, and its text is a
`<task-notification>` block for a *dispatched subagent's completion*, not a
brief:

```
<task-notification> <task-id>ac0a05b49edbd8d64</task-id>
<tool-use-id>toolu_01XvLx8goNUYFAVXnaDDJRyy</tool-use-id>
<output-file>C:\Users\dudar\AppData\Local\Temp\claude\C--Claude-Projects-wt-3263-g…
```

The only absolute path in that later turn is the notification's own scratch
`<output-file>`, and the briefed tree appears nowhere in it. The originating
turn (index 4, `promptSource: "sdk"`) is 30 entries earlier.

**Inferred:** a rule of the shape "the most recent turn" is answering *what
arrived last*, which here is the assignment's completion report. On this corpus
`promptSource: "sdk"` — present on every prompt turn observed, and absent from
the one system turn — is what separates an originating instruction from later
system traffic. Q1's answer is therefore: findable, with `promptSource` as the
discriminator, and position alone is insufficient on **1 of 7** transcripts.

**Observed — no sidechain prompt turns exist in this corpus.** All 7 report
`sidechainPromptTurns=0`, so subagent-produced text never appears as a
prompt-bearing turn here. `b5a1be31` does contain a `[Subagent hand-back]`
entry (index 21) yet still reports `promptTurns=1`: the hand-back's content
block is not of type `text`, so the prompt-turn filter excludes it. The
hand-back's *nested* shape was read during an ad-hoc inspection that is not
part of the pasted parser; the exclusion itself is **observed** in the pasted
parser's own `Q1 entries=30 promptTurns=1` line.

## Finding 2 (Q2) — can a heuristic extract the *assigned* root from a transcript?

**Observed, per file, four columns as the ticket specifies. `HIT` = the
extracted path equals the ground-truth briefed tree; `MISS` otherwise; `n/a` =
that transcript carries no assignment to extract, so there is no assigned root
in it at all (reported rather than silently scored as a miss).**

| transcript | heuristic | extracted root | ground truth | verdict |
|---|---|---|---|---|
| `9eeee2f0` (#3325 d1) | H1 last-turn first path | `…\claude-3325-…\probe\wt-y` | `…\probe\wt-y` | **HIT** |
| | H2 last `sdk` turn, first path | `…\probe\wt-y` | `…\probe\wt-y` | **HIT** |
| | H2r declared-root path | `(none)` | `…\probe\wt-y` | no pick |
| | H3 most frequent path overall | `C:\Claude\Projects\wt-3263-guard-gap-spike` | `…\probe\wt-y` | MISS |
| | H4 most frequent path under a root | `C:\Claude\Projects\wt-3263-guard-gap-spike` | `…\probe\wt-y` | MISS |
| | H5 labelled path | `C:\Claude\Projects\wt-3263-guard-gap-spike` | `…\probe\wt-y` | MISS |
| `5193fe70` (#3325 d2) | H1 last-turn first path | `…\probe\wt-y` | `…\probe\wt-y` | **HIT** |
| | H2 last `sdk` turn, first path | `…\probe\wt-y` | `…\probe\wt-y` | **HIT** |
| | H2r declared-root path | `(none)` | `…\probe\wt-y` | no pick |
| | H3 most frequent path overall | `C:\Claude\Projects\wt-3263-guard-gap-spike` | `…\probe\wt-y` | MISS |
| | H4 most frequent path under a root | `C:\Claude\Projects\wt-3263-guard-gap-spike` | `…\probe\wt-y` | MISS |
| | H5 labelled path | `C:\Claude\Projects\wt-3263-guard-gap-spike` | `…\probe\wt-y` | MISS |
| `c6bb424b` (#3325 d3) | H1 last-turn first path | `…\Temp\claude\…\tasks\ac0a05b49edbd8d64.output` | `…\probe\wt-y` | **MISS** |
| | H2 last `sdk` turn, first path | `…\probe\wt-y` | `…\probe\wt-y` | **HIT** |
| | H2r declared-root path | `(none)` | `…\probe\wt-y` | no pick |
| | H3 most frequent path overall | `C:\Claude\Projects\wt-3263-guard-gap-spike` | `…\probe\wt-y` | MISS |
| | H4 most frequent path under a root | `C:\Claude\Projects\wt-3263-guard-gap-spike` | `…\probe\wt-y` | MISS |
| | H5 labelled path | `C:\Claude\Projects\wt-3263-guard-gap-spike` | `…\probe\wt-y` | MISS |
| `b5a1be31` (#3333 P1) | all six | — | — | **n/a** |
| `41eacf8a` (#3333 P4) | all six | — | — | **n/a** |
| `380c8b4c` (#3333) | all six | — | — | **n/a** |
| `913df6a5` (#3333) | all six | — | — | **n/a** |

**The four `#3333` transcripts are dispatch-*controller* records, not
assignments.** This could not be read off a predecessor doc, so it is checked
directly: each of their issuing turns opens `Do exactly these … steps, in
order, … Make one Agent tool call: subagent_type "fix-agent", …` — a controller
instructing a session to dispatch, or to relay a path through *subagent prose* —
not an assignment. None contains an `assigned worktree:`-style brief, and the
only absolute path any of them carries outside the checkout is its own scratch
`probe\prompt.txt`. Against a ground truth that was never stated, "did it
extract the assigned root" is not a question such a transcript can answer, so
those rows are reported `n/a` rather than scored — **which is itself a Q2
finding**: four of the seven records contain no assignment to extract, and
nothing on disk marks them apart from the three that do.

**Hit rate where the question is answerable (3 of 3), and against the whole
directory as denominator (3 of 7). Every heuristic's rate is reported
separately (acceptance item 5), not only the best one:**

| heuristic | HIT | MISS | no pick | n/a | hit rate (answerable) | hit rate (whole dir) |
|---|---|---|---|---|---|---|
| H1 last-turn first path | 2 | 1 | 0 | 4 | 2/3 | 2/7 |
| H2 last `sdk`-source turn, first path | **3** | 0 | 0 | 4 | **3/3** | 3/7 |
| H2r declared-root path | 0 | 0 | 3 | 4 | 0/3 (inert) | 0/7 |
| H3 most frequent path overall | 0 | 3 | 0 | 4 | 0/3 | 0/7 |
| H4 most frequent path under a root | 0 | 3 | 0 | 4 | 0/3 | 0/7 |
| H5 labelled path | 0 | 3 | 0 | 4 | 0/3 | 0/7 |

**Misses, each named with its cause (acceptance item 5), reported separately
rather than pooled:**

1. `c6bb424b`, **H1** — the last prompt-bearing turn is the
   `task_notification` system turn, so the first path it yields is the
   notification's `<output-file>` scratch path
   (`…\Temp\claude\…\tasks\ac0a05b49edbd8d64.output`). The briefed tree is not
   in that turn at all. Cause: position, not path shape — this is Finding 1's
   two-turn case arriving in Q2.
2. `9eeee2f0` / `5193fe70` / `c6bb424b`, **H3 and H4** — one identical cause in
   all three: the most frequently mentioned path is the session's **own**
   checkout (`wt-3263-guard-gap-spike`, 20/21/23 mentions), because every tool
   call in the transcript is stamped with it, while the briefed tree is
   mentioned once, in prose. Frequency measures *where the session ran* — the
   very signal #3325 and #3333 showed is **not** the assigned root.
3. All three, **H5** — the label rule returns the path following a label, and
   the label that actually occurs is X's own path inside tool text
   (`…\wt-3263-guard-gap-spike\CLAUDE.md`), not a label naming the assigned
   tree. The corpus contains no `Worktree:`-style label for the assigned root,
   so H5 has nothing correct to lock onto and falls back to the most-referenced
   path.
4. All three, **H2r** — not a wrong answer but **no answer**: it never produced
   a pick on any transcript (`(none)` in every `Q2 H2r_…` line), because the
   only declared-root pattern it looks for — a transcript `cwd` field naming
   the briefed tree — does not occur in this corpus. Reported as a rule tried
   and found inert rather than quietly dropped from the table.

**Observed, and deliberately stated outside the hit-rate columns:** the
per-transcript path counts behind H3 are `pathsDistinct=17/17/19` for
`9eeee2f0`/`5193fe70`/`c6bb424b`, with the session's own checkout counting
20/21/23 and the briefed tree 1 — so the gap between the winning and losing
candidate is not a near-tie that a better tie-break could settle.

## Finding 3 (Q3) — containment: is the assigned root always among the roots mentioned, and how many others are there?

**Observed. This is a different property from Q2 and is answered only from the
`mentioned anywhere` side; no heuristic is involved.**

| transcript | assigned root among all mentioned paths? | times mentioned | other known checkout roots also mentioned | paths under no known root |
|---|---|---|---|---|
| `9eeee2f0` (#3325 d1) | **YES** | 1 | 0 | 15 |
| `5193fe70` (#3325 d2) | **YES** | 1 | 0 | 15 |
| `c6bb424b` (#3325 d3) | **YES** | 1 | 0 | 17 |
| `b5a1be31`, `41eacf8a`, `380c8b4c`, `913df6a5` (#3333 ×4) | n/a — no assignment | — | 1 each (P1 only) | 14–15 |

**Containment holds on 3 of 3 answerable transcripts.** The assigned root is
present in the transcript, and **no other known checkout root is mentioned
alongside it** in any of the three (`otherGuardRootsMentioned=0`,
`otherCwdRootsMentioned=0`). The set of known roots resolved the way the guard
resolves it — `PRIMARY_CHECKOUT_ROOT` plus `git worktree list --porcelain`, 19
roots on this run (`18 worktrees + primary`) — is the denominator for that
"other roots" count.

**The distinguishing number is the co-signal, not the containment.** On all
three, the briefed tree is mentioned exactly **once**, while the *session's own*
checkout is mentioned **20–23 times**, and the session's own checkout is not
"another worktree" — it is the dispatching tree X itself, which the guard's
root list does contain. So `otherGuardRootsMentioned=0` is true only in the
narrow sense that no *second* worktree is named; a reader who takes "other
roots" to mean "other checkout-like roots than the assigned one" must count X,
and then the number is **1 on all three**, with X outnumbering the assigned tree
20:1 to 23:1 in mentions.

**There is no line here that says which of the two is the assignment.** Q2 and
Q3 are reported separately, as instructed, and they disagree in the way the
ticket anticipated: containment is **3/3** while the best non-positional
extraction heuristic is **0/3** and the best positional one is 2/3.

## Not tested

- No regression test accompanies this spike, per the #3246/#3325/#3333
  precedent (stated up front in this doc's own opening paragraph).
- Only 7 transcripts, drawn from 2 prior spikes, were available on this box;
  the answerable subset for Q2/Q3 is 3 transcripts, all sharing the same
  dispatch shape (a `[claude][verify]`-style single-turn dispatch into a
  freshly created worktree). A corpus with a *different* dispatch shape —
  multi-turn briefing, a mid-session re-assignment, or a resumed session
  whose original brief has scrolled out of the visible transcript window —
  was not available and is not represented here.
- Whether `promptSource` and `turnOrigin` are stable fields across CLI
  versions was not checked; this corpus's 7 transcripts all carry
  `"version":"2.1.278"` (observed in the Finding 1 sample), so no
  cross-version comparison was possible.
- H2r (declared-root filtering) was tried only against `KNOWN_ROOTS` (the
  guard's own root list) and `CWD_ROOTS` (a transcript's own `cwd` values,
  live at parse time); it was not tried against a root list snapshotted at
  the transcript's *own* time, which could differ from today's if worktrees
  have since been added or removed.
- Compacted or summarized transcripts (where the harness's own context
  compression has replaced early turns with a summary) were not in this
  corpus and were not tested; whether a compacted originating turn still
  carries `promptSource` and the briefed path is an open question this
  spike does not answer.
- Sidechain-only assignment (a brief arriving via a subagent hand-back
  rather than a top-level user turn) was not exercised — this corpus's one
  hand-back entry (`b5a1be31` index 21, Finding 1) belongs to a transcript
  with no assignment to extract at all, so it does not test that case.

## Conclusion

**Stating the numbers only; no design choice is made here, per the ticket's
own Output instruction.**

- **Q1 (findability):** the originating instruction is findable, but not by
  raw position — `c6bb424b` (1 of 7) has a later, non-originating
  prompt-bearing turn (a `task_notification`). `promptSource: "sdk"` (or
  more broadly, filtering to `sdk`/`user` sources rather than `system`)
  separates the originating turn from that later traffic on every transcript
  observed.
- **Q2 (extraction):** of the six heuristics tried, one — H2, "the first
  absolute path in the most recent `sdk`/`user`-sourced turn" — hit the
  assigned root on all 3 of 3 answerable transcripts. The purely positional
  variant (H1, ignoring `promptSource`) hit 2 of 3, missing exactly the case
  Q1 flagged. The four remaining heuristics (H2r, H3, H4, H5), which all
  either filter to declared roots or rank by mention frequency, hit 0 of 3 —
  the session's own dispatching checkout is mentioned 20–23 times against
  the assigned root's 1 mention, so frequency and root-membership both point
  at the wrong tree on this corpus. 4 of the 7 transcripts carry no
  assignment at all and are reported `n/a` rather than folded into any rate.
- **Q3 (containment):** on all 3 answerable transcripts, the assigned root
  is present in the transcript (mentioned exactly once each), and no
  *second* worktree beyond the assigned root and the session's own
  dispatching checkout is mentioned. Whether the dispatching checkout counts
  as an "other" root is a labeling choice, not a number this spike can
  settle — reported both ways in Finding 3.
- **Where Q2 and Q3 diverge:** containment holds 3/3 while extraction's best
  score is 3/3 only for one specific heuristic (H2) and 0/3 for four others;
  the two properties are not interchangeable, and a design that assumes
  "the root is mentioned somewhere" still needs a way to pick it out from
  among the mentions, which is exactly what most of the tried heuristics
  failed to do on this corpus.
- **Sample size caveat, stated plainly:** the answerable subset is 3
  transcripts, all produced by the same predecessor spike (#3325) with the
  same dispatch shape. These numbers describe that corpus; they are not a
  claim about every possible dispatch shape, and the Not-tested section
  above lists several shapes this spike did not see.

## Parser source

Pasted in full, exactly as run to produce every number above (acceptance
item 4). Kept outside every repo checkout, at
`C:\Users\dudar\AppData\Local\Temp\open-engine-scratch\cline-3339-20260920-105131\parse-transcripts.mjs`;
reproduced here verbatim.

```javascript
// Castwright#3339 - throwaway spike tooling. Kept OUTSIDE every repo checkout
// (OS temp scratch), same idiom as #3325's and #3333's probe scripts. Prints the
// Q1/Q2/Q3 numbers used by docs/ops/3263-transcript-extraction-feasibility.md.
//
// Usage:  node parse-transcripts.mjs [filter ...]
//   Each filter is a case-insensitive substring matched against a transcript's
//   directory or file name, so a re-run can be scoped to one or two transcripts.
//   No filter = all seven.
//
// The known-checkout-root enumeration mirrors
// scripts/hooks/guard-worktree-write.mjs (PRIMARY_CHECKOUT_ROOT +
// `git worktree list --porcelain`), so Q3's "known root" set is the guard's set.

import { readFileSync, existsSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { win32 } from 'node:path';

const { resolve, sep } = win32;

const PRIMARY_CHECKOUT_ROOT = 'C:\\Claude\\Projects\\Audiobook-Generator';
const GAP_DIR = 'C:\\Users\\dudar\\.claude\\projects\\C--Claude-Projects-wt-3263-guard-gap-spike';
const CWDDIR = 'C:\\Users\\dudar\\.claude\\projects\\C--Claude-Projects-wt-3263-cwd-dispatch-spike';

// Throwaway probe tree Y from #3325 (created for that spike, removed after it).
const Y = 'C:\\Users\\dudar\\AppData\\Local\\Temp\\open-engine-scratch\\claude-3325-20260919-225612\\probe\\wt-y';

// Ground truth from the predecessor docs:
// #3325 Setting/Finding 3 - all three dispatches were briefed at Y (cwd = X).
// #3333 Finding 1/4 - see `briefed` below.
const CORPUS = [
  { src: '#3325 d1', dir: GAP_DIR, file: '9eeee2f0-78ab-46ab-9eb3-91d293b533fd', briefed: Y },
  { src: '#3325 d2', dir: GAP_DIR, file: '5193fe70-26c8-489a-963b-23e5495f56b2', briefed: Y },
  { src: '#3325 d3', dir: GAP_DIR, file: 'c6bb424b-1396-4473-8f2f-019453ffbcc5', briefed: Y },
  { src: '#3333 P1', dir: CWDDIR, file: 'b5a1be31-7f94-4441-b986-c1cebda324f3', briefed: 'UNKNOWN' },
  { src: '#3333 P4', dir: CWDDIR, file: '380c8b4c-cf38-4f90-b78a-84c3a50e6227', briefed: 'UNKNOWN' },
  { src: '#3333 other1', dir: CWDDIR, file: '41eacf8a-bc27-4ed5-a66a-7589a9a9928a', briefed: 'UNKNOWN' },
  { src: '#3333 other2', dir: CWDDIR, file: '913df6a5-9b5f-4c1e-8e34-0c1157e3fcf0', briefed: 'UNKNOWN' },
];

function listKnownCheckoutRoots() {
  try {
    const r = spawnSync('git', ['worktree', 'list', '--porcelain'], {
      cwd: PRIMARY_CHECKOUT_ROOT, encoding: 'utf8', windowsHide: true,
    });
    if (r.error || r.status !== 0 || !r.stdout) return [PRIMARY_CHECKOUT_ROOT];
    const roots = r.stdout.split('\n')
      .filter((l) => l.startsWith('worktree '))
      .map((l) => l.slice('worktree '.length).trim())
      .filter(Boolean)
      .map((p) => resolve(p));
    return roots.length > 0 ? roots : [PRIMARY_CHECKOUT_ROOT];
  } catch {
    return [PRIMARY_CHECKOUT_ROOT];
  }
}

const KNOWN_ROOTS = listKnownCheckoutRoots();

/** Absolute Windows path spellings, both separators, no shell expansion.
 *  A candidate must carry at least two separators (`C:\a\b`) — see
 *  MIN_SEPARATORS below: the single-separator form matches junk like `g:\n\n`
 *  that occurs in escaped text. */
const PATH_RE = /[A-Za-z]:[\\/][^\s"'`<>|*?\r\n]+/g;
const MIN_SEPARATORS = 2;

let rejected = 0;
const rejectedExamples = [];

function extractPaths(text) {
  const found = [];
  const matches = String(text).match(PATH_RE);
  if (!matches) return found;
  for (const raw of matches) {
    const cleaned = raw.replace(/[.,;:)\]}]+$/, '');
    const seps = (cleaned.match(/[\\/]/g) || []).length;
    // `g:\n\n` and friends are false positives from JSON-escaped whitespace:
    // a literal backslash followed by n/r/t sits inside a longer match.
    const escapedWs = /\\[nrt]/.test(cleaned);
    if (cleaned.length > 3 && seps >= MIN_SEPARATORS && !escapedWs) {
      found.push(cleaned);
    } else if (rejectedExamples.length < 12) {
      rejected++;
      rejectedExamples.push(cleaned);
    } else {
      rejected++;
    }
  }
  return found;
}

/** Canonical spelling: backslashes, no trailing separator, lower-cased for
 *  identity comparisons (Windows paths are case-insensitive). */
function canon(p) {
  let s = String(p).replace(/[\\/]+/g, '\\').replace(/\\+$/, '');
  return s;
}
const key = (p) => canon(p).toLowerCase();

function isUnderRoot(absPath, root) {
  const p = canon(absPath).toLowerCase();
  const r = canon(root).toLowerCase();
  return p === r || p.startsWith(r + sep);
}

function rootsCovering(path, roots) {
  return roots.filter((r) => isUnderRoot(path, r));
}

function loadEntries(file) {
  const out = [];
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try { out.push(JSON.parse(t)); } catch { /* malformed line: skipped */ }
  }
  return out;
}

function collectStrings(value, out, depth = 0) {
  if (value === null || value === undefined || depth > 14) return;
  if (typeof value === 'string') { out.push(value); return; }
  if (Array.isArray(value)) { for (const v of value) collectStrings(v, out, depth + 1); return; }
  if (typeof value === 'object') { for (const k of Object.keys(value)) collectStrings(value[k], out, depth + 1); }
}

/** The user/prompt text of one entry, for either message.content shape. */
function promptText(entry) {
  const c = entry && entry.message ? entry.message.content : undefined;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) {
    return c.filter((b) => b && b.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text).join('\n');
  }
  return '';
}

function isPromptTurn(e) {
  return !!e && e.type === 'user' && promptText(e).trim().length > 0;
}

function lastPromptTurn(entries, topLevelOnly) {
  for (let i = entries.length - 1; i >= 0; i--) {
    if (isPromptTurn(entries[i]) && (!topLevelOnly || entries[i].isSidechain !== true)) {
      return { entry: entries[i], index: i };
    }
  }
  return null;
}

function distinctPaths(strings) {
  const m = new Map();
  for (const s of strings) {
    for (const p of extractPaths(s)) {
      const k = key(p);
      if (!m.has(k)) m.set(k, canon(p));
    }
  }
  return m;
}

function countPaths(strings) {
  const counts = new Map();
  const display = new Map();
  for (const s of strings) {
    for (const p of extractPaths(s)) {
      const k = key(p);
      counts.set(k, (counts.get(k) || 0) + 1);
      if (!display.has(k)) display.set(k, canon(p));
    }
  }
  return { counts, display };
}

/** Rule C: an explicitly labelled path mention. */
function labeledPaths(text) {
  const re = /(?:assigned\s+worktree|assigned\s+tree|assigned\s+path|worktree|working\s+directory|directory|cwd|dir)\s*[:=]\s*([A-Za-z]:[\\/][^\s"'`<>|*?\r\n]+)/gi;
  const hits = [];
  let m;
  while ((m = re.exec(String(text))) !== null) hits.push(m[1].replace(/[.,;:)\]}]+$/, ''));
  return hits;
}

/** H1: the first absolute path mentioned, in mention order. No root filter and
 *  no ground-truth input — a pick must never see `briefed`. */
function pickFirst(paths) { return paths.length ? paths[0] : null; }

/** Root-filtered variant: first path that resolves under any of `roots`. */
function pickFirstRooted(paths, roots) {
  for (const p of paths) if (rootsCovering(p, roots).length > 0) return p;
  return null;
}

/** H3: the most frequently mentioned absolute path. */
function pickMostFrequent(counts, display) {
  let best = null;
  let bestN = -1;
  for (const [k, n] of counts) if (n > bestN) { bestN = n; best = display.get(k); }
  return best;
}

/** H4: most frequent path that resolves under a declared root. */
function pickMostFrequentRooted(counts, display, roots) {
  const ordered = [...counts.keys()].sort((x, y) => counts.get(y) - counts.get(x));
  for (const k of ordered) if (rootsCovering(display.get(k), roots).length > 0) return display.get(k);
  return null;
}

/** The most recent prompt-bearing turn whose `promptSource` is in `sources`. */
function lastTurnBySource(entries, sources) {
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (isPromptTurn(e) && sources.includes(e.promptSource || 'user')) return { entry: e, index: i };
  }
  return null;
}

/** Scoring only — `briefed` is ground truth and is read nowhere else. */
function score(pick, briefed) {
  if (!briefed) return 'n/a (no briefed tree in this transcript)';
  if (!pick) return 'no pick';
  if (key(pick) === key(briefed)) return 'HIT';
  return isUnderRoot(pick, briefed) ? 'HIT (subpath of assigned)' : 'MISS';
}

const filters = process.argv.slice(2);
const VERBOSE = filters.length > 0;
console.log(`KNOWN_ROOTS=${KNOWN_ROOTS.length}`);
for (const r of KNOWN_ROOTS) console.log(`  ROOT ${r}`);

for (const c of CORPUS) {
  const name = `${c.dir}\\${c.file}.jsonl`;
  if (filters.length && !filters.some((f) => name.toLowerCase().includes(f.toLowerCase()))) continue;
  console.log(`\n===== ${c.src} ${c.file}`);
  if (!existsSync(name)) { console.log('MISSING file'); continue; }
  const entries = loadEntries(name);
  console.log(`Q0 kb=${Math.round(statSync(name).size / 1024)} entries=${entries.length}`);
  const allStrings = [];
  for (const e of entries) collectStrings(e, allStrings);
  const pathsAll = distinctPaths(allStrings);
  const { counts, display } = countPaths(allStrings);

  const anyTurn = lastPromptTurn(entries, false);
  const topTurn = lastPromptTurn(entries, true);
  const anyText = anyTurn ? promptText(anyTurn.entry) : '';
  const topText = topTurn ? promptText(topTurn.entry) : '';

  const keyUnion = new Set();
  let promptTurns = 0;
  let sidechainTurns = 0;
  for (const e of entries) {
    if (isPromptTurn(e)) {
      promptTurns++;
      if (e.isSidechain === true) sidechainTurns++;
      for (const k of Object.keys(e)) keyUnion.add(k);
    }
  }
  console.log(`Q1 entries=${entries.length} promptTurns=${promptTurns} sidechainPromptTurns=${sidechainTurns}`);
  console.log(`Q1 keysOnPromptTurns=${[...keyUnion].sort().join(',')}`);
  console.log(`Q1 lastPromptTurnAny idx=${anyTurn ? anyTurn.index : -1} isSidechain=${anyTurn ? anyTurn.entry.isSidechain === true : 'n/a'} textLen=${anyText.length}`);
  console.log(`Q1 lastPromptTurnTopLevel idx=${topTurn ? topTurn.index : -1} textLen=${topText.length}`);
  if (anyTurn) {
    const sample = JSON.parse(JSON.stringify(anyTurn.entry));
    if (sample.message && typeof sample.message === 'object') {
      sample.message = { ...sample.message, content: `<redacted: ${anyText.length} chars of prompt text>` };
    }
    if (sample.toolUseResult) sample.toolUseResult = '<redacted>';
    console.log(`Q1 sample=${JSON.stringify(sample).slice(0, 400)}`);
  }

  // ---- Q1: the prompt-bearing turns, in order (see Finding 1).
  const turns = [];
  entries.forEach((e, i) => {
    if (!isPromptTurn(e)) return;
    const text = promptText(e);
    turns.push({
      i,
      promptSource: e.promptSource || '(absent)',
      turnOrigin: e.turnOrigin || '(absent)',
      sidechain: e.isSidechain === true,
      chars: text.length,
      excerpt: text.replace(/\s+/g, ' ').slice(0, 180),
      paths: extractPaths(text),
    });
  });
  console.log(`Q1TURNS n=${turns.length}`);
  for (const t of turns) {
    console.log(`  TURN idx=${t.i} promptSource=${t.promptSource} turnOrigin=${t.turnOrigin} sidechain=${t.sidechain} chars=${t.chars} paths=${t.paths.length}${t.paths.length ? ' first=' + canon(t.paths[0]) : ''}`);
    console.log(`  EXCERPT "${t.excerpt}"`);
  }

  // ---- roots the transcript itself declares, live at the session's own time
  const cwdMap = new Map();
  for (const e of entries) {
    if (typeof e.cwd !== 'string' || !e.cwd) continue;
    const k = key(e.cwd);
    if (!cwdMap.has(k)) cwdMap.set(k, { display: canon(e.cwd), n: 0, sidechain: 0 });
    const cv = cwdMap.get(k);
    cv.n++;
    if (e.isSidechain === true) cv.sidechain++;
  }
  const CWD_ROOTS = [...cwdMap.values()].map((v) => v.display);
  console.log(`CWDROOTS n=${cwdMap.size}`);
  for (const v of cwdMap.values()) console.log(`  CWD ${v.display} entries=${v.n} sidechain=${v.sidechain}`);

  // ---- heuristics: every pick below is blind to `briefed`.
  const pathsAny = extractPaths(anyText);
  const sdkTurn = lastTurnBySource(entries, ['sdk', 'user']);
  const pathsSdk = sdkTurn ? extractPaths(promptText(sdkTurn.entry)) : [];
  const declaredRoots = [...KNOWN_ROOTS, ...CWD_ROOTS];
  const h1 = pickFirst(pathsAny);
  const h2 = pickFirst(pathsSdk);
  const h2r = pickFirstRooted(pathsSdk, declaredRoots);
  const h3 = pickMostFrequent(counts, display);
  const h4 = pickMostFrequentRooted(counts, display, declaredRoots);
  const h5 = pickFirst(labeledPaths(anyText).concat(labeledPaths(allStrings.join('\n'))));

  const coveredRoots = new Set();
  for (const k of pathsAll.keys()) for (const r of rootsCovering(display.get(k), KNOWN_ROOTS)) coveredRoots.add(key(r));
  const cwdCovered = new Set();
  for (const k of pathsAll.keys()) for (const r of rootsCovering(display.get(k), CWD_ROOTS)) cwdCovered.add(key(r));
  let unrooted = 0;
  for (const k of pathsAll.keys()) {
    const p = display.get(k);
    if (rootsCovering(p, KNOWN_ROOTS).length === 0 && rootsCovering(p, CWD_ROOTS).length === 0) unrooted++;
  }
  const underBriefed = c.briefed
    ? [...pathsAll.keys()].filter((k) => key(display.get(k)) === key(c.briefed) || isUnderRoot(display.get(k), c.briefed)).length
    : 0;
  const otherKnown = [...coveredRoots].filter((r) => !c.briefed || !isUnderRoot(r, c.briefed));
  const otherCwd = [...cwdCovered].filter((r) => !c.briefed || !isUnderRoot(r, c.briefed));

  console.log(`Q2 briefed=${c.briefed}`);
  console.log(`Q2 pathsDistinct=${pathsAll.size} guardRootsCovered=${coveredRoots.size} cwdRootsCovered=${cwdCovered.size} pathsUnderNoRoot=${unrooted}`);
  console.log(`Q2 assignedPathAmongPaths=${underBriefed > 0 ? `YES (${underBriefed})` : 'NO'}`);
  console.log(`Q2 H1_lastTurnFirstPath=${h1 ? canon(h1) : '(none)'} => ${score(h1, c.briefed)}`);
  console.log(`Q2 H2_lastSdkTurnFirstPath=${h2 ? canon(h2) : '(none)'} => ${score(h2, c.briefed)}`);
  console.log(`Q2 H2r_lastSdkTurnFirstDeclaredRootPath=${h2r ? canon(h2r) : '(none)'} => ${score(h2r, c.briefed)}`);
  console.log(`Q2 H3_mostFrequent=${h3 ? canon(h3) : '(none)'} => ${score(h3, c.briefed)}`);
  console.log(`Q2 H4_mostFrequentDeclaredRootPath=${h4 ? canon(h4) : '(none)'} => ${score(h4, c.briefed)}`);
  console.log(`Q2 H5_labeled=${h5 ? canon(h5) : '(none)'} => ${score(h5, c.briefed)}`);
  console.log(`Q3 otherGuardRootsMentioned=${otherKnown.length} otherCwdRootsMentioned=${otherCwd.length}`);
  console.log(`Q3 pathSample=${[...pathsAll.values()].slice(0, 6).join(' ; ')}`);
  if (VERBOSE) {
    // Every distinct path with its classification, most frequent first. Verbose
    // mode is opt-in and normally scoped to one transcript, so this stays small.
    console.log(`Q3 ALLPATHS n=${pathsAll.size}`);
    const ordered = [...pathsAll.keys()].sort((x, y) => (counts.get(y) || 0) - (counts.get(x) || 0));
    for (const k of ordered) {
      const disp = display.get(k);
      const g = rootsCovering(disp, KNOWN_ROOTS);
      const w = rootsCovering(disp, CWD_ROOTS);
      console.log(`  ${counts.get(k)}x  ${disp}  [guardRoot:${g.length ? g.join('|') : '-'}] [sessionCwdRoot:${w.length ? w.join('|') : '-'}]`);
    }
  }
}
console.log(`\nPATH_SHAPE_REJECTS total=${rejected} examples=${rejectedExamples.join(' ; ')}`);
console.log('\nDONE');
```
