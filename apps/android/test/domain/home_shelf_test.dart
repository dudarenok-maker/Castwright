import 'package:flutter_test/flutter_test.dart';
import 'package:castwright/src/domain/home_shelf.dart';

ShelfBook sb(String id, {String? lastPlayedAt, String updatedAt = 't'}) =>
    ShelfBook(
      bookId: id,
      title: id,
      author: 'A',
      lastPlayedAt: lastPlayedAt,
      updatedAt: updatedAt,
    );

ShelfBook book(String id,
        {String? lastPlayedAt, bool hidden = false, bool finished = false}) =>
    ShelfBook(
      bookId: id,
      title: id,
      author: 'A',
      lastPlayedAt: lastPlayedAt,
      updatedAt: '',
      hidden: hidden,
      finished: finished,
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

    test('excludes hidden books', () {
      final shelf = buildContinueListening([
        book('a', lastPlayedAt: '2026-06-20T10:00:00Z'),
        book('b', lastPlayedAt: '2026-06-20T11:00:00Z', hidden: true),
      ]);
      expect(shelf.map((b) => b.bookId), ['a']);
    });

    test('still orders visible books newest-first', () {
      final shelf = buildContinueListening([
        book('a', lastPlayedAt: '2026-06-20T10:00:00Z'),
        book('b', lastPlayedAt: '2026-06-20T11:00:00Z'),
      ]);
      expect(shelf.map((b) => b.bookId), ['b', 'a']);
    });

    test('buildContinueListening excludes finished books', () {
      final shelf = buildContinueListening([
        book('a', lastPlayedAt: '2026-06-20T10:00:00Z'),
        book('b', lastPlayedAt: '2026-06-20T11:00:00Z', finished: true),
      ]);
      expect(shelf.map((b) => b.bookId), ['a']);
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
