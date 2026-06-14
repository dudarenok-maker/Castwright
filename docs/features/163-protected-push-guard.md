---
status: active
shipped: null
owner: null
---

# 163 — Protected-branch pre-push guard

> Status: stable
> Key files: `scripts/guard-protected-push.mjs`, `scripts/tests/guard-protected-push.test.mjs`, `.husky/pre-push`
> URL surface: none (dev tooling)
> OpenAPI ops: none

## Benefit / Rationale

GitHub nudges that `main` "isn't protected." Investigation found that the
server-side features behind that nudge — **classic branch protection AND
repository rulesets** — both return **HTTP 403** on this repo:

> "Upgrade to GitHub Pro or make this repository public to enable this feature."

The repo is **private on the free plan**, so neither is enableable without
upgrading to GitHub Pro or making the repo public. The maintainer chose to stay
free + private, with the desired rule being simply **block force-push +
deletion of `main`**. The only enforcement point we control on the free plan is
the **local `pre-push` hook**, so this plan adds a guard there.

**Update 2026-06-14:** the repo upgraded to **GitHub Pro** and the server-side
ruleset is now live on `main` (id 17654264 — blocks force-push + deletion; no
required status checks, per opt-in CI / plan 215; tracked as `com-4`). This
local guard is now **belt-and-suspenders** rather than the sole mechanism — it
still protects checkouts/worktrees before the verify battery and any clone whose
remote isn't the protected repo.

- **User:** an accidental `git push --force` or `git push origin :main` against
  `main` is refused instantly with a clear message, before the ~15-min verify
  battery even starts — instead of silently rewriting/deleting history.
- **Technical:** pure, dependency-injected decision function
  (`evaluatePush`) → fully unit-testable with no real git repo, mirroring the
  `validate-commit-msg.mjs` validator pattern.
- **Architectural:** documents the free-private gating constraint in one place
  and ships the ready-to-run server-side command for the day the repo goes Pro
  or public (see "Out of scope"). Honest about the limitation: a local hook
  guards only this checkout and is bypassable with `--no-verify`.

## Architectural impact

- **New seam:** `scripts/guard-protected-push.mjs` exports
  `evaluatePush(stdinText, { isAncestor })`, `PROTECTED_REFS`, `ZERO`,
  `helpMessage` — pure functions + a thin CLI gated on `argv[1]` so `import`
  from tests stays inert (same idiom as `validate-commit-msg.mjs`).
- **Hook wiring:** `.husky/pre-push` runs the guard first
  (`node scripts/guard-protected-push.mjs "$@" || exit 1`) so a force/delete is
  rejected before `npm run verify`. The `|| exit 1` is load-bearing — without
  it `sh` falls through to `verify` and the hook's exit code would be verify's.
- **Invariant preserved:** the guard only ever acts on `PROTECTED_REFS`
  (`refs/heads/main`); every other ref (feature branches, ref creation) passes
  through untouched, so the direct-to-`main` trivial-fix workflow and all
  feature-branch force-pushes are unaffected.
- **Reversibility:** delete the guard line from `.husky/pre-push` (and the
  script) — nothing else depends on it.

## Invariants to preserve

- `PROTECTED_REFS` in `scripts/guard-protected-push.mjs` is exactly
  `['refs/heads/main']`. Adding a protected branch = extend this array.
- A push line is `<localRef> <localSha> <remoteRef> <remoteSha>` (git
  `pre-push` stdin contract, `man githooks`). `localSha` all-zero ⇒ deletion;
  `remoteSha` all-zero ⇒ ref creation (allowed).
- `evaluatePush` blocks a protected ref when: (a) `localSha` is zero
  (deletion), or (b) `remoteSha` is non-zero and **not** an ancestor of
  `localSha` (non-fast-forward / force). It never blocks ref creation.
- The CLI's real-git `isAncestor` treats `git merge-base --is-ancestor` exit
  codes as: `0` → ancestor (FF, allow), `1` → not ancestor (force, block),
  anything else / spawn error → **cannot verify → allow** (so an unfetched
  remote sha never falsely blocks an ordinary push).

## Test plan

### Automated coverage

- Node:test (`scripts/tests/guard-protected-push.test.mjs`, runs under
  `npm run test:hooks`) — asserts, against `evaluatePush` with a stubbed
  `isAncestor`: deletion of `main` → blocked; force-push to `main` → blocked;
  fast-forward to `main` → allowed; force-push/deletion of a feature branch →
  allowed; creating `main` (remote sha zero) → allowed; a mixed push deleting
  `main` amid feature pushes → blocked; blank stdin lines ignored;
  `main` ∈ `PROTECTED_REFS`.

### Manual acceptance walkthrough

Run from the repo root (no real remote needed — pipe a fake ref line):

1. **Deletion blocked:**
   `printf 'refs/heads/x 0000000000000000000000000000000000000000 refs/heads/main bbbb\n' | node scripts/guard-protected-push.mjs origin URL; echo $?`
   → prints the "Refusing to DELETE protected branch" help and exits `1`.
2. **Force-push blocked (real git):** with `H=$(git rev-parse HEAD)` and
   `P=$(git rev-parse HEAD~1)`,
   `printf "refs/heads/main $P refs/heads/main $H\n" | node scripts/guard-protected-push.mjs origin URL; echo $?`
   → exits `1` (remote `H` is not an ancestor of local `P` ⇒ non-fast-forward).
3. **Fast-forward allowed:** swap `$P`/`$H` in step 2 → exits `0`.
4. **Feature branch / empty stdin:** any non-`main` ref, or empty stdin →
   exits `0` and `npm run verify` proceeds.

## Out of scope

- **Server-side enforcement** — gated behind GitHub Pro / public on this repo.
  When the repo goes Pro or public, enable a ruleset that blocks force-push +
  deletion of the default branch:

  ```bash
  gh api -X POST repos/dudarenok-maker/AudioBook-Generator/rulesets --input - <<'JSON'
  { "name": "protect-main", "target": "branch", "enforcement": "active",
    "conditions": { "ref_name": { "include": ["~DEFAULT_BRANCH"], "exclude": [] } },
    "rules": [ { "type": "deletion" }, { "type": "non_fast_forward" } ] }
  JSON
  ```

  Tracked in `docs/BACKLOG.md` as `ops-9`.
- **Required status checks / required PRs** — not requested, and a required
  `npm run verify` check would deadlock doc-only PRs (`verify.yml` skips them
  via `paths-ignore: docs/**`, so the required check would never report).

## Ship notes

(Filled in when status flips to `stable`: shipped date + commit SHA.)
