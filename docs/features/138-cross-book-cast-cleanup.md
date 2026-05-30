---
status: active
shipped: null
owner: null
---

# Cross-book cast cleanup (fe-8, fe-9, fs-11, fe-16)

> Status: stable
> Key files: `src/modals/profile-drawer.tsx`, `src/modals/bulk-duplicate-review.tsx`, `src/views/voices.tsx`, `src/components/layout.tsx`, `src/lib/cross-book-duplicates.ts`, `src/lib/voice-status.ts`, `server/src/routes/cast-not-linked-to.ts`, `server/src/audio/segments-io.ts`, `server/src/routes/book-state.ts`
> URL surface: `#/voices`, the per-book Voices tab, and the profile drawer (reachable from cast / confirm / voices)
> OpenAPI ops: `DELETE /api/books/{bookId}/cast/{characterId}/not-linked-to` (mirrors the plan-101 POST, which was also never added to `openapi.yaml` — both routes ship contract-by-test, see "Out of scope")

Four backlog items that build on the SHIPPED plan-101 cross-book duplicate review (`docs/features/archive/101-cross-book-duplicate-review.md`) and plan-130 Qwen-default fallback (`docs/features/130-qwen-default-engine.md`).

## Benefit / Rationale

- **User (fe-8):** the "Possible duplicate of …" chip surfaces a cross-book duplicate from inside the profile drawer — the user no longer has to go hunting on the Voices view to discover that the character they're editing is a likely series-mate of another book's character.
- **User (fe-9):** "Review all duplicates in <Series>" walks the whole series' duplicate queue one pair at a time instead of clicking each family-card ⚠ pill individually.
- **User (fs-11):** "different on purpose" is now reversible — an "Ignored duplicate suggestions" section lists previously variant-marked pairs with an Unmark button, so a mis-click no longer permanently buries a real duplicate.
- **User (fe-16):** the cast Status pill reads "Fallback (Kokoro)" for any character that actually rendered on the placeholder Kokoro voice (Qwen fallback), closing the loop on plan-130's per-character fallback — the user can see exactly which characters still need a designed voice for bespoke quality.
- **Technical:** all four reuse the existing plan-101 predicate (`detectDuplicateCandidates`) + modal (`DuplicateReviewModal`) + the already-present `resolveVoiceStatus` 4th-arg seam — no new detection logic, no new wire shapes beyond one optional book-state field + one DELETE op.
- **Architectural:** the render-time fallback fact (`renderedFallbackEngine`, stamped by generation since plan 130) now has a read path all the way to the cast view; the duplicate-resolution reconciliation (redux ↔ foreign-cast cache) gains its symmetric "undo" counterpart.

## Architectural impact

- **New seam — `detectIgnoredDuplicatePairs(ctx)`** (`src/lib/cross-book-duplicates.ts`): the inverse of the candidate detector's `notLinkedTo` suppression. Same family/series guards; emits a pair only when the `notLinkedTo` relation holds. Feeds the Ignored section.
- **New seam — `removeNotLinkedToCachedCharacter`** (`src/lib/cross-book-duplicates.ts`) + **`castActions.removeNotLinked`** (`src/store/cast-slice.ts`): the symmetric undo counterparts to the plan-101 `append*` helpers / `applyNotLinked`. Same "return same Map reference on no-op" contract.
- **New seam — `collectRenderedFallbackEngines(bookDir, chapters)`** (`server/src/audio/segments-io.ts`): aggregates the per-character `renderedFallbackEngine` across a book's rendered segments files. "Any chapter fell back wins."
- **Wire shape (additive, optional):** book-state GET now returns `renderedFallbackByCharacter: Record<string, string>`. Hand-written in `BookStateResponse` (`src/lib/types.ts`) — NOT an OpenAPI-generated shape (the composite book-state response never was), so no `openapi:types` regen needed. The cast slice holds it (`renderedFallbackByCharacter?`, optional so pre-existing preloaded test stores keep typechecking) and the cast view + drawer thread it into `resolveVoiceStatus`' existing 4th arg.
- **New server op — `DELETE /cast/:characterId/not-linked-to`** (`server/src/routes/cast-not-linked-to.ts`): same router, same body shape + guards as the POST; removes the symmetric pair from both books' cast.json, idempotent.
- **Invariants preserved:** OpenAPI is the type source of truth for generated shapes — untouched (the new field lives on the hand-written composite response; the DELETE op follows the same contract-by-test pattern the plan-101 POST already used). RTK Immer reducers. No hex literals (CSS-var Tailwind tokens). ≥44px touch targets on the new chip / buttons.
- **Reversibility:** fs-11 IS the reverse path for a "different on purpose" decision. The fe-16 field is read-only/derived — deleting the segments aggregation reverts the pill to its design lifecycle. fe-8/fe-9 are pure UI entry points over the existing modal.

## Invariants to preserve

- `resolveVoiceStatus(c, voice, effectiveEngine, renderedFallbackEngine?)` (`src/lib/voice-status.ts:91`) — the 4th arg renders `{ label: 'Fallback (Kokoro)', color: 'warning' }` and OUTRANKS the design lifecycle when `=== 'kokoro'`.
- `detectDuplicateCandidates` notLinkedTo suppression (`src/lib/cross-book-duplicates.ts` ~L194-195) and `detectIgnoredDuplicatePairs` (the inverse) must stay complementary — a pair is in exactly one of the two outputs.
- `DELETE /cast/:characterId/not-linked-to` rejects self-pair + same-book, requires series-mate scope — byte-identical guards to the POST (`server/src/routes/cast-not-linked-to.ts`).
- `collectRenderedFallbackEngines` returns `{}` (never throws) on a missing audio dir — book-state GET wraps it in `.catch(() => ({}))` as belt-and-braces.

## Test plan

### Automated coverage

- Vitest unit (`src/modals/profile-drawer.test.tsx`) — chip renders + fires `onReviewDuplicate`; disappears when `duplicateOther` is null (resolved).
- Vitest unit (`src/views/voices.test.tsx`) — bulk review opens, links the single queued pair, closes after the last; Skip control closes; Ignored toggle lists a variant-marked pair, Unmark DELETEs + re-surfaces the candidate.
- Vitest unit (`src/lib/cross-book-duplicates.test.ts`) — `removeNotLinkedToCachedCharacter` immutability/no-op; `detectIgnoredDuplicatePairs` flags only notLinkedTo pairs (cast + Voice-fallback paths).
- Vitest unit (`src/store/cast-slice.test.ts`) — `setRenderedFallback` overwrite/clear; `applyNotLinked`/`removeNotLinked` symmetric add/remove + no-op.
- Vitest unit (`src/views/cast.test.tsx`) — "Fallback (Kokoro)" pill renders from the slice map; clears when the map omits the id.
- Vitest server (`server/src/audio/segments-io.test.ts`) — `collectRenderedFallbackEngines` "any chapter wins", empty cases, no interference with the Qwen-name aggregator.
- Vitest server (`server/src/routes/cast-not-linked-to.test.ts`) — DELETE removes the symmetric pair from both books, idempotent on absent pair, asymmetric on-disk start settles, 400/404 guards.
- Vitest server (`server/src/routes/book-state.test.ts`) — book-state GET surfaces `renderedFallbackByCharacter` (`{}` with no segments; `{ id: 'kokoro' }` from a stamped snapshot).
- Playwright e2e (`e2e/cross-book-cast-cleanup.spec.ts`) — the duplicate-review chip + bulk-review entry surfaces (written; run at integration).

### Manual acceptance walkthrough

1. **Open `#/voices` with a series carrying a cross-book duplicate** → the Kore/Charon family card shows the ⚠ pill AND a "Review all duplicates in <Series>" banner button.
2. **Click the bulk button** → a progress strip reads "1 / N"; the single-pair modal mounts. Link / Different-on-purpose / Skip → Next advances; the last pair closes the modal.
3. **Open the profile drawer for a duplicate character** → a "⚠ Possible duplicate of …" chip renders under the Voice-profile header. Click → the modal opens pre-populated.
4. **Mark a pair "different on purpose", then toggle "Show ignored duplicate suggestions"** → the pair is listed with an Unmark button. Click Unmark → toast, and the pair re-surfaces as a live candidate.
5. **Generate a Qwen book where one character has no designed voice** → that character's cast row Status reads "Fallback (Kokoro)". Design its voice + regenerate → the pill flips back to Designed/Generated.

## Out of scope

- Adding the plan-101 `POST /cast/:characterId/not-linked-to` (and now the DELETE) to `openapi.yaml` + `src/lib/api-types.ts`. The plan-101 POST shipped contract-by-test (no openapi path, hand-written `NotLinkedToArgs`/`NotLinkedToResponse` in `src/lib/api.ts`); the DELETE follows the same pattern for consistency. A follow-up could formalise both ops in the spec — filed as a backlog candidate rather than scope-creeping this round.
- A "fuzzy match" duplicate surface beyond the conservative substring rule (plan-101 out-of-scope, unchanged).

## Ship notes

(Filled in when status flips to `stable`.)
