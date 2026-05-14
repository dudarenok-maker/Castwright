# Voice match pipeline

> Status: stable
> Key files: `src/views/confirm-cast.tsx`, `src/store/cast-slice.ts`, `src/lib/api.ts` (`matchVoices`), `server/src/routes/voice-match.ts`, `server/src/workspace/library-cast-scan.ts`, `server/src/util/text-match.ts`, `src/modals/match-detail.tsx`
> URL surface: `#/books/:bookId/confirm`
> OpenAPI ops: `POST /api/books/:bookId/voice-match`

## What this covers

After stage-1 analysis finishes, the server scores each newly-extracted character against the user's existing voice library (cast files from prior books). Each match comes with an overall confidence score (0–1) and a list of contributing factors. The user reviews suggestions in the confirm-cast view, sees details in a modal, and can decline matches one-by-one without losing the underlying character.

## Scoring algorithm

Five factors. `nameScore = max(name_exact, name_tokens)`. The overall score
is `clamp01(0.65 * nameScore + 0.15 * gender + 0.10 * age_range + 0.10 * attributes)`.

| Factor       | Weight | Score 1.0 when…                                                                  | Score 0.0 when…                                  |
|--------------|:------:|----------------------------------------------------------------------------------|--------------------------------------------------|
| `name_exact` | 0.65   | normalized full name OR alias on either side hits the other side's normalized name/alias | not exact                                   |
| `name_tokens`| 0.65   | Jaccard of primary-name tokens (length ≥ 2) — aliases excluded from the bag      | no shared tokens                                 |
| `gender`     | 0.15   | both sides present and equal                                                     | both present and differ                          |
| `age_range`  | 0.10   | both sides present and equal                                                     | both present and differ                          |
| `attributes` | 0.10   | Jaccard of lowercased attribute sets ('narrator' filtered out)                    | disjoint or both empty                           |

`gender` and `age_range` score 0.5 when either side is absent (no contribution but no penalty); those rows are omitted from the response's `factors` list so the MatchDetail modal stays readable.

**Floor.** When `nameScore < 0.34`, the candidate is dropped entirely. This prevents gender + attribute coincidence alone from surfacing a "Matched" badge in the confirm view when there is no meaningful name signal.

**Library scope.** `scanLibraryCharacters()` (`server/src/workspace/library-cast-scan.ts`) walks `BOOKS_ROOT` and yields every character whose owning book has `state.castConfirmed === true`. The route excludes the current `bookId` from its own match candidates (a book never matches itself) and respects an optional `libraryVoiceIds` allow-list on the request body.

## Invariants to preserve

- `POST /api/books/:bookId/voice-match` request body: `{ characters: Character[] }`. Response shape: `VoiceMatchResponse { bookId, matches: { characterId, candidates: { voiceId, fromBookTitle, score, factors: MatchFactor[] }[] }[] }`.
- `MatchFactor`: `{ id, label, score, detail }`. Both `score` and per-factor `score` are 0–1 floats.
- `castActions.applyVoiceMatches` merges into `state.cast` keyed by `characterId` — never drops characters that have no candidates (`src/store/cast-slice.ts`). An empty `candidates` array means "no suggestion," not "remove this character."
- `castActions.declineMatch` removes the suggestion (clears `voiceId` + `matchedFrom`) without removing the character.
- The MatchDetail modal is opened via `setMatchDetailFor(characterId)`; closed via `setMatchDetailFor(null)` (`src/store/ui-slice.ts:111`). Survives navigation between confirm and other ready views.
- In mock mode, `mockMatchVoices` only returns candidates for characters that have a `matchedFrom` + `voiceId` in the canned data (`src/lib/api.ts:222-237`). Characters with no canned match return an empty `candidates` array.

## Acceptance walkthrough

Run `VITE_USE_MOCKS=true`. Upload and analyse a book until confirm-cast loads.

1. **Land on `#/books/:bookId/confirm`** → voice-match request fires (or in mock mode is canned). Each character row shows either (a) the suggested voice with a confidence badge, or (b) "No match — assign manually" if `candidates` is empty.
2. **Click "see details" on a matched character** → MatchDetail modal opens. Lists each factor (id, label, score 0–1, detail string). The modal title shows the character name + the source book.
3. **Decline a match** → suggestion disappears from the row; character row now shows "Assign a voice" CTA. Re-opening the row does NOT re-show the declined match.
4. **Confirm cast** → URL transitions to `#/books/:bookId/manuscript?chapter=3` (per `confirmCast` reducer + `READY_DEFAULTS`).
5. **Character with no candidates** → row shows "no match" state from first paint; no modal can be opened (the "see details" button is hidden).
6. **Server error** (real backend, force 500) → request throws; UI shows an inline error with a retry button; characters render with no suggestions (graceful degradation).

## Cross-book live walkthrough (real backend)

The canonical e2e manuscript for cross-book matching is `~/Downloads/the Coalfall Commission.txt` (do not commit). To exercise the live scoring against a second book in the same series:

1. With a confirmed Keepers book already in the workspace (Marlow present, cast confirmed on disk), import and analyse `the Coalfall Commission.txt`.
2. **On the confirm page**, the Marlow row should render:
   - "Matched · N%" pill with N derived from `0.65 * nameScore + 0.15 * gender + 0.10 * age + 0.10 * attributes`.
   - "From {prior book title}" in the Reuse tile subtitle.
   - The continuity footer "Continuity preserved — Marlow from {prior book} will be used."
3. **Open MatchDetail** on the Marlow row → factors include `name_exact` (score 1.0 when names match cleanly) or `name_tokens` (e.g. ½ when the prior book had "Marlow" and this one has "Marlow Halden"). Plus gender/age_range/attributes when they contribute.
4. **Non-recurring characters** (only in the new book) → render as Generated with no Matched pill.

## Out of scope

- Cross-book voice cloning / sample re-rendering — covered by `22-voice-library.md` and the TTS plans.
- Bulk-accept-all UI — v1 is per-character review.
- Fuzzy name match beyond token Jaccard (e.g. Levenshtein on misspellings). Add when a real failure case shows up.
