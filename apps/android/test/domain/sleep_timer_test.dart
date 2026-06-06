import 'package:flutter_test/flutter_test.dart';
import 'package:audiobook_companion/src/domain/sleep_timer.dart';

class FakeHandle implements SleepHandle {
  bool cancelled = false;
  @override
  void cancel() => cancelled = true;
}

void main() {
  group('SleepTimer', () {
    test('start schedules onExpire and marks active', () {
      var expired = false;
      Duration? scheduled;
      void Function()? captured;
      final timer = SleepTimer(
        onExpire: () => expired = true,
        scheduler: (d, cb) {
          scheduled = d;
          captured = cb;
          return FakeHandle();
        },
      );

      timer.start(const Duration(minutes: 30));
      expect(timer.isActive, isTrue);
      expect(scheduled, const Duration(minutes: 30));

      captured!(); // fire
      expect(expired, isTrue);
      expect(timer.isActive, isFalse);
    });

    test('cancel cancels the handle and clears active', () {
      final handle = FakeHandle();
      final timer = SleepTimer(onExpire: () {}, scheduler: (d, cb) => handle);
      timer.start(const Duration(minutes: 10));
      timer.cancel();
      expect(handle.cancelled, isTrue);
      expect(timer.isActive, isFalse);
    });

    test('starting again cancels the previous handle', () {
      final handles = <FakeHandle>[];
      final timer = SleepTimer(
        onExpire: () {},
        scheduler: (d, cb) {
          final h = FakeHandle();
          handles.add(h);
          return h;
        },
      );
      timer.start(const Duration(minutes: 5));
      timer.start(const Duration(minutes: 15));
      expect(handles.first.cancelled, isTrue);
      expect(handles.last.cancelled, isFalse);
    });
  });
}
