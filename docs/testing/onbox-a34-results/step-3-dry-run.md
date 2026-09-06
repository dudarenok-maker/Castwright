# A34 step 3 — dry-run the repair script against the real workspace

Register row A34 (#2584, #2040), parent #2903. Read-only step: ran
`scripts/repair-a34-wrong-direction-ids.mjs` with no `--apply` against the
**real** `C:\AudiobookWorkspace`. No file under `C:\AudiobookWorkspace\books\`
was written by this step.

## Pre-check: server liveness

`--apply` gates on the port-refused probe, but a dry run never calls it — no
writes happen either way, so this is belt-and-braces, not a hard requirement
for this step. `Get-NetTCPConnection -LocalPort 8080,8443` showed 8443 in
`Listen` state (a LAN HTTPS dev server instance was up at the time); 8080 was
not listening. Irrelevant to this step's result since dry-run makes no writes
and never probes ports itself — noted here only so step 4 (which does need
`--apply` and will hit the real port-refused gate) knows to stop that instance
first.

## Method

Ran from the worktree, pointed at the real workspace via env var (not a
throwaway copy, per the issue):

```
$env:AUDIOBOOK_WORKSPACE = 'C:\AudiobookWorkspace'
node scripts\repair-a34-wrong-direction-ids.mjs
```

## Full dry-run output

```
=== A34 (#2584/#2040) wrong-direction characterId repair pass ===
mode: DRY RUN (no writes)
workspace: C:\AudiobookWorkspace
books scanned: 23

report-only (id-shape matched, but same-character NOT confirmed — never auto-repaired): 2
  - [Derek Landy / Skulduggery Pleasant / Playing with Fire] lightning-dave -> lightning_dave (no-name-evidence)
  - [Derek Landy / Skulduggery Pleasant / Playing with Fire] the-torment -> the_torment (no-name-evidence)

confirmed repairs: 1 across 1 book(s)
  - [Castwright / Standalones / Заказ Коалфолла] would reinstate "oduvan" (was "одуван", "Одуван")

Re-run with --apply to write.
```

23 books scanned — matches step 1's manual count exactly. `AudiobookWorkspace`
also contains a `Castwright (throwaway test)` directory and a
`______ __________` (mojibake-named) directory at the top level, both outside
`books\` at the scanned root or otherwise not carrying a `cast.json` the
script's `collectBooks` picks up — the scanned total still lands on 23,
matching step 1.

### The 2 report-only entries are new information, not a discrepancy

Step 1's manual classification called `Playing with Fire`'s
`lightning-dave→lightning_dave` and `the-torment→the_torment` "ASCII→ASCII"
and ruled them out on that basis. The script's `isAsciiKebabId` is stricter —
it requires **hyphens only** (`/^[a-z0-9]+(-[a-z0-9]+)*$/`), so an
underscore-bearing id like `lightning_dave` fails the kebab test and the pair
passes the script's shape gate (`from` kebab, `to` not-kebab-shaped). This is
not a bug and not a second real hit: both are correctly routed to
`reportOnly` with reason `no-name-evidence`, confirmed by hand below, and
`planWorkspaceRepairs` only adds a book to `bookPlans` (the confirmed,
appliable set) when it has at least one entry in `repairs` — a `reportOnly`
book with zero `repairs` entries is never touched by `--apply` in step 4.

## Confirmed repair — manual spot-check (1 of 1 confirmed pairs)

`Castwright / Standalones / Заказ Коалфолла`, `oduvan → одуван`:

- `.audiobook/cast-id-history.json`: `supersededBy.oduvan == "одуван"`,
  `recordedAtSeq.oduvan == 12`, `recordedAtIso.oduvan ==
  "2026-08-21T07:47:44.959Z"` — matches step 1's cross-check exactly, and no
  earlier record for `одуван` exists in the same file (11 total
  `supersededBy` entries, same as step 1's table).
- `.audiobook/cast.json`: the only live row with this identity is
  `id: "одуван"`, `name: "Одуван"`, `role: "Мастер-кузнец"`,
  `color: "halloran"` — no `oduvan` row remains live, confirming the ASCII id
  was fully retired and there is exactly one candidate row left to reinstate
  it onto.
- `.audiobook/cast.json.bak.castfix` (the pre-retirement snapshot): the
  `oduvan` row there reads `name: "Одуван"`, `role: "Blacksmith"`,
  `color: "halloran"` — same name (`normaliseForMatch("Одуван") ===
  normaliseForMatch("Одуван")`), same `color` token (`halloran`), role
  translated but semantically identical (Blacksmith / Мастер-кузнец).
- **Direction verified correct by hand**: the established ASCII id `oduvan`
  named "Одуван" existed first (`recordedAtSeq: 12`, 2026-08-21), was later
  superseded by the non-ASCII `одуван` — same character, same color tag,
  translated role — which is exactly the wrong-direction shape #2584/A34
  describes. Reinstating `oduvan` over `одуван` is the correct repair
  direction; nothing in the on-disk evidence contradicts the script's own
  conclusion.

## Report-only spot-check (1 of 2, representative — same reason applies to both)

`Derek Landy / Skulduggery Pleasant / Playing with Fire`,
`lightning-dave → lightning_dave`:

- Live `cast.json` row: `id: "lightning_dave"`, `name: "Lightning Dave"`.
- No `cast.json.bak.*` file exists anywhere under this book's `.audiobook/`
  directory at all — there is no on-disk snapshot from before whatever
  retirement produced `lightning-dave → lightning_dave`, so the script
  correctly has zero bak evidence to confirm (or refute) same-character
  identity and reports `no-name-evidence` rather than guessing. Manually
  confirmed absent, not just unread by the script.

## Result

- **23 books scanned**, matching step 1's manual count.
- **1 confirmed wrong-direction pair**, matching step 1's finding exactly:
  `Castwright / Standalones / Заказ Коалфолла`, `oduvan → одуван`
  ("Одуван", the blacksmith). Hand-verified correct and safe to apply in
  step 4.
- **2 report-only pairs** (`Playing with Fire`'s `lightning-dave` and
  `the-torment`), both correctly excluded from the appliable set for lack of
  bak evidence — confirmed by hand that no bak snapshot exists for that book.
  Neither is in `bookPlans`, so step 4's `--apply` will not touch this book.
- **0 writes** — dry run only, as scoped. No file under
  `C:\AudiobookWorkspace\books\` was modified.
