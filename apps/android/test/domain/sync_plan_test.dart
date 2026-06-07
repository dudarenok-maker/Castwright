import 'package:flutter_test/flutter_test.dart';
import 'package:castwright/src/domain/sync_manifest.dart';
import 'package:castwright/src/domain/sync_plan.dart';

SyncManifestIndex index(List<SyncManifestIndexBook> books, List<String> active) =>
    SyncManifestIndex(schemaVersion: 1, books: books, activeBookIds: active);

SyncManifestIndexBook book(String id, String updatedAt) => SyncManifestIndexBook(
      bookId: id,
      updatedAt: updatedAt,
      title: id,
      author: '',
      series: '',
      seriesPosition: null,
      chapterCount: 0,
    );

SyncManifestChapter chapter(
  String uuid,
  int id, {
  String? fingerprint,
  bool audio = true,
}) =>
    SyncManifestChapter(
      uuid: uuid,
      id: id,
      title: 'ch$id',
      fingerprint: audio ? (fingerprint ?? 't|100') : null,
      urlSuffix: audio ? 'audio.mp3' : null,
      audioUrl: audio ? '/api/books/b1/chapters/$id/audio.mp3' : null,
    );

SyncManifestBookDetail detail(List<SyncManifestChapter> chapters) =>
    SyncManifestBookDetail(
      schemaVersion: 1,
      bookId: 'b1',
      updatedAt: 't',
      chapters: chapters,
      activeChapterUuids: chapters.map((c) => c.uuid).toList(),
    );

void main() {
  group('planIndexSync', () {
    test('fetches an unknown book and a book whose updatedAt advanced', () {
      final plan = planIndexSync(
        index([book('b1', '2026-06-06T11:00:00Z'), book('b2', '2026-06-06T09:00:00Z')],
            ['b1', 'b2']),
        {'b2': '2026-06-06T09:00:00Z'}, // b1 unknown, b2 unchanged
      );
      expect(plan.booksToSync.map((b) => b.bookId), ['b1']);
      expect(plan.bookIdsToEvict, isEmpty);
    });

    test('re-fetches a book whose server updatedAt is newer than local', () {
      final plan = planIndexSync(
        index([book('b1', '2026-06-06T12:00:00Z')], ['b1']),
        {'b1': '2026-06-06T10:00:00Z'},
      );
      expect(plan.booksToSync.map((b) => b.bookId), ['b1']);
    });

    test('evicts a local book absent from the active set', () {
      final plan = planIndexSync(
        index([book('b1', 't')], ['b1']),
        {'b1': 't', 'gone': 't'},
      );
      expect(plan.booksToSync, isEmpty);
      expect(plan.bookIdsToEvict, ['gone']);
    });
  });

  group('planBookSync', () {
    test('downloads a new chapter and one whose fingerprint changed', () {
      final plan = planBookSync(
        detail([
          chapter('u1', 1, fingerprint: 'fp-new'), // changed
          chapter('u2', 2, fingerprint: 'fp-same'), // unchanged
          chapter('u3', 3, fingerprint: 'fp-3'), // brand new
        ]),
        {'u1': 'fp-old', 'u2': 'fp-same'},
      );
      expect(plan.chaptersToDownload.map((c) => c.uuid), ['u1', 'u3']);
      expect(plan.chapterUuidsToEvict, isEmpty);
    });

    test('does NOT re-download when only the positional id changed (uuid keying)', () {
      // Same uuid + same fingerprint, but the chapter was reordered so its
      // positional id moved 1 -> 5. srv-35 keying means no re-download.
      final plan = planBookSync(
        detail([chapter('u1', 5, fingerprint: 'fp-same')]),
        {'u1': 'fp-same'},
      );
      expect(plan.chaptersToDownload, isEmpty);
    });

    test('skips chapters that have no rendered audio yet', () {
      final plan = planBookSync(
        detail([chapter('u1', 1, audio: false)]),
        {},
      );
      expect(plan.chaptersToDownload, isEmpty);
    });

    test('evicts a local chapter absent from the active set', () {
      final plan = planBookSync(
        detail([chapter('u1', 1, fingerprint: 'fp')]),
        {'u1': 'fp', 'dead': 'whatever'},
      );
      expect(plan.chaptersToDownload, isEmpty);
      expect(plan.chapterUuidsToEvict, ['dead']);
    });
  });
}
