import 'package:castwright/src/data/file_store.dart';
import 'package:castwright/src/demo/demo_runtime.dart';
import 'package:castwright/src/domain/paired_server.dart';
import 'package:castwright/src/ui/app_settings_screen.dart';
import 'package:castwright/src/ui/library_home_screen.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

const _server = PairedServer(
    url: 'https://demo.local', token: 't', caFingerprint: 'demo-fingerprint');

void main() {
  testWidgets('library AppBar shows the Demo badge in demoMode', (tester) async {
    final rt = await buildDemoRuntime(fs: InMemoryFileStore(), coversDir: '/covers');
    await tester.pumpWidget(MaterialApp(
      home: LibraryHomeScreen(
          runtime: rt, server: _server, onUnpair: () async {}, demoMode: true),
    ));
    await tester.pump();
    expect(find.byKey(const Key('demo-badge')), findsOneWidget);
    await rt.dispose();
  });

  testWidgets('settings suppresses Server section + shows Exit demo in demoMode',
      (tester) async {
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
    await rt.dispose();
  });

  testWidgets('settings keeps Server section when not in demoMode', (tester) async {
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
    await rt.dispose();
  });
}
