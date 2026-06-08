---
status: active
shipped: null
owner: null
---

# 132 — Code-statistics tooling (`npm run stats`) + engineering-notes block

> Renumbered 131 → 132 (2026-05-29): plan 131 collided with `131-cast-status-filter.md` (both landed on `main` from parallel sessions). This tooling doc moved to 132; the cast-status-filter feature keeps 131.

> Status: stable
> Key files: `scripts/code-stats.mjs`, `scripts/bump-version.mjs`, `brand/project-narrative.md` (local-only), `package.json`
> URL surface: none (build/release tooling)
> OpenAPI ops: none

## Benefit / Rationale

- **User (maintainer / curious reader):** a reproducible answer to "how big is this project?" — a SLOC-per-language table with a production-vs-test split lives in the project narrative's technical appendix and refreshes itself on every release, so the numbers are never stale guesswork.
- **Technical:** wraps [`tokei`](https://github.com/XAMPPRocky/tokei) (counts code excluding comments + blanks, honours `.gitignore`) behind a small Node ESM script. The tokei-JSON → markdown transform is pure and unit-tested, so coverage needs no binary.
- **Architectural:** tokei stays a **local-only maintainer dependency** — it is deliberately NOT added to CI. The release hook is best-effort (a missing tokei never blocks a cut), so `release.yml` is untouched and a tokei-less box still produces a clean version bump.

## Architectural impact

- **New seams:**
  - `scripts/code-stats.mjs` — `npm run stats` (preview) / `npm run stats -- --write` (rewrite the doc block). Exports pure helpers (`classifyFile`, `summarize`, `renderMarkdown`, `replaceBlock`) behind an `import.meta`-main guard, matching `bump-version.mjs`.
  - A `<!-- CODE-STATS:START -->` / `<!-- CODE-STATS:END -->` marker block in `brand/project-narrative.md` Appendix B that the script rewrites idempotently.
- **Invariants preserved:**
  - Release entry point unchanged in shape — `bump-version.mjs` still creates the annotated `vX.Y.Z` tag after the cross-OS gate (plan 127). The stats refresh is inserted *before* the version mutation and its diff rides in the same `chore: bump version to X.Y.Z` commit.
  - CI never gains a tokei dependency (CLAUDE.md / cross-platform-scripts constraint).
- **Migration story:** none — additive script + doc block + one npm script.
- **Reversibility:** delete the script, the npm `stats` entry, the doc block, and the `refreshCodeStats()` call in `bump-version.mjs`. Nothing else depends on it.

## Invariants to preserve

1. `code-stats.mjs` pure helpers stay importable without side effects — the `import.meta`-main guard at the foot of the file gates `main()` (`scripts/code-stats.mjs`). Tests import the helpers; they must never spawn tokei.
2. `replaceBlock` preserves the document's existing line ending (CRLF on a Windows checkout) so `--write` is idempotent and doesn't churn the diff (`scripts/code-stats.mjs`, `replaceBlock`). Missing markers throw rather than silently no-op.
3. `CODE_LANGS` defines what counts as "source code" for the prod/test split + code-only total; JSON / YAML / Markdown are listed in the table but excluded from the code headline so a lockfile bump can't masquerade as code growth (`scripts/code-stats.mjs`).
4. The `refreshCodeStats()` step in `bump-version.mjs` is **non-fatal**: it skips cleanly when `scripts/code-stats.mjs` is absent (fixture repo) or when tokei errors (not installed). The narrative now lives at `brand/project-narrative.md` (git-ignored, local-only), so the refresh updates it in place but it is **no longer staged** into the version-bump commit.

## Test plan

### Automated coverage

- node:test (`scripts/tests/code-stats.test.mjs`, via `npm run test:hooks`) —
  - `classifyFile` flags `*.test.*` / `*.spec.*` and `e2e/` / `tests/` segments across both path separators, and does NOT misread `spec-utils.ts` / `tests-helpers/`.
  - `summarize` buckets prod vs test over a fixture tokei JSON and excludes JSON from the code total.
  - `renderMarkdown` is deterministic given a fixed date and carries the headline numbers + ratio.
  - `replaceBlock` swaps between markers, is idempotent for both LF and CRLF docs, and throws on missing markers.
- node:test (`scripts/tests/bump-version.test.mjs`) — two added cases pin that the code-stats refresh skips cleanly (dry-run plan line + `[SKIP]` notice) and still bumps + tags when `code-stats.mjs` is absent.

### Manual acceptance walkthrough

1. `winget install XAMPPRocky.tokei` (Windows) and restart the shell so `tokei` is on PATH.
2. `npm run stats` → prints the language table + prod/test split to stdout (no file change).
3. `npm run stats -- --write` → updates only the CODE-STATS block in `brand/project-narrative.md` (local-only, git-ignored); re-running prints `no change — stats already current.`
4. `node scripts/bump-version.mjs --level patch --dry-run` → prints `[PLAN] refresh code stats: … via code-stats.mjs --write (best-effort)` and mutates nothing.
5. Uninstall/rename tokei → `npm run stats` dies with a per-OS install hint; `bump-version` (real run) prints `[SKIP] code-stats refresh failed` and still completes the bump.

## Out of scope

- Installing tokei in CI or attaching a stats artifact to the GitHub Release (chosen against: keeps tokei local-only, zero CI-minute cost). A future `--check` staleness guard for `verify` would need tokei in CI — file it on the backlog if wanted.
- Per-directory or churn-over-time breakdowns.

## Ship notes

Shipped 2026-05-29 on branch `chore/scripts-code-stats` (commit SHA filled at merge). Initial numbers: ~137.8k source lines, ~70.4k application vs ~67.4k test code (~0.96 test-per-source), comments+blanks ~29% of tracked lines.
