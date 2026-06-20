# Cross-device "finished" sync + web auto-finish + reconcile fix — Design

**Status:** approved-in-principle (brainstorming, 2026-06-20); **revised after adversarial review** (see Revision log).
**Batch:** 2 of 2 (follow-up to the on-device companion work shipped in PR #953 / `docs/features/app-14-continue-listening-finished.md`).
**Issue:** Refs #952 (delivers the cross-device + reconcile parts; per-chapter tick survival stays deferred on #952).

## Revision log
Adversarial review (2026-06-20) found three load-bearing assumptions wrong; this revision incorporates the fixes:
- **C1:** the sync-manifest index reads only `state.json` and chapter durations there are often stale (`'00:00'`); deriving `isFinished` in the index is neither cheap nor reliable. → The manifest now carries the **cheap explicit `finished` + `hidden` flags** (from `listen-progress.json`), NOT the derived value. Cross-device finish is made **explicit on both clients**.
- **C2:** there is no online sync poll (reconnect/cold-start only). → Add a **foreground-resume pull trigger**, rewire the companion shelf to consult pulled server state, and state propagation latency honestly.
- **C3:** the web never sends `listenedAt`, so the reconcile compares two clocks. → The **web now sends `listenedAt`** on every `putListenProgress`.
- I1/I2/I3/M1–M3 folded in (mini-player callback seam; web end-of-book explicit finish; replay-flicker guard; schema notes).

## Problem

After Batch 1, "finished book leaves Continue listening" works **per device** but not **across** devices, and the **web** has the same auto-finish gap the companion had:

1. A book finished on the **phone** does not leave the **web** rail, and vice-versa.
2. The **web** never auto-clears a finished book — finishing is **manual only** (`src/components/library/continue-listening-rail.tsx`; `src/views/book-library.tsx:168-170`). No auto-finish on reaching the end exists in `src/`.
3. The companion's resume reconcile (`apps/android/lib/src/domain/resume_reconcile.dart`) compares `listenedAt` vs `updatedAt` as **raw ISO strings** — naive-local vs UTC can mis-order and drop a push.

## Verified grounding facts (checked against code in the adversarial review)

- **Server `isFinished`** (`server/src/workspace/listen-stats-aggregate.ts:53-69`): true on explicit `finished`, OR resume within the final listenable chapter's tail `max(30s, 2% of final)`, OR effectively-complete within 30s. `buildContinueListening` (`:116`) already excludes finished/hidden/≤5s/no-audio; `buildLibraryStats` counts `isFinished`.
- **`POST /shelf-status` accepts `finished:false`** and clears `finished`+`finishedAt` (`server/src/routes/book-state.ts:1452-1459`). Sticky `finished` is only cleared this way; derived `isFinished` clears when resume leaves the tail.
- **The sync-manifest index builds purely from `state.json`** (`server/src/routes/library-sync-manifest.ts:102-111`, `sync-manifest.ts:105-130`) — it does NOT read `listen-progress.json`, and `state.chapters[].duration` can be `'00:00'` (real PCM durations live in `*.segments.json`, read only on the DETAIL path). So deriving `isFinished` in the index is neither free nor reliable.
- **Companion auto-sync is reconnect-only**: `companion_runtime.dart:210-211` (`onConnectivityChanged → maybeSync`); `auto_sync_service.dart:32-60` runs only on a network transition. No periodic/online poll. The library screen refreshes on `initState`/return-from-player, but the **shelf is built from LOCAL `lastPlayedAt`/`hidden`** (`library_home_screen.dart:60-70`) and never consults freshly-pulled server state today.
- **Companion knows real chapter durations locally** (`Chapters.durationSec`) and already sends `listenedAt` on resume push (`resume_sync_service.dart:76`). **The web sends NO `listenedAt`** on any `putListenProgress` (`mini-player.tsx:248,409,458,933`; `listen.tsx:223`) → web records get server-receive-time `updatedAt`.
- **`Books.finished` does NOT exist**; the existing `finished` column is on **`Chapters`** (`library_database.dart:75`, per-chapter tick, out of scope). Drift `schemaVersion = 6`, chain ends at `if (from < 6) addColumn(books, books.hidden)`.
- The web fetches the rail **once on library mount** (`book-library.tsx:125`, dep `[dispatch]`).

## Principle

Server stays the **store of truth** for finished/hidden. But cross-device "finished" is made **explicit**: whichever client reaches the end POSTs `finished:true`, so propagation does not depend on the server re-deriving from position on the manifest hot path (which is expensive + duration-unreliable per C1). The server's *derived* `isFinished` still powers the **web's own rail** server-side (where `buildContinueListening`/`assembleBookInputs` load full data) and the stats count.

## Design

### Part A — Server (additive, cheap)

Add two fields per book to the sync-manifest **index** entry (`SyncManifestIndexBook` + the index builder in `server/src/routes/library-sync-manifest.ts`):
- `finished: boolean` — the **explicit** `finished` flag from `listen-progress.json` (NOT derived `isFinished`).
- `hidden: boolean` — the `hidden` flag from `listen-progress.json`.

This requires the index builder to read each book's `listen-progress.json` (one small JSON per book — acceptable on the sync path; both flags are single booleans, no duration math). Update the OpenAPI manifest-index schema with the two optional booleans; regenerate `src/lib/api-types.ts`. (No new endpoints — `POST /shelf-status` already sets both flags.)

### Part B — Companion (`apps/android`)

**B1 — Push (best-effort, offline-safe; mirror resume-sync: event-driven + reconnect flush, failures non-fatal):**
- Auto-finish (Batch 1's `bookCompletedStream` via `wireFinishedTracking`) → `POST /shelf-status {finished:true}`.
- Long-press remove → `POST /shelf-status {hidden:true}`.
- Replay start (genuine reopen of a finished book) → `POST /shelf-status {finished:false}` (symmetric un-finish across devices).
- Add `ApiClient.setShelfStatus(bookId, {finished?, hidden?})`. Dropped POSTs: a lost `finished:true` self-heals only if re-finished (no longer derived); a lost `hidden`/`finished:false` does not self-heal — keep a small Drift "pending shelf-status" set flushed on the next sync so removes/un-finishes are durable.

**B2 — Pull + shelf rewire (drives the local shelf from server truth):**
- Add `Books.finished` (Drift **schema 7** + `if (from < 7) addColumn(books, books.finished)`). Do NOT touch `Chapters.finished` (pre-existing, different column).
- During auto-sync's index load, persist manifest `finished`→`Books.finished`, `hidden`→`Books.hidden`.
- **Rewire the shelf builder** (`library_home_screen.dart:60-70` → `home_shelf.dart`): `ShelfBook` gains `finished` (default false); `buildContinueListening` excludes `hidden || finished`. (Today it consults only local `lastPlayedAt`/`hidden` — this is the load-bearing change that makes pulled state visible.)
- **Refresh trigger (C2):** pull the index on **app foreground-resume** (Flutter `AppLifecycleState.resumed`) in addition to reconnect, so a book finished on web leaves the phone shelf without needing a connectivity flap. State the latency honestly in docs: propagation happens on reconnect, cold-start, or foreground-resume — not while the phone sits continuously foregrounded with no lifecycle event.
- **Reversibility + flicker guard (I3):** `markPlayed` (already runs on every book open, `player_screen.dart:94`) clears local `Books.hidden` **and `Books.finished`**. On replay, the companion sets a local "pending un-finish" marker for that book that **suppresses a pulled `finished:true`** until the `{finished:false}` POST is confirmed — so the next sync can't flicker the just-resumed book back off the shelf.
- **Survives reinstall:** first post-reinstall sync pulls finished/hidden for all downloaded books → shelf correct.

**B3 — Reconcile fix:**
- `resume_reconcile.dart`: compare `DateTime.parse(...).toUtc()` instants, not raw strings. Companion stamps `listenedAt` as UTC ISO.
- Paired with Part C's web `listenedAt` change so BOTH clients drive `updatedAt` from client time and the server's srv-34 compare-and-set guard (`book-state.ts:1378-1402`) applies uniformly. Regression test: a tz-skewed local/remote pair the old string compare ordered wrong.

### Part C — Web (`src/`)

- **C-i — End-of-book explicit finish (authoritative; resolves I2):** on `onEnded` of the **last listenable chapter** (and/or when the player crosses the finish tail on the last chapter), write a final `putListenProgress(currentSec ≈ duration)` **and** `POST /shelf-status {finished:true}`. Without this the web's bookmark often sits short of the tail (the 5s-throttled save + `if (t<=5) return` + `onEnded` issuing no PUT — `mini-player.tsx:929-996`), so neither the web rail nor the phone pull ever sees it finished.
- **C-ii — Optimistic dismiss (I1):** add an `onCrossedFinish?: () => void` callback to `MiniPlayer`, fired from `onTimeUpdate`/`onEnded` using the live `audio.durationSec` to detect the tail; `Layout` (which has `chapters`/`trackIdx`/`nextTrackAvailable`, `layout.tsx:359-363`) gates on `!nextTrackAvailable` (last chapter) and dispatches `continueListeningActions.dismiss(bookId)` for instant UI feedback. Cross-router/redux seam → add a Playwright e2e per the project bar.
- **C-iii — Rail refresh:** ensure `/api/library/continue-listening` is refetched on return to the library (mount effect already does if the view remounts; if a layout keeps `book-library` mounted, add an explicit refetch on stage→`books`).
- **C-iv — Send `listenedAt` (C3):** every `putListenProgress` call in `mini-player.tsx`/`listen.tsx` sends `listenedAt: new Date().toISOString()` so web writes carry client time and the server guard applies uniformly.

## Data flow

- **Finish on phone:** companion `POST finished:true` → server `listen-progress.finished` → manifest → web rail (server already excludes explicit finished) on refetch; phone shelf excludes locally via Batch-1 `markBookFinished` setting `Books.hidden` (offline-immediate) and `Books.finished` on next pull.
- **Finish on web:** web `POST finished:true` (C-i) → server → manifest → companion pull (reconnect/cold-start/foreground) sets `Books.finished` → phone shelf excludes; web rail excludes immediately (optimistic) + on refetch (authoritative).
- **Manual remove on phone:** `POST hidden:true` → web rail excludes; phone excludes locally.
- **Replay:** `markPlayed` clears local finished/hidden + pending-un-finish guard; `POST finished:false` → returns to both shelves; guard prevents flicker.
- **Reinstall phone:** first sync pulls finished/hidden for all books → shelf correct.

## Edge cases

- **Offline auto-finish (M3):** phone shelf is correct **immediately, offline** — Batch 1's `markBookFinished` sets `Books.hidden=true` locally, which the shelf already excludes. The new `Books.finished`-from-pull does not regress this; the `finished:true` POST queues for the next sync (for the web's + stats' benefit).
- **Replay flicker (I3):** handled by the pending-un-finish guard + `markPlayed` clearing `Books.finished` (above).
- **Dropped pushes:** `finished:true` re-derivable only by re-finishing; `hidden`/`finished:false` durable via the pending shelf-status set (B1).
- **Clock skew (C3):** narrowed to genuine device-vs-device skew once both clients send client `listenedAt`; the server guard then orders by a single clock semantic.

## Testing

- **Server:** manifest index includes explicit `finished` + `hidden` per book (reads `listen-progress.json`); OpenAPI/`api-types` regenerated; existing manifest tests green.
- **Companion:** `setShelfStatus` posts on auto-finish/remove/replay; pending shelf-status flush on reconnect; pull stores manifest finished/hidden → Drift; `buildContinueListening` excludes `finished||hidden`; `Books.finished` schema-7 migration; foreground-resume triggers pull; replay clears local finished + guard prevents flicker; reconcile tz-skew regression.
- **Web:** end-of-last-chapter writes final position + POSTs finished:true; optimistic dismiss via `onCrossedFinish` + Layout gating (e2e); rail refetch drops a finished book; `listenedAt` sent on putListenProgress.

## Out of scope (stays on #952)

Per-chapter completion-tick survival across a companion reinstall — needs NEW server-side per-chapter `finished` storage. Do NOT touch the pre-existing `Chapters.finished`-has-no-`onUpgrade`-addColumn latent gap (M1) — flagged, not Batch 2's to fix (couples scope).

## Decomposition

One cohesive feature (consistent finished state) across server + companion + web. One implementation plan, sequenced by layer so each is independently testable: **server manifest fields → companion pull+shelf-rewire → companion push+replay-guard → companion reconcile → web (finish-on-end, listenedAt, optimistic dismiss, rail refresh).**
