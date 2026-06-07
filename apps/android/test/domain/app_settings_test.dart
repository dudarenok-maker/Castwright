import 'package:flutter_test/flutter_test.dart';
import 'package:castwright/src/domain/app_settings.dart';
import 'package:castwright/src/domain/skip_behavior.dart';

void main() {
  group('AppSettings', () {
    test('sensible defaults', () {
      const s = AppSettings.defaults;
      expect(s.sleepTimerMinutes, 0); // off
      expect(s.defaultSpeed, 1.0);
      expect(s.skipButtonBehavior, SkipButtonBehavior.seek);
      expect(s.skipForwardSeconds, 30);
      expect(s.skipBackwardSeconds, 15);
      expect(s.unmeteredWifiOnly, isTrue);
      expect(s.autoSyncOnReconnect, isTrue);
      expect(s.autoDeleteFinished, isFalse);
      expect(s.keepRecentBooks, greaterThan(0));
      expect(s.storageCapBytes, greaterThan(0));
    });

    test('copyWith overrides only the given fields', () {
      final s = AppSettings.defaults.copyWith(
        skipButtonBehavior: SkipButtonBehavior.chapter,
        unmeteredWifiOnly: false,
      );
      expect(s.skipButtonBehavior, SkipButtonBehavior.chapter);
      expect(s.unmeteredWifiOnly, isFalse);
      expect(s.defaultSpeed, 1.0); // untouched
    });

    test('json round-trips, including the skip-behavior enum', () {
      final s = AppSettings.defaults.copyWith(
        sleepTimerMinutes: 30,
        defaultSpeed: 1.5,
        skipButtonBehavior: SkipButtonBehavior.chapter,
        storageCapBytes: 1234,
        autoDeleteFinished: true,
        streamOverLan: true,
        volumeBoostDb: 8,
      );
      final back = AppSettings.fromJson(s.toJson());
      expect(back.sleepTimerMinutes, 30);
      expect(back.defaultSpeed, 1.5);
      expect(back.skipButtonBehavior, SkipButtonBehavior.chapter);
      expect(back.storageCapBytes, 1234);
      expect(back.autoDeleteFinished, isTrue);
      expect(back.streamOverLan, isTrue);
      expect(back.volumeBoostDb, 8.0);
    });

    test('volumeBoostDb defaults to 0 (off)', () {
      expect(AppSettings.defaults.volumeBoostDb, 0);
      expect(AppSettings.fromJson(const {}).volumeBoostDb, 0);
    });

    test('fromJson tolerates missing keys (falls back to defaults)', () {
      final s = AppSettings.fromJson({'defaultSpeed': 2.0});
      expect(s.defaultSpeed, 2.0);
      expect(s.skipButtonBehavior, SkipButtonBehavior.seek); // default
      expect(s.unmeteredWifiOnly, isTrue); // default
    });

    test('fromJson tolerates an unknown skip-behavior value', () {
      final s = AppSettings.fromJson({'skipButtonBehavior': 'bogus'});
      expect(s.skipButtonBehavior, SkipButtonBehavior.seek);
    });
  });
}
