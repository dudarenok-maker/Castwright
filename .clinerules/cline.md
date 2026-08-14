# Cline project rules (Castwright / Audiobook-Generator)

Loaded by Cline each session. The full project context is in the root
`CLAUDE.md` (Cline reads it too) -- these are Cline-specific operational
prefs layered on top. Keep this minimal; move anything of general value into
`CLAUDE.md` instead.

## Commits (Conventional Commits, enforced by hooks)
- Subject format: `<type>(<scope>): <subject>`.
  - Types: `feat | fix | refactor | perf | test | docs | build | ci | chore`
  - Scopes (required except for `chore`): `frontend | server | sidecar | app |
    scripts | e2e | mocks | openapi | docs | deps | ci | ops`
  - Subject <= 100 chars. Breaking change = `!` before the colon
    (e.g. `feat(server)!: drop legacy field`).
  - Multi-line commit bodies end with a `Co-Authored-By:` trailer naming the
    agent (e.g. `Co-Authored-By: Cline <...>`).
- The `commit-msg` hook rejects malformed subjects; `pre-push` re-checks them,
  refuses force-push/deletion of `main`, and runs `verify:fast:branch`.

## Verify before commit / push
- `pre-commit` runs `npm run verify:fast:scoped` (scoped to STAGED files). Run
  it before staging so hooks pass on the first try.
- The fast local gate before pushing is `npm run verify:fast:branch`.
- Never bypass hooks with `--no-verify` for dev work -- it is reserved for
  CI-generated commits only (e.g. `.github/workflows/regen-visual-baselines.yml`).
- Cloud `verify.yml` is a required status check on `main` -- the real gate.

## Testing discipline (required, per CLAUDE.md)
- New behaviour ships a paired automated test. Bug fixes ship a regression test
  that fails before the fix and passes after. Never delete or `.skip` a test
  without an explicit replacement. UI cross-seam changes should land an e2e test.

## Execution model (sub-agent delivery — CLAUDE.md doctrine)
- All NON-TRIVIAL work is sub-agent-executed: the main thread coordinates,
  curates context, and judges; it does NOT produce hand-written task code.
  Only work clearing CLAUDE.md's trivial bar (nothing can break, nothing needs
  review) stays inline, plus validation (which is the main thread's job).
- Dispatch FRESH cold subagents per task (spawn_agent / team tools), briefed
  from the ticket/plan doc as the sole source of requirements — not forks that
  inherit session context.
- Per task: an implementer subagent, then a task-review subagent (spec + quality).
- Non-trivial specs/plans get an adversarial `assumption-checker` pass before
  the user approves; present its actual tagged output, not a paraphrase.
- Ship through the `pr-review-gate` / code-review pass; the PR needs
  `Closes #NN` / `Refs #NN`.
- CAPABILITY NOTE (honest, Cline-specific): Cline cannot select model tiers for
  subagents — they run on the configured session model. The repo's
  Haiku/Sonnet/Opus/`Fable` routing table (CLAUDE.md "Model routing") and its
  `.claude/worktrees` + `claude/wt-*` branch choreography are Claude-Code
  mechanics I can't reproduce verbatim. I follow the INTENT (fresh subagent
  execution + per-task review + review-gated ships), not those letter-level
  mechanics. Where tier choice would matter, say so and hand the decision to
  the user.

## Working style
- Surgical changes: fix what's broken, don't restyle what works. Match existing
  conventions. Keep edits minimal (see CLAUDE.md "Simplicity first").
