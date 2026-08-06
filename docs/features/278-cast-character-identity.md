---
status: active
shipped: null
owner: null
---

# Cast-authoritative character identity (#2040)

> Status: active — Waves 1-3 shipped code + tests; on-box acceptance owed (A32, B3, A33)
> Key files: `server/src/store/cast-resolve.ts`, `server/src/store/cast-id-history.ts`,
> `server/src/store/remap-fresh-to-prior.ts`, `server/src/audio/segments-io.ts`,
> `server/src/routes/cast-reject-orphan.ts`, `server/src/routes/cast-create.ts`,
> `src/views/cast.tsx`, `src/store/cast-slice.ts`, `scripts/repair-cast-id-drift.mjs`
> URL surface: `#/books/<id>/cast` (the orphaned-id advisory banner)
> OpenAPI ops: `GET /api/books/{id}` (`orphanedCharacterFallbacks` field),
> `POST` and `DELETE /api/books/{bookId}/cast/{characterId}/reject-orphan-match`

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
  **is now reversible** (#2092/#2089, design settled 2026-08-05, superseding the
  "no in-app undo" state this section previously described):
  `DELETE .../reject-orphan-match` — same path and body shape as the POST that
  created it — removes EVERY `rejectedPairs` entry that governs `(orphanedId,
  characterId)` (`rejectedPairsGoverning`, `server/src/store/cast-resolve.ts` —
  ordinarily one, but a row can govern more than one differently-punctuated raw
  spelling of the same underlying id that collide onto the same normalised key;
  review round 2/#2092/#2089 found the original raw-exact match missed that case).
  For each governing pair, removes the same-book `notLinkedTo` edge keyed on
  `{bookId, characterId: pair.from}` — the PAIR's OWN raw spelling, which need
  not equal `orphanedId` itself (never on `characterId` alone, so an unrelated
  cross-book edge from `cast-not-linked-to.ts` can't be collaterally deleted) —
  and, when that pair had forgotten a `supersededBy` entry, restores it via the
  `forgotSupersededTo` value stashed on the pair at reject time. The response
  echoes every removed pair's `from` as `removedFrom` (review round 3/#2092/
  #2089), which the client keys its own redux `notLinkedTo` mirror off instead of
  `orphanedId` — mirroring off `orphanedId` was itself a defect this same round
  fixed, since a governing pair's `from` can differ from the row's own id. The
  undo is
  **lossless for resolution purposes**: `buildCastResolver(...).resolve(orphanedId)`
  returns the exact same tier/target after a POST-then-DELETE round trip that it
  returned before the POST, pinned directly against the resolver (not by
  inspecting file contents) in `cast-reject-orphan.test.ts`'s "#2089 acceptance
  bar" cases. No confirmation dialog on either verb (D5) — the reject's
  consequence is invisible until the next render, so a confirm would ask for
  certainty at the point the user has the least information; Undo is presented as
  a sibling control instead. See "Deviations from the spec" below for how the
  reject itself moved from id-scoped to pair-scoped in the same change.

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
   reachable (`probePortRefused`, `scripts/repair-cast-id-drift.mjs:1016`). The
   liveness probe covers not just the configured port but its whole
   `listenWithAutoRebind` auto-rebind range (`probePortRangeRefused`,
   `AUTO_REBIND_RANGE`) — #2090, closed by the same PR as #2093 below.
3. **The resolver never matches on display names.** `buildCastResolver` is
   ids-only — four tiers, first hit wins: a live exact id (`via: 'exact'`), a
   non-rejected history hit (`via: 'history'`, gated against both the legacy
   id-wide `rejected` list and the pair-scoped `rejectedPairs` — #2092/#2089,
   now the only field production writes), a normalised id
   (`via: 'normalised-id'`, gated the same way), a normalised history hit
   (`via: 'normalised-history'`, likewise). Name matching happens only at
   merge/repair time (`server/src/store/remap-fresh-to-prior.ts`, and the
   Tier A/B matcher inside `scripts/repair-cast-id-drift.mjs`) — never inside
   the resolver itself.
4. **A tie never guesses.** If two cast rows (or two history entries) share a
   normalised key, `buildCastResolver.resolve()` returns `undefined` rather than
   picking one — silently rendering one character's lines in another's voice is
   strictly worse than the narrator-substitution fallback it would replace.
5. **`rejected`/`rejectedPairs` are checked after `exact`, ahead of the other
   three tiers** (`cast-resolve.ts:164` for `rejected`; `:172`, `:184`, `:191`
   for `rejectedPairs` against tiers 2/3/4 respectively — NOT the map
   construction above them) — a live cast row always wins over a stale
   rejection, so a reclaimed id (the character's own name minted again by a
   later re-analysis) is never permanently shadowed by a past "not the same
   character" decision. `rejectedPairs` (#2092/#2089) additionally scopes the
   block to the SPECIFIC rejected target rather than every candidate — see
   `rejectedPairs`'s own doc comment on `CastIdHistory`
   (`server/src/store/cast-id-history.ts`) for the full design. This is a
   deliberate deviation from spec §4.6's original wording; see "Deviations
   from the spec" below.
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
8. **`cast-create`'s mint checks `cast-id-history.json` too, not just the live
   roster — and the check is `normaliseIdKey`-equivalence, not raw string
   equality** (srv-86, #2085) — `server/src/routes/cast-create.ts` treats every
   key in `supersededBy`, and every live cast id, as "taken" alongside an exact
   match: a name whose naive mint collides with a retired or live id **after
   normalisation** (e.g. mints `the-torment` where the id on disk is the pre-RC2
   `the_torment`) gets the existing collision-suffix path instead. A raw-only
   check is insufficient — `safeId`'s output (and its own and this route's
   collision suffixes) is always a `normaliseIdKey` fixed point, but a history
   key or a pre-RC2 live id is whatever spelling actually landed on disk, so the
   gap is one-directional and opens exactly where invariant 3's normalised-id
   tier already has real drift to protect (review round 1, Critical; caught
   against the real *Playing with Fire* `the_torment`/`the-torment` shape,
   `docs/testing/cast-id-drift-onbox-acceptance.md:40-44`). This is the mirror
   image of the analyzer's `dropSupersededIdsReclaimedByLiveCast`: that path
   doesn't control the mint (an LLM produced the id, and a fresh roster
   legitimately reclaimed it) so it drops the stale history entry; `cast-create`
   DOES control the mint, so it avoids the collision instead of sacrificing a
   history entry that is still protecting real rendered segments. Reported via a
   `console.log` line, matched by the same normalised comparison, whenever the
   avoidance fires for either reason it can fire — a history match (raw or
   normalised) or a live row that normalises the same with no history involved
   (review round 2, M4; the report used to be gated on the history case only,
   which left the sibling avoidance below silent) — but deliberately NOT for
   an ordinary raw collision between two live ids sharing a name, which is the
   ordinary pre-#2085 `-n`-suffix path and unrelated to this invariant. No
   `displaced` entry is written, because nothing is dropped; the log names the
   colliding id as a **recorded** history entry rather than an active redirect
   (review round 2, M3), since a chained or since-deleted target can leave a
   `supersededBy` entry pointing at an id that is no longer itself live.
   `existingIds` is filtered to `typeof id === 'string'` before any of this
   runs (review round 2, I1) — `cast.json` is read here without
   `characterSchema` validation, and the normalised-comparison machinery this
   invariant introduced calls `normaliseIdKey` on every id in `existingIds`,
   so an unvalidated missing/non-string `id` on disk would otherwise throw a
   `TypeError` into the route's error handler (a 500) instead of degrading
   gracefully, mirroring the guard `cast-resolve.ts`'s `resolve()` entry point
   already applies for the same reason. Also closes a pre-existing
   sibling with no history involved at all: a live `the_torment` with nothing
   retired, re-created as "The Torment", used to collide `byNormId` for both
   spellings the instant `the-torment` landed, killing normalised-id
   resolution for both (review round 1) — the same normalised taken-set
   (built from `existingIds` **and** `historyKeys`) covers it.
9. **An interim `cast.json` write never removes an id from the persisted
   roster** (srv-87, #2086). The three interim ("Cast so far") writes — two
   inside `runMainAnalyzerJob` and one inside `runSubsetAnalyzerJob`
   (`analysis.ts`, all three the `overlayInterimCastForLiveView` calls in
   those two functions — cited by symbol, not line: a line citation here was
   already stale twice over, F2, #2163) — go through
   `overlayInterimCastForLiveView` (`server/src/store/merge-analysis-cast.ts`),
   which has no id-drift name-fallback and produces no `retirements` — there is
   nothing in its return type for a caller to discard. Only the two
   authoritative end-of-run writes (the `mergeAnalysisResultWithExistingCast`
   call in `runMainAnalyzerJob` and the one in
   `runSubsetAnalyzerJob`) apply identity merges and
   call `retireCharacterId`. Before this fix, a mid-run death — **or a
   completed run whose `phase1DriftExceeded` gate skipped the authoritative
   write** (`runMainAnalyzerJob`'s `attributionDriftExceeded` call, checked
   at its two `phase1DriftExceeded` use sites later in the same function;
   `attributionDriftExceeded` is a normal, logged,
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
   orphan-free — 91 ids / 93 segments remain report-only, needing a human
   decision (widened by the #2107 fix, independent review 2026-08-05; was
   93/161 before), and *Unlocked* alone still carries 34 orphaned segments
   under `unknown-male`; see the on-box register's A33 row) or a re-render
   to recover.
10. **A reject's two writes are created together and must be destroyed
    together** (#2133). `POST /reject-orphan-match` writes BOTH a
    `rejectedPairs` entry on `cast-id-history.json` and a one-sided
    `notLinkedTo` edge on `cast.json` — see this same doc's invariant 2 and
    `rejectedPairs`'s own doc comment on `CastIdHistory`
    (`server/src/store/cast-id-history.ts`) for why both are needed. Anything
    that removes one must remove the other, or the survivor becomes a
    decision about a pairing that no longer exists, applied forever,
    invisibly:
    - **`retireCharacterId` dropping a self-loop `rejectedPairs` entry**
      (`RetireCharacterIdResult.droppedSelfLoopRejections`,
      `cast-id-history.ts`) — when the id a pair was rejected `to` retires
      into a replacement that IS that same pair's `from`, the pair becomes
      nonsensical (`X !-> X`) and is dropped. `retireCharacterId` never
      touches `cast.json` itself, so it can only report the drop; BOTH
      production callers (`analysis.ts`'s `recordRetirements` and
      `cast-merge.ts`'s `performCastMerge`) now act on it, clearing the
      matching `notLinkedTo` edge in the same write (or the same lock span,
      for `cast-merge.ts`, which already holds it — rule 1 forbids a second
      nested `withCastLock` for the same book).
    - **`DELETE /reject-orphan-match`'s abandoned-half-write path** — the
      route writes `notLinkedTo` first (unconditional, per its own module
      doc) and `rejectedPairs` second; if the process dies or 500s between
      the two and the user never retries, the `notLinkedTo` edge survives
      with no pair, and the only removal path (`rejectedPairsGoverning`
      returning a matching pair) can never find one. DELETE now also clears
      the edge unconditionally, keyed on `orphanedId` directly, alongside the
      pair-scoped removal (which stays keyed on each governing pair's own
      `from`, for the `the_torment`/`The-Torment` normalised-collision
      shape).
      **Residual, recorded rather than fixed (I3, fix round, #2163):** the
      endpoint change above is real and tested — it clears the edge for any
      caller that reaches it — but nothing in the UI reaches it in this
      exact state. `handleUndoOrphanRejection` (`src/views/cast.tsx`) only
      fires from `OrphanRejectedChips`, which renders only off
      `info.rejectedAgainst`, itself derived from `rejectedPairsGoverning`
      — empty here by construction, since no `rejectedPairs` entry ever
      landed. So the abandoned-half-write state stays invisible and
      unreachable from the UI even after this fix; deciding how (or
      whether) to surface it is a UI design call, deliberately left open
      rather than folded into this endpoint change.
    - **A dead `notLinkedTo` target on the read side** is a separate,
      narrower case (finding B, same #2133 comment): `rejectedPairsGoverning`
      rule 1 has no liveness check on `to`, so a chip can still name a
      character no longer in the live cast (folded away by an unrelated
      merge). The pair is already inert for resolution regardless — the chip
      is cosmetic and its Undo button would 404 forever, so `src/views/
      cast.tsx`'s `OrphanRejectedChips` hides it client-side rather than
      changing `rejectedPairsGoverning`'s deliberately-raw rule-1 semantics
      or loosening the DELETE route to accept a non-live `characterId`.

## Deviations from the spec

The design doc (`docs/superpowers/specs/2026-08-01-cast-character-identity-design.md`)
and plan (`docs/superpowers/plans/2026-08-01-cast-character-identity.md`) are the
design of record; four points shipped differently than either originally wrote them
down, each a deliberate controller ruling made during implementation:

- **The reject action writes a `rejectedPairs` entry, not only a `notLinkedTo`
  edge.** Spec §4.6 said rejecting "removes the history entry." On every real book
  in the 20-book workspace, **zero** `cast-id-history.json` files exist — every
  currently orphaned segment resolves through the *normalised* tiers, where there
  is no history entry to remove. A reject that only deleted history entries would
  have been a button that does nothing on 100% of currently-affected books. The
  shipped design (`server/src/routes/cast-reject-orphan.ts`) writes **three**
  things: a pair-scoped entry in `cast-id-history.json`'s `rejectedPairs`,
  honoured by `buildCastResolver` (this is what actually stops read-side
  resolution — of `orphanedId` onto THIS `characterId` specifically, see below);
  the one-sided `notLinkedTo` edge on the live character naming the orphaned id
  (this is what stops the next re-analysis's name matcher from re-recording it —
  spec §4.6's original durability requirement, which stays correct as written);
  and, non-fatally (`cast-reject-orphan.ts`), a `forgetSupersededId` call that
  clears a stale `supersededBy` entry for the same id **when it targets this same
  `characterId`** — left in so a rejected id doesn't linger in two places at once,
  scoped rather than unconditional so it can't collaterally destroy a *different*,
  still-valid alias for the same orphaned id.

  **Revised again, #2092/#2089 (design settled 2026-08-05):** the write above
  originally targeted a single id-wide `rejected: string[]` list — `orphanedId`
  blocked against *every* candidate, forever. The repo owner approved a
  pair-scoped design instead: `rejectedPairs: Array<{from, to, forgotSupersededTo?}>`
  blocks `orphanedId` onto `characterId` SPECIFICALLY, so a later, *different*
  reconciliation for the same orphaned id (the common "mayrin is not Mr. Marrow,
  but mayrin IS Mairin" shape once a later analysis mints the right alias) stays
  resolvable — `scripts/repair-cast-id-drift.mjs` pushes a rejected id to
  `skipped` before any candidate is computed, so an id-wide block cost real,
  permanent damage on the auto-reconciled path, not just an edge case. The legacy
  `rejected` field is kept, read-only, for back-compat with a file written before
  this change; no code path writes it anymore. This also made the reject
  REVERSIBLE — see "Reversibility" above and `DELETE .../reject-orphan-match`
  (`cast-reject-orphan.ts`) — because `forgetSupersededId` now returns what it
  removed (D6) instead of discarding it, so the undo can restore the exact alias
  the reject had shadowed.
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
  building, Tier A/B candidate resolution (both normalised against a reserved
  fold-bucket id on the source AND the target side — #2093 residual 4),
  `snapshotsConsistent`, the reserved-source guard, the cross-source ambiguity
  veto, the zero-segment guard, `rankSnapshotCandidates`'s scoring, the
  re-render list shape, `buildOrphansFromSegments` (#2093 residual 6; #2107,
  widened by independent review + owner decision 2026-08-05, to list every
  tier except `'exact'` as an orphan — the `autoReconciled` bucket this used
  to describe, including its `'normalised-id'`/`'normalised-history'`
  split, no longer exists), `isCacheAvailable`/`readAnalysisCache` against real fixtures covering
  every refusal state — missing, unparseable, validly-parsing-but-names-zero-
  characters (independent-review Critical C1), and (pre-merge review I1) a
  validly-parsing entry whose id or name is an EMPTY STRING — `isCacheAvailable`
  now builds the real `cacheNameIndex` via `buildNameIndex` (the same call
  guard 2 consumes) instead of a looser `cacheEntriesOf`-only check, closing
  the gap one field deeper than C1 (#2093 residual 1), `planBookRepairs`'s
  `withheldForMissingCache` count — proven both to increment when a real Tier
  A/B candidate is withheld for missing cache evidence AND to stay `0` for a
  matched-but-zero-segment id (pre-merge review I2 moved the cache-
  availability gate to fire after the zero-segment/snapshot-consistency
  guards, so a candidate those guards would have refused anyway can't inflate
  the count that gates the whole-workspace `--apply` refusal) and for a
  reserved-source id (guard 1 refuses before the cache gate is ever reached —
  the actual *Unlocked* shape), `shouldRefuseApplyForWithheldAutoRecord`'s
  decision logic (#2093 residual 2, renamed and re-scoped by owner-decided
  policy in review round 2 — this covers the pure `apply &&
  booksWithheldForMissingCache > 0` decision only; its wiring into `main()`'s
  actual exit path is untestable without `server/dist` and is verified only
  by the live dry run, not by this suite), and `probePortRangeRefused`'s
  fail-closed behaviour across the whole `listenWithAutoRebind` auto-rebind
  range, not only the configured port (#2090) — verified live against real
  TCP listeners, including both boundaries of the range directly (pre-merge
  review I3: mutation-testing found the original three tests could not
  distinguish `startPort + i` from `startPort + i + 1`, nor `AUTO_REBIND_RANGE`
  20 from 19) and a configured port near the top of the valid TCP range
  (minor: `probePortRangeRefused` now clamps at 65535 rather than letting
  `net.connect` throw synchronously on an out-of-range port).
- `e2e/orphaned-character-fallback-banner.spec.ts` — both banner sections render
  from a real hydrate-shaped payload; the reject flow round-trips through the
  redux store in a real browser; the reject button stays disabled until a
  candidate is picked.
- `server/src/routes/cast-create.test.ts` (srv-86, #2085) — the merge-then-
  recreate repro driven through the real merge and create routes: a re-created
  character never re-mints an id `cast-id-history.json` still protects, the
  avoidance is logged, the history entry survives untouched; a raw spelling
  drift (the real `the_torment`/`the-torment` shape, review round 1) is caught
  by the normalised comparison whether the drifted id is in history or only in
  the live roster (and the live-only case is logged too — review round 2,
  M4); an ordinary raw collision between two live same-named characters stays
  silent (review round 2, M4 scope — the widened report doesn't fire for the
  pre-#2085 case); a `cast.json` row with a missing/non-string `id` creates
  successfully rather than 500ing (review round 2, I1); and the route neither
  crashes nor silently disables the check when `cast-id-history.json` is
  genuinely absent (confirmed via `existsSync`, not merely "the previous test
  happened not to write one") or malformed (the latter also logs).
- `server/src/store/cast-id-history.test.ts`'s "operator-visible warnings"
  block (review round 2, M1/M2) — `loadCastIdHistory` actually calls
  `console.warn` (not just returns the degraded value) for both the
  wrong-shape branch and the unreadable/parse-throw branch, each naming the
  file path, and stays silent for the common absent-file case.

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
  Wave 2, **now fixed** (invariant 8 above) — kept here only as the historical
  filing note. **Auto-repairing the interim `cast.json` write path** — filed as
  [#2086](https://github.com/dudarenok-maker/Castwright/issues/2086) during
  Wave 2, **now also fixed** (invariant 9 above) — likewise kept as a filing note.
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

Three rows tracked (A33 partially discharged 2026-08-05 — see below) — see
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
  **PARTIALLY DISCHARGED 2026-08-05** — `--apply` was run for real (against
  `main` @ `f3d6ae0f`) and wrote exactly the 3 predicted aliases across 2
  books (*Заказ Коалфолла*, *Everblaze*), all 20 `cast.json` files
  byte-unchanged; the liveness rail caught a real `npm run dev` via its LAN
  HTTPS half before that. **Still owed:** confirming the fix reaches actual
  audio (re-render *Заказ Коалфолла* ch2 and listen) and the Cast-screen
  banner cross-check — see the register row A33 and the run sheet's §8.6+
  for the full account, including two defects the run surfaced
  ([#2107](https://github.com/dudarenok-maker/Castwright/issues/2107), the
  re-render list drops an aliased row's segments after `--apply` — **fixed,
  then WIDENED by an independent review + owner decision** to list every
  resolver tier except `'exact'` as an orphan, on its own branch, not in the
  #2102 PR;
  [#2108](https://github.com/dudarenok-maker/Castwright/issues/2108), a
  wrong `WORKSPACE_DIR` scanned 0 books and still reported a clean summary
  — fixed here in the #2102 PR that also closes the residuals below).
  The dry run (re-measured 2026-08-05, `CACHE_DIR` correctly pointed at the
  checkout that ran this workspace's analysis) reports: **3 auto-recordable
  aliases covering 27 segments**, **93 ids reported for a human decision
  covering 161 segments** (corrected from a prior 93 — see below), **17
  re-render rows covering 120 segments** — this whole bullet is the
  PRE-`--apply`, pre-#2107-fix baseline, left as originally measured.
  **Superseded, post-widened-fix (fresh dry run, 2026-08-05, read-only,
  never `--apply`):** auto-recordable aliases **0 → 2 / 68 segments**
  (`the-torment`/`lightning-dave`, previously invisible under the removed
  `autoReconciled` bucket); report-only **93/161 → 91 ids / 93 segments**;
  re-render candidates **13 rows / 93 segments (the #2107-regressed figure)
  → 23 rows / 188 segments** — 188 matches the original full-workspace
  orphan count, the arithmetic check that this is now the complete set.
  Continuing with the original baseline: **0 books
  modified**, **1 book missing analysis-cache evidence, 0 books with an
  auto-record withheld because of it**. These are two DIFFERENT numbers (independent-review
  Critical C1, widened by a later pre-merge review pass (I1), found the
  cache-availability gate could read a cache as usable when it wasn't; the
  repo owner then decided that a book's raw missing-cache status should stop
  gating `--apply` on its own). *Unlocked*'s cache file — the one book this
  surfaces — parses but names zero characters; **it is NOT an orphan-free
  book** — it carries `unknown-male`, 34 rendered segments across ch63/ch67
  (confirmed both by a live scan and by the real `--apply` run above). The
  reason it doesn't block `--apply`: `unknown-male` is a reserved
  fold-bucket SOURCE id, and guard 1 refuses to auto-record from a reserved
  source unconditionally, firing before the cache-availability gate is ever
  reached — so *Unlocked*'s blind ambiguity veto never actually stood
  between the pass and a real candidate. `--apply` refuses only when a
  book's blind ambiguity veto actually withheld a real auto-record
  candidate (`booksWithheldForMissingCache`, currently `0`; a pre-merge
  review pass (I2) also moved this check to fire after the zero-segment and
  snapshot-consistency guards, so a matched-but-unrendered id can't inflate
  it either) — the broader `booksMissingCache` count stays reported for
  operator visibility but no longer gates. See the run sheet's Wave 3
  section for the exact walkthrough.

## Ship notes

Not yet `stable`. Fill in when Wave 3 ships (PR merges) and the three on-box rows
above are discharged or explicitly deferred with the repo owner's sign-off.
