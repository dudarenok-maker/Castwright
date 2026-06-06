import '../domain/resume_reconcile.dart';
import 'playback_store.dart';

/// A server listen-progress record (the subset the companion needs).
class RemoteProgress {
  const RemoteProgress({
    required this.chapterUuid,
    required this.chapterId,
    required this.currentSec,
    required this.updatedAt,
  });

  /// srv-35 stable uuid (preferred local key); null on pre-srv-35 records.
  final String? chapterUuid;
  final int chapterId;
  final double currentSec;
  final String updatedAt;
}

/// The listen-progress endpoints the resume sync uses. Injectable so the
/// service unit-tests without HTTP (the real impl is [ApiClient]).
abstract class ListenProgressApi {
  /// GET; null when the server has no record (404).
  Future<RemoteProgress?> getListenProgress(String bookId);

  /// PUT with the client [listenedAt] (srv-34) so last-write-wins by listen time.
  Future<void> putListenProgress(
    String bookId, {
    required int chapterId,
    required double currentSec,
    required String listenedAt,
  });
}

/// Maps a local chapter `uuid` to its current positional `chapterId` (the PUT
/// body keys by id). Injectable; wired to the local store / manifest later.
typedef ChapterIdResolver = Future<int?> Function(String bookId, String chapterUuid);

/// Two-way resume sync (`app-6`): reconciles the local resume point with the
/// server's by **listen time** (`srv-34`), pushing or pulling accordingly. The
/// local store IS the offline queue — whatever the player saved offline is
/// pushed on the next reachable sync.
class ResumeSyncService {
  ResumeSyncService({
    required ListenProgressApi progressApi,
    required PlaybackStore playbackStore,
    required ChapterIdResolver chapterIdResolver,
  })  : _api = progressApi,
        _store = playbackStore,
        _resolveChapterId = chapterIdResolver;

  final ListenProgressApi _api;
  final PlaybackStore _store;
  final ChapterIdResolver _resolveChapterId;

  Future<ResumeAction> syncBook(String bookId) async {
    final remote = await _api.getListenProgress(bookId);
    final local = await _store.loadPlayback(bookId);
    final localListenedAt =
        (local != null && local.listenedAt.isNotEmpty) ? local.listenedAt : null;

    final action = reconcileResume(
      localListenedAt: localListenedAt,
      remoteUpdatedAt: remote?.updatedAt,
    );

    switch (action) {
      case ResumeAction.pushLocal:
        if (local != null) {
          final id = await _resolveChapterId(bookId, local.chapterUuid);
          if (id != null) {
            await _api.putListenProgress(
              bookId,
              chapterId: id,
              currentSec: local.positionMs / 1000.0,
              listenedAt: local.listenedAt,
            );
          }
        }
      case ResumeAction.pullRemote:
        if (remote?.chapterUuid != null) {
          await _store.savePlayback(
            bookId,
            remote!.chapterUuid!,
            (remote.currentSec * 1000).round(),
            remote.updatedAt,
          );
        }
      case ResumeAction.noop:
        break;
    }
    return action;
  }

  Future<void> syncAll(List<String> bookIds) async {
    for (final id in bookIds) {
      await syncBook(id);
    }
  }
}
