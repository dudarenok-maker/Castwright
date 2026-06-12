import '../data/audio_engine.dart';

/// A posed [AudioEngine] for marketing capture: no native audio, a fixed
/// "playing" state at a fixed position/duration so the player renders a static,
/// deterministic now-playing frame. All control methods are no-ops.
class DemoAudioEngine implements AudioEngine {
  DemoAudioEngine({
    Duration position = const Duration(minutes: 7, seconds: 12),
    Duration duration = const Duration(minutes: 23, seconds: 40),
  })  : _position = position,
        _duration = duration;

  final Duration _position;
  final Duration _duration;

  @override
  Duration get position => _position;
  @override
  Stream<Duration> get positionStream => Stream<Duration>.value(_position);

  @override
  Duration? get duration => _duration;
  @override
  Stream<Duration?> get durationStream => Stream<Duration?>.value(_duration);

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
