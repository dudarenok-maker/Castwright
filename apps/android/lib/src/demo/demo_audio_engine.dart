import '../data/audio_engine.dart';

/// A posed [AudioEngine] for marketing capture: no native audio, a fixed
/// "playing" state at a fixed position/duration so the player renders a static,
/// deterministic now-playing frame. All control methods are no-ops.
class DemoAudioEngine implements AudioEngine {
  DemoAudioEngine({
    this.position = const Duration(minutes: 7, seconds: 12),
    this.duration = const Duration(minutes: 23, seconds: 40),
  });

  @override
  final Duration position;
  @override
  Stream<Duration> get positionStream => Stream<Duration>.value(position);

  /// Non-null here; overrides the interface's nullable [AudioEngine.duration].
  @override
  final Duration duration;
  @override
  Stream<Duration?> get durationStream => Stream<Duration?>.value(duration);

  @override
  bool get playing => true;
  @override
  Stream<bool> get playingStream => Stream<bool>.value(true);

  @override
  Stream<void> get completionStream => const Stream<void>.empty();

  @override
  Future<void> setFilePath(String path) async {}
  @override
  Future<void> setStreamUrl(String url, {Map<String, String>? headers}) async {}
  @override
  Future<void> play() async {}
  @override
  Future<void> pause() async {}
  @override
  Future<void> seek(Duration position) async {}
  @override
  Future<void> setSpeed(double speed) async {}
  @override
  Future<void> setVolumeBoost(double db) async {}
  @override
  Future<void> dispose() async {}
}
