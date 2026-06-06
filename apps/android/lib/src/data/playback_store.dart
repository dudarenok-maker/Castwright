/// A per-book playback resume point — the chapter + offset to restore.
class PlaybackPoint {
  const PlaybackPoint({
    required this.chapterUuid,
    required this.positionMs,
    this.listenedAt = '',
  });
  final String chapterUuid;
  final int positionMs;

  /// ISO wall-clock time the position was recorded (`app-6` last-write-wins key).
  final String listenedAt;
}

/// The store seam the player persists/restores resume points through
/// (satisfied by `DriftLocalLibrary`). Injectable so the player controller
/// unit-tests without drift.
abstract class PlaybackStore {
  Future<void> savePlayback(
      String bookId, String chapterUuid, int positionMs, String isoNow);
  Future<PlaybackPoint?> loadPlayback(String bookId);
}
