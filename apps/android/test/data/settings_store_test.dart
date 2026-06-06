import 'package:flutter_test/flutter_test.dart';
import 'package:audiobook_companion/src/data/file_store.dart';
import 'package:audiobook_companion/src/data/settings_store.dart';
import 'package:audiobook_companion/src/domain/app_settings.dart';
import 'package:audiobook_companion/src/domain/skip_behavior.dart';

void main() {
  group('SettingsStore', () {
    test('returns defaults when nothing is saved', () async {
      final s = await SettingsStore(InMemoryFileStore(), path: '/s.json').load();
      expect(s.unmeteredWifiOnly, isTrue);
      expect(s.skipButtonBehavior, SkipButtonBehavior.seek);
    });

    test('saves and loads back', () async {
      final fs = InMemoryFileStore();
      final store = SettingsStore(fs, path: '/s.json');
      await store.save(AppSettings.defaults.copyWith(
        defaultSpeed: 1.75,
        skipButtonBehavior: SkipButtonBehavior.chapter,
      ));
      final loaded = await store.load();
      expect(loaded.defaultSpeed, 1.75);
      expect(loaded.skipButtonBehavior, SkipButtonBehavior.chapter);
    });

    test('returns defaults on corrupt json', () async {
      final fs = InMemoryFileStore();
      await fs.writeBytes('/s.json', 'not json'.codeUnits);
      final loaded = await SettingsStore(fs, path: '/s.json').load();
      expect(loaded.defaultSpeed, AppSettings.defaults.defaultSpeed);
    });
  });
}
