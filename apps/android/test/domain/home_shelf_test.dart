import 'package:flutter_test/flutter_test.dart';
import 'package:audiobook_companion/src/domain/home_shelf.dart';

ShelfBook sb(String id, {String? lastPlayedAt, String updatedAt = 't'}) =>
    ShelfBook(
      bookId: id,
      title: id,
      author: 'A',
      lastPlayedAt: lastPlayedAt,
      updatedAt: updatedAt,
    );

void main() {
  group('buildContinueListening', () {
    test('only in-progress books, most-recently-played first', () {
      final shelf = buildContinueListening([
        sb('a', lastPlayedAt: '2026-06-06T10:00:00Z'),
        sb('b', lastPlayedAt: null), // never started -> excluded
        sb('c', lastPlayedAt: '2026-06-06T12:00:00Z'),
      ]);
      expect(shelf.map((b) => b.bookId), ['c', 'a']);
    });

    test('treats empty lastPlayedAt as not started', () {
      final shelf = buildContinueListening([sb('a', lastPlayedAt: '')]);
      expect(shelf, isEmpty);
    });
  });

  group('buildRecentlyUpdated', () {
    test('sorts by updatedAt desc and respects the limit', () {
      final rail = buildRecentlyUpdated([
        sb('a', updatedAt: '2026-06-01T00:00:00Z'),
        sb('b', updatedAt: '2026-06-06T00:00:00Z'),
        sb('c', updatedAt: '2026-06-03T00:00:00Z'),
      ], limit: 2);
      expect(rail.map((b) => b.bookId), ['b', 'c']);
    });
  });
}
