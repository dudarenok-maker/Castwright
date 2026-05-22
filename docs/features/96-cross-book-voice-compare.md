---
status: active
shipped: null
owner: null
---

# Cross-book voice Compare with series-propagating saves

> Status: active
> Key files: `src/views/voices.tsx`, `src/modals/compare-cast-modal.tsx`, `src/lib/api.ts`, `server/src/routes/cast-series-patch.ts`
> URL surface: `#/voices` (global voice library) and `#/books/<id>/library` (per-book Voices tab) — Compare modal mount
> OpenAPI ops: not surfaced through `openapi.yaml` (the sibling `cast/merge` + `cast/link-prior` routes are also hand-typed in `src/lib/api.ts` — same precedent)

## Benefit / Rationale

- **User:** the Compare button now works for cast-member pairs from different books in the same series — e.g. comparing Alden in *Exile* against Mr. Sweeney in *Keeper of the Lost Cities*. Saves on either side propagate to every book in the series whose cast contains that same character (matched by name or alias). Dark-mode contrast on the floating toolbar's "same / different base voice" badges is also fixed so the pill is actually readable.
- **Technical:** drops the cross-book guard at `voices.tsx` and the silent fallback that only saved to redux for the open book. Saves now route through a single new endpoint that resolves the series via the existing dedup primitive (`dedupSeriesPrior`) and writes to each matched `cast.json` atomically.
- **Architectural:** reuses plan-94's normalisation rule (`lowercase + strip non-alphanum`) as the canonical "is this the same character?" predicate across both Phase-0a prompt rendering and the cross-book save path. No new matching predicate — drift between save propagation and prompt rendering is impossible by construction.

## Architectural impact

- **New seam:** `POST /api/books/:bookId/cast/:characterId/series-patch` in `server/src/routes/cast-series-patch.ts`. Body is intentionally narrow (`gender? | ageRange? | tone?` only). Voice-override + audio-affecting fields are NOT accepted — those are book-local decisions and propagating them silently would invalidate already-rendered audio in books the user isn't looking at.
- **Frontend hydrate refactor:** the old `fetchAndOpenForeignCast` (single-book, open-modal-after-fetch) is split into a pure `hydrateForeignCast(bookId): Promise<Character[] | null>` plus an `openCompareModal(voicePair)` orchestrator. Per-side parallel fetches share the cache + single-flight `globalCastFetching` set; same-bookId pairs dedupe to one fetch.
- **Modal contract extension:** `CompareCastModal` gains an opt-in `propagatesAcrossSeries` prop. When true, an inline hint renders on each side: "Saves propagate to every book in this series where this character appears." Default false keeps the single-book `cast.tsx` call site unchanged.
- **Toolbar shell:** `voices.tsx` adopts `.floating-pill-inverse` (already in `styles.css:409–416`) instead of raw `bg-ink text-canvas`. The styles.css comment block documents the exact failure mode this fixes — `--ink`/`--canvas` swap in dark mode would otherwise flip the pill to cream and wash out all the `bg-canvas/15` overlays inside.
- **Invariant preserved (plan 94):** the dedup rule used by `cast-series-patch.ts` matches `dedupSeriesPrior`'s normalisation (`s.toLowerCase().replace(/[^a-z0-9]/g, '')`). Drift between the analyser prompt's "same character" notion and the save propagation's "same character" notion would let saves miss the row the analyser counted as the same person.
- **Reversibility:** revert the route file + the `voices.tsx` save handler. The frontend would fall back to the redux-only save path (open book only); cross-book Compare itself can be re-gated by restoring the bookId-mismatch check at `compareDerivations`.

## Invariants to preserve

1. **Patch body schema is closed.** `server/src/routes/cast-series-patch.ts` accepts only `gender | ageRange | tone`. Unknown keys → 400. Voice-override or any audio-affecting field must NEVER reach this endpoint — see the `patchSchema` zod definition.
2. **Same dedup predicate as plan 94.** `normaliseToken` in `cast-series-patch.ts` mirrors the one in `series-prior-dedup.ts:43`. Any change to the normalisation rule must update both.
3. **Standalone books propagate to themselves only.** `scanSeriesCharactersForBookId` returns `[]` for a standalone (or for a book whose series has no siblings); the route falls back to a single-target write. Asserted at `cast-series-patch.test.ts > 'writes only to the source when the book is a standalone'`.
4. **Cross-series scope guard.** `scanSeriesCharactersForBookId` already filters by `(author, series)`. Cross-series characters that happen to share a name (e.g. Sophie in KOTLC vs. Sophie in a different series) are NOT propagated to. Asserted at `cast-series-patch.test.ts > 'propagates the patch to all series-mate books containing the same-named character'` which seeds a same-name character in a different-series book and verifies it is left untouched.
5. **Partial-failure surfacing.** `cast-series-patch.ts` returns HTTP 207 when any sibling write fails; the frontend's `onSaveSide` handler in `voices.tsx` pushes a per-failed-book error toast alongside the success toast. Asserted at `voices.test.tsx > 'pushes a per-failed-book error toast alongside the success toast on partial-success'`.
6. **Modal hint is opt-in.** `CompareCastModal` renders the propagation hint only when `propagatesAcrossSeries={true}` is passed. `cast.tsx`'s in-book Compare must NOT show it — single-book saves don't go through the series-patch endpoint. Asserted at `compare-cast-modal.test.tsx > 'hides the "Saves propagate" hint by default (cast.tsx call-site)'`.
7. **Toolbar shell stays dark in dark mode.** `voices.tsx` uses `.floating-pill-inverse` (not raw `bg-ink text-canvas`). See `styles.css:401–416` for the documented failure mode.

## Test plan

### Automated coverage

- **Vitest server** (`server/src/routes/cast-series-patch.test.ts`) — 9 cases: empty body, unknown key, out-of-range tone axis, unknown bookId / characterId, multi-book name-match propagation, alias-match propagation, standalone single-target, cross-series scope guard (negative), single-sibling write-failure → 207.
- **Vitest frontend** (`src/views/voices.test.tsx`) —
  - Cross-book Compare button enabled (was the BACKLOG #7 disabled assertion, flipped).
  - Save calls `api.seriesPatchCharacter` with the edited side's patch.
  - Multi-book updated → "Saved to N books in this series" toast.
  - Partial-failure surfaces per-failed-book error toast.
  - Network error → "Save failed — try again." toast.
- **Vitest modal** (`src/modals/compare-cast-modal.test.tsx`) — propagation hint hidden by default, shown on both sides when `propagatesAcrossSeries={true}`.
- **Playwright e2e** (`e2e/voices-compare.spec.ts`) — cross-book Compare button enabled; old "Cross-book compare not supported yet" tooltip absent. (Dialog-open assertion deferred to Vitest because the `sb` mock state intentionally returns `cast: null` to anchor a sibling per-book test.)

### Manual acceptance walkthrough

1. **Dark mode, `#/voices`** → toggle dark mode in the appearance panel. Floating toolbar pill at the bottom of the view shows readable text on a dark background (was unreadable cream-on-cream pre-fix).
2. **Select two cross-book same-series characters** → e.g. Alden (Exile) + Mr. Sweeney (Keeper of the Lost Cities). Toolbar shows "same base voice ✓" badge (both routed to `am_adam`); text is legible. Compare button is enabled.
3. **Click Compare** → modal mounts with both characters as Side A / Side B. Each side renders the inline hint "Saves propagate to every book in this series where this character appears."
4. **Edit a tone slider on Side A** → Side A's Save button enables.
5. **Click Save on Side A** → toast appears at the bottom of the screen: "Saved to N books in this series." where N is the number of books in the series that contain Alden by name or alias.
6. **Navigate to a sibling book** → open that book's Cast tab → open Alden's profile → the edited tone is present (the save propagated).
7. **Standalone book** → open the Compare modal for a pair inside a standalone book. Hint still renders (the modal can't know it's a standalone without an extra pre-query), but the post-save toast reads "Saved." with N=1.

## Out of scope

- **Voice override propagation across the series.** The endpoint deliberately rejects `voiceId` in the body. Override is a book-local TTS-routing decision; propagating it would invalidate already-generated audio in foreign books without warning.
- **Audio invalidation across propagated books.** Tone / gender / ageRange edits don't invalidate already-generated audio in the current pipeline (they feed the analyser hint and any future regen). If that changes, a separate cross-book invalidation pass is needed.
- **Pre-querying the series-sibling count for the modal hint.** The hint shows a generic message rather than a specific N. The post-save toast carries the actual N. Avoiding the pre-query keeps the modal mount cheap and dodges a stale-count race when the user just dragged in a new alias.
- **Batch voice replace across books** — BACKLOG #3 in the Could bucket; separate write story.

## Ship notes

(Filled in when status flips to `stable`.)
