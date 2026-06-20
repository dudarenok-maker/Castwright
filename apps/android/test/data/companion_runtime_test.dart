import 'dart:async';

import 'package:drift/native.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:castwright/src/data/audio_engine.dart';
import 'package:castwright/src/data/companion_runtime.dart';
import 'package:castwright/src/data/drift_local_library.dart';
import 'package:castwright/src/data/file_store.dart';
import 'package:castwright/src/data/library_database.dart';
import 'package:castwright/src/data/playback_store.dart';
import 'package:castwright/src/data/player_controller.dart';

// ---------------------------------------------------------------------------
// Minimal fake AudioEngine for this test file.
// ---------------------------------------------------------------------------

class _FakeAudioEngine implements AudioEngine {
  final _pos = StreamController<Duration>.broadcast();
  final _dur = StreamController<Duration?>.broadcast();
  final _completion = StreamController<void>.broadcast();
  final _playingCtl = StreamController<bool>.broadcast();

  bool _playing = false;
  Duration _position = Duration.zero;
  Duration? _duration;

  @override
  Duration get position => _position;
  @override
  Stream<Duration> get positionStream => _pos.stream;
  @override
  Duration? get duration => _duration;
  @override
  Stream<Duration?> get durationStream => _dur.stream;
  @override
  Stream<void> get completionStream => _completion.stream;
  @override
  bool get playing => _playing;
  @override
  Stream<bool> get playingStream => _playingCtl.stream;

  @override
  Future<void> play() async {
    _playing = true;
    _playingCtl.add(true);
  }

  @override
  Future<void> pause() async {
    _playing = false;
    _playingCtl.add(false);
  }

  @override
  Future<void> seek(Duration p) async => _position = p;
  @override
  Future<void> setFilePath(String path) async => _position = Duration.zero;
  @override
  Future<void> setStreamUrl(String url, {Map<String, String>? headers}) async {}
  @override
  Future<void> setSpeed(double s) async {}
  @override
  Future<void> setVolumeBoost(double db) async {}

  @override
  Future<void> dispose() async {
    await _pos.close();
    await _dur.close();
    await _completion.close();
    await _playingCtl.close();
  }

  void emitDuration(Duration d) {
    _duration = d;
    _dur.add(d);
  }

  void emitPosition(Duration p) {
    _position = p;
    _pos.add(p);
  }

  void emitCompletion() => _completion.add(null);
}

// ---------------------------------------------------------------------------
// Simple in-memory PlaybackStore for the player's autosave.
// ---------------------------------------------------------------------------

class _MemPlaybackStore implements PlaybackStore {
  final Map<String, PlaybackPoint> _map = {};

  @override
  Future<void> savePlayback(String b, String u, int ms, String iso) async =>
      _map[b] = PlaybackPoint(chapterUuid: u, positionMs: ms);

  @override
  Future<PlaybackPoint?> loadPlayback(String b) async => _map[b];
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

void main() {
  group('wireFinishedTracking — real PlayerController + DriftLocalLibrary (I1)',
      () {
    test(
        'driving the player to finish the last chapter marks book hidden and both chapters finished',
        () async {
      // ── Arrange ────────────────────────────────────────────────────────────
      // In-memory library seeded with book 'b1' and 2 chapters.
      final db = LibraryDatabase(NativeDatabase.memory());
      final library = DriftLocalLibrary(db, InMemoryFileStore(), root: '/t');

      await library.upsertBookMeta(
          bookId: 'b1',
          title: 'Test Book',
          author: 'A',
          series: '',
          seriesPosition: null);
      // Chapter 1 — long (60 s), will be ticked by near-end path.
      await library.recordChapterMeta(
          bookId: 'b1',
          uuid: 'u1',
          chapterId: 1,
          title: 'One',
          fingerprint: 'fp1',
          urlSuffix: 'audio.mp3',
          durationSec: 60);
      // Chapter 2 — long last chapter (60 s); near-end tick triggers bookCompleted.
      await library.recordChapterMeta(
          bookId: 'b1',
          uuid: 'u2',
          chapterId: 2,
          title: 'Two',
          fingerprint: 'fp2',
          urlSuffix: 'audio.mp3',
          durationSec: 60);

      final engine = _FakeAudioEngine();
      final playlist = [
        const PlayableChapter(uuid: 'u1', path: '/b1/u1/audio.mp3'),
        const PlayableChapter(uuid: 'u2', path: '/b1/u2/audio.mp3'),
      ];
      final player = PlayerController(
        audioEngine: engine,
        playbackStore: _MemPlaybackStore(),
        playlistLoader: (_) async => playlist,
        clock: () => DateTime.utc(2026, 6, 20),
      );

      // ── Wire finished-tracking (the real path under test) ──────────────────
      final subs = wireFinishedTracking(player, library);

      // ── Act: open the book, jump to ch1 near-end to tick it, then drive
      // ── the last chapter to its near-end finish window while playing. ─────
      await player.openBook('b1');

      // Tick chapter 1 (non-last) near-end → setChapterFinished('u1', true).
      await player.playChapter('u1');
      await engine.play();
      engine.emitDuration(const Duration(seconds: 60));
      engine.emitPosition(const Duration(seconds: 55)); // remaining 5 s
      await Future<void>.delayed(Duration.zero);

      // Move to last chapter, emit near-end while playing → bookCompleted.
      await player.playChapter('u2');
      engine.emitDuration(const Duration(seconds: 60));
      engine.emitPosition(const Duration(seconds: 55)); // remaining 5 s
      await Future<void>.delayed(Duration.zero);

      // ── Assert ─────────────────────────────────────────────────────────────
      final books = await library.listBooks();
      expect(books.single.hidden, isTrue,
          reason: 'markBookFinished must set hidden = true');

      final finishedUuids = await library.finishedChapterUuids('b1');
      expect(finishedUuids.length, 2,
          reason: 'both chapters must be marked finished');

      // ── Cleanup ────────────────────────────────────────────────────────────
      for (final s in subs) {
        await s.cancel();
      }
      await player.dispose();
      await library.close();
    });
  });
}
