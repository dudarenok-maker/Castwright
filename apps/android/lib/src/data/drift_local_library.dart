import 'dart:convert';

import 'package:drift/drift.dart';

import '../domain/storage_policy.dart';
import 'cover_thumbnails.dart' show ThumbnailStore;
import 'file_store.dart';
import 'library_database.dart';
import 'local_library.dart';
import 'playback_store.dart';

/// Display-oriented book row for list/grid UIs (`app-7`).
class BookSummary {
  const BookSummary({
    required this.bookId,
    required this.title,
    required this.author,
    required this.series,
    required this.seriesPosition,
    required this.lastPlayedAt,
    required this.coverThumbPath,
    required this.hidden,
  });
  final String bookId;
  final String title;
  final String author;
  final String series;
  final int? seriesPosition;
  final String? lastPlayedAt;
  final String? coverThumbPath;
  final bool hidden;
}

/// A locally-stored chapter (the offline source for the player + durations).
class DownloadedChapter {
  const DownloadedChapter({
    required this.uuid,
    required this.chapterId,
    required this.title,
    required this.durationSec,
    required this.urlSuffix,
    this.bytes = 0,
  });
  final String uuid;
  final int chapterId;
  final String title;
  final double? durationSec;
  final String? urlSuffix;

  /// On-disk byte size of the downloaded audio (0 when the file is absent —
  /// e.g. a finished chapter whose file was evicted but whose row remains).
  /// The Android Auto browse tree filters to `bytes > 0` so only playable
  /// chapters appear in the car.
  final int bytes;
}

/// The production on-device store (`app-4`): a drift/SQLite-backed
/// [LocalLibrary] (so the `app-3` sync engine runs against it unchanged) plus
/// storage accounting, the eviction-plan applier, play/finished tracking, cover
/// thumbnail paths, and a one-time import of the `app-3` JSON snapshot.
///
/// Per-chapter audio lives at `<root>/books/<bookId>/<uuid>/<urlSuffix>` — the
/// same scheme as the `app-3` [FileLocalLibrary] it supersedes.
class DriftLocalLibrary implements LocalLibrary, PlaybackStore, ThumbnailStore {
  DriftLocalLibrary(this._db, this._fs, {required String root}) : _rootPath = root;

  final LibraryDatabase _db;
  final FileStore _fs;
  final String _rootPath;

  String _bookDir(String bookId) => '$_rootPath/books/$bookId';
  String _chapterDir(String bookId, String uuid) => '${_bookDir(bookId)}/$uuid';

  Future<void> close() => _db.close();

  Future<void> _ensureBook(String bookId) async {
    await _db.into(_db.books).insert(
          BooksCompanion.insert(bookId: bookId),
          mode: InsertMode.insertOrIgnore,
        );
  }

  // --- LocalLibrary port (consumed by the app-3 sync engine) ---------------

  @override
  String audioPath(String bookId, String uuid, String urlSuffix) =>
      '${_chapterDir(bookId, uuid)}/$urlSuffix';

  @override
  Future<Map<String, String>> syncedBookUpdatedAt() async {
    final rows = await _db.select(_db.books).get();
    return {for (final r in rows) r.bookId: r.updatedAt};
  }

  @override
  Future<Map<String, String>> chapterFingerprints(String bookId) async {
    final rows = await (_db.select(_db.chapters)
          ..where((c) => c.bookId.equals(bookId)))
        .get();
    return {for (final r in rows) r.uuid: r.fingerprint ?? ''};
  }

  @override
  Future<void> recordChapter(
      String bookId, String uuid, String fingerprint, String urlSuffix) async {
    await _ensureBook(bookId);
    final size = await _fs.size(audioPath(bookId, uuid, urlSuffix));
    final bytes = size < 0 ? 0 : size;
    final existing = await (_db.select(_db.chapters)
          ..where((c) => c.uuid.equals(uuid)))
        .getSingleOrNull();
    if (existing == null) {
      await _db.into(_db.chapters).insert(ChaptersCompanion.insert(
            uuid: uuid,
            bookId: bookId,
            chapterId: 0,
            fingerprint: Value(fingerprint),
            urlSuffix: Value(urlSuffix),
            bytes: Value(bytes),
          ));
    } else {
      // Update only the sync-critical columns; leave chapterId/title/finished.
      await (_db.update(_db.chapters)..where((c) => c.uuid.equals(uuid))).write(
        ChaptersCompanion(
          bookId: Value(bookId),
          fingerprint: Value(fingerprint),
          urlSuffix: Value(urlSuffix),
          bytes: Value(bytes),
        ),
      );
    }
  }

  /// Like [recordChapter] but also persists chapter id/title/duration from the
  /// manifest detail, so the player + library work OFFLINE. Preserves the
  /// `finished` flag on re-download.
  Future<void> recordChapterMeta({
    required String bookId,
    required String uuid,
    required int chapterId,
    required String title,
    required String fingerprint,
    required String urlSuffix,
    double? durationSec,
  }) async {
    await _ensureBook(bookId);
    final size = await _fs.size(audioPath(bookId, uuid, urlSuffix));
    final bytes = size < 0 ? 0 : size;
    final existing = await (_db.select(_db.chapters)
          ..where((c) => c.uuid.equals(uuid)))
        .getSingleOrNull();
    if (existing == null) {
      await _db.into(_db.chapters).insert(ChaptersCompanion.insert(
            uuid: uuid,
            bookId: bookId,
            chapterId: chapterId,
            title: Value(title),
            fingerprint: Value(fingerprint),
            urlSuffix: Value(urlSuffix),
            bytes: Value(bytes),
            durationSec: Value(durationSec),
          ));
    } else {
      await (_db.update(_db.chapters)..where((c) => c.uuid.equals(uuid))).write(
        ChaptersCompanion(
          bookId: Value(bookId),
          chapterId: Value(chapterId),
          title: Value(title),
          fingerprint: Value(fingerprint),
          urlSuffix: Value(urlSuffix),
          bytes: Value(bytes),
          durationSec: Value(durationSec),
        ),
      );
    }
  }

  /// Locally-stored chapters for a book, ordered by positional id — the
  /// offline source for the player playlist + chapter list + durations.
  Future<List<DownloadedChapter>> chaptersForBook(String bookId) async {
    final rows = await (_db.select(_db.chapters)
          ..where((c) => c.bookId.equals(bookId))
          ..orderBy([(c) => OrderingTerm(expression: c.chapterId)]))
        .get();
    return [
      for (final r in rows)
        DownloadedChapter(
          uuid: r.uuid,
          chapterId: r.chapterId,
          title: r.title,
          durationSec: r.durationSec,
          urlSuffix: r.urlSuffix,
          bytes: r.bytes,
        ),
    ];
  }

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

  /// Chapters with no persisted peaks yet — the work-list for the connect-time
  /// backfill sweep. Scoped to rows with a `fingerprint` (a rendered chapter)
  /// and a real `chapterId` (> 0, so the peaks URL is usable); excludes
  /// finished-evicted rows (fingerprint cleared) and id-0 legacy rows. Does not
  /// check `bytes`, so a metadata-synced chapter not yet downloaded is included.
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

  @override
  Future<void> setBookUpdatedAt(String bookId, String updatedAt) async {
    await _ensureBook(bookId);
    await (_db.update(_db.books)..where((b) => b.bookId.equals(bookId)))
        .write(BooksCompanion(updatedAt: Value(updatedAt)));
  }

  @override
  Future<void> evictChapter(String bookId, String uuid) async {
    await (_db.delete(_db.chapters)..where((c) => c.uuid.equals(uuid))).go();
    await _fs.deleteDir(_chapterDir(bookId, uuid));
  }

  @override
  Future<void> evictBook(String bookId) async {
    await (_db.delete(_db.chapters)..where((c) => c.bookId.equals(bookId))).go();
    await (_db.delete(_db.books)..where((b) => b.bookId.equals(bookId))).go();
    await _fs.deleteDir(_bookDir(bookId));
  }

  /// Remove ALL downloaded books + their audio files (reclaims all storage).
  /// Pairing + settings are untouched.
  Future<void> clearAllBooks() async {
    for (final b in await listBooks()) {
      await evictBook(b.bookId);
    }
  }

  // --- app-4 store extensions ---------------------------------------------

  /// Per-book usage for the storage-eviction policy.
  Future<List<BookUsage>> bookUsages() async {
    final books = await _db.select(_db.books).get();
    final chapters = await _db.select(_db.chapters).get();
    final byBook = <String, List<ChapterUsage>>{};
    for (final c in chapters) {
      (byBook[c.bookId] ??= []).add(
        ChapterUsage(uuid: c.uuid, bytes: c.bytes, finished: c.finished),
      );
    }
    return [
      for (final b in books)
        BookUsage(
          bookId: b.bookId,
          lastPlayedAt: b.lastPlayedAt,
          chapters: byBook[b.bookId] ?? const [],
        ),
    ];
  }

  Future<int> totalBytes() async {
    final rows = await _db.select(_db.chapters).get();
    return rows.fold<int>(0, (sum, c) => sum + c.bytes);
  }

  Future<void> markPlayed(String bookId, String isoNow) async {
    await _ensureBook(bookId);
    await (_db.update(_db.books)..where((b) => b.bookId.equals(bookId)))
        .write(BooksCompanion(
      lastPlayedAt: Value(isoNow),
      hidden: const Value(false), // replaying un-hides from the shelf
    ));
  }

  /// Hide/un-hide a book from the "Continue listening" shelf without touching
  /// its resume point or chapter ticks (manual long-press remove).
  Future<void> setBookHidden(String bookId, bool hidden) async {
    await _ensureBook(bookId);
    await (_db.update(_db.books)..where((b) => b.bookId.equals(bookId)))
        .write(BooksCompanion(hidden: Value(hidden)));
  }

  /// Mark a whole book finished: tick every chapter and drop it from the shelf.
  /// Reversible — markPlayed (replay) clears `hidden`.
  Future<void> markBookFinished(String bookId) async {
    await (_db.update(_db.chapters)..where((c) => c.bookId.equals(bookId)))
        .write(const ChaptersCompanion(finished: Value(true)));
    await setBookHidden(bookId, true);
  }

  Future<void> setChapterFinished(String uuid, bool finished) async {
    await (_db.update(_db.chapters)..where((c) => c.uuid.equals(uuid)))
        .write(ChaptersCompanion(finished: Value(finished)));
  }

  /// The uuids of [bookId]'s chapters the user has played to the end
  /// (the persisted `finished` flag). Drives the chapter-list "done" check.
  Future<Set<String>> finishedChapterUuids(String bookId) async {
    final rows = await (_db.select(_db.chapters)
          ..where((c) => c.bookId.equals(bookId) & c.finished.equals(true)))
        .get();
    return {for (final r in rows) r.uuid};
  }

  /// Apply a [planStorageEviction] result: drop finished chapter files (keep the
  /// row, clear fingerprint + bytes) and evict whole books.
  Future<void> applyEviction(EvictionPlan plan) async {
    for (final ref in plan.chapterFilesToDrop) {
      await _fs.deleteDir(_chapterDir(ref.bookId, ref.uuid));
      await (_db.update(_db.chapters)..where((c) => c.uuid.equals(ref.uuid)))
          .write(const ChaptersCompanion(
        fingerprint: Value(null),
        bytes: Value(0),
      ));
    }
    for (final bookId in plan.booksToEvict) {
      await evictBook(bookId);
    }
  }

  Future<void> upsertBookMeta({
    required String bookId,
    required String title,
    required String author,
    required String series,
    int? seriesPosition,
  }) async {
    await _ensureBook(bookId);
    await (_db.update(_db.books)..where((b) => b.bookId.equals(bookId))).write(
      BooksCompanion(
        title: Value(title),
        author: Value(author),
        series: Value(series),
        seriesPosition: Value(seriesPosition),
      ),
    );
  }

  Future<List<BookSummary>> listBooks() async {
    final rows = await _db.select(_db.books).get();
    return [
      for (final b in rows)
        BookSummary(
          bookId: b.bookId,
          title: b.title,
          author: b.author,
          series: b.series,
          seriesPosition: b.seriesPosition,
          lastPlayedAt: b.lastPlayedAt,
          coverThumbPath: b.coverThumbPath,
          hidden: b.hidden,
        ),
    ];
  }

  @override
  Future<String?> coverThumbPath(String bookId) async {
    final row = await (_db.select(_db.books)
          ..where((b) => b.bookId.equals(bookId)))
        .getSingleOrNull();
    return row?.coverThumbPath;
  }

  @override
  Future<void> setCoverThumbPath(String bookId, String path) async {
    await _ensureBook(bookId);
    await (_db.update(_db.books)..where((b) => b.bookId.equals(bookId)))
        .write(BooksCompanion(coverThumbPath: Value(path)));
  }

  // --- PlaybackStore (app-5) ----------------------------------------------

  @override
  Future<void> savePlayback(
      String bookId, String chapterUuid, int positionMs, String isoNow) async {
    await _db.into(_db.playback).insertOnConflictUpdate(PlaybackCompanion.insert(
          bookId: bookId,
          chapterUuid: chapterUuid,
          positionMs: Value(positionMs),
          updatedAt: Value(isoNow),
        ));
  }

  @override
  Future<PlaybackPoint?> loadPlayback(String bookId) async {
    final row = await (_db.select(_db.playback)
          ..where((p) => p.bookId.equals(bookId)))
        .getSingleOrNull();
    if (row == null) return null;
    return PlaybackPoint(
      chapterUuid: row.chapterUuid,
      positionMs: row.positionMs,
      listenedAt: row.updatedAt,
    );
  }

  /// The `bookId` with the most recent resume activity (max `playback.updatedAt`),
  /// or null if nothing has ever been played. Drives the Android Auto "current
  /// book" tab on cold connect, when no book is loaded in the player yet.
  Future<String?> mostRecentlyPlayedBookId() async {
    final row = await (_db.select(_db.playback)
          ..orderBy(
              [(p) => OrderingTerm(expression: p.updatedAt, mode: OrderingMode.desc)])
          ..limit(1))
        .getSingleOrNull();
    return row?.bookId;
  }

  /// One-time migration: if the `app-3` JSON snapshot exists under [_rootPath],
  /// import its books + chapters into drift (statting each on-disk file for
  /// byte accounting), then delete it so this runs once.
  Future<void> importLegacyJsonIfPresent() async {
    final path = '$_rootPath/sync-state.json';
    final bytes = await _fs.read(path);
    if (bytes == null) return;

    final decoded = jsonDecode(utf8.decode(bytes));
    if (decoded is Map<String, dynamic>) {
      final books = (decoded['books'] as Map?)?.cast<String, dynamic>() ?? {};
      for (final entry in books.entries) {
        final bookId = entry.key;
        final book = (entry.value as Map).cast<String, dynamic>();
        await setBookUpdatedAt(bookId, book['updatedAt'] as String? ?? '');
        final chapters =
            (book['chapters'] as Map?)?.cast<String, dynamic>() ?? {};
        for (final ce in chapters.entries) {
          final c = (ce.value as Map).cast<String, dynamic>();
          await recordChapter(
            bookId,
            ce.key,
            c['fingerprint'] as String? ?? '',
            c['urlSuffix'] as String? ?? 'audio.mp3',
          );
        }
      }
    }
    await _fs.delete(path);
  }
}
