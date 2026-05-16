# Contributing

How to land changes on this repo without stepping on yourself (or on a parallel
agent run). Two rules — the **branching model** keeps work isolated until it's
ready to merge, and the **commit convention** makes the history greppable by
area. The commit convention is enforced by a git hook; the branching model is
soft convention.

## TL;DR

- Cut every change on a branch named `<type>/<scope>-<slug>` (e.g. `feat/server-batch-retry`).
- Every commit subject MUST be `<type>(<scope>): <subject>` — `chore: <subject>` is the no-scope catch-all. A pre-commit-msg hook rejects anything else.
- Long-running parallel work goes in a `git worktree`, not a second clone. Reconcile multiple agent branches via an `integration/<date>` branch with `npm run verify` between merges.
- `main` is always shippable. `npm run verify` is the pre-push gate.

## Branching model

Trunk-based with short-lived feature branches, isolated per agent via worktrees.

### Branch naming

`<type>/<scope>-<short-slug>`

```
feat/server-batch-retry
fix/frontend-voice-swatch-click
refactor/sidecar-synth-pipeline
docs/docs-plan-38
```

Both `<type>` and `<scope>` come from the [commit-convention vocabulary](#commit-convention).
The slug is whatever short hyphenated name makes the branch easy to find — the
slug does NOT have to mirror the eventual commit subject.

### Lifetime

- Target **< 1 week**, ideally a single agent run.
- Rebase onto `main` instead of merging `main` into your branch (linear history is
  easier to bisect by scope tag).
- Delete the branch after merge.

### Worktrees for parallel work

When two or more agents (or you + an agent) need to work in parallel, use
`git worktree` so each has its own working copy off the shared `.git`:

```powershell
# From the repo root:
git worktree add ../wt-server-retry feat/server-batch-retry
git worktree add ../wt-frontend-fix  fix/frontend-voice-swatch-click

# When the branch lands and you no longer need the checkout:
git worktree remove ../wt-server-retry
```

The Agent tool's `isolation: "worktree"` setting does exactly this for you when
delegating work — prefer it over running multiple agents on the same checkout.

### Scope discipline > merge magic

Conflicts are avoided by **agreeing what each branch touches**, not by clever
merge tooling. Two parallel branches should have near-disjoint file sets:

| Scope      | File set                                             |
| ---------- | ---------------------------------------------------- |
| `frontend` | `src/`                                                |
| `server`   | `server/src/`                                         |
| `sidecar`  | `server/tts-sidecar/`                                 |
| `scripts`  | `scripts/`                                            |
| `e2e`      | `e2e/`                                                |
| `mocks`    | `src/mocks/`                                          |
| `openapi`  | `openapi.yaml` + regenerated `src/lib/api-types.ts`   |
| `docs`     | `docs/`, `CLAUDE.md`, `README.md`, `CONTRIBUTING.md`  |
| `deps`     | `package.json`, lockfile, sub-package `package.json`s |
| `ci`       | `.husky/`, future GH Actions workflows                |

Two agents in the same scope = serialize them. Two agents in different scopes
= run them in parallel.

### Reconciliation pattern

When N parallel agent branches finish:

1. `git switch -c integration/2026-05-17 main` — fresh integration branch off the
   current `main`.
2. Merge each agent branch one at a time. Run `npm run verify` between merges.
   This narrows the blame window for any failure to the branch you just merged.
3. Resolve any conflicts on the integration branch — never on the original agent
   branches.
4. When all merges are green, fast-forward `main` to `integration/2026-05-17` and
   delete the agent branches.

If a merge breaks `verify` and the fix isn't obvious, drop the offending branch
from the batch and ship the rest — re-cut the branch later off the new `main`.

## Commit convention

Format:

```
<type>(<scope>): <subject>
```

with an optional `!` before the colon to mark a breaking change:

```
feat(server)!: drop legacy field
```

### Allowed types

| Type       | Meaning                                                       |
| ---------- | ------------------------------------------------------------- |
| `feat`     | New user-visible behavior                                     |
| `fix`      | Bug fix                                                       |
| `refactor` | No behavior change (rename, restructure, extract)             |
| `perf`     | Performance work                                              |
| `test`     | Test-only change (new tests, fixture updates)                 |
| `docs`     | Docs/plans/README only                                        |
| `build`    | Bundler/build config (`tsc`, `vite`, Playwright config, etc.) |
| `ci`       | Hooks, GH Actions, lint config                                |
| `chore`    | Catch-all (codegen, version bumps, tidy-up). Scope optional.  |

### Allowed scopes

`frontend` · `server` · `sidecar` · `scripts` · `e2e` · `mocks` · `openapi` ·
`docs` · `deps` · `ci`

Mapped to file sets in the [table above](#scope-discipline--merge-magic).
Adding a new scope requires updating BOTH this file AND
`scripts/validate-commit-msg.mjs` in the same diff.

### Multi-scope changes

Comma-separate, no spaces:

```
feat(frontend,openapi): align ChapterSummary field with backend
```

Use sparingly — if a change spans three or more scopes, consider whether it
should be split into separate commits.

### Subject line rules

- Lowercase first character, no trailing period.
- Imperative mood: "add", "fix", "remove", not "added"/"adds"/"adding".
- Max 100 chars (the hook will reject longer subjects).
- Plan numbers go in the subject, not the scope: `feat(frontend): plan 22a voice library compare entry`.

### Exempt commits

Merge commits, revert commits, and `fixup!` / `squash!` commits are accepted
verbatim — git generates these automatically and the hook does not interfere.

### Examples

```
feat(server): add Gemini rate-limit retry budget
fix(frontend): voice swatch click plays sample everywhere it renders
refactor(sidecar): extract Kokoro voice catalog into module
test(e2e): cover sticky generation across navigation
docs(docs): backlog MoSCoW inventory of outstanding plan items
build(deps): bump vitest to 2.1.9
chore: tidy gitignore
chore(deps): bump openapi-typescript
feat(server,openapi)!: drop legacy chapter.summary field
```

### Enforcement

`.husky/commit-msg` invokes `scripts/validate-commit-msg.mjs` on every commit
and rejects non-conforming subjects. The validator itself is unit-tested
(`npm run test:hooks`) and runs in `test:fast` and `test:all`, so a broken
validator can't land.

To bypass the hook in a genuine emergency, use `git commit --no-verify` — but
the pre-push `verify` gate will still run the regression test for the validator,
and the bypassed commit will need fixing before any PR is reviewed.

## When you ship a change

The full checklist lives in [CLAUDE.md → "Before-shipping checklist"](CLAUDE.md#before-shipping-checklist).
The compact version:

1. Update or create the regression plan under `docs/features/`.
2. Add paired automated tests in the same diff.
3. Update `docs/features/INDEX.md` and `docs/BACKLOG.md` if relevant.
4. Run `npm run verify` locally.
5. Surface the user-visible delta in the end-of-turn summary.
