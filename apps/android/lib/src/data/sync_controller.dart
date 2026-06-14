import '../domain/library_tree.dart';
import '../domain/sync_manifest.dart';
import '../domain/sync_plan.dart';
import 'chapter_downloader.dart';
import 'drift_local_library.dart';
import 'player_controller.dart';
import 'sync_engine.dart' show ManifestApi;

/// App-shell sync orchestration (the integration glue over the app-3 engine
/// pieces): load the cheap manifest **index** to populate the library, then
/// **download one book on demand** (so we don't pull a whole multi-book library
/// at once). Per-book download reuses the `planBookSync` delta — a re-download
/// after a server regen pulls only the changed chapters.
class SyncController {
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
        _peaksFetcher = peaksFetcher ?? ((b, c) async => const []);

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

  /// Last fetched detail per book — drives the player playlist in-session.
  final Map<String, SyncManifestBookDetail> _details = {};

  /// Fetch the index, record each book's display metadata locally, and return
  /// the book rows for the library UI. No audio is downloaded.
  Future<List<SyncManifestIndexBook>> loadIndex() async {
    final index = await _api.index();
    for (final b in index.books) {
      await _library.upsertBookMeta(
        bookId: b.bookId,
        title: b.title,
        author: b.author,
        series: b.series,
        seriesPosition: b.seriesPosition?.toInt(), // drift col is int; display uses the index double
      );
    }
    return index.books;
  }

  /// Load the index AND compute each book's download state for the library UI:
  /// not-downloaded, downloaded, or **update-available** (downloaded but the
  /// server's `updatedAt` moved past what we last synced — something changed
  /// since the last connect).
  Future<List<LibraryBook>> loadLibrary() async {
    final books = await loadIndex();
    final localUpdated = await _library.syncedBookUpdatedAt();
    final result = <LibraryBook>[];
    for (final b in books) {
      final downloaded = (await _library.chapterFingerprints(b.bookId)).isNotEmpty;
      final BookDownloadState state;
      if (!downloaded) {
        state = BookDownloadState.notDownloaded;
      } else if ((localUpdated[b.bookId] ?? '').compareTo(b.updatedAt) < 0) {
        state = BookDownloadState.updateAvailable;
      } else {
        state = BookDownloadState.downloaded;
      }
      result.add(LibraryBook(
        bookId: b.bookId,
        title: b.title,
        author: b.author,
        series: b.series,
        seriesPosition: b.seriesPosition,
        downloadState: state,
      ));
    }
    return result;
  }

  /// Download (or delta-update) one book's chapters. Pulls only chapters that
  /// are new or whose fingerprint changed.
  Future<void> downloadBook(
    String bookId, {
    void Function(int done, int total)? onProgress,
  }) async {
    final detail = await _api.bookDetail(bookId);
    _details[bookId] = detail;
    final localFp = await _library.chapterFingerprints(bookId);
    final plan = planBookSync(detail, localFp);
    final total = plan.chaptersToDownload.length;
    var done = 0;
    onProgress?.call(done, total);
    for (final c in plan.chaptersToDownload) {
      await _downloader.download(
        url: _resolveUrl(c.audioUrl!),
        finalPath: _library.audioPath(bookId, c.uuid, c.urlSuffix!),
        expectedSize: c.expectedSize,
      );
      await _library.recordChapterMeta(
        bookId: bookId,
        uuid: c.uuid,
        chapterId: c.id,
        title: c.title,
        fingerprint: c.fingerprint!,
        urlSuffix: c.urlSuffix!,
        durationSec: c.durationSec,
      );
      final peaks = await _peaksFetcher(bookId, c.id);
      if (peaks.isNotEmpty) await _library.savePeaks(c.uuid, peaks);
      done++;
      onProgress?.call(done, total);
    }
    await _library.setBookUpdatedAt(bookId, detail.updatedAt);
  }

  /// Ensure the book's detail (chapter order/paths) is loaded in-session so
  /// [playlistFor]/[chaptersOf] work. Falls back to a detail SYNTHESIZED from
  /// the local drift store when the server is unreachable (OFFLINE playback).
  Future<void> ensureDetail(String bookId) async {
    if (_details.containsKey(bookId)) return;
    try {
      _details[bookId] = await _api.bookDetail(bookId);
    } catch (_) {
      final local = await _library.chaptersForBook(bookId);
      if (local.isEmpty) rethrow; // nothing local AND offline → real failure
      _details[bookId] = SyncManifestBookDetail(
        schemaVersion: 1,
        bookId: bookId,
        updatedAt: '',
        chapters: [
          for (final c in local)
            SyncManifestChapter(
              uuid: c.uuid,
              id: c.chapterId,
              title: c.title,
              fingerprint: 'local', // non-null → hasAudio true
              urlSuffix: c.urlSuffix,
              durationSec: c.durationSec,
              audioUrl: c.urlSuffix != null
                  ? '/api/books/$bookId/chapters/${c.chapterId}/${c.urlSuffix}'
                  : null,
            ),
        ],
        activeChapterUuids: [for (final c in local) c.uuid],
      );
    }
  }

  /// Build the library from the LOCAL drift store only (offline) — all books
  /// present on disk, marked downloaded.
  Future<List<LibraryBook>> loadLocalLibrary() async {
    final books = await _library.listBooks();
    return [
      for (final b in books)
        LibraryBook(
          bookId: b.bookId,
          title: b.title,
          author: b.author,
          series: b.series,
          seriesPosition: b.seriesPosition?.toDouble(),
          downloadState: BookDownloadState.downloaded,
        ),
    ];
  }

  /// True once the book has at least one downloaded chapter on disk.
  Future<bool> isBookDownloaded(String bookId) async =>
      (await _library.chapterFingerprints(bookId)).isNotEmpty;

  /// The book's chapters (uuid + title) from the in-session detail, for a
  /// chapter-picker UI. Empty until the detail has been loaded.
  List<SyncManifestChapter> chaptersOf(String bookId) =>
      _details[bookId]?.chapters ?? const [];

  /// Ordered, locally-playable chapters for a book (from the in-session detail).
  List<PlayableChapter> playlistFor(String bookId) {
    final detail = _details[bookId];
    if (detail == null) return const [];
    return [
      for (final c in detail.chapters)
        if (c.hasAudio)
          PlayableChapter(
            uuid: c.uuid,
            path: _library.audioPath(bookId, c.uuid, c.urlSuffix!),
            title: c.title,
            durationSec: c.durationSec,
          ),
    ];
  }

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
}
