import 'package:drift/drift.dart';
import 'package:drift_flutter/drift_flutter.dart';

part 'library_database.g.dart';

/// One row per (sessionId, bookId, date) accrual — the offline buffer for
/// listening-stats flushing (fs-16 H-b). Seconds are stored as absolute
/// totals; upsert is max(existing, incoming) so re-sending is idempotent,
/// matching the server's own max() upsert on `PUT /api/books/:id/listen-stats`.
class ListenStatsBuffer extends Table {
  TextColumn get sessionId => text()();
  TextColumn get bookId => text()();
  TextColumn get date => text()(); // 'YYYY-MM-DD'
  IntColumn get seconds => integer()();

  @override
  Set<Column<Object>> get primaryKey => {sessionId, bookId, date};
}

/// One row per synced book (the phone's local mirror of the server library).
class Books extends Table {
  TextColumn get bookId => text()();
  TextColumn get updatedAt => text().withDefault(const Constant(''))();
  TextColumn get title => text().withDefault(const Constant(''))();
  TextColumn get author => text().withDefault(const Constant(''))();
  TextColumn get series => text().withDefault(const Constant(''))();
  IntColumn get seriesPosition => integer().nullable()();

  /// ISO timestamp of the last time the user played this book — drives
  /// least-recently-listened book eviction.
  TextColumn get lastPlayedAt => text().nullable()();

  /// On-disk path of the cached ~250×250 cover thumbnail (client-downscaled).
  TextColumn get coverThumbPath => text().nullable()();

  /// Whether the user has dismissed this book from the "Continue listening"
  /// shelf — set on auto-finish (last chapter reached) or a manual long-press
  /// remove, cleared on replay (markPlayed). Drives shelf exclusion only; the
  /// book stays fully in the library.
  BoolColumn get hidden => boolean().withDefault(const Constant(false))();

  /// Server-derived/explicit "finished" pulled from the sync-manifest index —
  /// drives shelf exclusion (book left the Continue-listening shelf). Distinct
  /// from per-chapter Chapters.finished. Cleared locally only on genuine replay.
  BoolColumn get finished => boolean().withDefault(const Constant(false))();

  @override
  Set<Column<Object>> get primaryKey => {bookId};
}

/// One row per chapter of a synced book, keyed by the stable srv-35 `uuid`.
class Chapters extends Table {
  TextColumn get uuid => text()();
  TextColumn get bookId => text()();

  /// Current positional id (for building the audio URL); keying is by [uuid].
  IntColumn get chapterId => integer()();
  TextColumn get title => text().withDefault(const Constant(''))();

  /// `audioRenderedAt|fileSize` — null when no audio is downloaded.
  TextColumn get fingerprint => text().nullable()();
  TextColumn get urlSuffix => text().nullable()();

  /// On-disk byte size of the downloaded audio (0 when absent) — drives
  /// storage accounting.
  IntColumn get bytes => integer().withDefault(const Constant(0))();

  /// PCM-measured chapter length (seconds) from the manifest — stored so the
  /// player + library show durations + listener progress OFFLINE.
  RealColumn get durationSec => real().nullable()();

  /// Waveform peaks for the player (the server's 240 normalized RMS bins),
  /// JSON-encoded as a `List<double>`. Null until fetched — persisted so the
  /// waveform survives offline / screen recreation / restart instead of being
  /// re-fetched live every time.
  TextColumn get peaks => text().nullable()();

  /// Whether the user has finished this chapter — drives auto-delete-finished
  /// eviction (the row stays; only the audio file is dropped).
  BoolColumn get finished => boolean().withDefault(const Constant(false))();

  @override
  Set<Column<Object>> get primaryKey => {uuid};
}

/// Per-book playback resume point (`app-5`): the current chapter + position the
/// player restores when a book is (re)opened. Kept local; `app-6` syncs it with
/// the server listen-progress.
class Playback extends Table {
  TextColumn get bookId => text()();
  TextColumn get chapterUuid => text()();
  IntColumn get positionMs => integer().withDefault(const Constant(0))();
  TextColumn get updatedAt => text().withDefault(const Constant(''))();

  @override
  Set<Column<Object>> get primaryKey => {bookId};
}

@DriftDatabase(tables: [Books, Chapters, Playback, ListenStatsBuffer])
class LibraryDatabase extends _$LibraryDatabase {
  LibraryDatabase(super.e);

  /// Production opener — a single SQLite file under the app's data dir
  /// (path_provider via drift_flutter). Tests inject `NativeDatabase.memory()`.
  LibraryDatabase.open() : this(driftDatabase(name: 'library'));

  @override
  int get schemaVersion => 7;

  @override
  MigrationStrategy get migration => MigrationStrategy(
        onCreate: (m) => m.createAll(),
        onUpgrade: (m, from, to) async {
          if (from < 2) await m.createTable(playback);
          if (from < 3) await m.addColumn(chapters, chapters.durationSec);
          if (from < 4) await m.createTable(listenStatsBuffer);
          if (from < 5) await m.addColumn(chapters, chapters.peaks);
          if (from < 6) await m.addColumn(books, books.hidden);
          if (from < 7) await m.addColumn(books, books.finished);
        },
      );

  // ── listen-stats buffer DAO ────────────────────────────────────────────

  /// Upsert an absolute accrual: stores max(existing.seconds, [seconds]).
  /// Uses a single raw SQL upsert so there is no race between read and write.
  Future<void> upsertListenStatAccrual({
    required String sessionId,
    required String bookId,
    required String date,
    required int seconds,
  }) =>
      customStatement(
        'INSERT INTO listen_stats_buffer (session_id, book_id, date, seconds) '
        'VALUES (?, ?, ?, ?) '
        'ON CONFLICT (session_id, book_id, date) DO UPDATE '
        'SET seconds = MAX(excluded.seconds, listen_stats_buffer.seconds)',
        [sessionId, bookId, date, seconds],
      );

  /// All buffered rows, grouped by (bookId, sessionId). Returns a map
  /// `bookId → sessionId → List<(date, seconds)>`.
  Future<Map<String, Map<String, List<({String date, int seconds})>>>>
      pendingByBook() async {
    final rows = await select(listenStatsBuffer).get();
    final result =
        <String, Map<String, List<({String date, int seconds})>>>{};
    for (final r in rows) {
      result
          .putIfAbsent(r.bookId, () => {})
          .putIfAbsent(r.sessionId, () => [])
          .add((date: r.date, seconds: r.seconds));
    }
    return result;
  }

  /// Delete the rows that were successfully flushed.
  Future<void> clearFlushedListenStats({
    required String sessionId,
    required String bookId,
    required List<String> dates,
  }) async {
    await (delete(listenStatsBuffer)
          ..where(
            (t) =>
                t.sessionId.equals(sessionId) &
                t.bookId.equals(bookId) &
                t.date.isIn(dates),
          ))
        .go();
  }
}
