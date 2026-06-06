import 'package:flutter_test/flutter_test.dart';
import 'package:audiobook_companion/src/domain/skip_behavior.dart';

void main() {
  group('resolveSkipAction', () {
    test('seek mode maps forward/back to +30s / -15s by default', () {
      final fwd = resolveSkipAction(SkipButtonBehavior.seek, forward: true);
      final back = resolveSkipAction(SkipButtonBehavior.seek, forward: false);
      expect(fwd, isA<SeekBy>());
      expect((fwd as SeekBy).delta, const Duration(seconds: 30));
      expect((back as SeekBy).delta, const Duration(seconds: -15));
    });

    test('seek amounts are configurable', () {
      final fwd = resolveSkipAction(
        SkipButtonBehavior.seek,
        forward: true,
        forwardSeconds: 45,
        backwardSeconds: 20,
      );
      expect((fwd as SeekBy).delta, const Duration(seconds: 45));
    });

    test('chapter mode maps to +1 / -1 chapter steps', () {
      final fwd = resolveSkipAction(SkipButtonBehavior.chapter, forward: true);
      final back = resolveSkipAction(SkipButtonBehavior.chapter, forward: false);
      expect((fwd as ChapterStep).direction, 1);
      expect((back as ChapterStep).direction, -1);
    });
  });
}
