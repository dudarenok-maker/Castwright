import 'package:castwright/src/data/file_store.dart';
import 'package:castwright/src/demo/demo_runtime.dart';
import 'package:castwright/src/domain/paired_server.dart';
import 'package:castwright/src/ui/app_settings_screen.dart';
import 'package:castwright/src/ui/library_home_screen.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

const _server = PairedServer(
    url: 'https://demo.local', token: 't', caFingerprint: 'demo-fingerprint');

/// Enlarge the test surface so lazy-ListView tiles (Server / unpair rows, below
/// the fold on the default 800x600) actually mount and are findable.
void _bigSurface(WidgetTester tester) {
  tester.view.physicalSize = const Size(1200, 2400);
  tester.view.devicePixelRatio = 1.0;
  addTearDown(tester.view.reset);
}

// NOTE: these tests intentionally do NOT call `rt.dispose()`. Disposing the
// runtime while the screen is still mounted closes the Drift DB out from under
// LibraryHomeScreen's in-flight `_refresh` stream and deadlocks. The in-memory
// runtime is reclaimed at process exit — the same pattern as runtime_override_test.

void main() {
  testWidgets('library AppBar shows the Demo badge in demoMode', (tester) async {
    final rt = await buildDemoRuntime(fs: InMemoryFileStore(), coversDir: '/covers');
    await tester.pumpWidget(MaterialApp(
      home: LibraryHomeScreen(
          runtime: rt, server: _server, onUnpair: () async {}, demoMode: true),
    ));
    await tester.pumpAndSettle();
    expect(find.byKey(const Key('demo-badge')), findsOneWidget);
  });

  testWidgets('settings suppresses Server section + shows Exit demo in demoMode',
      (tester) async {
    _bigSurface(tester);
    final rt = await buildDemoRuntime(fs: InMemoryFileStore(), coversDir: '/covers');
    await tester.pumpWidget(MaterialApp(
      home: AppSettingsScreen(
          runtime: rt,
          server: _server,
          onUnpair: () async {},
          onLibraryCleared: () {},
          demoMode: true),
    ));
    await tester.pumpAndSettle();
    expect(find.text('Server'), findsNothing);
    expect(find.text('demo-fingerprint'), findsNothing);
    expect(find.text('Exit demo'), findsOneWidget);
    expect(find.text('Unpair device'), findsNothing);
  });

  testWidgets('settings keeps Server section when not in demoMode', (tester) async {
    _bigSurface(tester);
    final rt = await buildDemoRuntime(fs: InMemoryFileStore(), coversDir: '/covers');
    await tester.pumpWidget(MaterialApp(
      home: AppSettingsScreen(
          runtime: rt,
          server: _server,
          onUnpair: () async {},
          onLibraryCleared: () {}),
    ));
    await tester.pumpAndSettle();
    // 'Server' renders twice (section label + ListTile title); assert the
    // unique URL instead so the presence check is unambiguous.
    expect(find.text('https://demo.local'), findsOneWidget);
    expect(find.text('Unpair device'), findsOneWidget);
  });
}
