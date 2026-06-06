import 'package:audio_service/audio_service.dart';

import 'player_controller.dart';

/// Bridges the OS media session (lock screen, Bluetooth, notification) to the
/// [PlayerController]. Bluetooth/notification skip buttons honour the `app-13`
/// skip-button behaviour (default ±seek, not chapter) via [PlayerController.skip].
///
/// Device-tuned glue — not unit-tested (the [PlayerController] brain is).
class CompanionAudioHandler extends BaseAudioHandler with SeekHandler {
  CompanionAudioHandler(this._controller);

  final PlayerController _controller;

  @override
  Future<void> play() => _controller.play();

  @override
  Future<void> pause() => _controller.pause();

  @override
  Future<void> seek(Duration position) => _controller.seekTo(position);

  // Bluetooth/headset/steering-wheel next/prev — defaults to a short seek so an
  // accidental press doesn't skip a whole chapter (toggle in app-13).
  @override
  Future<void> skipToNext() => _controller.skip(forward: true);

  @override
  Future<void> skipToPrevious() => _controller.skip(forward: false);

  @override
  Future<void> stop() async {
    await _controller.pause();
    await super.stop();
  }
}

/// Standard audio_service config for the companion's media session.
const companionAudioServiceConfig = AudioServiceConfig(
  androidNotificationChannelId: 'com.audiobookgenerator.audiobook_companion.audio',
  androidNotificationChannelName: 'Playback',
  androidNotificationOngoing: true,
);
