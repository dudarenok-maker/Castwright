# Castwright#3044 step 1 — PreToolUse hook mechanism for Agent-tool subagent dispatch

Empirical findings only. No guard logic is built here (that is the next
child). This is a research spike; no regression test accompanies it, and per
the acceptance criteria that omission is intentional and stated explicitly.

## Setup

- Worktree: `C:\Claude\Projects\wt-3044-worktree-write-guard`, branch
  `chore/ops-3044-worktree-write-guard`.
- Confirmed `.claude/agents/fix-agent.md` is git-tracked (`.gitignore` line 44
  is `.claude/*`, but lines 45–46 re-include `.claude/skills/` and
  `.claude/agents/`; `git check-ignore -v .claude/agents/fix-agent.md` exits
  non-zero — not ignored). `.claude/settings.json` and
  `.claude/settings.local.json` both fall under the `.claude/*` ignore and are
  NOT tracked; `.claude/settings.json` does not currently exist in this
  worktree at all (only in the primary checkout, with just
  `{"enabledPlugins": {...}}`, no `hooks` key).
- Test harness: a real, separate Claude Code process spawned non-interactively
  with `claude -p "<prompt>" --permission-mode bypassPermissions
  --output-format text`, `Set-Location`'d into this worktree first so its
  `.claude/agents/fix-agent.md` frontmatter is the one that loads. That
  top-level session was then told, in its prompt, to dispatch exactly one
  `Agent({subagent_type: "fix-agent", ...})` call — this reproduces a genuine
  Agent-tool subagent dispatch, not a simulation of one.
- Throwaway hook script: a small Python script (kept outside the repo, under
  the run's OS-temp scratch directory, never committed) that reads the
  `PreToolUse` JSON off stdin and appends one JSON line per invocation to a
  log file, also outside the repo.

## Finding 1 — which mechanism fires

**A `hooks:` key in the subagent's own frontmatter (`.claude/agents/fix-agent.md`) fires for that subagent's tool calls, including when it is dispatched via the Agent tool from a separate top-level session.** No restart, no global `settings.json` entry, and no separate registration step was needed — the moment the frontmatter carried the `hooks:` key, the very next `claude -p` invocation that dispatched `fix-agent` triggered it. The global-`settings.json` fallback (test-plan step 5) was therefore never needed and was not exercised — see "Not tested" below.

Wired as:

```yaml
hooks:
  PreToolUse:
    - matcher: "Write|Edit|Bash"
      hooks:
        - type: command
          command: "python \"<scratch>\\hook-logger.py\""
```

Observed log lines (from the throwaway logger, one JSON object per fired
hook call, reformatted here for readability — the actual bytes were single-line
JSON):

```json
{"ts": "2026-09-17T19:57:42.527211Z", "hook_event_name": "PreToolUse", "tool_name": "Bash", "agent_id": "a35e4a0a51da78415", "agent_type": "fix-agent", "cwd": "C:\\Claude\\Projects\\wt-3044-worktree-write-guard", "session_id": "6a2984d8-6d3c-4561-8d20-10c946ec53a6", "tool_input": {"command": "wc -l CLAUDE.md", "description": "Count lines in CLAUDE.md"}}
```

```json
{"ts": "2026-09-17T19:58:16.416503Z", "hook_event_name": "PreToolUse", "tool_name": "Write", "agent_id": "a6f54bf21b87b65fe", "agent_type": "fix-agent", "cwd": "C:\\Claude\\Projects\\wt-3044-worktree-write-guard", "session_id": "e5740107-3ab7-4e53-a0c4-c404e62b9c0f", "tool_input": {"file_path": "C:\\Claude\\Projects\\wt-3044-worktree-write-guard\\.claude\\hooktest-scratch.txt", "content": "hello"}}
```

```json
{"ts": "2026-09-17T19:58:19.810104Z", "hook_event_name": "PreToolUse", "tool_name": "Edit", "agent_id": "a6f54bf21b87b65fe", "agent_type": "fix-agent", "cwd": "C:\\Claude\\Projects\\wt-3044-worktree-write-guard", "session_id": "e5740107-3ab7-4e53-a0c4-c404e62b9c0f", "tool_input": {"file_path": "C:\\Claude\\Projects\\wt-3044-worktree-write-guard\\.claude\\hooktest-scratch.txt", "old_string": "hello", "new_string": "hello world", "replace_all": false}}
```

Each fired exactly once, matching exactly one tool call from the dispatched
subagent — no duplicate firings, and no firing was observed for the
top-level session's own tool calls (the top-level session used the Agent
tool itself, which is not in the `Write|Edit|Bash` matcher, and made no other
tool calls in these runs).

## Finding 2 — observed `PreToolUse` payload shape

Confirmed real fields from the JSON above, for all three tool types tested:

- Common to every call: `hook_event_name` (`"PreToolUse"`), `tool_name`,
  `tool_input`, `cwd` (the subagent's working directory — the worktree, not
  the scratch dir, IN THIS SPIKE'S SETUP; this was arranged by `Set-Location`
  into the worktree before launching `claude -p`, per "Setup" above, not a
  property this spike observed a subagent guarantee on its own — see
  [Castwright#3263](https://github.com/dudarenok-maker/Castwright/issues/3263),
  filed from PR #3261's own review pass, for the real failure mode this
  arrangement doesn't rule out — measured at 87.6% of real dispatches and
  closed 2026-09-22 by deriving the assigned root from `transcript_path`
  instead, see `docs/ops/3263-transcript-signal-measurement.md`), `session_id`,
  plus **`agent_id`** and
  **`agent_type`**,
  which were present and populated (`agent_type: "fix-agent"`) specifically
  because these calls came from inside a subagent — this is the field a
  future global hook would use to distinguish subagent calls from main-session
  calls.
- **`Bash`**: `tool_input = {"command": "wc -l CLAUDE.md", "description": "Count lines in CLAUDE.md"}`.
  The full shell command string is present **verbatim** in `tool_input.command`
  — not paraphrased, not truncated, not tokenized. `description` is a
  secondary free-text field the model supplies, not derived from the command.
- **`Write`**: `tool_input = {"file_path": "<abs path>", "content": "hello"}`
  — absolute path and full file content, verbatim.
- **`Edit`**: `tool_input = {"file_path": "<abs path>", "old_string": "hello", "new_string": "hello world", "replace_all": false}`.

(Fields such as `prompt_id`, `transcript_path`, `permission_mode`,
`tool_use_id` were not captured by the throwaway logger — it only recorded a
subset of keys — but were not needed to answer the acceptance questions above
and are not claimed as directly observed here.)

## Finding 3 — deny mechanism confirmed to work

Tested, not assumed. Swapped the hook command to a second throwaway script
that unconditionally writes stderr and exits 2 for any matched call, then
re-ran the exact same `wc -l CLAUDE.md` dispatch through `fix-agent`.

**Observed result: the Bash call was blocked before execution.** The
dispatching (top-level) session reported it verbatim:

```
The subagent's `wc -l CLAUDE.md` call was blocked, not executed. It was denied by a PreToolUse:Bash hook with this message:

PreToolUse:Bash hook error: [python "<scratch>\hook-deny.py"]: ... (Python deprecation warning noise) ...
Blocked by throwaway test hook: this tool call is denied for issue #3246 testing.
```

The throwaway deny-script's own log confirms it fired and made the deny
decision:

```
2026-09-17T19:58:51.562000Z tool_name=Bash -> DENYING
```

So **exit code 2 + stderr text is a confirmed-working deny mechanism for a
frontmatter-scoped `PreToolUse` hook on a subagent dispatch** — the stderr
text is what surfaced back through the subagent's tool-result and was visible
to the dispatching session. The `wc -l CLAUDE.md` command itself never ran
(no corresponding successful tool result was reported, only the denial).

## Not tested

- The alternative JSON-stdout deny shape
  (`{"hookSpecificOutput": {"permissionDecision": "deny", ...}}`) was **not**
  tested — only the exit-code-2 path was exercised, since it already
  confirmed denial works and the test-plan's step 5 (global `settings.json`
  fallback) was skipped as unnecessary once step 2–4 (frontmatter) succeeded
  on the first attempt. If the next child wants the JSON-shape variant
  confirmed too (e.g. because it wants a `permissionDecisionReason` shown
  differently to the model), that is owed, not assumed.
- The global `.claude/settings.json` hook path was not wired or tested at
  all, for the same reason — the frontmatter mechanism worked on first try
  for the exact case being verified (subagent dispatched via the Agent tool
  from a separate top-level session), so there was no negative result to work
  around.
- `agent_id` was observed to differ between the top-level session's own
  subagent instance IDs across separate dispatches (as expected — a new
  subagent instance per dispatch) but its stability *within* a single
  subagent's multiple tool calls was only confirmed for the Write+Edit pair
  in Finding 1 (same `agent_id` for both), not exhaustively probed further.

## Conclusion for the next child (real guard logic)

Scope the real `PreToolUse` guard as a `hooks:` frontmatter key on
`fix-agent.md` (and any other subagent role the guard should cover) rather
than a global `settings.json` hook — it is the confirmed-working, correctly
narrow mechanism, it deregisters automatically when the subagent finishes
(no manual cleanup risk), and `tool_input.file_path` (Write/Edit) /
`tool_input.command` (Bash) plus `cwd` are all present and exactly what a
path-outside-worktree check needs. Use exit code 2 with a descriptive stderr
message for the deny path — confirmed to actually block the call and to
surface its reason back to the dispatching session.
