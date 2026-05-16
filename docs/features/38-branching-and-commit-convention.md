---
status: stable
shipped: 2026-05-17
owner: null
---

# Branching model & commit convention

> Status: stable
> Key files: `CONTRIBUTING.md`, `.husky/commit-msg`, `scripts/validate-commit-msg.mjs`, `scripts/tests/validate-commit-msg.test.mjs`, `package.json`
> URL surface: none
> OpenAPI ops: none

## Benefit / Rationale

- **User (developer-facing):** `git log --grep="(sidecar)"` returns a clean area history without hand-curation. `git blame` lines carry a scope tag so the *why* of any line is one step away from the *what*.
- **Technical:** A pre-commit-msg gate makes drift impossible — the convention is either followed or the commit doesn't land. Branch naming mirrors commit scope, so `git branch --list 'feat/server-*'` gives the open server work at a glance.
- **Architectural:** Forces every change to declare which area it touches *before* it merges. Parallel-agent work in disjoint scopes (e.g. `frontend` + `sidecar`) collides far less often because the scope vocabulary names the disjoint file sets explicitly. The reconciliation pattern (`integration/<date>` branch, verify between merges) gives a single chokepoint for resolving cross-scope conflicts rather than letting them spread across N feature branches.

## Architectural impact

- **New seam:** `.husky/commit-msg` hook + `scripts/validate-commit-msg.mjs` validator module. The validator is a pure function (`validateCommitSubject(subject) → { ok, reason }`) so it can be tested without invoking git.
- **New test tier:** `npm run test:hooks` (Node's built-in `node:test` runner, no new deps). Folded into `test:fast` (pre-commit gate) and `test:all` (pre-push gate) so a broken validator can't ship.
- **Invariants preserved:**
  - The two existing hooks (`pre-commit` → `verify:fast`, `pre-push` → `verify`) are untouched. The new `commit-msg` hook is additive.
  - Merge, revert, fixup, and squash commits remain exempt — git auto-generates these and the hook accepts them verbatim. Breaking this would block `git revert` and interactive rebases.
- **Migration:** Existing commit history is untouched. The convention applies from this commit forward. Pre-existing branches do NOT need rewriting.
- **Reversibility:** Delete `.husky/commit-msg`, the validator, the test, and the `test:hooks` script. CONTRIBUTING.md becomes documentation of a convention that nothing enforces — also fine. No data migration.

## Invariants to preserve

1. **The hook is the source of truth for the allowed type/scope vocabulary.** The lists in `CONTRIBUTING.md` MUST match the constants `TYPES`, `CHORE_TYPE`, and `SCOPES` in `scripts/validate-commit-msg.mjs:8-21`. The test `every documented type is acceptable in a typed commit` in `scripts/tests/validate-commit-msg.test.mjs` exercises every type; `every documented scope is acceptable` exercises every scope. Adding a new type/scope requires updating both files in the same diff or those tests will fail.
2. **`chore` is the only type where scope is optional.** Enforced by two distinct regex patterns in `scripts/validate-commit-msg.mjs:24-26` (`CHORE_PATTERN` allows the scope group to be absent; `TYPED_PATTERN` requires it). The test cases `feat: missing scope` (reject) and `chore: bump version` (accept) lock this.
3. **Auto-generated commits are exempt.** `AUTO_GENERATED` regex in `scripts/validate-commit-msg.mjs:29` matches `Merge `, `Revert `, `fixup! `, and `squash! ` prefixes. Removing any of these breaks `git revert`, `git merge`, or interactive rebase workflows.
4. **The validator never imports beyond `node:fs`.** It must run on a developer's machine seconds after `git commit`, before `node_modules` is even guaranteed to exist (e.g. partial checkouts). Keeping it dependency-free means it works on every clone the moment `npm install` finishes.
5. **CLI mode is gated on `argv[1]`, not on `import.meta`-based main detection.** `scripts/validate-commit-msg.mjs:79-82` checks that the invoking script path ends with `scripts/validate-commit-msg.mjs`. This is Windows-path-safe (the `replace(/\\/g, '/')` normalizes separators) and importable from tests without triggering `process.exit`.
6. **Subject extraction must skip blank lines and `#` comments** (`extractSubject` in `scripts/validate-commit-msg.mjs:66-74`). Git's commit-message editor inserts a template of `#`-prefixed help lines; the validator must not pick those up as the subject.

## Test plan

### Automated coverage

- `scripts/tests/validate-commit-msg.test.mjs` (Node's built-in `node:test`) — exercises:
  - Every documented type accepted with a valid scope.
  - Every documented scope accepted with `feat`.
  - Multi-scope subjects, breaking-change `!` marker, `chore` with and without scope.
  - Merge / Revert / fixup! / squash! exemption.
  - Reject cases: missing scope on non-chore types, wrong case, unknown type, unknown scope, missing colon/space, empty subject, oversize subject (>100 chars).
  - `extractSubject` skips blank lines and `#` comments, handles CRLF, returns empty string when only comments are present.
- Wired into `npm run test:hooks` → folded into `npm run test:fast` (pre-commit) and `npm run test:all` (pre-push).

### Manual acceptance walkthrough

1. **Hook rejects malformed subject.**
   - Edit any file. `git add` it. Run `git commit -m "fix: missing scope"`.
   - Expected: commit refused, stderr shows the help block from `validate-commit-msg.mjs`, exit code 1.
2. **Hook accepts conforming subject.**
   - `git commit -m "fix(frontend): voice swatch click plays sample"` against the same staged change.
   - Expected: commit succeeds, `git log -1 --format=%s` shows the subject verbatim.
3. **Hook exempts merge commits.**
   - From a feature branch, `git merge --no-ff main` after main has new commits. The auto-generated `Merge branch 'main' ...` subject should be accepted without modification.
4. **`test:hooks` runs in pre-commit.**
   - With staged changes, `git commit -m "chore: smoke test"`. Expected: `npm run verify:fast` runs `npm run test:hooks` first, then frontend + server tests. All three green → commit lands.
5. **Validator unit suite catches regressions.**
   - Temporarily rename the `chore` type in `scripts/validate-commit-msg.mjs` to `chores`. Run `npm run test:hooks`. Expected: the `chore: bump version` accept case fails. Revert.

## Out of scope

- **Rewriting historical commits to conform.** Existing history is preserved as-is; the convention applies from this commit forward.
- **Branch-name enforcement.** Branch naming is soft convention only — no `pre-push` hook gates the branch name. If misnamed branches become a problem, add a hook later.
- **Automated changelog generation from commit subjects.** The scope tags are designed to support this (e.g. `git log --grep="(server)" --pretty=format:"%s"`), but no tooling is shipped — the git log itself is the changelog per `docs/features/INDEX.md`.
- **Semantic versioning derived from `feat!` / `fix` prefixes.** This is a private frontend tool with `"private": true` in `package.json`; no published versions exist.
- **`commitlint` or `husky-commit-msg` packages.** The hand-rolled validator is ~80 lines, has zero deps, and is unit-tested. Pulling in `commitlint` (200+ transitive deps) would not earn its keep.

## Ship notes

- Shipped 2026-05-17.
- Three artifacts: `CONTRIBUTING.md` (workflow doc), `.husky/commit-msg` + `scripts/validate-commit-msg.mjs` + `scripts/tests/validate-commit-msg.test.mjs` (enforcement), this plan (regression).
- One follow-up to consider if pain emerges: a `prepare-commit-msg` hook that prefills the type/scope based on the branch name (e.g. branch `feat/server-foo` → subject template `feat(server): `). Not shipped because it muddies the failure mode of the strict hook.
