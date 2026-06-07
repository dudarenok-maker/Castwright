import 'dart:async';

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
  Duration? get duration => _player.duration;

  @override
  Stream<Duration?> get durationStream => _player.durationStream;

  @override
  Stream<void> get completionStream => _player.processingStateStream
      .where((s) => s == ProcessingState.completed);

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
  Future<void> play() async {
    // just_audio's play() Future resolves only when playback ENDS; we only want
    // to START playback and return, so fire-and-forget it.
    unawaited(_player.play());
  }

  @override
  Future<void> pause() => _player.pause();

  @override
  Future<void> seek(Duration position) => _player.seek(position);

  @override
  Future<void> setSpeed(double speed) => _player.setSpeed(speed);

  @override
  Future<void> dispose() => _player.dispose();
}
