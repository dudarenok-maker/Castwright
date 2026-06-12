import 'package:castwright/src/demo/demo_audio_engine.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  test('reports a fixed playing state, position and duration', () async {
    final engine = DemoAudioEngine(
      position: const Duration(minutes: 7, seconds: 12),
      duration: const Duration(minutes: 23, seconds: 40),
    );
    expect(engine.playing, isTrue);
    expect(engine.position, const Duration(minutes: 7, seconds: 12));
    expect(engine.duration, const Duration(minutes: 23, seconds: 40));
    expect(await engine.playingStream.first, isTrue);
    expect(await engine.positionStream.first, engine.position);
    expect(await engine.durationStream.first, engine.duration);
  });

  test('control methods are no-ops that complete', () async {
    final engine = DemoAudioEngine();
    await engine.setFilePath('whatever');
    await engine.play();
    await engine.pause();
    await engine.seek(const Duration(seconds: 5));
    await engine.setSpeed(1.5);
    await engine.setVolumeBoost(3);
    await engine.dispose();
  });
}
