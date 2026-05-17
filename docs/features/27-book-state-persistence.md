# Book state persistence

> Status: stable
> Key files: `src/lib/api.ts` (`getBookState`, `putBookState`, `getWorkspaceChangelog`), `src/components/layout.tsx` (per-book hydrate effect), `server/src/routes/book-state.ts`, `server/src/routes/workspace.ts`, `src/lib/types.ts` (`BookStateResponse`, `PutStateRequest`, `ChangeLogEvent`)
> URL surface: indirect (any URL that lands on a `ready`/`confirm`/`analysing` stage); `#/log` for the workspace change log
> OpenAPI ops: `GET /api/books/:bookId/state`, `PUT /api/books/:bookId/state`, `GET /api/workspace/changelog`

## What this covers

When the app opens a previously-analysed book, it fetches `BookStateResponse` from disk-backed JSON (`.audiobook/state.json` + `cast.json` + `manuscript-edits.json`) and seeds the relevant slices. When the user edits cast or sentences, the app PUTs a per-slice patch. This keeps work persistent across reloads without needing a separate database.

## Invariants to preserve

- `BookStateResponse` shape (`src/lib/types.ts:116-127`): `{ state: BookStateJson; cast: { characters: Character[] } | null; manuscript: { wordCount, format } | null; manuscriptEdits: { sentences? } | null; revisions: { pending?, drift? } | null; completedSlugs: string[] }`. Any field can be null when the corresponding file isn't on disk.
- `BookStateJson` (`src/lib/types.ts:100-114`): `{ bookId, manuscriptId, title, author, series, seriesPosition, isStandalone, manuscriptFile, castConfirmed, chapters: { id, title, slug, duration? }[], coverGradient: [string, string], createdAt, updatedAt }`.
- `PutStateRequest` shape (`src/lib/types.ts:131-134`): `{ slice: 'cast' | 'manuscript' | 'revisions' | 'state' | 'changeLog'; patch: unknown }`. Only one slice per PUT; the `state` slice patch-merges editorial fields server-side; every other slice full-replaces the matching on-disk JSON file.
- `getBookState` returns `Promise<BookStateResponse | null>`. The real impl maps a 404 (book not in workspace) to `null`; other failures throw. The mock impl returns `null` for a never-`mockPutBookState`-d bookId and round-trips PUTs against the module-scoped `MOCK_BOOK_STATES` map (`src/lib/api.ts`). Per-slice write semantics match the real route — see `src/lib/api.mock-state.test.ts` for the pin. Callers (`layout.tsx`, `analysing.tsx`) short-circuit on null and leave the per-book slices on their in-memory defaults.
- Hydration effect runs in `App.tsx` whenever `stage.bookId` changes; failures log + fall back.
- `castConfirmed: boolean` is the authoritative flag for "user has confirmed cast"; `openBook` derives the routed view from book status, but the state flag is what survives to disk.
- Manuscript-edits round-trip: `setSentenceCharacter` / `setSentencesCharacter` / `splitSentence` → persistence-middleware fires PUT `slice='manuscript'` → server writes `manuscript-edits.json` atomically → on next book open, GET reads the file, the merge filter at `server/src/routes/book-state.ts:78-95` drops orphan ids whose value falls inside the analysis-cache id range, preserves ids > `maxCacheId` (split offspring), falls back to the raw cache only when no edits exist, and the slice's `hydrateFromBookState` overwrites `s.sentences` with the result. Pinned by `server/src/routes/book-state.hydrate.test.ts` (PUT→GET round-trip with and without cache) plus `book-state.reparse.test.ts` (GET-side reconcile cases).
- Revisions hydrate-then-poll: the per-book hydration effect in `src/components/layout.tsx` dispatches `revisionsActions.hydrateFromBookState(res.revisions ?? null)` synchronously after `getBookState` resolves, seeding `pending` / `drift` / `dismissed` / `acceptedSelections` from `revisions.json` BEFORE the 30 s `pollRevisions` interval starts. The poll is the in-session live-update path (server-side drift detection or backend-pushed regen results since the page opened); the GET hydrate is the cold-load path. Removing the hydrate dispatch from the per-book effect would reopen the brief empty-state flash window that used to render between mount and the first poll tick. Pinned by `src/components/layout.test.tsx`.

## Acceptance walkthrough

Run with `VITE_USE_MOCKS=false`, server on `:8080`, with at least one book under `books/<Author>/<Series>/<Title>/.audiobook/` on disk.

1. **Open a previously-analysed book** (`status: 'cast_pending'` or further) → `GET /api/books/<id>/state` fires; response carries `state`, `cast`, and `completedSlugs`. Cast slice hydrates.
2. **Open a book that's only `not_analysed`** → state file may be missing or minimal; response carries `state` only; cast/manuscript/revisions are null. UI shows the analysing flow.
3. **Confirm cast** → PUT `{ slice: 'cast', patch: { characters: [...] } }` fires; on-disk `cast.json` updates.
4. **Reload after confirm** → cast hydrates from disk; user lands in the same `ready` view.
5. **Reassign a sentence** (per `12-manuscript-view.md`) → PUT `{ slice: 'manuscript', patch: { sentences: [...] } }` fires. Reload the page: the reassignment survives. The merge filter only drops sentences whose id falls inside the analysis-cache id range without being present in it (orphans from a prior chapter shape); user-created split offspring with ids > `maxCacheId` round-trip intact.
6. **Mock-mode round-trip** — under `VITE_USE_MOCKS=true`, the persistence middleware still PUTs on curated actions; the mock api stores each patch in an in-memory map. A subsequent `getBookState(bookId)` returns the merged response. A cold boot for a never-touched bookId resolves to `null` and the per-book slices fall back to in-memory defaults. No crash, no infinite loop. Pinned by `src/lib/api.mock-state.test.ts`.

## Change-log invariants

- Per-book log lives at `<book-dir>/.audiobook/change-log.json` and is hydrated into `s.changeLog.events` on book open. The slice is the source of truth for the in-book Log tab.
- Workspace log (`#/log`) reads `s.changeLog.workspaceEvents`, populated by `GET /api/workspace/changelog` on every `ChangelogRoute` mount. The server fans out across every book, tags each event with `bookId`/`bookTitle`/`author`, and sorts newest-first.
- The following editorial actions MUST dispatch a change-log entry (and the persistence middleware MUST persist it):
  - `cast/setCharacters` for a tune (drawer's Save with `voiceState === 'tuned'`) → `voice_tune` via `buildVoiceTuneEvent`.
  - `cast/lockVoice` → `voice_lock` via `buildVoiceLockEvent`.
  - `ui/confirmCast` (paired in `ConfirmRoute.onConfirm`) → `cast_confirm` via `buildCastConfirmEvent`.
  - Each manuscript boundary edit (`setSentenceCharacter` / `setSentencesCharacter` / `splitSentence`) → `changeLog/bumpBoundaryMove({ chapterId, count })`. The reducer aggregates consecutive edits in the same chapter into a single entry at the list head so a drag gesture is one audit line, not dozens.
- **Reparse selective wipe**: `ConfirmRoute.onReanalyse` dispatches `changeLog/wipeBookShapeEvents` BEFORE `uiActions.reanalyse`. The wipe drops every event with a defined `chapterId` (regenerate, chapter_complete, chapter_failed, boundary_move). Cast/voice prefs (voice_tune, voice_lock, voice_reuse, cast_confirm) and historical markers (import, analysis_complete, library_add, generation_started) survive — those are either still accurate after a reparse or remain informative.
- Workspace endpoint MUST skip books that have no `.audiobook/change-log.json` rather than failing the whole response. A freshly imported book without any logged actions is normal state.

## Out of scope

- Conflict resolution if two clients write the same book simultaneously — single-user assumption.
- Versioning of the state.json schema — current is v1; future migrations TBD.
- Encryption of state.json — local-only, no encryption needed.
