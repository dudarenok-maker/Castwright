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

## Pass-1 review update (2026-09-07) — five corrections, one nit

Everything above records the script AS FIRST WRITTEN. The PR's mandatory
review pass found five correctness bugs in it; the notes below say what is
now different, so this file does not read as a description of the shipped
script when it is a description of its first draft.

- **The `--apply` write path was untested.** The suite claimed to cover it,
  but the test copied `applyBookPlan`'s body inline and asserted on the copy.
  Four mutations of the REAL function left the suite fully green: swapping
  `retireCharacterId`'s last two arguments (which drives its FORWARD branch
  and re-inflicts the exact A34 defect this script exists to repair),
  stubbing the whole function to `return;`, deleting the partial-repair
  refusal, and turning the `ascii-id-already-live` branch into a repair.
  `applyBookPlan` and `backupBeforeApply` are now exported and driven
  directly; each of those four mutations reddens a named test.
- **`collectBakNameEntries`'s `bakAvailable` flag was discarded.** One
  unparseable `cast.json.bak.*` is swallowed to `null`, contributes zero
  entries, and `buildNameIndex`'s `normSet.size > 1` then reads the
  survivors as *unambiguous* rather than as *unknown* — so lost evidence
  produced a **confirmed** repair. `planBookRepairs` now takes
  `bakAvailable` and withholds every matched pair in the book when it is
  `false` (`bak-evidence-unreadable`), the same gate
  `repair-cast-id-drift.mjs` already applies. The "no bak evidence /
  ambiguous / mismatch" list above is therefore now five reasons, not three.
- **The same-name confirmation had no uniqueness rule.** A bare 1-1 name
  comparison auto-confirmed when two live rows share a display name (Солдат,
  Стражник, the `unknown-*` buckets), which would permanently bind the
  retired id — and every attribution behind it — to possibly the wrong row,
  at a different `voiceUuid`. `resolveTierAName`'s tie rule
  (`repair-cast-id-drift.mjs`) is now mirrored: a tie means stop
  (`live-name-not-unique`).
- **The two-file write had no backup and ran in the wrong order.** The order
  described above (cast.json first, history second) is reversed: history
  first. If `retireCharacterId` throws — `CastIdHistoryUnreadableError`, its
  own `withKeyLock` timeout, an AV-scanner EPERM — cast-first leaves the
  live id ASCII while the history still points at the dead non-ASCII one,
  which `buildCastResolver` drops, orphaning *every* attribution in the
  book. History-first leaves every attribution resolvable. Both files are
  also copied to `<file>.bak.a34-<date>` before either write, and a part-way
  failure names those copies in its error.
- **`KNOWN_STANDING_PORTS` blinded the shared liveness probe to 8090** —
  this repo's own worktree slot-1 `PORT`, inside the default 8080
  auto-rebind walk. Now a per-run `ALLOW_STANDING_PORTS` opt-in, empty by
  default, with tests (there were none).

The `25/25` figure above is that draft's. The suite is **43/43** as shipped.

## Pass-2/3 review update (2026-09-08) — backup stamp tightened again

The pass-1 bullet above ("Both files are also copied to
`<file>.bak.a34-<date>` before either write") described the stamp as it stood
after pass 1: date-only. A later review pass found a same-day retry could
overwrite that same file, destroying the one pre-repair backup a retry most
needs — so the stamp is now `new Date().toISOString().replace(/[:.]/g, '-')`
(millisecond resolution, filesystem-safe), giving each run its own
`.bak.a34-<stamp>` file. The sibling script (`repair-cast-id-drift.mjs`) had
the identical date-only-stamp defect and was fixed the same way (#3095). This
file otherwise still reads as pass-1 described it.
