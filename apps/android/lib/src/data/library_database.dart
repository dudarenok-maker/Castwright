import 'package:drift/drift.dart';
import 'package:drift_flutter/drift_flutter.dart';

part 'library_database.g.dart';

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

@DriftDatabase(tables: [Books, Chapters, Playback])
class LibraryDatabase extends _$LibraryDatabase {
  LibraryDatabase(super.e);

  /// Production opener — a single SQLite file under the app's data dir
  /// (path_provider via drift_flutter). Tests inject `NativeDatabase.memory()`.
  LibraryDatabase.open() : this(driftDatabase(name: 'library'));

  @override
  int get schemaVersion => 3;

  @override
  MigrationStrategy get migration => MigrationStrategy(
        onCreate: (m) => m.createAll(),
        onUpgrade: (m, from, to) async {
          if (from < 2) await m.createTable(playback);
          if (from < 3) await m.addColumn(chapters, chapters.durationSec);
        },
      );
}
