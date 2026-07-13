import 'package:castwright/main.dart';
import 'package:castwright/src/data/file_store.dart';
import 'package:castwright/src/demo/demo_pairing_store.dart';
import 'package:castwright/src/demo/demo_runtime.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  testWidgets('runtimeOverride boots straight to the library', (tester) async {
    final fs = InMemoryFileStore();
    final rt = await buildDemoRuntime(fs: fs, coversDir: '/covers');

    await tester.pumpWidget(AudiobookCompanionApp(
      store: DemoPairingStore(),
      deepLinks: const Stream.empty(),
      runtimeOverride: rt,
    ));
    await tester.pumpAndSettle();

    // The library AppBar title proves we skipped pairing and rendered the home.
    expect(find.text('Library'), findsOneWidget);
    expect(find.text('Not paired yet'), findsNothing);
    // A seeded book tile is shown (by key — the title also appears in the
    // Continue rail, so a text matcher would find two). The default test
    // surface (800dp logical) is `medium` (app-21), which renders the
    // cover-forward grid (taller tiles than the old ListTile rows) — scroll
    // it into view first so this still finds an on-screen widget rather than
    // one merely built-but-clipped below the fold.
    await tester.ensureVisible(
        find.byKey(const Key('book-hollow-tide-1'), skipOffstage: false));
    await tester.pumpAndSettle();
    expect(find.byKey(const Key('book-hollow-tide-1')), findsOneWidget);
  });
}
