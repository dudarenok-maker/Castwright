---
status: stable
shipped: null
owner: null
---

# Cross-book character link — collapse duplicates + carry profile over

> Status: active
> Key files: `server/src/routes/cast-link-prior.ts`, `src/store/cast-slice.ts`,
> `src/lib/prior-link-candidates.ts`, `src/components/layout.tsx`,
> `scripts/repair-linked-character-attributes.mjs`
> URL surface: Profile Drawer "link to a prior series book" picker (`#/books/<id>/cast`)
> OpenAPI ops: `POST /api/books/{bookId}/cast/link-prior` (response shape widened)

## Benefit / Rationale

Reported as "I link Dame Linnet and Concilor Linnet and it doesn't work — it still
shows in the link options, and linking doesn't bring any representative quotes."
Diagnosis (the Hollow Tide / The Floodmark): the link **was** persisting, but two real gaps made
it feel broken.

- **User:** Linking a recurring character to a prior book now (a) removes ALL of
  that person's prior-book copies from the picker — not just the single volume you
  picked — so the list actually clears, and (b) carries the canonical character's
  representative quotes + attributes/description/tone onto the linked row, so a
  roster-carried row with zero of its own lines (e.g. The Floodmark's "Dame Linnet",
  0 quotes) is no longer blank after linking.
- **Technical:** The picker's suppression now keys on the canonical `voiceId`
  (the series-wide propagation key) instead of only the exact `matchedFrom`
  target, which is single-valued and can't cover a person who appears in N books.
- **Architectural:** `cast/link-prior` already unified voice + aliases; it now
  also unifies the **profile content** at the same seam, matching what the user
  expects "these are the same person" to mean. Mirrors the in-book merge
  (`cast-merge.ts`) field rules.

## Architectural impact

- **`cast/link-prior` response widened** — adds optional `profile` (`evidence`,
  `attributes`, `description`, `tone`, `gender`, `ageRange`), present only when
  the merge changed something. Additive; older clients ignore it.
- **Profile merge rules** (mirror `cast-merge.ts`): union list fields
  (`evidence` deduped on normalised quote, `attributes` lower-case deduped),
  **source-first** so the current book's own quotes lead; fill-if-missing the
  scalar fields so a richer local profile is never clobbered. Evidence is pure
  `{quote, note}` text with no book-local references, so cross-book union is
  pollution-free.
- **Picker collapse** — `filterLinkablePriorCandidates` (new pure lib) suppresses
  a candidate when an exact `matchedFrom` hit OR a shared non-empty `voiceId`
  with any local character.
- **Reducer** — `applyManualMatch` applies the echoed `profile`; the existing
  persist-middleware rule for `applyManualMatch` round-trips it to `cast.json`.
- **Migration / backfill** — existing reused rows predate the carry-over.
  `scripts/repair-linked-character-attributes.mjs` groups every cast member into
  cross-book **identity clusters** via union-find over two edge kinds:
  series-scoped shared `voiceId`, and `matchedFrom` links — so it catches
  voiceId-only links and origin rows, not just `matchedFrom`. For clusters
  spanning ≥2 books it **tops up the THIN copies** (count `< LOW_QUOTES`/
  `LOW_ATTRS`, default 5) to the cluster union — rich rows are never inflated,
  the narrator is skipped. Scalars fill-if-missing. Dry-run by default;
  `--apply` writes a `.bak` first.
- **Reversibility** — server/reducer changes are forward-only but additive (no
  data shape removed). The script writes `<cast.json>.bak` per touched book.

## Invariants to preserve

- `applyManualMatch` still preserves a `locked`/`tuned` voice — only `matchedFrom`
  (+ profile) is updated in that case (`src/store/cast-slice.ts`).
- Profile merge never drops the source's own data: list fields are source-first
  unions, scalars are fill-if-missing (`cast-link-prior.ts`).
- `cast/link-prior` series-scope guard unchanged (same author+series, no
  standalones).

## Test plan

### Automated coverage

- Vitest server (`server/src/routes/cast-link-prior.test.ts`) — merges target
  profile onto an empty source (+ response `profile` echo); unions quotes/attrs
  source-first and never clobbers the source's own description.
- Vitest unit (`src/lib/prior-link-candidates.test.ts`) — collapses all of a
  person's prior-book copies once a local row shares their `voiceId`; still
  suppresses the exact `matchedFrom` target when `voiceId` is absent; leaves
  unrelated/unlinked candidates alone.
- Vitest unit (`src/store/cast-slice.test.ts`) — `applyManualMatch` applies the
  echoed `profile`, and leaves the profile untouched when none is carried.

### Manual acceptance walkthrough (real backend)

1. Open The Floodmark → Cast → "Dame Linnet" profile drawer. Before this change the
   link picker lists several "Dame Linnet" + a "Councillor Linnet"; after, those
   collapse out once the row is linked (shares `voiceId: dame-linnet`).
2. Link an unlinked recurring character to its prior-book canonical → the drawer
   immediately shows the inherited representative quotes + attributes; reload →
   they persist (cast.json round-trip).
3. Run `BASE=C:/AudiobookWorkspace node scripts/repair-linked-character-attributes.mjs`
   (dry run) → confirms thin multi-book rows top up (The Floodmark/Dame Linnet 0→29
   quotes, 0→23 attributes; rich rows + narrator untouched); `--apply` writes.

## Out of scope

- In-book merge (`cast/merge`) is unchanged — it already merges everything and
  removes the source row.
- No change to the auto-matcher (`voice-match`) or the not-linked-to decision.

## Ship notes

Shipped 2026-06-06 (merge 9cd7f57, PR #574). Live acceptance confirmed:
The Floodmark → Cast → "Dame Linnet" shows inherited representative quotes/attributes
that persist across reload; `scripts/repair-linked-character-attributes.mjs --apply`
run to top up thin multi-book rows.
