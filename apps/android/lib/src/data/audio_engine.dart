/// The audio playback engine seam (`app-5`). The real adapter wraps
/// `just_audio`; injectable so the [PlayerController] unit-tests without native
/// audio.
abstract class AudioEngine {
  Future<void> setFilePath(String path);
  Future<void> play();
  Future<void> pause();
  Future<void> seek(Duration position);
  Future<void> setSpeed(double speed);

  /// Current playback position.
  Duration get position;

  /// Position ticks (drive the autosave throttle).
  Stream<Duration> get positionStream;

  Future<void> dispose();
}
