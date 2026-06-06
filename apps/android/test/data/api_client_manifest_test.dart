import 'package:flutter_test/flutter_test.dart';
import 'package:audiobook_companion/src/data/api_client.dart';
import 'package:audiobook_companion/src/data/pairing_service.dart';
import 'package:audiobook_companion/src/domain/paired_server.dart';

Connection conn() => const Connection(
      server: PairedServer(url: 'https://10.0.0.5:8443', token: 'tok', caFingerprint: 'f'),
      caPem: 'PEM',
    );

const _indexBody = '''
{"schemaVersion":1,
 "books":[{"bookId":"b1","updatedAt":"2026-06-06T10:00:00.000Z","title":"B1",
           "author":"A","series":"S","seriesPosition":1,"chapterCount":3}],
 "activeBookIds":["b1","b2"]}
''';

const _detailBody = '''
{"schemaVersion":1,"bookId":"b1","updatedAt":"2026-06-06T10:00:00.000Z",
 "chapters":[{"uuid":"u1","id":1,"title":"C1",
              "fingerprint":"2026-06-06T09:00:00.000Z|100","urlSuffix":"audio.mp3",
              "audioUrl":"/api/books/b1/chapters/1/audio.mp3"}],
 "activeChapterUuids":["u1"]}
''';

void main() {
  group('ApiClient sync-manifest', () {
    test('syncManifestIndex GETs the manifest route and parses the index', () async {
      Uri? sentUrl;
      final api = ApiClient(conn(), send: (m, url, h) async {
        sentUrl = url;
        return const HttpResult(200, _indexBody);
      });

      final index = await api.syncManifestIndex();
      expect(sentUrl.toString(), 'https://10.0.0.5:8443/api/library/sync-manifest');
      expect(index.activeBookIds, ['b1', 'b2']);
      expect(index.books.single.bookId, 'b1');
    });

    test('syncManifestIndex appends ?since when given', () async {
      Uri? sentUrl;
      final api = ApiClient(conn(), send: (m, url, h) async {
        sentUrl = url;
        return const HttpResult(200, _indexBody);
      });

      await api.syncManifestIndex(since: '2026-06-06T00:00:00.000Z');
      expect(sentUrl!.path, '/api/library/sync-manifest');
      expect(sentUrl!.queryParameters['since'], '2026-06-06T00:00:00.000Z');
    });

    test('syncManifestBookDetail GETs ?bookId and parses the detail', () async {
      Uri? sentUrl;
      final api = ApiClient(conn(), send: (m, url, h) async {
        sentUrl = url;
        return const HttpResult(200, _detailBody);
      });

      final detail = await api.syncManifestBookDetail('b1');
      expect(sentUrl!.path, '/api/library/sync-manifest');
      expect(sentUrl!.queryParameters['bookId'], 'b1');
      expect(detail.chapters.single.uuid, 'u1');
      expect(detail.activeChapterUuids, ['u1']);
    });

    test('manifestApi adapter exposes the engine ManifestApi surface', () async {
      final api = ApiClient(conn(), send: (m, url, h) async =>
          const HttpResult(200, _indexBody));
      final source = api.manifestApi;
      final index = await source.index();
      expect(index.books.single.bookId, 'b1');
    });
  });
}
