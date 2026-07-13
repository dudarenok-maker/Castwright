import 'package:flutter_test/flutter_test.dart';
import 'package:castwright/src/domain/activate_book.dart';

void main() {
  ({List<String> log, Future<void> Function(String, {required String title, String? artPath, String? currentBookId}) run}) harness() {
    final log = <String>[];
    Future<void> run(String bookId, {required String title, String? artPath, String? currentBookId}) {
      return runActivateBook(
        bookId: bookId, title: title, artPath: artPath, currentBookId: currentBookId,
        ensureDetail: (b) async => log.add('ensureDetail:$b'),
        coverThumbPath: (b) async { log.add('coverThumbPath:$b'); return '/art/$b.jpg'; },
        saveNow: () async => log.add('saveNow'),
        syncBook: (b) async => log.add('syncBook:$b'),
        switchBook: (b, t, a) async => log.add('switchBook:$b:$t:$a'),
        openBook: (b, t, a) async => log.add('openBook:$b:$t:$a'),
        markPlayed: (b) async => log.add('markPlayed:$b'),
      );
    }
    return (log: log, run: run);
  }

  test('first activation: ensureDetail → openBook → markPlayed → reconcile', () async {
    final h = harness();
    await h.run('A', title: 'Book A', artPath: '/art/a.jpg', currentBookId: null);
    expect(h.log, ['ensureDetail:A', 'openBook:A:Book A:/art/a.jpg', 'markPlayed:A', 'syncBook:A']);
  });

  test('switch: saveNow → push outgoing → switch (fresh position), then reconcile', () async {
    final h = harness();
    await h.run('B', title: 'Book B', artPath: '/art/b.jpg', currentBookId: 'A');
    expect(h.log, [
      'ensureDetail:B', 'saveNow', 'syncBook:A',
      'switchBook:B:Book B:/art/b.jpg', 'markPlayed:B', 'syncBook:B',
    ]);
  });

  test('resolves cover when artPath omitted', () async {
    final h = harness();
    await h.run('A', title: 'Book A', currentBookId: null);
    expect(h.log, ['ensureDetail:A', 'coverThumbPath:A', 'openBook:A:Book A:/art/A.jpg', 'markPlayed:A', 'syncBook:A']);
  });

  test('re-activating the already-open book is a true no-op', () async {
    final h = harness();
    await h.run('A', title: 'Book A', currentBookId: 'A');
    expect(h.log, isEmpty);
  });
}
