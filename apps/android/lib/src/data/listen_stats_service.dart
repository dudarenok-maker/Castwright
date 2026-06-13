import 'library_database.dart';

/// A single (date, seconds) pair for the PUT body.
class StatDay {
  const StatDay({required this.date, required this.seconds});
  final String date;
  final int seconds;
}

/// The listen-stats PUT endpoint, injectable for tests.
/// Real implementation is [ApiClient.listenStatsApi].
abstract class ListenStatsApi {
  /// PUT /api/books/[bookId]/listen-stats — absolute accrual per day.
  /// Server performs max() upsert keyed by (date, sessionId), so re-sending
  /// is idempotent.
  Future<void> putListenStats(
    String bookId, {
    required String sessionId,
    required List<StatDay> days,
  });
}

/// Reads all buffered (sessionId, bookId, date, seconds) rows from the drift
/// offline buffer, PUTs each (bookId, sessionId) group to the server, and
/// clears the rows that were acknowledged. API failures are silently swallowed
/// so the buffer survives for the next reconnect; because the PUT is idempotent
/// (server uses max()), re-sending the same absolutes is always safe.
class ListenStatsFlushService {
  ListenStatsFlushService({
    required this._api,
    required this._db,
  });

  final ListenStatsApi _api;
  final LibraryDatabase _db;

  /// Flush all pending rows. Iterates each (bookId → sessionId) group in turn;
  /// per-group failures leave ONLY that group's rows in the buffer.
  Future<void> flush() async {
    final pending = await _db.pendingByBook();
    for (final bookEntry in pending.entries) {
      final bookId = bookEntry.key;
      for (final sessionEntry in bookEntry.value.entries) {
        final sessionId = sessionEntry.key;
        final dayRows = sessionEntry.value;
        if (dayRows.isEmpty) continue;

        final days = dayRows.map((r) => StatDay(date: r.date, seconds: r.seconds)).toList();
        try {
          await _api.putListenStats(bookId, sessionId: sessionId, days: days);
          await _db.clearFlushedListenStats(
            sessionId: sessionId,
            bookId: bookId,
            dates: dayRows.map((r) => r.date).toList(),
          );
        } on Exception {
          // Leave the rows; they will be re-sent on the next flush.
          // Re-sending absolutes is safe because the server uses max().
        }
      }
    }
  }
}
