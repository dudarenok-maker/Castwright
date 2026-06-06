import 'package:flutter_test/flutter_test.dart';
import 'package:audiobook_companion/src/data/file_store.dart';

void main() {
  group('InMemoryFileStore', () {
    test('size is -1 for an absent path and the byte length otherwise', () async {
      final fs = InMemoryFileStore();
      expect(await fs.size('/a'), -1);
      await fs.writeBytes('/a', [1, 2, 3]);
      expect(await fs.size('/a'), 3);
      expect(await fs.exists('/a'), isTrue);
    });

    test('append accumulates and read returns the full bytes', () async {
      final fs = InMemoryFileStore();
      await fs.append('/a', [1, 2]);
      await fs.append('/a', [3]);
      expect(await fs.read('/a'), [1, 2, 3]);
      expect(await fs.size('/a'), 3);
    });

    test('read returns null for an absent path', () async {
      final fs = InMemoryFileStore();
      expect(await fs.read('/missing'), isNull);
    });

    test('rename moves bytes and clears the source', () async {
      final fs = InMemoryFileStore();
      await fs.writeBytes('/a.tmp', [9, 9]);
      await fs.rename('/a.tmp', '/a');
      expect(await fs.exists('/a.tmp'), isFalse);
      expect(await fs.read('/a'), [9, 9]);
    });

    test('delete is a no-op for an absent path', () async {
      final fs = InMemoryFileStore();
      await fs.delete('/nope'); // must not throw
      await fs.writeBytes('/a', [1]);
      await fs.delete('/a');
      expect(await fs.exists('/a'), isFalse);
    });

    test('deleteDir removes every path under the prefix', () async {
      final fs = InMemoryFileStore();
      await fs.writeBytes('/books/b1/c1.mp3', [1]);
      await fs.writeBytes('/books/b1/c2.mp3', [2]);
      await fs.writeBytes('/books/b2/c1.mp3', [3]);
      await fs.deleteDir('/books/b1');
      expect(await fs.exists('/books/b1/c1.mp3'), isFalse);
      expect(await fs.exists('/books/b1/c2.mp3'), isFalse);
      expect(await fs.exists('/books/b2/c1.mp3'), isTrue);
    });
  });
}
