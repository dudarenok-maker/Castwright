import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:audiobook_companion/src/data/cert_pinning.dart';
import 'package:audiobook_companion/src/data/pairing_service.dart';
import 'package:audiobook_companion/src/data/pairing_store.dart';
import 'package:audiobook_companion/src/domain/paired_server.dart';
import 'package:audiobook_companion/src/ui/pairing_screen.dart';

class FakeStore implements PairingStore {
  PairedServer? saved;
  String? savedCaPem;
  @override
  Future<PairedServer?> load() async => saved;
  @override
  Future<void> save(PairedServer server) async => saved = server;
  @override
  Future<void> clear() async => saved = null;
  @override
  Future<void> saveCaPem(String pem) async => savedCaPem = pem;
  @override
  Future<String?> loadCaPem() async => savedCaPem;
}

String pemOf(List<int> der) =>
    '-----BEGIN CERTIFICATE-----\n${base64.encode(der)}\n-----END CERTIFICATE-----\n';

void main() {
  final pem = pemOf(List<int>.generate(40, (i) => i));
  final goodFp = caFingerprintFromPem(pem);

  // Pump a host route and open PairingScreen on top, so its success-path pop()
  // returns to a real previous route.
  Future<void> open(WidgetTester tester, PairingService service, PairingStore store) async {
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: Builder(
            builder: (ctx) => ElevatedButton(
              onPressed: () => Navigator.of(ctx).push(
                MaterialPageRoute(builder: (_) => PairingScreen(service: service, store: store)),
              ),
              child: const Text('open'),
            ),
          ),
        ),
      ),
    );
    await tester.tap(find.text('open'));
    await tester.pumpAndSettle();
  }

  Future<void> fill(WidgetTester tester, String fingerprint) async {
    await tester.enterText(find.byKey(const Key('field-url')), 'https://10.0.0.5:8443');
    await tester.enterText(find.byKey(const Key('field-token')), 'tok');
    await tester.enterText(find.byKey(const Key('field-fingerprint')), fingerprint);
    await tester.tap(find.widgetWithText(FilledButton, 'Pair'));
    await tester.pumpAndSettle();
  }

  testWidgets('shows the mismatch error and does not save on a wrong fingerprint', (tester) async {
    final store = FakeStore();
    final service = PairingService(fetchCa: (_) async => pem, probe: (_, _) async => 200);
    await open(tester, service, store);
    await fill(tester, 'AB:CD:EF'); // wrong fingerprint

    expect(find.byKey(const Key('pair-error')), findsOneWidget);
    expect(store.saved, isNull);
  });

  testWidgets('saves the connection on a matching fingerprint + ok probe', (tester) async {
    final store = FakeStore();
    final service = PairingService(fetchCa: (_) async => pem, probe: (_, _) async => 200);
    await open(tester, service, store);
    await fill(tester, goodFp); // correct

    expect(store.saved, isNotNull);
    expect(store.saved!.url, 'https://10.0.0.5:8443');
  });
}
