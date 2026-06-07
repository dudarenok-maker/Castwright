import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:image/image.dart' as img;
import 'package:castwright/src/data/cover_thumbnails.dart';
import 'package:castwright/src/data/file_store.dart';

class _FakeStore implements ThumbnailStore {
  final Map<String, String> paths = {};
  @override
  Future<String?> coverThumbPath(String bookId) async => paths[bookId];
  @override
  Future<void> setCoverThumbPath(String bookId, String path) async =>
      paths[bookId] = path;
}

void main() {
  group('resizeJpegToWidth', () {
    test('downscales a large JPEG to the target width', () {
      final big = img.Image(width: 1000, height: 600);
      img.fill(big, color: img.ColorRgb8(10, 20, 30));
      final srcBytes = img.encodeJpg(big);

      final out = resizeJpegToWidth(srcBytes, 250);
      final decoded = img.decodeImage(Uint8List.fromList(out))!;
      expect(decoded.width, 250);
      expect(out.length, lessThan(srcBytes.length));
    });

    test('does not upscale an already-small image', () {
      final small = img.Image(width: 100, height: 80);
      final srcBytes = img.encodeJpg(small);
      final out = resizeJpegToWidth(srcBytes, 250);
      final decoded = img.decodeImage(Uint8List.fromList(out))!;
      expect(decoded.width, 100);
    });
  });

  group('ThumbnailCache', () {
    test('fetches + resizes + stores on first call, returns the cached path', () async {
      final fs = InMemoryFileStore();
      final store = _FakeStore();
      var fetches = 0;
      final cache = ThumbnailCache(
        fs: fs,
        store: store,
        root: '/data',
        fetch: (bookId) async {
          fetches++;
          return [1, 2, 3, 4];
        },
        resize: (src, width) => [9, 9], // fake resize for orchestration test
      );

      final path = await cache.ensureThumbnail('b1');
      expect(path, '/data/thumbs/b1.jpg');
      expect(await fs.read(path), [9, 9]);
      expect(store.paths['b1'], path);
      expect(fetches, 1);
    });

    test('returns the cached file without re-fetching', () async {
      final fs = InMemoryFileStore();
      final store = _FakeStore();
      var fetches = 0;
      final cache = ThumbnailCache(
        fs: fs,
        store: store,
        root: '/data',
        fetch: (bookId) async {
          fetches++;
          return [1];
        },
        resize: (src, width) => [9],
      );

      await cache.ensureThumbnail('b1');
      await cache.ensureThumbnail('b1');
      expect(fetches, 1); // second call hit the cache
    });

    test('re-fetches when the recorded thumbnail file is missing', () async {
      final fs = InMemoryFileStore();
      final store = _FakeStore()..paths['b1'] = '/data/thumbs/b1.jpg';
      var fetches = 0;
      final cache = ThumbnailCache(
        fs: fs,
        store: store,
        root: '/data',
        fetch: (bookId) async {
          fetches++;
          return [1];
        },
        resize: (src, width) => [9],
      );

      await cache.ensureThumbnail('b1'); // path recorded but no file on disk
      expect(fetches, 1);
      expect(await fs.exists('/data/thumbs/b1.jpg'), isTrue);
    });
  });
}
