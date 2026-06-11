import 'package:flutter/material.dart';
import 'package:image_picker/image_picker.dart';
import 'package:mobile_scanner/mobile_scanner.dart';

import '../domain/pairing_qr.dart';

/// Returns the decoded barcode strings found in the image at [imagePath].
typedef BarcodeDecoder = Future<List<String>> Function(String imagePath);

/// Returns a captured/selected image path, or null if the user cancelled.
typedef PickImage = Future<String?> Function(ImageSource source);

/// Scans the desktop pairing QR (app-2). A LIVE mobile_scanner (ML Kit) camera
/// preview decodes continuous frames — far more forgiving than a single still
/// when capturing a QR off a screen — with a "Choose a screenshot" gallery
/// fallback that decodes a picked image via `MobileScannerController.analyzeImage`.
///
/// History: flutter_zxing couldn't decode the QR on a real Android 16 device, and
/// ML Kit had NPE'd — but that NPE was R8 minification stripping ML Kit's
/// reflection targets (release build); with minify disabled it runs. The live
/// camera's `errorBuilder` degrades gracefully to the gallery path if the camera
/// can't start, so the screen never hard-crashes.
class QrScanScreen extends StatefulWidget {
  const QrScanScreen(
      {super.key, this.decode, this.pickImage, this.liveCamera = true});

  /// Decoder for a still image (gallery path). Null → mobile_scanner analyzeImage.
  final BarcodeDecoder? decode;

  /// Image source for the gallery path. Null → image_picker.
  final PickImage? pickImage;

  /// Whether to show the live camera preview. False in widget tests (the
  /// mobile_scanner platform view can't run under `flutter test`).
  final bool liveCamera;

  @override
  State<QrScanScreen> createState() => _QrScanScreenState();
}

class _QrScanScreenState extends State<QrScanScreen> {
  bool _handled = false;
  bool _busy = false;
  String? _error;

  late final BarcodeDecoder _decode = widget.decode ?? _analyzeImage;
  late final PickImage _pickImage = widget.pickImage ?? _defaultPickImage;

  /// Live-camera frames: pop on the first valid pairing payload.
  void _onDetect(BarcodeCapture capture) {
    for (final barcode in capture.barcodes) {
      final raw = barcode.rawValue;
      if (raw != null && _tryPair(raw)) return;
    }
  }

  /// Parse [raw]; on a valid pairing payload pop the screen with it. Returns
  /// true once handled so repeated frames/barcodes don't double-pop.
  bool _tryPair(String raw) {
    if (_handled || !mounted) return _handled;
    try {
      final qr = PairingQr.parse(raw);
      _handled = true;
      Navigator.of(context).pop(qr);
      return true;
    } on FormatException {
      return false; // a barcode, but not a pairing payload
    }
  }

  Future<void> _scanFromGallery() async {
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      final path = await _pickImage(ImageSource.gallery);
      if (path == null) {
        if (mounted) setState(() => _busy = false); // cancelled
        return;
      }
      final raws = await _decode(path);
      for (final raw in raws) {
        if (_tryPair(raw)) return;
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
      body: Column(
        children: [
          Expanded(
            child: widget.liveCamera
                ? MobileScanner(
                    onDetect: _onDetect,
                    errorBuilder: (context, error) => const _CameraUnavailable(),
                  )
                : const _CameraUnavailable(),
          ),
          Padding(
            padding: const EdgeInsets.all(16),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                const Text(
                  'Point the camera at the QR on the desktop. '
                  "If that's awkward, pick a screenshot of it instead.",
                  textAlign: TextAlign.center,
                ),
                const SizedBox(height: 12),
                OutlinedButton.icon(
                  key: const Key('scan-gallery'),
                  onPressed: _busy ? null : _scanFromGallery,
                  icon: const Icon(Icons.image),
                  label: const Text('Choose a screenshot'),
                  style: OutlinedButton.styleFrom(
                      minimumSize: const Size.fromHeight(48)),
                ),
                if (_busy)
                  const Padding(
                    padding: EdgeInsets.only(top: 12),
                    child: CircularProgressIndicator(),
                  ),
                if (_error != null)
                  Padding(
                    padding: const EdgeInsets.only(top: 8),
                    child: Text(
                      _error!,
                      key: const Key('scan-error'),
                      textAlign: TextAlign.center,
                      style:
                          TextStyle(color: Theme.of(context).colorScheme.error),
                    ),
                  ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

/// Shown when the live camera can't start (or is disabled in tests) — the
/// gallery fallback below still works.
class _CameraUnavailable extends StatelessWidget {
  const _CameraUnavailable();

  @override
  Widget build(BuildContext context) {
    return ColoredBox(
      color: Theme.of(context).colorScheme.surfaceContainerHighest,
      child: const Center(
        child: Padding(
          padding: EdgeInsets.all(24),
          child: Text(
            'Camera preview unavailable — use "Choose a screenshot" below, '
            'or enter the code manually.',
            textAlign: TextAlign.center,
          ),
        ),
      ),
    );
  }
}

/// Default still-image decoder: mobile_scanner's ML Kit on a one-shot controller.
Future<List<String>> _analyzeImage(String imagePath) async {
  final controller = MobileScannerController();
  try {
    final capture = await controller.analyzeImage(imagePath);
    return capture?.barcodes
            .map((b) => b.rawValue)
            .whereType<String>()
            .toList() ??
        const <String>[];
  } finally {
    await controller.dispose();
  }
}

Future<String?> _defaultPickImage(ImageSource source) async {
  final x = await ImagePicker().pickImage(source: source);
  return x?.path;
}
