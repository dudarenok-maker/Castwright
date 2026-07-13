import 'dart:async';

import '../data/audio_engine.dart';

/// Interactive demo [AudioEngine] for the app-20 on-device guest mode: position
/// advances on a timer with NO real audio, so a reviewer sees the player respond
/// to play/pause/seek/speed. Streams are broadcast — the player subscribes
/// positionStream/durationStream from multiple widgets — and [dispose] cancels
/// the timer so no emission outlives an exit-demo teardown.
class DemoTickingAudioEngine implements AudioEngine {
  DemoTickingAudioEngine({
    Duration duration = const Duration(minutes: 23, seconds: 40),
    Duration tick = const Duration(milliseconds: 500),
  })  : _duration = duration,
        _tick = tick;

  final Duration _duration;
  final Duration _tick;

  Duration _position = Duration.zero;
  bool _playing = false;
  double _speed = 1.0;
  Timer? _timer;

  final _positionCtl = StreamController<Duration>.broadcast();
  final _playingCtl = StreamController<bool>.broadcast();
  final _durationCtl = StreamController<Duration?>.broadcast();
  final _completionCtl = StreamController<void>.broadcast();

  @override
  Duration get position => _position;
  @override
  Stream<Duration> get positionStream => _positionCtl.stream;
  @override
  bool get playing => _playing;
  @override
  Stream<bool> get playingStream => _playingCtl.stream;
  @override
  Duration? get duration => _duration;
  @override
  Stream<Duration?> get durationStream => _durationCtl.stream;
  @override
  Stream<void> get completionStream => _completionCtl.stream;

  void _setPlaying(bool v) {
    _playing = v;
    if (!_positionCtl.isClosed) _playingCtl.add(v);
    _timer?.cancel();
    _timer = null;
    if (v) {
      _timer = Timer.periodic(_tick, (_) {
        final next = _position + _tick * _speed;
        if (next >= _duration) {
          _position = _duration;
          _positionCtl.add(_position);
          _setPlaying(false);
          _completionCtl.add(null);
          return;
        }
        _position = next;
        _positionCtl.add(_position);
      });
    }
  }

  @override
  Future<void> setFilePath(String path) async {
    if (!_durationCtl.isClosed) _durationCtl.add(_duration);
  }

  @override
  Future<void> setStreamUrl(String url, {Map<String, String>? headers}) async {
    if (!_durationCtl.isClosed) _durationCtl.add(_duration);
  }

  @override
  Future<void> play() async => _setPlaying(true);
  @override
  Future<void> pause() async => _setPlaying(false);

  @override
  Future<void> seek(Duration position) async {
    _position = position < Duration.zero
        ? Duration.zero
        : (position > _duration ? _duration : position);
    if (!_positionCtl.isClosed) _positionCtl.add(_position);
  }

  @override
  Future<void> setSpeed(double speed) async => _speed = speed;
  @override
  Future<void> setVolumeBoost(double db) async {}

  @override
  Future<void> dispose() async {
    _timer?.cancel();
    _timer = null;
    await _positionCtl.close();
    await _playingCtl.close();
    await _durationCtl.close();
    await _completionCtl.close();
  }
}
