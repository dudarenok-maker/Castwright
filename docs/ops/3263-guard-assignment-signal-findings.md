# Castwright#3325 — what a `PreToolUse` hook can see that independently identifies the assigned worktree

Empirical findings only. No guard logic changed, no fix written. This is a
research spike; per the #3246 precedent that omission is intentional and is
stated explicitly here. This is the direct successor to
`docs/ops/3044-hook-mechanism-findings.md` (#3246), and its purpose is to
close the two gaps that doc named for itself: capture the *complete*
`PreToolUse` payload (not a chosen subset), and — for the first time —
reproduce the real #3263 failure shape (`cwd` ≠ the briefed worktree) instead
of the arranged one every previous run used.

## Setup

- Worktree: `C:\Claude\Projects\wt-3263-guard-gap-spike`, branch
  `docs/docs-3263-guard-gap-spike` (created by this chain's child 1; not
  created by this spike).
- Throwaway probe worktree **Y**: created for this spike only, under the OS
  temp scratch directory —
  `C:\Users\dudar\AppData\Local\Temp\open-engine-scratch\claude-3325-20260919-225612\probe\wt-y`
  — via `git worktree add <path> --detach` run from this worktree (**X**).
  Removed with `git worktree remove --force` once the probes finished; see
  acceptance item 8.
- Throwaway logger: a small Node script,
  `...\claude-3325-20260919-225612\probe\hook-logger.mjs`, kept outside every
  repo checkout, never committed. Unlike #3246's logger it does **not** record
  a chosen subset of keys — it appends the **entire raw stdin payload
  verbatim**, byte-for-byte, as one JSON line, so no field can be missed by a
  logger-side oversight. A second pass added an in-hook read of
  `transcript_path` itself (see Finding 4) to test readability *at hook-fire
  time*, not after the fact.
- Wiring: this worktree's own `.claude/agents/fix-agent.md` had its `hooks:`
  `PreToolUse` command temporarily repointed from the real
  `scripts/hooks/guard-worktree-write.mjs` to the throwaway logger, for the
  duration of the probes only. Reverted before commit — see acceptance item 7;
  `git diff main -- .claude/agents/fix-agent.md` is empty at commit time.
- Harness (adapted from #3246's, with the one change that matters for Q3):
  `claude -p "<prompt>" --permission-mode bypassPermissions --output-format
  text`, launched from **X** (`cwd` = this worktree) — **not** `Set-Location`'d
  into **Y** first, unlike #3246. The prompt instructed that top-level session
  to make exactly one `Agent({subagent_type: "fix-agent", ...})` call, briefed
  with **Y's absolute path** as its assigned working directory and told to run
  a trivial read-only command (`wc -l CLAUDE.md` / a PowerShell line-count
  equivalent) there. This is deliberately the #3263 mismatch shape: the
  dispatching session's own `cwd` is X, but the subagent is *briefed* at Y.
- Three independent dispatches were run this way (three separate `claude -p`
  processes, three separate sessions, three separate `fix-agent` instances) to
  check the finding wasn't a one-off. All three are reported below.

## Finding 1 — the complete payload (Q1)

**All eleven top-level keys were captured, with real values, across all three
dispatches**, closing #3246's explicit gap (`prompt_id`, `transcript_path`,
`permission_mode`, `tool_use_id` were "not captured and not claimed observed"
there):

`session_id`, `transcript_path`, `cwd`, `prompt_id`, `permission_mode`,
`agent_id`, `agent_type`, `hook_event_name`, `tool_name`, `tool_input`,
`tool_use_id`.

Raw, verbatim, single-line JSON as captured (dispatch 1 — reformatted only for
this doc's line width is not applied; this is the exact byte content the
logger wrote, one line, no truncation):

```json
{"session_id":"9eeee2f0-78ab-46ab-9eb3-91d293b533fd","transcript_path":"C:\\Users\\dudar\\.claude\\projects\\C--Claude-Projects-wt-3263-guard-gap-spike\\9eeee2f0-78ab-46ab-9eb3-91d293b533fd.jsonl","cwd":"C:\\Claude\\Projects\\wt-3263-guard-gap-spike","prompt_id":"518cce5d-dc19-41fe-aca0-c6d52d1c1302","permission_mode":"bypassPermissions","agent_id":"ab4b539f35f8fd2cf","agent_type":"fix-agent","hook_event_name":"PreToolUse","tool_name":"PowerShell","tool_input":{"command":"(Get-Content \"C:\\Users\\dudar\\AppData\\Local\\Temp\\open-engine-scratch\\claude-3325-20260919-225612\\probe\\wt-y\\CLAUDE.md\" | Measure-Object -Line).Lines","description":"Count lines in CLAUDE.md at the specified worktree path"},"tool_use_id":"toolu_017uZbE9mnmbYw73YbFxVmg9"}
```

This is also the payload used for the Q3 evidence below (Finding 3) — the
same line satisfies both acceptance item 1 and item 2.

`prompt_id`: a UUID, one per user-prompt turn in the dispatching session (not
per subagent — see below). `permission_mode`: a string, `"bypassPermissions"`
in this harness since that is what the launcher used; presumably reflects
whatever the top-level session's own mode is. `tool_use_id`: a
`toolu_`-prefixed opaque id, matching the tool-call id the model itself
generated for that `Agent(...)`-dispatched tool call. `transcript_path`: see
Finding 4 — not just present, independently confirmed readable and populated
at hook-fire time.

`agent_id` differed across all three dispatches (`ab4b539f35f8fd2cf`,
`a98a11f874376c5df`, `ac0a05b49edbd8d64`) and `session_id` likewise
(`9eeee2f0…`, `5193fe70…`, `c6bb424b…`) — each dispatch is a genuinely
distinct subagent instance and top-level session, as expected.

## Finding 2 — the hook process environment (Q2)

Captured, for all three dispatches, the full sorted list of environment
variable **names** visible to the hook process (69–70 names per dispatch,
stable set across dispatches modulo ordering), and the values of every
`CLAUDE_*`/`ANTHROPIC_*` variable whose name did not match
`/key|token|secret|credential/i` (that filter excluded
`CLAUDE_CODE_MESSAGING_TOKEN` from value capture; its name is still listed).

Observed names (one representative dispatch; the set was the same, modulo
process-specific noise, across all three):

```
AI_AGENT, ALLUSERSPROFILE, ANDROID_HOME, APPDATA, CLAUDECODE,
CLAUDE_CODE_CHILD_SESSION, CLAUDE_CODE_ENTRYPOINT, CLAUDE_CODE_EXECPATH,
CLAUDE_CODE_MAX_SUBAGENTS_PER_SESSION, CLAUDE_CODE_MESSAGING_SOCKET,
CLAUDE_CODE_MESSAGING_TOKEN, CLAUDE_CODE_SESSION_ATTENDED,
CLAUDE_CODE_SESSION_ID, CLAUDE_EFFORT, CLAUDE_PID, CLAUDE_PROJECT_DIR,
COMMONPROGRAMFILES, COMPUTERNAME, COMSPEC, COREPACK_ENABLE_AUTO_PIN,
CUDA_HOME, CUDA_PATH, CUDA_PATH_V12_4, CommonProgramFiles(x86),
CommonProgramW6432, DriverData, EXEPATH, GITHUB_PERSONAL_ACCESS_TOKEN,
GIT_EDITOR, HOME, HOMEDRIVE, HOMEPATH, LOCALAPPDATA, LOGONSERVER, MSYSTEM,
NUMBER_OF_PROCESSORS, NoDefaultCurrentDirectoryInExePath, OE_CLAIM_ISSUE,
OE_CLAIM_WHY, OE_RUN_SCRATCH, OLDPWD, OLLAMA_DEBUG,
OLLAMA_FLASH_ATTENTION, OLLAMA_KV_CACHE_TYPE, OLLAMA_NUM_PARALLEL,
OLLAMA_SCHED_SPREAD, OS, OneDrive, PATH, PATHEXT, PLINK_PROTOCOL,
PROCESSOR_ARCHITECTURE, PROCESSOR_IDENTIFIER, PROCESSOR_LEVEL,
PROCESSOR_REVISION, PROGRAMFILES, PSExecutionPolicyPreference,
PSModulePath, PUBLIC, PWD, ProgramData, ProgramFiles(x86), ProgramW6432,
QWEN_CLOUD_API_KEY, SHELL, SHLVL, SYSTEMDRIVE, SYSTEMROOT, TEMP, TERM,
TMP, USERDOMAIN, USERDOMAIN_ROAMINGPROFILE, USERNAME, WINDIR, _
```

`CLAUDE_*`/`ANTHROPIC_*` values observed (representative — `CLAUDE_PID` and
`CLAUDE_CODE_SESSION_ID` values are given per-dispatch below since they are
the ones that vary):

```
CLAUDE_CODE_CHILD_SESSION=1
CLAUDE_CODE_ENTRYPOINT=sdk-cli
CLAUDE_CODE_EXECPATH=C:\Users\dudar\.local\bin\claude.exe
CLAUDE_CODE_MAX_SUBAGENTS_PER_SESSION=1000
CLAUDE_CODE_MESSAGING_SOCKET=\\.\pipe\LOCAL\cc-msg-0490d7839ce1d567c108bdcdc7d1dfb4
CLAUDE_CODE_SESSION_ATTENDED=0
CLAUDE_EFFORT=medium
CLAUDE_PROJECT_DIR=C:/Claude/Projects/wt-3263-guard-gap-spike
```

**Answer to the question this finding exists for: nothing in the hook
process's environment scopes to one `Agent(...)` dispatch.** Checked
directly, not inferred: `CLAUDE_CODE_SESSION_ID`'s value was compared against
the same-dispatch payload's own `session_id` field for all three dispatches,
and it matched exactly every time —

| dispatch | payload `session_id` | env `CLAUDE_CODE_SESSION_ID` |
|---|---|---|
| 1 | `9eeee2f0-78ab-46ab-9eb3-91d293b533fd` | `9eeee2f0-78ab-46ab-9eb3-91d293b533fd` |
| 2 | `5193fe70-26c8-489a-963b-23e5495f56b2` | `5193fe70-26c8-489a-963b-23e5495f56b2` |
| 3 (two tool calls, same session) | `c6bb424b-1396-4473-8f2f-019453ffbcc5` | `c6bb424b-1396-4473-8f2f-019453ffbcc5` (both) |

— i.e. the env var mirrors the **top-level dispatching session**, not the
individual `fix-agent` instance the hook fired for. `agent_id` (the value that
*does* vary per subagent instance, per Finding 1) does not appear anywhere in
the environment under any name. `CLAUDE_PID` likewise tracks the top-level
`claude -p` process (`40044`, `40064`, `40412` — one value per dispatch,
identical across both tool calls within dispatch 3's single session), not a
per-subagent process. This **confirms** #3263's statement that no existing
precedent for a per-dispatch-scoped signal exists anywhere observable from
this hook — checked by direct comparison, not assumed.

## Finding 3 — reproducing the #3263 mismatch shape (Q3)

**Core result: on 3 out of 3 independent dispatches, `cwd` was the
dispatching session's own checkout (X), never the briefed worktree (Y).**

| dispatch | `agent_type` | `cwd` observed | Y (the briefed path) | match? |
|---|---|---|---|---|
| 1 | `fix-agent` | `C:\Claude\Projects\wt-3263-guard-gap-spike` | `...\probe\wt-y` | **NO — mismatch** |
| 2 | `fix-agent` | `C:\Claude\Projects\wt-3263-guard-gap-spike` | `...\probe\wt-y` | **NO — mismatch** |
| 3 (both tool calls) | `fix-agent` | `C:\Claude\Projects\wt-3263-guard-gap-spike` | `...\probe\wt-y` | **NO — mismatch** |

This is the exact shape #3263 describes and #3246 could not produce (its
harness `Set-Location`'d into the assigned worktree before dispatch, which
made `cwd` correct by construction). Here the dispatching session's `cwd` was
never changed — the top-level session stayed at **X** throughout, and the
subagent it dispatched, briefed in plain-language prose at **Y**'s absolute
path, nonetheless ran with `cwd` = **X**. The subagent's *own tool calls*
prove it was genuinely trying to operate against Y — `tool_input.command` in
every captured call references Y's absolute path directly (`Get-Content
"...\probe\wt-y\CLAUDE.md"`, `cd .../probe/wt-y && wc -l CLAUDE.md`, `wc -l
"...\probe\wt-y\CLAUDE.md"`) — while the hook's own `cwd` field, sourced
independently by the harness rather than the model, stayed at X the whole
time. `agent_type` reads `fix-agent` in all three, and `cwd`'s value visibly
differs from Y's path on its face, matching acceptance items 1–2 exactly.

Read together with `guard-worktree-write.mjs`'s `resolveAssignedRoot`
(`scripts/hooks/guard-worktree-write.mjs:134-136`): in this exact shape the
guard resolves the *wrong* root as "assigned" (X, not Y) — precisely the
inversion #3263 describes, now observed directly rather than reasoned about.
A real write the subagent made *inside Y* would be evaluated against X as the
assigned root and denied as foreign; a write into X itself would be allowed
as "the assigned worktree."

## Finding 4 — is `transcript_path` a candidate signal? (Q4)

**Report only, per the issue's instruction — nothing built on this.**

`transcript_path` is present in every payload (Finding 1). Beyond presence,
this spike directly tested **readability at hook-fire time**, not just
after the session ended: the second and third dispatches' logger read
`transcript_path` from *inside the hook process*, synchronously, in the same
invocation that received the `PreToolUse` payload on stdin — not a
post-hoc check run later by this spike's own tooling.

```json
{"transcriptProbe":{"tp":"C:\\Users\\dudar\\.claude\\projects\\C--Claude-Projects-wt-3263-guard-gap-spike\\5193fe70-26c8-489a-963b-23e5495f56b2.jsonl","readOk":true,"byteLen":427378,"containsWtY":true}}
{"transcriptProbe":{"tp":"C:\\Users\\dudar\\.claude\\projects\\C--Claude-Projects-wt-3263-guard-gap-spike\\c6bb424b-1396-4473-8f2f-019453ffbcc5.jsonl","readOk":true,"byteLen":565876,"containsWtY":true}}
```

**Both attempts succeeded**: the file existed, was readable with a plain
`fs.readFileSync`, and — the part that matters for the candidate-signal
question — **its contents included the dispatching brief text naming the
assigned worktree** (`containsWtY: true`; the literal substring `wt-y`,
Y's own directory name from the briefing prose, was present in the transcript
body). This means the file is not just a log of the subagent's own actions —
it (or at least the session transcript at this path) carries the text of the
prompt that named the intended target, which `cwd` alone does not.

Two things this spike did **not** establish, and are named here rather than
implied: (1) whether `transcript_path` in every payload points at the
**top-level dispatching session's** transcript specifically (as opposed to a
per-subagent transcript) — the two probed paths both matched the session_id
already seen in that dispatch's own `session_id` field (Finding 1), which is
the top-level session's id, so on this evidence it is the *dispatching
session's* transcript, not a subagent-private one; (2) whether the *literal
briefed path* (vs. just the directory's short name, `wt-y`) appears verbatim
and parseable — `containsWtY` only tested substring presence of the short
name, not a structured extraction of the full absolute path from transcript
JSON. A consumer wanting to *use* this signal would need to parse the
transcript's JSONL structure to reliably extract the most recent user-turn
text and pull a path out of it — a nontrivial parse, and squarely the kind of
"whether to use it" decision this doc is told not to make.

## Finding 5 — implications for the three candidate directions (Q5)

Per #3263's "The decision owed" section. Reporting only — no direction is
chosen here.

**(a) A per-dispatch signal set by the coordinator** (env var or marker file
keyed by `agent_id`/`session_id`): **ruled out as currently existing, still
open as a thing to build.** Finding 2 directly confirms — by comparison, not
assumption — that nothing currently in the hook's environment is scoped to
one `Agent(...)` dispatch; `CLAUDE_CODE_SESSION_ID` and `CLAUDE_PID` both
track the top-level session, and `agent_id` (the one value that *does*
identify the specific subagent) appears nowhere in the environment. #3263's
statement that "no existing precedent... anywhere in this repo's `.claude/`
or `scripts/hooks/`" is confirmed for the environment specifically. Whether
the harness exposes *some other* mechanism to set a per-dispatch marker
(e.g. a working-directory-scoped file, since `cwd` itself — though not
trustworthy as ground truth — is at least stable per dispatch) is not tested
here; this spike only probed the environment and the payload, not the
harness's internal dispatch machinery.

**(b) A structural rule over `listKnownCheckoutRoots()` treating `cwd` as
advisory**: **supported as viable, with a caveat this spike surfaces.**
Finding 3 shows `cwd` in the mismatch case still resolves to a *real, known*
checkout root (X) — it is not garbage or absent, it is just the *wrong*
known root. A rule that denies any target whose resolved root fails to match
some independently-verified root would still need a source for that
independent verification; Finding 2 shows the environment does not supply
one, and Finding 4 shows `transcript_path` (if parsed) might. So (b) as
literally stated — "deny anything `cwd` doesn't independently verify" — has
no independent verification source currently available from this hook's
inputs alone; it would need pairing with something like (a) or (c), or with a
parsed reading of (Finding 4)'s transcript signal, to have a positive
"verified" case at all, as opposed to only ever landing on "cannot verify,
deny."

**(c) An upstream fix at dispatch time** (ensure `Agent(...)` calls briefing
an existing worktree genuinely spawn with `cwd` set to that path): **neither
supported nor ruled out by this spike's observations** — this spike observed
the *symptom* (payload `cwd` = X across 3/3 mismatched dispatches) from
outside the harness, at the hook boundary, and made no attempt to inspect or
modify how the Agent tool itself decides a subagent's working directory. That
inspection is a different kind of work (harness/dispatch-path investigation,
not a `PreToolUse` payload capture) and is explicitly out of this spike's
scope per the issue's "Not in scope" section.

## Not tested

- The alternative JSON-stdout deny shape
  (`{"hookSpecificOutput": {"permissionDecision": "deny", ...}}`) — not
  exercised here, same as #3246; this spike's logger always exits 0
  (observation only, never denies).
- The global `.claude/settings.json` hook path — not wired or tested, same
  reason as #3246: the frontmatter mechanism is what fires for this dispatch
  shape and was sufficient for every question this spike needed to answer.
- Whether `transcript_path` structurally scopes to the top-level session vs.
  a per-subagent transcript beyond the session-id match noted in Finding 4 —
  not independently confirmed by inspecting the harness, only inferred from
  the matching session ids across the two probed dispatches.
- Full structured extraction of the briefed absolute path from
  `transcript_path`'s JSONL contents (Finding 4) — only a short-substring
  presence check (`wt-y`) was performed, not a parse that reliably pulls out
  a full path from arbitrary prompt phrasing.
- `agent_id`'s stability across multiple tool calls *within* one subagent
  instance was reconfirmed here only for dispatch 3 (both its Bash calls
  carried the same `agent_id`, consistent with #3246's own Finding 3 note for
  a Write+Edit pair) — not exhaustively re-probed beyond that.
- Any command-injection or shell-quoting behavior of `tool_input.command` for
  the Bash/PowerShell payloads observed here — out of scope for this spike,
  which only reads the payload, and already covered by
  `guard-worktree-write.mjs`'s own `normalizeSeparators`/`pathSpellings`
  logic and its test suite.
- Whether the mismatch shape reproduces identically when the dispatching
  session's own `cwd` is somewhere other than a known checkout root (e.g. the
  OS temp directory itself) — all three dispatches here launched from X, a
  known checkout root, matching #3263's own confirmed-repro setup.

## Conclusion

No direction is chosen — that decision belongs to the operator, per #3263's
"The decision owed" and this issue's explicit instruction not to pick one.
What this spike adds beyond #3246 and #3263's own review-pass repro:

1. **The full payload is now confirmed**, not partially captured — all four
   previously-unclaimed fields (`prompt_id`, `transcript_path`,
   `permission_mode`, `tool_use_id`) are present and populated (Finding 1).
2. **The real #3263 failure shape is now directly observed**, 3/3, with raw
   verbatim payload evidence — not just reasoned about from #3044's incident
   record or #3261's arranged-`cwd` review repro (Finding 3).
3. **The environment carries no per-dispatch signal today** — confirmed by
   direct comparison, closing the open question in #3263's own text
   (Finding 2), which bears on candidate (a).
4. **`transcript_path` is a real, readable, non-empty candidate signal** that
   does carry the assignment text — untested for structural extraction
   reliability, and explicitly not built on here (Finding 4), which bears on
   candidates (a) and (b).

All three candidate directions in #3263 remain live; Finding 5 states what
this spike's observations support, rule out, or leave unknown for each.
