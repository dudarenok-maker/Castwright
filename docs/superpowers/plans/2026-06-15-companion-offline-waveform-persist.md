# Companion Offline Waveform Persistence — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the companion app's chapter waveform an offline-persisted asset so it survives going offline, leaving/returning to the player screen, and app restarts — and refetch peaks on connect for every locally-stored chapter that lacks them.

**Architecture:** Today waveform peaks are fetched live from the server (`GET /api/books/:id/chapters/:id/audio` → `peaks`) and cached only in an in-memory `Map` on `_PlayerScreenState`, so they vanish offline and on screen recreation (root cause confirmed in `player_screen.dart:34-41` + `api_client.dart:111-122`). We persist peaks in the existing drift `Chapters` table (one tiny nullable JSON column, ~2 KB/chapter), make the player read **local-first** through a new `SyncController.peaksFor`, persist peaks for every chapter as it downloads, and add a `backfillMissingPeaks` sweep wired to the connect / reconnect path. The `SyncController` becomes the single owner of the peaks policy; `DriftLocalLibrary` owns persistence primitives.

**Tech Stack:** Flutter / Dart, drift (SQLite) with build_runner codegen, `flutter_test`.

**Branch:** `fix/companion-offline-waveform-persist` (cut from `main`).

---

### Task 0: Cut the branch

- [ ] **Step 1: Create the branch off latest main**

```bash
git switch main && git pull
git switch -c fix/companion-offline-waveform-persist
```

---

### Task 1: Add the `peaks` column to the drift schema (v4 → v5)

**Files:**
- Modify: `apps/android/lib/src/data/library_database.dart` (Chapters table + schemaVersion + migration)
- Regenerate: `apps/android/lib/src/data/library_database.g.dart` (build_runner output — committed)

- [ ] **Step 1: Add the nullable `peaks` column to the `Chapters` table**

In `library_database.dart`, inside `class Chapters extends Table`, add the column immediately after `durationSec` (before `finished`):

```dart
  /// Waveform peaks for the player (the server's 240 normalized RMS bins),
  /// JSON-encoded as a `List<double>`. Null until fetched — persisted so the
  /// waveform survives offline / screen recreation / restart instead of being
  /// re-fetched live every time.
  TextColumn get peaks => text().nullable()();
```

- [ ] **Step 2: Bump the schema version and add the migration step**

In `library_database.dart`, change `int get schemaVersion => 4;` to:

```dart
  @override
  int get schemaVersion => 5;
```

And add the migration line inside `onUpgrade` (after the `from < 4` line):

```dart
        onUpgrade: (m, from, to) async {
          if (from < 2) await m.createTable(playback);
          if (from < 3) await m.addColumn(chapters, chapters.durationSec);
          if (from < 4) await m.createTable(listenStatsBuffer);
          if (from < 5) await m.addColumn(chapters, chapters.peaks);
        },
```

- [ ] **Step 3: Regenerate the drift codegen**

Run:
```bash
cd apps/android && dart run build_runner build --delete-conflicting-outputs
```
Expected: regenerates `library_database.g.dart` with a `peaks` column on the generated `Chapter`/`ChaptersCompanion` types and `schemaVersion => 5`. No analyzer errors.

- [ ] **Step 4: Confirm it compiles**

Run:
```bash
cd apps/android && flutter analyze lib/src/data/library_database.dart lib/src/data/library_database.g.dart
```
Expected: "No issues found!"

- [ ] **Step 5: Commit**

```bash
git add apps/android/lib/src/data/library_database.dart apps/android/lib/src/data/library_database.g.dart
git commit -m "feat(companion): add persisted peaks column to chapters (schema v5)"
```

---

### Task 2: Persistence primitives on `DriftLocalLibrary`

**Files:**
- Modify: `apps/android/lib/src/data/drift_local_library.dart`
- Test: `apps/android/test/data/drift_local_library_test.dart`

- [ ] **Step 1: Write the failing tests**

Append these tests inside the existing `group('DriftLocalLibrary (LocalLibrary port)', () { ... })` in `drift_local_library_test.dart` (the file already imports `dart:convert`, `drift/native.dart`, `file_store.dart`, `library_database.dart`, and defines `makeLib(fs)`):

```dart
    test('savePeaks + loadPeaks round-trips; loadPeaks is null when unsaved', () async {
      final fs = InMemoryFileStore();
      final lib = makeLib(fs);
      await fs.writeBytes('/data/books/b1/u1/audio.mp3', [1]);
      await lib.recordChapterMeta(
          bookId: 'b1', uuid: 'u1', chapterId: 1, title: 'One',
          fingerprint: 'fp1', urlSuffix: 'audio.mp3', durationSec: 10);

      expect(await lib.loadPeaks('u1'), isNull); // nothing saved yet
      await lib.savePeaks('u1', [0.0, 0.5, 1.0]);
      expect(await lib.loadPeaks('u1'), [0.0, 0.5, 1.0]);
      await lib.close();
    });

    test('chaptersMissingPeaks returns only audio chapters (chapterId>0) lacking peaks', () async {
      final fs = InMemoryFileStore();
      final lib = makeLib(fs);
      await fs.writeBytes('/data/books/b1/u1/audio.mp3', [1]);
      await fs.writeBytes('/data/books/b1/u2/audio.mp3', [2]);
      // u1: has audio, no peaks → SHOULD appear.
      await lib.recordChapterMeta(
          bookId: 'b1', uuid: 'u1', chapterId: 1, title: 'One',
          fingerprint: 'fp1', urlSuffix: 'audio.mp3', durationSec: 10);
      // u2: has audio + peaks already → SHOULD NOT appear.
      await lib.recordChapterMeta(
          bookId: 'b1', uuid: 'u2', chapterId: 2, title: 'Two',
          fingerprint: 'fp2', urlSuffix: 'audio.mp3', durationSec: 10);
      await lib.savePeaks('u2', [1.0]);
      // u3: legacy/sync-engine row with chapterId 0 (no usable peaks URL) →
      // SHOULD NOT appear (excluded by the chapterId > 0 filter).
      await fs.writeBytes('/data/books/b1/u3/audio.mp3', [3]);
      await lib.recordChapter('b1', 'u3', 'fp3', 'audio.mp3'); // chapterId 0

      final missing = await lib.chaptersMissingPeaks();
      expect(missing.map((c) => c.uuid), ['u1']);
      expect(missing.single.bookId, 'b1');
      expect(missing.single.chapterId, 1);
      await lib.close();
    });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run:
```bash
cd apps/android && flutter test test/data/drift_local_library_test.dart
```
Expected: FAIL — `loadPeaks`, `savePeaks`, `chaptersMissingPeaks` are not defined on `DriftLocalLibrary`.

- [ ] **Step 3: Implement the three methods**

In `drift_local_library.dart`, add these methods inside `class DriftLocalLibrary`, right after `chaptersForBook` (around line 194, before `setBookUpdatedAt`). `jsonEncode`/`jsonDecode` come from the already-imported `dart:convert`; `Value` from `package:drift/drift.dart`:

```dart
  /// Persist a chapter's waveform peaks (JSON-encoded). Keyed by [uuid]; a
  /// no-op when no such chapter row exists.
  Future<void> savePeaks(String uuid, List<double> peaks) async {
    await (_db.update(_db.chapters)..where((c) => c.uuid.equals(uuid)))
        .write(ChaptersCompanion(peaks: Value(jsonEncode(peaks))));
  }

  /// A chapter's persisted peaks, or null when none have been saved.
  Future<List<double>?> loadPeaks(String uuid) async {
    final row = await (_db.select(_db.chapters)..where((c) => c.uuid.equals(uuid)))
        .getSingleOrNull();
    final raw = row?.peaks;
    if (raw == null) return null;
    final decoded = jsonDecode(raw);
    if (decoded is! List) return null;
    return [for (final e in decoded) (e as num).toDouble()];
  }

  /// Downloaded chapters (real chapterId, audio present) that have no persisted
  /// peaks yet — the work-list for the connect-time backfill sweep. Excludes
  /// audio-less rows (nothing to show) and id-0 legacy rows (no usable URL).
  Future<List<({String bookId, String uuid, int chapterId})>>
      chaptersMissingPeaks() async {
    final rows = await (_db.select(_db.chapters)
          ..where((c) =>
              c.peaks.isNull() &
              c.fingerprint.isNotNull() &
              c.chapterId.isBiggerThanValue(0)))
        .get();
    return [
      for (final r in rows)
        (bookId: r.bookId, uuid: r.uuid, chapterId: r.chapterId),
    ];
  }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run:
```bash
cd apps/android && flutter test test/data/drift_local_library_test.dart
```
Expected: PASS (all tests, including the pre-existing ones).

- [ ] **Step 5: Commit**

```bash
git add apps/android/lib/src/data/drift_local_library.dart apps/android/test/data/drift_local_library_test.dart
git commit -m "feat(companion): persist + query chapter waveform peaks in drift store"
```

---

### Task 3: Peaks policy on `SyncController` (read-local-first, persist-on-download, backfill)

**Files:**
- Modify: `apps/android/lib/src/data/sync_controller.dart`
- Test: `apps/android/test/data/sync_controller_test.dart`

- [ ] **Step 1: Write the failing tests**

In `sync_controller_test.dart`, first extend the `make(...)` helper so a fake peaks fetcher can be injected. Replace the existing `make` (lines 46-59) with:

```dart
  SyncController make(
    ManifestApi api,
    Map<String, List<int>> serverBytes, {
    Future<List<double>> Function(String bookId, int chapterId)? peaksFetcher,
  }) {
    final downloader = ChapterDownloader(
      (url, headers) async =>
          RangeResponse(statusCode: 200, body: Stream.value(serverBytes[url.path]!)),
      fs,
      delay: (_) async {},
    );
    return SyncController(
      manifestApi: api,
      localLibrary: lib,
      chapterDownloader: downloader,
      urlResolver: (p) => Uri.parse('https://s$p'),
      peaksFetcher: peaksFetcher,
    );
  }
```

Then add a new test group at the end of `main()` (after the existing groups):

```dart
  // NOTE: this file's setUp builds `lib` at FS root '/d' (not '/data'), and
  // recordChapterMeta tolerates a missing audio file (bytes → 0). The peaks
  // policy doesn't depend on bytes, so these tests deliberately skip writing
  // audio fixtures.
  group('peaks policy', () {
    test('peaksFor returns persisted peaks without fetching', () async {
      var fetches = 0;
      final c = make(_ThrowingApi(), {}, peaksFetcher: (_, __) async {
        fetches++;
        return const [];
      });
      await lib.recordChapterMeta(
          bookId: 'b1', uuid: 'u1', chapterId: 1, title: 'One',
          fingerprint: 'fp1', urlSuffix: 'audio.mp3', durationSec: 10);
      await lib.savePeaks('u1', [0.25, 0.75]);

      expect(await c.peaksFor('b1', 'u1', 1), [0.25, 0.75]);
      expect(fetches, 0); // local hit → no server call
    });

    test('peaksFor fetches + persists when not local, then returns them', () async {
      final c = make(_ThrowingApi(), {},
          peaksFetcher: (b, id) async => [0.1, 0.2, 0.3]);
      await lib.recordChapterMeta(
          bookId: 'b1', uuid: 'u1', chapterId: 1, title: 'One',
          fingerprint: 'fp1', urlSuffix: 'audio.mp3', durationSec: 10);

      expect(await c.peaksFor('b1', 'u1', 1), [0.1, 0.2, 0.3]);
      expect(await lib.loadPeaks('u1'), [0.1, 0.2, 0.3]); // persisted for next time
    });

    test('peaksFor returns empty offline with nothing cached', () async {
      final c = make(_ThrowingApi(), {}, peaksFetcher: (_, __) async => const []);
      await lib.recordChapterMeta(
          bookId: 'b1', uuid: 'u1', chapterId: 1, title: 'One',
          fingerprint: 'fp1', urlSuffix: 'audio.mp3', durationSec: 10);
      expect(await c.peaksFor('b1', 'u1', 1), isEmpty);
    });

    test('downloadBook persists peaks for each downloaded chapter', () async {
      final detail = SyncManifestBookDetail(
        schemaVersion: 1, bookId: 'b1', updatedAt: 't1',
        chapters: [ch('b1', 'u1', 1, 'fp1', dur: 10)],
        activeChapterUuids: const ['u1'],
      );
      final api = _FakeApi(SyncManifestIndex(schemaVersion: 1, books: const [],
          activeBookIds: const ['b1']), {'b1': detail});
      final c = make(api, {'/api/books/b1/chapters/1/audio.mp3': [1, 2, 3]},
          peaksFetcher: (b, id) async => [0.4, 0.6]);

      await c.downloadBook('b1');
      expect(await lib.loadPeaks('u1'), [0.4, 0.6]);
    });

    test('backfillMissingPeaks fills missing, skips empties, returns count', () async {
      var calls = <int>[];
      final c = make(_ThrowingApi(), {}, peaksFetcher: (b, id) async {
        calls.add(id);
        return id == 1 ? [1.0, 0.5] : const []; // ch1 has peaks, ch2 doesn't
      });
      await lib.recordChapterMeta(
          bookId: 'b1', uuid: 'u1', chapterId: 1, title: 'One',
          fingerprint: 'fp1', urlSuffix: 'audio.mp3', durationSec: 10);
      await lib.recordChapterMeta(
          bookId: 'b1', uuid: 'u2', chapterId: 2, title: 'Two',
          fingerprint: 'fp2', urlSuffix: 'audio.mp3', durationSec: 10);

      final filled = await c.backfillMissingPeaks();
      expect(filled, 1);
      expect(calls..sort(), [1, 2]); // both attempted
      expect(await lib.loadPeaks('u1'), [1.0, 0.5]);
      expect(await lib.loadPeaks('u2'), isNull);
      // second pass is a no-op: u1 now has peaks, u2 still returns empty
      expect(await c.backfillMissingPeaks(), 0);
    });

    test('backfillMissingPeaks is re-entrancy guarded (concurrent call is a no-op)',
        () async {
      var fetchCalls = 0;
      final c = make(_ThrowingApi(), {}, peaksFetcher: (b, id) async {
        fetchCalls++;
        return [0.5];
      });
      await lib.recordChapterMeta(
          bookId: 'b1', uuid: 'u1', chapterId: 1, title: 'One',
          fingerprint: 'fp1', urlSuffix: 'audio.mp3', durationSec: 10);

      // A Dart async body runs synchronously up to its first await, so `first`
      // claims the guard before `second` is invoked — deterministic, no timers.
      final first = c.backfillMissingPeaks();
      final second = await c.backfillMissingPeaks(); // guarded → no-op
      expect(second, 0);
      expect(await first, 1);
      expect(fetchCalls, 1); // only the first sweep actually fetched
    });
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run:
```bash
cd apps/android && flutter test test/data/sync_controller_test.dart
```
Expected: FAIL — the `peaksFetcher` named arg, `peaksFor`, and `backfillMissingPeaks` don't exist yet.

- [ ] **Step 3: Add the `peaksFetcher` field + constructor param**

In `sync_controller.dart`, update the constructor and fields. Replace the constructor (lines 15-28) with:

```dart
  SyncController({
    required ManifestApi manifestApi,
    required DriftLocalLibrary localLibrary,
    required ChapterDownloader chapterDownloader,
    required Uri Function(String path) urlResolver,
    Future<List<double>> Function(String bookId, int chapterId)? peaksFetcher,
  })  : _api = manifestApi,
        _library = localLibrary,
        _downloader = chapterDownloader,
        _resolveUrl = urlResolver,
        _peaksFetcher = peaksFetcher ?? ((_, __) async => const []);

  final ManifestApi _api;
  final DriftLocalLibrary _library;
  final ChapterDownloader _downloader;
  final Uri Function(String path) _resolveUrl;

  /// Fetches a chapter's server-side waveform peaks (empty when absent/offline).
  /// Defaults to a no-op so non-networked construction (tests/demo) is unchanged.
  final Future<List<double>> Function(String bookId, int chapterId) _peaksFetcher;

  /// Re-entrancy guard: the initial-connect sweep and an auto-sync reconnect
  /// sweep can fire near-simultaneously — without this they'd double-fetch.
  bool _backfilling = false;
```

- [ ] **Step 4: Persist peaks during download**

In `sync_controller.dart`, inside `downloadBook`'s loop, after the `await _library.recordChapterMeta(...)` call (currently ends at line 106) and before `done++;`, add:

```dart
      final peaks = await _peaksFetcher(bookId, c.id);
      if (peaks.isNotEmpty) await _library.savePeaks(c.uuid, peaks);
```

- [ ] **Step 5: Add `peaksFor` and `backfillMissingPeaks`**

In `sync_controller.dart`, add these methods at the end of the class (after `playlistFor`):

```dart
  /// Peaks for a chapter, local-first: returns persisted peaks when present,
  /// else fetches from the server (when reachable), persists, and returns them.
  /// Empty when neither source has them (offline + never cached) — the caller
  /// then shows the plain bar.
  Future<List<double>> peaksFor(String bookId, String uuid, int chapterId) async {
    final local = await _library.loadPeaks(uuid);
    if (local != null && local.isNotEmpty) return local;
    final remote = await _peaksFetcher(bookId, chapterId);
    if (remote.isNotEmpty) await _library.savePeaks(uuid, remote);
    return remote;
  }

  /// Fetch + persist peaks for every locally-stored chapter that lacks them
  /// (e.g. downloaded before peaks were persisted). Best-effort and idempotent:
  /// an empty/failed fetch leaves that chapter for the next connect; once every
  /// chapter has peaks it is a no-op. Re-entrancy guarded so overlapping connect
  /// + reconnect sweeps don't double-fetch. Returns the number newly filled.
  Future<int> backfillMissingPeaks() async {
    if (_backfilling) return 0; // a sweep is already running
    _backfilling = true;
    try {
      final missing = await _library.chaptersMissingPeaks();
      var filled = 0;
      for (final c in missing) {
        final peaks = await _peaksFetcher(c.bookId, c.chapterId);
        if (peaks.isNotEmpty) {
          await _library.savePeaks(c.uuid, peaks);
          filled++;
        }
      }
      return filled;
    } finally {
      _backfilling = false;
    }
  }
```

- [ ] **Step 6: Run the tests to verify they pass**

Run:
```bash
cd apps/android && flutter test test/data/sync_controller_test.dart
```
Expected: PASS (new `peaks policy` group + all pre-existing tests).

- [ ] **Step 7: Commit**

```bash
git add apps/android/lib/src/data/sync_controller.dart apps/android/test/data/sync_controller_test.dart
git commit -m "feat(companion): local-first peaks read + persist-on-download + connect backfill"
```

---

### Task 4: Wire the player + runtime to the persisted peaks

**Files:**
- Modify: `apps/android/lib/src/ui/player_screen.dart` (read via `sync.peaksFor`)
- Modify: `apps/android/lib/src/data/companion_runtime.dart` (inject fetcher + backfill on connect/reconnect)

These two files are device glue (no unit tests — `companion_runtime` is documented as "exercised on a device, not in unit tests", and there are no `player_screen` tests). The behaviour they expose is already covered by the Task 2/3 unit tests; this task only re-points the call sites. Acceptance is the manual walkthrough in Task 5.

- [ ] **Step 1: Point the player's `_ensurePeaks` at `sync.peaksFor`**

In `player_screen.dart`, replace the body of `_ensurePeaks` (lines 37-41) with:

```dart
  Future<void> _ensurePeaks(String uuid, int chapterId) async {
    if (_peaks.containsKey(uuid)) return;
    // Local-first: survives offline + screen recreation + restart. Falls back
    // to a live fetch (and persists) only when nothing is cached locally.
    final peaks =
        await widget.runtime.sync.peaksFor(widget.bookId, uuid, chapterId);
    if (peaks.isNotEmpty && mounted) setState(() => _peaks[uuid] = peaks);
  }
```

(`_ensureCurrentPeaks` at lines 43-48 already passes the correct `ch.first.id` as `chapterId`; leave it unchanged.)

- [ ] **Step 2: Inject the real peaks fetcher into the runtime's `SyncController`**

In `companion_runtime.dart`, in `forConnection`, update the `SyncController(...)` construction (lines 106-111) to pass the fetcher:

```dart
    final sync = SyncController(
      manifestApi: api.manifestApi,
      localLibrary: library,
      chapterDownloader: downloader,
      urlResolver: resolve,
      peaksFetcher: api.getChapterPeaks,
    );
```

- [ ] **Step 3: Backfill missing peaks on reconnect (auto-sync path)**

In `companion_runtime.dart`, in the `AutoSyncService(...)` wiring, extend the `runSync` closure (lines 177-181) so the reconnect sweep also fills peaks:

```dart
      runSync: () async {
        final books = await library.listBooks();
        await resumeSync.syncAll([for (final b in books) b.bookId]);
        await sync.backfillMissingPeaks();
      },
```

- [ ] **Step 4: Kick a one-shot backfill on initial connect**

In `companion_runtime.dart`, just before the final `return CompanionRuntime._(...)` in `forConnection`, add a fire-and-forget backfill so a launch that is already online (no connectivity-change event fires) still fills missing peaks. `unawaited` is from the already-imported `dart:async` (same idiom as `just_audio_engine.dart:57`):

```dart
    // Fill waveforms for any chapters downloaded before peaks were persisted.
    // Best-effort + idempotent: a no-op offline (getChapterPeaks swallows the
    // error) and once every chapter has peaks.
    unawaited(sync.backfillMissingPeaks());

    return CompanionRuntime._(api, library, sync, player, thumbnails,
        settingsStore, settings, resumeSync, sleepTimer, handler,
        [connectivitySub, completedSub]);
```

- [ ] **Step 5: Analyze the touched files**

Run:
```bash
cd apps/android && flutter analyze lib/src/ui/player_screen.dart lib/src/data/companion_runtime.dart
```
Expected: "No issues found!"

- [ ] **Step 6: Commit**

```bash
git add apps/android/lib/src/ui/player_screen.dart apps/android/lib/src/data/companion_runtime.dart
git commit -m "feat(companion): read waveform peaks local-first + backfill on connect"
```

---

### Task 5: Regression doc, bug issue, and full verification

**Files:**
- Create: `docs/features/companion-offline-waveform.md` (short regression plan)
- Modify: `docs/features/INDEX.md` (link the new plan under the companion area)

- [ ] **Step 1: Write the regression plan**

Create `docs/features/companion-offline-waveform.md` (front-matter `status: active`) capturing: the root cause (live-only + in-memory `_peaks`), the fix (drift `peaks` column v5; `SyncController.peaksFor` local-first; persist-on-download; `backfillMissingPeaks` on connect/reconnect), the **invariants** (peaks survive offline + screen recreation + restart; a chapter downloaded online then taken offline shows its waveform; switching chapters offline keeps showing waveforms for any with persisted peaks), and a **manual acceptance walkthrough**:

```
1. Connect to the local server, download a book.
2. Open the player, page through every chapter while online → each shows a waveform.
3. Force-quit the app. Re-open offline (server unreachable / airplane mode).
4. Open the player → every chapter still shows its waveform (no grey bar).
5. Switch chapters offline → waveform persists per chapter; none revert to grey.
6. (Backfill) Wipe the app's peaks (or install over an old build with audio but no
   peaks), reconnect → within one connect, all downloaded chapters gain waveforms.
```

- [ ] **Step 2: Link it in the features index**

Add an entry for `companion-offline-waveform.md` under the companion/app area of `docs/features/INDEX.md` (match the surrounding format).

- [ ] **Step 3: File the bug issue**

```bash
gh issue create --label bug --title "Companion waveforms disappear offline (live-only, not persisted)" \
  --body "Chapter waveforms in the companion player are fetched live and cached only in memory, so they vanish offline, on chapter switch, and on screen recreation — defaulting to a grey bar. Fix persists peaks in the drift store (schema v5), reads local-first, and backfills on connect. Plan: docs/superpowers/plans/2026-06-15-companion-offline-waveform-persist.md. Regression: docs/features/companion-offline-waveform.md."
```
Note the issue number `#NN` for the PR body (`Closes #NN`).

- [ ] **Step 4: Run the companion test suite**

Run:
```bash
cd apps/android && flutter test
```
Expected: PASS — all suites, including the new drift + sync_controller cases.

- [ ] **Step 5: Analyze the whole companion package**

Run:
```bash
cd apps/android && flutter analyze
```
Expected: "No issues found!"

- [ ] **Step 6: Commit the docs**

```bash
git add docs/features/companion-offline-waveform.md docs/features/INDEX.md
git commit -m "docs(companion): regression plan for offline waveform persistence"
```

- [ ] **Step 7: Open the PR**

```bash
git push -u origin fix/companion-offline-waveform-persist
gh pr create --title "fix(companion): persist waveform peaks for offline playback" \
  --body "## Summary
Waveform peaks are now an offline-persisted asset. Root cause: peaks were fetched live and cached only in an in-memory map on the player screen, so they vanished offline / on chapter switch / on screen recreation (grey bar).

- drift \`Chapters.peaks\` column (schema v4 → v5)
- \`SyncController.peaksFor\` reads local-first, fetches + persists on miss
- peaks persisted for every chapter as it downloads
- \`backfillMissingPeaks\` sweep wired to initial connect + auto-sync reconnect (fills chapters downloaded before peaks were persisted)

## Test plan
- New unit tests: \`drift_local_library_test.dart\` (save/load/missing-peaks), \`sync_controller_test.dart\` (peaksFor local-first + fetch-persist, persist-on-download, backfill).
- \`flutter test\` + \`flutter analyze\` green.
- Manual acceptance per docs/features/companion-offline-waveform.md (offline waveform survives restart + chapter switch; backfill on reconnect).

Closes #NN

🤖 Generated with [Claude Code](https://claude.com/claude-code)"
```

---

## Notes / decisions baked into this plan

- **Why a drift column, not a sidecar file:** chapter metadata (id/title/duration) already lives in the `Chapters` table and is read offline; peaks belong with it. `durationSec` (added in schema v3 the same way) is the precedent. ~2 KB/chapter is negligible.
- **Why `SyncController` owns the policy:** it already holds `_library` + the URL/manifest seams and is unit-tested; putting `peaksFor`/`backfill` there keeps the player a thin view and makes the read policy testable without a widget test.
- **`peaksFetcher` is optional with a no-op default** so existing `SyncController` construction in `demo_runtime.dart` and `sync_controller_test.dart` compiles unchanged; only the live runtime passes `api.getChapterPeaks`.
- **Backfill scope** = chapters with audio (`fingerprint` not null) and a real `chapterId` (`> 0`). This excludes finished-evicted rows (no audio to visualize) and id-0 legacy-imported rows (no usable peaks URL — they refill via `recordChapterMeta` on next re-download). This is why `chaptersMissingPeaks` filters on those two conditions.
- **Eviction is untouched:** `evictChapter` drops the whole row (peaks included); finished-drop (`applyEviction`) keeps the tiny peaks blob — harmless, and the player only renders waveforms for playable chapters anyway.
- **No drift migration unit test** is added — matching existing convention (v2/v3/v4 added none); fresh-DB `createAll` exercises the new column in every test, and the `from < 5` `addColumn` line mirrors the proven `durationSec` upgrade.

## Adversarial review (2026-06-15) — findings folded in

Checked against the live code; two defects fixed in this plan, four risks judged benign and documented:

- **[FIXED] Wrong test FS root.** `sync_controller_test`'s `setUp` builds the lib at root `/d`, not `/data`. The peaks tests no longer write audio fixtures at all (`recordChapterMeta` tolerates a missing file → `bytes = 0`, which the peaks policy ignores). The `drift_local_library` tests keep `/data` because `makeLib` uses that root.
- **[FIXED] Concurrent backfill double-fetch.** The initial-connect one-shot (Task 4 Step 4) and the auto-sync reconnect sweep (Task 4 Step 3) can overlap on a fresh online launch. Added the `_backfilling` re-entrancy guard + a deterministic test (Dart async runs synchronously to the first `await`, so the first call claims the guard before the second is invoked — no timers/Completers).
- **[BENIGN] No drift schema-snapshot/migration test exists** — every `schemaVersion` in `test/` is the *manifest protocol* field (always `1`), unrelated to `LibraryDatabase.schemaVersion`. The 4→5 bump breaks nothing.
- **[BENIGN] `_ensurePeaks` is not on the position tick.** It fires only from `_prepare` (open) and `_playChapter` (chapter change) — `player_screen.dart:75,96`. The transport `StreamBuilder` rebuilds per tick but only *reads* `_peaks[uuid]`; it never calls the fetch. So a local-first miss can't spam the network, and `api_client` connects fail fast offline anyway.
- **[BENIGN] `savePeaks` is update-only.** Viewing a not-yet-downloaded chapter while online (server detail lists it, no drift row yet) fetches peaks but the `UPDATE` writes 0 rows — peaks still show via the in-memory `_peaks` cache that session; nothing to persist for a chapter you can't play offline. Intentional (no orphan rows).
- **[BENIGN] A chapter the server has no peaks for (`peaks: []`)** is never persisted, so it's re-attempted on each connect (one cheap GET). Acceptable; not worth a "no-peaks" sentinel yet.
