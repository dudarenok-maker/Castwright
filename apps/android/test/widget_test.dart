import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:audiobook_companion/main.dart';
import 'package:audiobook_companion/src/data/pairing_store.dart';
import 'package:audiobook_companion/src/domain/paired_server.dart';

/// In-memory store so the home widget test runs without platform channels.
class FakeStore implements PairingStore {
  FakeStore([this._value]);
  PairedServer? _value;
  @override
  Future<PairedServer?> load() async => _value;
  @override
  Future<void> save(PairedServer server) async => _value = server;
  @override
  Future<void> clear() async => _value = null;
}

void main() {
  testWidgets('unpaired home shows the status + a Pair a device button', (tester) async {
    await tester.pumpWidget(AudiobookCompanionApp(store: FakeStore()));
    await tester.pumpAndSettle();

    expect(find.text('Audiobook Companion'), findsWidgets);
    expect(find.byKey(const Key('home-status')), findsOneWidget);
    expect(find.text('Not paired yet'), findsOneWidget);
    expect(find.widgetWithText(FilledButton, 'Pair a device'), findsOneWidget);
  });

  testWidgets('paired home shows the server URL + an Unpair button', (tester) async {
    await tester.pumpWidget(
      AudiobookCompanionApp(
        store: FakeStore(
          const PairedServer(url: 'https://10.0.0.5:8443', token: 't', caFingerprint: 'f'),
        ),
      ),
    );
    await tester.pumpAndSettle();

    expect(find.text('Paired with https://10.0.0.5:8443'), findsOneWidget);
    expect(find.widgetWithText(OutlinedButton, 'Unpair'), findsOneWidget);
  });
}
