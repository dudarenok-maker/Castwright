---
status: active
shipped: null
owner: null
---

# Cast-authoritative character identity (#2040)

> Status: active — Waves 1-3 shipped code + tests; on-box acceptance owed (A32, B3, A33)
> Key files: `server/src/store/cast-resolve.ts`, `server/src/store/cast-id-history.ts`,
> `server/src/store/remap-fresh-to-prior.ts`, `server/src/audio/segments-io.ts`,
> `server/src/routes/cast-reject-orphan.ts`, `src/views/cast.tsx`, `src/store/cast-slice.ts`,
> `scripts/repair-cast-id-drift.mjs`
> URL surface: `#/books/<id>/cast` (the orphaned-id advisory banner)
> OpenAPI ops: `GET /api/books/{id}` (`orphanedCharacterFallbacks` field),
> `POST /api/books/{bookId}/cast/{characterId}/reject-orphan-match`

## Benefit / Rationale

- **User:** a character's lines no longer silently switch to the narrator's voice
  just because a re-analysis spelled their internal id slightly differently. Where
  a mismatch can't be resolved automatically, the Cast screen names it and offers a
  one-click "not the same character" correction instead of a mystery.
- **Technical:** `cast.json` is now unambiguously the identity of record. Every
  code path that used to join on a raw `characterId` string now reads through one
  resolver (`buildCastResolver`), so there is exactly one place that decides
  whether two ids name the same person — not eight independent `.get()` calls
  that could each drift out of sync with the others.
- **Architectural:** id history moved off the `Character` record and into its own
  side-table (`.audiobook/cast-id-history.json`), because three adversarial design
  rounds found five different places that silently rebuild a `Character` from an
  explicit field list and drop anything not on it. A side-table can be *missed* by
  a future call site (an orphan stays an orphan, visible in the banner) but it can
  no longer be *destroyed* by one — the failure mode changed from "silent data
  loss" to "silent no-op," which is the whole point of the shape.

## Architectural impact

- **New seams:** `buildCastResolver(cast, history)` (`server/src/store/cast-resolve.ts`)
  is the single id-resolution choke point for every render/QA/drift-detection read
  site. `retireCharacterId(bookDir, from, to)` (`server/src/store/cast-id-history.ts`)
  is the single write choke point for every id-retiring code path. Any new code
  that joins two artifacts on `characterId` must go through the former; any new
  code that changes a persisted character id must call the latter — see
  "Invariants to preserve" below, and the matching `CLAUDE.md` entry.
- **Invariants preserved:** `characterSchema`, `openapi.yaml`'s `Character` schema
  and `api-types.ts` are untouched by Waves 1-2 by deliberate design constraint —
  the id history is not a field on `Character` (spec §4.1). Wave 3 adds one new
  openapi path (`reject-orphan-match`) and widens `orphanedCharacterFallbacks`
  (both additive, no existing field removed or retyped beyond `characterId`
  relaxing from required to optional).
- **Migration story:** none required for existing `cast.json` files — the side-table
  is a new, optional, per-book file that degrades to today's behaviour when absent.
  `scripts/repair-cast-id-drift.mjs` is the one-time backfill for the 20 books that
  already carry drift; it has **only ever run in dry-run mode** as of this plan's
  `active` status (see "On-box acceptance" below) — no real book has been repaired
  yet.
- **Reversibility:** deleting `.audiobook/cast-id-history.json` for a book reverts
  it to pre-Wave-1 resolution (exact-id-only) with no other side effect — the file
  is never authoritative for identity, only a lookup aid. A rejected reconciliation
  (`POST .../reject-orphan-match`) has **no in-app undo** — see "Out of scope"
  and follow-up #2089.

## Invariants to preserve

1. **`cast.json` is the identity of record.** The analyzer's `characterId` — and
   the analysis cache's, and a frozen `segments.json`'s — is an *alias* into that
   identity, never the identity itself. `server/src/store/cast-resolve.ts:63-140`
   (`buildCastResolver`) is the only place that decides whether an alias names a
   live cast row.
2. **Any code path that changes a persisted character id calls `retireCharacterId`
   through the choke point.** `server/src/store/cast-id-history.ts:98-163`
   (`retireCharacterId`) records the old id before the new one takes over, and
   repoints any existing entry that pointed at the old id so resolution stays a
   single O(1) lookup — both on the direct-reversal branch (`:126-136`) and the
   general case (the repoint loop at `:151-158`). The five original call sites
   are enumerated in the design spec §4.4; a sixth (`scripts/repair-cast-id-drift.mjs`)
   writes the same side-table out-of-process, gated on no live server being
   reachable (`probePortRefused`, `scripts/repair-cast-id-drift.mjs:689`).
3. **The resolver never matches on display names.** `buildCastResolver` is
   ids-only — four tiers, first hit wins: a live exact id (`via: 'exact'`), a
   non-rejected `rejected`-checked-after-exact history hit (`via: 'history'`), a
   normalised id (`via: 'normalised-id'`), a normalised history hit
   (`via: 'normalised-history'`). Name matching happens only at merge/repair time
   (`server/src/store/remap-fresh-to-prior.ts`, and the Tier A/B matcher inside
   `scripts/repair-cast-id-drift.mjs`) — never inside the resolver itself.
4. **A tie never guesses.** If two cast rows (or two history entries) share a
   normalised key, `buildCastResolver.resolve()` returns `undefined` rather than
   picking one — silently rendering one character's lines in another's voice is
   strictly worse than the narrator-substitution fallback it would replace.
5. **`rejected` is checked after `exact`, ahead of the other three tiers**
   (`cast-resolve.ts:108-116`) — a live cast row always wins over a stale
   rejection, so a reclaimed id (the character's own name minted again by a later
   re-analysis) is never permanently shadowed by a past "not the same character"
   decision. This is a deliberate deviation from spec §4.6's original wording; see
   "Deviations from the spec" below.
6. **Frozen `<slug>.segments.json` files are never rewritten to migrate ids**
   (spec §3) — the resolver reads through drift instead of correcting it at rest.
   `chapter-qa-repair.ts` rewriting a segments file as part of its own normal
   repair job is not covered by this rule; `scripts/repair-cast-id-drift.mjs`
   writes only `cast-id-history.json`, never `cast.json` or any `segments.json`.
7. **The banner's auto-reconciled/needs-your-decision split has no fuzzy "closest
   candidate" ranker of its own** (`src/views/cast.tsx`) — the only ranked
   candidate list in the whole feature lives in `scripts/repair-cast-id-drift.mjs`
   (`rankSnapshotCandidates`). Two independent rankers is the exact
   duplicate-matching-logic defect class Task 16's CRITICAL finding came from
   (see "Deviations from the spec").
8. **An interim `cast.json` write never removes an id from the persisted
   roster** (srv-87, #2086). The three interim ("Cast so far") writes
   (`analysis.ts:3633`, `:3845`, `:5613`) go through
   `overlayInterimCastForLiveView` (`server/src/store/merge-analysis-cast.ts`),
   which has no id-drift name-fallback and produces no `retirements` — there is
   nothing in its return type for a caller to discard. Only the two
   authoritative end-of-run writes (`:4885`, `:6148`) apply identity merges and
   call `retireCharacterId`. Before this fix, a mid-run death — **or a
   completed run whose `phase1DriftExceeded` gate skipped the authoritative
   write** (`analysis.ts:4868`; `attributionDriftExceeded` is a normal, logged,
   non-crash outcome, not only a process kill) — could leave a character's id
   durably swapped in `cast.json` with no history record, orphaning that
   character's frozen `<slug>.segments.json` entries to the narrator. Residual
   risk this closes is **not** self-repairing: the prior belief that a damaged
   `cast.json` "self-repairs on the next completed analysis" is false for the
   old→new *mapping* — the next run reads the already-swapped file as its
   prior, the analysis cache already holds the drifted id, so the fallback
   never re-fires for that pair and no retirement is ever recorded for it. Only
   the *file* becomes authoritative again; the mapping itself needs
   `scripts/repair-cast-id-drift.mjs --apply` (A33 — run 2026-08-05, but only
   **partially** discharged: the write path is proven and recorded 3
   auto-recordable aliases across 2 books, but the workspace is not
   orphan-free — 93 ids / 161 segments remain report-only, needing a human
   decision, and *Unlocked* alone still carries 34 orphaned segments under
   `unknown-male`; see the on-box register's A33 row) or a re-render to
   recover.

## Deviations from the spec

The design doc (`docs/superpowers/specs/2026-08-01-cast-character-identity-design.md`)
and plan (`docs/superpowers/plans/2026-08-01-cast-character-identity.md`) are the
design of record; four points shipped differently than either originally wrote them
down, each a deliberate controller ruling made during implementation:

- **The reject action writes a `rejected` list, not only a `notLinkedTo` edge.**
  Spec §4.6 said rejecting "removes the history entry." On every real book in the
  20-book workspace, **zero** `cast-id-history.json` files exist — every currently
  orphaned segment resolves through the *normalised* tiers, where there is no
  history entry to remove. A reject that only deleted history entries would have
  been a button that does nothing on 100% of currently-affected books. The shipped
  design (`server/src/routes/cast-reject-orphan.ts`) writes **three** things: a
  `rejected` list in `cast-id-history.json`, honoured by `buildCastResolver` (this
  is what actually stops read-side resolution); the one-sided `notLinkedTo` edge on
  the live character naming the orphaned id (this is what stops the next
  re-analysis's name matcher from re-recording it — spec §4.6's original durability
  requirement, which stays correct as written); and, non-fatally
  (`cast-reject-orphan.ts:148`), a `forgetSupersededId` call that clears any stale
  `supersededBy` entry for the same id — redundant with `rejected` for resolution
  purposes, but left in so a rejected id doesn't linger in two places at once.
- **`rejected` is checked after the `exact` tier, not ahead of all four.** The
  first implementation round followed the brief literally (ahead of all four
  tiers, including `exact`) and it was wrong: a rejected id is, by construction,
  not live at reject time, but a *later* re-analysis can mint that exact string
  again as a genuine new live character — an orphaned id is very often the
  character's own name. Checking `rejected` ahead of `exact` would have
  permanently shadowed that reclaimed id behind its own past rejection,
  reintroducing #2040's own bug through the feature meant to fix it. Fixed in
  Task 17 fix round 1; see `cast-resolve.ts:108-116`.
- **No fuzzy "closest candidate by name" ranker in the banner.** Spec §4.6
  mentions surfacing the closest candidate by name for a genuine miss. The banner
  (`src/views/cast.tsx`) instead shows the orphaned id and segment count with a
  plain `<select>` of the live cast — no ranking. The one candidate ranker that
  exists (`rankSnapshotCandidates`, gender/age/attributes/tone-scored) lives only
  in `scripts/repair-cast-id-drift.mjs`, deliberately, so there is one ranker in
  the whole feature and not two independently-maintained ones that could disagree.
- **The repair pass never auto-records an alias whose SOURCE is a reserved
  fold-bucket id** (`narrator`, the male/female fold buckets), and any cross-source
  name ambiguity vetoes auto-recording from either source for that id. Neither
  guard is in the original spec/plan — both were added after a whole-branch review
  found the pass would otherwise have auto-recorded `unknown-male → timkin` on the
  real *Exile* book, where the analysis cache separately names the same bucket id
  Timkin (ch7), Rex (ch33) and an unnamed ch60 group across the book — "repairing"
  by routing Rex's lines onto Timkin's voice, the same harm class the whole feature
  exists to prevent. See `scripts/repair-cast-id-drift.mjs`'s `planBookRepairs` and
  `task-18-report.md`'s "Round 1 addendum" for the full account.

## Test plan

### Automated coverage

- `server/src/util/character-id.test.ts` — `normaliseIdKey`: separator/case
  collapse, non-Latin preservation, never equates ids whose letters differ.
- `server/src/store/cast-resolve.test.ts` — all four resolver tiers, a genuine
  miss, a normalised tie returning `undefined`, `via` tier precedence (including
  the CRITICAL regression: a live normalised id beats an unrelated normalised
  history entry), and `rejected` checked after `exact`.
- `server/src/store/cast-id-history.test.ts` — `retireCharacterId` idempotency,
  no-op on `from === to`, repoint-on-chain, the direct-reversal guard, and the
  `rejected` field's validation.
- `server/src/store/cast-id-history.survival.test.ts` — a client cast `PUT` and a
  reparse (`applyReparse`, which `rm`s `cast.json`) both leave
  `cast-id-history.json` intact, with **no production code change** — the test
  that pins the whole rationale for moving history off the `Character` record.
- `server/src/store/remap-fresh-to-prior.test.ts` — the early remap on both the
  main and subset analyzer paths: keeps the prior id, refuses an ambiguous name
  match, honours a `notLinkedTo` edge, composes correctly with the same run's own
  dedup rewrites (the §11 Q2 regression).
- `server/src/tts/synthesise-chapter.orphan-alias.test.ts` — an orphaned id
  resolves through an alias at the real render path; the `:1519` clone
  pre-pass regression guard; a genuine miss still stamps the #2023 orphan fallback.
- `server/src/audio/build-synth-replacement.alias.test.ts` — `findDivergentSentences`
  tolerates an alias-only difference but still reports a genuine reattribution; a
  rejected alias no longer counts as "the same person."
- `server/src/audio/segments-io.test.ts` — `collectOrphanedCharacterFallbacks`
  reports every unresolved id (not only #2023-stamped ones), tags `alias` /
  `normalised` / `unresolved` correctly via the resolver's own `via` field, never
  reports an exact live id, forward-fills `voiceName`/`characterId` across
  chapters, accumulates `segments` count.
- `server/src/routes/cast-reject-orphan.test.ts` +
  `cast-reject-orphan.failure-modes.test.ts` — the reject route's write ordering
  (notLinkedTo edge before the history writes), self-pair 400, idempotency,
  `forgetSupersededId` non-fatal vs. `rejectOrphanedId` fatal (500) failure modes.
- `server/src/routes/cast-id-history-wiring.test.ts` — the full route→collector→
  synth hop carries `{schema, supersededBy, rejected?}` as one object, not a bare
  map with a separately-threaded array (Task 17 fix round 1's structural fix).
- `src/store/cast-slice.test.ts`, `src/views/cast.test.tsx` — the banner split
  (auto-reconciled collapsed by default, needs-your-decision always expanded),
  `applyOrphanRejection`, error-toast and busy-disable paths on the reject action.
- `scripts/tests/repair-cast-id-drift.test.mjs` — every pure helper: name-index
  building, Tier A/B candidate resolution, `snapshotsConsistent`, the reserved-
  source guard, the cross-source ambiguity veto, the zero-segment guard,
  `rankSnapshotCandidates`'s scoring, the re-render list shape, and
  `probePortRefused`'s fail-closed behaviour (verified live against three real
  listener shapes, not only unit-tested).
- `e2e/orphaned-character-fallback-banner.spec.ts` — both banner sections render
  from a real hydrate-shaped payload; the reject flow round-trips through the
  redux store in a real browser; the reject button stays disabled until a
  candidate is picked.

### Manual acceptance walkthrough

Run in mock mode (`VITE_USE_MOCKS=true`, i.e. plain `npm run dev`) — mock-mode
generation has no per-line attribution model, so the orphaned-fallback map is
seeded directly via the real `cast/setOrphanedCharacterFallbacks` reducer through
`window.__store__.dispatch(...)`, exactly as `e2e/orphaned-character-fallback-banner.spec.ts`
does. This is the same reason that spec exists: the seam under test is
redux → rendered DOM, not the server-side aggregation (which has its own
`segments-io.test.ts`/`book-state.test.ts` coverage).

1. **Confirm any book's cast, land on `#/books/<id>/cast`.** Expected UI: no
   orphaned-id banner (`[data-testid="orphaned-character-fallback-banner"]`
   absent).
2. **In the browser console:**
   ```js
   window.__store__.dispatch({
     type: 'cast/setOrphanedCharacterFallbacks',
     payload: {
       mayrin: { resolution: 'alias', resolvedCharacterId: 'narrator', segments: 6 },
       coalfall: { resolution: 'unresolved', segments: 13 },
     },
   });
   ```
   Expected UI: the banner appears. `needs-your-decision`
   (`[data-testid="orphaned-needs-decision"]`) is expanded by default, naming
   `coalfall` and "13 segments." `auto-reconciled`
   (`[data-testid="orphaned-auto-reconciled"]`) is collapsed — the list is not in
   the DOM until its toggle is clicked.
3. **Click the "N character id(s) auto-reconciled" toggle.** Expected UI: the
   list appears, naming `mayrin` and "6 segments."
4. **In the `needs-your-decision` row for `coalfall`,** the "Not the same
   character" button is disabled. Pick a candidate from its `<select>`. Expected
   UI: the button enables.
5. **In the `auto-reconciled` row for `mayrin`,** click "Not the same character"
   (pre-filled, no picker needed). Expected redux state: `mayrin`'s
   `orphanedCharacterFallbacks` entry flips to `resolution: 'unresolved'`,
   `resolvedCharacterId` cleared. Expected UI: `mayrin` drops out of
   `auto-reconciled` and reappears under `needs-your-decision` (now two rows).

## Out of scope

- **Retro-migrating ids inside a frozen `segments.json`.** The resolver reads
  through drift instead (spec §3, invariant 6 above). Re-rendering is the only
  way to correct audio already on disk.
- **A UUID primary key replacing the free-text id.** Considered and rejected for
  this round (spec §3) — out of scope until the current design proves
  insufficient.
- **Making the analyzer's id deterministic.** Not something this design controls
  or depends on.
- **Moving the analysis-cache write after the early remap pass** (spec §11 Q3).
  Cache drift (89 distinct cache-orphan ids across 18 books, per spec §6 —
  larger than the 11-id/188-segment rendered-damage population) stays masked by
  aliases rather than stopped at the source. Recorded as an open design question,
  not a task.
- **An in-app undo for a rejected reconciliation.** Filed as
  [#2089](https://github.com/dudarenok-maker/Castwright/issues/2089) (fs-78) —
  rejecting is durable and irreversible today, with no confirm step.
- **`cast-create` re-minting a merged-away character id** — filed as
  [#2085](https://github.com/dudarenok-maker/Castwright/issues/2085) during
  Wave 2. (Its sibling, auto-repairing the interim cast.json write path, was
  also filed during Wave 2 as #2086 — that one has since shipped; see
  invariant 8 above.)
- **The repair script's `--apply` liveness probe missing an auto-rebound port** —
  `server/src/crash-logging.ts:155-162` auto-rebinds on `EADDRINUSE` to
  `port+1..port+19`; the probe only checks the configured port and the LAN HTTPS
  port. Filed as [#2090](https://github.com/dudarenok-maker/Castwright/issues/2090)
  (ops-50).
- **Rejecting a needs-your-decision row writes a permanent id-wide block that
  buys nothing there, with no visible row change.** `reject-orphan-match` calls
  the same id-scoped `rejected` write (`cast-resolve.ts:113`) whichever banner
  section the click came from. On an auto-reconciled row that's the point — stop
  a wrong resolution. On a needs-your-decision row the id was never resolving in
  the first place, so the only useful effect is the `notLinkedTo` edge; the
  `rejected` entry instead permanently blocks that id from ever resolving via
  history or either normalised tier again, with no undo (#2089) and no visible
  sign in the UI that a permanent decision was made. Filed as
  [#2092](https://github.com/dudarenok-maker/Castwright/issues/2092) (fs-79).

## On-box acceptance

Three rows owed — see
[`docs/testing/onbox-acceptance-register.md`](../testing/onbox-acceptance-register.md)
and the run sheet
[`docs/testing/cast-id-drift-onbox-acceptance.md`](../testing/cast-id-drift-onbox-acceptance.md):

- **A32** (Wave 1) — re-rendering an already-drifted real chapter puts the
  character's own voice on their lines, confirmed by listening, not only by the
  JSON fields.
- **B3** (Wave 2) — a real analyzer re-analysing an already-drifted real book
  keeps the cast's existing id (or correctly records a genuine change) instead of
  drifting it further.
- **A33** (Wave 3) — the repair pass's `--apply` run against the real workspace.
  **Never executed as of this plan's `active` status.** The dry run (2026-08-05,
  round-2 review fixes applied, `CACHE_DIR` correctly pointed at the checkout
  that ran this workspace's analysis) reports: **3 auto-recordable aliases
  covering 27 segments**, **93 ids reported for a human decision covering 161
  segments** (corrected from a prior 93 — see below), **17 re-render rows
  covering 120 segments**, **0 books modified**, **0 books missing
  analysis-cache evidence**. `--apply` now refuses outright if that last
  number is nonzero (round-2 review fail-closed fix — a missing cache file
  silently defeated the cross-source ambiguity veto). See the run sheet's
  Wave 3 section for the exact walkthrough.

## Ship notes

Not yet `stable`. Fill in when Wave 3 ships (PR merges) and the three on-box rows
above are discharged or explicitly deferred with the repo owner's sign-off.
