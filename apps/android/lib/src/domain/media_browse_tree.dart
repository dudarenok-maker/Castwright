/// Pure media-browser tree for in-car head units (`app-9`, Android Auto +
/// CarPlay). The audio_service `MediaBrowser` callbacks map these nodes to
/// `MediaItem`s; building + addressing the tree is pure, so it unit-tests
/// without the car/native layer.
library;

const String rootMediaId = 'root';

/// Tab-1 sentinel — resolves to the current book's chapter list (app-9).
const String currentMediaId = 'current';

/// Tab-2 sentinel — resolves to the downloaded-book library.
const String libraryMediaId = 'library';

/// audio_service's "recent" root (`AudioService.recentRootId`) — Android Auto /
/// Assistant query this for one-tap resume. We answer it with the current chapter.
const String recentMediaId = 'recent';

String bookMediaId(String bookId) => 'book/$bookId';
String chapterMediaId(String bookId, String uuid) => 'chapter/$bookId/$uuid';

// --- Android Auto content-style extras -----------------------------------
// AA reads these keys from a browsable parent's extras to decide how to render
// its children (1 = list, 2 = grid). `MediaItem.extras` are propagated to AA.
const String _contentStyleBrowsableHint =
    'android.media.browse.CONTENT_STYLE_BROWSABLE_HINT';
const String _contentStylePlayableHint =
    'android.media.browse.CONTENT_STYLE_PLAYABLE_HINT';
const int _contentStyleListItem = 1;

/// Extras to attach to a browsable parent so AA renders its children as a list
/// (not a grid / not the awkward one-tab-per-item strip).
const Map<String, dynamic> listContentStyleExtras = {
  _contentStyleBrowsableHint: _contentStyleListItem,
  _contentStylePlayableHint: _contentStyleListItem,
};

enum MediaIdKind { root, current, library, recent, book, chapter, unknown }

class MediaId {
  const MediaId(this.kind, {this.bookId, this.uuid});
  final MediaIdKind kind;
  final String? bookId;
  final String? uuid;
}

MediaId parseMediaId(String id) {
  if (id == rootMediaId) return const MediaId(MediaIdKind.root);
  if (id == currentMediaId) return const MediaId(MediaIdKind.current);
  if (id == libraryMediaId) return const MediaId(MediaIdKind.library);
  if (id == recentMediaId) return const MediaId(MediaIdKind.recent);
  final parts = id.split('/');
  if (parts.length == 2 && parts[0] == 'book') {
    return MediaId(MediaIdKind.book, bookId: parts[1]);
  }
  if (parts.length == 3 && parts[0] == 'chapter') {
    return MediaId(MediaIdKind.chapter, bookId: parts[1], uuid: parts[2]);
  }
  return const MediaId(MediaIdKind.unknown);
}

/// The root's children for Android Auto: the current-book tab first (labelled
/// with the live book title), then "Library". When there is no current book
/// (nothing played / nothing downloaded), Tab 1 is hidden and the root is just
/// "Library". Both are browsable (`playable: false`).
List<MediaNode> rootBrowseChildren({String? currentBookTitle}) {
  return [
    if (currentBookTitle != null)
      MediaNode(id: currentMediaId, title: currentBookTitle, playable: false),
    const MediaNode(id: libraryMediaId, title: 'Library', playable: false),
  ];
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
