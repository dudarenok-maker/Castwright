/// The audio playback engine seam (`app-5`). The real adapter wraps
/// `just_audio`; injectable so the [PlayerController] unit-tests without native
/// audio.
abstract class AudioEngine {
  Future<void> setFilePath(String path);

  /// Stream a remote chapter URL with auth headers — `app-10` LAN instant play.
  Future<void> setStreamUrl(String url, {Map<String, String>? headers});
  Future<void> play();
  Future<void> pause();
  Future<void> seek(Duration position);
  Future<void> setSpeed(double speed);

  /// Boost loudness above the source's unity (decibels, 0 = off). `setVolume`
  /// can only attenuate; this adds gain (Android LoudnessEnhancer) so a quiet
  /// −16 LUFS master can be lifted on-device.
  Future<void> setVolumeBoost(double db);

  /// Current playback position.
  Duration get position;

  /// Position ticks (drive the autosave throttle).
  Stream<Duration> get positionStream;

  /// Loaded media duration (null until known).
  Duration? get duration;
  Stream<Duration?> get durationStream;

  /// Fires once each time the loaded track plays to its end (drives
  /// auto-advance to the next chapter).
  Stream<void> get completionStream;

  Future<void> dispose();
}
