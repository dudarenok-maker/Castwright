# Castwright#3354 — H2 against the fix-agent-into-pre-existing-worktree dispatch shape

Measurement only, per the ticket's own instruction: no guard code change, no
design recommendation. **HIT or MISS, with reasoning.**

> **Superseded as shipping justification (2026-09-22).** The corpus behind this
> doc and behind `3263-transcript-extraction-feasibility.md` is 4 transcripts,
> all single-turn, and its "3/3 HIT" was promoted into a shipping argument for
> PR #3358 with that caveat dropped. PR #3358's review pass caught it. The
> guard's behaviour is now justified by
> [`3263-transcript-signal-measurement.md`](3263-transcript-signal-measurement.md)
> — 715 real transcripts scored against an independent ground truth — which
> found the bare H2 rule measured here to be 76.5% precise, not 100%. Read this
> doc as the record of one dispatch shape, not as evidence about the heuristic
> in general.

## What this closes

`docs/ops/3263-transcript-extraction-feasibility.md` (#3339/#3340/#3341,
docs-only PR #3348, still open) validated H2 against a 7-transcript corpus, but
its own `## Not tested` section named the gap explicitly: all 3 *answerable*
transcripts in that corpus share one dispatch shape — a single-turn probe from
#3325's spike, dispatched into a **freshly-created** worktree. None are the
shape that actually broke in production and motivated #3263 in the first
place: a `fix-agent` briefed at an **already-existing** worktree (#3263's
2026-09-19 comments, both quoted below). This doc supplies one real transcript
of that missing shape and scores it the same way.

## The dispatch

- **Target worktree** (pre-existing, not created by this probe):
  `C:\Claude\Projects\wt-3272-pipeline-floor-throttle`, on branch
  `fix/scripts-3272-pipeline-floor-throttle`. Confirmed idle before dispatch:
  `git -C C:\Claude\Projects\Audiobook-Generator worktree list` showed it
  checked out; its owning issue, Castwright#3272, was open with **no
  assignee** at dispatch time — no other lane's ticket was actively claimed
  against it.
- **subagent_type**: the ticket asked for `fix-agent` (or `implementer` as
  fallback). **Both were attempted first and both failed**: `Agent type
  'fix-agent' not found` and `Agent type 'implementer' not found` — the
  dispatching session for this measurement is the Open Engine queue-heartbeat
  session, rooted at a scratch temp directory (`Is a git repository: false`),
  not at `C:\Claude\Projects\Audiobook-Generator`. Those two agent types are
  defined in that repo's `.claude/agents/*.md` and are only registered for a
  session whose own root is that repo (confirmed present on disk:
  `C:\Claude\Projects\Audiobook-Generator\.claude\agents\fix-agent.md` and
  `...\implementer.md`). **Fell back to `general-purpose`** — same underlying
  Claude Code `Agent(...)` dispatch mechanism, no `isolation` set, briefed at
  the same pre-existing worktree, with tool access at least as broad as
  `fix-agent`'s. This substitution is itself a finding: it is not possible to
  reproduce the *exact* production subagent_type from every session this
  fix might eventually run in — see the Discussion section below.
- **Brief** (read-only, nothing to revert): "read `CLAUDE.md` in this worktree
  and report its first heading." No `Set-Location` into the target tree first
  — dispatched from the queue-heartbeat session's own unrelated cwd, per the
  ticket's explicit instruction not to take that shortcut.
- **Result**: the subagent read
  `C:\Claude\Projects\wt-3272-pipeline-floor-throttle\CLAUDE.md` and reported
  its first heading, `# Project context for Claude Code`. No files modified —
  a pure Read, so nothing needed reverting. No guard denial observed (the
  general-purpose fallback carries no `guard-worktree-write.mjs` hook the way
  `fix-agent` would in-repo — see Discussion).

## Locating the transcript — two candidate files, not one

This is the first and largest structural difference from the existing
3-transcript corpus, so it is reported before Q2/Q3: **the dispatch does not
appear as a single file the way #3325's probes did.**

| File | Role |
|---|---|
| `C:\Users\dudar\.claude\projects\C--Users-dudar-AppData-Local-Temp-open-engine-ringer-oe-heartbeat-claude-3354-20260921-081052-oe-heartbeat-claude\d78961ad-373f-4ae1-80f5-82286ab1c404.jsonl` | the **dispatching** session's own transcript (845 KB, 171 entries) |
| `...\d78961ad-373f-4ae1-80f5-82286ab1c404\subagents\agent-aee3d97f828c02eb4.jsonl` | the **dispatched subagent's own, separate** transcript (210 KB, 17 entries) |

The existing 7-transcript corpus never had to make this choice: all 7 entries
were each their *own* standalone top-level session (#3325's and #3333's own
spikes each dispatched into a session that had no parent to nest under), so
"the transcript for this dispatch" was unambiguous. Here, the dispatching
session is the OE queue-heartbeat session that was already running before the
dispatch and kept running after it — the `Agent(...)` call is one tool
use/tool-result pair inside a much longer, unrelated conversation, and the
subagent's own turns are recorded in a wholly separate file the harness
creates for it (`<dispatcher-session>\subagents\agent-<agentId>.jsonl`).

**Both were extracted and scored** (full output: parser run below) because
which one a real `PreToolUse` hook's `transcript_path` would resolve to is
exactly the open question this measurement bears on, and the two give
opposite answers.

## Q2 — extraction

Parser: `docs/ops/3263-transcript-extraction-feasibility.md`'s `## Parser
source` section (the #3340-corrected version), copied verbatim except the
`CORPUS` array (data, not logic — see that file's own header comment) into
`parse-transcripts-3354.mjs`, kept outside every checkout at
`C:\Users\dudar\AppData\Local\Temp\open-engine-scratch\claude-3354-20260921-081052\parse-transcripts-3354.mjs`.
Ground truth (`briefed`) for both entries:
`C:\Claude\Projects\wt-3272-pipeline-floor-throttle`.

### Against the dispatcher's own transcript (`d78961ad-...jsonl`)

```
Q0 kb=845 entries=171
Q1TURNS n=2   <- only 2 of 171 entries are "prompt turns" by the parser's own
                 definition (type:"user" AND non-empty text content); neither
                 is the Agent dispatch itself.
Q2 pathsDistinct=52 guardRootsCovered=10 cwdRootsCovered=1 pathsUnderNoRoot=28
Q2 assignedPathAmongPaths=YES (2)
Q2 H1_lastTurnFirstPath=C:\Users\dudar\.claude\skills\open-agent-engine => MISS
Q2 H2_lastSdkTurnFirstPath=C:\Users\dudar\.claude\skills\open-agent-engine => MISS
Q2 H2r_lastSdkTurnFirstDeclaredRootPath=C:\Claude\Projects\Audiobook-Generator => MISS
Q2 H3_mostFrequent=...\oe-heartbeat-claude => MISS
Q2 H4_mostFrequentDeclaredRootPath=...\oe-heartbeat-claude => MISS
Q2 H5_labeled=...\oe-heartbeat-claude => MISS
```

**All six heuristics MISS**, and not narrowly: the assigned root is among the
transcript's paths (`assignedPathAmongPaths=YES (2)`), but every heuristic
picks something else, because the `Agent(...)` dispatch's brief text never
becomes a `promptText`-bearing "user" turn in the parser's sense. It surfaces
as a `tool_use` block inside an *assistant* message (the dispatch call) and a
`tool_result` block inside the following *user*-typed entry — and
`isPromptTurn()` requires `type === 'user'` with `promptText(e).trim().length
> 0`, where `promptText()` reads only `content` blocks of `type: 'text'`.
Neither the tool_use's JSON `input` nor the tool_result's structured content
qualifies. The two turns the parser *does* find (idx 4 and 21) are this
session's own launch instructions and skill content — genuinely unrelated to
the dispatch. **This is a harder failure than "wrong pick": the signal is not
merely outranked, it is invisible to every heuristic that operates on
`promptText`-bearing turns**, because that is not how the harness records a
same-session `Agent(...)` dispatch.

### Against the subagent's own transcript (`agent-aee3d97f828c02eb4.jsonl`)

```
Q0 kb=210 entries=17
Q1TURNS n=1
  TURN idx=0 promptSource=(absent) turnOrigin=(absent) sidechain=true chars=507 paths=2 first=C:\Claude\Projects\wt-3272-pipeline-floor-throttle
  EXCERPT "You are briefed to work at the existing worktree C:\Claude\Projects\wt-3272-pipeline-floor-throttle (this worktree already exists and is checked out on branch fix/scripts-3272-pipe"
Q2 pathsDistinct=7 guardRootsCovered=1 cwdRootsCovered=1 pathsUnderNoRoot=4
Q2 assignedPathAmongPaths=YES (2)
Q2 H1_lastTurnFirstPath=C:\Claude\Projects\wt-3272-pipeline-floor-throttle => HIT
Q2 H2_lastSdkTurnFirstPath=C:\Claude\Projects\wt-3272-pipeline-floor-throttle => HIT
Q2 H2r_lastSdkTurnFirstDeclaredRootPath=C:\Claude\Projects\wt-3272-pipeline-floor-throttle => HIT
Q2 H3_mostFrequent=...\oe-heartbeat-claude => MISS
Q2 H4_mostFrequentDeclaredRootPath=...\oe-heartbeat-claude => MISS
Q2 H5_labeled=...\oe-heartbeat-claude => MISS
```

**H1, H2 and H2r all HIT.** This transcript has exactly one prompt-bearing
turn — the brief itself — and its first absolute path is the assigned
worktree, so the "first path in the (only) turn" heuristics land directly on
it. H3/H4/H5 miss: the most-mentioned path across the whole subagent
transcript is the harness's own `cwd` (the dispatcher's unrelated scratch
directory, mentioned in every one of the subagent's 17 entries' metadata —
`CWDROOTS ... cwd=...oe-heartbeat-claude entries=17`), and no `worktree:`/`cwd:`-style
label pattern matched the brief's prose ("briefed to work at the existing
worktree X" has no `:`/`=` immediately before the path, so `labeledPaths()`'s
regex does not fire).

**H2 verdict for this ticket's own Q2 question: HIT — but only when scored
against the subagent's own transcript file, not the dispatcher's.**

## Q3 — containment (subagent transcript, the one H2 actually hits on)

- Assigned root mentioned: **YES**, 2 occurrences (the worktree path itself
  once, `...\CLAUDE.md` once).
- Other known guard-checkout roots mentioned: **0**
  (`Q3 otherGuardRootsMentioned=0`) — this dispatch's own turns never mention
  `Audiobook-Generator` or any other worktree.
- Other session-`cwd` roots mentioned: **1** — the dispatching queue-heartbeat
  session's own scratch cwd, present because it is recorded on every entry's
  `cwd` metadata field, not because the subagent's own text mentions it.

Compare to the existing corpus's 3 answerable entries (Finding 3): those also
scored `guardRootsCovered=0` beyond the assigned root itself. This transcript
is consistent with that pattern — a single-turn, narrowly-briefed probe stays
narrowly contained regardless of dispatch shape.

## Structural differences from the existing 3-transcript corpus (acceptance item 5)

1. **File location and count.** The existing corpus: one file per dispatch,
   each a standalone top-level session
   (`<encoded-cwd>\<session-id>.jsonl`). This dispatch: **two** candidate
   files — the long-lived dispatcher's own transcript (which never records
   the brief as parseable prompt text at all) and a separate, short,
   subagent-only transcript nested under
   `<dispatcher-session>\subagents\agent-<agentId>.jsonl`. Which one a real
   `PreToolUse` hook's `transcript_path` resolves to determines whether H2
   is a HIT or a total miss — this doc could not establish that from outside
   a session where the guard hook is actually wired (see Discussion).
2. **`cwd` never moves to the target.** Every entry in the subagent's own
   transcript — all 17, including the one holding the brief — carries `cwd`
   equal to the *dispatching* session's cwd, never the assigned worktree. This
   matches #3263's own second comment verbatim: *"Its `PreToolUse` payload
   `cwd` was the primary checkout, so the guard denied every write to the
   correct worktree."* This transcript reproduces that exact `cwd` mismatch
   mechanically, independent of any hook firing — it is a property of how the
   harness populates `cwd` on dispatched-agent transcript entries, not
   something a hook computes.
3. **Turn count and shape.** The 3 answerable corpus entries were themselves
   single-turn dispatches — `docs/ops/3263-transcript-extraction-feasibility.md`'s
   `## Not tested` section says so directly ("*all sharing the same dispatch
   shape (a `[claude][verify]`-style single-turn dispatch…)*"), and so does
   this doc's own `## What this closes` above. This transcript has exactly
   **one** prompt-bearing turn too — the brief — because the task was
   deliberately trivial (single Read, no back-and-forth). So H2's "first path
   in the most recent turn" and "first path in the only turn" collapse to the
   same computation, and this measurement adds a **fourth single-turn**
   transcript rather than the multi-turn one the source doc's gap named.

   **This is the load-bearing gap, not a footnote** — corrected 2026-09-22
   after PR #3358's review pass. An earlier revision of this bullet asserted
   the corpus entries "each had a longer turn sequence (a real multi-step
   probe)" and concluded the single-turn case "does not change the
   heuristic's logic". Both halves were wrong. The subsequent 715-transcript
   measurement (`docs/ops/3263-transcript-signal-measurement.md`) found that
   on multi-turn transcripts a newest-turn-first scan lands on a later
   injected turn — typically a skill preamble rooted at the primary
   checkout — rather than on the brief, and that single-vs-multi-turn is
   precisely the variable separating "most recent turn" from "the brief". No
   conclusion in this doc survives being generalised past the single-turn
   shape it measured.
4. **Path phrasing.** The assigned path in this transcript appears inside a
   sentence — "briefed to work at the existing worktree `C:\...`
   (this worktree already exists...)" — with a parenthetical immediately
   after it, not as a bare path or a `label: path` pair. `extractPaths()`'s
   regex still isolates it correctly (paths=2, first path correct), and the
   trailing `)` is stripped by the existing punctuation-trim rule
   (`cleaned.replace(/[.,;:)\]}]+$/, '')`), so this phrasing difference did
   **not** change the H2 outcome — but it is worth naming because a
   differently-punctuated brief (e.g. a path followed immediately by a
   comma-separated clause with another absolute path before it) could.

## Discussion (not a design recommendation — reasoning only, per the ticket's scope)

This measurement could not dispatch as `fix-agent` itself, so it could not
observe a real `PreToolUse` guard denial or a real `transcript_path` value
firsthand — both require a session rooted at
`C:\Claude\Projects\Audiobook-Generator` (or one of its worktrees), where
`.claude/agents/fix-agent.md` is registered and `.claude/settings*` presumably
wires the guard hook. The two production occurrences quoted in #3263's
2026-09-19 comments *were* dispatched that way (a `fix-agent`, no `isolation`,
briefed at a pre-existing worktree, from a session with a real `cwd` mismatch)
— structurally identical to this measurement's dispatch mechanics (same
`Agent(...)` call shape, same missing `isolation`, same target-is-pre-existing
condition, same resulting `cwd`-equals-dispatcher-not-target property) even
though the `subagent_type` differs. That the `cwd` mismatch reproduces
mechanically outside the guarded repo, using a different `subagent_type`, on a
different day, from a different dispatching session, is itself evidence the
underlying cause is a harness property (how the SDK populates the subagent's
transcript metadata), not something specific to `fix-agent`'s own
configuration.

Whether `transcript_path` in a real `PreToolUse` payload resolves to the
subagent's own file (where H2 hits, per this measurement) or to the
dispatcher's (where it does not) is the one fact this doc could not settle
directly, and is exactly the reachability question the next design pass on
#3263 needs answered before choosing between direction (a) and the
alternatives — not something to infer from this doc's own struture.

## Acceptance checklist

1. Real transcript named — session id `d78961ad-373f-4ae1-80f5-82286ab1c404`
   (dispatcher) and subagent id `aee3d97f828c02eb4` (file
   `agent-aee3d97f828c02eb4.jsonl`), both paths given above. Not synthesized,
   not hand-edited.
2. Dispatch target confirmed pre-existing:
   `C:\Claude\Projects\wt-3272-pipeline-floor-throttle`, checked out before
   this ticket started, not created by this probe (`isolation` was not set on
   the `Agent(...)` call).
3. Q2 reported for both candidate files, same shape as the existing doc's
   table (distinct paths, ground truth, present, per-heuristic pick and
   score).
4. Q3 reported separately from Q2, for the transcript H2 actually hits on.
5. Structural differences from the 3-entry corpus named explicitly (four of
   them, above), independent of whether they changed the H2 outcome.
6. Output lands in this new file; `docs/ops/3263-transcript-extraction-feasibility.md`
   was not edited.
7. `git status --porcelain` for this commit shows only this new file.
8. No design recommendation: **HIT** (subagent transcript) / effectively
   **unreachable** (dispatcher transcript) — reasoning above, no guard code
   touched, no direction chosen.

## Parser invocation

```
node C:\Users\dudar\AppData\Local\Temp\open-engine-scratch\claude-3354-20260921-081052\parse-transcripts-3354.mjs
```

Exit code `0`, full output (`KNOWN_ROOTS` block, both corpus entries, the
trailing `PATH_SHAPE_REJECTS`/`DONE` lines) captured at run time; the Q1/Q2/Q3
lines relevant to this doc's claims are quoted verbatim above.
