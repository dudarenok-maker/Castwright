import 'package:flutter/material.dart';
import 'package:flutter_zxing/flutter_zxing.dart';

import '../domain/paired_server.dart';

/// Scans the server pairing QR and pops with the parsed [PairedServer]
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
      final server = PairedServer.fromQrPayload(raw);
      _handled = true;
      Navigator.of(context).pop(server);
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
        tryInverted: true,
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
