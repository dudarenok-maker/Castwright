# Book state persistence

> Status: KNOWN: scaffolded (manuscript-edits hydration partial)
> Key files: `src/lib/api.ts` (`getBookState`, `putBookState`), `src/App.tsx` (hydrate effect), `server/src/routes/book-state.ts`, `src/lib/types.ts` (`BookStateResponse`, `PutStateRequest`)
> URL surface: indirect (any URL that lands on a `ready`/`confirm`/`analysing` stage)
> OpenAPI ops: `GET /api/books/:bookId/state`, `PUT /api/books/:bookId/state`

## What this covers

When the app opens a previously-analysed book, it fetches `BookStateResponse` from disk-backed JSON (`.audiobook/state.json` + `cast.json` + `manuscript-edits.json`) and seeds the relevant slices. When the user edits cast or sentences, the app PUTs a per-slice patch. This keeps work persistent across reloads without needing a separate database.

## Invariants to preserve

- `BookStateResponse` shape (`src/lib/types.ts:116-127`): `{ state: BookStateJson; cast: { characters: Character[] } | null; manuscript: { wordCount, format } | null; manuscriptEdits: { sentences? } | null; revisions: { pending?, drift? } | null; completedSlugs: string[] }`. Any field can be null when the corresponding file isn't on disk.
- `BookStateJson` (`src/lib/types.ts:100-114`): `{ bookId, manuscriptId, title, author, series, seriesPosition, isStandalone, manuscriptFile, castConfirmed, chapters: { id, title, slug, duration? }[], coverGradient: [string, string], createdAt, updatedAt }`.
- `PutStateRequest` shape (`src/lib/types.ts:131-134`): `{ slice: 'cast' | 'manuscript' | 'revisions' | 'state'; patch: unknown }`. Only one slice per PUT; server merges into the on-disk file for that slice.
- `mockGetBookState` throws "Book state hydration is not available in mock mode (no disk workspace)." (`src/lib/api.ts:147-152`). App.tsx must catch this and fall back to in-memory defaults; do not crash.
- Hydration effect runs in `App.tsx` whenever `stage.bookId` changes; failures log + fall back.
- `castConfirmed: boolean` is the authoritative flag for "user has confirmed cast"; `openBook` derives the routed view from book status, but the state flag is what survives to disk.

## Acceptance walkthrough

Run with `VITE_USE_MOCKS=false`, server on `:8080`, with at least one book under `books/<Author>/<Series>/<Title>/.audiobook/` on disk.

1. **Open a previously-analysed book** (`status: 'cast_pending'` or further) → `GET /api/books/<id>/state` fires; response carries `state`, `cast`, and `completedSlugs`. Cast slice hydrates.
2. **Open a book that's only `not_analysed`** → state file may be missing or minimal; response carries `state` only; cast/manuscript/revisions are null. UI shows the analysing flow.
3. **Confirm cast** → PUT `{ slice: 'cast', patch: { characters: [...] } }` fires; on-disk `cast.json` updates.
4. **Reload after confirm** → cast hydrates from disk; user lands in the same `ready` view.
5. **Reassign a sentence** (per `12-manuscript-view.md`) → PUT `{ slice: 'manuscript', patch: { sentences: [...] } }` fires. CURRENT BEHAVIOR: the file is written but hydration on reload is partial; do not assert end-to-end round-trip until the gap is closed.
6. **Mock-mode regression** — `getBookState` throws; App.tsx catches and falls back to in-memory defaults (cast from analyser output, no manuscript edits). No crash, no infinite loop.

## KNOWN: scaffolded

- `manuscriptEdits.sentences` is written by PUT but not fully hydrated by GET — sentence reassignments may reset to analyser output on reload. Document this gap; do not assert end-to-end persistence.
- `revisions` hydration on GET is also partial today; the polling mechanism (per `20-revisions-and-drift.md`) drives the slice in practice.

## Out of scope

- Conflict resolution if two clients write the same book simultaneously — single-user assumption.
- Versioning of the state.json schema — current is v1; future migrations TBD.
- Encryption of state.json — local-only, no encryption needed.
