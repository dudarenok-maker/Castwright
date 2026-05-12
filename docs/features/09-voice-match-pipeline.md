# Voice match pipeline

> Status: stable
> Key files: `src/views/confirm-cast.tsx`, `src/store/cast-slice.ts`, `src/lib/api.ts` (`matchVoices`), `server/src/routes/voice-match.ts`, `src/modals/match-detail.tsx`
> URL surface: `#/books/:bookId/confirm`
> OpenAPI ops: `POST /api/books/:bookId/voice-match`

## What this covers

After stage-1 analysis finishes, the server scores each newly-extracted character against the user's existing voice library (cast files from prior books). Each match comes with a confidence score and a list of factors (e.g. "same gender", "matching tone", "shared archetype"). The user reviews suggestions in the confirm-cast view, sees details in a modal, and can decline matches one-by-one without losing the underlying character.

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

## Out of scope

- The factor-scoring algorithm itself — server-side.
- Cross-book voice cloning / sample re-rendering — covered by `22-voice-library.md` and the TTS plans.
- Bulk-accept-all UI — v1 is per-character review.
