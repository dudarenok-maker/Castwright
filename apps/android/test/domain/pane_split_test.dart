import 'dart:ui';
import 'package:flutter_test/flutter_test.dart';
import 'package:castwright/src/domain/pane_split.dart';

DisplayFeature _vHinge(Rect bounds) => DisplayFeature(
      bounds: bounds,
      type: DisplayFeatureType.hinge,
      state: DisplayFeatureState.postureHalfOpened,
    );

void main() {
  test('no features → default fraction, clamped, no gutter', () {
    final s = paneSplitForHinge(const Size(1000, 700), const []);
    expect(s.gutter, 0);
    expect(s.leftWidth, 400); // 1000 * 0.4
  });

  test('clamps to min/max', () {
    expect(paneSplitForHinge(const Size(700, 700), const []).leftWidth, 360); // 280→min
    expect(paneSplitForHinge(const Size(2000, 900), const []).leftWidth, 440); // 800→max
  });

  test('vertical hinge → split at hinge left edge, gutter = hinge width', () {
    // hinge occupies x∈[498,502], full height → vertical seam
    final s = paneSplitForHinge(
        const Size(1000, 700), [_vHinge(const Rect.fromLTWH(498, 0, 4, 700))]);
    expect(s.leftWidth, 498);
    expect(s.gutter, 4);
  });

  test('horizontal hinge is ignored (falls through to default)', () {
    final h = DisplayFeature(
      bounds: const Rect.fromLTWH(0, 348, 1000, 4), // wide+short = horizontal
      type: DisplayFeatureType.fold,
      state: DisplayFeatureState.postureFlat,
    );
    final s = paneSplitForHinge(const Size(1000, 700), [h]);
    expect(s.gutter, 0);
    expect(s.leftWidth, 400);
  });
}
