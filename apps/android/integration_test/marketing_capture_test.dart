import 'package:castwright/main.dart';
import 'package:castwright/src/data/pairing_service.dart';
import 'package:castwright/src/demo/demo_pairing_store.dart';
import 'package:castwright/src/demo/demo_runtime.dart';
import 'package:castwright/src/domain/pairing_qr.dart';
import 'package:castwright/src/ui/pairing_screen.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import 'package:path_provider/path_provider.dart';

import 'marketing/scenes.dart';

/// Drives every marketing scene × theme and emits one screenshot each. Run via
/// `flutter drive` (see integration_test/marketing/README.md) — the driver
/// (test_driver/integration_test.dart) writes the PNG bytes to disk.
Future<void> main() async {
  final binding = IntegrationTestWidgetsFlutterBinding.ensureInitialized();

  testWidgets('capture marketing scenes', (tester) async {
    // Android: replace the live surface with an image-backed one so
    // takeScreenshot can read pixels. Done once, before the first shot.
    await binding.convertFlutterSurfaceToImage();

    final dir = await getExternalStorageDirectory();
    final coversDir = '${dir!.path}/demo-covers';

    for (final theme in [ThemeMode.light, ThemeMode.dark]) {
      final themeName = theme == ThemeMode.light ? 'light' : 'dark';
      for (final scene in marketingScenes) {
        final rt = await buildDemoRuntime(
          coversDir: coversDir,
          offline: scene.offline,
          root: '${dir.path}/demo-runtime', // writable app dir on-device
        );

        if (scene.nav == SceneNav.pairing) {
          // Pairing skips the runtime — pump the pre-filled review form directly.
          await tester.pumpWidget(MaterialApp(
            themeMode: theme,
            theme: ThemeData(
                colorScheme: ColorScheme.fromSeed(seedColor: const Color(0xFFA43C6C)),
                useMaterial3: true),
            darkTheme: ThemeData(
                colorScheme: ColorScheme.fromSeed(
                    seedColor: const Color(0xFFA43C6C), brightness: Brightness.dark),
                useMaterial3: true),
            home: PairingScreen(
              service: PairingService(),
              store: DemoPairingStore(),
              initialQr: const PairingQr(
                  hostPort: 'studio.local:8443', code: '4810-6105', fpTag: 'CW7K-P2'),
            ),
          ));
          await tester.pumpAndSettle();
        } else {
          await tester.pumpWidget(AudiobookCompanionApp(
            store: DemoPairingStore(),
            deepLinks: const Stream.empty(),
            runtimeOverride: rt,
            themeMode: theme,
          ));
          await tester.pumpAndSettle();

          if (scene.nav == SceneNav.settings) {
            await tester.tap(find.byKey(const Key('open-settings')));
            await tester.pumpAndSettle();
          } else if (scene.nav == SceneNav.player) {
            // Tap the book tile by key (the title also appears in the Continue
            // rail). ensureVisible guards against it being below the fold.
            final book = find.byKey(const Key('book-hollow-tide-1'));
            await tester.ensureVisible(book);
            await tester.pumpAndSettle();
            await tester.tap(book);
            await tester.pumpAndSettle();
            // Flip the local _playing flag to the playing look.
            final chapter = find.byKey(const Key('chapter-ht1-c2'));
            if (chapter.evaluate().isNotEmpty) {
              await tester.tap(chapter);
              await tester.pumpAndSettle();
            }
          }
        }

        await binding.takeScreenshot('${scene.id}.$themeName');
        await rt.dispose();
      }
    }
  });
}
