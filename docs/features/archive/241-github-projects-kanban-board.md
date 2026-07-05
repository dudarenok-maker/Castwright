---
status: stable
shipped: 2026-07-05
owner: null
---

# 241 — GitHub Projects kanban board (ops-25)

> Status: stable
> Key files: `scripts/backlog-sync.mjs`, `scripts/bulk-add-project-items.mjs`, `scripts/strip-chore-moscow-labels.mjs`, `scripts/link-sub-issues.mjs`, `scripts/audit-branches-worktrees.mjs`, `scripts/audit-issue-parseability.mjs`, `scripts/clear-done-project-items.mjs`, `docs/backlog-project-config.json`, `docs/BACKLOG.md`, `CONTRIBUTING.md` (§Issues "The board"), `CLAUDE.md` (§The backlog)
> URL surface: none (process / tooling / docs) — the board itself lives at `https://github.com/users/dudarenok-maker/projects/1`
> OpenAPI ops: none

## Benefit / Rationale

- **User (maintainer):** replaces the flat issue list with a live kanban board for day-to-day triage — Status/Priority live on the board, not scattered across labels and a hand-maintained markdown file.
- **Technical:** `docs/BACKLOG.md` becomes a generated artifact (`npm run backlog:sync`), ending the drift between the file and reality that any hand-maintained planning doc accumulates. The parseability audit surfaced and fixed a real gap: the original design assumed one issue-body convention, but the live repo actually used three.
- **Architectural:** intra-tier ordering gets a real, durable mechanism (a numeric `Priority` field) instead of an implicit "row position in a markdown file" convention that a generator can't reconstruct from GitHub's API.

## Architectural impact

- **New seams / extension points:**
  - `docs/backlog-project-config.json` — the single source of board/field/option IDs every script reads, mirroring `docs/backlog-issue-map.json` from plan 166.
  - `scripts/backlog-sync.mjs` — exports `parseWhatBenefit`, `groupByMoscow`, `renderBacklogMd` (pure, tested) plus the GraphQL/CLI glue.
  - Five one-off rollout scripts (`bulk-add-project-items`, `strip-chore-moscow-labels`, `link-sub-issues`, `audit-branches-worktrees`, `audit-issue-parseability`) and one ongoing release-cut tool (`clear-done-project-items`), all dry-run-by-default.
- **Invariants preserved:** the `<prefix>-<n>` ID scheme from plan 166 is untouched — it's still how an issue maps to a `docs/BACKLOG.md` row. Bugs stay off `docs/BACKLOG.md`. The plan-166 migration/thinning scripts remain in the tree (historical tooling, not deleted).
- **Migration story:** one-time rollout mutated live GitHub state (bulk-added 88 issues, stripped 17 chore `moscow:*` labels, retrofitted one initiative into native sub-issues, filed 3 previously-untracked overhang issues). `docs/backlog-project-config.json` is the bridge artifact; `docs/BACKLOG.md` itself is fully regenerable from the board at any time.
- **Reversibility:** `docs/BACKLOG.md` is git-tracked (`git checkout docs/BACKLOG.md` reverts a bad generation); the Project board itself can be deleted and Task 1 re-run; no schema/data-shape change to the app.

## Invariants to preserve

1. The board's `Status` single-select field has exactly 6 options: `Backlog`, `Next`, `In Progress`, `Parked`, `Waiting/Blocked`, `Done` (`docs/backlog-project-config.json`'s `statusOptions`).
2. The **Backlog** saved view filters `is:issue label:type:feature`; the **Bugs & Chores** view filters `is:issue label:bug,type:chore` (comma = OR in Projects-view filter syntax — a different convention from `gh issue list --label`, which AND-combines).
3. `docs/BACKLOG.md` is **generated**, never hand-edited (`scripts/backlog-sync.mjs`'s `HEADER` constant states this) — edit the linked issue and re-run `npm run backlog:sync` instead.
4. `moscow:*` labels are meaningful **only** on `type:feature` issues; `type:chore` issues never carry one (enforced once by `scripts/strip-chore-moscow-labels.mjs`, not an ongoing gate).
5. Intra-tier ordering is driven by the numeric `Priority` field (`compareByPriority` in `scripts/backlog-sync.mjs`) — lower number = higher priority, appears first; an issue with no Priority sorts last, tiebroken by issue number. This is NOT issue-number ordering alone — a design choice made explicitly during planning to preserve the hand-curated ranking the old `docs/BACKLOG.md` encoded as row position.
6. **"Status ≠ Done" is deliberately stricter than a literal single-field reading.** `toBacklogIssues` in `scripts/backlog-sync.mjs` requires BOTH `content.state === 'OPEN'` AND the board's Status field ≠ `'Done'` for a `type:feature` issue to appear in the Must/Should/Could sections — not the Status field alone. This is intentional belt-and-suspenders: a closed issue whose card missed the "Item closed → Done" board automation, or one with a stale Status value, can never reappear in `docs/BACKLOG.md` just because nobody dragged its card. `moscow:wont` issues are the one exception — they render regardless of state or Status, per design.
7. `parseWhatBenefit` (`scripts/backlog-sync.mjs`) recognizes three issue-body conventions: the legacy `- _What:_ ...` / `- _Benefit...:_ ...` bullet (from `scripts/thin-backlog.mjs`'s original convention), a `## What` / `## Benefit (axis)` markdown heading followed by a paragraph (the dominant real-world shape, from `.github/ISSUE_TEMPLATE/backlog-item.yml` and hand-authored `gh issue create` bodies), and a `**What**` bold-heading block / `**Benefit (axis):**` bold-inline line. A block extraction stops only at a recognized label keyword (`KNOWN_LABELS`), not at any line merely opening with bold emphasis — content like `**Proof, not promises.** more text...` must not be mistaken for a new section.

## Test plan

### Automated coverage

- `node:test` (`scripts/tests/backlog-sync.test.mjs`, runs via `npm run test:hooks`) — 11 cases covering `parseWhatBenefit` across all three body conventions plus the bold-emphasis-is-not-a-label regression, `groupByMoscow`'s Priority-ascending sort (including the missing-Priority-sorts-last / issue-number tiebreak), and `renderBacklogMd`'s row shape, missing-section placeholder text, and Won't-section one-liners.
- The five one-off rollout scripts and the ongoing `clear-done-project-items.mjs` are throwaway/release-cut tooling reviewed by hand during rollout, matching the design spec's Testing section — not unit tested individually.

### Manual acceptance walkthrough

1. **Board setup** (Task 1): `gh project view 1 --owner dudarenok-maker` shows the `Castwright Kanban` project with `Status` (6 options) and `Priority` (NUMBER) fields; the **Backlog** and **Bugs & Chores** saved views render with the documented filters; the three built-in workflows (Item added → Backlog, Item closed → Done, Item reopened → Backlog) are on, Pull request merged is off.
2. **Bulk rollout** (Tasks 4-6): the board holds every open issue with a heuristic Status + Priority seeded from the pre-cutover `docs/BACKLOG.md` row order; the language-breadth initiative (7 issues) shows a "Sub-issues 0/7 done" progress bar under its parent tracker.
3. **Label reclassification** (Task 5): `gh issue view <n> --json labels` on any of the 17 previously-`moscow:*` chores shows no `moscow:*` label; `ops-17`/#790, `side-23`/#1228, `srv-4`/#431 all carry `tracking` and show Status = `Waiting/Blocked`.
4. **Generation** (Task 10): `npm run backlog:sync` (dry-run) prints a diff with zero `no What section found` / `no Benefit section found` placeholders; `npm run backlog:sync -- --apply` writes a `docs/BACKLOG.md` grouped by Must/Should/Could, each tier ordered by Priority, plus a Won't section.
5. **Release-cut integration** (Task 11): `node scripts/clear-done-project-items.mjs` (dry-run) lists any Done items with no errors.

## Out of scope (matches the spec)

- Time-based auto-archive for `Done` (cron-based) — `clear-done-project-items.mjs` is a manual release-cut step only.
- Bot-enforced "Parked needs a comment" check — process-mandatory, not automated.
- A recurring (not just one-time) branch/worktree hygiene sweep — `audit-branches-worktrees.mjs` is a report-only tool run on demand, not scheduled.

## Ship notes

Shipped 2026-07-05. See PR body for the merge commit SHA. Supersedes [docs/features/archive/166-github-issues-backlog-integration.md](archive/166-github-issues-backlog-integration.md). Source spec: [docs/superpowers/specs/2026-07-05-github-issues-kanban-design.md](../superpowers/specs/2026-07-05-github-issues-kanban-design.md). Implementation plan: [docs/superpowers/plans/2026-07-05-github-issues-kanban-board.md](../superpowers/plans/2026-07-05-github-issues-kanban-board.md). Closes #1321.
