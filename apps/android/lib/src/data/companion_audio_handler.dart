import 'dart:async';

import 'package:audio_service/audio_service.dart';

import 'player_controller.dart';

/// Bridges the OS media session (lock screen, notification, Bluetooth/headset,
/// Android Auto / CarPlay) to the [PlayerController].
///
/// Created detached in `main()` via `AudioService.init` (before pairing builds
/// the runtime), then [attach]ed to the live player. It **observes** the
/// player's streams to broadcast `playbackState` + `mediaItem` outward (so the
/// lock-screen shows title/art/progress) and routes OS controls inward.
/// Bluetooth next/prev honour the app-13 skip behaviour via [PlayerController.skip].
///
/// app-9: in-car browse comes from the injected [childrenProvider] /
/// [onPlayMediaId] (the runtime builds these from the live library).
class CompanionAudioHandler extends BaseAudioHandler with SeekHandler {
  PlayerController? _controller;
  Future<List<MediaItem>> Function(String parentMediaId)? _childrenProvider;
  Future<void> Function(String mediaId)? _onPlayMediaId;
  final List<StreamSubscription<Object?>> _subs = [];

  /// Wire the live player (+ optional car browse). Idempotent: re-attaching
  /// detaches the previous player first.
  void attach(
    PlayerController controller, {
    Future<List<MediaItem>> Function(String parentMediaId)? childrenProvider,
    Future<void> Function(String mediaId)? onPlayMediaId,
  }) {
    detach();
    _controller = controller;
    _childrenProvider = childrenProvider;
    _onPlayMediaId = onPlayMediaId;
    _subs.add(controller.playingStream.listen((_) => _broadcastState()));
    _subs.add(controller.positionStream.listen((_) => _broadcastState()));
    _subs.add(controller.nowPlayingStream.listen(_onNowPlaying));
    _broadcastState();
  }

  void detach() {
    for (final s in _subs) {
      s.cancel();
    }
    _subs.clear();
    _controller = null;
  }

  void _onNowPlaying(NowPlaying? np) {
    if (np == null) return;
    mediaItem.add(MediaItem(
      id: np.id,
      title: np.title,
      album: np.album.isEmpty ? 'Castwright' : np.album,
      duration: np.duration,
      artUri: (np.artPath != null && np.artPath!.isNotEmpty)
          ? Uri.file(np.artPath!)
          : null,
    ));
    _broadcastState();
  }

  void _broadcastState() {
    final c = _controller;
    final isPlaying = c?.playing ?? false;
    playbackState.add(playbackState.value.copyWith(
      controls: [
        MediaControl.skipToPrevious,
        if (isPlaying) MediaControl.pause else MediaControl.play,
        MediaControl.skipToNext,
      ],
      systemActions: const {MediaAction.seek},
      processingState: AudioProcessingState.ready,
      playing: isPlaying,
      updatePosition: c?.position ?? Duration.zero,
    ));
  }

  @override
  Future<void> play() => _controller?.play() ?? Future.value();

  @override
  Future<void> pause() => _controller?.pause() ?? Future.value();

  @override
  Future<void> seek(Duration position) =>
      _controller?.seekTo(position) ?? Future.value();

  // Bluetooth/headset/steering-wheel next/prev — defaults to a short seek so an
  // accidental press doesn't skip a whole chapter (toggle in app-13).
  @override
  Future<void> skipToNext() => _controller?.skip(forward: true) ?? Future.value();

  @override
  Future<void> skipToPrevious() =>
      _controller?.skip(forward: false) ?? Future.value();

  @override
  Future<void> stop() async {
    await _controller?.pause();
    await super.stop();
  }

  // --- app-9: in-car media browsing (Android Auto / CarPlay) ---------------

  @override
  Future<List<MediaItem>> getChildren(String parentMediaId,
      [Map<String, dynamic>? options]) async {
    final provider = _childrenProvider;
    return provider != null ? await provider(parentMediaId) : const [];
  }

  @override
  Future<void> playFromMediaId(String mediaId,
      [Map<String, dynamic>? extras]) async {
    final cb = _onPlayMediaId;
    if (cb != null) await cb(mediaId);
  }
}

/// Standard audio_service config for the companion's media session.
const companionAudioServiceConfig = AudioServiceConfig(
  androidNotificationChannelId: 'ai.castwright.audio',
  androidNotificationChannelName: 'Playback',
  androidNotificationOngoing: true,
);
