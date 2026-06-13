---
status: stable
shipped: 2026-05-27
owner: null
---

# 122 — Rebaseline collapses recurring cast by name/alias (durable de-duplication)

> Status: stable
> Key files: `src/lib/cross-book-duplicates.ts` (`sameCharacterByNameAlias`), `src/lib/merge-series-cast.ts`, `src/modals/rebaseline-modal.tsx` (`runApprove`), `server/src/routes/voice-override-linked.ts`, `server/src/routes/cast-link-prior.ts`, `server/src/analyzer/fold-minor-cast.ts`
> URL surface: `#/books/<id>/library` + `#/voices` (the "Rebaseline the series" modal)
> OpenAPI ops: `POST /api/books/{bookId}/cast/{characterId}/voice-override-linked` (new)

## Benefit / Rationale

- **User:** a recurring character that the analyzer detected under divergent ids across books (`wren` vs `wren-sparrow`, `Castor` vs `bron-te`) now shows as ONE row in the Rebaseline modal, and approving its voice reaches every book — no more "two Sophies", no more silent skips. Stops the duplicate from re-appearing on every new book.
- **Technical:** the modal's display de-dup and the approve-time write now agree on the same conservative name/alias rule (the one the analyzer's series-prior dedup already uses), so collapse can't desync from propagation.
- **Architectural:** locks the invariant *"a fold-bucket id never carries a real character's name"* and makes cross-book linking actually unify the propagation key (`voiceId ?? id`), closing the two data-drifts at their source.

## What changed

Root cause (see `~/.claude/plans/why-do-i-have-piped-kahn.md` for the diagnosis): the modal — and the series-override write (`applyOverrideToCastFiles`, `server/src/routes/voices.ts`) — key on `voiceId ?? id`. A character detected under a divergent id that never received a shared `voiceId` splits into its own row. In-book merge and `cast-link-prior` only wrote **aliases**, never the `voiceId`, so they never unified the key. Separately, a real character could end up wearing an `unknown-male`/`unknown-female` id (drift from old merges / voice-match), making it look like a named bucket.

Four parts:

1. **Shared matcher** — `sameCharacterByNameAlias(a, b)` in `src/lib/cross-book-duplicates.ts`: normalised name/alias token match (reusing `normaliseDuplicateToken` + `looksLikeSameName`), **false** when either side marks the other `notLinkedTo`, and never matches a bucket id.
2. **Display collapse** — `mergeSeriesCast` unions series-mates by `voiceId ?? id` (pass 1) AND by `sameCharacterByNameAlias` (pass 2). Anchor identity wins, line counts sum, the group's designed Qwen voice carries onto the representative.
3. **Keystone write** — new `POST /api/books/:bookId/cast/:characterId/voice-override-linked` rediscovers the same name/alias group across the series (reusing `cast-series-patch`'s `tokensFor`/`intersects`), **unifies `voiceId`** to one canonical key, and writes the override to every member — so a single approve reaches books on a divergent key. `runApprove` calls it instead of the plain series override. The old voiceId-keyed propagation is preserved (superset).
4. **Prevention** — `cast-link-prior` now also stamps `source.voiceId = target.voiceId ?? target.id` (a manual link truly unifies the key); `fold-minor-cast` canonicalises any bucket-id row back to the generic `Unknown male/female` name on output (the drifted name is NOT kept as an alias, so the matcher won't re-bind that character to the bucket).

## Architectural impact

- **Invariants preserved:** the display de-dup key and the write/propagation key stay in lockstep — collapsing a row can no longer silently skip a book on approve. Auto-collapse is gated by `notLinkedTo` (plan 101), the existing "intentionally different" escape hatch (e.g. teenage vs adult Wren). Matching stays conservative (exact / strict-substring / punctuation-normalised) — typo-only id variants with no shared token (`aldan` vs `maelor`) do NOT auto-collapse, by design.
- **Migration:** no schema change. Existing confirmed books were repaired by the one-off data fix in the plan above; this change is forward-looking + heals the modal display/propagation.
- **Stale audio:** propagating a new Qwen voice to a book whose audio is already rendered makes that book's chapters stale — but that is the explicit intent of a series rebaseline (drift flags the affected chapters), so no extra gating.

## Test plan

- **Unit:** `src/lib/cross-book-duplicates.test.ts` (matcher: substring, alias bridge, normalised-equality, notLinkedTo, bucket guard), `src/lib/merge-series-cast.test.ts` (name/alias collapse, line-sum, notLinkedTo blocks, Qwen carry, never collapses a bucket).
- **Component:** `src/modals/rebaseline-modal.test.tsx` — a divergent-id same-name sibling renders ONE row; a `notLinkedTo` sibling stays a SECOND row; approve calls `setVoiceOverrideLinked(homeBookId, characterId, {engine,name})`.
- **Server:** `server/src/routes/voice-override-linked.test.ts` (unify voiceId + propagate across name/alias group, respect notLinkedTo, preserve voiceId-key propagation, series boundary, standalone, null-clear, 400/404); `server/src/routes/cast-link-prior.test.ts` (voiceId unified, id fallback); `server/src/analyzer/fold-minor-cast.test.ts` (drifted bucket canonicalised, no named ≥minLines char on a bucket id).
- **E2E:** existing `e2e/rebaseline.spec.ts` drives open → propose → approve → toast through the new linked-override path (mock workspace is single-book, so multi-book collapse is covered at the component level).

## Ship notes

Shipped 2026-05-27 via PR #295 (merge commit `ac6f4f8`). Preceded by a one-off data fix that repaired the live the Hollow Tide workspace (split-id voiceId alignment + breaking named characters out of fold-bucket ids); this plan makes the de-duplication durable so it stops recurring on new books. `npm run verify` green locally and in CI (verify 15m + title lint). Follows plan [108](../108-qwen-coexistence.md) (the rebaseline modal itself).
