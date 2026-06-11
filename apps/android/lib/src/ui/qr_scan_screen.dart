import 'package:flutter/material.dart';
import 'package:google_mlkit_barcode_scanning/google_mlkit_barcode_scanning.dart';
import 'package:image_picker/image_picker.dart';

import '../domain/pairing_qr.dart';

/// Returns the decoded barcode strings found in the image at [imagePath].
typedef BarcodeDecoder = Future<List<String>> Function(String imagePath);

/// Returns a captured/selected image path, or null if the user cancelled.
typedef PickImage = Future<String?> Function(ImageSource source);

/// Scans the desktop pairing QR from a STILL image (app-2). zxing-cpp could not
/// decode the QR on a real Android 16 device; ML Kit can, and a still image
/// avoids the live-camera ML Kit lifecycle that NPE'd on API 36. Both the image
/// source and the decoder are injected so the screen logic is unit-testable and
/// the decoder is swappable in one place.
class QrScanScreen extends StatefulWidget {
  // ignore: prefer_const_constructors_in_immutables
  QrScanScreen({super.key, BarcodeDecoder? decode, PickImage? pickImage})
      : decode = decode ?? mlkitDecodeQr,
        pickImage = pickImage ?? _defaultPickImage;

  final BarcodeDecoder decode;
  final PickImage pickImage;

  @override
  State<QrScanScreen> createState() => _QrScanScreenState();
}

class _QrScanScreenState extends State<QrScanScreen> {
  bool _busy = false;
  String? _error;

  Future<void> _scanFrom(ImageSource source) async {
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      final path = await widget.pickImage(source);
      if (path == null) {
        if (mounted) setState(() => _busy = false); // cancelled
        return;
      }
      final raws = await widget.decode(path);
      for (final raw in raws) {
        try {
          final qr = PairingQr.parse(raw);
          if (mounted) Navigator.of(context).pop(qr);
          return;
        } on FormatException {
          // a barcode, but not a pairing payload — try the next one
        }
      }
      if (mounted) {
        setState(() {
          _busy = false;
          _error = 'No Castwright pairing code found in that image. '
              'Try again, or enter the code manually.';
        });
      }
    } catch (e) {
      if (mounted) {
        setState(() {
          _busy = false;
          _error = "Couldn't read that image ($e). "
              'Try again, or enter the code manually.';
        });
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Scan pairing code')),
      body: Padding(
        padding: const EdgeInsets.all(24),
        child: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            const Text(
              'Point your phone at the QR on the desktop and take a photo, '
              'or pick a screenshot of it.',
              textAlign: TextAlign.center,
            ),
            const SizedBox(height: 24),
            FilledButton.icon(
              key: const Key('scan-camera'),
              onPressed: _busy ? null : () => _scanFrom(ImageSource.camera),
              icon: const Icon(Icons.photo_camera),
              label: const Text('Take a photo of the QR'),
              style: FilledButton.styleFrom(
                  minimumSize: const Size.fromHeight(48)),
            ),
            const SizedBox(height: 12),
            OutlinedButton.icon(
              key: const Key('scan-gallery'),
              onPressed: _busy ? null : () => _scanFrom(ImageSource.gallery),
              icon: const Icon(Icons.image),
              label: const Text('Choose a screenshot'),
              style: OutlinedButton.styleFrom(
                  minimumSize: const Size.fromHeight(48)),
            ),
            const SizedBox(height: 16),
            if (_busy) const Center(child: CircularProgressIndicator()),
            if (_error != null)
              Padding(
                padding: const EdgeInsets.only(top: 8),
                child: Text(
                  _error!,
                  key: const Key('scan-error'),
                  textAlign: TextAlign.center,
                  style: TextStyle(color: Theme.of(context).colorScheme.error),
                ),
              ),
          ],
        ),
      ),
    );
  }
}

/// Default decoder: Google ML Kit, QR format only, on a still image file.
Future<List<String>> mlkitDecodeQr(String imagePath) async {
  final scanner = BarcodeScanner(formats: [BarcodeFormat.qrCode]);
  try {
    final barcodes =
        await scanner.processImage(InputImage.fromFilePath(imagePath));
    return [for (final b in barcodes) b.rawValue]
        .whereType<String>()
        .toList();
  } finally {
    await scanner.close();
  }
}

Future<String?> _defaultPickImage(ImageSource source) async {
  final x = await ImagePicker().pickImage(source: source);
  return x?.path;
}
