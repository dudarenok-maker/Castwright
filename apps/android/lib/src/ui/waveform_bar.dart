import 'package:flutter/material.dart';

import '../domain/waveform.dart';

/// A chapter waveform: resamples the server's RMS peaks to fit the width,
/// tints the played portion, and seeks on tap/drag. Falls back to nothing
/// when there are no peaks (caller decides what to show instead).
class WaveformBar extends StatelessWidget {
  const WaveformBar({
    super.key,
    required this.peaks,
    required this.progress,
    this.onSeek,
    this.height = 48,
  });

  final List<double> peaks;
  final double progress; // 0..1
  final ValueChanged<double>? onSeek; // fraction 0..1
  final double height;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return LayoutBuilder(
      builder: (context, constraints) {
        final width = constraints.maxWidth;
        final bars = (width / 3).floor().clamp(1, 512);
        final resampled = resamplePeaks(peaks, bars);
        void seek(double dx) =>
            onSeek?.call((dx / width).clamp(0.0, 1.0));
        return GestureDetector(
          behavior: HitTestBehavior.opaque,
          onTapDown: (d) => seek(d.localPosition.dx),
          onHorizontalDragUpdate: (d) => seek(d.localPosition.dx),
          child: CustomPaint(
            size: Size(width, height),
            painter: _WaveformPainter(
              bars: resampled,
              progress: progress.clamp(0.0, 1.0),
              played: scheme.primary,
              unplayed: scheme.outlineVariant,
            ),
          ),
        );
      },
    );
  }
}

class _WaveformPainter extends CustomPainter {
  _WaveformPainter({
    required this.bars,
    required this.progress,
    required this.played,
    required this.unplayed,
  });

  final List<double> bars;
  final double progress;
  final Color played;
  final Color unplayed;

  @override
  void paint(Canvas canvas, Size size) {
    if (bars.isEmpty) return;
    final slot = size.width / bars.length;
    final barW = (slot * 0.66).clamp(1.0, 4.0);
    final mid = size.height / 2;
    final playedPaint = Paint()..color = played..strokeCap = StrokeCap.round;
    final unplayedPaint = Paint()..color = unplayed..strokeCap = StrokeCap.round;
    final progressX = progress * size.width;
    for (var i = 0; i < bars.length; i++) {
      final x = i * slot + slot / 2;
      final h = (bars[i] * (size.height - 2)).clamp(2.0, size.height);
      final paint = (x <= progressX ? playedPaint : unplayedPaint)
        ..strokeWidth = barW;
      canvas.drawLine(Offset(x, mid - h / 2), Offset(x, mid + h / 2), paint);
    }
  }

  @override
  bool shouldRepaint(_WaveformPainter old) =>
      old.progress != progress ||
      old.bars.length != bars.length ||
      old.played != played;
}
