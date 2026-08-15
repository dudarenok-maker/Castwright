# Agent effort-resolution probe (2026-08-14)

Run to decide whether `.claude/agents/*.md` can pin reasoning effort at all,
per [the effort-routing design](../superpowers/specs/2026-08-14-model-effort-routing-design.md).
The roster was gated behind this: a Negative would have cancelled it.

## Verdict

```
EFFORT_KEY_IS_SCHEMA_DECLARED: yes
EFFORT_LEGAL_VALUES: low | medium | high | xhigh | max | <integer>
TOOLS_KEY_HONOURED: yes — resolved list is surfaced in the agent-type listing
PROJECT_DEFINITIONS_LOADED: yes — .claude/agents/*.md become dispatchable types
AGENT_TOOL_HAS_EFFORT_PARAM: no
WORKFLOW_AGENT_HAS_EFFORT_OPT: yes — opts.effort, same five names
CLI_EFFORT_FLAGS_DECLARED: claude --effort | copilot --effort/--reasoning-effort | cline --thinking
```

`--help` on each CLI shows the flag is declared, not that it is honoured at
runtime in every configuration. A parallel session reports that `copilot
--effort` is not honoured when `--model auto` is set — reported, not
reproduced here.

## Method — and why the behavioural probe could not answer it

Three throwaway definitions were written to `.claude/agents/` and the harness
restarted: one with an invalid `effort:` value, one **positive control** with an
invalid `model:` value on a key that is definitely in the schema, and one
all-valid with `tools: Read, Glob, Grep`.

**All three loaded.** Including the positive control. That is what makes the
probe *inconclusive rather than confirmatory*: an unknown key and a known key
with a bad value both load silently, so the invalid-`effort:` definition
loading was never going to discriminate. The mechanism is two schema layers —
frontmatter parsing types `effort` as a loose string, and only the
resolved-agent layer enforces the enum.

The probe did answer one thing, because the listing renders the **resolved**
tool set rather than reporting on load-time acceptance: `tools:` is honoured,
and the all-valid definition enumerated as exactly `(Tools: Read, Glob, Grep)`
while the two controls, which set no `tools:`, did not.

## What actually settled it

`grep -a` over the harness's own bundle (`~/.local/share/claude/versions/2.1.232`):

```js
effort: Cs([Nr(["low","medium","high","xhigh","max"]), at().int()]).optional()
  .describe("Reasoning effort level for this agent. Either a named level or an integer")
```

Note the **integer branch**. The guard as first specced admitted only the five
names and would have failed a legal definition.

## The reusable lesson

**Read the harness's schema first.** Three revisions went into designing
behavioural probes for a question one `grep` of the binary answered. Behavioural
probing is for when there is no schema to read — not before checking whether
there is one.

The design was not *bad*: it carried a positive control, which is the only
reason the result was read as "inconclusive" rather than as confirmation. A
probe without that control would have shipped a false Positive.
