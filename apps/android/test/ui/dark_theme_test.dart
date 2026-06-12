import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:castwright/main.dart';
import 'package:castwright/src/data/pairing_store.dart';
import 'package:castwright/src/domain/paired_server.dart';

/// A store that reports "not paired" so the app settles on the on-ramp Scaffold
/// — enough to read the resolved theme brightness off a real BuildContext.
class _UnpairedStore implements PairingStore {
  @override
  Future<PairedServer?> load() async => null;
  @override
  Future<String?> loadCaPem() async => null;
  @override
  Future<void> save(PairedServer server) async {}
  @override
  Future<void> saveCaPem(String pem) async {}
  @override
  Future<void> clear() async {}
}

void main() {
  testWidgets('themeMode dark resolves a dark color scheme', (tester) async {
    await tester.pumpWidget(AudiobookCompanionApp(
      store: _UnpairedStore(),
      deepLinks: const Stream.empty(),
      themeMode: ThemeMode.dark,
    ));
    await tester.pumpAndSettle();

    final ctx = tester.element(find.text('Not paired yet'));
    expect(Theme.of(ctx).colorScheme.brightness, Brightness.dark);
  });

  testWidgets('themeMode light resolves a light color scheme', (tester) async {
    await tester.pumpWidget(AudiobookCompanionApp(
      store: _UnpairedStore(),
      deepLinks: const Stream.empty(),
      themeMode: ThemeMode.light,
    ));
    await tester.pumpAndSettle();

    final ctx = tester.element(find.text('Not paired yet'));
    expect(Theme.of(ctx).colorScheme.brightness, Brightness.light);
  });
}
