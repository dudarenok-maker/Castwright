/// fs-16 — wall-clock listening accumulator, Dart mirror of
/// `src/lib/listen-stats-reporter.ts`. Rate- and seek-independent: sums real
/// elapsed time between play/pause/tick checkpoints using an injected clock,
/// never the media position. Buckets seconds by the injected local-date string;
/// switching books flushes the prior book's tally. Pure domain — no Flutter/IO
/// imports, no DateTime.now().
library;

/// One day's accumulated listening seconds for a book.
class DrainedDay {
  const DrainedDay({required this.date, required this.seconds});
  final String date;
  final int seconds;
}

/// Returned by [StatsAccumulator.drain].
class DrainResult {
  const DrainResult({required this.sessionPresent, required this.days});
  final bool sessionPresent;
  final List<DrainedDay> days;
}

/// Returned by [StatsAccumulator.switchBook].
class BookHandoff {
  const BookHandoff({required this.bookId, required this.days});
  final String bookId;
  final List<DrainedDay> days;
}

/// Accumulates wall-clock listening time for a single book, bucketed by local
/// date. Constructed with a [bookId], a [_now] clock returning ms-epoch ints,
/// and a [_localDate] returning the current local date as `'YYYY-MM-DD'`.
class StatsAccumulator {
  StatsAccumulator(this._bookId, this._now, this._localDate);

  String _bookId;
  final int Function() _now;
  final String Function() _localDate;

  final Map<String, double> _byDate = {};
  bool _playing = false;
  int _lastCheckpoint = 0;

  void _addElapsed() {
    if (!_playing) return;
    final t = _now();
    final secs = (t - _lastCheckpoint) / 1000.0;
    final date = _localDate();
    _byDate[date] = (_byDate[date] ?? 0.0) + (secs < 0 ? 0.0 : secs);
    _lastCheckpoint = t;
  }

  /// Start accruing. Idempotent: a second call while already playing does nothing.
  void onPlay() {
    if (_playing) return;
    _playing = true;
    _lastCheckpoint = _now();
  }

  /// Add elapsed since last checkpoint and stop accruing.
  void onPause() {
    _addElapsed();
    _playing = false;
  }

  /// Periodic checkpoint; also captures midnight rollover when [_localDate] flips.
  void tick() {
    _addElapsed();
  }

  /// Snapshot the accumulated days (rounded to whole seconds, zero-second days
  /// filtered) without clearing. Updates the checkpoint so draining twice while
  /// playing does not re-count the same interval.
  DrainResult drain() {
    _addElapsed();
    return DrainResult(
      sessionPresent: _byDate.isNotEmpty || _playing,
      days: _byDate.entries
          .map((e) => DrainedDay(date: e.key, seconds: e.value.round()))
          .where((d) => d.seconds > 0)
          .toList(),
    );
  }

  /// Flush the current book's tally and re-target [nextBookId]. Returns the
  /// prior book's days. If playing, the checkpoint is reset so the new book
  /// starts accruing from this moment.
  BookHandoff switchBook(String nextBookId) {
    _addElapsed();
    final prior = BookHandoff(
      bookId: _bookId,
      days: _byDate.entries
          .map((e) => DrainedDay(date: e.key, seconds: e.value.round()))
          .where((d) => d.seconds > 0)
          .toList(),
    );
    _byDate.clear();
    _bookId = nextBookId;
    if (_playing) _lastCheckpoint = _now();
    return prior;
  }
}
