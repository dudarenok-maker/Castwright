import 'package:flutter_test/flutter_test.dart';
import 'package:castwright/src/domain/library_load.dart';
import 'package:castwright/src/domain/library_tree.dart';

LibraryBook bk(String id) => LibraryBook(
      bookId: id,
      title: id,
      author: 'a',
      series: '',
      seriesPosition: null,
      downloadState: BookDownloadState.downloaded,
    );

Future<List<LibraryBook>> Function() ok(List<LibraryBook> v) => () async => v;
Future<List<LibraryBook>> Function() fails() =>
    () async => throw Exception('unreachable');

void main() {
  group('loadLibraryLocalFirst', () {
    test('local content paints first, then the server upgrades it', () async {
      final local = [bk('downloaded')];
      final server = [bk('downloaded'), bk('streamable')];
      final states = await loadLibraryLocalFirst(
        loadLocal: ok(local),
        loadServer: ok(server),
      ).toList();

      expect(states, hasLength(2));
      // 1st paint: the local library, no spinner, server probe in flight.
      expect(states[0].books, local);
      expect(states[0].loading, isFalse);
      expect(states[0].connecting, isTrue);
      expect(states[0].offline, isFalse);
      // 2nd paint: the full server catalogue, done probing.
      expect(states[1].books, server);
      expect(states[1].connecting, isFalse);
      expect(states[1].offline, isFalse);
      expect(states[1].error, isNull);
    });

    test('a failed connection does NOT block or error when local exists',
        () async {
      final local = [bk('downloaded')];
      final states = await loadLibraryLocalFirst(
        loadLocal: ok(local),
        loadServer: fails(),
      ).toList();

      expect(states, hasLength(2));
      expect(states[0].books, local); // shown immediately
      expect(states[0].loading, isFalse);
      // Stays on the local library, marked offline, no error screen.
      expect(states.last.books, local);
      expect(states.last.offline, isTrue);
      expect(states.last.connecting, isFalse);
      expect(states.last.error, isNull);
    });

    test('empty local + reachable server: spinner first, then the catalogue',
        () async {
      final server = [bk('streamable')];
      final states = await loadLibraryLocalFirst(
        loadLocal: ok(const []),
        loadServer: ok(server),
      ).toList();

      expect(states.first.loading, isTrue); // nothing to show yet
      expect(states.first.books, isEmpty);
      expect(states.last.books, server);
      expect(states.last.loading, isFalse);
      expect(states.last.offline, isFalse);
    });

    test('empty local + unreachable server surfaces the error', () async {
      final states = await loadLibraryLocalFirst(
        loadLocal: ok(const []),
        loadServer: fails(),
      ).toList();

      expect(states.last.books, isEmpty);
      expect(states.last.error, isNotNull);
      expect(states.last.loading, isFalse);
      expect(states.last.connecting, isFalse);
    });

    test('a throwing local load is treated as empty, not fatal', () async {
      final server = [bk('streamable')];
      final states = await loadLibraryLocalFirst(
        loadLocal: () async => throw Exception('disk error'),
        loadServer: ok(server),
      ).toList();

      expect(states.first.books, isEmpty);
      expect(states.first.loading, isTrue);
      expect(states.last.books, server);
      expect(states.last.error, isNull);
    });
  });
}
