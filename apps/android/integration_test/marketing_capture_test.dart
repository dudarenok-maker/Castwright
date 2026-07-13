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

const _seed = Color(0xFFA43C6C);

ThemeData _appTheme({required Brightness brightness}) => ThemeData(
  colorScheme: ColorScheme.fromSeed(seedColor: _seed, brightness: brightness),
  useMaterial3: true,
);

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
    // Covers live in adb-writable /data/local/tmp — it survives the app
    // install/uninstall lifecycle (unlike the app's external dir, which is wiped
    // on uninstall) and the app can still read it.
    const coversDir = '/data/local/tmp/demo-covers';
    final root =
        '${dir!.path}/demo-runtime'; // app-writable dir for Drift/settings

    for (final theme in [ThemeMode.light, ThemeMode.dark]) {
      final themeName = theme == ThemeMode.light ? 'light' : 'dark';
      for (final scene in marketingScenes) {
        final rt = await buildDemoRuntime(
          coversDir: coversDir,
          offline: scene.offline,
          root: root,
        );
        final key = ValueKey('${scene.id}-$themeName');

        if (scene.nav == SceneNav.pairing) {
          // Pairing skips the runtime — pump the pre-filled review form directly.
          await tester.pumpWidget(
            MaterialApp(
              key: key,
              debugShowCheckedModeBanner: false,
              themeMode: theme,
              theme: _appTheme(brightness: Brightness.light),
              darkTheme: _appTheme(brightness: Brightness.dark),
              home: PairingScreen(
                service: PairingService(),
                store: DemoPairingStore(),
                initialQr: const PairingQr(
                  hostPort: 'studio.local:8443',
                  code: '4810-6105',
                  fpTag: 'CW7K-P2',
                ),
              ),
            ),
          );
          await tester.pumpAndSettle();
        } else {
          // A unique key per scene forces a FRESH HomePage State each pump, so
          // _boot re-runs with this scene's runtime (otherwise Flutter reuses the
          // State and every scene clings to scene 0's now-disposed runtime).
          await tester.pumpWidget(
            AudiobookCompanionApp(
              key: key,
              store: DemoPairingStore(),
              deepLinks: const Stream.empty(),
              runtimeOverride: rt,
              themeMode: theme,
            ),
          );
          await tester.pumpAndSettle();

          if (scene.nav == SceneNav.settings) {
            await tester.tap(find.byKey(const Key('open-settings')));
            await tester.pumpAndSettle();
          } else if (scene.nav == SceneNav.player) {
            // Open the hero book (The Drowning Bell) and start a chapter so the
            // docked player shows the WaveformBar (peaks are seeded locally in
            // buildDemoRuntime) rather than the plain fallback slider.
            final book = find.byKey(const Key('book-hollow-tide-1'));
            await tester.ensureVisible(book);
            await tester.pumpAndSettle();
            await tester.tap(book);
            await tester.pumpAndSettle();
            final chapter = find.byKey(const Key('chapter-ht1-c2'));
            if (chapter.evaluate().isNotEmpty) {
              await tester.tap(chapter);
              await tester.pumpAndSettle();
            }
          } else if (scene.nav == SceneNav.bookDetail) {
            // A different book (The Coalfall Commission) opened at its resume
            // point — reads as "drilled into this book" (cover + chapter list +
            // resume position + waveform on the resumed chapter).
            final book = find.byKey(const Key('book-coalfall-commission'));
            await tester.ensureVisible(book);
            await tester.pumpAndSettle();
            await tester.tap(book);
            await tester.pumpAndSettle();
          }
        }

        // Image.file decodes off the frame pipeline, so pumpAndSettle doesn't
        // wait for cover art. Let real async run, then paint, before the shot.
        await tester.runAsync(
          () => Future<void>.delayed(const Duration(milliseconds: 800)),
        );
        await tester.pumpAndSettle();

        await binding.takeScreenshot('${scene.id}.$themeName');
        // NOTE: do NOT dispose rt here — the just-pumped HomePage State still
        // references it; the framework tears it down when the next scene pumps
        // (different key). Disposing now closes the Drift DB the screen still
        // reads. The handful of in-memory DBs are reclaimed at process exit.
      }
    }
  });
}
