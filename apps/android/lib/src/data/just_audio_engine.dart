import 'dart:async';

import 'package:just_audio/just_audio.dart';

import 'audio_engine.dart';

/// Real [AudioEngine] backed by `just_audio`. Thin wrapper — behaviour is
/// validated on a device (no unit tests for the native player).
class JustAudioEngine implements AudioEngine {
  JustAudioEngine() : this._(AndroidLoudnessEnhancer());
  JustAudioEngine._(this._loudness)
      : _player = AudioPlayer(
          audioPipeline: AudioPipeline(androidAudioEffects: [_loudness]),
        ) {
    // just_audio surfaces load/playback failures on playbackEventStream's error
    // channel (a PlayerException). Route them to errorStream for the app-10
    // streaming fallback. The listener never cancels — it lives with the engine.
    _player.playbackEventStream.listen(
      (_) {},
      onError: (Object e, StackTrace _) {
        if (!_errors.isClosed) _errors.add(e);
      },
    );
  }

  final AndroidLoudnessEnhancer _loudness;
  final AudioPlayer _player;
  final _errors = StreamController<Object>.broadcast();

  @override
  Duration get position => _player.position;

  @override
  Stream<Duration> get positionStream => _player.positionStream;

  @override
  bool get playing => _player.playing;

  @override
  Stream<bool> get playingStream => _player.playingStream;

  @override
  Duration? get duration => _player.duration;

  @override
  Stream<Duration?> get durationStream => _player.durationStream;

  @override
  Stream<void> get completionStream => _player.processingStateStream
      .where((s) => s == ProcessingState.completed);

  @override
  Stream<Object> get errorStream => _errors.stream;

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
  Future<void> setVolumeBoost(double db) async {
    await _loudness.setEnabled(db > 0);
    await _loudness.setTargetGain(db); // decibels above unity
  }

  @override
  Future<void> dispose() async {
    await _errors.close();
    await _player.dispose();
  }
}
