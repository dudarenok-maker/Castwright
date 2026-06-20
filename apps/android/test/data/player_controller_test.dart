import 'dart:async';

import 'package:drift/native.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:castwright/src/data/audio_engine.dart';
import 'package:castwright/src/data/library_database.dart';
import 'package:castwright/src/data/player_controller.dart';
import 'package:castwright/src/data/playback_store.dart';
import 'package:castwright/src/domain/skip_behavior.dart';

class FakeAudioEngine implements AudioEngine {
  final List<String> calls = [];
  final StreamController<Duration> _pos = StreamController<Duration>.broadcast();
  Duration _position = Duration.zero;
  String? loadedPath;

  // Mutable duration so tests can inject a known chapter length.
  Duration? _duration;
  final StreamController<Duration?> _durationCtl =
      StreamController<Duration?>.broadcast();

  @override
  Duration get position => _position;
  @override
  Stream<Duration> get positionStream => _pos.stream;
  @override
  Duration? get duration => _duration;
  @override
  Stream<Duration?> get durationStream => _durationCtl.stream;

  /// Inject a chapter duration (mirrors how [emitCompletion] works).
  void emitDuration(Duration d) {
    _duration = d;
    _durationCtl.add(d);
  }

  /// Alias used by the near-end tests — same as [emit] but named for clarity.
  void emitPosition(Duration p) => emit(p);

  final _completionCtl = StreamController<void>.broadcast();
  @override
  Stream<void> get completionStream => _completionCtl.stream;
  void emitCompletion() => _completionCtl.add(null);

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
    await _completionCtl.close();
    await _durationCtl.close();
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

/// Build a player wired to the stats accumulator. [nowMs] is a mutable box —
/// the caller changes it between steps to advance the injected clock.
PlayerController makeWithStats(
  FakeAudioEngine engine,
  MemPlaybackStore store,
  LibraryDatabase db,
  List<int> nowMs, {
  String sessionId = 'sess1',
  String localDate = '2026-06-14',
  Map<String, List<PlayableChapter>>? playlists,
}) {
  final lists = playlists ?? {'b1': playlistB1};
  return PlayerController(
    audioEngine: engine,
    playbackStore: store,
    playlistLoader: (bookId) async => lists[bookId] ?? const [],
    clock: () => DateTime.fromMillisecondsSinceEpoch(nowMs[0]),
    saveInterval: const Duration(seconds: 10),
    statsDb: db,
    sessionId: sessionId,
    localDate: () => localDate,
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

    test('skip honours the configured forward seconds (app-13)', () async {
      final engine = FakeAudioEngine();
      final pc = make(engine, MemPlaybackStore());
      pc.skipForwardSeconds_ = 45;
      await pc.openBook('b1');
      engine.emit(const Duration(seconds: 10));
      await pc.skip(forward: true);
      expect(engine.calls, contains('seek:55000')); // 10s + 45s
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

    test('emits the finished chapter uuid on completion (app-4)', () async {
      final engine = FakeAudioEngine();
      final pc = make(engine, MemPlaybackStore());
      final done = <String>[];
      final sub = pc.chapterCompletedStream.listen(done.add);
      await pc.openBook('b1'); // u1
      engine.emitCompletion();
      await Future<void>.delayed(Duration.zero);
      expect(done, contains('u1'));
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

    test('near-end position ticks the chapter without waiting for completion',
        () async {
      // 2-chapter book so 'u2' is the last chapter; we play chapter 1 (u1).
      final engine = FakeAudioEngine();
      final pc = make(engine, MemPlaybackStore(), playlists: {
        'b1': const [
          PlayableChapter(uuid: 'u1', path: '/b1/u1/audio.mp3'),
          PlayableChapter(uuid: 'u2', path: '/b1/u2/audio.mp3'),
        ],
      });
      final done = <String>[];
      final sub = pc.chapterCompletedStream.listen(done.add);
      await pc.openBook('b1'); // starts at u1 (non-last)
      engine.emitDuration(const Duration(seconds: 60));
      engine.emitPosition(const Duration(seconds: 51)); // remaining 9s <= 10s
      await Future<void>.delayed(Duration.zero);
      expect(done, ['u1']);
      // A second near-end tick must NOT re-emit for the same chapter.
      engine.emitPosition(const Duration(seconds: 52));
      await Future<void>.delayed(Duration.zero);
      expect(done, ['u1']);
      await sub.cancel();
      await pc.dispose();
    });

    test('last chapter near-end emits bookCompleted once', () async {
      // 2-chapter book — play chapter 2 (u2 = last).
      final engine = FakeAudioEngine();
      final pc = make(engine, MemPlaybackStore(), playlists: {
        'b1': const [
          PlayableChapter(uuid: 'u1', path: '/b1/u1/audio.mp3'),
          PlayableChapter(uuid: 'u2', path: '/b1/u2/audio.mp3'),
        ],
      });
      final books = <String>[];
      final sub = pc.bookCompletedStream.listen(books.add);
      await pc.openBook('b1');
      await pc.playChapter('u2'); // u2 = last chapter in this 2-chapter list
      engine.emitDuration(const Duration(seconds: 60));
      engine.emitPosition(const Duration(seconds: 55)); // remaining 5s
      await Future<void>.delayed(Duration.zero);
      engine.emitPosition(const Duration(seconds: 56)); // second tick — no re-emit
      await Future<void>.delayed(Duration.zero);
      expect(books, ['b1']);
      await sub.cancel();
      await pc.dispose();
    });

    test('non-last chapter near-end does NOT emit bookCompleted', () async {
      // 2-chapter book, start at u1 (non-last).
      final engine = FakeAudioEngine();
      final pc = make(engine, MemPlaybackStore(), playlists: {
        'b1': const [
          PlayableChapter(uuid: 'u1', path: '/b1/u1/audio.mp3'),
          PlayableChapter(uuid: 'u2', path: '/b1/u2/audio.mp3'),
        ],
      });
      final books = <String>[];
      final sub = pc.bookCompletedStream.listen(books.add);
      await pc.openBook('b1'); // starts at u1 (not last)
      engine.emitDuration(const Duration(seconds: 60));
      engine.emitPosition(const Duration(seconds: 55)); // within threshold
      await Future<void>.delayed(Duration.zero);
      expect(books, isEmpty);
      await sub.cancel();
      await pc.dispose();
    });

    test(
        'single-chapter book: replay re-emits chapterCompleted and bookCompleted',
        () async {
      // The only chapter (u1) is also the last (index 0 == length-1).
      // Before the fix, _bookFinishEmitted is never cleared by _loadIndex
      // (because `index != _playlist.length - 1` is always false), so a
      // replay never fires bookCompletedStream a second time.
      final engine = FakeAudioEngine();
      final pc = make(engine, MemPlaybackStore(), playlists: {
        'b1': const [
          PlayableChapter(uuid: 'u1', path: '/b1/u1/audio.mp3'),
        ],
      });
      final chapters = <String>[];
      final books = <String>[];
      final chSub = pc.chapterCompletedStream.listen(chapters.add);
      final bkSub = pc.bookCompletedStream.listen(books.add);

      // ── First play-through ──────────────────────────────────────────────
      await pc.openBook('b1');
      engine.emitDuration(const Duration(seconds: 60));
      engine.emitPosition(const Duration(seconds: 55)); // remaining 5s <= 10s
      await Future<void>.delayed(Duration.zero);
      expect(chapters, ['u1'], reason: 'first play: chapterCompleted once');
      expect(books, ['b1'], reason: 'first play: bookCompleted once');

      // ── Replay (simulate user tapping "play again" → openBook called again) ─
      await pc.openBook('b1');
      engine.emitDuration(const Duration(seconds: 60));
      engine.emitPosition(const Duration(seconds: 55));
      await Future<void>.delayed(Duration.zero);
      expect(chapters, ['u1', 'u1'],
          reason: 'replay: chapterCompleted a second time');
      expect(books, ['b1', 'b1'],
          reason: 'replay: bookCompleted a second time');

      await chSub.cancel();
      await bkSub.cancel();
      await pc.dispose();
    });
  });

  // ── fs-16: listen-stats accumulator wiring ────────────────────────────────

  group('PlayerController stats accumulator (fs-16)', () {
    test('autosave tick upserts accrual when playing', () async {
      final engine = FakeAudioEngine();
      final db = LibraryDatabase(NativeDatabase.memory());
      final nowMs = [0]; // mutable clock box
      final pc = makeWithStats(engine, MemPlaybackStore(), db, nowMs);

      await pc.openBook('b1');
      // Start playing (triggers onPlay via playingStream).
      await engine.play();
      await Future<void>.delayed(Duration.zero);

      // Advance clock by 15 s and fire the position stream to cross the autosave
      // interval. The stats tick should drain ~15 s into the buffer.
      nowMs[0] = 15000;
      engine.emit(const Duration(seconds: 15));
      await Future<void>.delayed(Duration.zero);

      final pending = await db.pendingByBook();
      expect(pending.containsKey('b1'), isTrue);
      final days = pending['b1']!['sess1']!;
      expect(days.length, 1);
      expect(days.single.date, '2026-06-14');
      expect(days.single.seconds, greaterThan(0));

      await pc.dispose();
      await db.close();
    });

    test('buffering (not playing) does not accrue', () async {
      final engine = FakeAudioEngine();
      final db = LibraryDatabase(NativeDatabase.memory());
      final nowMs = [0];
      final pc = makeWithStats(engine, MemPlaybackStore(), db, nowMs);

      await pc.openBook('b1');
      // Do NOT call engine.play() — engine stays paused.
      nowMs[0] = 15000;
      engine.emit(const Duration(seconds: 15));
      await Future<void>.delayed(Duration.zero);

      // No stats should have been buffered.
      expect(await db.pendingByBook(), isEmpty);

      await pc.dispose();
      await db.close();
    });

    test('book switch persists prior book stats before retargeting', () async {
      final engine = FakeAudioEngine();
      final db = LibraryDatabase(NativeDatabase.memory());
      final nowMs = [0];
      final pc = makeWithStats(
        engine,
        MemPlaybackStore(),
        db,
        nowMs,
        playlists: {
          'b1': playlistB1,
          'b2': const [PlayableChapter(uuid: 'x1', path: '/b2/x1/audio.mp3')],
        },
      );

      await pc.openBook('b1');
      await engine.play();
      await Future<void>.delayed(Duration.zero);

      // Advance 20 s, fire tick to accrue b1 stats.
      nowMs[0] = 20000;
      engine.emit(const Duration(seconds: 20));
      await Future<void>.delayed(Duration.zero);

      // Switch to b2 — should flush b1 stats into the buffer.
      await pc.switchBook('b2');

      final pending = await db.pendingByBook();
      expect(pending.containsKey('b1'), isTrue,
          reason: 'b1 stats must be flushed to buffer on switch');
      expect(pending['b1']!['sess1']!.single.seconds, greaterThan(0));

      await pc.dispose();
      await db.close();
    });
  });
}
