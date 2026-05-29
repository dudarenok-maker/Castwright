---
status: stable
shipped: 2026-05-13
owner: null
---

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
- **Cast-non-empty leg on the hydrate short-circuit.** `src/components/layout.tsx`'s per-book hydration effect short-circuits when the manuscript slice already reflects this book (`manuscript.bookId === bookId && manuscript.manuscriptId && manuscript.title`). For the **confirm** and **ready** stages, that check ALSO requires `cast.characters.length > 0` before skipping the disk re-fetch — anything else lets cast=[] survive into the confirm view as "0 speaking characters detected." This closes the race where `castActions.hydrateFromAnalysis` no-ops (its `if (characters?.length)` guard in `src/store/cast-slice.ts:43`) but `manuscriptActions.hydrateFromAnalysis` stamps `bookId` regardless (`src/store/manuscript-slice.ts:81`), leaving manuscript hydrated but cast empty after the SSE `result` event lands without characters or after a Phase 0 cache resume skips the streamed `cast-update` merge path. Analysing stage deliberately skips the cast-non-empty check: it legitimately starts with cast=[] and grows it via streamed Phase 0a events, so demanding cast there would re-fetch mid-stream and clobber the live roster. Pinned by `src/components/layout.test.tsx` (test "re-fetches getBookState when entering /confirm with manuscript hydrated but cast empty").

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
- **Every `matchedFrom`/alias-stamping cast action is a curated persist action** (`PERSIST_RULES` in `src/store/persistence-middleware.ts`). Auto-reuse (`cast/applyVoiceMatches`) AND manual continuity link (`cast/applyManualMatch`) both persist the full `cast.characters`, so a *forced* reuse lands the SAME durable `matchedFrom`/`voiceId` as an auto-match — otherwise a manual link's `matchedFrom` lived only in redux (the `link-prior` endpoint writes the prior book's alias + the source's `voiceId`, but not the source's `matchedFrom`) and reverted on reload, silently breaking the Reused badge + the merge-picker "already linked" suppression (both keyed on `matchedFrom`). `cast/applyAddAlias` is curated for the same reason: the alias add re-asserts the full latest redux cast as the authoritative last write, so it can't be clobbered by a concurrent dedicated-endpoint write or a debounced cast PUT from an earlier edit (the intermittent "also-known-as / rename didn't save" race).
- The following editorial actions MUST dispatch a change-log entry (and the persistence middleware MUST persist it):
  - `cast/setCharacters` for a tune (drawer's Save with `voiceState === 'tuned'`) → `voice_tune` via `buildVoiceTuneEvent`.
  - `cast/lockVoice` → `voice_lock` via `buildVoiceLockEvent`.
  - `ui/confirmCast` (paired in `ConfirmRoute.onConfirm`) → `cast_confirm` via `buildCastConfirmEvent`.
  - Each manuscript boundary edit (`setSentenceCharacter` / `setSentencesCharacter` / `splitSentence`) → `changeLog/bumpBoundaryMove({ chapterId, count })`. The reducer aggregates consecutive edits in the same chapter into a single entry at the list head so a drag gesture is one audit line, not dozens.
- **Reparse selective wipe**: `ConfirmRoute.onReanalyse` dispatches `changeLog/wipeBookShapeEvents` BEFORE `uiActions.reanalyse`. The wipe drops every event with a defined `chapterId` (regenerate, chapter_complete, chapter_failed, boundary_move). Cast/voice prefs (voice_tune, voice_lock, voice_reuse, cast_confirm) and historical markers (import, analysis_complete, library_add, generation_started) survive — those are either still accurate after a reparse or remain informative.
- Workspace endpoint MUST skip books that have no `.audiobook/change-log.json` rather than failing the whole response. A freshly imported book without any logged actions is normal state.

## Schema versioning + migration seam

State.json is versioned via a top-level `schema: number` field stamped by `stampStateSchema` (in `server/src/workspace/state-migrate.ts`) on every write. `CURRENT_STATE_SCHEMA = 1` today. The reader-side `migrateStateJson(raw)` runs every parsed doc through a single seam that knows how to:

- Treat a missing `schema` field as v1 (back-compat for every state.json written before the seam landed — those files load unchanged).
- Pass v1 docs through as a no-op.
- Reject `schema > CURRENT_STATE_SCHEMA` with `UnsupportedStateSchemaError`, refusing to interpret a future-version file the current server doesn't fully understand. (Silently reading would risk dropping fields a newer client wrote when the user next edits the book.)
- Route older versions through a transform branch (today no path exists because field-absent already covers the only pre-v1 case).

**Rename-vs-add policy.** Decide whether your change bumps the schema:

- **Adding an OPTIONAL field is backwards-compatible.** No schema bump. The old reader ignores the new field; the new writer keeps writing it. This is the common case (e.g. `narratorCredit`, `coverImage`, `audioModelKey` all landed without a bump).
- **Renaming a field, removing a field still read by older clients, or changing a field's semantics (units, encoding, type widening)** breaks readers. Bump `CURRENT_STATE_SCHEMA` and add a migration branch in `migrateStateJson`.

**Writer call sites** (all routed through `writeStateJsonAtomic` in `server/src/workspace/state-migrate.ts`, which stamps schema AND opts into the rotating-backup write path): `server/src/routes/book-state.ts` (title refresh, PUT slice=state with/without rename, reparse, exclude-chapter), `server/src/routes/import.ts` (initial book creation), `server/src/routes/analysis.ts` (main + subset analysis result writes), `server/src/routes/generation.ts` (post-render duration + audioModelKey stamp), `server/src/workspace/scan.ts` (lazy audio-model backfill), `server/src/cover/openlibrary.ts` (cover patch / clear). Adding a new writer? Route it through `writeStateJsonAtomic`.

**Reader-side migration**: today the readers throughout `server/src/` still use raw `readJson<BookStateJson>(...)` because the `schema?: number` field is optional in the type and v1-stamped files pass through unchanged. When `CURRENT_STATE_SCHEMA` bumps to 2, route the canonical reader (`findBookByBookId` in `scan.ts`) through `migrateStateJson(raw)` so every other caller picks up the migration for free.

## Rotating state.json backups

Every `writeStateJsonAtomic` call now rotates the prior `state.json` into `state.json.bak.1`, shifts existing `.bak.N` slots up by one, and drops anything past `.bak.STATE_BACKUP_KEEP` (default 3). Cheap insurance against a torn write, a schema-migration bug, or an OneDrive race that survives the rename-retry — the canonical chokepoint (`findBookBy` in `scan.ts`) goes through `readStateJsonWithRecovery`, which falls back to the next-newest backup on a JSON-parse failure and logs a single `[state-io]` warning naming which backup recovered. Other `.audiobook/*.json` writers (cast.json, manuscript-edits.json, revisions.json, change-log.json) stay on the bare `writeJsonAtomic` shape — they're cheap to re-derive and not worth the disk multiplier.

The rotation is self-healing across partial failures (e.g. EPERM mid-chain): each rename uses `renameWithRetry` and skips already-shifted slots via `existsSync` gates on the next attempt, so a half-rotated chain converges to consistency on the next write. Pinned by `server/src/workspace/state-io.test.ts` ("writeJsonAtomic with rotating backups" + "readJsonWithRecovery").

Pinned by `server/src/workspace/state-migrate.test.ts` (the unit specs) + the round-trip case in `server/src/routes/book-state.test.ts` ("PUT slice=state stamps schema=1 on the on-disk file").

## Out of scope

- Conflict resolution if two clients write the same book simultaneously — single-user assumption.
- `.audiobook/analysis-state.json` schema versioning — separate file, ephemeral persistence (deleted on terminal success), not yet versioned. If that ever needs migration, file a new backlog item.
- Encryption of state.json — local-only, no encryption needed.
