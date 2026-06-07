import 'package:flutter_test/flutter_test.dart';
import 'package:castwright/src/domain/waveform.dart';

void main() {
  group('resamplePeaks', () {
    test('downsamples by windowed max and normalizes to [0,1]', () {
      // 4 peaks → 2 bars: bar0=max(0,1)=1, bar1=max(0,0.5)=0.5, peak=1.
      expect(resamplePeaks([0, 1, 0, 0.5], 2), [1.0, 0.5]);
    });

    test('normalizes a quiet chapter so the loudest bar fills', () {
      // all small, max 0.2 → normalized so the peak becomes 1.
      final r = resamplePeaks([0.1, 0.2, 0.05], 3);
      expect(r.reduce((a, b) => a > b ? a : b), 1.0);
    });

    test('empty peaks → all-zero bars', () {
      expect(resamplePeaks([], 4), [0.0, 0.0, 0.0, 0.0]);
    });

    test('more bars than samples does not crash and covers every bar', () {
      final r = resamplePeaks([1, 0], 5);
      expect(r.length, 5);
      expect(r.every((v) => v >= 0 && v <= 1), isTrue);
    });

    test('non-positive bar count → empty', () {
      expect(resamplePeaks([1, 2, 3], 0), isEmpty);
    });
  });
}
