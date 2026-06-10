import 'package:flutter/material.dart';
import 'package:flutter_zxing/flutter_zxing.dart';

import '../domain/pairing_qr.dart';

/// Scans the server pairing QR and pops with the parsed [PairingQr]
/// (app-2). Non-matching codes are ignored so the camera keeps scanning.
///
/// Uses `flutter_zxing` (zxing-cpp via FFI) rather than ML Kit: mobile_scanner
/// 7.2.0's ML Kit barcode scanner NPEs inside `process()` on start on Android
/// 16 / API 36 (reproduced on a Pixel 10 Pro emulator + a real device). zxing
/// has no ML Kit / Play Services dependency. `ReaderWidget` is a self-contained
/// camera scanner with a built-in gallery import — so the user can also pick a
/// screenshot of the QR if the live camera is awkward.
class QrScanScreen extends StatefulWidget {
  const QrScanScreen({super.key});

  @override
  State<QrScanScreen> createState() => _QrScanScreenState();
}

class _QrScanScreenState extends State<QrScanScreen> {
  bool _handled = false;

  void _onScan(Code code) {
    if (_handled || !mounted) return;
    final raw = code.text;
    if (raw == null || raw.isEmpty) return;
    try {
      final qr = PairingQr.parse(raw);
      _handled = true;
      Navigator.of(context).pop(qr);
    } on FormatException {
      // A QR, but not a pairing payload — keep scanning.
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Scan pairing code')),
      body: ReaderWidget(
        onScan: _onScan,
        codeFormat: Format.qrCode,
        // Decode robustness for real-world capture (a phone pointed at the QR on
        // a desktop screen). These settings (tryHarder, veryHigh resolution,
        // cropPercent 1.0) were originally required when the pairing QR carried a
        // dense JSON payload ({url, token, caFingerprint}) that the ReaderWidget
        // defaults couldn't decode from a screen. The QR is now compact —
        // CWP1*host:port*code*fpTag — so the aggressive settings are belt-and-
        // suspenders, but they're cheap and protect against marginal capture
        // conditions (glare, small screen, off-axis angle). tryRotate stays on.
        tryHarder: true,
        tryInverted: true,
        resolution: ResolutionPreset.veryHigh,
        cropPercent: 1.0,
        showScannerOverlay: false,
        showToggleCamera: false,
        // Lets the user decode a saved screenshot of the QR as a fallback.
        showGallery: true,
        loading: const DecoratedBox(
          decoration: BoxDecoration(color: Colors.black),
          child: Center(child: CircularProgressIndicator()),
        ),
      ),
    );
  }
}
