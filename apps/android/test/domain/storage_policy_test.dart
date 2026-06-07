import 'package:flutter_test/flutter_test.dart';
import 'package:castwright/src/domain/storage_policy.dart';

ChapterUsage ch(String uuid, int bytes, {bool finished = false}) =>
    ChapterUsage(uuid: uuid, bytes: bytes, finished: finished);

BookUsage book(String id, String? lastPlayedAt, List<ChapterUsage> chapters) =>
    BookUsage(bookId: id, lastPlayedAt: lastPlayedAt, chapters: chapters);

List<String> refs(List<ChapterRef> r) =>
    r.map((c) => '${c.bookId}/${c.uuid}').toList();

void main() {
  group('planStorageEviction', () {
    test('does nothing when under cap and auto-delete-finished is off', () {
      final plan = planStorageEviction(
        books: [
          book('b1', 't', [ch('u1', 100, finished: true)]),
        ],
        capBytes: 1000,
        autoDeleteFinished: false,
        keepRecentBooks: 1,
      );
      expect(plan.chapterFilesToDrop, isEmpty);
      expect(plan.booksToEvict, isEmpty);
    });

    test('drops finished chapter files (with audio) but keeps unfinished', () {
      final plan = planStorageEviction(
        books: [
          book('b1', 't', [
            ch('done', 100, finished: true),
            ch('open', 200, finished: false),
            ch('done-no-file', 0, finished: true), // nothing to drop
          ]),
        ],
        capBytes: 100000,
        autoDeleteFinished: true,
        keepRecentBooks: 1,
      );
      expect(refs(plan.chapterFilesToDrop), ['b1/done']);
      expect(plan.booksToEvict, isEmpty);
    });

    test('evicts the least-recently-played book when over cap', () {
      final plan = planStorageEviction(
        books: [
          book('old', '2026-06-01T00:00:00Z', [ch('a', 600)]),
          book('new', '2026-06-06T00:00:00Z', [ch('b', 600)]),
        ],
        capBytes: 1000, // 1200 total > cap
        autoDeleteFinished: false,
        keepRecentBooks: 1, // protect the most-recent ('new')
      );
      expect(plan.booksToEvict, ['old']);
    });

    test('stops evicting once back under the cap', () {
      final plan = planStorageEviction(
        books: [
          book('oldest', '2026-06-01T00:00:00Z', [ch('a', 400)]),
          book('mid', '2026-06-02T00:00:00Z', [ch('b', 400)]),
          book('new', '2026-06-06T00:00:00Z', [ch('c', 400)]),
        ],
        capBytes: 1000, // 1200 total; dropping 'oldest' (400) -> 800 <= cap
        autoDeleteFinished: false,
        keepRecentBooks: 1,
      );
      expect(plan.booksToEvict, ['oldest']); // not 'mid' too
    });

    test('never evicts a protected (recent) book even if still over cap', () {
      final plan = planStorageEviction(
        books: [
          book('a', '2026-06-05T00:00:00Z', [ch('x', 5000)]),
          book('b', '2026-06-06T00:00:00Z', [ch('y', 5000)]),
        ],
        capBytes: 100, // impossible to satisfy without evicting protected
        autoDeleteFinished: false,
        keepRecentBooks: 2, // both protected
      );
      expect(plan.booksToEvict, isEmpty);
    });

    test('an evicted book is not also listed in chapterFilesToDrop', () {
      final plan = planStorageEviction(
        books: [
          // Even after dropping the finished file, 'old' is still 900 bytes,
          // so the cap forces a whole-book eviction.
          book('old', '2026-06-01T00:00:00Z', [
            ch('done', 100, finished: true),
            ch('open', 900, finished: false),
          ]),
          book('new', '2026-06-06T00:00:00Z', [ch('keep', 50)]),
        ],
        capBytes: 100, // 950 remaining after finished-drop -> must evict 'old'
        autoDeleteFinished: true,
        keepRecentBooks: 1,
      );
      expect(plan.booksToEvict, ['old']);
      // 'old/done' is gone via the whole-book eviction, not double-listed.
      expect(refs(plan.chapterFilesToDrop), isEmpty);
    });

    test('treats a never-played book (null lastPlayedAt) as oldest', () {
      final plan = planStorageEviction(
        books: [
          book('never', null, [ch('a', 600)]),
          book('recent', '2026-06-06T00:00:00Z', [ch('b', 600)]),
        ],
        capBytes: 1000,
        autoDeleteFinished: false,
        keepRecentBooks: 1,
      );
      expect(plan.booksToEvict, ['never']);
    });
  });
}
