import 'package:flutter_test/flutter_test.dart';
import 'package:castwright/src/domain/library_tree.dart';

LibraryBook bk(
  String id, {
  String author = 'A',
  String series = '',
  double? pos,
  String? title,
  BookDownloadState state = BookDownloadState.downloaded,
}) =>
    LibraryBook(
      bookId: id,
      title: title ?? id,
      author: author,
      series: series,
      seriesPosition: pos,
      downloadState: state,
    );

void main() {
  group('buildLibraryTree', () {
    test('groups by author then series, sorted, books by series position', () {
      final tree = buildLibraryTree([
        bk('b3', author: 'Zane', series: 'Saga', pos: 2, title: 'Two'),
        bk('b1', author: 'Anna', series: 'Saga', pos: 2, title: 'A2'),
        bk('b2', author: 'Anna', series: 'Saga', pos: 1, title: 'A1'),
        bk('b4', author: 'Zane', series: 'Saga', pos: 1, title: 'One'),
      ]);

      expect(tree.map((a) => a.author), ['Anna', 'Zane']); // authors sorted
      final anna = tree.first;
      expect(anna.series.single.series, 'Saga');
      expect(anna.series.single.books.map((b) => b.title), ['A1', 'A2']); // by pos
      final zane = tree.last;
      expect(zane.series.single.books.map((b) => b.title), ['One', 'Two']);
    });

    test('standalone (no series) books group under an empty series bucket', () {
      final tree = buildLibraryTree([
        bk('b1', author: 'Anna', series: '', title: 'Solo'),
      ]);
      expect(tree.single.series.single.series, '');
      expect(tree.single.series.single.books.single.title, 'Solo');
    });

    test('orders by decimal series position (novella 8.5 between 8 and 9)', () {
      final tree = buildLibraryTree([
        bk('b1', author: 'DR', series: 'the Hollow Tide', pos: 9, title: 'The Drowning Bell'),
        bk('b2', author: 'DR', series: 'the Hollow Tide', pos: 8, title: 'The Lantern Tide'),
        bk('b3', author: 'DR', series: 'the Hollow Tide', pos: 8.5, title: 'The Floodmark'),
      ]);
      expect(tree.single.series.single.books.map((b) => b.title),
          ['The Lantern Tide', 'The Floodmark', 'The Drowning Bell']);
    });

    test('formatSeriesPosition shows decimals only when needed', () {
      expect(formatSeriesPosition(8.5), '8.5');
      expect(formatSeriesPosition(1), '1');
      expect(formatSeriesPosition(null), '');
    });

    test('a series with null positions falls back to title order', () {
      final tree = buildLibraryTree([
        bk('b1', author: 'A', series: 'S', title: 'Beta'),
        bk('b2', author: 'A', series: 'S', title: 'Alpha'),
      ]);
      expect(
          tree.single.series.single.books.map((b) => b.title), ['Alpha', 'Beta']);
    });
  });

  group('filterBooks', () {
    final books = [
      bk('b1', author: 'Brandon Sanderson', title: 'Mistborn'),
      bk('b2', author: 'Anna', title: 'The Way of Kings'),
    ];

    test('empty query returns everything', () {
      expect(filterBooks(books, '').length, 2);
    });

    test('matches title case-insensitively', () {
      expect(filterBooks(books, 'mistborn').single.bookId, 'b1');
    });

    test('matches author', () {
      expect(filterBooks(books, 'sanderson').single.bookId, 'b1');
    });

    test('matches series — keeps every book in a matched series', () {
      final series = [
        bk('b1', author: 'Della Renwick', series: 'The Hollow Tide', title: 'The Ebb'),
        bk('b2', author: 'Della Renwick', series: 'The Hollow Tide', title: 'Saltgrave'),
        bk('b3', author: 'Other', series: 'Different', title: 'Standalone'),
      ];
      final hit = filterBooks(series, 'hollow');
      expect(hit.map((b) => b.bookId), ['b1', 'b2']);
    });
  });
}
