import 'package:castwright/src/data/api_client.dart';
import 'package:castwright/src/data/pairing_service.dart' show Connection;
import 'package:castwright/src/domain/paired_server.dart';
import 'package:castwright/src/demo/demo_http_send.dart';
import 'package:flutter_test/flutter_test.dart';

ApiClient client({bool offline = false}) => ApiClient(
      const Connection(
        server: PairedServer(
            url: 'https://demo.local', token: 't', caFingerprint: 'f'),
        caPem: 'placeholder-not-a-real-cert',
      ),
      send: demoHttpSend(offline: offline),
    );

void main() {
  test('serves a non-empty manifest index', () async {
    final index = await client().syncManifestIndex();
    expect(index.books, isNotEmpty);
    expect(index.activeBookIds, isNotEmpty);
  });

  test('every index book resolves a detail with chapters', () async {
    final api = client();
    final index = await api.syncManifestIndex();
    for (final b in index.books) {
      final detail = await api.syncManifestBookDetail(b.bookId);
      expect(detail.bookId, b.bookId);
      expect(detail.chapters, isNotEmpty);
    }
  });

  test('chapter audio endpoint returns waveform peaks', () async {
    final api = client();
    final index = await api.syncManifestIndex();
    final detail = await api.syncManifestBookDetail(index.books.first.bookId);
    final peaks = await api.getChapterPeaks(detail.bookId, detail.chapters.first.id);
    expect(peaks, isNotEmpty);
  });

  test('listen-progress is 404 (null)', () async {
    expect(await client().getListenProgress('any'), isNull);
  });

  test('offline makes the manifest paths throw ApiException', () async {
    expect(() => client(offline: true).syncManifestIndex(),
        throwsA(isA<ApiException>()));
  });
}
