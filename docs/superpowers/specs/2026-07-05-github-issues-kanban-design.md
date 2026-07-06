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
didn't anticipate the overhang-visibility problem. Plan 166's own rollout
(label taxonomy, issue migration, BACKLOG.md thinning) appears functionally
complete against the live repo — issues are labeled, `docs/BACKLOG.md` is
already in its thinned form — even though the plan's frontmatter still reads
`status: active` / `shipped: null`. This spec's rollout flips that status to
`stable` alongside noting the supersession, rather than assuming it without
checking.

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
`type:feature` issues.

**This is a real reclassification, not cosmetic cleanup.** Live-querying the
repo during review found roughly 15 `type:chore` issues currently carrying a
`moscow:*` label (1 `must` — `ops-16`/#822 —, 3 `should`, 11 `could`) — step
3's label-strip and the `docs/BACKLOG.md` generator both apply to this full
set, not just a couple of examples. Three of these are the sharpest
illustration of what's at stake: `side-23`/#1228, `ops-17`/#790, and
`srv-4`/#431 all carry `moscow:should` and are ranked in `docs/BACKLOG.md`'s
Should bucket today. Two of the three (`side-23`, `srv-4`) already carry
`tracking` — upstream-blocked watchdogs
("wake when X ships"), not do-whenever busywork. `ops-17` matches the exact
same semantic (its body: "Blocked upstream... re-check periodically and bump
when upstream ships") but doesn't yet carry the `tracking` label — rollout
step 3 adds it there so label-driven routing (§B) actually catches it. Moving
these out loses their MoSCoW rank and their `docs/BACKLOG.md` visibility;
their new visible home is the **Waiting/Blocked** lane on the Bugs & Chores
board (§B), not the generated doc. This trade-off is deliberate — see §B and
§D — not an oversight.

`docs/BACKLOG.md` only ever reflects `type:feature` issues going forward.
Bugs were already excluded by existing convention; chores are now excluded
too, including the `tracking` ones described above.

### B. Board structure

One GitHub Project (v2). One custom field: **Status** (single-select:
`Backlog`, `Next`, `In Progress`, `Parked`, `Waiting/Blocked`, `Done` — 6
values total). Two saved views over the same underlying items, each showing
only the subset of Status values that applies to its track:

- **Backlog view** — filtered to `type:feature`. Board grouped by Status,
  showing `Backlog`/`Next`/`In Progress`/`Parked`/`Done` (5 columns;
  `Waiting/Blocked` hidden — a feature can already express "blocked" via
  `Parked` + its mandatory comment). Priority within a column is signaled by
  the existing `moscow:*` label plus manual drag-order for fine sequencing
  (mirrors how BACKLOG.md row order already works today).
- **Bugs & Chores view** — filtered to `bug` OR `type:chore`. Board grouped
  by the same Status field, showing `Backlog` (used here as "Open,
  unclaimed"), `In Progress`, `Waiting/Blocked`, and `Done` (4 columns;
  `Next` hidden — this track isn't priority-queued). `tracking`-labeled
  issues (upstream-blocked watchdogs like `side-23`/`ops-17`/`srv-4`, once
  rollout step 3 adds the label to `ops-17`) live in `Waiting/Blocked` rather
  than being stranded in `Backlog` indefinitely — this is their home now that
  they've lost `docs/BACKLOG.md` visibility (see §A). Placement into
  `Waiting/Blocked` is a manual drag during rollout (and thereafter whenever
  a chore turns out to be externally blocked) — the `tracking` label signals
  which issues these are, but auto-routing by label isn't part of the
  built-in workflow set below and isn't built now.

**Mostly built-in automation** for the common-path transitions: a new issue
is auto-added to the board with Status = `Backlog`. **Auto-add is now driven
by a version-controlled Action** (`.github/workflows/add-to-project.yml`, via
`actions/add-to-project`, ops #1390) rather than the Project's built-in
"Auto-add to project" workflow, which had been leaking issues onto the floor
(e.g. #1386, #1377) — the Action fires on `issues: [opened, reopened,
transferred]` and needs the `ADD_TO_PROJECT_PAT` repo secret (the default
`GITHUB_TOKEN` can't write a user-owned Projects v2 board). Everything else
below stays built-in:
GitHub's separate **"Item closed"** workflow moves that issue's card to
`Done` when the issue itself closes (including via a PR's `Closes #NN` on
merge); a reopened issue moves back to `Backlog`. These are two distinct
built-in workflows, not one — a PR that merges without formally closing its
linked issue won't move the card. All other transitions (`Next`, `In
Progress`, `Parked`, `Waiting/Blocked`) are manual drags.

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

**Open technical risks (resolve during planning, before committing to this
script):**

- Whether the Projects v2 GraphQL API exposes an item's manual drag-position
  within a column. If not, within-bucket ordering falls back to an explicit
  numeric "Priority" field maintained by hand on the Project — which is
  itself a form of hand-maintenance, just narrower (one ordering field
  instead of the whole doc). The "stop hand-maintaining `docs/BACKLOG.md`"
  benefit in the Goals section should be read with this caveat: it removes
  hand-maintenance of prose/structure, not necessarily of fine-grained
  ordering.
- Whether every current `type:feature` issue body actually has cleanly
  parseable `_What:_`/`_Benefit:_` sections — the `backlog-item.yml` form
  structures new issues this way, but hand-filed or freely-edited bodies
  aren't guaranteed to match. Rollout step 7 (below) now includes an audit
  pass for this before the generator is trusted to run unattended.

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
3. Strip `moscow:*` labels off all existing `type:chore` issues — the full
   ~15-issue set (1 `must`, 3 `should`, 11 `could`), not just the three
   `tracking` examples cited in §A. Find the set with three separate
   queries — one per moscow tier, since `gh issue list --label` AND-combines
   multiple labels rather than OR-ing them: `gh issue list --label
   type:chore --label moscow:must`, then `--label moscow:should`, then
   `--label moscow:could`. This is a real reprioritization, not cleanup —
   flag it in the PR description as such. Separately, cross-reference the
   surfaced issues against the `tracking` label (`gh issue list --label
   type:chore --label tracking`) to find the ones needing a `Waiting/Blocked`
   home — the moscow-tier queries themselves don't filter by `tracking`.
   Add `tracking` to `ops-17`/#790 (matches the same upstream-blocked-watchdog
   semantic as `side-23`/`srv-4` but doesn't carry the label yet), then set
   all `tracking` chores to Status = `Waiting/Blocked` on the board as part
   of this same pass, so nothing silently loses visibility mid-rollout.
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
7. **Issue-body parseability audit:** before building `npm run backlog:sync`,
   spot-check `type:feature` issue bodies (particularly ones not filed via
   the `backlog-item.yml` form) for cleanly parseable `_What:_`/`_Benefit:_`
   sections. Fix up any non-conforming bodies by hand (matches existing
   convention that the issue body is canonical) rather than having the
   generator silently emit blanks for them.
8. Build and test `npm run backlog:sync`, run it once, commit the
   regenerated `docs/BACKLOG.md`.
9. Add a "clear Done items" step to the release-cut checklist.
10. Update `CONTRIBUTING.md`'s Issues section. Update
    `docs/features/166-github-issues-backlog-integration.md`'s frontmatter
    from `status: active`/`shipped: null` to `status: stable` (its own
    rollout is functionally complete against the live repo) and note that
    its "no Projects board" decision is superseded by this spec.

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
