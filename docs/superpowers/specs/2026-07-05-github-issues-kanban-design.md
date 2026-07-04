---
status: draft
---

# GitHub Projects kanban board for issue tracking

## Problem

Castwright has 85 open GitHub issues and no working surface between the flat
issue list (unusable at this volume) and `docs/BACKLOG.md` (a hand-maintained,
prioritized MoSCoW document that's still valuable as a consolidated read, but
isn't a live tracker). Two concrete symptoms:

- **Overhangs are invisible.** Work that's "almost done but has a stalled
  piece" — e.g. the LAN cert broker, or the many "SHIPPED but owes on-box
  acceptance" items tracked only in Claude's memory system — has no visible
  home. It isn't "open" in a useful sense and it isn't closed.
- **Parked work lives only in git state.** A `git worktree list` / `git
  branch` sweep during this design session found 5 active worktrees and
  roughly 30 local branches (many `[gone]` from origin, several genuinely
  ahead of `main` — `docs/lan-cert-install-side`,
  `feat/server-dynamic-analyzer-models`,
  `feat/frontend-castwright-local-hostnames`, etc.). None of this is
  reflected in an issue or a board; it's tribal knowledge at best.

This design supersedes the prior decision recorded in
[`docs/features/166-github-issues-backlog-integration.md`](../../features/166-github-issues-backlog-integration.md)
("Out of scope" line: *"A GitHub Projects (v2) board — labels +
`docs/BACKLOG.md` are the planning surface by decision (less overhead, single
source of priority)"*). That decision predates the current issue volume and
didn't anticipate the overhang-visibility problem; this spec's rollout section
updates that plan's status accordingly.

## Goals

- A live, visual working surface for "what's next / in progress / stalled"
  that doesn't require reading 85 issues in a flat list.
- Explicit separation between priority-driven planning work (features) and
  do-whenever quality work (bugs, chores).
- A way to see, at a glance, the status of large multi-issue initiatives
  (voice cloning, language support, the LAN cert broker) instead of
  inferring it from scattered issue titles.
- Keep `docs/BACKLOG.md` as the prioritized, readable, consolidated MoSCoW
  document — but stop hand-maintaining it in parallel with a live board.

## Non-goals

- Not replacing GitHub Issues as the detail/discussion surface — issue
  bodies remain canonical (What/Acceptance/Key files/Depends on/Benefit).
- Not introducing a third-party tool (Linear, Trello, etc.) — GitHub
  Projects (v2) only.
- Not building real-time enforcement of process rules (e.g. the Parked
  comment requirement) — see "Parked convention" below.

## Design

### A. Scope & policy change

The board becomes the day-to-day working surface. `docs/BACKLOG.md` stays,
but becomes **generated** from the board rather than hand-written.

**Policy change:** `bug` and `type:chore` issues are no longer
MoSCoW-prioritized. They move to a separate "just get done" track — do
whenever, no ranking. `moscow:*` labels remain meaningful only for
`type:feature` issues. Existing `type:chore` issues that happen to carry a
stray `moscow:*` label get that label stripped during rollout (cosmetic
cleanup, not a behavior change — the view filters were never going to key off
it either way).

`docs/BACKLOG.md` only ever reflects `type:feature` issues. Bugs and chores
were already excluded by existing convention; this extends the same
exclusion to chores explicitly.

### B. Board structure

One GitHub Project (v2). One custom field: **Status** (single-select:
`Backlog`, `Next`, `In Progress`, `Parked`, `Done`). Two saved views over the
same underlying items:

- **Backlog view** — filtered to `type:feature`. Board grouped by Status,
  all 5 columns visible. Priority within a column is signaled by the
  existing `moscow:*` label plus manual drag-order for fine sequencing
  (mirrors how BACKLOG.md row order already works today).
- **Bugs & Chores view** — filtered to `bug` OR `type:chore`. Board grouped
  by the same Status field, but only `Backlog` (used here as "Open,
  unclaimed"), `In Progress`, and `Done` are used/shown — `Next` and
  `Parked` don't apply to this track and stay hidden in this view.

**Built-in automation only** (no custom scripting): new issue → added to
board, Status = `Backlog`. Issue closed or its PR merged → Status = `Done`.
Reopened → back to `Backlog`. All other transitions (`Next`, `In Progress`,
`Parked`) are manual drags.

**Parked convention (process-mandatory, not automated):** moving a card to
`Parked` requires leaving a comment on the issue explaining the overhang or
blocker. This is documented as a hard rule (in CONTRIBUTING.md's Issues
section) and checked during periodic audits — not enforced by a bot. GitHub
Projects v2 doesn't cleanly expose per-item status-change events to a
repo-level Action (items aren't repo-scoped), so real-time enforcement would
need non-trivial polling infrastructure that isn't justified yet.

### C. Epic / initiative tracking

For multi-issue efforts that are easy to lose track of: one **parent
tracking issue** per initiative, with related issues linked as native
**sub-issues** (GitHub's built-in "tracked by" relationship — the parent
shows `N/M done` progress automatically). The parent issue is a normal card
on the Backlog board and moves through the same 5 lanes as any other item.
Sub-issues can also appear independently on the board if they're
independently workable, or stay off-board as pure checklist items if too
small to track separately.

Existing multi-issue efforts get retrofitted with a parent issue during
rollout (see below) rather than only applying to new work going forward.

### D. `docs/BACKLOG.md` generator (`npm run backlog:sync`)

A script queries the Project board (GraphQL) for `type:feature` issues on
the Backlog view with **Status ≠ `Done`**, groups them by `moscow:*`, and
regenerates `docs/BACKLOG.md` in its existing row format:

```
#### <prefix>-<n> — <title> ([#NN](issue-url))
_What:_ ...
_Benefit:_ ...
_Full detail + acceptance:_ [#NN]
```

`_What:_` / `_Benefit:_` are parsed out of the linked issue body's existing
What/Benefit sections (already canonical there per CONTRIBUTING.md) — not
duplicated free text in the generator. The `## Won't (this round)` section
is populated from `moscow:wont`-labeled `type:feature` issues regardless of
board Status. The `## Retired numbering` section stays static hand-written
prose (historical note, not derivable from the board).

Completed (`Done`) items never appear in the generated file — matching the
existing convention that BACKLOG.md is a forward-looking planning view, not
a changelog.

Run manually (`npm run backlog:sync`), review the diff, commit like any
other doc change. No new CI job.

**Open technical risk (resolve during planning):** whether the Projects v2
GraphQL API exposes an item's manual drag-position within a column. If not,
within-bucket ordering in the generated doc falls back to a simple explicit
numeric "Priority" field on the Project — only needed if ordering fidelity
turns out to matter; the board's own drag-order remains useful either way.

### E. Done-lane retention

Start with **release-tied clearing**: add a step to the existing
release-cut checklist/script that bulk-archives `Done` items. No new
scheduled automation. A time-based auto-archive (e.g. 7 days after issue
close, via a daily cron against the Projects GraphQL API) is a plausible
follow-up once it's clear how fast `Done` actually fills up between
releases — not built now.

## Rollout / migration (one-time)

1. Create the Project, the Status field, both views, enable the built-in
   automations described above.
2. Bulk-add the 85 currently-open issues via a one-off script (GraphQL),
   setting an initial Status by heuristic (open + no recent activity →
   `Backlog`; linked to an open PR or recent commits → `In Progress`), then
   a manual pass to correct/fill in `Next` and `Parked`.
3. Strip stray `moscow:*` labels off existing `type:chore` issues.
4. **Initiative retrofit:** identify existing multi-issue efforts (language
   support work, the LAN cert broker, voice cloning, etc.), create a parent
   tracking issue per initiative, link existing issues as sub-issues.
5. **Branch/worktree audit:** for each local branch and worktree not merged
   or deleted, correlate to an issue (file one if none exists), and set
   that issue's Status to `Parked` with the mandatory explanatory comment —
   or flag for deletion if genuinely abandoned. No branch/worktree deletion
   happens without explicit user sign-off per item.
6. **Memory-overhang audit:** sweep the "SHIPPED but owes X" entries
   currently tracked only in the memory system, file missing follow-up
   issues, set correct Status on the board.
7. Build and test `npm run backlog:sync`, run it once, commit the
   regenerated `docs/BACKLOG.md`.
8. Add a "clear Done items" step to the release-cut checklist.
9. Update `CONTRIBUTING.md`'s Issues section, and update
   `docs/features/166-github-issues-backlog-integration.md`'s status to
   reflect that its "no Projects board" decision has been superseded by this
   spec.

## Testing

- `backlog:sync` is new code (a script parsing issue bodies and querying
  GraphQL) — gets unit tests per the project's testing discipline (parsing
  logic, moscow grouping, Won't-section handling) plus a fixture-based
  integration test against a canned GraphQL response.
- The one-off bulk-add/backfill and branch-audit scripts are throwaway
  rollout tooling, not part of the ongoing test surface — reviewed by hand
  during rollout rather than unit tested.
- No automated test coverage applies to the Project's own configuration
  (fields/views/workflows) — that's GitHub-hosted config, verified by eye
  during rollout.

## Out of scope / future follow-ups

- Time-based auto-archive for `Done` (cron-based), if release-tied clearing
  proves insufficient.
- Bot-enforced "Parked needs a comment" check, if process-mandatory
  discipline proves insufficient.
- A recurring (not just one-time) branch/worktree hygiene sweep.
