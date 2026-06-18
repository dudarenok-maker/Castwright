import 'dart:async';

import 'package:castwright/main.dart';
import 'package:castwright/src/data/pairing_service.dart';
import 'package:castwright/src/data/pairing_store.dart';
import 'package:castwright/src/domain/paired_server.dart';
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
  testWidgets('a pair deep link opens a pre-filled pairing screen',
      (tester) async {
    final links = StreamController<Uri>();
    addTearDown(links.close);
    await tester.pumpWidget(AudiobookCompanionApp(
      store: _NoopStore(),
      service: PairingService(),
      deepLinks: links.stream,
    ));
    await tester.pumpAndSettle();

    links.add(Uri.parse(
        'https://www.castwright.ai/pair?h=192.168.1.5:8443&c=K7QF3M2P&f=J4XQ2A7BWZ9K3M5R'));
    await tester.pumpAndSettle();

    expect(find.text('192.168.1.5:8443'), findsOneWidget);
    expect(find.text('K7QF3M2P'), findsOneWidget);
  });

  testWidgets('a non-pairing deep link is ignored', (tester) async {
    final links = StreamController<Uri>();
    addTearDown(links.close);
    await tester.pumpWidget(AudiobookCompanionApp(
      store: _NoopStore(),
      service: PairingService(),
      deepLinks: links.stream,
    ));
    await tester.pumpAndSettle();

    links.add(Uri.parse('https://example.com/'));
    await tester.pumpAndSettle();

    expect(find.byKey(const Key('home-status')), findsOneWidget);
    expect(find.text('192.168.1.5:8443'), findsNothing);
  });

  testWidgets('a second deep link does not stack a second pairing screen',
      (tester) async {
    final links = StreamController<Uri>();
    addTearDown(links.close);
    await tester.pumpWidget(AudiobookCompanionApp(
      store: _NoopStore(), service: PairingService(), deepLinks: links.stream));
    await tester.pumpAndSettle();

    links.add(Uri.parse('https://www.castwright.ai/pair?h=192.168.1.5:8443&c=K7QF3M2P&f=1CR5AYMZRKMGWCTRFPHCFV0H6R'));
    await tester.pumpAndSettle();
    links.add(Uri.parse('https://www.castwright.ai/pair?h=192.168.1.9:8443&c=ZZZZZZZZ&f=1CR5AYMZRKMGWCTRFPHCFV0H6R'));
    await tester.pumpAndSettle();

    expect(find.text('Pair a device'), findsOneWidget); // AppBar title — exactly one screen
  });
}
