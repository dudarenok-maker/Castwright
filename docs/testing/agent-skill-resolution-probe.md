# Agent skill-resolution probe (2026-08-13)

Run to decide whether `.claude/skills/pr-review-gate/` needs mirroring for
other agents, per
[the PR review skill design](../superpowers/specs/2026-08-13-pr-review-skill-design.md).

## Method

Each agent was **driven directly and asked what it could see.** Only what an
agent actually reported counts. Two weaker methods were tried first and are
recorded here because both looked conclusive and were not:

- `npx skills list --json` shows this repo's three project skills with
  `"agents": ["Claude Code"]`. That field is the shared CLI's **install
  bookkeeping**, not proof of what any agent resolves.
- Grepping the Cline binary (`@cline/cli-windows-x64/bin/cline.exe`) returns
  `.claude/skills` ×3 and `.agents/skills` ×1. Positive evidence Cline reads
  *a* `.claude/skills`, but **silent on global vs workspace** — which is the
  only distinction that decides anything.

Cline was probed headlessly, with the repo as cwd:

```bash
cline -p -c "C:\Claude\Projects\wt-pr-review-skill" -t 240 \
  "List the skills available to you in this workspace. Do you see one named pr-review-gate?"
```

## Results

| Agent | Sees project `.claude/skills/`? | Evidence |
|---|---|---|
| Claude Code | **yes** | resolves this repo's three project skills today |
| Cline 3.0.54 | **no** | listed exactly the 23 global skills from `~/.agents/skills/`; answered `pr-review-gate: NO` |
| Gemini CLI, Copilot, Antigravity, Hermes | **not tested** | share `~/.agents/skills/` per the store's own docs; none was driven |

The Cline result is strong rather than vague: it did not merely fail to find
the skill, it returned the exact global set as a fingerprint.

## Cline's subagent

Asked directly, in the same session:

- **Dispatch:** yes — `spawn_agent`, plus `team_spawn_teammate` / `team_run_task`.
- **Context:** *"Fresh empty context. A dispatched sub-agent does not inherit
  our conversation history."* → satisfies the gate's independence requirement.
- **Model selection:** **no.** Neither tool takes a model parameter. Its own
  stderr disclosed the backing model as `deepseek-v4-flash`.

**So a Cline-run pass is genuinely independent but flash-tier.** It satisfies
the design's stated capability ("the strongest tier available to that agent"),
and this line exists so nobody records one as equivalent to an Opus-tier pass.

Caveat held openly: items 2 and 3 are the agent's **self-report about its own
harness**. Item 1 is stronger — a model can observe its own tool list — but
"my subagent starts cold" is a claim about runtime behaviour that was not
independently reproduced.

## Verdict

```
MIRROR_NEEDED:        Cline (via the global store, NOT a workspace path)
MIRROR_TARGET:        ~/.agents/skills/pr-review-gate/
CLINE_SUBAGENT_COLD:  yes (self-reported)
CLINE_TIER_SELECTABLE: no — observed deepseek-v4-flash
```

The design had assumed a **workspace** mirror. There is no workspace path to
mirror into: the only store Cline reads is outside the repo. The owner chose
the per-machine install step (`npm run skills:sync`) over dropping the mirror —
see plan Task 8, which carries the two consequences that follow (the drift
guard fails open because its target is in `$HOME`; relative links need a
provenance header).

## Incident during this probe

The first `cline` invocation silently self-updated 3.0.53 → 3.0.54 and left the
install broken mid-flight: `cline`, `cline.cmd` and `cline.ps1` disappeared
from `%APPDATA%\npm`, and the package lost its own `package.json`. Symptoms in
order were a working call, then `MODULE_NOT_FOUND`, then `command not found`.
`npm i -g cline` repaired it (EPERM warnings on the temp dir are cosmetic).
Suspect this before assuming a probe broke something.

## Second run — OWED, not yet performed (2026-08-14)

Decision 9 of [the effort-routing design](../superpowers/specs/2026-08-14-model-effort-routing-design.md)
mirrors `model-routing/SKILL.md` into `~/.agents/skills/` (proven — Cline reads
that store) but **deliberately does not mirror the six agent definitions**,
because nothing here establishes that Cline resolves them.

This run is owed before any definition is mirrored. Three questions:

1. Does Cline's `spawn_agent` accept a persona/definition **name**, or only an
   inline prompt?
2. Is `~/.agents/agents/` resolved as a definition store? (It does not exist
   today — checked directly.)
3. If a definition is found, is its **frontmatter honoured** — specifically
   `model:` and `effort:`?

**Do not mirror definitions on a partial answer.** Cline cannot select a
subagent's model (`CLINE_TIER_SELECTABLE: no — observed deepseek-v4-flash`),
so writing files carrying `model: opus` / `effort: xhigh` into a harness that
can honour neither produces a sync that reports files written and changes
nothing — a mirror that looks maintained and governs nothing. Mirror only what
the probe says lands.
