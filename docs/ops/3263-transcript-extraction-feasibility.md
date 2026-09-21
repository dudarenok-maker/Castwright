# Castwright#3339 — measuring `transcript_path` extraction feasibility (#3263 direction A)

> Re-verified and corrected under **#3340**. The parser this doc pasted in its
> first revision rejected real paths as escape debris (`\tasks`, `\node_modules`,
> `\temp`), so four of its numbers were not what the pasted source prints. The
> corrected source is pasted at the bottom and every number below is now what
> that script outputs; what moved, and the one-line change, are in
> **Re-verification after #3340**.

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
- Parser: `parse-transcripts-fixed.mjs` — #3339's `parse-transcripts.mjs` with
  the one-predicate fix described under `## Re-verification after #3340` — kept
  **outside every repo checkout** under the OS temp scratch directory
  (`C:\Users\dudar\AppData\Local\Temp\open-engine-scratch\cline-3340-20260920-225641\parse-transcripts-fixed.mjs`),
  never committed — same idiom as #3325's `hook-logger.mjs` and #3333's probe
  scripts. It is reproduced in full at the bottom of this doc; that paste is
  this doc's only reproducibility guarantee, which is why acceptance item 4
  exists. #3339's own revision of the same file still lives at
  `…\open-engine-scratch\cline-3339-20260920-105131\parse-transcripts.mjs`, and
  the **corrected** revision — the one whose single changed line is quoted under
  **Re-verification after #3340** — is what is pasted at the bottom.
- Verbatim run (from the scratch directory), **observed** output: `node
  parse-transcripts-fixed.mjs` → exit code `0`, `182` lines. Scoping one
  transcript also switches the parser into its verbose per-path mode:
  `node parse-transcripts-fixed.mjs c6bb424b` → exit code `0`. (#3339 recorded
  `194` lines for its revision; that revision resolved 19 known checkout roots
  and this one resolves 7, and the 12-line difference is exactly those 12
  `ROOT` lines — `182 + 12 = 194`.) The corrected file was re-run end to end on
  2026-09-21 and reproduced its own earlier output byte for byte, and the paste
  re-extracted from **this** doc was run separately and reproduced that same
  output a third time the same day — so the block at the bottom is the script
  that produced every number in this doc, verified by running the paste itself
  rather than the file it was copied from.
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
  way, so the set is resolved from **whatever directory the parser is run in**,
  and it is therefore a property of the run, not a constant. **Observed**:
  #3339 recorded 19 roots (18 worktrees + the primary checkout); the #3340
  re-verification run, launched from the scratch directory the doc specifies,
  resolved **7**. Both are reported because either one is reproducible only
  together with its working directory, and the difference does not touch any
  answerable transcript: `guardRootsCovered=0` on all three of them and on
  three of the four `n/a` ones, and the remaining transcript's own checkout is
  simultaneously a `cwd` root, so it stays covered under either set.

- Path shape: a candidate is any absolute Windows path literal
  (`[A-Za-z]:[\\/]…`) with **no** shell expansion, a trailing-separator strip,
  and a minimum of two separators — **plus**, after #3340, an escape-debris
  rule that only fires when a `\[nrt]` pair is *not* followed by a name
  character. `\tasks`, `\node_modules` and `\temp` are then read as separator +
  directory name (real paths), while `\n\n` and `\n-` stay debris.
  **Observed**: the parser's own counter reports `PATH_SHAPE_REJECTS total=84`,
  e.g. `U:\`, `C:\Program`, `g:\n\n`, `s:\n\n-`. That counter is **not
  deduplicated** — it increments once per rejected candidate per pass and the
  parser sweeps the whole corpus twice — so `84` is 42 occurrences of four
  genuine debris candidates per transcript (28 distinct in all), and after
  #3340's fix every one of them is genuine debris. Two counts that shipped with
  #3339 are **not** what the source it pasted prints; #3340 measured all three
  revisions rather than re-deriving them (full table under **Re-verification
  after #3340** below):
  - the pasted (unfixed) source prints `PATH_SHAPE_REJECTS total=94`, and among
    its rejects are **4 occurrences of one real absolute path** — `c6bb424b`'s
    `…\tasks\ac0a05b49edbd8d64.output`, dropped only because `\t` begins
    `tasks` — so "all 56 rejects are non-paths" was false;
  - `56` is what that same doubled counter prints for a revision with **no**
    escape filter at all (`U:\` and `C:\Program` only: 4 occurrences × 7
    transcripts × 2 passes), i.e. the count of a revision the doc does not
    paste. Deleted outright, this filter is still wrong: it re-admits `g:\n\n`
    and `s:\n\n-` as paths, which is how that revision reaches
    `pathsDistinct=17` instead of `15` on `9eeee2f0`.
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
   checkout (`wt-3263-guard-gap-spike`, 26/27/29 occurrences), because every tool
   call in the transcript is stamped with it, while the briefed tree is
   mentioned 7/5/5 times, in prose. Frequency measures *where the session ran* —
   the very signal #3325 and #3333 showed is **not** the assigned root.
   (**Corrected by #3340**: `#3339` printed 20/21/23 and "mentioned once",
   which came from the same path-shape filter — see **Re-verification after
   #3340**. The correction shrinks the mention margin from roughly 20:1 to
   roughly 4:1, and does not change the outcome: H3 and H4 still pick the
   session's own checkout, not the assigned tree, on all three.)
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
per-transcript distinct-path counts behind H3 are `pathsDistinct=15/15/17` for
`9eeee2f0`/`5193fe70`/`c6bb424b`, and in every one of the three the H3 winner is
the session's own checkout (`C:\Claude\Projects\wt-3263-guard-gap-spike`) — the
very signal #3325 and #3333 showed is **not** the assigned root. (**Corrected by
#3340**: `#3339` printed `pathsDistinct=17/17/19` here, because its path-shape
filter was dropping real candidates — see **Re-verification after #3340**.)

**Mention counts are rule-dependent, so both rules are named wherever a count
appears.** *Distinct* counts a parsed path once (that is what `assignedPathAmongPaths=YES (1)`
reports); *occurrences* counts every mention, subpaths included. The two rules
disagree on this corpus — the briefed tree is 1 distinct path but 7/5/5
occurrences — so any ratio between the two trees is only meaningful with its rule
attached. Under **occurrences** the session's own checkout leads by roughly 4:1,
not the roughly 20:1 `#3339` reported from the distinct rule; it still leads on
all three, so the H3/H4 outcome is unchanged, but the margin that #3339's text
described as unreachable by "a better tie-break" is four times narrower than it
said.

## Finding 3 (Q3) — containment: is the assigned root always among the roots mentioned, and how many others are there?

**Observed. This is a different property from Q2 and is answered only from the
`mentioned anywhere` side; no heuristic is involved.**

| transcript | assigned root among all mentioned paths? | times mentioned | other known checkout roots also mentioned | paths under no known root |
|---|---|---|---|---|
| `9eeee2f0` (#3325 d1) | **YES** | 7 (1 distinct) | 0 | 15 |
| `5193fe70` (#3325 d2) | **YES** | 5 (1 distinct) | 0 | 15 |
| `c6bb424b` (#3325 d3) | **YES** | 5 (1 distinct) | 0 | 15 |
| `b5a1be31`, `41eacf8a`, `380c8b4c`, `913df6a5` (#3333 ×4) | n/a — no assignment | — | 1 each (P1 only) | 12–13 |

**Containment holds on 3 of 3 answerable transcripts.** The assigned root is
present in the transcript, and **no other known checkout root from the guard's
own list is mentioned alongside it** in any of the three
(`otherGuardRootsMentioned=0`). The `cwd`-root variant of the same question
answers **1**, not 0 (`otherCwdRootsMentioned=1`): a transcript's own `cwd` — the
dispatching checkout X — is a `cwd` root and is mentioned, so it is counted there
even though it is not a second *worktree*. The set of known roots is resolved the
way the guard resolves it — `PRIMARY_CHECKOUT_ROOT` plus
`git worktree list --porcelain` — and because the parser runs that command in
whatever directory it is launched from, the set is a property of the run:
#3339's run saw **19** roots (`18 worktrees + primary`), the #3340 re-verification
run saw **7**. Both are reported because either is reproducible only together
with its working directory; the difference moves no answer above, since
`guardRootsCovered=0` on all three answerable transcripts under either set.

**The distinguishing number is the co-signal, not the containment.** On all
three, the briefed tree accounts for **1 distinct path** and **5–7 occurrences**,
while the *session's own* checkout is mentioned **26–29 times**, and the session's
own checkout is not "another worktree" — it is the dispatching tree X itself,
which the guard's root list does contain. So `otherGuardRootsMentioned=0` is true
only in the narrow sense that no *second* worktree is named; a reader who takes
"other roots" to mean "other checkout-like roots than the assigned one" must count
X, and then the number is **1 on all three**, with X outnumbering the assigned tree
by roughly 4:1 to 5:1 in occurrence mentions (`26:7`, `27:5`, `29:5`). (**Corrected
by #3340**: #3339 printed "mentioned exactly once" and `20–23` here, both from the
path-shape filter that was dropping real candidates — see **Re-verification after
#3340**.)

**There is no line here that says which of the two is the assignment.** Q2 and
Q3 are reported separately, as instructed, and they disagree in the way the
ticket anticipated: containment is **3/3** while the best non-positional
extraction heuristic is **0/3** and the best positional one is 2/3.

## Re-verification after #3340

**What was wrong, stated as a rule rather than a symptom.** The path-shape filter
in the source #3339 pasted read:

```javascript
    const escapedWs = /\\[nrt]/.test(cleaned);
    if (cleaned.length > 3 && seps >= MIN_SEPARATORS && !escapedWs) {
```

so a candidate was discarded if a backslash followed by `n`, `r` or `t` appeared
**anywhere** inside it. That is the right test for JSON-escape debris —
`rationalizing:\n\n` leaves the literal characters `g:\n\n`, and
`instructions:\n\n- Codex:` leaves `s:\n\n-` — but it is not a test for *those*
artifacts specifically, and any real path containing a directory whose name
begins with one of those three letters matches it just as well (`\tasks`,
`\node_modules`, `\temp`, `\new`). **Observed in this corpus**: four occurrences
of one real absolute path were dropped for exactly that reason — `c6bb424b`'s
subagent-notification path `…\tasks\ac0a05b49edbd8d64.output`, rejected because
`\t` begins `tasks`.

**The fix — one predicate, quoted verbatim from the source pasted below:**

```javascript
    const escapedWs = /\\[nrt](?![A-Za-z0-9_])/.test(cleaned);
```

A control character never begins a path-name run, so `\[nrt]` immediately
followed by a name character is separator + name (`\tasks`), while `\[nrt]`
followed by a non-name character is separator + escape (`g:\n\n`, `s:\n\n-`).

**Observed — six cases run against the predicate itself, both classes, `fail=0`**
(`predicate-check.mjs`, a throwaway harness kept in the same scratch directory):

| input | class | `#3339` rule | `#3340` rule |
|---|---|---|---|
| `g:\n\n` (from `rationalizing:\n\n`) | JSON-escape debris | rejects | rejects |
| `s:\n\n-` (from `instructions:\n\n- Codex:`) | JSON-escape debris | rejects | rejects |
| `…\claude\x\tasks\ac0a05b49edbd8d64.output` | real path, real `\tasks` dir | **rejects** | accepts |
| `C:\Claude\Projects\Axiom\node_modules\pkg\i.js` | real path, real `\node_modules` dir | **rejects** | accepts |
| `C:\Users\a\temp\f.txt` | real path, real `\temp` dir | **rejects** | accepts |
| `C:\Users\dudar\AppData\Local\Temp\x\t` | boundary: path *ends* in a one-character name | rejects | rejects |

The last row is a **residual, not a pass**: admitting `…\x\t` would require
knowing that `x\t` is a real directory name rather than an escape, and nothing in
the string says so. No such path occurs in this corpus, so it moves no number
here; it is listed because the fix narrows the old rule rather than proving the
class closed, and **Not tested** says so again from the other direction.

**Observed — all three revisions run over the whole corpus.** "No filter" is the
same source with the `!escapedWs` clause deleted, "#3339" is the predicate quoted
above, "#3340" is the source pasted below:

| revision | escape predicate | `PATH_SHAPE_REJECTS` | `pathsDistinct` `9eeee2f0`/`5193fe70`/`c6bb424b` | `pathsDistinct`, four `#3333` | `c6bb424b` H1 |
|---|---|---|---|---|---|
| no filter | none | `total=56` | `17/17/19` | `17/17/16/16` | `…\tasks\ac0a05b49edbd8d64.output` → **MISS** |
| #3339, as pasted then | `/\\[nrt]/` | `total=94` | `15/15/16` | `15/15/14/14` | `(none)` → no pick |
| #3340, pasted below | `/\\[nrt](?![A-Za-z0-9_])/` | `total=84` | `15/15/17` | `15/15/14/14` | `…\tasks\ac0a05b49edbd8d64.output` → **MISS** |

`56` is exactly the debris-only count (`U:\` and `C:\Program`, 4 occurrences × 7
transcripts × 2 passes), so **deleting** the filter is not the fix either: it
re-admits `g:\n\n` and `s:\n\n-`, which is how it reaches `pathsDistinct=17` on
`9eeee2f0` where the correct count is `15`. `84` is `42 × 2` — 42 debris
occurrences (6 per transcript × 7), 28 distinct candidates (4 per transcript) —
measured with a separate per-candidate probe rather than read off the counter.
The counter is **not** an occurrence count: it increments once per rejected
candidate per pass and the parser sweeps the corpus more than once, so the same
candidates print as `56` under one rule and `94` under another, and for `#3339`
the measured occurrence count is 46 (28 debris candidates plus 4 occurrences of
the real `.output` path in `c6bb424b`, each counted once per candidate).

**Observed — the fix moves exactly one transcript.** Diffing the `#3339` output
against the `#3340` output over all seven transcripts changes four lines, all in
`c6bb424b`'s block: the `TURN idx=30` line (`paths=0` → `paths=1`), its `Q2
pathsDistinct` (`16` → `17`), its `pathsUnderNoRoot` (`14` → `15`), and its `Q2
H1_lastTurnFirstPath` (`(none) => no pick` → that notification's `.output` path
`=> MISS`) — plus the counter total. The other six transcripts' blocks are
byte-identical between the two revisions, and H2's pick is unaffected either way.

**What this changes in the rest of the doc, and what it does not.** Four numbers
moved, all traceable to this one predicate: the reject-counter (Setup bullet and
the table above); `c6bb424b`'s H1 cell, which stops being a no-pick and becomes a
**MISS** with a measured cause (Finding 2, Misses item 1); the per-transcript
`pathsDistinct` line in Finding 2; and the two mention counts (the session's own
checkout `20/21/23` → `26/27/29` occurrences, the briefed tree "mentioned once" →
`7/5/5` occurrences but still `1` distinct path) in Finding 2 and Finding 3.
**Unchanged:** every rate in Finding 2's hit-rate table (H1 2/3, H2 3/3, H2r 0/3
inert, H3/H4/H5 0/3), the H3/H4/H5 winners and their causes, containment 3/3 in
Finding 3, and every transcript count in Finding 1. The correction narrows the
mention margin between the two trees from roughly 20:1 to roughly 4:1 without
changing which tree wins.

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
- **The path-shape false-reject bug this rework fixed was found by a
  spot-check, not by a test, and no check exists that the class is closed.**
  The corrected rule (`\[nrt]` counts as debris only when it is *not* followed
  by a name character) is justified against the real instances of both classes
  in this corpus, but a transcript carrying a different escape artifact, or a
  real directory name whose escape-lookalike segment is followed by a
  non-name character, is not represented here. See **Re-verification after
  #3340**.

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
  the session's own dispatching checkout is mentioned 26–29 times against
  the assigned root's 5–7 occurrences, so frequency and root-membership both
  point at the wrong tree on this corpus. (**Corrected by #3340**: this bullet
  printed `20–23` against `1`, the counts the pre-fix path-shape filter
  produced; no rate changed — see **Re-verification after #3340**.) 4 of the 7
  transcripts carry no assignment at all and are reported `n/a` rather than
  folded into any rate.
- **Q3 (containment):** on all 3 answerable transcripts, the assigned root
  is present in the transcript (1 distinct path each, 5–7 occurrences under
  the occurrence rule Finding 3 names), and no *second* worktree beyond the
  assigned root and the session's own dispatching checkout is mentioned.
  Whether the dispatching checkout counts as an "other" root is a labeling
  choice, not a number this spike can settle — reported both ways in
  Finding 3.
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
item 4). The **corrected** revision is kept outside every repo checkout at
`C:\Users\dudar\AppData\Local\Temp\open-engine-scratch\cline-3340-20260920-225641\parse-transcripts-fixed.mjs`
(`sha256 48B392E3B3140580A5315B889E47CC136A405D7BDE50E1F2AF42FD109165502C`);
reproduced here verbatim. #3339's own revision of the same file — the one whose
`escapedWs` predicate this pastes over — is at
`…\open-engine-scratch\cline-3339-20260920-105131\parse-transcripts.mjs`, and it
is the revision that printed the four counts corrected under
**Re-verification after #3340**. The paste below was re-extracted from this doc
and run on its own, and it reproduces every number in this doc.

```javascript
// Castwright#3340 - same throwaway spike tooling as #3339, with the path-shape
// false-reject in extractPaths() fixed (see `escapedWs` below). Kept OUTSIDE every checkout
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
    // a literal backslash followed by n/r/t sits inside a longer match - but
    // ONLY when that `\[nrt]` is not the start of a real directory name.
    // Corpus evidence, both classes: every genuine instance is followed by a
    // further escape (`g:\n\n`, `s:\n\n-`, from `rationalizing:\n\n` and
    // `instructions:\n\n- Codex:`), while a rejected-until-now real path
    // continues as an ordinary identifier (`...\tasks\ac0a05b49edbd8d64.output`,
    // i.e. `\t` + `a`). A control character never begins a path-name run, so
    // `\[nrt]` immediately followed by a name character is separator + name.
    const escapedWs = /\\[nrt](?![A-Za-z0-9_])/.test(cleaned);
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
