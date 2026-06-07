import 'dart:async';

import '../domain/skip_behavior.dart';
import 'audio_engine.dart';
import 'playback_store.dart';

/// One chapter the player can load: its stable `uuid` and local file path,
/// plus display metadata (title/duration) for the media-session notification.
class PlayableChapter {
  const PlayableChapter({
    required this.uuid,
    required this.path,
    this.title = '',
    this.durationSec,
  });
  final String uuid;
  final String path;
  final String title;
  final double? durationSec;
}

/// Pure now-playing snapshot; the audio-service handler maps it to a MediaItem
/// for the lock-screen / notification / car display. No audio_service import
/// here keeps [PlayerController] unit-testable.
class NowPlaying {
  const NowPlaying({
    required this.id,
    required this.bookId,
    required this.title,
    required this.album,
    this.artPath,
    this.duration,
  });
  final String id; // chapter uuid
  final String bookId;
  final String title; // chapter title
  final String album; // book title
  final String? artPath; // cover thumbnail file path
  final Duration? duration;
}

/// Resolves a book's ordered, locally-available chapters (built from the
/// `app-4` store). Injectable so the controller unit-tests without drift.
typedef PlaylistLoader = Future<List<PlayableChapter>> Function(String bookId);

/// The player brain (`app-5`): per-book resume + switching, frequent local
/// autosave, and media-key handling — all over an injectable [AudioEngine] and
/// [PlaybackStore]. The native `just_audio`/`audio_service` wiring lives in the
/// real [AudioEngine] adapter + the audio-service handler.
class PlayerController {
  PlayerController({
    required AudioEngine audioEngine,
    required PlaybackStore playbackStore,
    required PlaylistLoader playlistLoader,
    required DateTime Function() clock,
    SkipButtonBehavior skipBehavior = SkipButtonBehavior.seek,
    Duration saveInterval = const Duration(seconds: 10),
  })  : _engine = audioEngine,
        _store = playbackStore,
        _loadPlaylist = playlistLoader,
        _now = clock,
        _autosaveInterval = saveInterval {
    skipBehavior_ = skipBehavior;
    _sub = _engine.positionStream.listen(_onTick);
    _completionSub = _engine.completionStream.listen((_) {
      final finished = currentChapterUuid;
      if (finished != null) _chapterCompleted.add(finished);
      _advance();
    });
  }

  final AudioEngine _engine;
  final PlaybackStore _store;
  final PlaylistLoader _loadPlaylist;
  final DateTime Function() _now;
  final Duration _autosaveInterval;

  /// Skip-button behaviour + seek amounts (driven by `app-13`); mutable so
  /// settings can change them at runtime.
  late SkipButtonBehavior skipBehavior_;
  int skipForwardSeconds_ = 30;
  int skipBackwardSeconds_ = 15;

  StreamSubscription<Duration>? _sub;
  StreamSubscription<void>? _completionSub;
  final StreamController<NowPlaying?> _nowPlaying =
      StreamController<NowPlaying?>.broadcast();

  /// Emits a chapter's `uuid` when it plays to its end (app-4 finished-tracking).
  final StreamController<String> _chapterCompleted =
      StreamController<String>.broadcast();
  Stream<String> get chapterCompletedStream => _chapterCompleted.stream;
  List<PlayableChapter> _playlist = const [];
  String? _bookId;
  String _bookTitle = '';
  String? _artPath;
  int _index = -1;
  double _speed = 1.0;
  double _boostDb = 0;
  DateTime? _lastSave;

  /// Live playback duration of the loaded chapter (null until known).
  Stream<Duration?> get durationStream => _engine.durationStream;
  Duration? get duration => _engine.duration;

  /// Playing/paused for the media session.
  Stream<bool> get playingStream => _engine.playingStream;
  bool get playing => _engine.playing;

  /// Emits on every chapter load (incl. auto-advance) so the media session
  /// updates the lock-screen / car title + artwork.
  Stream<NowPlaying?> get nowPlayingStream => _nowPlaying.stream;

  double get speed => _speed;
  Future<void> setSpeed(double speed) {
    _speed = speed;
    return _engine.setSpeed(speed);
  }

  /// Loudness boost in dB above unity (0 = off), re-applied per chapter.
  double get volumeBoostDb => _boostDb;
  Future<void> setVolumeBoost(double db) {
    _boostDb = db;
    return _engine.setVolumeBoost(db);
  }

  /// Auto-advance to the next chapter when the current one ends.
  Future<void> _advance() async {
    if (_index >= 0 && _index + 1 < _playlist.length) {
      await _loadIndex(_index + 1);
      await play();
    }
  }

  String? get currentBookId => _bookId;
  String? get currentChapterUuid =>
      (_index >= 0 && _index < _playlist.length) ? _playlist[_index].uuid : null;

  /// True only for the chapter currently loaded in the engine — the `app-3`
  /// sync engine uses this as its deferred-swap `isInUse` predicate.
  bool isInUse(String uuid) => uuid == currentChapterUuid;

  /// The loaded playlist (for a chapter-list UI).
  List<PlayableChapter> get chapters => List.unmodifiable(_playlist);

  /// Load + play a specific chapter by its stable `uuid`.
  Future<void> playChapter(String uuid) async {
    final i = _playlist.indexWhere((c) => c.uuid == uuid);
    if (i < 0) return;
    await _loadIndex(i);
    await play();
  }

  /// Prepare a book for playback: load its playlist, restore the saved resume
  /// point (or start at the first chapter), and seek there.
  Future<void> openBook(String bookId,
      {String bookTitle = '', String? artPath}) async {
    _bookId = bookId;
    _bookTitle = bookTitle;
    _artPath = artPath;
    _playlist = await _loadPlaylist(bookId);
    final saved = await _store.loadPlayback(bookId);
    var index = 0;
    if (saved != null) {
      final i = _playlist.indexWhere((c) => c.uuid == saved.chapterUuid);
      if (i >= 0) index = i;
    }
    await _loadIndex(index, seekMs: saved?.positionMs ?? 0);
  }

  Future<void> _loadIndex(int index, {int seekMs = 0}) async {
    if (index < 0 || index >= _playlist.length) return;
    _index = index;
    final c = _playlist[index];
    _nowPlaying.add(NowPlaying(
      id: c.uuid,
      bookId: _bookId ?? '',
      title: c.title.isEmpty ? 'Chapter ${index + 1}' : c.title,
      album: _bookTitle,
      artPath: _artPath,
      duration: c.durationSec != null
          ? Duration(milliseconds: (c.durationSec! * 1000).round())
          : null,
    ));
    await _engine.setFilePath(c.path);
    if (_speed != 1.0) await _engine.setSpeed(_speed); // persist speed across chapters
    if (_boostDb > 0) await _engine.setVolumeBoost(_boostDb); // persist boost too
    if (seekMs > 0) await _engine.seek(Duration(milliseconds: seekMs));
    // Measure the autosave interval from load time, so we don't persist on the
    // very first position tick.
    _lastSave = _now();
  }

  Future<void> seekTo(Duration position) =>
      _engine.seek(position < Duration.zero ? Duration.zero : position);

  /// Live playback position (for the player UI).
  Stream<Duration> get positionStream => _engine.positionStream;
  Duration get position => _engine.position;

  Future<void> play() => _engine.play();
  Future<void> pause() async {
    await _engine.pause();
    await saveNow();
  }

  /// Persist the current position immediately (e.g. on pause / app background).
  Future<void> saveNow() async {
    final book = _bookId;
    final uuid = currentChapterUuid;
    if (book == null || uuid == null) return;
    await _store.savePlayback(
        book, uuid, _engine.position.inMilliseconds, _now().toIso8601String());
    _lastSave = _now();
  }

  /// Save the active book's position, then restore another book at its own
  /// resume point — per-book state is preserved across switches.
  Future<void> switchBook(String bookId) async {
    await saveNow();
    await openBook(bookId);
  }

  Future<void> skip({required bool forward}) async {
    final action = resolveSkipAction(skipBehavior_,
        forward: forward,
        forwardSeconds: skipForwardSeconds_,
        backwardSeconds: skipBackwardSeconds_);
    switch (action) {
      case SeekBy(:final delta):
        var target = _engine.position + delta;
        if (target < Duration.zero) target = Duration.zero;
        await _engine.seek(target);
      case ChapterStep(:final direction):
        final next = _index + direction;
        if (next >= 0 && next < _playlist.length) await _loadIndex(next);
    }
  }

  void _onTick(Duration position) {
    final last = _lastSave;
    final now = _now();
    if (last == null || now.difference(last) >= _autosaveInterval) {
      final book = _bookId;
      final uuid = currentChapterUuid;
      if (book != null && uuid != null) {
        _lastSave = now;
        // Fire-and-forget; ordering preserved by the single-subscription stream.
        _store.savePlayback(
            book, uuid, position.inMilliseconds, now.toIso8601String());
      }
    }
  }

  Future<void> dispose() async {
    await _sub?.cancel();
    await _completionSub?.cancel();
    await _nowPlaying.close();
    await _chapterCompleted.close();
    await _engine.dispose();
  }
}
