import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:audiobook_companion/src/domain/app_settings.dart';
import 'package:audiobook_companion/src/domain/skip_behavior.dart';
import 'package:audiobook_companion/src/ui/settings_screen.dart';

void main() {
  Widget host(AppSettings s, void Function(AppSettings) onChanged) =>
      MaterialApp(home: SettingsScreen(settings: s, onChanged: onChanged));

  testWidgets('renders the key controls', (tester) async {
    await tester.pumpWidget(host(AppSettings.defaults, (_) {}));
    expect(find.byKey(const Key('unmetered-wifi-only')), findsOneWidget);
    expect(find.byKey(const Key('skip-chapter-mode')), findsOneWidget);
    expect(find.byKey(const Key('auto-sync-on-reconnect')), findsOneWidget);
    expect(find.byKey(const Key('auto-delete-finished')), findsOneWidget);
  });

  testWidgets('toggling unmetered-wifi-only emits the change', (tester) async {
    AppSettings? changed;
    await tester.pumpWidget(host(AppSettings.defaults, (s) => changed = s));
    await tester.tap(find.byKey(const Key('unmetered-wifi-only')));
    await tester.pump();
    expect(changed!.unmeteredWifiOnly, isFalse); // default true -> toggled off
  });

  testWidgets('enabling chapter-skip switches the behavior', (tester) async {
    AppSettings? changed;
    await tester.pumpWidget(host(AppSettings.defaults, (s) => changed = s));
    await tester.tap(find.byKey(const Key('skip-chapter-mode')));
    await tester.pump();
    expect(changed!.skipButtonBehavior, SkipButtonBehavior.chapter);
  });
}
