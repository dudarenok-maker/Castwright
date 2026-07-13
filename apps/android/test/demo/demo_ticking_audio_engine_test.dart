import 'package:castwright/src/demo/demo_ticking_audio_engine.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  test('position advances while playing and stops when paused', () async {
    final e = DemoTickingAudioEngine(
      duration: const Duration(seconds: 10),
      tick: const Duration(milliseconds: 10),
    );
    await e.play();
    await Future<void>.delayed(const Duration(milliseconds: 60));
    final afterPlay = e.position;
    expect(afterPlay, greaterThan(Duration.zero));
    await e.pause();
    await Future<void>.delayed(const Duration(milliseconds: 40));
    expect(e.position, afterPlay); // no advance after pause
    await e.dispose();
  });

  test('positionStream is broadcast (multiple concurrent subscribers)', () async {
    final e = DemoTickingAudioEngine(tick: const Duration(milliseconds: 10));
    var a = 0, b = 0;
    final s1 = e.positionStream.listen((_) => a++);
    final s2 = e.positionStream.listen((_) => b++); // would throw if single-sub
    await e.play();
    await Future<void>.delayed(const Duration(milliseconds: 40));
    await s1.cancel();
    await s2.cancel();
    expect(a, greaterThan(0));
    expect(b, greaterThan(0));
    await e.dispose();
  });

  test('seek clamps and emits; setSpeed accepted', () async {
    final e = DemoTickingAudioEngine(duration: const Duration(seconds: 10));
    await e.setSpeed(2.0);
    await e.seek(const Duration(seconds: 100));
    expect(e.position, const Duration(seconds: 10)); // clamped to duration
    await e.seek(const Duration(seconds: -5));
    expect(e.position, Duration.zero); // clamped to zero
    await e.dispose();
  });

  test('dispose cancels the timer (no emissions afterward)', () async {
    final e = DemoTickingAudioEngine(tick: const Duration(milliseconds: 10));
    await e.play();
    await e.dispose();
    // A later listen on a closed broadcast controller yields no events.
    var emitted = 0;
    final sub = e.positionStream.listen((_) => emitted++);
    await Future<void>.delayed(const Duration(milliseconds: 40));
    await sub.cancel();
    expect(emitted, 0);
  });
}
