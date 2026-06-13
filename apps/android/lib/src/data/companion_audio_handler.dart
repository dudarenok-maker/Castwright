import 'dart:async';

import 'package:audio_service/audio_service.dart';
import 'package:rxdart/rxdart.dart';

import '../domain/media_browse_tree.dart';
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
/// [onPlayMediaId] (the runtime builds these from the live library). Because
/// Android Auto can bind + query the browser before the async runtime boot
/// wires those callbacks, [getChildren] waits (bounded) on a readiness
/// [Completer] and refreshes AA via [_notifyChildrenChanged] once the live tree
/// is available and whenever the playing chapter/book changes.
class CompanionAudioHandler extends BaseAudioHandler with SeekHandler {
  CompanionAudioHandler({this.readyTimeout = const Duration(seconds: 4)});

  /// How long [getChildren] waits for [attach] before falling back to the info
  /// row (so Android Auto never hangs on a cold/unpaired connect).
  final Duration readyTimeout;

  /// Per-folder subjects backing [subscribeToChildren]. Android Auto listens to
  /// these; pushing an event re-queries [getChildren] for that folder. Created
  /// lazily as AA subscribes (only the folders it shows are tracked).
  final Map<String, BehaviorSubject<Map<String, dynamic>>> _childrenSubjects = {};

  PlayerController? _controller;
  Future<List<MediaItem>> Function(String parentMediaId)? _childrenProvider;
  Future<void> Function(String mediaId)? _onPlayMediaId;
  final List<StreamSubscription<Object?>> _subs = [];

  /// Completes when [attach] wires a live provider. Reset on [detach] so a
  /// post-unpair query waits again rather than seeing a stale "ready".
  Completer<void> _ready = Completer<void>();

  /// Last book we told Android Auto about — refresh the root (Tab-1 label) only
  /// when the book actually changes.
  String? _lastNotifiedBookId;

  /// Shown when Android Auto connects before the runtime is ready (or unpaired).
  static const MediaItem _infoRow = MediaItem(
    id: 'info',
    title: 'Open Castwright on your phone to set up',
    playable: false,
  );

  /// Wire the live player (+ optional car browse). Idempotent: re-attaching
  /// swaps the player without disturbing an in-flight readiness wait.
  void attach(
    PlayerController controller, {
    Future<List<MediaItem>> Function(String parentMediaId)? childrenProvider,
    Future<void> Function(String mediaId)? onPlayMediaId,
  }) {
    _cancelSubs();
    _controller = controller;
    _childrenProvider = childrenProvider;
    _onPlayMediaId = onPlayMediaId;
    _subs.add(controller.playingStream.listen((_) => _broadcastState()));
    _subs.add(controller.positionStream.listen((_) => _broadcastState()));
    _subs.add(controller.nowPlayingStream.listen(_onNowPlaying));
    _broadcastState();
    if (!_ready.isCompleted) _ready.complete();
    // The root may now expose a current-book tab + real labels.
    _notify(rootMediaId);
  }

  void detach() {
    _cancelSubs();
    _controller = null;
    _childrenProvider = null;
    _onPlayMediaId = null;
    _lastNotifiedBookId = null;
    // Only reset a *completed* readiness gate — never abandon an instance an
    // in-flight getChildren is still awaiting (attach completes that one).
    if (_ready.isCompleted) _ready = Completer<void>();
  }

  void _cancelSubs() {
    for (final s in _subs) {
      s.cancel();
    }
    _subs.clear();
  }

  /// Tell Android Auto a folder's children changed (re-queries [getChildren]).
  /// No-op when nothing is subscribed to that folder.
  void _notify(String parentMediaId) {
    final s = _childrenSubjects[parentMediaId];
    if (s != null && !s.isClosed) s.add(const <String, dynamic>{});
  }

  @override
  ValueStream<Map<String, dynamic>> subscribeToChildren(String parentMediaId) {
    return _childrenSubjects.putIfAbsent(
        parentMediaId, () => BehaviorSubject.seeded(const <String, dynamic>{}));
  }

  void _onNowPlaying(NowPlaying? np) {
    if (np == null) return;
    mediaItem.add(MediaItem(
      // Match the browse-tree id so Android Auto highlights the active chapter.
      id: chapterMediaId(np.bookId, np.id),
      title: np.title,
      album: np.album.isEmpty ? 'Castwright' : np.album,
      duration: np.duration,
      artUri: (np.artPath != null && np.artPath!.isNotEmpty)
          ? Uri.file(np.artPath!)
          : null,
    ));
    _broadcastState();
    // Refresh the current-book chapter list (moves the highlight); refresh the
    // root too when the book changed (updates the Tab-1 label).
    final bookChanged = np.bookId != _lastNotifiedBookId;
    _lastNotifiedBookId = np.bookId;
    _notify(currentMediaId);
    if (bookChanged) _notify(rootMediaId);
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
    if (_childrenProvider == null) {
      // AA queried before the runtime attached — wait (bounded) for it.
      try {
        await _ready.future.timeout(readyTimeout);
      } on TimeoutException {
        return [_infoRow];
      }
    }
    final provider = _childrenProvider;
    return provider != null ? await provider(parentMediaId) : [_infoRow];
  }

  @override
  Future<void> playFromMediaId(String mediaId,
      [Map<String, dynamic>? extras]) async {
    final cb = _onPlayMediaId;
    if (cb != null) await cb(mediaId);
  }
}

/// Standard audio_service config for the companion's media session.
///
/// app-9: `androidBrowsableRootExtras` declares Android Auto content-style
/// support (render the browse tree as lists); `artDownscale*` forces
/// audio_service to decode + re-encode cover art itself so the AA projection —
/// a separate process that can't read our private `file://` thumbnails — can
/// still show covers (Stage-1 art fix).
const companionAudioServiceConfig = AudioServiceConfig(
  androidNotificationChannelId: 'ai.castwright.audio',
  androidNotificationChannelName: 'Playback',
  androidNotificationOngoing: true,
  artDownscaleWidth: 256,
  artDownscaleHeight: 256,
  androidBrowsableRootExtras: browsableRootExtras,
);
