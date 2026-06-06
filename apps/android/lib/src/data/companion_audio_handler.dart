import 'package:audio_service/audio_service.dart';

import '../domain/media_browse_tree.dart';
import 'player_controller.dart';

/// Bridges the OS media session (lock screen, Bluetooth, notification) to the
/// [PlayerController]. Bluetooth/notification skip buttons honour the `app-13`
/// skip-button behaviour (default ±seek, not chapter) via [PlayerController.skip].
///
/// `app-9` adds the in-car browse tree (Android Auto + CarPlay) via the
/// `MediaBrowser` callbacks ([getChildren] / [playFromMediaId]) over the pure
/// [buildMediaBrowseTree]/[childrenOf] domain — the host supplies [browseRoot]
/// (built from the library) and [onPlayMediaId] (open + play).
///
/// Device-tuned glue — not unit-tested (the [PlayerController] + browse-tree
/// brains are).
class CompanionAudioHandler extends BaseAudioHandler with SeekHandler {
  CompanionAudioHandler(
    this._controller, {
    MediaNode Function()? browseRoot,
    void Function(MediaId mediaId)? onPlayMediaId,
  })  : _browseRootProvider = browseRoot,
        _playMediaIdCallback = onPlayMediaId;

  final PlayerController _controller;
  final MediaNode Function()? _browseRootProvider;
  final void Function(MediaId mediaId)? _playMediaIdCallback;

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

  // --- app-9: in-car media browsing (Android Auto / CarPlay) ---------------

  @override
  Future<List<MediaItem>> getChildren(String parentMediaId,
      [Map<String, dynamic>? options]) async {
    final root = _browseRootProvider?.call();
    if (root == null) return const [];
    return childrenOf(root, parentMediaId).map(_toMediaItem).toList();
  }

  @override
  Future<void> playFromMediaId(String mediaId,
      [Map<String, dynamic>? extras]) async {
    final parsed = parseMediaId(mediaId);
    if (parsed.kind == MediaIdKind.chapter) _playMediaIdCallback?.call(parsed);
  }

  MediaItem _toMediaItem(MediaNode n) => MediaItem(
        id: n.id,
        title: n.title,
        album: n.subtitle,
        playable: n.playable,
      );
}

/// Standard audio_service config for the companion's media session.
const companionAudioServiceConfig = AudioServiceConfig(
  androidNotificationChannelId: 'com.audiobookgenerator.audiobook_companion.audio',
  androidNotificationChannelName: 'Playback',
  androidNotificationOngoing: true,
);
