import 'package:castwright/main.dart';
import 'package:castwright/src/demo/demo_pairing_store.dart';
import 'package:castwright/src/demo/demo_runtime.dart';
import 'package:castwright/src/domain/window_size.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import 'package:path_provider/path_provider.dart';

/// On-device acceptance for the app-21 adaptive layout: drives the REAL app
/// (demo runtime) on whatever device it runs on and asserts the layout matches
/// that device's window size class — two-pane on a tablet/foldable-open
/// (≥840 dp), single-pane (pushed player) on a phone. Same test passes on both,
/// so it doubles as a phone-regression + tablet-acceptance check.
///
/// Run: `flutter test integration_test/responsive_adaptive_test.dart -d <device>`.
Future<void> main() async {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();

  testWidgets('adaptive layout matches the device window size class',
      (tester) async {
    final dir = await getExternalStorageDirectory();
    final rt = await buildDemoRuntime(
      coversDir: '/data/local/tmp/demo-covers', // optional; missing → placeholder
      offline: false,
      root: '${dir!.path}/adaptive-test-runtime',
    );

    await tester.pumpWidget(AudiobookCompanionApp(
      key: const ValueKey('adaptive-test'),
      store: DemoPairingStore(),
      deepLinks: const Stream.empty(),
      runtimeOverride: rt,
      themeMode: ThemeMode.light,
    ));
    await tester.pumpAndSettle();

    final logicalWidth =
        tester.view.physicalSize.width / tester.view.devicePixelRatio;
    final expanded =
        windowSizeClassFor(logicalWidth) == WindowSizeClass.expanded;

    // The library rendered (search field present) and the hero book is on the
    // Continue-listening rail — always built (top of the scroll), unlike a
    // below-the-fold grid tile.
    expect(find.byKey(const Key('library-search')), findsOneWidget,
        reason: 'library should render at $logicalWidth dp');
    final heroCard = find.byKey(const Key('continue-hollow-tide-1'));
    expect(heroCard, findsOneWidget);

    if (expanded) {
      // Two-pane: the shell Row is present and the detail pane starts empty.
      expect(find.byKey(const Key('adaptive-two-pane')), findsOneWidget);
      expect(find.text('Select a book to start listening'), findsOneWidget);

      await tester.tap(heroCard);
      await tester.pumpAndSettle();

      // The player filled the persistent pane in place (no route push).
      expect(find.byKey(const Key('player-playpause')), findsOneWidget);
      expect(find.text('Select a book to start listening'), findsNothing);
    } else {
      // Single-pane: no two-pane Row; selecting pushes the PlayerScreen route.
      expect(find.byKey(const Key('adaptive-two-pane')), findsNothing);

      await tester.tap(heroCard);
      await tester.pumpAndSettle();

      expect(find.byKey(const Key('player-playpause')), findsOneWidget);
    }
  });
}
