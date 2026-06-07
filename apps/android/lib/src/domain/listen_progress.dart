/// Pure helpers for showing how far through a book the listener is, and for
/// formatting durations. No IO — fed by the manifest chapter durations + the
/// stored resume point.
library;

/// Fraction (0..1) of a book listened: the durations of all chapters before
/// the resume point, plus the current position, over the book total. Returns 0
/// when the total is unknown (no durations). Null chapter durations count as 0.
double listenedFraction({
  required List<double?> durations,
  required int resumeIndex,
  required double resumePositionSec,
}) {
  final total = durations.fold<double>(0, (s, d) => s + (d ?? 0));
  if (total <= 0) return 0;
  var listened = resumePositionSec;
  for (var i = 0; i < resumeIndex && i < durations.length; i++) {
    listened += durations[i] ?? 0;
  }
  final f = listened / total;
  return f < 0 ? 0 : (f > 1 ? 1 : f);
}

/// `H:MM:SS` when there are hours, else `M:SS`; null → empty string.
String formatDuration(double? seconds) {
  if (seconds == null) return '';
  final total = seconds.round();
  final h = total ~/ 3600;
  final m = (total % 3600) ~/ 60;
  final s = total % 60;
  final ss = s.toString().padLeft(2, '0');
  if (h > 0) return '$h:${m.toString().padLeft(2, '0')}:$ss';
  return '$m:$ss';
}
