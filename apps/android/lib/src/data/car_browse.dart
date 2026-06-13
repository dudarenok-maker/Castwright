import 'package:audio_service/audio_service.dart';

import '../domain/media_browse_tree.dart';
import 'art_uri.dart';
import 'drift_local_library.dart' show BookSummary, DownloadedChapter;

/// The book + chapter the listener is currently on (or most-recently was),
/// resolved by the runtime from the live player then the persisted resume point.
class CarCurrent {
  const CarCurrent({this.bookId, this.chapterUuid});
  final String? bookId;
  final String? chapterUuid;
}

/// Builds the Android Auto browse tree (app-9) from the downloaded library.
///
/// Pure-ish glue over injected data accessors so it unit-tests without drift /
/// the player. Shows **downloaded-only** content (`bytes > 0`) — everything
/// listed is playable offline in the car. The runtime wires the real library +
/// player; [getChildren] / [playFromMediaId] feed the audio_service handler.
class CarBrowse {
  CarBrowse({
    required this.allBooks,
    required this.chaptersForBook,
    required this.current,
    required this.play,
    Uri? Function(String? thumbPath)? art,
  }) : art = art ?? carArtUri;

  final Future<List<BookSummary>> Function() allBooks;
  final Future<List<DownloadedChapter>> Function(String bookId) chaptersForBook;
  final Future<CarCurrent> Function() current;
  final Future<void> Function(String bookId, String uuid) play;
  final Uri? Function(String? thumbPath) art;

  Future<List<MediaItem>> getChildren(String parentMediaId) async {
    final parsed = parseMediaId(parentMediaId);
    switch (parsed.kind) {
      case MediaIdKind.root:
        return _rootItems();
      case MediaIdKind.current:
        final cur = await current();
        // Rotate so the chapter you're on leads the list (pre-scrolled in the
        // car); the next chapters follow immediately, wrapping to earlier ones.
        return cur.bookId == null
            ? const []
            : _chapterItems(cur.bookId!, startAtUuid: cur.chapterUuid);
      case MediaIdKind.book:
        return _chapterItems(parsed.bookId!);
      case MediaIdKind.library:
        return _libraryItems();
      case MediaIdKind.recent:
        return _recentItems();
      case MediaIdKind.chapter:
      case MediaIdKind.unknown:
        return const [];
    }
  }

  Future<void> playFromMediaId(String mediaId) async {
    final parsed = parseMediaId(mediaId);
    if (parsed.kind != MediaIdKind.chapter) return;
    await play(parsed.bookId!, parsed.uuid!);
  }

  // --- internals -----------------------------------------------------------

  /// Downloaded (`bytes > 0`) chapters for a book — the only ones playable offline.
  Future<List<DownloadedChapter>> _downloaded(String bookId) async {
    final chs = await chaptersForBook(bookId);
    return [for (final c in chs) if (c.bytes > 0) c];
  }

  Future<List<MediaItem>> _rootItems() async {
    final title = await _currentBookTitle();
    return [
      for (final n in rootBrowseChildren(currentBookTitle: title))
        MediaItem(
          id: n.id,
          title: n.title,
          playable: false,
          extras: listContentStyleExtras,
        ),
    ];
  }

  /// The current book's title — but only when it actually has downloaded audio
  /// (else Tab 1 is hidden).
  Future<String?> _currentBookTitle() async {
    final bid = (await current()).bookId;
    if (bid == null) return null;
    if ((await _downloaded(bid)).isEmpty) return null;
    for (final b in await allBooks()) {
      if (b.bookId == bid) return b.title.isEmpty ? 'Current book' : b.title;
    }
    return null;
  }

  Future<MediaItem> _chapterItem(
      String bookId, DownloadedChapter c, Uri? artUri) async {
    return MediaItem(
      id: chapterMediaId(bookId, c.uuid),
      title: c.title.isEmpty ? 'Chapter ${c.chapterId}' : c.title,
      playable: true,
      artUri: artUri,
      duration: c.durationSec != null
          ? Duration(milliseconds: (c.durationSec! * 1000).round())
          : null,
    );
  }

  Future<List<MediaItem>> _chapterItems(String bookId,
      {String? startAtUuid}) async {
    var chs = await _downloaded(bookId);
    if (startAtUuid != null) chs = _rotateToCurrent(chs, startAtUuid);
    final artUri = art(await _coverFor(bookId));
    return [for (final c in chs) await _chapterItem(bookId, c, artUri)];
  }

  /// Rotate [chs] so the chapter with [currentUuid] is first (forward order,
  /// wrapping). Unchanged if it's absent or already first.
  List<DownloadedChapter> _rotateToCurrent(
      List<DownloadedChapter> chs, String currentUuid) {
    final i = chs.indexWhere((c) => c.uuid == currentUuid);
    if (i <= 0) return chs;
    return [...chs.sublist(i), ...chs.sublist(0, i)];
  }

  Future<List<MediaItem>> _libraryItems() async {
    final items = <MediaItem>[];
    for (final b in await allBooks()) {
      if ((await _downloaded(b.bookId)).isEmpty) continue; // downloaded-only
      items.add(MediaItem(
        id: bookMediaId(b.bookId),
        title: b.title,
        artist: b.author,
        playable: false,
        artUri: art(b.coverThumbPath),
        extras: listContentStyleExtras,
      ));
    }
    return items;
  }

  Future<List<MediaItem>> _recentItems() async {
    final cur = await current();
    final bid = cur.bookId, uuid = cur.chapterUuid;
    if (bid == null || uuid == null) return const [];
    final match =
        (await _downloaded(bid)).where((c) => c.uuid == uuid).toList();
    if (match.isEmpty) return const [];
    return [await _chapterItem(bid, match.first, art(await _coverFor(bid)))];
  }

  Future<String?> _coverFor(String bookId) async {
    for (final b in await allBooks()) {
      if (b.bookId == bookId) return b.coverThumbPath;
    }
    return null;
  }
}
