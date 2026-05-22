---
status: stable
shipped: 2026-05-22
owner: null
---

# Cross-book duplicate cleanup — review surface for escaped continuity-links

> Status: stable
> Key files: `src/views/voices.tsx`, `src/modals/duplicate-review-modal.tsx`, `src/lib/cross-book-duplicates.ts`, `src/store/cast-slice.ts`, `src/lib/api.ts`, `src/mocks/voices.ts`, `server/src/routes/cast-not-linked-to.ts`, `server/src/handoff/schemas.ts`, `openapi.yaml`
> URL surface: `#/voices` (global) and `#/books/<id>/library` (per-book) — modal opens in place
> OpenAPI ops: new `POST /api/books/{bookId}/cast/{characterId}/not-linked-to`; reuses `POST /api/books/{bookId}/cast/link-prior` (plan 09)

## Benefit / Rationale

- **User:** When the Phase-0a name matcher misses a continuity-link across books in the same series (e.g. "Sophie Foster" in *Everblaze* vs "Sophie" in *Exile*, both routed to Kokoro `af_aoede`), the voices view today silently shows two separate cast rows under one base voice. The user has no discoverable way to fix it — plan 99's voices-pill Merge button is hard-gated to same-book pairs because cross-book merges would corrupt sentence attribution. The new "Review duplicate" affordance + passive ⚠ pill on each voice-family card makes the duplicate visible AND fixable in two clicks, with an explicit escape hatch for intentional variants (e.g. "teenage Sophie" vs "adult Sophie" — the user's real case).
- **Technical:** Reuses the existing `cast-link-prior` transport (plan 09) for the "same character — link them" path; adds one new same-shape route (`cast-not-linked-to`) for the "different on purpose" path. No changes to sentence attribution, no changes to `manuscript-edits.json`, no changes to per-book character IDs. The cross-book guard in `voices.tsx:220-222` is preserved exactly — we ADD a third action surface alongside the existing same-book Merge button rather than relaxing the existing gate.
- **Architectural:** Establishes "linked-as-same" vs "marked-as-variant" as a first-class invariant on the `Character` schema (new `notLinkedTo?: { bookId, characterId }[]` field, persisted symmetrically). The duplicate-candidate predicate lives client-side as a pure derivation off the existing `series-prior-dedup` normalisation rule — no server-side scanning, no new on-disk index file. Profile-drawer becomes the per-character entry point and voices-view becomes the cross-book discovery surface, both funnelling through one shared `DuplicateReviewModal`.

## Architectural impact

- **Two new actions, two new entry points (v1), one shared modal.** Actions: link (existing `cast-link-prior` POST) + mark-as-variant (new `cast-not-linked-to` POST). Entry points: voices-pill `Review duplicate ↗` button (replaces the disabled `Merge` when 2 cross-book same-base-voice cards are selected), per-family ⚠ pill (auto-detected candidates). Both open `<DuplicateReviewModal/>`, which dispatches the chosen action. The profile-drawer chip is a v2 follow-up (see Out of scope).
- **`Character.notLinkedTo?: { bookId, characterId }[]`** — symmetric pair-write to both books' cast.json. Server route `POST /api/books/:bookId/cast/:characterId/not-linked-to { otherBookId, otherCharacterId }` writes both sides atomically. Same series-scope guard as `cast-link-prior` (same author + series, neither standalone). Idempotent — adding an already-present pair is a no-op write.
- **Duplicate-candidate detection** lives in `src/lib/cross-book-duplicates.ts` (pure helper) and is wired through a memo in `voices.tsx`. Predicate per pair (a, b):
  1. Same `(ttsVoice.provider, ttsVoice.name)` (a.k.a. same family)
  2. Same `(author, series)`, neither standalone
  3. `a.bookId !== b.bookId`
  4. Normalised-name match per `server/src/workspace/series-prior-dedup.ts:normaliseToken` rule (lowercase + strip non-alphanumeric), OR one normalised name is a strict substring of the other (e.g. `sophie` ⊂ `sophiefoster`)
  5. Pair NOT in either character's `notLinkedTo` set
  6. Neither character has the other already linked via `aliases` (case-insensitive name match)
- **Mock-mode parity.** `api.linkPrior` + new `api.notLinkedTo` shipped in `src/lib/api.ts`'s mock branch with realistic latency + symmetric local-store mutation. Mock fixture: KOTLC books 1+2 share a Sophie/Sophie-Foster unlinked pair to trigger the chip on first load.
- **No changes to `cast-link-prior` server semantics.** The route already does what we need; the modal just dispatches it with the pair the user picked.

## Invariants to preserve

- **Cross-book merge gate** in `src/views/voices.tsx:220-222` (`Cross-book merges aren't supported`) stays exactly as is. The cross-book path does not route through `cast-merge` — it dispatches `cast-link-prior` instead. Do not relax the original guard.
- **`series-prior-dedup` normalisation rule** in `server/src/workspace/series-prior-dedup.ts` (`s.toLowerCase().replace(/[^a-z0-9]/g, '')`) is the single source of truth for "same character" matching. The frontend duplicate-candidate predicate MUST mirror it byte-for-byte; if the server's rule changes, update the frontend port in the same PR.
- **Profile-drawer merge-picker contract** (`src/modals/profile-drawer.tsx:70, 283-300`) stays unchanged. The new `DuplicateReviewModal` is a parallel surface, not a replacement — users can still open the drawer's `mergeCandidatesPrior` dropdown to link arbitrary prior-book characters.
- **Series-scope guard** in `server/src/routes/cast-link-prior.ts:85-93` (same author + series, neither standalone). The new `cast-not-linked-to` route mirrors this guard — refusing to record a "not linked" decision across series prevents the field from being a general-purpose ignore list.
- **`UNMERGEABLE_IDS = { narrator, unknown-male, unknown-female }`** in `src/views/voices.tsx:77`. Duplicate detection MUST exclude these IDs on both sides (a narrator from book A is never a duplicate of a named character in book B, even if names normalise the same way somehow).

## Test plan

### Automated coverage

- **Vitest unit (`src/views/voices.test.tsx`)** — new `describe('LibraryView cross-book duplicate review (plan 101)')`:
  - Asserts `⚠ N duplicate candidate(s)` pill appears on `af_aoede` family with Sophie/Sophie-Foster fixture.
  - Asserts clicking the pill opens `<DuplicateReviewModal/>` pre-populated with the pair.
  - Asserts 2× selection on the cross-book pair shows `Review duplicate ↗` button (not the disabled `Merge`).
  - Asserts pair where one side has the other in `notLinkedTo` does NOT render the ⚠ pill (regression for the variant case).
  - Asserts pair where one side has the other in `aliases` does NOT render the ⚠ pill (already-linked case).
  - Asserts same-book duplicate pair still shows plan-99 `Merge into …` button, not the new `Review duplicate ↗`.
- **Vitest unit (`src/modals/duplicate-review-modal.test.tsx`)** — new file:
  - Link path dispatches `api.linkPrior({ sourceBookId, sourceCharacterId, targetBookId, targetCharacterId })` then `castActions.applyManualMatch` then closes modal.
  - Variant path dispatches `api.notLinkedTo({ bookId, characterId, otherBookId, otherCharacterId })` then `castActions.applyNotLinked` then closes modal.
  - Error toast on either path leaves the modal open.
  - Survivor picker defaults to longer-named side (reusing `pickMergeSurvivor`).
- **Vitest server (`server/src/routes/cast-not-linked-to.test.ts`)** — new file:
  - Happy path writes `notLinkedTo` on BOTH books' cast.json atomically.
  - Idempotent: writing the same pair twice does not duplicate the array entry.
  - Same-series guard rejects cross-series pairs with 404 (mirrors `cast-link-prior.test.ts`).
  - 400 on missing body fields / self-pair (`otherBookId === sourceBookId && otherCharacterId === sourceCharacterId`).
  - 404 on unknown source / target character or book.
- **Playwright e2e (`e2e/voices/duplicate-review.spec.ts`)** — new file (TWO scenarios):
  - **Link path**: load mock workspace with KOTLC #1 Sophie Foster + KOTLC #2 Sophie unlinked → navigate `#/voices` → assert ⚠ pill visible on `af_aoede` family → click → modal → choose "Same character, link them" → modal closes → reload page → assert ⚠ pill gone (alias persisted).
  - **Variant path**: same fixture → click ⚠ pill → choose "Different on purpose (e.g. teenage vs adult)" → modal closes → reload → assert ⚠ pill gone (notLinkedTo persisted).

### Manual acceptance walkthrough

Run in mock mode (`VITE_USE_MOCKS=true`) — the KOTLC #1+#2 fixture seeds the unlinked Sophie/Sophie-Foster pair.

1. **Cold boot at `#/voices`** → expected family card for `af_aoede` (Kokoro) shows two character rows: "Sophie Foster" (Everblaze) + "Sophie" (Exile). Expected: small amber `⚠ 1 duplicate candidate` pill in the family-card header.
2. **Click the pill.** Expected: `<DuplicateReviewModal/>` opens with side-by-side cards. Header: "Same person across books?". Default survivor: "Sophie Foster" (longer name). Survivor radio is swappable.
3. **Click "Same character — link them"** with default survivor. Expected: modal shows a brief spinner → closes. The amber pill on the family card disappears. Open Sophie Foster's profile drawer → "Sophie" is now in the alias list.
4. **Reload `#/voices`.** Expected: amber pill stays gone (alias persists on disk).
5. **Reset fixture (refresh browser in mock mode).** Re-open the pill, this time pick "Different on purpose (e.g. teenage vs adult)". Expected: modal closes, amber pill disappears. Open both cast rows' profile drawers — both rows still exist (no alias appended).
6. **Reload.** Expected: amber pill stays gone (notLinkedTo persists on disk symmetrically on both rows).
7. **Cross-book pair selection via radios.** With Sophie + Sophie Foster selected (one tick on each card), expected pill text: `Selected · 2 · same base voice ✓ · Compare · Review duplicate ↗ · Clear`. The same-book plan-99 `Merge into …` button does NOT appear (cross-book).
8. **Same-book pair (regression).** Select two `af_aoede` characters from the same book. Expected: plan-99 `Merge into …` button appears (not `Review duplicate ↗`).
9. **Profile drawer fallback.** Reset fixture → open Sophie's profile drawer (from any cast view) → click the existing "Merge into…" picker. Expected: the prior-book optgroup ("From prior books in this series") lists "Sophie Foster (Everblaze)". Selecting it fires the same `cast-link-prior` flow the voices-view modal uses; the amber pill on `#/voices` disappears on next visit. (No new chip in v1 — see Out of scope.)
10. **Variant fixture coverage.** With the variant-marked pair from step 5, navigate to `#/voices` — confirm no ⚠ pill on the family card. Both cast rows stay live but the "duplicate" suggestion stops surfacing.

## Out of scope

- **Profile-drawer "Possible duplicate of …" chip.** The drawer's existing `mergeCandidatesPrior` dropdown already provides the cast-side link path (plan 09); discoverability via a top-of-drawer chip is a v2 follow-up tracked in BACKLOG. Voices-view ⚠ pill is the primary surface in v1.
- **Bulk "review all duplicates in series"** single-modal walkthrough. v1 is one-pair-at-a-time. Track as BACKLOG follow-up if user requests after first ship.
- **Undo for "different on purpose" decisions.** No UI to remove a `notLinkedTo` entry once added. Server route could grow `DELETE` semantics (or `{ remove: true }` in the body) but no frontend surface in v1.
- **Cross-series linking.** The series-scope guard intentionally rejects pairs across different series. Use the existing voice-override flow if two characters in unrelated books should share a voice profile.
- **Detecting cross-base-voice duplicates.** If the user hand-tuned Sophie to `af_alloy` in Exile while keeping `af_aoede` in Everblaze, the predicate's same-family rule will miss them. Out of scope — covered by the existing same-base-voice surface.
- **Auto-linking on analysis.** This plan is the manual cleanup surface. The auto-matcher improvements live in plan 09 / plan 94.

## Ship notes

- **Shipped:** 2026-05-22 via PR #176, merge commit `477a21d`.
- **No spec delta from the active plan.** Detector, modal, server route, mock fixture, and all 4 voices-test + 9 modal + 9 server + 15 lib + 1 e2e cases shipped exactly as drafted. `npm run verify` (full pre-push battery) green on first run after rebase.
- **Renumber on rebase:** drafted as plan 100; renumbered to 101 because PR #171 (GPU-arbitration-semaphore) had archived as `archive/100-gpu-arbitration-semaphore.md` and PR #173 (docs-only CI skip) had archived as `archive/100-docs-only-ci-skip.md` (later renumbered to `archive/101-docs-only-ci-skip.md` in PR #175). When this plan archives, the `archive/101-cross-book-duplicate-review.md` slot will collide with the docs-only-ci-skip archive — same numbering pattern plan 99 set, where two plans can share a number across active/archive boundaries (in-code references stay at original ship-time number for historical accuracy).
- **Tests landed and green:** 15 new cases in `src/lib/cross-book-duplicates.test.ts`; 9 new cases in `src/modals/duplicate-review-modal.test.tsx`; 9 new cases in `server/src/routes/cast-not-linked-to.test.ts`; 4 new cases in `src/views/voices.test.tsx` (`describe('LibraryView cross-book duplicate review (plan 101)')`); 1 new chromium spec in `e2e/voices-duplicate-review.spec.ts`. Existing 32 voices-view + 88 e2e tests stayed green.
- **Deferred follow-ups filed:** BACKLOG Could #34 (profile-drawer chip), #35 (bulk per-series review modal), #36 (undo for variant decisions). Each carries a what / acceptance / key-files / depends / benefit per the BACKLOG entry shape.
