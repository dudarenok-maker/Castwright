# Castwright#3333 — can a dispatch set a subagent's `cwd`? (#3263 direction (c) reachability)

Empirical findings only. No guard change, no fix. Per the #3246/#3325 precedent
no regression test accompanies this spike, and that omission is stated
explicitly here. This is the direct successor to
`docs/ops/3263-guard-assignment-signal-findings.md` (#3325), which reproduced
the #3263 mismatch (dispatching-session `cwd` ≠ briefed worktree) on 3/3
`fix-agent` dispatches but explicitly did not attempt this question — its
Finding 5(c) says so directly: "this spike observed the *symptom* ... from
outside the harness, at the hook boundary, and made no attempt to inspect or
modify how the Agent tool itself decides a subagent's working directory."
This spike attempts exactly that, from inside the harness this time.

## Setup

- Worktree: `C:\Claude\Projects\wt-3263-cwd-dispatch-spike`, branch
  `docs/docs-3263-cwd-dispatch-spike` (both created by this spike, per the
  issue — this is the first child of #3263's dispatch-cwd chain).
- Throwaway logger: `hook-logger.mjs`, kept outside every repo checkout under
  the OS temp scratch directory
  (`...\open-engine-scratch\claude-3333-20260920-021407\probe\hook-logger.mjs`),
  never committed. Appends the entire raw stdin `PreToolUse` payload verbatim,
  one JSON line per firing, and always exits 0 (observation only, never a
  guard decision) — same idiom as #3325's logger, trimmed to just the payload
  capture since this spike does not need the env dump.
- Wiring: this worktree's own `.claude/agents/fix-agent.md` had its `hooks:`
  `PreToolUse` command temporarily repointed from the real
  `scripts/hooks/guard-worktree-write.mjs` to the throwaway logger, for the
  duration of the probes only. Reverted before commit — see acceptance item 5;
  `git diff main -- .claude/agents/fix-agent.md` is empty at commit time.
- Harness: `claude -p "<prompt>" --permission-mode bypassPermissions
  --output-format text`, launched from this worktree (`cwd` = the worktree
  root) via a `Start-Process`-free direct foreground call — this run's shell
  is not subject to the 30-second single-command cap other lanes' runners
  are, so no detached-and-poll wrapper was needed for either dispatch, which
  each completed in under a minute.
- Two independent top-level sessions were run, one per probe that needed a
  live dispatch (P1, P4). Each subagent was asked to do two things
  independently so the evidence does not depend on only one channel: (a) run
  a trivial read-only command (`Get-Location`, since the harness fires
  PowerShell tool calls on this box) whose `PreToolUse` payload the wired
  logger captures raw, and (b) report what it saw back through the top-level
  session's own final reply, so the subagent's own account of its working
  directory is available even where hook capture might not apply (see the
  P1 caveat below).
- P2 and P3 needed no dispatch: P2 is answered directly from this running
  session's own `Agent` tool schema (already visible to it, per the task);
  P3 is answered by reading `fix-agent.md`'s actual frontmatter directly and
  by fetching Anthropic's own subagent documentation
  (`https://code.claude.com/docs/en/sub-agents`, redirected from
  `https://docs.claude.com/en/docs/claude-code/sub-agents`).

## Finding 1 (P1) — `isolation: "worktree"` DOES scope `cwd` per dispatch, and it is independently visible from outside the subagent

**Decisive result: the dispatched `fix-agent`'s `cwd` was a freshly-created
worktree, not the dispatching session's own checkout — confirmed on two
independent channels for the same dispatch.**

Raw, verbatim, single-line `PreToolUse` payload captured by the wired logger
(reformatted only for this doc's line width is not applied — this is the
exact byte content the logger wrote):

```json
{"session_id":"b5a1be31-7f94-4441-b986-c1cebda324f3","transcript_path":"C:\\Users\\dudar\\.claude\\projects\\C--Claude-Projects-wt-3263-cwd-dispatch-spike\\b5a1be31-7f94-4441-b986-c1cebda324f3.jsonl","cwd":"C:\\Claude\\Projects\\Audiobook-Generator\\.claude\\worktrees\\agent-a5672e0bf6137163a","prompt_id":"d465a54e-8112-46f2-95b0-88600fa4c8fd","permission_mode":"bypassPermissions","agent_id":"a5672e0bf6137163a","agent_type":"fix-agent","hook_event_name":"PreToolUse","tool_name":"PowerShell","tool_input":{"command":"Get-Location","description":"Get current working directory"},"tool_use_id":"toolu_01QiHnwg9qnR8sF8s9sUvEnP"}
```

`cwd` is `C:\Claude\Projects\Audiobook-Generator\.claude\worktrees\agent-a5672e0bf6137163a` —
**neither** the dispatching session's own checkout
(`C:\Claude\Projects\wt-3263-cwd-dispatch-spike`) **nor** the primary
checkout (`C:\Claude\Projects\Audiobook-Generator` itself), but a distinct,
freshly-minted worktree path under `Audiobook-Generator\.claude\worktrees\`,
suffixed with the same id as `agent_id`. This is the mismatch's inverse of
#3325's Finding 3: there, `cwd` stayed at the dispatching session's checkout
regardless of where the subagent was briefed; here, `isolation: "worktree"`
visibly moved `cwd` to a location that is neither of those two, and did so in
a way an outside observer (this hook) can see.

**Independent confirmation via the subagent's own report** (the top-level
session's final reply, channel (b) from Setup): `REPORTED: C:\Claude\Projects\Audiobook-Generator\.claude\worktrees\agent-a5672e0bf6137163a` —
byte-identical to the hook payload's `cwd` value. Two independently-sourced
readings (the harness's own `PreToolUse` payload vs. the subagent's own
`Get-Location` output relayed back through the dispatching session) agree.

**Confirmed auto-cleanup, matching the documented behavior** (see Finding 3):
`git worktree list` run against the primary checkout immediately after this
dispatch returned no `Audiobook-Generator\.claude\worktrees\agent-*` entry —
the worktree was removed because the subagent made no changes (it only ran a
read-only `Get-Location`), exactly as the Agent tool's own `isolation`
parameter description states.

**A caveat this spike surfaces about how it got this evidence at all**: the
wired logger firing here was not guaranteed in advance. Per Finding 3 below,
Anthropic's own docs state an `isolation: "worktree"` dispatch gets "an
isolated copy of the repository branched by default from your default branch
... rather than the parent session's `HEAD`" — a fresh `git`-level checkout
that, if `fix-agent.md`'s hook wiring were re-read from *that* checkout, would
have used `main`'s committed (production) `guard-worktree-write.mjs`, not
this worktree's uncommitted logger edit, since the logger wiring was never
committed anywhere. **Observed, not assumed: the logger fired anyway** (the
payload above is proof), which means the subagent definition — including its
`hooks:` frontmatter — is resolved once from the *dispatching* session's
already-loaded configuration, not re-read from the isolated worktree's
on-disk `.claude/agents/fix-agent.md`. This is itself a finding, reported
here because it directly shapes what P5 can and cannot conclude: the isolated
worktree is scoped for the subagent's *file and git operations*, not for
which agent-definition file governs its hooks.

## Finding 2 (P2) — the `Agent` tool's own schema has no working-directory parameter

Reported verbatim, as visible to this running session's own tool list (no
harness source file was read for this — the schema is already present in this
session's own context, which is what the issue asks for: "as visible to a
running Claude Code session"):

```
parameters:
  description   (string)  — short description of the task
  isolation     (string, enum: "worktree" | "remote")
                — "Isolation mode. \"worktree\" creates a temporary git
                  worktree so the agent works on an isolated copy of the
                  repo. \"remote\" launches the agent in a remote cloud
                  environment (always runs in background; availability is
                  gated)."
  model         (string, enum: "sonnet" | "opus" | "haiku" | "fable")
                — optional model override for this agent call
  prompt        (string) — the task for the agent to perform
  run_in_background (boolean)
  subagent_type (string) — which agent type to use for this task
```

**No parameter names or describes a working directory, a path, or a root.**
`isolation` is the only field that touches the filesystem location a subagent
operates in at all, and its own description (quoted above, verbatim) frames
it as a binary choice of *isolation mode* ("worktree" or "remote"), not a
location the caller supplies — it names no existing path anywhere. There is
no `cwd`, `path`, `workingDirectory`, `root`, `dir`, or similarly-named
parameter of any kind.

## Finding 3 (P3) — `.claude/agents/*.md` frontmatter has no working-directory key, and the one isolation-related key is documented, not guessed

**`fix-agent.md`'s actual frontmatter, read directly off disk** (before any
of this spike's temporary edits):

```yaml
---
name: fix-agent
description: Fixes one narrowly-scoped incidental finding — one finding, one fix, one paired regression test — briefed from the report that surfaced it.
model: haiku
effort: medium
hooks:
  PreToolUse:
    - matcher: "Write|Edit|Bash|PowerShell|NotebookEdit"
      hooks:
        - type: command
          command: "node \"${CLAUDE_PROJECT_DIR}/scripts/hooks/guard-worktree-write.mjs\""
---
```

Keys present: `name`, `description`, `model`, `effort`, `hooks`. **None of
these names or otherwise concerns a working directory.**

**This was checked against Anthropic's own documentation, not guessed** —
fetched directly from `https://code.claude.com/docs/en/sub-agents` (the
canonical URL `https://docs.claude.com/en/docs/claude-code/sub-agents`
redirects there). The documentation names exactly one frontmatter field that
touches working-directory behavior at all, `isolation`, quoted verbatim:

> "Set to `worktree` to run the subagent in a temporary git worktree, giving
> it an isolated copy of the repository branched by default from your
> default branch rather than the parent session's `HEAD`. The worktree is
> automatically cleaned up if the subagent makes no changes."

And, on default (no `isolation` set) behavior, quoted verbatim:

> "A subagent starts in the main conversation's current working directory.
> Within a subagent, `cd` commands don't persist between Bash or PowerShell
> tool calls and don't affect the main conversation's working directory. To
> give the subagent an isolated copy of the repository instead, set
> `isolation: worktree`."

And on the failure mode if the isolated worktree disappears mid-run:

> "A subagent with `isolation: worktree` runs its Bash and PowerShell
> commands inside its worktree. A command whose working directory resolves
> to your main checkout instead, for example because the worktree directory
> was removed while the subagent was running, fails with an error."

**Explicitly stated rather than left implicit: there is no `cwd` or `path`
frontmatter field for subagents.** `isolation: worktree` is the only
documented lever, and per its own wording it creates a *new* worktree off the
*default branch* — it does not accept an existing path (an existing worktree,
for instance) as a target. This is the direct answer to the ticket's own P3
question ("Is there a documented or discoverable key that sets the
subagent's working directory?"): no — the only discoverable key
(`isolation`) is a mode selector with two fixed values, not a path input, and
this was confirmed against the actual shipped documentation rather than
inferred from behavior alone.

## Finding 4 (P4) — an already-running session's own `cd` does not change what a later dispatch inherits

**Result: no effect, observed directly, not inferred.** One session (`cwd` =
this worktree throughout) ran, in order: (1) an `Agent` dispatch (no
`isolation`) asked to report its own `Get-Location`; (2) a plain `Bash cd`
to a different absolute path (`/c/Users/dudar/AppData/Local/Temp`); (3) a
second `Agent` dispatch, same brief. Both dispatches' `PreToolUse` payloads,
captured raw by the wired logger:

```json
{"ts":"2026-09-20T02:21:59.440Z","raw":"{\"session_id\":\"41eacf8a-bc27-4ed5-a66a-7589a9a9928a\",\"transcript_path\":\"C:\\\\Users\\\\dudar\\\\.claude\\\\projects\\\\C--Claude-Projects-wt-3263-cwd-dispatch-spike\\\\41eacf8a-bc27-4ed5-a66a-7589a9a9928a.jsonl\",\"cwd\":\"C:\\\\Claude\\\\Projects\\\\wt-3263-cwd-dispatch-spike\",\"prompt_id\":\"18f67767-6aa7-448f-a45c-1c886ab4b33f\",\"permission_mode\":\"bypassPermissions\",\"agent_id\":\"a71fc54b8d439f393\",\"agent_type\":\"fix-agent\",\"hook_event_name\":\"PreToolUse\",\"tool_name\":\"PowerShell\",\"tool_input\":{\"command\":\"Get-Location\",\"description\":\"Get current working directory\"},\"tool_use_id\":\"toolu_01JNKY5K6ksuW3iXg8p6NfZh\"}"}
{"ts":"2026-09-20T02:22:13.016Z","raw":"{\"session_id\":\"41eacf8a-bc27-4ed5-a66a-7589a9a9928a\",\"transcript_path\":\"C:\\\\Users\\\\dudar\\\\.claude\\\\projects\\\\C--Claude-Projects-wt-3263-cwd-dispatch-spike\\\\41eacf8a-bc27-4ed5-a66a-7589a9a9928a.jsonl\",\"cwd\":\"C:\\\\Claude\\\\Projects\\\\wt-3263-cwd-dispatch-spike\",\"prompt_id\":\"18f67767-6aa7-448f-a45c-1c886ab4b33f\",\"permission_mode\":\"bypassPermissions\",\"agent_id\":\"ad03a5dd3c30789d0\",\"agent_type\":\"fix-agent\",\"hook_event_name\":\"PreToolUse\",\"tool_name\":\"PowerShell\",\"tool_input\":{\"command\":\"Get-Location\",\"description\":\"Get current working directory\"},\"tool_use_id\":\"toolu_011zab7QRA75vPeWSWzatVaG\"}"}
```

Both report `cwd` = `C:\Claude\Projects\wt-3263-cwd-dispatch-spike` — the
worktree the top-level session was launched in — **unchanged by the
intervening `cd`**. Distinct `agent_id`s (`a71fc54b8d439f393` vs
`ad03a5dd3c30789d0`) confirm these are two genuinely separate subagent
instances, not one process reporting twice. The top-level session's own
final reply corroborates the same result independently: `BEFORE:
C:\Claude\Projects\wt-3263-cwd-dispatch-spike` / `AFTER:
C:\Claude\Projects\wt-3263-cwd-dispatch-spike`.

This matches Finding 3's quoted documentation exactly — "A subagent starts
in the main conversation's current working directory" describes the
*session's* current working directory as the harness understands it (fixed
at session start, apparently), not a live-mutable value a `cd` inside a Bash
tool call can move. The practical, positive rule this leaves for a
coordinator, worth recording even though it is a negative result: **a
dispatch inherits wherever its session was launched, and nothing done inside
that session after launch — including a `cd`/`Set-Location` — changes it.**
The only lever this spike found that moves a subagent's `cwd` away from the
launch-time value at all is `isolation: worktree` (Finding 1), and that
lever moves it to a *new* worktree, not an arbitrary chosen path.

## Finding 5 (P5) — verdict: direction (c) is **partially reachable**, and the gap is precise

Per #3263's "The decision owed" section. One verdict, as instructed — not a
hedge across two:

**Direction (c) — an upstream fix at dispatch time — is reachable in the
narrow sense of "can a dispatch scope `cwd` away from the parent session's
own checkout," but not reachable in the sense #3263 actually needs, which is
"can a dispatch be aimed at an *existing, coordinator-chosen* worktree."**

What Finding 1 supports: the harness **does** have a real, working mechanism
that produces a `cwd` other than the dispatching session's checkout —
`isolation: "worktree"` — and that mechanism is independently observable
from the same `PreToolUse` hook boundary #3263 is worried about (the
resulting `cwd` is not garbage or absent; it is a real, verifiable path a
guard could check against). This directly answers the first half of P1's own
framing: "the harness demonstrably can scope `cwd` per dispatch."

What rules out the naive form of (c): per Finding 3's quoted documentation,
`isolation: worktree` **always creates a brand-new worktree off the default
branch** — it takes no path parameter (Finding 2: the `Agent` tool schema has
none) and no frontmatter key selects an existing directory (Finding 3: no
`cwd`/`path` key exists, documented or otherwise). #3263's actual guard
scenario is a coordinator that has already created and assigned a specific
worktree (e.g. `wt-3263-...`) and wants a subagent dispatched *there* — not
a fresh, unrelated worktree branched from `main`. Nothing observed in this
spike lets a caller name that existing path. So "reduces to how do we aim
that same mechanism at an existing tree," the reduction #3263's own text
invites if P1 came back positive, does not currently have an answer: the
mechanism exists, but its one knob is binary (on/off), not a path.

**Named for what remains unknown, not swept under the verdict**: whether the
Agent tool or the CLI exposes any *undocumented* way to point `isolation:
worktree` (or something like it) at a pre-existing worktree was not tested
here beyond what Findings 2 and 3 found in the documented/discoverable
surface — an internal flag or environment variable outside the schema and
the frontmatter spec could in principle exist and was not probed, because
probing internals beyond the documented interface was not this spike's
brief (see "Not tested" below).

## Not tested

- Whether `isolation: "worktree"`'s freshly-created worktree can be
  redirected to an existing path via any undocumented mechanism (an
  environment variable, a CLI flag, an internal setting) beyond the `Agent`
  tool's own schema (Finding 2) and the documented frontmatter surface
  (Finding 3) — this spike only checked the documented/discoverable surface,
  per its P2/P3 brief, not the harness's internal implementation.
- `isolation: "remote"` — out of scope for this spike (P1–P4 only name
  `"worktree"`), and it launches in a cloud environment rather than a local
  worktree at all, so it would not answer the local-worktree question #3263
  asks regardless.
- Whether a *third-party* mechanism outside `.claude/agents/*.md` and the
  `Agent` tool itself (a wrapper script, a different CLI entry point, an SDK
  call) can set a subagent's `cwd` directly — this spike only probed what a
  session dispatching through the normal `Agent` tool / `claude -p` path can
  reach, matching the issue's own framing ("can an `Agent(...)` dispatch be
  made to spawn a subagent whose `cwd` is a path we choose").
- Whether the observed "hooks load once from the dispatching session's
  config, not the isolated worktree's disk" behavior (the Finding 1 caveat)
  holds for `PostToolUse` or other hook events, or for hook commands that
  reference `${CLAUDE_PROJECT_DIR}` (which would resolve differently in the
  isolated worktree than in the dispatching session) — only `PreToolUse`
  with an absolute-path command was exercised here.
- Repeating Finding 4 with a `Set-Location`-equivalent issued from a
  PowerShell tool call rather than Bash — only Bash's `cd` was tested; the
  predecessor spike's own workaround for the #3263 mismatch already used
  PowerShell `Set-Location` *before launching a new top-level session*
  (which is a different case from this spike's "already-running session"
  question) and was not re-tested here.

## Conclusion

**Verdict (P5): direction (c) is reachable for "produce a `cwd` other than
the parent session's checkout" but not reachable, on anything found here,
for "aim a dispatch at a specific existing worktree."** Supported by Finding
1 (positive: `isolation: worktree` visibly moves `cwd`, confirmed on two
independent evidence channels) together with Findings 2 and 3 (negative: no
parameter or frontmatter key accepts a caller-chosen path). The operator's
conditional approval of direction (c) ("conditional on it being reachable")
is therefore only half satisfied: the mechanism the direction imagined
(steering a dispatch's `cwd`) exists, but not in the shape #3263 needs
(pointing it at a *pre-existing, coordinator-assigned* worktree rather than
a fresh one off `main`). The decision returns to the operator with this
specific gap named, per the issue's own framing that "a clean 'not reachable'
is a successful outcome" — this is closer to that than to a clean "yes,"
and direction (a) (parsing `transcript_path`, per #3325's Finding 4, itself
only a report of a candidate signal, not a built one) remains the fallback
#3263 named.

`git diff --name-only origin/main...HEAD` at commit time: only this file,
`docs/ops/3263-dispatch-cwd-findings.md`. `git diff main --
.claude/agents/fix-agent.md`: empty (the temporary logger wiring was
reverted). `git worktree list`: no leftover probe tree — the one worktree
this spike created (`isolation: worktree`'s own, Finding 1) was auto-removed
by the harness itself since no changes were made inside it, and no other
probe worktree was created by hand this time (unlike #3325, this spike's
`Get-Location` probes needed no throwaway directory of their own — the
`isolation: worktree` dispatch created and destroyed its own).
