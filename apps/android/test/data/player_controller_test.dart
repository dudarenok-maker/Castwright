import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:audiobook_companion/src/data/audio_engine.dart';
import 'package:audiobook_companion/src/data/player_controller.dart';
import 'package:audiobook_companion/src/data/playback_store.dart';
import 'package:audiobook_companion/src/domain/skip_behavior.dart';

class FakeAudioEngine implements AudioEngine {
  final List<String> calls = [];
  final StreamController<Duration> _pos = StreamController<Duration>.broadcast();
  Duration _position = Duration.zero;
  String? loadedPath;

  @override
  Duration get position => _position;
  @override
  Stream<Duration> get positionStream => _pos.stream;
  @override
  Duration? get duration => null;
  @override
  Stream<Duration?> get durationStream => const Stream.empty();
  @override
  Stream<void> get completionStream => const Stream.empty();

  @override
  Future<void> setFilePath(String path) async {
    loadedPath = path;
    _position = Duration.zero;
    calls.add('set:$path');
  }

  @override
  Future<void> setStreamUrl(String url, {Map<String, String>? headers}) async {
    loadedPath = url;
    _position = Duration.zero;
    calls.add('stream:$url');
  }

  bool _playing = false;
  final _playingCtl = StreamController<bool>.broadcast();
  @override
  bool get playing => _playing;
  @override
  Stream<bool> get playingStream => _playingCtl.stream;
  @override
  Future<void> play() async {
    _playing = true;
    _playingCtl.add(true);
    calls.add('play');
  }

  @override
  Future<void> pause() async {
    _playing = false;
    _playingCtl.add(false);
    calls.add('pause');
  }
  @override
  Future<void> seek(Duration p) async {
    _position = p;
    calls.add('seek:${p.inMilliseconds}');
  }

  @override
  Future<void> setSpeed(double s) async => calls.add('speed:$s');
  @override
  Future<void> setVolumeBoost(double db) async => calls.add('boost:$db');
  @override
  Future<void> dispose() async {
    await _pos.close();
    await _playingCtl.close();
  }

  void emit(Duration p) {
    _position = p;
    _pos.add(p);
  }
}

class MemPlaybackStore implements PlaybackStore {
  final Map<String, PlaybackPoint> map = {};
  @override
  Future<void> savePlayback(String b, String u, int ms, String iso) async =>
      map[b] = PlaybackPoint(chapterUuid: u, positionMs: ms);
  @override
  Future<PlaybackPoint?> loadPlayback(String b) async => map[b];
}

List<PlayableChapter> playlistB1 = const [
  PlayableChapter(uuid: 'u1', path: '/b1/u1/audio.mp3'),
  PlayableChapter(uuid: 'u2', path: '/b1/u2/audio.mp3'),
  PlayableChapter(uuid: 'u3', path: '/b1/u3/audio.mp3'),
];

PlayerController make(
  FakeAudioEngine engine,
  MemPlaybackStore store, {
  SkipButtonBehavior behavior = SkipButtonBehavior.seek,
  DateTime Function()? now,
  Map<String, List<PlayableChapter>>? playlists,
}) {
  final lists = playlists ?? {'b1': playlistB1};
  return PlayerController(
    audioEngine: engine,
    playbackStore: store,
    playlistLoader: (bookId) async => lists[bookId] ?? const [],
    skipBehavior: behavior,
    clock: now ?? () => DateTime.utc(2026, 6, 6, 12),
    saveInterval: const Duration(seconds: 10),
  );
}

void main() {
  group('PlayerController', () {
    test('openBook with no saved point prepares the first chapter at 0', () async {
      final engine = FakeAudioEngine();
      final pc = make(engine, MemPlaybackStore());
      await pc.openBook('b1');
      expect(engine.loadedPath, '/b1/u1/audio.mp3');
      expect(pc.currentChapterUuid, 'u1');
      await pc.dispose();
    });

    test('openBook restores the saved chapter + position', () async {
      final engine = FakeAudioEngine();
      final store = MemPlaybackStore()
        ..map['b1'] = const PlaybackPoint(chapterUuid: 'u2', positionMs: 5000);
      final pc = make(engine, store);
      await pc.openBook('b1');
      expect(engine.loadedPath, '/b1/u2/audio.mp3');
      expect(engine.calls, contains('seek:5000'));
      expect(pc.currentChapterUuid, 'u2');
      await pc.dispose();
    });

    test('switchBook saves the current position then restores the other book', () async {
      final engine = FakeAudioEngine();
      final store = MemPlaybackStore();
      final pc = make(engine, store, playlists: {
        'b1': playlistB1,
        'b2': const [PlayableChapter(uuid: 'x1', path: '/b2/x1/audio.mp3')],
      });
      await pc.openBook('b1');
      engine.emit(const Duration(milliseconds: 4200));
      await pc.switchBook('b2');
      // b1's position was persisted on switch.
      expect(store.map['b1']!.chapterUuid, 'u1');
      expect(store.map['b1']!.positionMs, 4200);
      // b2 is now active.
      expect(engine.loadedPath, '/b2/x1/audio.mp3');
      expect(pc.currentBookId, 'b2');
      await pc.dispose();
    });

    test('autosave persists at most once per interval', () async {
      final engine = FakeAudioEngine();
      final store = MemPlaybackStore();
      var t = DateTime.utc(2026, 6, 6, 12);
      final pc = make(engine, store, now: () => t);
      await pc.openBook('b1');

      engine.emit(const Duration(seconds: 3)); // +3s since open, no save yet
      await Future<void>.delayed(Duration.zero);
      expect(store.map['b1'], isNull);

      t = t.add(const Duration(seconds: 11)); // cross the 10s interval
      engine.emit(const Duration(seconds: 14));
      await Future<void>.delayed(Duration.zero);
      expect(store.map['b1']!.positionMs, 14000);
      await pc.dispose();
    });

    test('skip in seek mode seeks +30s forward', () async {
      final engine = FakeAudioEngine();
      final pc = make(engine, MemPlaybackStore());
      await pc.openBook('b1');
      engine.emit(const Duration(seconds: 20));
      await pc.skip(forward: true);
      expect(engine.calls, contains('seek:50000')); // 20s + 30s
      await pc.dispose();
    });

    test('skip back never seeks below zero', () async {
      final engine = FakeAudioEngine();
      final pc = make(engine, MemPlaybackStore());
      await pc.openBook('b1');
      engine.emit(const Duration(seconds: 5));
      await pc.skip(forward: false); // -15s -> clamp to 0
      expect(engine.calls, contains('seek:0'));
      await pc.dispose();
    });

    test('skip in chapter mode advances to the next chapter', () async {
      final engine = FakeAudioEngine();
      final pc = make(engine, MemPlaybackStore(),
          behavior: SkipButtonBehavior.chapter);
      await pc.openBook('b1'); // u1
      await pc.skip(forward: true);
      expect(pc.currentChapterUuid, 'u2');
      expect(engine.loadedPath, '/b1/u2/audio.mp3');
      await pc.dispose();
    });

    test('volume boost is applied and re-applied on each chapter load', () async {
      final engine = FakeAudioEngine();
      final pc = make(engine, MemPlaybackStore(),
          behavior: SkipButtonBehavior.chapter);
      await pc.openBook('b1');
      await pc.setVolumeBoost(8);
      expect(engine.calls, contains('boost:8.0'));
      expect(pc.volumeBoostDb, 8.0);
      engine.calls.clear();
      await pc.skip(forward: true); // next chapter
      expect(engine.calls, contains('boost:8.0')); // persisted across chapters
      await pc.dispose();
    });

    test('nowPlayingStream emits chapter + book metadata on load', () async {
      final engine = FakeAudioEngine();
      final pc = make(engine, MemPlaybackStore(), playlists: {
        'b1': const [
          PlayableChapter(
              uuid: 'u1', path: '/b1/u1/a.mp3', title: 'Intro', durationSec: 60),
        ],
      });
      final events = <NowPlaying?>[];
      final sub = pc.nowPlayingStream.listen(events.add);
      await pc.openBook('b1', bookTitle: 'My Book', artPath: '/art.jpg');
      await Future<void>.delayed(Duration.zero);
      final np = events.whereType<NowPlaying>().last;
      expect(np.title, 'Intro');
      expect(np.album, 'My Book');
      expect(np.artPath, '/art.jpg');
      expect(np.duration, const Duration(seconds: 60));
      await sub.cancel();
      await pc.dispose();
    });

    test('isInUse is true only for the currently-loaded chapter', () async {
      final engine = FakeAudioEngine();
      final pc = make(engine, MemPlaybackStore());
      await pc.openBook('b1');
      expect(pc.isInUse('u1'), isTrue);
      expect(pc.isInUse('u2'), isFalse);
      await pc.dispose();
    });
  });
}
