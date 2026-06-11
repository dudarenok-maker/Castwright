import 'package:castwright/src/domain/pairing_qr.dart';
import 'package:castwright/src/data/pairing_service.dart';
import 'package:castwright/src/data/pairing_store.dart';
import 'package:castwright/src/domain/paired_server.dart';
import 'package:castwright/src/ui/pairing_screen.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

class _NoopStore implements PairingStore {
  @override
  Future<void> clear() async {}
  @override
  Future<PairedServer?> load() async => null;
  @override
  Future<String?> loadCaPem() async => null;
  @override
  Future<void> save(PairedServer server) async {}
  @override
  Future<void> saveCaPem(String caPem) async {}
}

void main() {
  testWidgets('initialQr pre-fills the host/code/fingerprint fields',
      (tester) async {
    await tester.pumpWidget(MaterialApp(
      home: PairingScreen(
        service: PairingService(),
        store: _NoopStore(),
        initialQr: const PairingQr(
            hostPort: '192.168.1.5:8443',
            code: 'K7QF3M2P',
            fpTag: 'J4XQ2A7BWZ9K3M5R'),
      ),
    ));
    expect(find.text('192.168.1.5:8443'), findsOneWidget);
    expect(find.text('K7QF3M2P'), findsOneWidget);
    expect(find.text('J4XQ2A7BWZ9K3M5R'), findsOneWidget);
  });
}
