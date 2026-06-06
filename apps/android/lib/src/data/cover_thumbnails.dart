import 'dart:typed_data';

import 'package:image/image.dart' as img;

import 'file_store.dart';

/// Minimal store seam the thumbnail cache reads/writes — satisfied by
/// [DriftLocalLibrary] without changes.
abstract class ThumbnailStore {
  Future<String?> coverThumbPath(String bookId);
  Future<void> setCoverThumbPath(String bookId, String path);
}

/// Fetches the full-resolution cover bytes for a book (the cert-pinned
/// `GET /api/books/:id/cover`). Injectable for tests.
typedef CoverFetcher = Future<List<int>> Function(String bookId);

/// Downscales source JPEG bytes to a target width. Injectable so the cache
/// orchestration tests without real image decoding.
typedef JpegResizer = List<int> Function(List<int> src, int targetWidth);

/// Caches a small (~250 px) cover thumbnail per book for lists/grids and the
/// lock-screen media session — fetching the full-res cover only once and
/// downscaling on-device (the D11 server `?width=` resize is a later
/// optimization). The full-res cover is fetched separately only for the
/// now-playing screen.
class ThumbnailCache {
  ThumbnailCache({
    required FileStore fs,
    required ThumbnailStore store,
    required CoverFetcher fetch,
    String root = '',
    int width = 250,
    JpegResizer? resize,
  })  : _fileStore = fs,
        _thumbStore = store,
        _fetcher = fetch,
        _rootPath = root,
        _targetWidth = width,
        _resize = resize ?? resizeJpegToWidth;

  final FileStore _fileStore;
  final ThumbnailStore _thumbStore;
  final CoverFetcher _fetcher;
  final String _rootPath;
  final int _targetWidth;
  final JpegResizer _resize;

  /// Returns the on-disk path to the book's thumbnail, creating it (fetch →
  /// downscale → write) if it isn't already cached.
  Future<String> ensureThumbnail(String bookId) async {
    final cached = await _thumbStore.coverThumbPath(bookId);
    if (cached != null && await _fileStore.exists(cached)) return cached;

    final src = await _fetcher(bookId);
    final small = _resize(src, _targetWidth);
    final path = '$_rootPath/thumbs/$bookId.jpg';
    await _fileStore.writeBytes(path, small);
    await _thumbStore.setCoverThumbPath(bookId, path);
    return path;
  }
}

/// Decode [src], downscale to [targetWidth] (never upscaling), and re-encode as
/// JPEG. Returns [src] unchanged if it isn't a decodable image.
List<int> resizeJpegToWidth(List<int> src, int targetWidth) {
  final decoded = img.decodeImage(Uint8List.fromList(src));
  if (decoded == null) return src;
  final resized = decoded.width <= targetWidth
      ? decoded
      : img.copyResize(decoded, width: targetWidth);
  return img.encodeJpg(resized, quality: 80);
}
