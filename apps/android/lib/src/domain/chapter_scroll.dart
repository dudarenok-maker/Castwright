/// Pixel offset to scroll a fixed-row chapter list so [index] sits near the top
/// with [contextRows] rows still visible above it, clamped to `[0, maxExtent]`.
/// Pure so the player screen's auto-scroll math is testable without a widget
/// tree; the row height is an estimate (rows are near-uniform), so this brings
/// the current chapter into view rather than pixel-aligning it.
double chapterScrollOffset({
  required int index,
  required double rowHeight,
  double contextRows = 1,
  required double maxExtent,
}) {
  final raw = (index - contextRows) * rowHeight;
  if (raw <= 0) return 0;
  return raw > maxExtent ? maxExtent : raw;
}
