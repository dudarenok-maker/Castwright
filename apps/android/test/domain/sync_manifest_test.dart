import 'package:flutter_test/flutter_test.dart';
import 'package:castwright/src/domain/sync_manifest.dart';

void main() {
  group('SyncManifestIndex', () {
    test('parses the index shape with books and the full active set', () {
      final index = SyncManifestIndex.fromJson({
        'schemaVersion': 1,
        'books': [
          {
            'bookId': 'b1',
            'updatedAt': '2026-06-06T10:00:00.000Z',
            'title': 'Book One',
            'author': 'Anon',
            'series': 'Saga',
            'seriesPosition': 2,
            'chapterCount': 12,
            'coverUrl': '/api/books/b1/cover',
          },
        ],
        'activeBookIds': ['b1', 'b2'],
      });

      expect(index.schemaVersion, 1);
      expect(index.activeBookIds, ['b1', 'b2']);
      expect(index.books, hasLength(1));
      final b = index.books.single;
      expect(b.bookId, 'b1');
      expect(b.updatedAt, '2026-06-06T10:00:00.000Z');
      expect(b.title, 'Book One');
      expect(b.author, 'Anon');
      expect(b.series, 'Saga');
      expect(b.seriesPosition, 2);
      expect(b.chapterCount, 12);
      expect(b.coverUrl, '/api/books/b1/cover');
    });

    test('tolerates a null seriesPosition and an absent coverUrl', () {
      final index = SyncManifestIndex.fromJson({
        'schemaVersion': 1,
        'books': [
          {
            'bookId': 'b1',
            'updatedAt': '2026-06-06T10:00:00.000Z',
            'title': 'Loose',
            'author': '',
            'series': '',
            'seriesPosition': null,
            'chapterCount': 0,
          },
        ],
        'activeBookIds': ['b1'],
      });

      final b = index.books.single;
      expect(b.seriesPosition, isNull);
      expect(b.coverUrl, isNull);
    });
  });

  group('SyncManifestIndexBook', () {
    test('fromJson parses finished + hidden (default false when absent)', () {
      final b = SyncManifestIndexBook.fromJson({'bookId': 'b1', 'updatedAt': 't', 'finished': true});
      expect(b.finished, isTrue);
      expect(b.hidden, isFalse);
    });
  });

  group('SyncManifestBookDetail', () {
    test('parses uuid-keyed chapters with the full active set', () {
      final detail = SyncManifestBookDetail.fromJson({
        'schemaVersion': 1,
        'bookId': 'b1',
        'updatedAt': '2026-06-06T10:00:00.000Z',
        'chapters': [
          {
            'uuid': 'u-aaa',
            'id': 1,
            'title': 'Chapter 1',
            'fingerprint': '2026-06-06T09:00:00.000Z|123456',
            'urlSuffix': 'audio.m4a',
            'audioUrl': '/api/books/b1/chapters/1/audio.m4a',
            'durationSec': 321.5,
            'lufs': -18.2,
          },
          {
            'uuid': 'u-bbb',
            'id': 2,
            'title': 'Chapter 2 (no audio yet)',
          },
        ],
        'activeChapterUuids': ['u-aaa', 'u-bbb'],
      });

      expect(detail.bookId, 'b1');
      expect(detail.activeChapterUuids, ['u-aaa', 'u-bbb']);
      expect(detail.chapters, hasLength(2));

      final c1 = detail.chapters.first;
      expect(c1.uuid, 'u-aaa');
      expect(c1.id, 1);
      expect(c1.title, 'Chapter 1');
      expect(c1.fingerprint, '2026-06-06T09:00:00.000Z|123456');
      expect(c1.urlSuffix, 'audio.m4a');
      expect(c1.audioUrl, '/api/books/b1/chapters/1/audio.m4a');
      expect(c1.durationSec, 321.5);
      expect(c1.lufs, -18.2);
      expect(c1.hasAudio, isTrue);

      final c2 = detail.chapters.last;
      expect(c2.uuid, 'u-bbb');
      expect(c2.fingerprint, isNull);
      expect(c2.audioUrl, isNull);
      expect(c2.hasAudio, isFalse);
    });

    test('expectedSize is parsed from the fingerprint size component', () {
      final ch = SyncManifestChapter.fromJson({
        'uuid': 'u',
        'id': 3,
        'title': 't',
        'fingerprint': '2026-06-06T09:00:00.000Z|987',
        'urlSuffix': 'audio.mp3',
        'audioUrl': '/api/books/b1/chapters/3/audio.mp3',
      });
      expect(ch.expectedSize, 987);
    });

    test('expectedSize is null when there is no fingerprint', () {
      final ch = SyncManifestChapter.fromJson({
        'uuid': 'u',
        'id': 3,
        'title': 't',
      });
      expect(ch.expectedSize, isNull);
    });
  });
}
