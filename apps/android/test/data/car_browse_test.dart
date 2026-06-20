import 'package:flutter_test/flutter_test.dart';
import 'package:castwright/src/data/car_browse.dart';
import 'package:castwright/src/data/drift_local_library.dart';
import 'package:castwright/src/domain/media_browse_tree.dart';

BookSummary _book(String id, String title, String author, {String? cover}) =>
    BookSummary(
      bookId: id,
      title: title,
      author: author,
      series: '',
      seriesPosition: null,
      lastPlayedAt: null,
      coverThumbPath: cover,
      hidden: false,
      finished: false,
    );

DownloadedChapter _ch(String uuid, int id, String title, int bytes,
        {double? dur}) =>
    DownloadedChapter(
      uuid: uuid,
      chapterId: id,
      title: title,
      durationSec: dur,
      urlSuffix: 'a.mp3',
      bytes: bytes,
    );

// b1 "Unraveled": u1 downloaded (100B) + u2 evicted (0B). b2 "Empty": all evicted.
final _books = [
  _book('b1', 'Unraveled', 'Shannon', cover: '/t/b1.jpg'),
  _book('b2', 'Empty', 'X'),
];
final _chapters = <String, List<DownloadedChapter>>{
  'b1': [_ch('u1', 1, 'One', 100, dur: 60), _ch('u2', 2, 'Two', 0)],
  'b2': [_ch('e1', 1, 'E', 0)],
};

CarBrowse makeBrowse({
  CarCurrent current = const CarCurrent(),
  void Function(String bookId, String uuid)? onPlay,
}) =>
    CarBrowse(
      allBooks: () async => _books,
      chaptersForBook: (id) async => _chapters[id] ?? const [],
      current: () async => current,
      play: (b, u) async => onPlay?.call(b, u),
    );

void main() {
  group('CarBrowse root', () {
    test('shows the current-book tab (title) then Library when a book is current',
        () async {
      final items =
          await makeBrowse(current: const CarCurrent(bookId: 'b1', chapterUuid: 'u1'))
              .getChildren(rootMediaId);
      expect(items.map((i) => i.id), [currentMediaId, libraryMediaId]);
      expect(items.first.title, 'Unraveled');
      expect(items.every((i) => i.playable == false), isTrue);
    });

    test('hides the current-book tab when no book is current', () async {
      final items = await makeBrowse().getChildren(rootMediaId);
      expect(items.map((i) => i.id), [libraryMediaId]);
    });

    test('hides the current-book tab when the current book has no downloaded audio',
        () async {
      final items =
          await makeBrowse(current: const CarCurrent(bookId: 'b2', chapterUuid: 'e1'))
              .getChildren(rootMediaId);
      expect(items.map((i) => i.id), [libraryMediaId]);
    });
  });

  group('CarBrowse current/book chapters', () {
    test('lists only downloaded (bytes>0) chapters, with browse-tree ids', () async {
      final items =
          await makeBrowse(current: const CarCurrent(bookId: 'b1', chapterUuid: 'u1'))
              .getChildren(currentMediaId);
      expect(items.map((i) => i.id), [chapterMediaId('b1', 'u1')]); // u2 evicted
      expect(items.single.playable, isTrue);
      expect(items.single.title, 'One');
    });

    test('book/<id> resolves the same downloaded chapter list', () async {
      final items = await makeBrowse().getChildren(bookMediaId('b1'));
      expect(items.map((i) => i.id), [chapterMediaId('b1', 'u1')]);
    });

    test('current tab is rotated to start at the playing chapter (wrapping)',
        () async {
      final chs = [for (var i = 1; i <= 5; i++) _ch('u$i', i, 'C$i', 100)];
      final browse = CarBrowse(
        allBooks: () async => [_book('b', 'Book', 'A')],
        chaptersForBook: (_) async => chs,
        current: () async => const CarCurrent(bookId: 'b', chapterUuid: 'u3'),
        play: (_, _) async {},
      );

      final items = await browse.getChildren(currentMediaId);
      expect(items.map((i) => i.id), [
        chapterMediaId('b', 'u3'),
        chapterMediaId('b', 'u4'),
        chapterMediaId('b', 'u5'),
        chapterMediaId('b', 'u1'),
        chapterMediaId('b', 'u2'),
      ]);
    });

    test('browsing a book via Library keeps natural chapter order (no rotation)',
        () async {
      final chs = [for (var i = 1; i <= 5; i++) _ch('u$i', i, 'C$i', 100)];
      final browse = CarBrowse(
        allBooks: () async => [_book('b', 'Book', 'A')],
        chaptersForBook: (_) async => chs,
        current: () async => const CarCurrent(bookId: 'b', chapterUuid: 'u3'),
        play: (_, _) async {},
      );

      final items = await browse.getChildren(bookMediaId('b'));
      expect(items.map((i) => i.id),
          [for (var i = 1; i <= 5; i++) chapterMediaId('b', 'u$i')]);
    });
  });

  group('CarBrowse library', () {
    test('lists only books that have downloaded audio, author as subtitle', () async {
      final items = await makeBrowse().getChildren(libraryMediaId);
      expect(items.map((i) => i.id), [bookMediaId('b1')]); // b2 fully evicted → hidden
      expect(items.single.artist, 'Shannon');
      expect(items.single.playable, isFalse);
    });

    test('library rows carry a content:// cover uri (AA-readable)', () async {
      final items = await makeBrowse().getChildren(libraryMediaId);
      expect(items.single.artUri?.scheme, 'content');
      expect(items.single.artUri?.queryParameters['path'], '/t/b1.jpg');
    });
  });

  group('CarBrowse recent', () {
    test('returns the current chapter as a single playable resume item', () async {
      final items =
          await makeBrowse(current: const CarCurrent(bookId: 'b1', chapterUuid: 'u1'))
              .getChildren(recentMediaId);
      expect(items.single.id, chapterMediaId('b1', 'u1'));
      expect(items.single.playable, isTrue);
    });

    test('is empty when nothing is current', () async {
      expect(await makeBrowse().getChildren(recentMediaId), isEmpty);
    });
  });

  group('CarBrowse playFromMediaId', () {
    test('plays the chapter parsed from a chapter media id', () async {
      String? playedBook, playedUuid;
      await makeBrowse(onPlay: (b, u) {
        playedBook = b;
        playedUuid = u;
      }).playFromMediaId(chapterMediaId('b1', 'u1'));
      expect(playedBook, 'b1');
      expect(playedUuid, 'u1');
    });

    test('ignores a non-chapter media id', () async {
      var called = false;
      await makeBrowse(onPlay: (_, _) => called = true)
          .playFromMediaId(libraryMediaId);
      expect(called, isFalse);
    });
  });
}
