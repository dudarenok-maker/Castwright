# Shipped feature plans (archive)

Plans land here once they ship AND their behavior is locked by automated tests.
Archiving keeps `docs/features/INDEX.md` short enough to scan in a single
screen — only **active**, **deferred**, and **scaffolded** plans stay in the
top-level directory.

## When to archive a plan

A plan is eligible for archive when ALL of:

1. Its frontmatter `status:` is `stable`.
2. It has a filled-in **Ship notes** section (date + commit SHA + any spec delta).
3. Its **Test plan** lists at least one automated test that actually exists and
   passes in `npm run verify` (i.e. the regression net is real, not aspirational).
4. No active plan in `docs/features/` links to it via a fresh `[NN — …](NN-…)`
   citation that depends on the plan being top-level. (Cross-references inside
   the archive are fine; cross-references INTO the archive from active plans
   are fine — they just need to use the `archive/` path.)

## How to archive

In the same PR as the shipping change:

1. Move the file: `git mv docs/features/NN-foo.md docs/features/archive/NN-foo.md`.
2. Update `docs/features/INDEX.md`:
   - Remove the line from its top-level section.
   - Add a one-line entry to `## Shipped (archive)` at the bottom (filename
     link + one-sentence summary).
3. Update any active plan that linked to it — change the link to
   `archive/NN-foo.md`.
4. Run `npm run verify` — no test references the moved file by old path.

## Why this exists

The top-level `docs/features/` directory is the working set. A 40+ entry
INDEX hides what's still in flight behind a wall of shipped history. Archiving
shipped plans keeps the index a planning tool rather than a changelog.

The `git log` is the changelog — this directory is "what we're working on".
