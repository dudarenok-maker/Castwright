# Finished-sync PR 2 — Companion pull/shelf + push + replay + reconcile — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The Android companion makes its Continue-listening shelf agree with the server's finished/hidden state (web→phone), pushes its own finishes/removes to the server, un-finishes correctly on genuine replay, and fixes the `listenedAt` reconcile.

**Architecture:** PR 1 added explicit `finished`/`hidden` to the sync-manifest index. PR 2: the companion PULLS those into Drift (`Books.finished` + existing `Books.hidden`) on index load and excludes `finished || hidden` from the local shelf; it PUSHES `POST /shelf-status` on auto-finish (`finished:true`), long-press remove (`hidden:true`), and genuine replay (`finished:false`); it fixes `markPlayed` to NOT clear finished and gates un-finish on an unambiguous replay signal; and it fixes the reconcile to compare parsed UTC instants.

**Tech Stack:** Flutter / Dart, Drift (SQLite) + build_runner, `flutter_test`.

**Spec:** `docs/superpowers/specs/2026-06-20-cross-device-finished-sync-design.md` (v3.1, "PR 2" section). **Depends on PR 1** (manifest fields) being merged to `main` first.

## Global Constraints

- Branch: cut `feat/app-finished-sync-pull` off `main` AFTER PR 1 merges (so `SyncManifestIndexBook` carries `finished`/`hidden` from the server). Android companion only (`apps/android/**`).
- Finish/hide is signalled to the server via the existing `POST /api/books/{bookId}/shelf-status` (unguarded). Pushes are best-effort + offline-tolerant; failures are non-fatal (a dropped `finished:true` self-heals on the web via server-derived `isFinished` from the synced position). NO durable pending-set (YAGNI).
- `markPlayed` must keep clearing `hidden` (pre-existing un-hide-on-open) but must NOT clear `Books.finished` (else a glance drops a finished book off the shelf).
- Un-finish (clear `Books.finished` + `POST finished:false`) fires ONLY on a **genuine backward navigation**: `_loadIndex(newIndex)` where a prior chapter was loaded (`_index >= 0`) AND `newIndex < _index` (the user jumped *back* to an earlier chapter), gated by the runtime on the book actually being finished. This is NOT the initial `openBook` restore (no prior `_index`), NOT forward auto-advance (`newIndex > _index`), and NOT `markPlayed`/open — so a glance-reopen of a finished book does NOT un-finish it. An explicit "Restart" reuses the same backward-load path.
- Run from `apps/android/`: `flutter test`, `flutter analyze` (use `flutter.bat` under PowerShell; `flutter` in Bash). Drift codegen: `dart run build_runner build --delete-conflicting-outputs`. Run `flutter pub get` first in the worktree.
- TDD: failing test first, implement, commit per task.

---

### Task 1: `Books.finished` column (Drift schema 7) + pull-persist method + BookSummary

**Files:**
- Modify: `apps/android/lib/src/data/library_database.dart` (Books table; `schemaVersion`; migration)
- Regenerate: `apps/android/lib/src/data/library_database.g.dart` (build_runner)
- Modify: `apps/android/lib/src/data/drift_local_library.dart` (`BookSummary.finished`; `listBooks`; `markPlayed` un-touched re finished; new `setBookSyncState`)
- Test: `apps/android/test/data/drift_local_library_test.dart`

**Interfaces:**
- Produces (on `DriftLocalLibrary`): `Future<void> setBookSyncState(String bookId, {required bool finished, required bool hidden})` — sets `Books.finished`+`Books.hidden` from a server pull. `BookSummary.finished: bool`. `markPlayed` clears `hidden` only (NOT `finished`).

- [ ] **Step 1: Write failing tests:**

```dart
test('setBookSyncState persists finished+hidden; listBooks surfaces finished', () async {
  await lib.upsertBookMeta(bookId: 'b1', title: 'T', author: 'A', series: '', seriesPosition: null);
  await lib.setBookSyncState('b1', finished: true, hidden: false);
  expect((await lib.listBooks()).single.finished, isTrue);
});

test('markPlayed clears hidden but NOT finished', () async {
  await lib.upsertBookMeta(bookId: 'b1', title: 'T', author: 'A', series: '', seriesPosition: null);
  await lib.setBookSyncState('b1', finished: true, hidden: true);
  await lib.markPlayed('b1', '2026-06-20T12:00:00Z');
  final b = (await lib.listBooks()).single;
  expect(b.hidden, isFalse);
  expect(b.finished, isTrue);
});
```

- [ ] **Step 2: Run, verify fail.** `flutter test test/data/drift_local_library_test.dart` → FAIL (`finished`/`setBookSyncState` undefined).

- [ ] **Step 3a:** In `library_database.dart`, add to `class Books` (after `hidden`):

```dart
  /// Server-derived/explicit "finished" pulled from the sync-manifest index —
  /// drives shelf exclusion (book left the Continue-listening shelf). Distinct
  /// from per-chapter Chapters.finished. Cleared locally only on genuine replay.
  BoolColumn get finished => boolean().withDefault(const Constant(false))();
```
Bump `schemaVersion => 7;` and add migration step: `if (from < 7) await m.addColumn(books, books.finished);`

- [ ] **Step 3b:** `dart run build_runner build --delete-conflicting-outputs`.

- [ ] **Step 3c:** In `drift_local_library.dart`: add `final bool finished;` (+ `required this.finished,`) to `BookSummary`; populate `finished: b.finished` in `listBooks()`; add:

```dart
  /// Persist server finished/hidden pulled from the manifest index.
  Future<void> setBookSyncState(String bookId, {required bool finished, required bool hidden}) async {
    await _ensureBook(bookId);
    await (_db.update(_db.books)..where((b) => b.bookId.equals(bookId)))
        .write(BooksCompanion(finished: Value(finished), hidden: Value(hidden)));
  }
```
Confirm `markPlayed` still writes only `lastPlayedAt` + `hidden: false` (do NOT add `finished` there).

- [ ] **Step 4: Run, verify pass** (+ full `flutter test`). Making `BookSummary.finished` **required** breaks exactly two `BookSummary(...)` construction sites — fix both: the prod mapper at `drift_local_library.dart:367` (the non-`listBooks` `BookSummary` build) and the test helper at `test/data/car_browse_test.dart:7`. (`ShelfBook.finished` defaults to false, so its call sites do NOT break — same as Batch-1's `hidden`.)

- [ ] **Step 5: Commit**

```bash
git add apps/android/lib/src/data/library_database.dart apps/android/lib/src/data/library_database.g.dart apps/android/lib/src/data/drift_local_library.dart apps/android/test/data/drift_local_library_test.dart apps/android/test/data/car_browse_test.dart
git commit -m "feat(app): Books.finished column (schema 7) + setBookSyncState pull (Refs #952)"
```

---

### Task 2: Parse + persist manifest finished/hidden on index load

**Files:**
- Modify: `apps/android/lib/src/domain/sync_manifest.dart:9-48` (`SyncManifestIndexBook` + `fromJson`)
- Modify: `apps/android/lib/src/data/sync_controller.dart:45-57` (`loadIndex` persists finished/hidden)
- Test: `apps/android/test/domain/sync_manifest_test.dart` (fromJson) + `sync_controller` test if present

**Interfaces:**
- Consumes: `DriftLocalLibrary.setBookSyncState` (Task 1).
- Produces: `SyncManifestIndexBook.finished: bool`, `.hidden: bool` (default false); `loadIndex()` calls `setBookSyncState` per book.

- [ ] **Step 1: Write failing test:**

```dart
test('fromJson parses finished + hidden (default false when absent)', () {
  final b = SyncManifestIndexBook.fromJson({'bookId': 'b1', 'updatedAt': 't', 'finished': true});
  expect(b.finished, isTrue);
  expect(b.hidden, isFalse);
});
```

- [ ] **Step 2: Run, verify fail.**

- [ ] **Step 3a:** In `sync_manifest.dart`, add `final bool finished;` + `final bool hidden;` (with `this.finished = false, this.hidden = false,` in the const ctor) and in `fromJson`:

```dart
      finished: json['finished'] as bool? ?? false,
      hidden: json['hidden'] as bool? ?? false,
```

- [ ] **Step 3b:** In `sync_controller.dart` `loadIndex()`, after `upsertBookMeta`, add:

```dart
      await _library.setBookSyncState(b.bookId, finished: b.finished, hidden: b.hidden);
```
> NOTE: `_library` is the `DriftLocalLibrary`/port; if its static type doesn't expose `setBookSyncState`, add it to the port interface or use the concrete type (mirror how `upsertBookMeta` is reached).

- [ ] **Step 4: Run, verify pass** (+ full `flutter test`).

- [ ] **Step 5: Commit**

```bash
git add apps/android/lib/src/domain/sync_manifest.dart apps/android/lib/src/data/sync_controller.dart apps/android/test/
git commit -m "feat(app): pull finished+hidden from manifest into Drift on index load (Refs #952)"
```

---

### Task 3: Shelf excludes finished + rebuild-after-pull ordering fix

**Files:**
- Modify: `apps/android/lib/src/domain/home_shelf.dart` (`ShelfBook.finished`; `buildContinueListening` filter)
- Modify: `apps/android/lib/src/ui/library_home_screen.dart:57-86` (`_refresh` rebuilds the shelf AFTER the pull)
- Test: `apps/android/test/domain/home_shelf_test.dart` + a library_home_screen widget test

**Interfaces:**
- Consumes: `BookSummary.finished` (Task 1).
- Produces: `ShelfBook` gains `finished` (default false); `buildContinueListening` excludes `b.inProgress && !b.hidden && !b.finished`.

- [ ] **Step 1: Write failing test** (home_shelf_test): a `finished:true` book is excluded from `buildContinueListening` even with a non-empty `lastPlayedAt`.

```dart
test('buildContinueListening excludes finished books', () {
  final shelf = buildContinueListening([
    book('a', lastPlayedAt: '2026-06-20T10:00:00Z'),
    book('b', lastPlayedAt: '2026-06-20T11:00:00Z', finished: true),
  ]);
  expect(shelf.map((b) => b.bookId), ['a']);
});
```
> NOTE: extend the `book()` helper (Batch-1) with a `finished` param.

- [ ] **Step 2: Run, verify fail.**

- [ ] **Step 3a:** `home_shelf.dart`: add `this.finished = false,` + `final bool finished;` to `ShelfBook`; filter becomes `books.where((b) => b.inProgress && !b.hidden && !b.finished)`.

- [ ] **Step 3b:** `library_home_screen.dart` `_refresh()` — the shelf is built from `listBooks()` BEFORE the `loadLibraryLocalFirst` stream (`:60-70`), and every stream tick re-assigns the SAME captured pre-pull `shelf` to `_continue` (`:78`). The pulled finished/hidden lands in **Drift only** (via `loadIndex`→`setBookSyncState`), so it is NOT reflected without a fresh local read. **REQUIRED:** after the stream reaches its terminal/`!s.loading` state, **re-query `await widget.runtime.library.listBooks()`**, rebuild the `ShelfBook` list (passing `finished: s.finished` and `hidden: s.hidden`), and `setState(() => _continue = rebuiltShelf)`. Keep the initial pre-pull `shelf` for instant paint, then replace with the post-pull re-query result. A simple in-loop re-build that re-reads from the just-updated local store is not enough unless it re-queries `listBooks()` (the stream payload `_books` is the grid, not the shelf rows).

- [ ] **Step 4: Run, verify pass** (+ full `flutter test`, `flutter analyze`).

- [ ] **Step 5: Commit**

```bash
git add apps/android/lib/src/domain/home_shelf.dart apps/android/lib/src/ui/library_home_screen.dart apps/android/test/
git commit -m "feat(app): shelf excludes finished + rebuild after server pull (Refs #952)"
```

---

### Task 4: `setShelfStatus` API + push on auto-finish & long-press remove

**Files:**
- Modify: `apps/android/lib/src/data/api_client.dart` (add `setShelfStatus`)
- Modify: `apps/android/lib/src/data/companion_runtime.dart` (`wireFinishedTracking`: also POST finished:true on book-completed)
- Modify: `apps/android/lib/src/ui/library_home_screen.dart` (`_confirmRemoveFromShelf`: also POST hidden:true)
- Test: `apps/android/test/data/api_client_test.dart` (if present) + `companion_runtime_test.dart`

**Interfaces:**
- Produces: `ApiClient.setShelfStatus(String bookId, {bool? finished, bool? hidden})` → `POST /api/books/{bookId}/shelf-status` with the provided flags; best-effort (caller swallows errors).

- [ ] **Step 1: Write failing tests:** `setShelfStatus` issues the right POST (mirror an existing `api_client` POST test, e.g. `putListenProgress`); `wireFinishedTracking` calls `api.setShelfStatus(bookId, finished: true)` when `bookCompletedStream` fires (extend the Batch-1 integration test); `_confirmRemoveFromShelf` calls `setShelfStatus(bookId, hidden: true)` (extend the Batch-1 long-press widget test).

- [ ] **Step 2: Run, verify fail.**

- [ ] **Step 3a:** `api_client.dart`: add (mirror `putListenProgress` `:146-171`):

```dart
  Future<void> setShelfStatus(String bookId, {bool? finished, bool? hidden}) async {
    final body = <String, dynamic>{};
    if (finished != null) body['finished'] = finished;
    if (hidden != null) body['hidden'] = hidden;
    await _client.post(
      Uri.parse('$_base/api/books/${Uri.encodeComponent(bookId)}/shelf-status'),
      headers: {'Content-Type': 'application/json'},
      body: jsonEncode(body),
    );
  }
```
> NOTE: match the file's actual HTTP client field/auth header pattern (`_client`/`_base`/token) used by `putListenProgress`.

- [ ] **Step 3b:** `companion_runtime.dart` `wireFinishedTracking`: change the book-completed listener to also push (best-effort):

```dart
  final bookFinishedSub = player.bookCompletedStream.listen((bookId) {
    library.markBookFinished(bookId);
    api.setShelfStatus(bookId, finished: true).catchError((_) {});
  });
```
> REQUIRED wiring: `wireFinishedTracking` currently is `wireFinishedTracking(PlayerController player, DriftLocalLibrary library)` (`companion_runtime.dart:38-52`), called as `wireFinishedTracking(player, library)` at `:213-214`. Change its signature to add `ApiClient api` and update that single call site to pass `api` (the runtime holds `api` as a public field at `:91`, in scope in `forConnection`). The book-completed listener's local `markBookFinished` already sets `hidden` locally (offline-correct); the POST is purely the cross-device push.

- [ ] **Step 3c:** `library_home_screen.dart` `_confirmRemoveFromShelf`: after `setBookHidden(b.bookId, true)`, add `widget.runtime.api.setShelfStatus(b.bookId, hidden: true).catchError((_) {});` (best-effort).

- [ ] **Step 4: Run, verify pass** (+ full `flutter test`).

- [ ] **Step 5: Commit**

```bash
git add apps/android/lib/src/data/api_client.dart apps/android/lib/src/data/companion_runtime.dart apps/android/lib/src/ui/library_home_screen.dart apps/android/test/
git commit -m "feat(app): push shelf-status on auto-finish + long-press remove (Refs #952)"
```

---

### Task 5: Replay trigger — un-finish on genuine replay only

**Files:**
- Modify: `apps/android/lib/src/data/player_controller.dart` (emit a replay/un-finish signal on loading an earlier chapter); wire to library clear + push
- Modify: `apps/android/lib/src/data/drift_local_library.dart` (`clearBookFinished(bookId)`)
- Modify: `apps/android/lib/src/data/companion_runtime.dart` (wire replay signal → clear local finished + POST finished:false + suppress-guard)
- Test: `apps/android/test/data/player_controller_test.dart` + companion_runtime test

**Interfaces:**
- Produces: `PlayerController` exposes `Stream<String> get bookReplayedStream` emitting `bookId` on a **backward navigation** — inside `_loadIndex(newIndex)`, capture `prev = _index` BEFORE reassigning, and after the load emit when `prev >= 0 && newIndex < prev` (a real jump back; not the initial restore, not forward advance). `DriftLocalLibrary` gains `Future<bool> isBookFinished(String bookId)` and `Future<void> clearBookFinished(String bookId)` (sets `Books.finished=false`).

- [ ] **Step 1: Write failing tests:**
  - player_controller: open a 3-chapter book (loads ch0), advance forward to ch1 then ch2 → NO `bookReplayedStream` emit; then `playChapter(ch0)` (jump back) → emits once. Re-`openBook` (initial restore at saved index) → NO emit.
  - `clearBookFinished` sets finished=false; `isBookFinished` reflects it.
  - runtime: on `bookReplayedStream` for a **finished** book → `clearBookFinished` + `POST finished:false`; for a **not-finished** book → neither (gated).
> NOTE: emit on backward nav ONLY (`newIndex < prev`), gated downstream on `isBookFinished`. This avoids BOTH false positives the review flagged: the glance-reopen (initial restore has no prior `_index`) and forward auto-advance (`newIndex > prev`).

- [ ] **Step 2: Run, verify fail.**

- [ ] **Step 3:** In `player_controller.dart` `_loadIndex`, capture `final prev = _index;` before `_index = newIndex;` and after the load `if (prev >= 0 && newIndex < prev && _bookId != null) _bookReplayed.add(_bookId!);` (add the `_bookReplayed` broadcast controller + getter + close in `dispose`). Add `isBookFinished`/`clearBookFinished` to `DriftLocalLibrary`. In `companion_runtime` (inside `wireFinishedTracking` or alongside), wire:
```dart
  final replaySub = player.bookReplayedStream.listen((bookId) async {
    if (!await library.isBookFinished(bookId)) return; // gate: only un-finish a finished book
    await library.clearBookFinished(bookId);
    api.setShelfStatus(bookId, finished: false).catchError((_) {});
  });
```
Add `replaySub` to the `_subs` disposal list.
> NO `_pendingUnfinish` guard (cut as YAGNI per review [I5]): the `finished:false` POST lands before the next library-entry pull (the user is in the player when they jump back, and the pull happens on returning to the library), so a stale `finished:true` won't be re-pulled; any momentary flicker self-corrects on the following pull. Document this as an accepted minor.

- [ ] **Step 4: Run, verify pass** (+ full `flutter test`).

- [ ] **Step 5: Commit**

```bash
git add apps/android/lib/src/data/player_controller.dart apps/android/lib/src/data/drift_local_library.dart apps/android/lib/src/data/companion_runtime.dart apps/android/test/
git commit -m "feat(app): un-finish on genuine replay with anti-flicker guard (Refs #952)"
```

---

### Task 6: Reconcile fix — compare parsed UTC instants

**Files:**
- Modify: `apps/android/lib/src/domain/resume_reconcile.dart`
- Test: `apps/android/test/domain/resume_reconcile_test.dart`

- [ ] **Step 1: Write failing test:** a tz-skewed pair the old string compare ordered wrong (e.g. local `2026-06-20T14:30:00.000` (naive, +0) vs remote `2026-06-20T19:30:00.000Z` representing the SAME instant or an ordering the string compare gets wrong) → `reconcileResume` returns the correct action when compared as instants.

```dart
test('orders by instant, not raw string (tz-skew)', () {
  // local is +10:00 wall time, remote is the same instant in UTC → noop/pull, not a wrong push
  final action = reconcileResume(
    localListenedAt: '2026-06-20T20:00:00.000+10:00',
    remoteUpdatedAt: '2026-06-20T10:00:00.000Z', // same instant
  );
  expect(action, ResumeAction.noop);
});
```

- [ ] **Step 2: Run, verify fail** (raw string compare gives the wrong answer).

- [ ] **Step 3:** Replace the raw `.compareTo` (`resume_reconcile.dart:19`) with `DateTime.parse(localListenedAt).toUtc().compareTo(DateTime.parse(remoteUpdatedAt).toUtc())`; keep the three null-handling branches (`:16-18`) and `enum ResumeAction { pushLocal, pullRemote, noop }`. **REQUIRED (else the parse misinterprets local time as UTC):** the companion currently stamps `listenedAt` via `DateTime.now().toIso8601String()` — a NAIVE local string with no `Z`/offset — at `player_controller.dart:292` and `:375` (the `_store.savePlayback`/`saveNow` paths). Change BOTH to `DateTime.now().toUtc().toIso8601String()` (and any stamp in `resume_sync_service.dart`). Without this, `DateTime.parse(naiveLocal).toUtc()` shifts the time by the device offset.

- [ ] **Step 4: Run, verify pass** (+ full `flutter test`).

- [ ] **Step 5: Commit**

```bash
git add apps/android/lib/src/domain/resume_reconcile.dart apps/android/test/domain/resume_reconcile_test.dart
git commit -m "fix(app): reconcile resume by parsed UTC instant not raw string (Refs #952)"
```

---

### Task 7: Regression doc update + full analyze/test

**Files:**
- Modify: `docs/features/fs-cross-device-finished-sync.md` (PR1's doc — add the PR2 companion behaviors + acceptance: finish on web → leaves phone shelf on next library visit; remove on phone → leaves web; replay → returns on both; reinstall → shelf correct after first sync)
- Modify: `docs/features/INDEX.md` if needed

- [ ] **Step 1:** Update the regression doc with PR2 behaviors + manual acceptance walkthrough.
- [ ] **Step 2:** `flutter analyze` (clean) + `flutter test` (all green) — paste tails.
- [ ] **Step 3: Commit**

```bash
git add docs/features/fs-cross-device-finished-sync.md docs/features/INDEX.md
git commit -m "docs(docs): cross-device finished sync PR2 companion behaviors (Refs #952)"
```

---

## Self-Review
- **Spec coverage (PR2):** B1 push → Task 4 (+ replay push in Task 5). B2 pull+shelf+ordering → Tasks 1-3. B2 schema-7 → Task 1. B2 markPlayed-keeps-finished → Task 1. B2 replay trigger + flicker guard → Task 5. B3 reconcile → Task 6. Foreground propagation via library re-entry (no lifecycle observer) → Task 3 ordering fix + doc (Task 7). ✓
- **Placeholders:** test bodies are sketches with NOTEs to match real harnesses; the `_pendingUnfinish` guard and `wireFinishedTracking` ApiClient threading are flagged as wiring to confirm against current code. ✓
- **Type consistency:** `Books.finished`, `setBookSyncState`, `BookSummary.finished`, `ShelfBook.finished`, `setShelfStatus`, `bookReplayedStream`, `clearBookFinished` consistent across tasks. ✓
- **Dependency:** PR2 branch cut AFTER PR1 merges (needs `SyncManifestIndexBook` server fields). Stated in Global Constraints.
