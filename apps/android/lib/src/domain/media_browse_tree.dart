/// Pure media-browser tree for in-car head units (`app-9`, Android Auto +
/// CarPlay). The audio_service `MediaBrowser` callbacks map these nodes to
/// `MediaItem`s; building + addressing the tree is pure, so it unit-tests
/// without the car/native layer.
library;

const String rootMediaId = 'root';

String bookMediaId(String bookId) => 'book/$bookId';
String chapterMediaId(String bookId, String uuid) => 'chapter/$bookId/$uuid';

enum MediaIdKind { root, book, chapter, unknown }

class MediaId {
  const MediaId(this.kind, {this.bookId, this.uuid});
  final MediaIdKind kind;
  final String? bookId;
  final String? uuid;
}

MediaId parseMediaId(String id) {
  if (id == rootMediaId) return const MediaId(MediaIdKind.root);
  final parts = id.split('/');
  if (parts.length == 2 && parts[0] == 'book') {
    return MediaId(MediaIdKind.book, bookId: parts[1]);
  }
  if (parts.length == 3 && parts[0] == 'chapter') {
    return MediaId(MediaIdKind.chapter, bookId: parts[1], uuid: parts[2]);
  }
  return const MediaId(MediaIdKind.unknown);
}

class BrowseChapter {
  const BrowseChapter({required this.uuid, required this.title});
  final String uuid;
  final String title;
}

class BrowseBook {
  const BrowseBook({
    required this.bookId,
    required this.title,
    required this.author,
    required this.chapters,
  });
  final String bookId;
  final String title;
  final String author;
  final List<BrowseChapter> chapters;
}

class MediaNode {
  const MediaNode({
    required this.id,
    required this.title,
    this.subtitle,
    required this.playable,
    this.children = const [],
  });
  final String id;
  final String title;
  final String? subtitle;
  final bool playable;
  final List<MediaNode> children;
}

/// Root → books (browsable) → chapters (playable).
MediaNode buildMediaBrowseTree(List<BrowseBook> books) {
  return MediaNode(
    id: rootMediaId,
    title: 'Library',
    playable: false,
    children: [
      for (final b in books)
        MediaNode(
          id: bookMediaId(b.bookId),
          title: b.title,
          subtitle: b.author,
          playable: false,
          children: [
            for (final c in b.chapters)
              MediaNode(
                id: chapterMediaId(b.bookId, c.uuid),
                title: c.title,
                playable: true,
              ),
          ],
        ),
    ],
  );
}

/// The children the head unit should show for [parentMediaId] (empty if none).
List<MediaNode> childrenOf(MediaNode root, String parentMediaId) {
  if (parentMediaId == root.id) return root.children;
  for (final book in root.children) {
    if (book.id == parentMediaId) return book.children;
  }
  return const [];
}
