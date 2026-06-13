import 'package:flutter_test/flutter_test.dart';
import 'package:castwright/src/domain/media_browse_tree.dart';

void main() {
  final lib = [
    BrowseBook(bookId: 'b1', title: 'Book One', author: 'A', chapters: const [
      BrowseChapter(uuid: 'u1', title: 'Ch 1'),
      BrowseChapter(uuid: 'u2', title: 'Ch 2'),
    ]),
    BrowseBook(bookId: 'b2', title: 'Book Two', author: 'B', chapters: const []),
  ];

  group('mediaId codec', () {
    test('round-trips root / book / chapter', () {
      expect(parseMediaId(rootMediaId).kind, MediaIdKind.root);

      final book = parseMediaId(bookMediaId('b1'));
      expect(book.kind, MediaIdKind.book);
      expect(book.bookId, 'b1');

      final ch = parseMediaId(chapterMediaId('b1', 'u2'));
      expect(ch.kind, MediaIdKind.chapter);
      expect(ch.bookId, 'b1');
      expect(ch.uuid, 'u2');
    });

    test('tolerates a uuid containing slashes is not expected but parses safely', () {
      final ch = parseMediaId('chapter/b1/u2');
      expect(ch.uuid, 'u2');
    });
  });

  group('mediaId codec (Android Auto tabs)', () {
    test('round-trips the current / library / recent sentinels', () {
      expect(parseMediaId(currentMediaId).kind, MediaIdKind.current);
      expect(parseMediaId(libraryMediaId).kind, MediaIdKind.library);
      expect(parseMediaId(recentMediaId).kind, MediaIdKind.recent);
    });
  });

  group('rootBrowseChildren', () {
    test('shows the current-book tab first, then Library, when a book is current', () {
      final nodes = rootBrowseChildren(currentBookTitle: 'Unraveled');
      expect(nodes.map((n) => n.id), [currentMediaId, libraryMediaId]);
      expect(nodes.first.title, 'Unraveled');
      expect(nodes.last.title, 'Library');
      expect(nodes.every((n) => !n.playable), isTrue);
    });

    test('hides the current-book tab when there is no current book', () {
      final nodes = rootBrowseChildren(currentBookTitle: null);
      expect(nodes.map((n) => n.id), [libraryMediaId]);
    });
  });

  group('content-style extras', () {
    test('list extras request the LIST hint for browsable + playable children', () {
      expect(listContentStyleExtras['android.media.browse.CONTENT_STYLE_BROWSABLE_HINT'],
          1);
      expect(listContentStyleExtras['android.media.browse.CONTENT_STYLE_PLAYABLE_HINT'],
          1);
    });
  });

  group('buildMediaBrowseTree', () {
    test('root lists books as browsable nodes', () {
      final root = buildMediaBrowseTree(lib);
      expect(root.id, rootMediaId);
      expect(root.children.map((n) => n.title), ['Book One', 'Book Two']);
      expect(root.children.every((n) => !n.playable), isTrue);
      expect(root.children.first.id, bookMediaId('b1'));
    });

    test('a book node lists its chapters as playable nodes', () {
      final root = buildMediaBrowseTree(lib);
      final b1 = root.children.first;
      expect(b1.children.map((c) => c.title), ['Ch 1', 'Ch 2']);
      expect(b1.children.every((c) => c.playable), isTrue);
      expect(b1.children.last.id, chapterMediaId('b1', 'u2'));
    });

    test('childrenOf returns a node\'s children by media id', () {
      final root = buildMediaBrowseTree(lib);
      expect(childrenOf(root, rootMediaId).length, 2);
      expect(childrenOf(root, bookMediaId('b1')).map((c) => c.title),
          ['Ch 1', 'Ch 2']);
      expect(childrenOf(root, bookMediaId('missing')), isEmpty);
    });
  });
}
