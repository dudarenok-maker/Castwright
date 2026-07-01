---
status: active
shipped: null
owner: null
---

# Model routing & review gates

> Status: active — mechanized gate (issue-linkage) is tested + CI-enforced; the other five gates are self-enforced prose, not locked by automated tests, so `stable` (which this repo's INDEX.md lifecycle defines as "behavior locked by automated tests") does not yet apply.
> Key files: `CLAUDE.md`, `.claude/skills/model-routing/SKILL.md`, `scripts/validate-pr-issue-link.mjs`, `.github/workflows/pr-issue-link.yml`
> URL surface: n/a — process/tooling change, no application UI
> OpenAPI ops: none

## Benefit / Rationale

- **User:** n/a — this repo has one operator (the user); "user" and "developer" are the same person for this change.
- **Technical:** subagent/session model choice stops defaulting to habit; spec/plan and PR review gates run by default instead of only when asked; a PR without a linked GitHub issue is mechanically caught, not just conventionally expected.
- **Architectural:** locks in a durable place for routing + review-gate rules (`.claude/skills/model-routing/SKILL.md`) that future sessions read without re-deriving; opens the precedent (Decision 11) of mechanizing a self-enforced convention when it's cheap enough to be worth it.

## Architectural impact

- **New seams**: a new project skill directory (`.claude/skills/model-routing/`); a new validator module shape (`scripts/validate-*.mjs` + CLI mode) alongside the existing `validate-commit-msg.mjs`; a second always-on `pull_request` workflow alongside `pr-title-lint.yml`.
- **Invariants preserved**: no application code, test suite, or product surface changes (spec "Out of scope"); `brainstorming`/`writing-plans` (global plugin skills) are not edited, only project-level `CLAUDE.md` / `.claude/skills/` content, which the standing instruction-precedence rule already gives priority over skill defaults.
- **Migration story**: none — no stored data shape changes.
- **Reversibility**: every CLAUDE.md edit and the skill file are plain markdown, revertible with a single `git revert`. The workflow is inert until wired into a required-status-check ruleset (Task 7 Step 8, the manual step — see the implementation plan); if that step is reverted, the check becomes advisory-only again, not broken.

## Invariants to preserve

1. The four-tier routing table (`CLAUDE.md` "Model routing" section, and the full copy in `.claude/skills/model-routing/SKILL.md`) never routes a fork — forks always inherit the dispatching session's model (`Agent` tool schema; see Decision 1 in the design spec).
2. `scripts/validate-pr-issue-link.mjs`'s `hasIssueLink()` strips fenced + inline code spans before testing for `Closes #NN` / `Refs #NN` — a backtick-wrapped keyword must not satisfy the check (it doesn't actually auto-close on GitHub either).
3. `.github/workflows/pr-issue-link.yml`'s job `name:` field ("Verify PR body links a GitHub issue") is the exact string referenced by the required-status-check ruleset (Task 7 Step 8, the manual step) — renaming the job without updating the ruleset silently breaks the required-check binding.

## Test plan

### Automated coverage

- `node:test` (`scripts/tests/validate-pr-issue-link.test.mjs`) — asserts `hasIssueLink()` accepts `Closes #NN`/`Refs #NN` (case-insensitive, amid other text), and rejects missing links, near-miss words ("Closed", "Closesnt", "encloses"), and backtick/fenced-code-wrapped occurrences. Auto-discovered by `npm run test:hooks` via `scripts/run-hooks-tests.mjs`'s `scripts/tests/*.test.mjs` glob.
- **Explicitly untested** (self-enforced prose, per the design spec's "Out of scope" honesty note): the routing table's tier selection, the escalation ladder, session-drift flagging, both review-gate loops' triggers/caps, task-tracking granularity, and `/compact` checkpoint flagging. None of these are checkable by an automated test — they're judged by the dispatching session in the moment. Only Decision 11's issue-linkage slice is mechanized.

### Manual acceptance walkthrough (process walkthrough, not a UI click-through)

1. Open a PR against `main` with a body that does **not** contain `Closes` or `Refs` → expect the `Verify PR body links a GitHub issue` check to fail (red ✗) on the PR.
2. Edit the PR body to add `Closes #<some real issue number>` (plain, not inside backticks) → expect the check to re-run (the `edited` trigger) and turn green.
3. Confirm `pr-title-lint.yml` (`.github/workflows/pr-title-lint.yml`) is unaffected — both workflows run independently on the same PR events.
4. After Task 7 Step 8 (the manual ruleset step) is applied: repeat step 1 and confirm the PR's merge button is now disabled/blocked by GitHub until the check passes (not just red).

## Out of scope

Everything the design spec's own "Out of scope" section names: application code, the `assumption-checker`/`code-review` skill implementations themselves, and full mechanization of the other five gates. See [docs/superpowers/specs/2026-07-01-model-routing-and-review-gates-design.md](../superpowers/specs/2026-07-01-model-routing-and-review-gates-design.md).

## Ship notes

(Filled in once merged: shipped date, commit SHA.)
