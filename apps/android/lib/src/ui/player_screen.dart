import 'package:flutter/material.dart';

import '../data/companion_runtime.dart';
import '../data/player_controller.dart';
import '../domain/sync_manifest.dart';

/// Player surface: a chapter picker + transport controls over the
/// [PlayerController]. Pick a chapter to start listening; the position ticks
/// live and play/pause/seek work.
class PlayerScreen extends StatefulWidget {
  const PlayerScreen({
    super.key,
    required this.runtime,
    required this.bookId,
    required this.title,
  });

  final CompanionRuntime runtime;
  final String bookId;
  final String title;

  @override
  State<PlayerScreen> createState() => _PlayerScreenState();
}

class _PlayerScreenState extends State<PlayerScreen> {
  bool _ready = false;
  bool _playing = false;
  String? _error;
  List<SyncManifestChapter> _chapters = const [];

  @override
  void initState() {
    super.initState();
    _prepare();
  }

  Future<void> _prepare() async {
    try {
      await widget.runtime.sync.ensureDetail(widget.bookId);
      await widget.runtime.player.openBook(widget.bookId); // loads + restores resume
      if (mounted) {
        setState(() {
          _chapters = widget.runtime.sync.chaptersOf(widget.bookId);
          _ready = true;
        });
      }
    } catch (e) {
      if (mounted) setState(() => _error = '$e');
    }
  }

  @override
  void dispose() {
    widget.runtime.player.pause();
    super.dispose();
  }

  Future<void> _playChapter(String uuid) async {
    await widget.runtime.player.playChapter(uuid);
    if (mounted) setState(() => _playing = true);
  }

  Future<void> _togglePlay() async {
    final p = widget.runtime.player;
    if (_playing) {
      await p.pause();
    } else {
      await p.play();
    }
    if (mounted) setState(() => _playing = !_playing);
  }

  String _fmt(Duration d) {
    final h = d.inHours;
    final m = d.inMinutes.remainder(60).toString().padLeft(2, '0');
    final s = d.inSeconds.remainder(60).toString().padLeft(2, '0');
    return h > 0 ? '$h:$m:$s' : '$m:$s';
  }

  @override
  Widget build(BuildContext context) {
    final player = widget.runtime.player;
    if (_error != null) {
      return Scaffold(
        appBar: AppBar(title: Text(widget.title)),
        body: Center(
          child: Padding(
            padding: const EdgeInsets.all(24),
            child: Text('Playback error: $_error', key: const Key('player-error')),
          ),
        ),
      );
    }
    if (!_ready) {
      return Scaffold(
        appBar: AppBar(title: Text(widget.title)),
        body: const Center(child: CircularProgressIndicator()),
      );
    }
    return Scaffold(
      appBar: AppBar(title: Text(widget.title)),
      body: Column(
        children: [
          Expanded(
            child: ListView.builder(
              itemCount: _chapters.length,
              itemBuilder: (_, i) {
                final c = _chapters[i];
                final current = c.uuid == player.currentChapterUuid;
                return ListTile(
                  key: Key('chapter-${c.uuid}'),
                  leading: CircleAvatar(child: Text('${c.id}')),
                  title: Text(c.title.isEmpty ? 'Chapter ${c.id}' : c.title),
                  trailing: current
                      ? Icon(_playing ? Icons.volume_up : Icons.pause,
                          color: Theme.of(context).colorScheme.primary)
                      : null,
                  selected: current,
                  onTap: c.hasAudio ? () => _playChapter(c.uuid) : null,
                  enabled: c.hasAudio,
                );
              },
            ),
          ),
          const Divider(height: 1),
          _transport(player),
        ],
      ),
    );
  }

  Widget _transport(PlayerController player) {
    return SafeArea(
      top: false,
      child: Padding(
        padding: const EdgeInsets.fromLTRB(8, 4, 8, 4),
        child: StreamBuilder<Duration?>(
          stream: player.durationStream,
          builder: (_, durSnap) {
            final dur = durSnap.data ?? player.duration ?? Duration.zero;
            return StreamBuilder<Duration>(
              stream: player.positionStream,
              builder: (_, posSnap) {
                final pos = posSnap.data ?? Duration.zero;
                final maxMs = dur.inMilliseconds;
                final v = maxMs > 0
                    ? pos.inMilliseconds.clamp(0, maxMs).toDouble()
                    : 0.0;
                return Column(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    Slider(
                      key: const Key('player-progress'),
                      value: v,
                      max: maxMs > 0 ? maxMs.toDouble() : 1.0,
                      onChanged: maxMs > 0
                          ? (x) => player
                              .seekTo(Duration(milliseconds: x.round()))
                          : null,
                    ),
                    Padding(
                      padding: const EdgeInsets.symmetric(horizontal: 16),
                      child: Row(
                        mainAxisAlignment: MainAxisAlignment.spaceBetween,
                        children: [
                          Text(_fmt(pos), key: const Key('player-position')),
                          Text(dur > Duration.zero ? _fmt(dur) : '--:--'),
                        ],
                      ),
                    ),
                    Row(
                      mainAxisAlignment: MainAxisAlignment.center,
                      children: [
                        IconButton(
                          iconSize: 34,
                          icon: const Icon(Icons.replay_30),
                          onPressed: () => player.skip(forward: false),
                        ),
                        IconButton(
                          key: const Key('player-playpause'),
                          iconSize: 52,
                          icon: Icon(
                              _playing ? Icons.pause_circle : Icons.play_circle),
                          onPressed: _togglePlay,
                        ),
                        IconButton(
                          iconSize: 34,
                          icon: const Icon(Icons.forward_30),
                          onPressed: () => player.skip(forward: true),
                        ),
                        TextButton(
                          key: const Key('player-speed'),
                          onPressed: _cycleSpeed,
                          child: Text('${_speed}x'),
                        ),
                      ],
                    ),
                  ],
                );
              },
            );
          },
        ),
      ),
    );
  }

  static const _speeds = [1.0, 1.25, 1.5, 2.0, 0.75];
  double _speed = 1.0;

  Future<void> _cycleSpeed() async {
    final next = _speeds[(_speeds.indexOf(_speed) + 1) % _speeds.length];
    await widget.runtime.player.setSpeed(next);
    if (mounted) setState(() => _speed = next);
  }
}
