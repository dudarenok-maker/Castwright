# Contributing

Castwright turns a manuscript into a full-cast audiobook — every character in
their own voice, performed on a machine you already own. This guide is how to
work on it without stepping on yourself (or on a parallel agent run).

Two habits carry most of that weight. The **branching model** keeps work
isolated until it's ready to merge, and the **commit convention** keeps the
history greppable by area. The commit convention is enforced by a git hook; the
branching model is soft convention — held up by agreement, not tooling. The
honest version: `main` is the only branch anyone trusts, so everything else is
in service of keeping it shippable.

## TL;DR

- Cut every change on a branch named `<type>/<scope>-<slug>` (e.g. `feat/server-batch-retry`).
- Every commit subject MUST be `<type>(<scope>): <subject>` — `chore: <subject>` is the no-scope catch-all. A pre-commit-msg hook rejects anything else.
- Long-running parallel work goes in a `git worktree`, not a second clone. Reconcile multiple agent branches via an `integration/<date>` branch with `npm run verify` between merges.
- `main` is always shippable. `npm run verify` is the pre-push gate.

## Contributing & licensing

Castwright is **source-available under the Functional Source License**
(FSL-1.1-ALv2, a.k.a. FSL-1.1-Apache-2.0) — not OSI open source. See
[`LICENSE`](LICENSE); the [README license section](README.md#license) explains
the model in one paragraph. The Castwright name and brand assets are **not**
covered by the code licence and are not part of this repository — see
[`docs/legal/brand-and-trademarks.md`](docs/legal/brand-and-trademarks.md).

**Posture today: issues welcome, PRs by invitation.** Please open an issue to
discuss a change before sending a PR.

**Two things are required on every contribution:**

- **DCO sign-off** — add `Signed-off-by: Your Name <you@example.com>` to each
  commit (`git commit -s`), certifying you wrote the change and may submit it
  under the project licence.
- **A lightweight CLA** — so the maintainer retains the right to relicense (the
  FSL future-grant and any relicensing depend on owning the copyright). The full
  text is [`docs/legal/CLA.md`](docs/legal/CLA.md); the `CLA Assistant` GitHub
  Action comments on each PR and records your one-time signature when you reply
  `I have read the CLA Document and I hereby sign the CLA`. See
  [`docs/legal/licensing.md`](docs/legal/licensing.md).

## Branching model

Trunk-based with short-lived feature branches, isolated per agent via worktrees.
One branch is one cohesive change — small enough to hold in your head, isolated
enough that a parallel run can't trip over it.

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

| Scope      | File set                                              |
| ---------- | ----------------------------------------------------- |
| `frontend` | `src/`                                                |
| `server`   | `server/src/`                                         |
| `sidecar`  | `server/tts-sidecar/`                                 |
| `app`      | `apps/android/` (Flutter companion app)               |
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
4. When all merges are green, open **one** PR from `integration/2026-05-17` (the
   default disposition for a round — not one PR per agent branch), then delete
   the agent branches once it merges.

Reconcile on the integration branch, run `npm run verify` locally until green,
and only then (if you want a cloud check) add the **`run-ci`** label to the
integration PR or dispatch `verify.yml` — see
[§ Requesting a CI run](#requesting-a-ci-run-ci-is-opt-in). The whole round then
bills at most a **single** CI verify run, on demand, rather than one (or
several) per agent branch. See
[docs/features/118-ci-cost-round-2.md](docs/features/118-ci-cost-round-2.md).

If a merge breaks `verify` and the fix isn't obvious, drop the offending branch
from the batch and ship the rest — re-cut the branch later off the new `main`.

For automation, see `scripts/wt-merge.mjs` — it drives the same sequence
(integration branch off `main`, `git merge --no-ff` per agent branch, `npm run verify`
between merges) in one command. Example:

```powershell
node scripts/wt-merge.mjs feat/server-foo feat/frontend-bar feat/scripts-baz
```

The helper is idempotent (safe to re-run on a partially-merged integration
branch — it skips branches whose merge commit is already present), aborts on
the first conflict (exit 2) or verify failure (exit 3) with a suggested
follow-up command that drops the offending branch, and supports `--dry-run`
for a plan-only preview. See `docs/features/archive/85-wt-merge-helper.md` for the
full contract.

### Running multiple Claude Code conversations

The worktree pattern above keeps the working tree isolated; the helper
`scripts/wt-new.mjs` collapses the manual setup (branch + worktree + port
assignment) into one command so spinning up a second/third/fourth parallel
`claude` session is a one-liner.

**Spawn a new parallel session:**

```powershell
node scripts/wt-new.mjs feat/server-batch-retry
```

The helper creates `../wt-batch-retry` on the new branch, writes a
`.env.local` with this worktree's port assignments (so its `npm run dev`
doesn't fight the main tree's `:5173` / `:8080` / `:9000` / `:5174`), then
runs `npm install` (root, which activates husky hooks via the `prepare`
script) and `npm install --prefix server` inside the worktree so it's
immediately ready for `npm run dev` / `npm run verify`. Finally prints a
copy-pasteable `cd …` + `npm run dev` + `claude` block. Pass `--no-install`
to skip the installs (the helper then falls back to printing both commands
in the next-steps block). Slot N gets ports offset by `N * 10`.

**List active worktrees + their port assignments:**

```powershell
node scripts/wt-list.mjs
```

**Coordinate scopes the same way as parallel agents.** The
[scope-discipline table](#scope-discipline--merge-magic) above applies
equally to top-level Claude sessions: two sessions in the same scope (both
in `frontend`, both in `server`) will produce overlapping diffs and merge
conflicts at integration time — serialize them or accept the reconciliation
work. Two sessions in disjoint scopes (`frontend` + `sidecar`) merge clean.

**Within-session Agent fan-out** is a separate axis: inside a single
`claude` session you can spawn multiple `Agent(...)` tool calls with
`isolation: "worktree"` to parallelize sub-tasks on disjoint scopes. That
uses the same git-worktree mechanism under the hood but is managed by
Claude Code, not by `wt-new.mjs`. Use `wt-new.mjs` when you want **multiple
top-level conversations**; use Agent-tool fan-out when you want **one
conversation that delegates**.

**GPU + shared-resource caveats** (not solved by `wt-new.mjs`, queue
manually):

- The analyzer Ollama and the TTS sidecar share one GPU. Two sessions both
  triggering real `/analyse` calls, or one running analysis while another
  loads Coqui XTTS, will fight over VRAM (an 8 GB GPU holds Kokoro +
  analyzer OR Kokoro + XTTS, not all three at once). Coordinate manually —
  let one session finish its run before another starts a heavy GPU task.
- The TTS sidecar's Python venv at `server/tts-sidecar/.venv/` is shared
  across worktrees. Fine for read-only use; if you're upgrading
  dependencies, do it once from one worktree and let the others pick it up.
- The local `WORKSPACE_DIR` (where book state + cast.json live) is also
  shared by default. If two sessions write to the same book at the same
  time they will race on `state.json`. Set `WORKSPACE_DIR=…` in each
  worktree's `.env.local` if you need fully isolated book stores.

## Commit convention

The history is a tool, not a log. Tag every commit by area so
`git log --grep="(scope)"` can walk a single surface years later.

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

`frontend` · `server` · `sidecar` · `app` · `scripts` · `e2e` · `mocks` · `openapi` ·
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

## Issues

GitHub issues hold the **detail** for tracked work and are the home for **bug
tracking**. [`docs/BACKLOG.md`](docs/BACKLOG.md) stays the thin, prioritized
MoSCoW planning view; the issue is where the spec, discussion, and PR-linking
live. Regression plan: [docs/features/166-github-issues-backlog-integration.md](docs/features/166-github-issues-backlog-integration.md).

### Backlog items ↔ issues

- **One backlog item ↔ one issue.** The issue title leads with the permanent
  `<prefix>-<n>` ID: `<prefix>-<n> — <one-line what>` (e.g. `srv-1 — Merge
journal for alias un-link`). The ID stays the durable cross-reference in
  code/commits/plans; the issue `#NN` is just the auto-close hook.
- **The issue body is canonical** — What / Acceptance / Key files / Depends on /
  Benefit. `docs/BACKLOG.md` keeps a thin summary + the issue link for
  Must/Should/Could, and a one-liner for Won't.
- File via the **Backlog item** form (`.github/ISSUE_TEMPLATE/backlog-item.yml`,
  auto-labels `type:feature`), then add `area:<prefix>` + `moscow:<tier>`.

### Bugs

Bugs are **out-of-band** — file the **Bug** form (auto-labels `bug`), keep a
plain descriptive title (no `<prefix>-<n>`), and leave them **off**
`docs/BACKLOG.md`. They still get triage, history, and PR-linking.

### Labels

Three axes + two helpers, version-controlled in `scripts/gh-labels.mjs` (run
`node scripts/gh-labels.mjs --apply` to create/reconcile them):

- `area:fe` · `area:srv` · `area:side` · `area:ops` · `area:fs`
- `moscow:must` · `moscow:should` · `moscow:could` · `moscow:wont`
- `type:feature` · `type:chore` · `bug`
- `needs-plan` (owes a `docs/features/NN-*.md`) · `tracking` (watchdog, no direct fix)

### Plan vs. no-plan

Substantial / cross-cutting issues still get a numbered `docs/features/NN-*.md`
regression plan (label the issue `needs-plan`; the plan cites the issue, the
issue links the plan). Small / localized issues skip the plan — the issue body

- a paired test is the spec, and the work goes straight issue → PR.

### Linking from PRs

Because the merge policy lands the PR description on `main`, a closing keyword
**in the PR body** auto-closes the issue on merge:

- Full delivery → `Closes #NN` in `## Summary`.
- Partial / one wave of multi-wave work → `Refs #NN` (no auto-close); the final
  wave's PR uses `Closes #NN`.
- Bug fix → `Closes #NN` (the bug issue).

Keep citing the `<prefix>-<n>` ID in commit **subjects** as before — the ID is
the durable reference, `#NN` is the GitHub hook.

### Server-side enforcement

Issue templates + labels are a **soft convention** (the same posture as the
commit/PR-title rules). CI is opt-in (plan 215), so we deliberately don't spend
Actions minutes on label-lint or required-field enforcement beyond the forms
themselves; the `blank_issues_enabled: false` config funnels every issue through
a template.

## Pull requests

Every change that lands on `main` goes through a GitHub PR — that's the one door,
and the review at it is what lets the next person trust the branch. The template,
the title gate, and the merge-button policy together codify what PRs #1-#4 already
do by hand. See [docs/features/archive/44-pr-hygiene.md](docs/features/archive/44-pr-hygiene.md)
for the regression plan and rationale.

### PR title

The PR title MUST match the [commit-convention subject format](#commit-convention):

```
<type>(<scope>): <subject>
```

A GitHub Actions workflow ([`.github/workflows/pr-title-lint.yml`](.github/workflows/pr-title-lint.yml))
runs `scripts/validate-commit-msg.mjs` against the title on every `opened` /
`edited` / `synchronize` / `reopened` event. The check fails with the same help
block the local `commit-msg` hook prints. GitHub's title and the squash/merge
commit subject are independent surfaces — the local hook covers commits, this
workflow covers the PR title.

The title does NOT have to match the first commit on the branch verbatim. It
typically does (because most PRs are one commit), but a multi-commit PR picks
the title that best describes the whole change.

### PR body

GitHub auto-populates the body from [`.github/pull_request_template.md`](.github/pull_request_template.md).
Two required sections:

1. **`## Summary`** — 1-3 sentences: what changes, why. If a regression plan
   under `docs/features/` applies, link it here (e.g. _"Implements
   `docs/features/archive/44-pr-hygiene.md`."_). If the PR fills a plan's Ship notes,
   say so.
2. **`## Test plan`** — checklist of what was run and what reviewers should
   look at. Always start with `- [ ] npm run verify — green` (the pre-push
   hook will fail your push if it isn't anyway).

If the PR delivers or advances a backlog/bug issue, link it in `## Summary`:
`Closes #NN` (full delivery) or `Refs #NN` (partial). The keyword in the PR
body auto-closes the issue on merge. See [Issues](#issues).

The template's HTML comments are guidance — strip them before submitting, or
leave them; they don't render. The Summary and Test plan headings are the
load-bearing structure that reviewers (and future-me) skim first.

### Requesting a CI run (CI is opt-in)

The `verify.yml` battery does **not** run automatically on PRs (plan 215). The
pre-push husky hook already runs the full `npm run verify` battery on every
push, so a per-PR cloud run is redundant spend on Actions minutes. Push freely
— every PR push (draft or ready) bills **0 CI minutes** by default. When you
want a clean-room cloud check (typically right before merge, or to sanity-check
a change you couldn't fully verify locally):

- add the **`run-ci`** label to the PR — fires one run, and re-runs on each new
  push while the label stays on; **or**
- dispatch it manually: Actions tab → Verify → Run workflow, or
  `gh workflow run verify.yml --ref <branch>`.

A labeled PR run is scope-filtered to the legs the diff touched (plan 103); a
manual dispatch runs the full battery. What still runs automatically on its own:
`pr-title-lint.yml` on every PR, `app.yml` on `apps/android/**` changes,
`release.yml` on a `vX.Y.Z` tag, and `cross-os.yml` (macOS + Windows + mobile
e2e) on its weekly cron + manual dispatch. **Every release tag runs the complete
cross-platform battery before publishing** (full `npm run verify` + mobile e2e on
Ubuntu, plus `verify:quick`+build on macOS and Windows — see `release.yml`), so
cross-OS coverage for a release is automatic, not a manual pre-announce step.
Rationale + measurements:
[docs/features/215-ci-label-gated-verify.md](docs/features/215-ci-label-gated-verify.md),
[docs/features/118-ci-cost-round-2.md](docs/features/118-ci-cost-round-2.md).

### Merge policy

- **Merge button: "Create a merge commit" only.** Squash collapses the
  branch's individual commits, which breaks `git log --grep="(scope)"`
  walking — that's load-bearing for plan 38's branching/scope model. Rebase
  loses the merge commit's `Merge pull request #N` marker, which makes
  `git log --merges` less useful. Disable both at the repo level:
  ```
  gh repo edit --enable-squash-merge=false --enable-rebase-merge=false
  ```
- **Delete branch on merge: always.** Once a PR merges, the head branch
  should be removed automatically. `git branch --list 'feat/server-*'`
  after `git fetch -p` should list open work only. Enable at the repo level:
  ```
  gh repo edit --delete-branch-on-merge
  ```
- **Rebase locally before merge if `main` has moved.** `git rebase origin/main`
  on the branch, force-push, then merge — keeps the merge commit's diff clean
  and the conflict surface minimal. Conflicts are resolved on the branch, never
  on `main`.

### Before requesting review

- `npm run verify` green locally (pre-push hook already enforces this).
- The regression plan under `docs/features/` is updated or added in the same
  diff if the PR changes behaviour the plan cites.
- The end-of-turn summary names the branch + commit SHAs so the reviewer can
  jump straight to the diff.

### Server-side enforcement (branch protection)

`main` has **server-side branch protection** as of 2026-06-14: a GitHub ruleset
(`id 17654264`, `enforcement: active`) blocks force-push + deletion, enabled
after the **GitHub Pro** upgrade (the feature 403'd on the old Free private
plan). It **deliberately excludes required status checks** — so it stays
compatible with opt-in CI (plan 215) and the doc-only `paths-ignore` skip
without deadlocking PRs that never run `verify` — and adds no required-PR rule,
so direct-to-`main` trivial fixes and tag-based releases keep working. The local
`guard-protected-push.mjs` pre-push hook (plan 163) is now belt-and-suspenders.
Enablement + the ruleset JSON live in `com-4` / `brand/ruleset-main.json`. The
conventions above remain soft enforcement plus the `pr-title-lint.yml` workflow.

### Doc-only PR fast-path

A PR whose changed-file set lives entirely under `docs/**`, root-level
`*.md` (`README.md`, `CLAUDE.md`, `CONTRIBUTING.md`, `CHANGELOG.md`), or
`.github/*.md` (e.g. `.github/pull_request_template.md`) skips
[`verify.yml`](.github/workflows/verify.yml) via `paths-ignore`.
The PR still requires a valid title (`pr-title-lint.yml` runs on every
PR) and GitHub's native `mergeable` status still surfaces conflicts —
the gate stays "PR required + title valid + no conflicts", just without
the 10–15 min full battery. Since plan 215 CI is opt-in for _every_ PR, this
`paths-ignore` is now a second layer — it additionally ensures that even a
`run-ci`-labeled PR whose files are all docs won't spin up the battery.
Rationale and the exact glob list:
[docs/features/archive/101-docs-only-ci-skip.md](docs/features/archive/101-docs-only-ci-skip.md).

The same file-set test also skips the **local** pre-push `npm run verify`
battery (`scripts/is-docs-only-push.mjs`, wired into `.husky/pre-push`) — a
docs-only push has no runtime surface for tests/build/e2e to exercise, so the
~15-min battery would otherwise run twice (locally, then again in CI) for zero
signal. See [CLAUDE.md "Commit gate"](CLAUDE.md#commit-gate).

## When you ship a change

The full checklist lives in [CLAUDE.md → "Before-shipping checklist"](CLAUDE.md#before-shipping-checklist).
The compact version:

1. Update or create the regression plan under `docs/features/`.
2. Add paired automated tests in the same diff.
3. Update `docs/features/INDEX.md` and `docs/BACKLOG.md` if relevant.
4. Update `docs/release-notes-next.md` and `RELEASE_NOTES.md` in this PR (see
   "Release notes" below) — skip only when the change has no shippable delta.
5. Run `npm run verify` locally.
6. Surface the user-visible delta in the end-of-turn summary.
7. No budgeted polling loops in tests (await an event or drain to quiescence);
   no `page.waitForTimeout` in new e2e (use state-based waits); no oversized
   inline test timeouts. (`scripts/check-no-budget-poll.mjs` is the automated
   gate; run it locally with `node scripts/check-no-budget-poll.mjs`.)

## Releasing

A release is a performance going out the door, so it gets the same care as one.
Cutting a public release is one command (after the notes file is ready):

```sh
# 1. Clean main, synced with origin (the cross-OS gate validates origin/main).
git switch main
git pull --ff-only

# 2. Author the release body in docs/release-notes-next.md (sections per
#    "Release notes" below) and set its `release-notes-next-version:` marker to
#    the version you're cutting. This file IS the GitHub release body, and
#    bump-version uses it by DEFAULT — no --notes-file flag needed.
$EDITOR docs/release-notes-next.md

# 3. Bump versions, GATE on a green cross-OS run, then create the chore commit
#    + annotated tag. Same command on Windows, macOS, Linux. This fires
#    cross-os.yml on main and BLOCKS (~15–20 min); if it fails the tag is NOT
#    created — fix main and re-run. --skip-cross-os bypasses the gate.
#    The bump REFUSES if the notes are missing or their version marker is stale
#    (a release can't ship a placeholder body); --allow-placeholder overrides.
node scripts/bump-version.mjs --level minor
#    (Or point at a different file: --notes-file path/to/notes.md)

# 4. Push the bump, then the tag. The tag push fires .github/workflows/release.yml.
git push origin main
git push origin vX.Y.Z

# 5. Watch:  gh run watch   (or the Actions tab in the browser)
```

Step 3's cross-OS gate (plan 127) is the macOS + Windows verify/build + mobile-e2e
smoke that plan 103 moved out of `release.yml` into `cross-os.yml` to cut Actions
minutes. The bumper now fires + blocks on it before tagging, so a cross-OS break
can't ship — without re-paying the matrix on every PR. `release.yml` then runs
`verify:quick` on Ubuntu against the tagged commit and publishes the
platform-independent zip + SHA-256 using the tag annotation as the body. Full spec:
[`docs/features/archive/127-release-cross-os-gate.md`](docs/features/archive/127-release-cross-os-gate.md)

- [`docs/features/archive/49-release-package.md`](docs/features/archive/49-release-package.md).

**Invariants the bumper enforces** — read these before you bypass it:

- The **cross-OS gate** (plan 127) must pass before the tag is created. The gate
  validates `origin/main`, so local `main` must be in sync with it (the bumper
  refuses otherwise). `--skip-cross-os` is the escape hatch (emergency / no-`gh`
  boxes); if you use it, fire `cross-os.yml` manually before announcing the release.
- `package.json` and `server/package.json` versions MUST stay in lockstep
  (the bumper refuses to run if they've drifted).
- Every `vX.Y.Z` tag is an annotated tag pointing at a `chore: bump version
to X.Y.Z` commit. Lightweight tags do NOT fire the workflow.
- Release notes live in the tag annotation, not the GitHub Release UI. The
  workflow reads `git tag -l --format='%(contents)' vX.Y.Z` and uses that
  verbatim as the body.

If the artefact is broken after publish, delete the release + tag and bump
again — never amend or force-push a published tag:

```sh
gh release delete vX.Y.Z --yes
git push origin :vX.Y.Z
git tag -d vX.Y.Z
# Fix forward; bump to vX.Y.Z+1.
```

## Release notes

Release notes are authored in `docs/release-notes-next.md` (technical
register). `bump-version.mjs` feeds that file verbatim into the annotated git
tag message, which the release workflow uses as the GitHub Release body — so the
file IS the source of truth. Its leading HTML-comment carries a
`release-notes-next-version:` marker the bump checks against the version being
cut (a stale or missing file fails the bump rather than shipping a placeholder).
The regression plans under `docs/features/` are the long-form companion
(reference plan / PR numbers in parens, e.g. `(#637, plan 195)`). The
user-facing, brand-voice notes are separate — `RELEASE_NOTES.md`, shown in-app
at `#/release-notes`.

**Both files are updated PR-by-PR, not reconstructed at cut time** —
[CLAUDE.md's before-shipping checklist](CLAUDE.md#before-shipping-checklist)
item 4 lands an entry in each alongside the code that shipped it, while the
PR's own context is fresh. "Releasing" step 2 above (`$EDITOR
docs/release-notes-next.md`) is then a final pass over an already-populated
draft — proofread, reorder into the anatomy below, set the version marker —
not first-time authoring from git history. `bump-version.mjs` never resets
either file after tagging, so right after a cut both are still "closed":
`docs/release-notes-next.md`'s marker equals the version that just shipped,
and `RELEASE_NOTES.md`'s top section is headed with that same shipped version.
**The first PR to land after a cut is the one that reopens both** — bump the
marker forward (increment minor, this project's usual cadence, unless the
release was a patch) and clear `docs/release-notes-next.md`'s stale body from
the last release, then head a fresh top section in `RELEASE_NOTES.md` with
that same new version — before appending its own entry to each. Any later PR
in the same release cycle finds both drafts already open and just appends.

A release describes what shipped, diffed against the **previous public
release**, and is organised as a **headline block + emoji-themed sections**
(the anatomy below). Fixes still lead with the user-visible symptom in plain
language before any internal explanation. A release is not a development diary
and not an inventory of parked work. **v1.7.0 is the canonical example** of the
format the rest of this section describes; releases v1.0.0–v1.6.0 were
refreshed into it retroactively.

### Anatomy, in order

1. **Title** — `# Castwright X.Y.Z` as an H1. The GitHub Release title
   mirrors it (`Castwright X.Y.Z`).
2. **Theme statement + intro.** A bolded lead naming the release's identity
   (`**The Castwright release.**`, `**A stability + hardening release.**`),
   then a 1–3 sentence paragraph that frames what shipped at a glance. This
   replaces the old `vX.Y.Z — themes` header line.
3. **Upgrade note (optional).** A `> ⚠️ **Upgrade note:**` blockquote for
   anything that breaks or needs action on upgrade — a data-dir move, a config
   rename, a non-self-upgrading jump, a manual migration. Omit when there is
   nothing to flag.
4. A `---` divider.
5. **`## ✨ Headline features`** — the 2–4 marquee items of the release, each an
   `### <emoji> <Name>` subsection (append `(new)` when the capability is
   brand-new, not an expansion). Each opens with a 1–2 sentence prose framing,
   then sub-bullets with a **bold lead** and plan / PR refs in parens. This
   block pulls the big story to the top; everything else lives in the themed
   sections below.
6. **Themed sections** — `## <emoji> <Theme>` groups that bucket the remaining
   work by surface, not by Features / Fixes / Engineering. Typical themes:
   🎙️ Voice design & casting · 🔊 Generation quality & reliability ·
   🎧 Listening experience · ⚙️ Models, settings & covers · 🔌 Sync & server
   infrastructure · 🏗️ Under the hood (rebrand / deps / licensing / CI). Each
   bullet leads with a **bold subject** and ends with plan / PR refs in parens.
   Fixes fold into the relevant theme and still lead with the user-visible
   symptom (see the Content rules below).
7. A `---` divider, then the footer: `**Full changelog:** vPREV...vX.Y.Z`.

Pick emoji from a small, stable set (✨ headline · 📱 mobile / companion ·
🚀 onboarding · 📖 content / books · 🍎 platform · 🎙️ voice · 🔊 generation ·
🎧 listening · ⚙️ settings · 🔌 sync / server · 🏗️ under-the-hood). Don't invent
a new emoji per release — consistency across the releases index is the point.

### Content rules

The four old buckets (Features / Fixes / Retirements / Engineering) are no
longer top-level sections — their content is distributed across the headline
block and the themed sections — but the writing rules for each _kind_ of line
still hold:

- **Feature lines** (headline sub-bullets + most themed bullets). A functional
  summary written for a reader who is at minimum a contributor / operator: the
  user-facing affordance plus enough mechanical hint (state-machine names,
  slice / file names, SSE channels, config knobs, dependency choices) that
  someone who knows the codebase can locate the work. Lead with a **bold
  subject**; close with the plan / PR ref in parens (`(#637, plan 195)`).
- **Fix lines.** Fold into the relevant theme, but each **must lead with the
  user-visible symptom in plain language** before any internal explanation —
  what the listener / deployer / operator saw and couldn't do — then close with
  the new behaviour (`Now legible`, `Now self-heals`, `Now stacks correctly`)
  and the plan / PR ref. Internal vocabulary (`bg-amber-50/60`,
  `BookStateJson.description`) is fine _inside_ the line to disambiguate the
  surface, never as the leading words.
- **Retirements.** Behaviour that **shipped in a previous release** and is now
  removed or downgraded — surface it loudly (the `⚠️ Upgrade note` blockquote,
  or a dedicated bullet) and tell users what to do instead.
- **Engineering lines** (the 🏗️ Under-the-hood theme). Test harness, build,
  install prereqs, deploy steps, repo layout, dependency versions, CI quirks
  (`apt / brew / choco`, `pwsh` vs `powershell.exe`) — mechanical detail
  welcome. An optional trailing line can carry BACKLOG / archive accounting
  (e.g. `BACKLOG since v1.2.2: Could 32 → 23 (9 items shipped …)`).

### What stays out

- **Parked or deferred work.** That belongs in `docs/BACKLOG.md`. A
  release describes what shipped, not what was considered. No "What is
  NOT in vX.Y.Z" sections.
- **Removals of never-shipped scaffolding.** If users never had it,
  they didn't lose it. Internal cleanup is not a retirement.
- **Same-cycle regression fixes.** A bug introduced and fixed within
  this release cycle is internal churn — invisible to anyone who only
  ever runs tagged versions.
- **Refactors, renames, internal restructuring** with no behavior,
  build, or test-command change.
- **Comparative phrasing on an initial release** ("now also on…",
  "improved…"). With no previous public release to diff against, just
  state what the feature is.

### Recipe

1. `git log vPREV..HEAD --oneline` (and `gh pr list --state merged --base main`
   for PR refs) and bucket each shipped change. Drop anything in "What stays
   out".
2. Identify the 2–4 **marquee items** — the things a user would tell a friend
   about. Those become the `## ✨ Headline features` subsections; everything
   else slots into a themed section.
3. For each candidate **Fix**, verify the bug actually predates `vPREV`
   (`git log vPREV -- <file>` or the bug report's date). If it was born and
   died inside this cycle, drop it. Then re-read each Fix line and confirm it
   opens with the user-visible failure mode ("Generation halted on the 'No
   analysed sentences cached' banner", "In dark mode, the Halted pill was
   nearly invisible"), not an internal name.
4. For each candidate **Retirement**, verify the behaviour shipped in a prior
   tag; if it was only ever in dev, it's internal cleanup — leave it out.
5. Write the body in order: title → theme statement + intro → optional upgrade
   note → `## ✨ Headline features` → themed sections → `**Full changelog:**`
   footer. Reference plan / PR numbers in parens throughout.
6. **Draft in the GitHub Release UI first.** `gh release create vX.Y.Z --draft
--target main --notes-file <path>` (a draft is collaborator-only — nothing
   public changes) so the user can review the rendered body. Iterate with
   `gh release edit vX.Y.Z --notes-file <path>`.
7. Once approved, the same body becomes the annotated-tag message for the bump
   (`node scripts/bump-version.mjs --notes-file <path>`); the release workflow
   publishes it verbatim. (Releases predating this format were refreshed
   directly via `gh release edit`.)
