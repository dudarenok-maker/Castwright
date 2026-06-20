# Cross-device "finished" sync + web auto-finish + reconcile fix — Design

**Status:** approved (brainstorming, 2026-06-20)
**Batch:** 2 of 2 (follow-up to the on-device companion work shipped in PR #953 / `docs/features/app-14-continue-listening-finished.md`).
**Issue:** Refs #952 (this delivers the cross-device + reconcile parts; per-chapter tick survival stays deferred on #952).

## Problem

After Batch 1, "finished book leaves Continue listening" works **on each device in isolation** but not **across** them, and the **web** has the same auto-finish gap the companion had:

1. A book finished on the **phone** does not leave the **web** Continue-listening rail promptly, and vice-versa.
2. The **web** never auto-clears a finished book from its rail — finishing is **manual only** (the ⋯ menu "Mark as finished" / "Hide from shelf" in `src/components/library/continue-listening-rail.tsx`; `src/views/book-library.tsx:168-170`). There is no auto-finish on reaching the end anywhere in `src/`.
3. The companion's resume-position reconcile (`apps/android/lib/src/domain/resume_reconcile.dart`) compares `listenedAt` vs `updatedAt` as **raw ISO strings** — a naive-local vs UTC pair can mis-order and silently drop a resume-position push.

## Key existing-behavior facts (grounding)

- The server is **already** the source of truth for "finished". `server/src/workspace/listen-stats-aggregate.ts`:
  - `isFinished(chapters, resume, explicitFinished)` returns true when the explicit `finished` flag is set, OR the resume bookmark sits within the last listenable chapter's tail (`max(30s, 2% of final chapter)`), OR the book is effectively complete (within `FINISH_TAIL_SEC = 30s` of the whole book's listenable end).
  - `buildContinueListening(...)` **already excludes** finished (explicit or derived), hidden, ≤5s, and no-audio books, sorted by `updatedAt` desc.
  - `buildLibraryStats(...)` counts `isFinished` books in `booksFinished` — so a *derived*-finished book already counts in stats; no explicit flag is needed for the count.
- Both clients **already sync resume position** (`PUT /api/books/{id}/listen-progress`). So the server can already derive "finished" from a synced end-position.
- `POST /api/books/{id}/shelf-status` already exists and sets sticky `finished` / resume-clearable `hidden`.
- The web fetches the rail **once on library mount** (`src/views/book-library.tsx:125`, dep `[dispatch]`) and refetches only on the dismiss-error path.
- The companion already consumes a per-book manifest index via `SyncController.loadIndex()` → `List<SyncManifestIndexBook>` (`apps/android/lib/src/data/sync_controller.dart:45`) during auto-sync (`auto_sync_service.dart`).
- `finished` semantics: **sticky** (user "finished it"; counts in stats; does NOT clear on resume). `hidden` semantics: **resume-clearable** (user "hide"; cleared on next resume; does NOT count in stats). Batch 1's companion `Books.hidden` mirrors the resume-clearable one (cleared by `markPlayed`).

## Principle

Keep the **server authoritative** for "finished". Make both clients **agree** with the server's `isFinished`/`hidden`, rather than each maintaining an independent notion. Minimal new surface: no new endpoints; one additive manifest field-set; a few client wirings.

## Design

### Part A — Server (additive)

Add two fields per book to the sync-manifest **index** entry (`SyncManifestIndexBook` and the index builder in `server/src/routes/library-sync-manifest.ts`):

- `finished: boolean` — the result of `isFinished(chapters, resume, explicitFinished)` for that book (covers BOTH explicit `finished` and derived-from-position).
- `hidden: boolean` — the raw `hidden` flag from `listen-progress.json`.

One sync-manifest index call then reports the finished/hidden state of every book. No other server change (the `POST /shelf-status` setter and the `isFinished` derivation already exist). The OpenAPI contract for the manifest index gains these two optional booleans; regenerate `src/lib/api-types.ts`.

### Part B — Companion (`apps/android`)

**B1 — Push (best-effort, offline-safe).** Mirror the existing resume-sync pattern (event-driven + flush on reconnect; failures are non-fatal and retried on the next sync):
- On auto-finish (Batch 1's `PlayerController.bookCompletedStream`, already wired through `wireFinishedTracking`): also `POST /shelf-status {finished: true}`. Explicit + sticky + reliably counted in stats — more robust than relying on the resume position landing inside the server tail.
- On long-press remove (`library_home_screen.dart` `_confirmRemoveFromShelf`): also `POST /shelf-status {hidden: true}`.
- Add an `ApiClient.setShelfStatus(bookId, {finished?, hidden?})` method. Offline: queue/skip and let the next auto-sync flush (a simple "pending shelf-status" set in Drift, flushed in `auto_sync_service`/`companion_runtime` like resume-sync — OR piggy-back the existing reconnect flush). Keep it minimal: best-effort POST now, and re-derive correctness from the pull on the next sync (so a dropped POST self-heals).

**B2 — Pull (drives the local shelf from server truth).** During auto-sync's index load, read each book's manifest `finished`/`hidden` and persist into Drift:
- Add `Books.finished` (Drift schema 7 + `addColumn` migration) alongside the existing `Books.hidden`.
- Store manifest `finished` → `Books.finished`, manifest `hidden` → `Books.hidden`.
- `buildContinueListening` shelf filter excludes `hidden || finished` (extend `ShelfBook` with `finished`, default false; `library_home_screen.dart` passes it through; `home_shelf.dart` filter).
- Reversibility preserved: `markPlayed` clears local `hidden` for instant return-to-shelf; the next sync re-pulls authoritative state. (A genuinely-finished book the user replays: `markPlayed` also should clear the local `finished` optimistically so it returns to the shelf, and the server clears it on the resumed position moving away from the tail / explicit unfinish — see Edge cases.)
- **Survives reinstall:** first post-reinstall sync re-pulls finished/hidden for every downloaded book → shelf correct with zero local history.

**B3 — Reconcile fix.** In `resume_reconcile.dart`, compare `DateTime.parse(localListenedAt)` vs `DateTime.parse(remoteUpdatedAt)` as instants (`.compareTo` on parsed `DateTime`, both normalized to UTC) instead of raw string compare. Ensure the companion emits UTC ISO (`toUtc().toIso8601String()`) wherever it stamps `listenedAt`. Add a regression test with a tz-skewed local/remote pair that the old string compare ordered wrong.

### Part C — Web (`src/`)

Make a finished book leave the rail without a manual action — the rail already excludes finished books server-side, so this is about **reflecting** that promptly:
- **Optimistic:** when the mini-player crosses the finish threshold for the **last** chapter (mirror the server tail), dispatch the existing `continueListeningActions.dismiss(bookId)` for instant feedback.
- **Authoritative:** ensure `/api/library/continue-listening` is re-fetched when the user returns to the library so the rail reflects server truth (the mount effect already refetches if the view remounts; if a layout keeps `book-library` mounted, add an explicit refetch trigger on stage→`books`).
- During implementation, confirm the precise root cause of the user's "finished, still shows" report: (i) rail staleness (view stays mounted, never refetched), or (ii) the end-of-book resume position isn't written far enough into the tail for the server to derive `isFinished`. Fix whichever applies (both are small; (ii) = ensure a final `PUT /listen-progress` at/near the chapter's natural end).

No new web server endpoint.

## Data flow

- **Finish on phone:** companion `POST finished:true` (and resume synced) → server → web rail (on refetch) excludes; phone shelf excludes locally immediately (B2 sets `Books.finished` on next sync; the push is for the *web's* benefit + stats).
- **Finish on web:** resume reaches the tail (+ optional explicit finished) → server `isFinished` true → companion pull on next sync sets `Books.finished` → phone shelf excludes.
- **Manual remove on phone:** `POST hidden:true` → server → web rail excludes; phone excludes locally.
- **Reinstall phone:** first sync pulls finished/hidden for all books → shelf correct.

## Edge cases

- **Replay a finished book:** opening it runs `markPlayed` (clears local `hidden`) — also clear local `Books.finished` optimistically so it returns to the phone shelf at once. On the server, resuming writes a new resume position; once it moves out of the tail the derived `isFinished` goes false. If the book had an *explicit* sticky `finished` flag, resuming does NOT auto-clear it server-side (sticky) — so consider having the companion `POST shelf-status {finished:false}` on a genuine replay-start, OR accept that an explicitly-finished book stays off the web rail until re-finished. **Decision: on replay start, companion POSTs `{finished:false}`** so replay is symmetric across devices (re-arms Batch 1's `_bookFinishEmitted` already handles the local re-finish).
- **Offline push dropped:** the pull on the next sync re-derives correct state, so a lost `POST shelf-status` self-heals for `finished` (derived from resume position). A lost `hidden` POST is the one case that won't self-heal from derivation — acceptable (user can remove again), or flush from a small pending-set.
- **Clock skew (reconcile):** addressed by B3 (parse instants, emit UTC).

## Testing

- **Server:** sync-manifest index includes `finished` (= `isFinished`) and `hidden` per book; OpenAPI/`api-types` regenerated; existing manifest tests stay green.
- **Companion:** `setShelfStatus` posts on auto-finish (`finished:true`) and on long-press remove (`hidden:true`); offline → no crash, self-heals on next sync; pull stores manifest finished/hidden into Drift; `buildContinueListening` excludes `finished || hidden`; `Books.finished` schema-7 migration; replay clears local finished + POSTs `finished:false`; reconcile tz-skew regression test.
- **Web:** optimistic dismiss when the player crosses the finish threshold on the last chapter; rail refetch on return-to-library drops a server-finished book; the targeted root-cause fix has a paired test.

## Out of scope (stays on #952)

Per-chapter completion-tick survival across a companion reinstall — requires NEW server-side per-chapter `finished` storage (the server tracks only book-level finished/hidden today). Lower value than book-level shelf consistency; revisit separately.

## Decomposition note

Spans server + companion + web but is one cohesive feature (consistent finished state). One spec → one implementation plan, executed as grouped tasks by sub-area (server first → companion push/pull → web → reconcile), so each layer is independently testable.
