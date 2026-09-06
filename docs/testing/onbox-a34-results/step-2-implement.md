# A34 step 2 — implement + test the wrong-direction repair script

Register row A34 (#2584, #2040), parent #2903. No file under
`C:\AudiobookWorkspace\books\` was read or written by this step — this is a
code + tests step only, per scope (running against the real workspace is
steps 3-4).

## What was built

`scripts/repair-a34-wrong-direction-ids.mjs` — a dry-run-by-default,
`--apply`-gated repair script for the wrong-direction `characterId`
retirement shape PR #2640's `stripEstablishedAsciiRewrites`
(`server/src/analyzer/roster-dedup.ts`) stops from happening again going
forward, but cannot repair once it is already on disk: an established
ASCII-kebab id that a prior analysis retired in favour of its non-ASCII
sibling, even though both name the same character (step 1's on-box scope:
1 hit — `Заказ Коалфолла`'s `oduvan → одуван` — across the 23 books
scanned).

Paired tests: `scripts/tests/repair-a34-wrong-direction-ids.test.mjs`.

### Why

The detector reuses `stripEstablishedAsciiRewrites`'s own gate exactly (ASCII
`from`, non-ASCII `to`, same character by `normaliseForMatch`) rather than
inventing a second name-equivalence rule, per the issue's own instruction.
The one wrinkle: `stripEstablishedAsciiRewrites` runs during a live analysis,
when both the prior cast row and the fresh roster survivor are in memory —
an offline repair pass has no "prior cast" once the ASCII row has been fully
retired from `cast.json`. The only on-disk evidence of what that row used to
be named is a `cast.json.bak.*` snapshot from before the retirement (which
step 1's own cross-check already relied on for the one real hit:
`cast.json.bak.castfix` names `oduvan` "Одуван", matching the live `одуван`
row's name today). So the script reuses `repair-cast-id-drift.mjs`'s own
`collectBakNameEntries`/`buildNameIndex` for that lookup — the same
ambiguity handling (a bak file naming one id under two different normalised
names marks it ambiguous, never guessed) rather than a second, weaker
version of it — and reuses `collectBooks` and `probePortRangeRefused`
(the `--apply` liveness probe) from the same file too, all already exported
there. `normaliseForMatch` and `isAsciiKebabId` themselves are small, pure,
and replicated verbatim (with a comment tying them to their source) rather
than imported, so every planning-helper test runs with no `server/dist`
build step — only `main()`'s `--apply` write path (`retireCharacterId`,
`writeJsonAtomic`) needs the compiled server, mirroring the split
`repair-cast-id-drift.mjs`'s own test file already documents.

A pair that matches the id-shape but has no bak evidence, ambiguous bak
evidence, or a bak name that does NOT match the live name is `reportOnly` —
never auto-repaired. This is what keeps a genuine cross-script alias merge
(e.g. `шеф` → `Борис Игнатьевич`, the exact counter-example
`stripEstablishedAsciiRewrites`'s own doc comment discusses) from being
mistaken for the #2584 coincidence.

The repair itself, once confirmed: rename the live character's `id` in
`cast.json` from the non-ASCII id back to the ASCII id (every other field
carried over unchanged), then call the server's own `retireCharacterId`
retiring the non-ASCII id in favour of the ASCII one. That function's
existing "direct reversal" branch (`server/src/store/cast-id-history.ts`) is
exactly this case — it already detects `supersededBy[to] === from` and
inverts correctly — so no second, hand-rolled history writer was needed.

A book with zero confirmed pairs is never written to, in either file:
`planWorkspaceRepairs` only returns a book when it has ≥1 confirmed
`repairs` entry.

## Test output

```
ℹ tests 25
ℹ suites 0
ℹ pass 25
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
```

Coverage includes (per the issue's minimum list, plus the report-only /
mutation-guard cases the detector's own soundness depends on):

- correct direction detected and reversed;
- a correctly-oriented (already-ASCII-live, i.e. non-ASCII → ASCII) entry
  left untouched;
- an ASCII → ASCII entry (a different, legitimate rewrite shape) left
  untouched;
- the `--apply` liveness-probe refusal fires and blocks the write — proven
  against a REAL `net` listener bound on an ephemeral port (not a stub),
  asserting both files are untouched and the process exit code is set;
- dry-run makes no filesystem writes — proven end-to-end through `main()`
  against a real fs fixture shaped exactly like `collectBooks` expects, not
  just the pure planning step;
- no bak evidence / ambiguous bak evidence / a bak name that does not match
  the live name → `reportOnly`, never auto-repaired;
- a book with zero confirmed pairs is excluded from `bookPlans` entirely;
- a mutation of the core direction-detection boolean (dropping the `to`-side
  ASCII check) was manually applied and confirmed to redden 4 tests
  (including a test written specifically to pin that condition), then
  reverted — the full 25/25-green suite above is the POST-revert run.

`eslint` on both new files: clean, exit 0, no findings.

## Not run this step

No real-workspace scan or `--apply` run — `main()`'s `server/dist` write
path (`loadServerModules`) was exercised only indirectly, via the same
write-shape (rename id, call `retireCharacterId`) driven against fakes in
the paired test file, and via the actual liveness-probe/dry-run tests
against `main()` itself over an fs fixture. `cd server && npm run build`
has not been run in this worktree. Steps 3 (dry-run against the real
workspace) and 4 (`--apply`) are separate, later steps.
