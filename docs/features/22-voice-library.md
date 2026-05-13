# Voice library

> Status: stable
> Key files: `src/views/voices.tsx`, `src/store/voices-slice.ts` (`hydrate`, `setPinned`), `src/lib/api.ts` (`getVoices`, `setVoicePin`), `server/src/routes/voices.ts`
> URL surface: `#/voices`
> OpenAPI ops: `GET /api/voices`, `PUT /api/voices/:id/pin`

## What this covers

Cross-book view of every voice the user has confirmed. Indexed by current book (recent / pinned bubble to the top), sorted by usage frequency, filterable by engine. Supports pinning. Used both as a browsable surface and as a source for cross-book voice reuse during cast confirmation.

## Invariants to preserve

- `GET /api/voices?currentBookId=X&engine=Y` returns `{ voices: Voice[] }`; both query params are optional but, when present, narrow the result (`src/lib/api.ts:299-307`).
- `PUT /api/voices/:id/pin { pinned: boolean }` updates the pin state server-side; response is empty 2xx.
- `Voice.gradient` is `[string, string]` tuple (`src/lib/types.ts:37-39`) — explicit override of OpenAPI's `string[]` widening. Renderer assumes tuple shape.
- Voice record: `{ id, character, bookTitle, bookId, attributes, gradient, usedIn, source: 'current' | 'library', ttsVoice }`. `source: 'current'` means "this book"; `'library'` means "another book."
- Pinning is optimistic in the slice: dispatch `setPinned(id, true)` → UI updates immediately; PUT fires in background; on error, slice rolls back and shows a toast.
- The same voice may appear with both `source: 'current'` and `source: 'library'` if it's been used across books; the renderer must dedupe by `id`.
- The voices view groups cards by `bookId` — one `<section>` per book with a book-title header; the current-source book renders first, library books follow alphabetically by title. There is no per-card "Used in N book — bookTitle" footer and the bookTitle subtitle is hidden inside cards (it lives only in the section header). Cards remain self-contained — no nested-card chrome around individual voice cards.
- Inside each section, voices sort by line count descending — `Character.lines` from the analysis when available, otherwise a count of `state.manuscript.sentences` matched by `characterId`. Library-source voices that don't belong to the open book fall back to `usedIn` descending, then character name. Implementation: `src/views/voices.tsx` `linesByVoiceId` + `groups` `useMemo`.
- The inline pin (star) lives on the voice card itself, next to the character name + reuse pill (`src/components/voice-library-panel.tsx::VoiceCard` `onTogglePin` prop). The sidebar `VoiceLibraryPanel` (cast view) does **not** render the pin.

## Acceptance walkthrough

Run `VITE_USE_MOCKS=true`.

1. **Open `#/voices`** → list renders with pinned voices at the top, then by usage frequency. Each card shows the character name, source book, gradient, attributes.
2. **Toggle pin on a voice** → card moves to the pinned section instantly (optimistic); `PUT /api/voices/<id>/pin` fires in background; on success, no further UI change; on failure, card rolls back and a toast appears.
3. **Filter by engine = "gemini"** → list narrows to Gemini-engine voices only. Switch to "local" → narrows to local-engine voices.
4. **From a book context** (open `#/voices?currentBookId=<id>` via the cast view's "Browse library" CTA) → `source: 'current'` voices for that book bubble up.
5. **Click a voice card** → opens the profile drawer for the linked character (in the source book) — this requires loading that book; or alternatively opens a read-only preview drawer. Either UX is acceptable; document the chosen path.
6. **Real-mode regression** — switch to `VITE_USE_MOCKS=false`. Library populates from disk scan; pinning persists across reloads.

## Out of scope

- Voice creation from scratch (not in v1).
- Bulk pinning / bulk delete.
- Voice "remixing" (blend two voices into a new one).
