import 'dart:async';

import '../data/audio_engine.dart';

/// Interactive demo [AudioEngine] for the app-20 on-device guest mode: position
/// advances on a timer with NO real audio, so a reviewer sees the player respond
/// to play/pause/seek/speed. Streams are broadcast — the player subscribes
/// positionStream/durationStream from multiple widgets — and [dispose] cancels
/// the timer so no emission outlives an exit-demo teardown.
class DemoTickingAudioEngine implements AudioEngine {
  DemoTickingAudioEngine({
    this.duration = const Duration(minutes: 23, seconds: 40),
    this.tick = const Duration(milliseconds: 500),
  });

  @override
  final Duration duration;

  /// Simulated playback time advanced per timer tick.
  final Duration tick;

  Duration _position = Duration.zero;
  bool _playing = false;
  double _speed = 1.0;
  Timer? _timer;
  bool _closed = false;

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
  Stream<Duration?> get durationStream => _durationCtl.stream;
  @override
  Stream<void> get completionStream => _completionCtl.stream;
  @override
  Stream<Object> get errorStream => const Stream<Object>.empty();

  void _setPlaying(bool v) {
    _playing = v;
    if (!_closed) _playingCtl.add(v);
    _timer?.cancel();
    _timer = null;
    if (v) {
      _timer = Timer.periodic(tick, (_) {
        final next = _position + tick * _speed;
        if (next >= duration) {
          _position = duration;
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
    if (!_closed) _durationCtl.add(duration);
  }

  @override
  Future<void> setStreamUrl(String url, {Map<String, String>? headers}) async {
    if (!_closed) _durationCtl.add(duration);
  }

  @override
  Future<void> play() async => _setPlaying(true);
  @override
  Future<void> pause() async => _setPlaying(false);

  @override
  Future<void> seek(Duration position) async {
    _position = position < Duration.zero
        ? Duration.zero
        : (position > duration ? duration : position);
    if (!_closed) _positionCtl.add(_position);
  }

  @override
  Future<void> setSpeed(double speed) async => _speed = speed;
  @override
  Future<void> setVolumeBoost(double db) async {}

  @override
  Future<void> dispose() async {
    _closed = true;
    _timer?.cancel();
    _timer = null;
    await _positionCtl.close();
    await _playingCtl.close();
    await _durationCtl.close();
    await _completionCtl.close();
  }
}
