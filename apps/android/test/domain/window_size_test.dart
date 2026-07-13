import 'package:flutter_test/flutter_test.dart';
import 'package:castwright/src/domain/window_size.dart';

void main() {
  group('windowSizeClassFor', () {
    test('boundaries', () {
      expect(windowSizeClassFor(0), WindowSizeClass.compact);
      expect(windowSizeClassFor(599), WindowSizeClass.compact);
      expect(windowSizeClassFor(600), WindowSizeClass.medium);
      expect(windowSizeClassFor(839), WindowSizeClass.medium);
      expect(windowSizeClassFor(840), WindowSizeClass.expanded);
      expect(windowSizeClassFor(1280), WindowSizeClass.expanded);
    });
  });

  group('libraryLayoutFor', () {
    test('twoPane only when expanded', () {
      expect(libraryLayoutFor(WindowSizeClass.compact), LibraryLayout.singlePane);
      expect(libraryLayoutFor(WindowSizeClass.medium), LibraryLayout.singlePane);
      expect(libraryLayoutFor(WindowSizeClass.expanded), LibraryLayout.twoPane);
    });
  });
}
