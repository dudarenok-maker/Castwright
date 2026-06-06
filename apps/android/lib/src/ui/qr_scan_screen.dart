import 'package:flutter/material.dart';
import 'package:mobile_scanner/mobile_scanner.dart';

import '../domain/paired_server.dart';

/// Scans the server pairing QR and pops with the parsed [PairedServer]
/// (app-2). Non-matching codes are ignored so the camera keeps scanning.
class QrScanScreen extends StatefulWidget {
  const QrScanScreen({super.key});

  @override
  State<QrScanScreen> createState() => _QrScanScreenState();
}

class _QrScanScreenState extends State<QrScanScreen> {
  bool _handled = false;

  void _onDetect(BarcodeCapture capture) {
    if (_handled || capture.barcodes.isEmpty) return;
    final raw = capture.barcodes.first.rawValue;
    if (raw == null || raw.isEmpty) return;
    try {
      final server = PairedServer.fromQrPayload(raw);
      _handled = true;
      Navigator.of(context).pop(server);
    } on FormatException {
      // Not a pairing QR — keep scanning.
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Scan pairing code')),
      body: MobileScanner(onDetect: _onDetect),
    );
  }
}
