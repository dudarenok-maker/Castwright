import 'dart:async';

/// A cancelable scheduled callback — abstracts `dart:async` `Timer` so the
/// [SleepTimer] unit-tests without real time.
abstract class SleepHandle {
  void cancel();
}

typedef SleepScheduler = SleepHandle Function(
    Duration delay, void Function() onFire);

/// Bedtime sleep timer (`app-13`): fires [onExpire] (the host pauses playback)
/// after the configured delay. The scheduler is injectable for tests; the
/// default uses a real `Timer`.
class SleepTimer {
  SleepTimer({required void Function() onExpire, SleepScheduler? scheduler})
      : _onExpireCb = onExpire,
        _scheduler = scheduler ?? _defaultScheduler;

  final void Function() _onExpireCb;
  final SleepScheduler _scheduler;

  SleepHandle? _handle;
  bool _active = false;

  bool get isActive => _active;

  void start(Duration delay) {
    _handle?.cancel();
    _active = true;
    _handle = _scheduler(delay, () {
      _active = false;
      _onExpireCb();
    });
  }

  void cancel() {
    _handle?.cancel();
    _handle = null;
    _active = false;
  }
}

SleepHandle _defaultScheduler(Duration delay, void Function() onFire) =>
    _TimerHandle(Timer(delay, onFire));

class _TimerHandle implements SleepHandle {
  _TimerHandle(this._timer);
  final Timer _timer;
  @override
  void cancel() => _timer.cancel();
}
