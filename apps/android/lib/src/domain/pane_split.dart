import 'dart:ui' show DisplayFeature, DisplayFeatureState, DisplayFeatureType;

import 'package:flutter/widgets.dart' show Size;

/// Left-pane width + the gutter that straddles a foldable hinge (0 when none).
class PaneSplit {
  const PaneSplit(this.leftWidth, this.gutter);
  final double leftWidth;
  final double gutter;
}

/// Compute the two-pane split. With no qualifying hinge, the left pane is
/// [defaultLeftFraction] of the width, clamped to [minLeft]/[maxLeft]. With a
/// vertical hinge/fold present, the split aligns to the hinge's left edge and the
/// gutter spans the hinge so no pane renders under it.
///
/// Pure: [features] is passed in (not read from context) so it unit-tests, and is
/// simply empty on platforms that don't fold (iOS) — identical to the no-hinge path.
PaneSplit paneSplitForHinge(
  Size size,
  List<DisplayFeature> features, {
  double defaultLeftFraction = 0.4,
  double minLeft = 360,
  double maxLeft = 440,
}) {
  for (final f in features) {
    final isHinge =
        f.type == DisplayFeatureType.hinge || f.type == DisplayFeatureType.fold;
    final isActive = f.state == DisplayFeatureState.postureHalfOpened ||
        f.state == DisplayFeatureState.postureFlat;
    final isVertical = f.bounds.width < f.bounds.height; // left/right seam
    if (isHinge && isActive && isVertical) {
      return PaneSplit(f.bounds.left, f.bounds.width);
    }
  }
  final w = (size.width * defaultLeftFraction).clamp(minLeft, maxLeft);
  return PaneSplit(w.toDouble(), 0);
}
