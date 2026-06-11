import 'package:castwright/src/domain/pairing_qr.dart';
import 'package:castwright/src/ui/qr_scan_screen.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:image_picker/image_picker.dart';

/// Pumps QrScanScreen (live camera OFF — the mobile_scanner platform view can't
/// run under flutter test) behind a launcher button and captures the popped
/// result. Exercises the gallery still-image path through the injected seams.
Future<void> _pumpScanner(
  WidgetTester tester, {
  required PickImage pickImage,
  required BarcodeDecoder decode,
  required void Function(PairingQr?) onResult,
}) async {
  await tester.pumpWidget(MaterialApp(
    home: Builder(
      builder: (context) => Scaffold(
        body: Center(
          child: ElevatedButton(
            child: const Text('open'),
            onPressed: () async {
              final qr = await Navigator.of(context).push<PairingQr>(
                MaterialPageRoute(
                  builder: (_) => QrScanScreen(
                      pickImage: pickImage, decode: decode, liveCamera: false),
                ),
              );
              onResult(qr);
            },
          ),
        ),
      ),
    ),
  ));
  await tester.tap(find.text('open'));
  await tester.pumpAndSettle();
}

void main() {
  testWidgets('a valid QR from the gallery pops a PairingQr', (tester) async {
    PairingQr? result;
    var resolved = false;
    await _pumpScanner(
      tester,
      pickImage: (_) async => '/fake/qr.png',
      decode: (_) async =>
          ['CWP1*192.168.1.5:8443*K7QF3M2P*J4XQ2A7BWZ9K3M5R'],
      onResult: (qr) {
        result = qr;
        resolved = true;
      },
    );
    await tester.tap(find.byKey(const Key('scan-gallery')));
    await tester.pumpAndSettle();
    expect(resolved, isTrue);
    expect(result?.code, 'K7QF3M2P');
  });

  testWidgets('a non-pairing barcode shows an error and stays open',
      (tester) async {
    await _pumpScanner(
      tester,
      pickImage: (_) async => '/fake/qr.png',
      decode: (_) async => ['https://example.com/not-a-pair'],
      onResult: (_) {},
    );
    await tester.tap(find.byKey(const Key('scan-gallery')));
    await tester.pumpAndSettle();
    expect(find.byKey(const Key('scan-error')), findsOneWidget);
    expect(find.byKey(const Key('scan-gallery')), findsOneWidget); // still open
  });

  testWidgets('no barcode in the image shows an error', (tester) async {
    await _pumpScanner(
      tester,
      pickImage: (_) async => '/fake/qr.png',
      decode: (_) async => <String>[],
      onResult: (_) {},
    );
    await tester.tap(find.byKey(const Key('scan-gallery')));
    await tester.pumpAndSettle();
    expect(find.byKey(const Key('scan-error')), findsOneWidget);
  });

  testWidgets('cancelling the picker is a no-op (no error)', (tester) async {
    await _pumpScanner(
      tester,
      pickImage: (_) async => null,
      decode: (_) async => <String>[],
      onResult: (_) {},
    );
    await tester.tap(find.byKey(const Key('scan-gallery')));
    await tester.pumpAndSettle();
    expect(find.byKey(const Key('scan-error')), findsNothing);
  });
}
