---
status: stable
shipped: 2026-05-13
owner: null
---

# Voice match pipeline

> Status: stable
> Key files: `src/views/confirm-cast.tsx`, `src/store/cast-slice.ts`, `src/lib/api.ts` (`matchVoices`, `overrideLibraryCast`, `getSeriesRoster`, `linkPriorCharacter`), `src/modals/profile-drawer.tsx`, `src/components/layout.tsx`, `server/src/routes/voice-match.ts`, `server/src/routes/library-cast-override.ts`, `server/src/routes/cast-link-prior.ts`, `server/src/routes/series-roster.ts`, `server/src/workspace/library-cast-scan.ts`, `server/src/workspace/series-cast-scan.ts`, `server/src/util/text-match.ts`, `src/modals/match-detail.tsx`
> URL surface: `#/books/:bookId/confirm`
> OpenAPI ops: `POST /api/books/:bookId/voice-match`, `POST /api/library-cast/override` (path not in openapi.yaml — mirrors `cast/merge`), `POST /api/books/:bookId/cast/link-prior` + `GET /api/books/:bookId/series-roster` (also kept out of openapi.yaml — same precedent)

## What this covers

After stage-1 analysis finishes, the server scores each newly-extracted character against the user's existing voice library (cast files from prior books). Each match comes with an overall confidence score (0–1) and a list of contributing factors. The user reviews suggestions in the confirm-cast view, sees details in a modal, and can decline matches one-by-one without losing the underlying character.

## Scoring algorithm

Five factors. `nameScore = max(name_exact, name_tokens)`. The overall score
is `clamp01(0.65 * nameScore + 0.15 * gender + 0.10 * age_range + 0.10 * attributes)`.

| Factor        | Weight | Score 1.0 when…                                                                          | Score 0.0 when…         |
| ------------- | :----: | ---------------------------------------------------------------------------------------- | ----------------------- |
| `name_exact`  |  0.65  | normalized full name OR alias on either side hits the other side's normalized name/alias | not exact               |
| `name_tokens` |  0.65  | Jaccard of primary-name tokens (length ≥ 2) — aliases excluded from the bag              | no shared tokens        |
| `gender`      |  0.15  | both sides present and equal                                                             | both present and differ |
| `age_range`   |  0.10  | both sides present and equal                                                             | both present and differ |
| `attributes`  |  0.10  | Jaccard of lowercased attribute sets ('narrator' filtered out)                           | disjoint or both empty  |

`gender` and `age_range` score 0.5 when either side is absent (no contribution but no penalty); those rows are omitted from the response's `factors` list so the MatchDetail modal stays readable.

**Floor.** When `nameScore < 0.34`, the candidate is dropped entirely. This prevents gender + attribute coincidence alone from surfacing a "Matched" badge in the confirm view when there is no meaningful name signal.

**Library scope.** `scanLibraryCharacters()` (`server/src/workspace/library-cast-scan.ts`) walks `BOOKS_ROOT` and yields every character whose owning book has `state.castConfirmed === true`. The route excludes the current `bookId` from its own match candidates (a book never matches itself) and respects an optional `libraryVoiceIds` allow-list on the request body.

**Series-scoped scanning.** `scanSeriesCharacters(author, series, { excludeBookId? })` (`server/src/workspace/series-cast-scan.ts`) is a filtered slice of the same data: same `castConfirmed === true` gate, plus a `(state.author, state.series)` filter and an `isStandalone === true` exclusion (standalones aren't part of a series's continuity). Used by Phase 0a's per-chapter detection prompt (C2) so the analyzer for book N+1 of a series sees the confirmed cast from books 1..N as a prior — distinct from the confirm-time voice-match scan this plan covers. `scanSeriesCharactersForBookId(bookId)` resolves `(author, series)` from `state.json` and applies `excludeBookId` automatically.

## Invariants to preserve

- `POST /api/books/:bookId/voice-match` request body: `{ characters: Character[] }`. Response shape: `VoiceMatchResponse { bookId, matches: { characterId, candidates: { voiceId, fromBookId, fromBookTitle, fromCharacterId, score, factors: MatchFactor[] }[] }[] }`. `fromBookId` + `fromCharacterId` carry a stable handle on the library record so the override flow can address it without re-walking the books tree.
- `MatchFactor`: `{ id, label, score, detail }`. Both `score` and per-factor `score` are 0–1 floats.
- `castActions.applyVoiceMatches` merges into `state.cast` keyed by `characterId` — never drops characters that have no candidates (`src/store/cast-slice.ts`). An empty `candidates` array means "no suggestion," not "remove this character." Writes `matchedFrom: { bookId, characterId, bookTitle, confidence }` on the survivor.
- `castActions.declineMatch` removes the suggestion (clears `voiceId` + `matchedFrom`) without removing the character.
- The MatchDetail modal is opened via `setMatchDetailFor(characterId)`; closed via `setMatchDetailFor(null)` (`src/store/ui-slice.ts:111`). Survives navigation between confirm and other ready views.
- In mock mode, `mockMatchVoices` only returns candidates for characters that have a `matchedFrom` + `voiceId` in the canned data (`src/lib/api.ts:300-318`). Characters with no canned match return an empty `candidates` array. The mock forwards `bookId` / `characterId` from the canned `matchedFrom` so the override checkbox can be exercised in mock mode too.

## Library-cast override (reverse of "Reuse")

When the current book contains a richer profile of a recurring character than the library record it matched against (e.g. the current book is a full novel; the library record came from a novella that met the character only briefly), the user can push the current profile back onto the library record. This runs _in addition to_ the normal Reuse decision — the source book still uses the library voice for continuity; the library record itself inherits the source's richer description/attributes/aliases.

- **Endpoint:** `POST /api/library-cast/override`. Body: `{ sourceBookId, sourceCharacterId, targetBookId, targetCharacterId }`. Response: `{ character: CharacterOutput }`. Route at `server/src/routes/library-cast-override.ts`.
- **Preserved on target:** `id`, `voiceId`, `name`, `color`, `voiceState`, `lines`, `scenes`, `evidence`. Audio identity must not move (chapter audio in the target book is bound to `voiceId`); per-book metrics + per-book quotes are not portable across manuscripts.
- **Replaced on target (when source has a value):** `description`, `role`, `gender`, `ageRange`, `tone`, `attributes` (union, source first). `aliases` = target's aliases ∪ source.name (if it differs from target.name) ∪ source.aliases, case-insensitive dedup. Same alias contract as manual `cast/merge`.
- **UI:** the "Continuity preserved" footer on the confirm-cast card grows an opt-in checkbox: "Update library profile from this manuscript." Default off. Renders only when (a) the parent route wired `onOverrideLibrary` and (b) `matchedFrom` carries both `bookId` and `characterId` (older voice-match cache entries without these are inert for this flow).
- **Fire timing:** `ConfirmCastView` collects per-character override choices locally; the "Confirm cast" button fires all opted-in overrides via `Promise.allSettled` before dispatching `uiActions.confirmCast()`. A failing override does NOT block the cast confirm — it just logs to console (`[confirm-cast] library override failed`).
- **Decline interaction:** if the user toggles override on and then switches the decision tile to "Generate fresh," the override is skipped (the toggle is only meaningful when `decision === 'match'`). The view's `handleConfirm` re-checks `decisions[c.id] === 'match'` before queueing the request.
- **What it does NOT touch:** the target book's `manuscript-edits.json`, `analysis-cache`, or `chapterCast`. Override is profile-only; sentence attributions reference characters by `id`, which is preserved.

## Manual continuity link (when auto-match misses)

When the auto-matcher's `nameScore < 0.34` floor drops a legitimate link — e.g. the new book has "Hartwell Brennan Vale" and the prior book has the canonical "Hart" (token Jaccard = 0, alias not pre-seeded) — the user has no way to fix it from the existing UI: the Profile Drawer's "Merge into another character…" dropdown only listed in-book candidates, so the prior character was unreachable. This section covers the manual-link affordance that closes that gap.

- **Endpoint:** `POST /api/books/{bookId}/cast/link-prior`. Body: `{ sourceCharacterId, targetBookId, targetCharacterId }`. Response: `{ matchedFrom: { bookId, characterId, bookTitle, confidence: 1 }, voiceId? }`. Route at `server/src/routes/cast-link-prior.ts`.
- **Roster endpoint:** `GET /api/books/{bookId}/series-roster`. Returns `{ characters: Array<{ id, name, bookId, bookTitle, voiceId?, aliases?, gender?, ageRange? }> }` — a thin wrapper around `scanSeriesCharactersForBookId()` so the frontend's optgroup picker has data to render. Route at `server/src/routes/series-roster.ts`. Neither route is in `openapi.yaml` — same precedent as `cast/merge` and `library-cast/override`.
- **Side effect on disk:** the link-prior call appends `source.name` (plus any of `source.aliases`) to the prior book's character `aliases` in its on-disk `cast.json` (atomic-rename, case-insensitive dedup, drops the target's own name). The matcher uses these on future books to recognise either surface form, so the link is durable even though the source book's `matchedFrom` lives only in Redux for the confirm session.
- **Series-scope guard:** the route rejects 404 when target is not a series-mate of source — same (author, series) + neither side is a standalone. Mirrors the filter `scanSeriesCharacters` already applies; the frontend dropdown and server accept-set therefore agree.
- **UI:** the Profile Drawer's existing "Merge X into another character…" picker grows a second `<optgroup label="From prior books in this series">` populated from `getSeriesRoster()`. Each prior option carries a `prior:${index}` discriminator value; the drawer's change handler routes the selection to `onLinkPrior` instead of `onMerge`, and the primary button label flips from "Merge" to "Link". Layout filters priors whose `id` is already the `matchedFrom.characterId` of a current cast member (already auto-matched → no need to manually re-link). Series-roster fetches are cached per-bookId so reopening the drawer within the same book doesn't refetch.
- **Frontend dispatch:** on a successful `link-prior` response, Layout dispatches `castActions.applyManualMatch({ characterId, matchedFrom, voiceId })` (single-row analogue of `applyVoiceMatches`; preserves `voiceState='locked'`/`'tuned'`). The "Continuity preserved" footer + "Sync profile" checkbox light up exactly like an auto-match — same code path in `confirm-cast.tsx`. The user can then tick the existing `library-cast/override` checkbox to symmetric-sync the richer profile across both books.
- **What it does NOT touch:** the source book's `cast.json` (the manual link is observed in Redux for this session; a re-run of voice-match reconstructs `matchedFrom` from the new alias on the prior). Voice tuning state on the source character is preserved.

## Acceptance walkthrough

Run `VITE_USE_MOCKS=true`. Upload and analyse a book until confirm-cast loads.

1. **Land on `#/books/:bookId/confirm`** → voice-match request fires (or in mock mode is canned). Each character row shows either (a) the suggested voice with a confidence badge, or (b) "No match — assign manually" if `candidates` is empty.
2. **Click "see details" on a matched character** → MatchDetail modal opens. Lists each factor (id, label, score 0–1, detail string). The modal title shows the character name + the source book.
3. **Decline a match** → suggestion disappears from the row; character row now shows "Assign a voice" CTA. Re-opening the row does NOT re-show the declined match.
4. **Confirm cast** → URL transitions to `#/books/:bookId/manuscript?chapter=3` (per `confirmCast` reducer + `READY_DEFAULTS`).
5. **Character with no candidates** → row shows "no match" state from first paint; no modal can be opened (the "see details" button is hidden).
6. **Server error** (real backend, force 500) → request throws; UI shows an inline error with a retry button; characters render with no suggestions (graceful degradation).

## Cross-book live walkthrough (real backend)

The canonical e2e manuscript for cross-book matching is `server/src/__fixtures__/the-coalfall-commission.md` (do not commit). To exercise the live scoring against a second book in the same series:

1. With a confirmed Keepers book already in the workspace (Marlow present, cast confirmed on disk), import and analyse `the Coalfall Commission.txt`.
2. **On the confirm page**, the Marlow row should render:
   - "Matched · N%" pill with N derived from `0.65 * nameScore + 0.15 * gender + 0.10 * age + 0.10 * attributes`.
   - "From {prior book title}" in the Reuse tile subtitle.
   - The continuity footer "Continuity preserved — Marlow from {prior book} will be used."
3. **Open MatchDetail** on the Marlow row → factors include `name_exact` (score 1.0 when names match cleanly) or `name_tokens` (e.g. ½ when the prior book had "Marlow" and this one has "Marlow Halden"). Plus gender/age_range/attributes when they contribute.
4. **Non-recurring characters** (only in the new book) → render as Generated with no Matched pill.
5. **Override toggle** (e.g. when the current book has a fuller portrait than the prior one): check "Update library profile from this manuscript" inside the continuity footer for any matched row, then click Confirm cast. The prior book's `cast.json` should now carry the richer `description` / `attributes` / `aliases` from this manuscript while its `voiceId` and chapter audio stay intact (`books/{author}/{series}/{prior-title}/.audiobook/cast.json`). Source's `name` lands in the library record's `aliases` if the names differed.
6. **Manual link** (auto-matcher missed): on the new book, open the drawer for a character that has no continuity footer (e.g. "Hartwell Brennan Vale"). Click "Merge … into another character…", expand the dropdown, and pick the matching prior under the "From prior books in this series" optgroup (e.g. "Hart"). Click "Link". The drawer closes and the cast card now shows the same "Continuity preserved" footer with "Sync profile" checkbox the auto-match path produces. On disk, the prior book's character `aliases` now includes the new book's character name (`books/{author}/{series}/{prior-title}/.audiobook/cast.json`). A subsequent voice-match run on any series book will pick up the new alias and surface a real `matchedFrom` for the new character automatically.

## Out of scope

- Cross-book voice cloning / sample re-rendering — covered by `22-voice-library.md` and the TTS plans.
- ~~Bulk-accept-all UI — v1 is per-character review.~~ **Shipped 2026-05-18** as plan 41 (`archive/41-bulk-library-sync.md`). Top-of-view "Apply all N matches" pill flips Reuse + auto-ticks the library-sync checkbox for low-confidence (< 0.9) rows (Bug C 2026-05-19 + Bug D 2026-05-22 refinements). Per-card untick still handles exceptions.
- Fuzzy name match beyond token Jaccard (e.g. Levenshtein on misspellings). Add when a real failure case shows up.
