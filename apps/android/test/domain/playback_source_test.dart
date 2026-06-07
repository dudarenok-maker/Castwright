import 'package:flutter_test/flutter_test.dart';
import 'package:castwright/src/domain/playback_source.dart';

void main() {
  group('resolvePlaybackSource', () {
    test('a downloaded chapter always plays the local file', () {
      expect(
        resolvePlaybackSource(
            localFileExists: true, onHomeLan: true, streamingEnabled: true),
        PlaybackSource.localFile,
      );
      // ...even off-LAN with streaming off.
      expect(
        resolvePlaybackSource(
            localFileExists: true, onHomeLan: false, streamingEnabled: false),
        PlaybackSource.localFile,
      );
    });

    test('not-downloaded + streaming on + on the home LAN -> stream', () {
      expect(
        resolvePlaybackSource(
            localFileExists: false, onHomeLan: true, streamingEnabled: true),
        PlaybackSource.lanStream,
      );
    });

    test('not-downloaded + streaming on + off-LAN -> needs download', () {
      expect(
        resolvePlaybackSource(
            localFileExists: false, onHomeLan: false, streamingEnabled: true),
        PlaybackSource.needsDownload,
      );
    });

    test('not-downloaded + streaming off -> needs download (offline-first)', () {
      expect(
        resolvePlaybackSource(
            localFileExists: false, onHomeLan: true, streamingEnabled: false),
        PlaybackSource.needsDownload,
      );
    });
  });
}
