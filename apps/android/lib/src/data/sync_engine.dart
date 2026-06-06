import 'dart:async';

import '../domain/sync_manifest.dart';
import '../domain/sync_plan.dart';
import 'chapter_downloader.dart';
import 'local_library.dart';

/// The manifest source the engine pulls from — the typed srv-32 endpoints.
/// Injectable so the engine unit-tests without a real server.
abstract class ManifestApi {
  Future<SyncManifestIndex> index({String? since});
  Future<SyncManifestBookDetail> bookDetail(String bookId);
}

enum SyncPhase { indexing, book, chapter, done }

/// A progress tick the foreground-service notification renders (e.g.
/// "Downloading Book A — ch 3/12").
class SyncProgress {
  const SyncProgress({
    required this.phase,
    this.bookId,
    this.booksDone = 0,
    this.booksTotal = 0,
    this.chaptersDone = 0,
    this.chaptersTotal = 0,
  });
  final SyncPhase phase;
  final String? bookId;
  final int booksDone;
  final int booksTotal;
  final int chaptersDone;
  final int chaptersTotal;
}

/// The outcome of a full sync pass.
class SyncResult {
  const SyncResult({
    required this.chaptersDownloaded,
    required this.chaptersDeferred,
    required this.chaptersEvicted,
    required this.booksEvicted,
    required this.errors,
  });
  final int chaptersDownloaded;
  final int chaptersDeferred;
  final int chaptersEvicted;
  final int booksEvicted;

  /// Per-book failure isolation: a book whose detail/downloads failed records
  /// its error here; the rest of the library still syncs.
  final Map<String, String> errors;
}

/// The delta-sync engine (`app-3`): fetch the srv-32 index, diff against local
/// state, pull each changed book's detail, download only changed/new chapters
/// (keyed by the stable `uuid`), evict what the server dropped, and report
/// progress. Atomic swap is deferred for a chapter the player has open.
class SyncEngine {
  SyncEngine({
    required ManifestApi api,
    required LocalLibrary library,
    required ChapterDownloader downloader,
    required Uri Function(String path) resolveUrl,
    bool Function(String uuid)? isInUse,
  })  : _manifestApi = api,
        _lib = library,
        _chapterDownloader = downloader,
        _resolve = resolveUrl,
        _isInUse = isInUse ?? ((_) => false);

  final ManifestApi _manifestApi;
  final LocalLibrary _lib;
  final ChapterDownloader _chapterDownloader;
  final Uri Function(String path) _resolve;
  final bool Function(String uuid) _isInUse;

  final StreamController<SyncProgress> _progress =
      StreamController<SyncProgress>.broadcast();

  /// Progress ticks for the foreground service / UI.
  Stream<SyncProgress> get progress => _progress.stream;

  Future<void> dispose() => _progress.close();

  Future<SyncResult> sync({String? since}) async {
    var downloaded = 0;
    var deferred = 0;
    var evictedChapters = 0;
    var evictedBooks = 0;
    final errors = <String, String>{};

    _emit(const SyncProgress(phase: SyncPhase.indexing));
    final index = await _manifestApi.index(since: since);
    final localUpdated = await _lib.syncedBookUpdatedAt();
    final indexPlan = planIndexSync(index, localUpdated);

    for (final bookId in indexPlan.bookIdsToEvict) {
      await _lib.evictBook(bookId);
      evictedBooks++;
    }

    final booksTotal = indexPlan.booksToSync.length;
    var booksDone = 0;
    for (final book in indexPlan.booksToSync) {
      _emit(SyncProgress(
        phase: SyncPhase.book,
        bookId: book.bookId,
        booksDone: booksDone,
        booksTotal: booksTotal,
      ));
      try {
        final detail = await _manifestApi.bookDetail(book.bookId);
        final localFp = await _lib.chapterFingerprints(book.bookId);
        final bookPlan = planBookSync(detail, localFp);

        for (final uuid in bookPlan.chapterUuidsToEvict) {
          await _lib.evictChapter(book.bookId, uuid);
          evictedChapters++;
        }

        final chaptersTotal = bookPlan.chaptersToDownload.length;
        var chaptersDone = 0;
        var bookDeferred = 0;
        var bookFailed = false;
        for (final c in bookPlan.chaptersToDownload) {
          _emit(SyncProgress(
            phase: SyncPhase.chapter,
            bookId: book.bookId,
            booksDone: booksDone,
            booksTotal: booksTotal,
            chaptersDone: chaptersDone,
            chaptersTotal: chaptersTotal,
          ));
          try {
            final defer = _isInUse(c.uuid);
            final outcome = await _chapterDownloader.download(
              url: _resolve(c.audioUrl!),
              finalPath: _lib.audioPath(book.bookId, c.uuid, c.urlSuffix!),
              expectedSize: c.expectedSize,
              commit: !defer,
            );
            if (outcome.committed) {
              await _lib.recordChapter(
                  book.bookId, c.uuid, c.fingerprint!, c.urlSuffix!);
              downloaded++;
            } else {
              deferred++;
              bookDeferred++;
            }
          } catch (e) {
            bookFailed = true;
            errors[book.bookId] = '$e';
          }
          chaptersDone++;
        }

        // Only stamp the book as synced when everything actually landed — a
        // deferred or failed chapter leaves it dirty so the next pass retries.
        if (!bookFailed && bookDeferred == 0) {
          await _lib.setBookUpdatedAt(book.bookId, detail.updatedAt);
        }
      } catch (e) {
        errors[book.bookId] = '$e';
      }
      booksDone++;
    }

    _emit(SyncProgress(
      phase: SyncPhase.done,
      booksDone: booksDone,
      booksTotal: booksTotal,
    ));

    return SyncResult(
      chaptersDownloaded: downloaded,
      chaptersDeferred: deferred,
      chaptersEvicted: evictedChapters,
      booksEvicted: evictedBooks,
      errors: errors,
    );
  }

  void _emit(SyncProgress p) {
    if (!_progress.isClosed) _progress.add(p);
  }
}
