---
status: active
shipped: 2026-05-30
owner: null
---

# Analysis-time cross-book reuse linking (durable continuity)

> Status: **Facet A shipped 2026-05-30** (auto-link at analysis + the `srv-14`
> denormalisation it builds on); **Facet B (reparse preservation) remains**
> (backlog `srv-13`). See Ship notes.
> Key files (target): `server/src/routes/analysis.ts`, `server/src/routes/book-state.ts` (reparse), `server/src/workspace/series-cast-scan.ts`, `server/src/routes/voice-match.ts`, `server/src/routes/cast-link-prior.ts`, `src/store/cast-slice.ts`
> URL surface: indirect — `#/books/<id>/cast` (the Reused badge + merge picker) after analysis / reparse
> OpenAPI ops: none (no new wire fields — `matchedFrom` / `voiceId` / `voiceState` already exist)

## Context / why this exists

A "reused" character carries `matchedFrom` (which prior book/character it continues),
a unified `voiceId`, and `voiceState:'reused'` — that's what drives the Reused
badge, the shared designed voice, and the merge-picker "already linked"
suppression. Two gaps make those links fragile, surfaced 2026-05-28 while
fixing a 7-book series whose principal cast mostly had **no** `matchedFrom`:

1. **Auto-reuse never runs at analysis.** Voice-match is **client-side and
   confirm-stage-only** — a `useEffect` in `src/components/layout.tsx` (~655-677)
   calls `api.matchVoices` → `castActions.applyVoiceMatches`
   (`src/store/cast-slice.ts:286-305`) once per (confirm stage, bookId). A
   character that never passes through a fresh confirm page (already-confirmed
   books; links wiped by a reparse) never gets `matchedFrom`.
2. **Reparse drops continuity.** The reparse handler **deletes `cast.json`**
   (`server/src/routes/book-state.ts:722-723`) so the cast view re-matches
   against the fresh chapter list — but nothing carries the prior `matchedFrom`
   / `voiceId` / `voiceState` / `aliases` forward. Plan 27 keeps the
   `voice_reuse` *change-log event*, but the `cast.json` that made it real is
   gone.

This session shipped the persistence fix for **new** links (PR #301) and
back-filled **existing** data with one-time scripts (`scripts/repair-series-reuse.mjs`,
`scripts/repair-sample-cache-scope.mjs`, PR #302) — but a reparse of any book
would silently evaporate that back-fill. This plan is the durable fix.

## Benefit / rationale

- **User:** continuity (Reused badge, shared designed voice, no duplicate in
  the merge picker) is established automatically when a later series book is
  analysed, and **survives a re-analysis** — no manual per-character linking,
  no re-running the repair script after every reparse.
- **Technical:** moves the reuse-link decision server-side (authoritative,
  not dependent on the frontend reaching a confirm page), reusing the existing
  matchers instead of the client-only path.
- **Architectural:** makes `matchedFrom` a durable cast field across the
  analyse → reparse lifecycle, same as user-tuned/locked voices already are.

## Approach (two facets)

### Facet A — establish links server-side at analysis

After Phase 0b finalises `stage1.characters` (`server/src/routes/analysis.ts`
~2157-2335, around `buildInterimCast` + `dropEvidencelessCast`), match each new
character against prior **same-series** books and stamp `matchedFrom` + unify
`voiceId` (+ `voiceState:'reused'` unless tuned/locked) + union aliases.
**Reuse existing primitives — do not reinvent matching:**

- `server/src/workspace/series-cast-scan.ts:scanSeriesCharactersForBookId(bookId)`
  — prior-book confirmed cast (already used for the Phase-0a chapter prompt).
- `server/src/routes/voice-match.ts` matchers — `exactNameOverlap()` (~106),
  `tokenOverlap()` (~119), via `server/src/util/text-match.ts` (`nameTokens`,
  `jaccard`); keep the same `nameScore < 0.34` floor + the gender/age factors
  from `scoreOne()` so the server agrees with what the client matcher would have
  picked.
- `server/src/routes/cast-link-prior.ts:appendAliases()` (~173) for the alias
  union; the `matchedFrom` / `voiceId` response shape (~137-163).
- Respect `notLinkedTo`; skip `unknown-male` / `unknown-female`; only run for
  **non-earliest** series books (the origin book has nothing prior). This
  mirrors `scripts/repair-series-reuse.mjs`, the validated end-state shape.

### Facet B — preserve continuity across reparse

In the reparse handler (`server/src/routes/book-state.ts:603-752`), instead of
unconditionally deleting `cast.json` (722-723), read it first and carry forward
per-character `matchedFrom` / `voiceId` / `voiceState:'reused'` / `aliases` for
characters that survive by id or name/alias, merging into the fresh analysis
output. The `src/store/cast-slice.ts:mergeCharacters` (71-104) preservation
pattern (already preserves tuned/locked voices) is the reference.

## Invariants to preserve

- OpenAPI unchanged — `matchedFrom` / `voiceId` / `voiceState` already exist.
- Never auto-link a `notLinkedTo` pair (intentional same-name-different-person,
  e.g. teenage vs adult Wren).
- Name matching can false-positive on coincidental same names — the 0.34 floor
  + gender/age factors mitigate; keep the score on `matchedFrom.confidence` so a
  low-confidence auto-link stays visible/overridable.
- Facet A runs only for non-earliest series books (same guard as the repair
  script).
- Client `applyVoiceMatches` stays as a fallback / ad-hoc re-match path — Facet
  A is additive, not a replacement.

## Test plan

### Automated coverage (when built)

- Server unit (`server/src/routes/analysis.test.ts` or a new `*.test.ts`) — a
  later-book analysis with a prior-book same-name character yields `matchedFrom`
  + unified `voiceId` on the new cast; a `notLinkedTo` pair is skipped; the
  earliest (origin) book gets no links.
- Server unit (`server/src/routes/book-state.test.ts`) — reparse preserves
  `matchedFrom` / `voiceId` / `voiceState:'reused'` / `aliases` for surviving
  characters; user-tuned/locked voices still survive.
- Frontend — existing `cast-slice.test.ts` `applyVoiceMatches` coverage stays
  green (the client path remains).

### Manual acceptance walkthrough

1. Analyse a later book in a series whose earlier books are confirmed → its
   recurring characters show "Reused" with `matchedFrom` pointing at the prior
   book, without opening the merge picker.
2. Reparse that book → the Reused badges + designed-voice continuity survive
   (don't revert to "Designed"/unlinked).

## Out of scope

- **Cross-SERIES** voice linking — that's backlog `srv-7`.
- Voice-embedding matching — the current matcher is name/attribute-based; this
  plan keeps that.
- The one-time repair scripts (`scripts/repair-series-reuse.mjs`,
  `repair-sample-cache-scope.mjs`) remain for already-confirmed historical data
  / cache; this plan makes them unnecessary for *future* analyses.

## Ship notes

**Facet A shipped 2026-05-30** on `feat/server-analysis-reuse-linking` (this
backlog-cleanup round, integration branch `integration/2026-05-30`):

- `cb65724` — `fix(server): denormalise reused qwen voice on auto-match write path` (`srv-14`). The cast PUT funnel (`server/src/routes/book-state.ts`) now denormalises `ttsEngine` + `overrideTtsVoices.qwen` onto any newly-reused character via the shared `resolveReusedVoiceFields`, so on-disk cast.json is self-complete without read-time hydration.
- `33cc87a` — `feat(server): auto-link cross-book reuse at analysis (plan 126 Facet A)`. New `server/src/workspace/series-reuse-link.ts:linkSeriesReuseAtAnalysis()` runs at the Phase-0b finalise site in `analysis.ts` (right after `dropEvidencelessCast`, before the cast.json persist), matching each character against prior **strictly-earlier** same-series books with the exported `voice-match.ts:scoreOne` (`nameScore < 0.34` floor + gender/age/attribute factors), stamping `matchedFrom`/unified `voiceId`/`voiceState:'reused'`, unioning aliases, and denormalising the bespoke voice. Guards: skips `unknown-male`/`unknown-female`, never auto-links a `notLinkedTo` pair, never overwrites an existing `matchedFrom`, never demotes a tuned/locked voice; the earliest series book + standalones get zero links. Wrapped in try/catch so a link error can't abort analysis. The client-side `applyVoiceMatches` path stays as an additive fallback.

**Still deferred — Facet B** (reparse preservation): the reparse handler still
deletes `cast.json` (`book-state.ts:722-723`), so a reparse drops the links
Facet A established. Carry `matchedFrom`/`voiceId`/`voiceState`/`aliases`
forward across reparse, mirroring `cast-slice.ts:mergeCharacters`. Tracked as
`srv-13` in the backlog.

**Also remaining** (surfaced this round): a SECOND Phase-0b finalise site — the
failed-chapter retry/resume `runChapterCastSubset` path in `analysis.ts`
(~L3508, writing cast.json ~L3712) — does NOT run the Facet-A link pass, so a
book completed exclusively via the chapter-retry path persists an unlinked
cast.json until the next full `/analysis/stream`. Fold into Facet B or a tiny
standalone fix.
