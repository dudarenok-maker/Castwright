---
status: stable
shipped: null
owner: dudarenok-maker
---

# Cross-OS verify gate on the version-cut process

> Status: stable
> Key files: `scripts/bump-version.mjs`, `scripts/tests/bump-version.test.mjs`, `.github/workflows/cross-os.yml` (gated workflow, unchanged), `CONTRIBUTING.md` (release flow)
> URL surface: none (release tooling)
> OpenAPI ops: none

Extends [49 — release packages on git-tag push](archive/49-release-package.md) and
[103 — CI cost reduction](archive/103-ci-cost-reduction.md) (which moved the cross-OS
matrix out of `release.yml` into the `workflow_dispatch` + weekly-cron `cross-os.yml`).

## Benefit / Rationale

- **User (maintainer):** before plan 103, `release.yml` ran a per-release macOS + Windows
  matrix, so a cross-OS break blocked the release automatically. Plan 103 moved that smoke to
  `cross-os.yml` (`workflow_dispatch` + weekly cron) to cut Actions minutes — but that made
  cross-OS a **manual pre-announce ritual** ("fire it before announcing a release"), easy to
  forget. This wires cross-OS back into the cut so it's **automatic and blocking again**: the
  annotated tag is not created until a cross-OS run is green, without paying the matrix on
  every PR (the cost win of 103 stays).
- **Technical:** the gate runs *first* — before any version-bump mutation — so a red run leaves
  the working tree pristine and no tag exists. Re-running after a fix is a clean retry with no
  half-applied state to reconcile.
- **Architectural:** the gate is opt-out (`--skip-cross-os`), and the script stays import-safe
  (pure helpers exported, CLI body behind an `import.meta`-main guard) matching the
  `install-qwen3.mjs` pattern, so the run-discovery logic is unit-testable without `gh`.

## Architectural impact

- **`scripts/bump-version.mjs`** gains: a `--skip-cross-os` flag; a new ordered step between
  the pre-flights and the version mutation that (a) verifies local `HEAD == origin/main`,
  (b) fires `cross-os.yml` via `gh workflow run`, (c) discovers the dispatched run, and
  (d) blocks on `gh run watch --exit-status`, dying (so `git tag` is never reached) on a red
  run. A new pre-flight refuses a target tag that already exists. The CLI body moved behind an
  `import.meta`-main guard; `semverBump` + a new pure `pickWorkflowRun` are exported.
- **What the gate validates.** `cross-os.yml` runs on `origin/main` (the commit your release is
  based on). The version-bump commit the script then creates changes only the two `package.json`
  version fields + their lockfile `version` fields — never the dependency tree or any source the
  cross-OS matrix exercises. The **exact** tagged commit is still Ubuntu-verified by `release.yml`
  on tag push; the cross-OS gate adds the macOS + Windows + mobile-e2e coverage on the
  platform-equivalent base commit. So no platform-specific code ships un-cross-OS-tested.
- **No workflow change.** `cross-os.yml` is unchanged — it already accepts `workflow_dispatch`,
  and a dispatch always runs both `cross-os-verify` (macOS + Windows verify/build) and
  `mobile-e2e`. `gh run watch` blocks on the whole run, so the gate requires every job green.
- **Reversibility:** `--skip-cross-os` reverts to the prior local-only prepare-then-push flow
  verbatim (bump → commit → tag, print push instructions); revert the diff to drop the gate.

## Invariants to preserve

- **Gate-before-mutation.** The cross-OS gate runs before `npm version` / commit / tag. A red
  run must leave zero mutations (no bumped `package.json`, no commit, no tag) — `bump-version.mjs`.
- **`pickWorkflowRun` matches the run we dispatched**, not a stale/concurrent one: head SHA equals
  the local `HEAD` cross-OS is validating, `event === 'workflow_dispatch'`, and `createdAt` is at
  or after the dispatch time (minus a small clock-skew slack). Newest match wins; returns `null`
  while the run hasn't surfaced so the caller keeps polling — `bump-version.mjs`.
- **Sync guard.** With the gate on, local `HEAD` must equal `origin/main`, else the gate would
  validate a different commit than the one being released — die with a clear message.
- **`--cleanup=verbatim`** on the annotated tag still preserves `## Features` / `## Fixes` /
  `## Engineering` headers (plan 49 / v1.4.0 regression) — unchanged.
- **Lockstep + clean-tree + on-main pre-flights** unchanged and still run first.
- **Import-safe module.** Importing `bump-version.mjs` must not run the release procedure (the
  `import.meta`-main guard); pure exports (`semverBump`, `pickWorkflowRun`) carry no I/O.

## Test plan

### Automated coverage (`npm run test:hooks` → `node --test scripts/tests/*.test.mjs`)

- **Existing post-state tests** (patch/minor/major bump, lockstep refusal, `--notes-file`
  annotation, dirty-tree refusal, unknown-level, GIT_* env-leak, `##`-header survival) keep
  asserting the same post-state, now run with `--skip-cross-os` so the throwaway repo (no `gh`,
  no remote) doesn't reach the gate.
- **New — `--skip-cross-os`** prints the `[SKIP]` notice and still bumps + commits + tags
  (gate-off path end-to-end via shell-out).
- **New — `--dry-run`** plan output names the gate (`cross-OS gate: ON …`) and mutates nothing.
- **New — `pickWorkflowRun` unit cases** (imported pure fn): picks the head-SHA + dispatch +
  fresh run; ignores other SHAs, non-dispatch events, and pre-dispatch runs; returns `null` when
  none match; picks the newest among multiple matches.

### Manual acceptance walkthrough

1. **Happy path.** On a clean, pushed `main`, `node scripts/bump-version.mjs --level minor
   --notes-file <notes>` → prints `[GATE] firing cross-os.yml …`, blocks on the run, and on
   green proceeds to create the commit + annotated tag, printing the push steps. The tag exists
   only after the run concluded `success`.
2. **Red gate.** Introduce a Windows/macOS break on `main`, run the bump → the gate dies with the
   failing run URL, and `git tag --list` shows no new tag, `git status` is clean (no bump commit).
   Fix `main`, re-run → clean retry, no version drift.
3. **Out of sync.** With an unpushed local commit on `main`, run the bump → dies on the sync guard
   ("out of sync with origin/main").
4. **Escape hatch.** `--skip-cross-os` cuts the tag locally without firing `gh` (prints the
   reminder to fire `cross-os.yml` manually before announcing).

## Out of scope

- Auto-pushing the commit + tag. The script still prints the two `git push` steps; pushing the
  tag (which fires `release.yml`) stays a deliberate manual action.
- Gating on the *exact* bump commit rather than its base. The version-bump delta is
  platform-inert and the exact commit is Ubuntu-verified by `release.yml`; testing the base
  commit on macOS + Windows is the cost-effective equivalent (see Architectural impact).
- Changing `cross-os.yml` itself (scope, jobs, cron) — unchanged.

## Ship notes

(Filled on merge: shipped date + commit SHA.)
