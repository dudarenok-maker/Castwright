import 'package:flutter_test/flutter_test.dart';
import 'package:castwright/src/domain/chapter_scroll.dart';

void main() {
  test('index 0 stays at the top', () {
    expect(
        chapterScrollOffset(index: 0, rowHeight: 72, maxExtent: 5000), 0);
  });

  test('deep index scrolls with one row of context above', () {
    // (10 - 1) * 72 = 648
    expect(
        chapterScrollOffset(index: 10, rowHeight: 72, maxExtent: 5000), 648);
  });

  test('offset is clamped to maxExtent', () {
    expect(
        chapterScrollOffset(index: 100, rowHeight: 72, maxExtent: 1000), 1000);
  });

  test('early index that would be negative clamps to 0', () {
    expect(
        chapterScrollOffset(index: 1, rowHeight: 72, contextRows: 2, maxExtent: 5000),
        0);
  });
}
