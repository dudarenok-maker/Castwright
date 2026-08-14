# Cline project rules (Castwright / Audiobook-Generator)

Loaded by Cline each session. The canonical context is the root `CLAUDE.md`
and `CONTRIBUTING.md` -- Cline reads both, so nothing here restates them. This
file carries only two kinds of rule: ones that are **Cline-specific**, and ones
that are **costly if missed** and easy to lose in 140 KB of prose. Keep it that
way -- anything of general value belongs in `CLAUDE.md` instead.

## Cline-specific

- **Skills resolve from `~/.agents/skills/` only.** Cline does not read a
  workspace `.claude/skills/` (probed 2026-08-13,
  `docs/testing/agent-skill-resolution-probe.md`). Re-run `npm run skills:sync`
  after any change under `.claude/skills/pr-review-gate/`. It is a per-machine
  step: the target is under `$HOME`, so CI cannot run it and a fresh clone has
  no mirror.
- **Model tiers are not selectable.** Subagents run on the configured session
  model, so CLAUDE.md's "Model routing" table (Haiku / Sonnet / Opus / Fable)
  and its `.claude/worktrees` + `claude/wt-*` branch choreography are
  Claude-Code mechanics I cannot reproduce verbatim. Follow the INTENT -- fresh
  cold subagents per task, per-task review, review-gated ships -- and where a
  tier choice would genuinely change the outcome, say so and hand the decision
  to the user.
- **This is a Windows box running PowerShell 5.1.** No `&&` / `||` chaining
  (use `;` or `if ($?) { ... }`), no ternary / `??` / `?.`. `head`, `tail`,
  `which`, and `touch` do not exist -- use `Get-Content -TotalCount N` /
  `-Tail N` and `(Get-Command x).Source`. A here-string's closing `'@` must sit
  at column 0, and an em dash inside a `.ps1` is a parse terminator.

## Never do these

- **Never commit to `main`.** Every change -- including a one-line doc fix --
  reaches `main` through a branch and a PR; `main`'s required status checks
  reject anything else. Branches are `<type>/<scope>-<slug>`.
- **Never hand-edit a generated file:** `src/lib/api-types.ts` (regenerate via
  `npm run openapi:types`), `docs/BACKLOG.md` (`npm run backlog:sync`),
  `server/.env.example` (`npm run config:sync`).
- **Never bypass a hook with `--no-verify`.** Triage instead: caused by my
  change -> fix it in the same commit; pre-existing (the same test fails on
  `main`) -> surface it to the user and do NOT fold the fix in; suspected flake
  -> re-run that test alone once and name it. `--no-verify` is reserved for
  CI-generated commits (`.github/workflows/regen-visual-baselines.yml`).
- **Never treat hook output in a fresh worktree as proof of verification** --
  see the first trap below.

## Traps that fail silently

- **A fresh worktree's git hooks do nothing, and say nothing.**
  `core.hooksPath` is inherited but resolves per-worktree, and `.husky/_` is
  git-ignored, so a new checkout gives git no hook to run: commit-msg
  validation and the whole pre-push battery vanish, silently. Fix it before the
  first commit with `npx husky`, then junction BOTH `node_modules` and
  `server/node_modules` from the primary checkout (missing the second fails the
  server legs with "vitest not found"). Simplest path is
  `node scripts/wt-new.mjs <type>/<scope>-<slug>`, which does all of it plus
  non-clashing ports.
- **`.claude/` is git-ignored wholesale** -- `.gitignore` has `.claude/*` with
  only `!.claude/skills/` re-included -- so a new file under it is silently
  skipped by `git add` and never reaches the PR. Confirm with
  `git status --short` after adding one.
- **Git-ignored artifacts (`brand/`, `mockups/`, marketing captures) are
  produced in the primary checkout**, never in a worktree: they do not travel
  with the branch and worktree teardown destroys them.

## Findings are fixed, not filed

A defect or chore surfaced in passing is fixed in the same round, with its
paired test, and declared in the PR body ("Also fixed, found in passing: ...").
Filing an issue records the fix; it never substitutes for it. The one thing
that defers a finding is a genuine design pass -- the fix has more than one
defensible outcome and something has to choose between them -- and then the
issue names the decision that is owed. "It would expand this PR", "it's
pre-existing", "it needs its own test", and "it's only a chore" are all void.
See CLAUDE.md "Incidental findings: report, fix, record".

## Gates a PR must clear

- Commit subjects follow Conventional Commits. The exact type and scope
  vocabulary lives in CONTRIBUTING.md "Allowed types" / "Allowed scopes" and is
  enforced by `scripts/validate-commit-msg.mjs` -- read it there rather than
  copying the lists around, because they change.
- `commit-msg` validates the subject. `pre-push` refuses force-push or deletion
  of `main`, re-validates every pushed subject (so bypassing `commit-msg` buys
  nothing), then runs `npm run verify:fast:branch` unless the push is
  docs-only.
- Run `npm run verify:fast:scoped` before staging and `npm run
  verify:fast:branch` before pushing, so the hooks pass on the first try.
- The **PR title** must itself match the commit-subject format
  (`pr-title-lint.yml`), and the **PR body** must carry a literal `Closes #NN`
  or `Refs #NN` (`pr-issue-link.yml`). Both are required status checks -- a
  missing issue link blocks merge outright. File the issue if none exists.
- A non-trivial spec or plan takes an adversarial `assumption-checker` pass
  before the user is asked to approve it; present its actual output, not a
  paraphrase.
- Cloud `verify.yml` is the real enforcement gate. Every PR that is not
  docs-only also takes the `pr-review-gate` pass before merge.

## Every change owes

- **A paired automated test.** New behaviour -> a new test. Bug fix -> a
  regression test that fails before the fix and passes after. Never delete or
  `.skip` a test without a named replacement. UI changes crossing
  router/redux/layout seams land a Playwright spec under `e2e/`.
- **Both release-notes files, in the same PR:** an entry in
  `docs/release-notes-next.md` and a matching user-facing, brand-voice line in
  the in-progress section at the top of `RELEASE_NOTES.md`. Skip only when the
  change has no shippable delta, and say so explicitly rather than omitting it
  silently.
- **An on-box acceptance row** when it ships behaviour only real hardware can
  prove (a live GPU, a real sidecar, a real analyzer, a real book). Recording
  blocks the merge; running does not. All three surfaces move together -- see
  CLAUDE.md "Before-shipping checklist" step 3.

## Working style

- Surgical changes: fix what's broken, don't restyle what works. Match the
  surrounding conventions even where you would write it differently. The seam
  is defect / chore / taste -- the first two get fixed, the third is never
  touched.
- Simplicity first: the minimum code that solves the problem. No speculative
  abstractions, no unrequested configurability.
- All non-trivial work is sub-agent-executed: the main thread coordinates,
  curates context, and judges. Trivial means nothing can break and nothing
  needs review -- if you would want a review pass on it, it is not trivial.
