import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:castwright/src/data/audio_engine.dart';
import 'package:castwright/src/data/playback_store.dart';
import 'package:castwright/src/data/player_controller.dart';
import 'package:castwright/src/domain/skip_behavior.dart';

/// Engine whose playing state is driven by the test, so we can assert the
/// controller re-broadcasts out-of-band stops (audio-focus loss / headset
/// disconnect) — the seam the in-app transport now subscribes to.
class DrivableEngine implements AudioEngine {
  final _playing = StreamController<bool>.broadcast();
  bool _playingNow = false;

  void emitPlaying(bool v) {
    _playingNow = v;
    _playing.add(v);
  }

  @override
  bool get playing => _playingNow;
  @override
  Stream<bool> get playingStream => _playing.stream;

  @override
  Duration get position => Duration.zero;
  @override
  Stream<Duration> get positionStream => const Stream.empty();
  @override
  Duration? get duration => null;
  @override
  Stream<Duration?> get durationStream => const Stream.empty();
  @override
  Stream<void> get completionStream => const Stream.empty();

  @override
  Future<void> setFilePath(String path) async {}
  @override
  Future<void> setStreamUrl(String url, {Map<String, String>? headers}) async {}
  @override
  Future<void> play() async => emitPlaying(true);
  @override
  Future<void> pause() async => emitPlaying(false);
  @override
  Future<void> seek(Duration p) async {}
  @override
  Future<void> setSpeed(double s) async {}
  @override
  Future<void> setVolumeBoost(double db) async {}
  @override
  Future<void> dispose() async => _playing.close();
}

class _MemStore implements PlaybackStore {
  @override
  Future<void> savePlayback(String b, String u, int ms, String iso) async {}
  @override
  Future<PlaybackPoint?> loadPlayback(String b) async => null;
}

void main() {
  test('playingStream re-broadcasts engine playing changes (incl. out-of-band)',
      () async {
    final engine = DrivableEngine();
    final controller = PlayerController(
      audioEngine: engine,
      playbackStore: _MemStore(),
      playlistLoader: (_) async => const [],
      clock: () => DateTime.utc(2026, 6, 19, 12),
    );

    final seen = <bool>[];
    final sub = controller.playingStream.listen(seen.add);

    await controller.play(); // engine emits true
    await Future<void>.delayed(Duration.zero);
    engine.emitPlaying(false); // out-of-band stop (focus loss / unplug)
    await Future<void>.delayed(Duration.zero);

    expect(seen, [true, false]);
    await sub.cancel();
    await controller.dispose();
  });

  test('two listeners can subscribe without multi-subscribing the engine',
      () async {
    // The engine stream gets a single subscriber (the controller); UI + media
    // session both listen to the re-broadcast. A passthrough would have thrown
    // on a single-subscription engine stream.
    final engine = DrivableEngine();
    final controller = PlayerController(
      audioEngine: engine,
      playbackStore: _MemStore(),
      playlistLoader: (_) async => const [],
      clock: () => DateTime.utc(2026, 6, 19, 12),
    );

    final a = controller.playingStream.listen((_) {});
    final b = controller.playingStream.listen((_) {});
    engine.emitPlaying(true);
    await Future<void>.delayed(Duration.zero);

    await a.cancel();
    await b.cancel();
    await controller.dispose();
  });
}
