# Cross-device "finished" sync + web auto-finish + reconcile fix — Design (v3)

**Status:** approved-in-principle; **revised twice after adversarial review** (see Revision log).
**Batch:** 2 of 2 (follow-up to PR #953 / `docs/features/app-14-continue-listening-finished.md`).
**Issue:** Refs #952 (cross-device + reconcile; per-chapter tick survival stays deferred on #952).

## Revision log
- **v2 (pass 1):** pivot from server-DERIVED finish-in-manifest (expensive + duration-unreliable) to EXPLICIT `finished` flags; add real refresh trigger; add web `listenedAt`.
- **v3 (pass 2):** two key realizations let the design get *leaner*:
  - **Phone→web already works** via existing resume-position sync + server-derived `isFinished` + the web rail's server-side exclusion — it only needs the **web to refetch the rail**. So the **web half is independently shippable (PR1)**; the companion half (PR2) is only for **web→phone**.
  - **Reverting the v2 web-`listenedAt` change:** activating the server's `>=` compare-and-set guard on web writes can DROP the authoritative web finish write. → finish is authoritative via **unguarded `POST /shelf-status`**; routine position saves stay last-write-wins.
  - Cut as YAGNI: the durable pending-shelf-status table (web self-heals `finished` via derived `isFinished`); the net-new lifecycle observer (library re-entry already pulls — fix shelf-rebuild ordering instead).
  - Fixed: web must detect the **final *listenable* chapter** (server semantics), not positional `!nextTrackAvailable`; un-finish gated on a **genuine replay signal**, never on `markPlayed`/open; web optimistic-dismiss gets its own **flicker guard**; manifest read placed in the **route** (pure builder stays I/O-free); legacy derived-finished books are **go-forward-only** (documented).

## Problem
After Batch 1, "finished leaves Continue listening" works per-device but not across, and the **web** never auto-finishes (manual ⋯ menu only — `continue-listening-rail.tsx`, `book-library.tsx:168-170`). Plus the companion reconcile compares ISO strings (`resume_reconcile.dart`).

## Verified grounding facts (checked in two review passes)
- **Server derives finish** (`server/src/workspace/listen-stats-aggregate.ts:42-69`): `isFinished` = explicit flag OR resume within final *listenable* chapter tail `max(30s,2%)` OR effectively-complete within 30s. `buildContinueListening:116` already excludes finished/hidden/≤5s/no-audio. `finalListenableChapter` **skips trailing non-listenable chapters** (`chapter-durations.ts:30-32`).
- **`POST /shelf-status`** sets/clears explicit `finished`(sticky)+`hidden`(resume-clearable); accepts `finished:false` (`book-state.ts:1452-1459`). It is **NOT** guarded by the `listenedAt` compare-and-set.
- **`PUT /listen-progress` guard:** when `listenedAt` is present, rejects if `existing.updatedAt >= listenedAt` (`book-state.ts:1395-1401`, `>=`). The web omits `listenedAt` today (`mini-player.tsx:248,409,458,933`; `listen.tsx:223`) → web writes are last-write-wins by receive time. The companion sends it (`resume_sync_service.dart:76`).
- **Manifest index is pure + state.json-only:** `buildSyncManifestIndex(rows)` (`sync-manifest.ts:105-130`) is I/O-free and gets `{bookId,state,coverUrl}`; the **route** `collectBooks()` (`library-sync-manifest.ts:102-111`) is where I/O belongs. `state.chapters[].duration` can be `'00:00'`; real durations live in `*.segments.json` (DETAIL path only). Helpers: `listenProgressJsonPath` (`paths.ts:187`), `readJson` (`state-io.ts:45`). `SYNC_MANIFEST_SCHEMA=1` (`sync-manifest.ts:23`).
- **Companion shelf is built LOCAL + pre-pull:** `library_home_screen._refresh()` (`apps/android/lib/src/ui/library_home_screen.dart:60-70`) computes the shelf from local `listBooks()` BEFORE `loadLibraryLocalFirst` streams; the stream only updates `_books`. `loadIndex()` (`sync_controller.dart:45-57`) persists meta via `upsertBookMeta` (title/author/series only). **No** `WidgetsBindingObserver`/`AppLifecycleState` anywhere in `apps/android/lib` (verified).
- **`markPlayed` runs on EVERY book open** (`player_screen.dart:93-94`) and already clears `hidden` (`drift_local_library.dart:295`). **`Books.finished` does NOT exist** (`finished` is a `Chapters` column, out of scope). Drift `schemaVersion=6`.
- **Companion knows real chapter durations locally** (`Chapters.durationSec`).

## Principle
Server is the store of truth. Cross-device finish is **explicit** (clients POST `finished:true` on reaching the end) so the cheap manifest carries it directly. The server's **derived** `isFinished` still powers the web rail server-side and, usefully, makes **phone→web self-heal** from the already-synced resume position.

---

## Delivery: TWO PRs (per pass-2 decomposition)

### PR 1 — Server manifest fields + Web auto-finish (independently shippable)
Delivers: the web auto-clears a finished book; **phone→web** propagation (web rail refetch + server-derived finish from the companion's already-synced position). The server fields are additive and unused until PR 2.

**A. Server (additive, no schema bump):**
- In the manifest-index **route** (`library-sync-manifest.ts` `collectBooks`/row assembly), read each book's `listen-progress.json` and thread `finished`(explicit)+`hidden` into the row tuple; the pure `buildSyncManifestIndex` maps them onto `SyncManifestIndexBook`. One small JSON read per book on the sync path — acceptable; both are single booleans (no duration math). `SYNC_MANIFEST_SCHEMA` stays 1 (additive/optional). Update OpenAPI + regenerate `src/lib/api-types.ts`.

**C. Web (`src/`):**
- **C-i — Explicit finish on end (authoritative):** when playback reaches the end of the **final *listenable* chapter**, `POST /shelf-status {finished:true}`. Detect "final listenable chapter" with **server-matching semantics** (filter excluded/no-audio trailing chapters — mirror `finalListenableChapter`), NOT positional `!nextTrackAvailable` (`layout.tsx:363` is positional over the full slice). The finish POST is unguarded → never dropped. (A best-effort final position `PUT` is optional and may be guard-rejected — do not rely on it; the POST is the signal.)
- **C-ii — Optimistic dismiss + flicker guard:** `MiniPlayer` gains `onCrossedFinish?: () => void` fired from `onTimeUpdate`/`onEnded` using live `audio.durationSec` against the tail; `Layout` gates on final-listenable-chapter and dispatches `continueListeningActions.dismiss(bookId)`. The dismissed id is **sticky** (kept dismissed in the `continueListening` slice) so a `C-iii` refetch landing before the server reflects the POST can't re-add it for one refetch cycle.
- **C-iii — Rail refetch on return to library** (`/api/library/continue-listening`): ensures phone-side finishes (server-derived from synced position) and the user's own finishes show. Add an explicit refetch on stage→`books` if `book-library` stays mounted.
- **Do NOT** add `listenedAt` to web `putListenProgress` (reverts v2 — would activate the `>=` guard and risk dropping web progress). Routine saves stay last-write-wins.
- e2e: a Playwright spec for auto-finish-removes-from-rail (router/redux/layout seam).

**PR-1 reconcile note:** B3 (companion reconcile) ships in PR 2 (companion-only).

### PR 2 — Companion pull/shelf + push + replay + reconcile (the web→phone half)

**B1 — Push (best-effort; mirror resume-sync reconnect flush; failures non-fatal):**
- Auto-finish (`bookCompletedStream` via `wireFinishedTracking`) → `POST /shelf-status {finished:true}`.
- Long-press remove → `POST /shelf-status {hidden:true}`.
- Genuine replay (see B2 replay trigger) → `POST /shelf-status {finished:false}`.
- Add `ApiClient.setShelfStatus(bookId,{finished?,hidden?})`. **No durable pending-set** (YAGNI): a dropped `finished:true` self-heals on the web via derived `isFinished` (the position is synced); a dropped `hidden`/`finished:false` is a documented minor (the LOCAL shelf is already correct; the user can redo a remove). Re-POST opportunistically on the next reconnect flush if cheap.

**B2 — Pull + shelf rewire + ordering fix:**
- Add `Books.finished` (Drift **schema 7** + `if (from<7) addColumn(books, books.finished)`; do NOT touch `Chapters.finished`).
- Extend `loadIndex()`/`upsertBookMeta` to persist manifest `finished`→`Books.finished`, `hidden`→`Books.hidden`.
- `ShelfBook` gains `finished` (default false); `buildContinueListening` excludes `hidden || finished`.
- **Fix shelf-rebuild ordering (C2):** `_refresh()` must rebuild the shelf from local rows **AFTER** the index pull persists (rebuild inside/after the `loadLibraryLocalFirst` stream, not from the pre-pull snapshot). This makes a re-entry into the library reflect server finished/hidden — the primary propagation path (no lifecycle observer needed for v1; document that web→phone shows on library (re)entry / reconnect / cold-start).
- **Reversibility:** `markPlayed` keeps clearing `hidden` (pre-existing un-hide-on-open). It must **NOT** clear `Books.finished` (that would drop a finished book off the shelf on a mere glance — pass-2 #6).
- **Replay trigger (un-finish):** clearing `Books.finished` + `POST finished:false` fires only on a **genuine replay** — the player's first real forward position advance after opening a finished book (or an explicit "Restart"), NOT on `markPlayed`/open. Until that POST confirms, suppress a pulled `finished:true` for that book (a transient in-memory un-finish guard) so the next pull can't flicker it back off.
- **Survives reinstall:** first post-reinstall sync pulls finished/hidden for all books.

**B3 — Reconcile fix:** `resume_reconcile.dart` compares `DateTime.parse(...).toUtc()` instants, not raw strings; companion stamps `listenedAt` as UTC ISO. Regression test with a tz-skewed pair. (Residual cross-clock skew vs web writes is pre-existing and minor — web writes are LWW by receive time; not addressed here.)

---

## Edge cases
- **Offline auto-finish (phone):** shelf correct immediately/offline via Batch-1 `markBookFinished` setting `Books.hidden` locally; `finished:true` POST is best-effort (web derives from synced position anyway).
- **Legacy/derived-finished books (pass-2 #5):** **go-forward-only.** A book finished-by-position before this ships, with no explicit flag, shows finished on the **web** (server derives) but NOT on the **phone** (manifest carries only the explicit flag) until re-finished. Accepted. (Optional future: a one-time server backfill that POSTs `finished:true` where `isFinished` derives true on the DETAIL path — a separate follow-up, not Batch 2.)
- **Glance vs replay (pass-2 #6):** opening to look does not un-finish (un-finish is gated on genuine forward playback / explicit restart).
- **Web flicker (pass-2 #4):** sticky optimistic dismiss for one refetch cycle (C-ii).

## Testing
- **PR 1 — Server:** manifest route reads `listen-progress.json`, index includes explicit `finished`+`hidden`; OpenAPI/`api-types` regenerated; existing manifest tests green. **Web:** final-listenable-chapter detection (incl. a book with a trailing excluded chapter); `onEnded`→POST finished:true; optimistic dismiss + sticky guard (no flicker on refetch); rail refetch; e2e auto-finish-removes-from-rail.
- **PR 2 — Companion:** `setShelfStatus` posts on auto-finish/remove/replay; pull persists manifest finished/hidden → Drift; `_refresh` rebuilds shelf post-pull (re-entry reflects server state); `buildContinueListening` excludes `finished||hidden`; `Books.finished` schema-7 migration; `markPlayed` does NOT clear finished; replay-trigger un-finish + suppress-guard prevents flicker; reconcile tz-skew regression.

## Out of scope (#952)
Per-chapter tick survival across reinstall (needs new server per-chapter storage). Do NOT touch the pre-existing `Chapters.finished`-missing-`onUpgrade` latent gap (couples scope).
