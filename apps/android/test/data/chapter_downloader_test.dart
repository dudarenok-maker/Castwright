import 'package:flutter_test/flutter_test.dart';
import 'package:castwright/src/data/chapter_downloader.dart';
import 'package:castwright/src/data/file_store.dart';

/// A fetch stub that plays back a queued list of responses, one per call, and
/// records the headers it was sent (so tests can assert the Range header).
class _FakeFetch {
  _FakeFetch(this._responses);
  final List<RangeResponse> _responses;
  final List<Map<String, String>> calls = [];
  int _i = 0;

  RangeFetch get fn => (Uri url, Map<String, String> headers) async {
        calls.add(Map.of(headers));
        return _responses[_i++];
      };
}

RangeResponse ok(int status, List<int> bytes) =>
    RangeResponse(statusCode: status, body: Stream.value(bytes));

RangeResponse fails(int status, List<int> head) => RangeResponse(
      statusCode: status,
      body: () async* {
        yield head;
        throw const SocketLikeError();
      }(),
    );

class SocketLikeError implements Exception {
  const SocketLikeError();
}

void main() {
  group('ChapterDownloader', () {
    test('downloads to .tmp, verifies size, and atomic-renames into place', () async {
      final fs = InMemoryFileStore();
      final fetch = _FakeFetch([ok(200, [1, 2, 3, 4])]);
      final dl = ChapterDownloader(fetch.fn, fs, delay: (_) async {});

      final outcome = await dl.download(
        url: Uri.parse('https://s/audio.mp3'),
        finalPath: '/books/b1/c1.mp3',
        expectedSize: 4,
      );

      expect(outcome.committed, isTrue);
      expect(await fs.read('/books/b1/c1.mp3'), [1, 2, 3, 4]);
      expect(await fs.exists('/books/b1/c1.mp3.tmp'), isFalse);
      // No Range header on a fresh download.
      expect(fetch.calls.single.containsKey('range'), isFalse);
    });

    test('resumes from a partial .tmp via a Range request', () async {
      final fs = InMemoryFileStore();
      // First attempt yields [1,2] then drops; second attempt resumes [3,4].
      final fetch = _FakeFetch([fails(200, [1, 2]), ok(206, [3, 4])]);
      final dl = ChapterDownloader(fetch.fn, fs, delay: (_) async {});

      final outcome = await dl.download(
        url: Uri.parse('https://s/audio.mp3'),
        finalPath: '/books/b1/c1.mp3',
        expectedSize: 4,
      );

      expect(outcome.committed, isTrue);
      expect(await fs.read('/books/b1/c1.mp3'), [1, 2, 3, 4]);
      // The retry sent Range: bytes=2- so the server only resends the tail.
      expect(fetch.calls[1]['range'], 'bytes=2-');
    });

    test('restarts when the server ignores Range and replies 200', () async {
      final fs = InMemoryFileStore();
      // Pre-seed a stale partial tmp, then the server ignores Range (200, full).
      await fs.writeBytes('/books/b1/c1.mp3.tmp', [9]);
      final fetch = _FakeFetch([ok(200, [1, 2, 3])]);
      final dl = ChapterDownloader(fetch.fn, fs, delay: (_) async {});

      final outcome = await dl.download(
        url: Uri.parse('https://s/audio.mp3'),
        finalPath: '/books/b1/c1.mp3',
        expectedSize: 3,
      );

      expect(outcome.committed, isTrue);
      expect(await fs.read('/books/b1/c1.mp3'), [1, 2, 3]);
    });

    test('rejects a size mismatch and gives up after retries', () async {
      final fs = InMemoryFileStore();
      final fetch = _FakeFetch([ok(200, [1, 2]), ok(200, [1, 2])]);
      final dl =
          ChapterDownloader(fetch.fn, fs, retries: 1, delay: (_) async {});

      await expectLater(
        dl.download(
          url: Uri.parse('https://s/audio.mp3'),
          finalPath: '/books/b1/c1.mp3',
          expectedSize: 4, // never satisfied
        ),
        throwsA(isA<DownloadException>()),
      );
      // The corrupt tmp is cleaned up, not left to poison the next sync.
      expect(await fs.exists('/books/b1/c1.mp3.tmp'), isFalse);
    });

    test('does not commit when commit is false (deferred swap)', () async {
      final fs = InMemoryFileStore();
      final fetch = _FakeFetch([ok(200, [1, 2, 3])]);
      final dl = ChapterDownloader(fetch.fn, fs, delay: (_) async {});

      final outcome = await dl.download(
        url: Uri.parse('https://s/audio.mp3'),
        finalPath: '/books/b1/c1.mp3',
        expectedSize: 3,
        commit: false,
      );

      expect(outcome.committed, isFalse);
      expect(await fs.exists('/books/b1/c1.mp3'), isFalse);
      expect(await fs.read('/books/b1/c1.mp3.tmp'), [1, 2, 3]);
    });
  });
}
