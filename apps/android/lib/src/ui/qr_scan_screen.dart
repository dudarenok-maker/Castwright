import 'package:flutter/material.dart';
import 'package:mobile_scanner/mobile_scanner.dart';

import '../domain/paired_server.dart';

/// Scans the server pairing QR and pops with the parsed [PairedServer]
/// (app-2). Non-matching codes are ignored so the camera keeps scanning.
///
/// We drive an explicit [MobileScannerController] (rather than letting the
/// widget create an implicit one) so we can (a) restrict ML Kit to QR codes —
/// smaller init surface — and (b) own its lifecycle for disposal. The custom
/// [MobileScanner.errorBuilder] replaces the plugin's raw default ("An
/// unexpected error occurred." + a native exception string) with a friendly
/// message that points the user back to manual entry — so a camera / ML Kit
/// failure never strands them on a black screen with an obfuscated stack trace.
class QrScanScreen extends StatefulWidget {
  const QrScanScreen({super.key});

  @override
  State<QrScanScreen> createState() => _QrScanScreenState();
}

class _QrScanScreenState extends State<QrScanScreen> {
  final MobileScannerController _controller = MobileScannerController(
    formats: const [BarcodeFormat.qrCode],
  );
  bool _handled = false;

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

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
      body: MobileScanner(
        controller: _controller,
        onDetect: _onDetect,
        errorBuilder: (context, error) => _ScannerError(error: error),
      ),
    );
  }
}

/// Friendly replacement for mobile_scanner's default error widget. Tells the
/// user the camera couldn't start and to use manual entry instead, with a
/// button that returns to the pairing form.
class _ScannerError extends StatelessWidget {
  const _ScannerError({required this.error});

  final MobileScannerException error;

  @override
  Widget build(BuildContext context) {
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(24),
        child: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            const Icon(Icons.no_photography_outlined, size: 48),
            const SizedBox(height: 16),
            const Text(
              "Couldn't start the camera",
              textAlign: TextAlign.center,
              style: TextStyle(fontSize: 18, fontWeight: FontWeight.bold),
            ),
            const SizedBox(height: 8),
            const Text(
              'Go back and enter the server URL, access token and CA '
              'fingerprint from the desktop pairing screen manually.',
              textAlign: TextAlign.center,
            ),
            const SizedBox(height: 20),
            FilledButton(
              key: const Key('scan-error-back'),
              onPressed: () => Navigator.of(context).maybePop(),
              child: const Text('Enter details manually'),
            ),
          ],
        ),
      ),
    );
  }
}
