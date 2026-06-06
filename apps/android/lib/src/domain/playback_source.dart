/// Pure playback-source decision (`app-10`). Offline-first: a downloaded chapter
/// always plays its local file; a not-yet-downloaded chapter may **stream over
/// the home LAN** for instant play when the user opted in and the server is
/// reachable, otherwise it must be downloaded first.
library;

enum PlaybackSource { localFile, lanStream, needsDownload }

PlaybackSource resolvePlaybackSource({
  required bool localFileExists,
  required bool onHomeLan,
  required bool streamingEnabled,
}) {
  if (localFileExists) return PlaybackSource.localFile;
  if (streamingEnabled && onHomeLan) return PlaybackSource.lanStream;
  return PlaybackSource.needsDownload;
}
