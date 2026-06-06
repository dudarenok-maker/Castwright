/// A per-book playback resume point — the chapter + offset to restore.
class PlaybackPoint {
  const PlaybackPoint({required this.chapterUuid, required this.positionMs});
  final String chapterUuid;
  final int positionMs;
}

/// The store seam the player persists/restores resume points through
/// (satisfied by `DriftLocalLibrary`). Injectable so the player controller
/// unit-tests without drift.
abstract class PlaybackStore {
  Future<void> savePlayback(
      String bookId, String chapterUuid, int positionMs, String isoNow);
  Future<PlaybackPoint?> loadPlayback(String bookId);
}
