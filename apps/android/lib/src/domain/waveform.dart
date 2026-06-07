/// Pure waveform reduction for the player's chapter waveform. The server
/// serves 240 normalized RMS bins per chapter (`GET …/chapters/:id/audio`
/// `peaks`); the UI resamples them to however many bars fit the width.
library;

/// Downsample [peaks] to [bars] bars by windowed max, then normalize so the
/// loudest bar is 1.0 (a quiet chapter still shows a readable shape). Returns
/// all-zero bars for empty input, and an empty list for a non-positive count.
List<double> resamplePeaks(List<double> peaks, int bars) {
  if (bars <= 0) return const [];
  final out = List<double>.filled(bars, 0.0);
  if (peaks.isEmpty) return out;
  for (var i = 0; i < bars; i++) {
    final start = (i * peaks.length / bars).floor();
    var end = ((i + 1) * peaks.length / bars).floor();
    if (end <= start) end = start + 1;
    if (end > peaks.length) end = peaks.length;
    var maxV = 0.0;
    for (var j = start; j < end; j++) {
      final v = peaks[j].abs();
      if (v > maxV) maxV = v;
    }
    out[i] = maxV;
  }
  final peak = out.fold<double>(0, (m, v) => v > m ? v : m);
  if (peak > 0) {
    for (var i = 0; i < bars; i++) {
      out[i] = out[i] / peak;
    }
  }
  return out;
}
