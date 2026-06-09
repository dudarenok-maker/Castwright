import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:flutter_zxing/flutter_zxing.dart';

import 'package:castwright/src/ui/qr_scan_screen.dart';

/// Regression guard for the pairing-QR scanner decode config.
///
/// The scanner shipped with flutter_zxing's `ReaderWidget` defaults (tryHarder
/// OFF, centre-50% crop, 720p), which left the dense pairing QR unreadable on a
/// real phone even though the native camera app decoded the same code off the
/// same screen. These assertions pin the robustness knobs so a refactor can't
/// silently fall back to the weak defaults.
void main() {
  testWidgets('configures ReaderWidget for robust real-world QR decode', (tester) async {
    // ReaderWidget's camera init runs through platform channels that no-op in a
    // widget test; it swallows the failure and stays in the tree, so a single
    // pump is enough to read its configuration without settling camera futures.
    await tester.pumpWidget(const MaterialApp(home: QrScanScreen()));
    await tester.pump();

    final reader = tester.widget<ReaderWidget>(find.byType(ReaderWidget));

    expect(reader.codeFormat, Format.qrCode);
    expect(reader.tryHarder, isTrue,
        reason: 'tryHarder is the single biggest decode lever for camera capture');
    expect(reader.cropPercent, 1.0,
        reason: 'decode the whole frame, not a centre crop, so the QR resolves anywhere in view');
    expect(reader.resolution, ResolutionPreset.veryHigh,
        reason: 'the dense pairing QR needs more than 720p to resolve its modules');
    expect(reader.tryInverted, isTrue);
  });
}
