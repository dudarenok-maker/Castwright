import 'package:castwright/src/data/file_store.dart';
import 'package:castwright/src/demo/demo_audio_engine.dart';
import 'package:castwright/src/demo/demo_runtime.dart';
import 'package:castwright/src/demo/demo_ticking_audio_engine.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  test('defaults to the posed DemoAudioEngine when no engine is passed', () async {
    final rt = await buildDemoRuntime(fs: InMemoryFileStore(), coversDir: '/covers');
    expect(rt.player.audioEngine, isA<DemoAudioEngine>());
    await rt.dispose();
  });

  test('uses the injected engine when provided', () async {
    final rt = await buildDemoRuntime(
      fs: InMemoryFileStore(),
      coversDir: '/covers',
      engine: DemoTickingAudioEngine(),
    );
    expect(rt.player.audioEngine, isA<DemoTickingAudioEngine>());
    await rt.dispose();
  });
}
