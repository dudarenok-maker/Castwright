import 'dart:async';

import '../domain/listen_stats_accumulator.dart';
import '../domain/skip_behavior.dart';
import 'audio_engine.dart';
import 'library_database.dart';
import 'playback_store.dart';

/// A book/chapter counts as finished once playback enters this window before
/// the end — covers the user's "last 5–10 seconds" rule and makes ticks robust
/// to skipping/seeking (no need to hit the engine's exact end-of-file event).
const Duration kFinishThreshold = Duration(seconds: 10);

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
    // fs-16: optional listen-stats accumulator wiring.
    this._statsDb,
    this._sessionId,
    this._localDate,
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
      // M1: a short last chapter (duration <= kFinishThreshold) never enters the
      // near-end window, so the near-end path never fires _bookCompleted. Emit it
      // here instead. No isPlaying guard — a genuine engine end-of-file event
      // confirms real playback ended. Dedup with _bookFinishEmitted so the normal
      // long-chapter path (near-end already emitted) doesn't double-fire.
      final book = _bookId;
      if (book != null &&
          _index == _playlist.length - 1 &&
          !_bookFinishEmitted) {
        _bookFinishEmitted = true;
        if (!_bookCompleted.isClosed) _bookCompleted.add(book);
      }
      _advance();
    });
    // Subscribe to playing state to drive the accumulator.
    _playingSub = _engine.playingStream.listen(_onPlayingChanged);
  }

  final AudioEngine _engine;
  final PlaybackStore _store;
  final PlaylistLoader _loadPlaylist;
  final DateTime Function() _now;
  final Duration _autosaveInterval;

  // fs-16: listen-stats accumulator — null when no db/sessionId injected.
  final LibraryDatabase? _statsDb;
  final String? _sessionId;
  final String Function()? _localDate;
  StatsAccumulator? _accumulator;

  /// Skip-button behaviour + seek amounts (driven by `app-13`); mutable so
  /// settings can change them at runtime.
  late SkipButtonBehavior skipBehavior_;
  int skipForwardSeconds_ = 30;
  int skipBackwardSeconds_ = 15;

  StreamSubscription<Duration>? _sub;
  StreamSubscription<void>? _completionSub;
  StreamSubscription<bool>? _playingSub;
  final StreamController<NowPlaying?> _nowPlaying =
      StreamController<NowPlaying?>.broadcast();

  /// Re-broadcasts the engine's playing state so the player UI *and* the media
  /// session can each subscribe independently (the engine stream gets a single
  /// subscriber here). Decoupling this is what lets the in-app transport track
  /// out-of-band stops (headset/Android Auto disconnect, audio-focus loss).
  final StreamController<bool> _playing =
      StreamController<bool>.broadcast();

  /// Emits a chapter's `uuid` when it plays to its end (app-4 finished-tracking).
  final StreamController<String> _chapterCompleted =
      StreamController<String>.broadcast();
  Stream<String> get chapterCompletedStream => _chapterCompleted.stream;

  /// Emits a book's `bookId` once when its LAST chapter enters [kFinishThreshold].
  final StreamController<String> _bookCompleted =
      StreamController<String>.broadcast();
  Stream<String> get bookCompletedStream => _bookCompleted.stream;

  /// Emits a book's `bookId` when the user navigates BACKWARD within its
  /// chapter list — a genuine replay signal. Only fires on `newIndex < prev`
  /// (where `prev >= 0`), so the initial `openBook` restore (prev = -1) and
  /// every forward auto-advance (`newIndex >= prev`) are both excluded.
  final StreamController<String> _bookReplayed =
      StreamController<String>.broadcast();
  Stream<String> get bookReplayedStream => _bookReplayed.stream;

  /// Dedup guards so the per-tick near-end check fires at most once per chapter
  /// and once per book; reset on every chapter load.
  String? _nearEndTickedUuid;
  bool _bookFinishEmitted = false;

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

  /// Playing/paused for the media session and the in-app transport. Mirrors the
  /// engine via the single [_playingSub] subscription, re-broadcast so multiple
  /// listeners (UI + handler) never multi-subscribe the engine stream.
  Stream<bool> get playingStream => _playing.stream;
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
    // fs-16: create or retarget the accumulator for this book.
    final ld = _localDate;
    if (_statsDb != null && _sessionId != null && ld != null) {
      final acc = _accumulator;
      if (acc == null) {
        // First open — create the accumulator targeting this book.
        _accumulator = StatsAccumulator(
          bookId,
          () => _now().millisecondsSinceEpoch,
          ld,
        );
      } else if (acc.bookId != bookId) {
        // Book changed via a direct openBook call (e.g. car browse): flush + retarget.
        final handoff = acc.switchBook(bookId);
        await _persistStatsHandoff(handoff);
      }
    }
    // FIX 1: reset _index before changing _bookId so that _loadIndex's
    // backward-nav check (prev >= 0 && index < prev && _bookId == currentBook)
    // cannot see a stale prior-book index when opening a different book.
    // The reset to -1 means _loadIndex captures prev=-1, which is excluded by
    // the `prev >= 0` guard — no spurious bookReplayedStream emit on switch.
    if (_bookId != bookId) _index = -1;
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
    // Reset the book-level guard so every openBook call (including replay)
    // starts fresh — _loadIndex's own reset only fires on non-last chapters,
    // which misses single-chapter books where index 0 == length-1 always.
    _bookFinishEmitted = false;
    await _loadIndex(index, seekMs: saved?.positionMs ?? 0);
  }

  Future<void> _loadIndex(int index, {int seekMs = 0}) async {
    if (index < 0 || index >= _playlist.length) return;
    // Capture prior index BEFORE reassigning — used for the backward-nav replay signal.
    final prev = _index;
    _index = index;
    // Reset near-end dedup so each new chapter can tick once.
    _nearEndTickedUuid = null;
    // Reset book-finish guard only when loading a non-last chapter: re-seeking
    // within the finished last chapter must not re-emit; replaying loads ch0
    // (non-last) which resets the guard for the new play-through.
    if (index != _playlist.length - 1) _bookFinishEmitted = false;
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
    // Emit the replay signal when the user navigates BACKWARD (genuine replay).
    // prev=-1 on the initial openBook restore → excluded by `prev >= 0`.
    // forward auto-advance: newIndex > prev → excluded by `index < prev`.
    if (prev >= 0 && index < prev && _bookId != null) {
      _bookReplayed.add(_bookId!);
    }
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
        book, uuid, _engine.position.inMilliseconds, _now().toUtc().toIso8601String());
    _lastSave = _now();
  }

  /// Save the active book's position, then restore another book at its own
  /// resume point — per-book state is preserved across switches.
  Future<void> switchBook(String bookId) async {
    await saveNow();
    // fs-16: flush the prior book's accumulated stats before retargeting.
    final acc = _accumulator;
    if (acc != null) {
      final handoff = acc.switchBook(bookId);
      await _persistStatsHandoff(handoff);
    }
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

  // fs-16: drive the accumulator from the engine's playing-state stream.
  void _onPlayingChanged(bool isPlaying) {
    // Re-broadcast first so the UI/media session update even when no accumulator
    // is wired (the early-return below is stats-only).
    if (!_playing.isClosed) _playing.add(isPlaying);
    // Accrual is gated on play/pause intent only. Safe because playback is always
    // from local downloaded files (setFilePath), so there are no sustained buffer
    // stalls. If streaming (setStreamUrl) is ever wired into the player flow,
    // additionally gate accrual on processingState == ready (spec fs-16 m7).
    final acc = _accumulator;
    if (acc == null) return;
    if (isPlaying) {
      acc.onPlay();
    } else {
      acc.onPause();
    }
  }

  void _onTick(Duration position) {
    // ── Near-end check (runs every tick, before the autosave-throttle block) ──
    final book = _bookId;
    final uuid = currentChapterUuid;
    final dur = _engine.duration;
    // Chapters shorter than kFinishThreshold rely on completionStream exclusively for ticks.
    if (book != null && uuid != null && dur != null && dur > kFinishThreshold) {
      final remaining = dur - position;
      if (remaining <= kFinishThreshold) {
        if (_nearEndTickedUuid != uuid) {
          _nearEndTickedUuid = uuid;
          if (!_chapterCompleted.isClosed) _chapterCompleted.add(uuid);
        }
        final isLast = _index == _playlist.length - 1;
        // I2: only emit the book-finish event while actually playing — a scrub/seek
        // while paused (engine emits a position on seek) must NOT hide the book.
        if (isLast && !_bookFinishEmitted && _engine.playing) {
          _bookFinishEmitted = true;
          if (!_bookCompleted.isClosed) _bookCompleted.add(book);
        }
      }
    }
    // ── Autosave-throttle block (unchanged) ──────────────────────────────────
    final last = _lastSave;
    final now = _now();
    if (last == null || now.difference(last) >= _autosaveInterval) {
      final book = _bookId;
      final uuid = currentChapterUuid;
      if (book != null && uuid != null) {
        _lastSave = now;
        // Fire-and-forget; ordering preserved by the single-subscription stream.
        _store.savePlayback(
            book, uuid, position.inMilliseconds, now.toUtc().toIso8601String());
        // fs-16: tick the accumulator and buffer any drained days.
        _tickStats(book);
      }
    }
  }

  /// Tick the stats accumulator and upsert drained days into the offline buffer.
  void _tickStats(String bookId) {
    final acc = _accumulator;
    final db = _statsDb;
    final session = _sessionId;
    if (acc == null || db == null || session == null) return;
    acc.tick();
    final result = acc.drain();
    for (final day in result.days) {
      db.upsertListenStatAccrual(
        sessionId: session,
        bookId: bookId,
        date: day.date,
        seconds: day.seconds,
      );
    }
  }

  /// Persist the prior book's accumulated stats to the offline buffer.
  Future<void> _persistStatsHandoff(BookHandoff handoff) async {
    final db = _statsDb;
    final session = _sessionId;
    if (db == null || session == null || handoff.days.isEmpty) return;
    for (final day in handoff.days) {
      await db.upsertListenStatAccrual(
        sessionId: session,
        bookId: handoff.bookId,
        date: day.date,
        seconds: day.seconds,
      );
    }
  }

  Future<void> dispose() async {
    await _sub?.cancel();
    await _completionSub?.cancel();
    await _playingSub?.cancel();
    await _playing.close();
    await _nowPlaying.close();
    await _chapterCompleted.close();
    await _bookCompleted.close();
    await _bookReplayed.close();
    await _engine.dispose();
  }
}
