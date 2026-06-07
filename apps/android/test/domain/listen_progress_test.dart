import 'package:flutter_test/flutter_test.dart';
import 'package:audiobook_companion/src/domain/listen_progress.dart';

void main() {
  group('listenedFraction', () {
    test('sums prior chapter durations + current position over the total', () {
      final f = listenedFraction(
        durations: [60, 120, 60],
        resumeIndex: 1,
        resumePositionSec: 30,
      );
      expect(f, closeTo((60 + 30) / 240, 1e-9));
    });

    test('is 0 when total duration is unknown (all null)', () {
      expect(
        listenedFraction(durations: [null, null], resumeIndex: 1, resumePositionSec: 5),
        0,
      );
    });

    test('clamps to 1 and tolerates null chapter durations', () {
      final f = listenedFraction(
        durations: [60, null, 60],
        resumeIndex: 3,
        resumePositionSec: 999,
      );
      expect(f, 1.0);
    });
  });

  group('formatDuration', () {
    test('formats seconds as H:MM:SS / M:SS', () {
      expect(formatDuration(0), '0:00');
      expect(formatDuration(65), '1:05');
      expect(formatDuration(3725), '1:02:05');
      expect(formatDuration(null), '');
    });
  });
}
