import 'package:drift/native.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:castwright/src/data/library_database.dart';
import 'package:castwright/src/data/listen_stats_service.dart';

// ── Fake API ──────────────────────────────────────────────────────────────────

class FakeListenStatsApi implements ListenStatsApi {
  final List<String> calls = []; // 'bookId|sessionId|date:secs,...'
  bool shouldThrow = false;

  @override
  Future<void> putListenStats(
    String bookId, {
    required String sessionId,
    required List<StatDay> days,
  }) async {
    if (shouldThrow) throw Exception('network error');
    final dayStr = days.map((d) => '${d.date}:${d.seconds}').join(',');
    calls.add('$bookId|$sessionId|$dayStr');
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

LibraryDatabase _makeDb() => LibraryDatabase(NativeDatabase.memory());

ListenStatsFlushService _makeService(
        FakeListenStatsApi api, LibraryDatabase db) =>
    ListenStatsFlushService(api: api, db: db);

// ── Tests ─────────────────────────────────────────────────────────────────────

void main() {
  group('ListenStatsFlushService.flush', () {
    test('PUTs buffered absolutes and clears rows on success', () async {
      final db = _makeDb();
      final api = FakeListenStatsApi();

      await db.upsertListenStatAccrual(
          sessionId: 's1', bookId: 'b1', date: '2026-06-14', seconds: 120);

      await _makeService(api, db).flush();

      expect(api.calls.length, 1);
      expect(api.calls.single, 'b1|s1|2026-06-14:120');
      // Buffer must be empty after a successful flush.
      expect(await db.pendingByBook(), isEmpty);
      await db.close();
    });

    test('a failing API leaves the buffer intact', () async {
      final db = _makeDb();
      final api = FakeListenStatsApi()..shouldThrow = true;

      await db.upsertListenStatAccrual(
          sessionId: 's1', bookId: 'b1', date: '2026-06-14', seconds: 60);

      await _makeService(api, db).flush();

      // No rows cleared — the buffer survived.
      final pending = await db.pendingByBook();
      expect(pending['b1']!['s1']!.single.seconds, 60);
      await db.close();
    });

    test('a re-flush after a partial failure does not double-count', () async {
      final db = _makeDb();
      final api = FakeListenStatsApi();

      await db.upsertListenStatAccrual(
          sessionId: 's1', bookId: 'b1', date: '2026-06-14', seconds: 100);

      // First flush fails.
      api.shouldThrow = true;
      await _makeService(api, db).flush();
      api.shouldThrow = false;
      api.calls.clear();

      // Second flush succeeds — the absolute value is re-sent, not accumulated.
      await _makeService(api, db).flush();

      // The PUT carries the same absolute 100, not 200.
      expect(api.calls.single, 'b1|s1|2026-06-14:100');
      expect(await db.pendingByBook(), isEmpty);
      await db.close();
    });

    test('multiple (bookId, sessionId) pairs each get their own PUT', () async {
      final db = _makeDb();
      final api = FakeListenStatsApi();

      await db.upsertListenStatAccrual(
          sessionId: 's1', bookId: 'b1', date: '2026-06-14', seconds: 10);
      await db.upsertListenStatAccrual(
          sessionId: 's1', bookId: 'b2', date: '2026-06-14', seconds: 20);
      await db.upsertListenStatAccrual(
          sessionId: 's2', bookId: 'b1', date: '2026-06-14', seconds: 30);

      await _makeService(api, db).flush();

      // Three distinct PUTs (b1/s1, b2/s1, b1/s2 — order may vary).
      expect(api.calls.length, 3);
      expect(api.calls, containsAll([
        'b1|s1|2026-06-14:10',
        'b2|s1|2026-06-14:20',
        'b1|s2|2026-06-14:30',
      ]));
      expect(await db.pendingByBook(), isEmpty);
      await db.close();
    });

    test('flush on empty buffer is a no-op', () async {
      final db = _makeDb();
      final api = FakeListenStatsApi();

      await _makeService(api, db).flush();

      expect(api.calls, isEmpty);
      await db.close();
    });

    test('partial (book-level) failure: successful books are cleared, '
        'failed book rows survive', () async {
      final db = _makeDb();

      // We need a controllable per-call failure. Use a custom fake.
      final selectiveApi = _SelectiveFailApi({'b2'});
      final svc = ListenStatsFlushService(api: selectiveApi, db: db);

      await db.upsertListenStatAccrual(
          sessionId: 's1', bookId: 'b1', date: '2026-06-14', seconds: 10);
      await db.upsertListenStatAccrual(
          sessionId: 's1', bookId: 'b2', date: '2026-06-14', seconds: 20);

      await svc.flush();

      final pending = await db.pendingByBook();
      // b1 succeeded → cleared; b2 failed → still buffered.
      expect(pending.containsKey('b1'), isFalse);
      expect(pending['b2']!['s1']!.single.seconds, 20);
      await db.close();
    });
  });
}

/// Fake that throws only for books in [_failBookIds].
class _SelectiveFailApi implements ListenStatsApi {
  _SelectiveFailApi(this._failBookIds);
  final Set<String> _failBookIds;

  @override
  Future<void> putListenStats(
    String bookId, {
    required String sessionId,
    required List<StatDay> days,
  }) async {
    if (_failBookIds.contains(bookId)) throw Exception('fail $bookId');
  }
}
