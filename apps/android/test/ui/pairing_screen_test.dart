import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:castwright/src/data/pairing_service.dart';
import 'package:castwright/src/data/pairing_store.dart';
import 'package:castwright/src/domain/paired_server.dart';
import 'package:castwright/src/ui/pairing_screen.dart';
import 'package:castwright/src/brand.dart';

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

void main() {
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

  Future<void> fill(WidgetTester tester) async {
    await tester.enterText(find.byKey(const Key('field-host')), '10.0.0.5:8443');
    await tester.enterText(find.byKey(const Key('field-code')), 'K7QF3M2P');
    await tester.enterText(find.byKey(const Key('field-fptag')), 'J4XQ2A7BWZ9K3M5R');
    await tester.tap(find.widgetWithText(FilledButton, 'Pair'));
    await tester.pumpAndSettle();
  }

  testWidgets('shows the mismatch error and does not save on a bad tag', (tester) async {
    final store = FakeStore();
    final service = PairingService(fetchCa: (url) async => 'pem', verifyTag: (pem, tag) => false);
    await open(tester, service, store);
    await fill(tester);
    expect(find.byKey(const Key('pair-error')), findsOneWidget);
    expect(store.saved, isNull);
  });

  testWidgets('saves the connection on a good tag + successful redeem', (tester) async {
    final store = FakeStore();
    final service = PairingService(
      fetchCa: (url) async => 'pem',
      verifyTag: (pem, tag) => true,
      redeem: (url, code, caPem) async => const RedeemResult(token: 'tok', caFingerprint: 'AB:CD'),
    );
    await open(tester, service, store);
    await fill(tester);
    expect(store.saved, isNotNull);
    expect(store.saved!.url, 'https://10.0.0.5:8443');
    expect(store.saved!.token, 'tok');
  });

  testWidgets('shows the brand short-form tagline on first run', (tester) async {
    final store = FakeStore();
    final service =
        PairingService(fetchCa: (url) async => 'pem', verifyTag: (pem, tag) => false);
    await open(tester, service, store);
    final tagline = find.byKey(const Key('pair-tagline'));
    expect(tagline, findsOneWidget);
    expect(tester.widget<Text>(tagline).data, brandTaglineShort);
  });
}
