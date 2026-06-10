import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:castwright/src/data/audio_engine.dart';
import 'package:castwright/src/data/companion_audio_handler.dart';
import 'package:castwright/src/data/playback_store.dart';
import 'package:castwright/src/data/player_controller.dart';
import 'package:castwright/src/domain/skip_behavior.dart';

class FakeAudioEngine implements AudioEngine {
  Duration _position = Duration.zero;
  @override
  Duration get position => _position;
  @override
  Stream<Duration> get positionStream => const Stream.empty();
  @override
  Duration? get duration => null;
  @override
  Stream<Duration?> get durationStream => const Stream.empty();
  @override
  Stream<void> get completionStream => const Stream.empty();

  @override
  Future<void> setFilePath(String path) async => _position = Duration.zero;
  @override
  Future<void> setStreamUrl(String url, {Map<String, String>? headers}) async =>
      _position = Duration.zero;

  @override
  bool get playing => false;
  @override
  Stream<bool> get playingStream => const Stream.empty();
  @override
  Future<void> play() async {}
  @override
  Future<void> pause() async {}
  @override
  Future<void> seek(Duration p) async => _position = p;
  @override
  Future<void> setSpeed(double s) async {}
  @override
  Future<void> setVolumeBoost(double db) async {}
  @override
  Future<void> dispose() async {}
}

class MemPlaybackStore implements PlaybackStore {
  @override
  Future<void> savePlayback(String b, String u, int ms, String iso) async {}
  @override
  Future<PlaybackPoint?> loadPlayback(String b) async => null;
}

PlayerController makeController() => PlayerController(
      audioEngine: FakeAudioEngine(),
      playbackStore: MemPlaybackStore(),
      playlistLoader: (bookId) async =>
          const [PlayableChapter(uuid: 'u1', path: '/b1/u1/audio.mp3')],
      skipBehavior: SkipButtonBehavior.seek,
      clock: () => DateTime.utc(2026, 6, 10, 12),
      saveInterval: const Duration(seconds: 10),
    );

void main() {
  group('CompanionAudioHandler media-session metadata', () {
    test('empty album falls back to the Castwright brand, not "Audiobook"',
        () async {
      final handler = CompanionAudioHandler();
      final controller = makeController();
      handler.attach(controller);

      await controller.openBook('b1'); // bookTitle defaults to ''
      await Future<void>.delayed(Duration.zero); // let the broadcast deliver

      expect(handler.mediaItem.value?.album, 'Castwright');
    });

    test('a real book title is passed through untouched', () async {
      final handler = CompanionAudioHandler();
      final controller = makeController();
      handler.attach(controller);

      await controller.openBook('b1', bookTitle: 'Keeper of the Lost Cities');
      await Future<void>.delayed(Duration.zero);

      expect(handler.mediaItem.value?.album, 'Keeper of the Lost Cities');
    });
  });
}
