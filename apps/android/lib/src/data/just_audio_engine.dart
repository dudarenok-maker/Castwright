import 'package:just_audio/just_audio.dart';

import 'audio_engine.dart';

/// Real [AudioEngine] backed by `just_audio`. Thin wrapper — behaviour is
/// validated on a device (no unit tests for the native player).
class JustAudioEngine implements AudioEngine {
  final AudioPlayer _player = AudioPlayer();

  @override
  Duration get position => _player.position;

  @override
  Stream<Duration> get positionStream => _player.positionStream;

  @override
  Future<void> setFilePath(String path) async {
    await _player.setFilePath(path);
  }

  @override
  Future<void> setStreamUrl(String url, {Map<String, String>? headers}) async {
    await _player.setAudioSource(
      AudioSource.uri(Uri.parse(url), headers: headers),
    );
  }

  @override
  Future<void> play() => _player.play();

  @override
  Future<void> pause() => _player.pause();

  @override
  Future<void> seek(Duration position) => _player.seek(position);

  @override
  Future<void> setSpeed(double speed) => _player.setSpeed(speed);

  @override
  Future<void> dispose() => _player.dispose();
}
