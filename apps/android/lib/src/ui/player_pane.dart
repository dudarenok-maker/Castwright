import 'dart:async';
import 'dart:io';

import 'package:flutter/material.dart';

import '../data/companion_runtime.dart';
import '../data/player_controller.dart';
import '../domain/chapter_scroll.dart';
import '../domain/listen_progress.dart';
import '../domain/resume_reconcile.dart';
import '../domain/sync_manifest.dart';
import 'waveform_bar.dart';

/// Reusable player body: chapter list + cover header + transport, keyed by the
/// active book. Self-activates its book (idempotent) and loads per-book view
/// state in [initState]; shows an empty state when [runtime]/[bookId] is null
/// (two-pane, no selection yet). Callers pass `key: ValueKey(bookId)`.
class PlayerPane extends StatefulWidget {
  const PlayerPane({
    super.key,
    required this.runtime,
    required this.bookId,
    required this.title,
  });

  final CompanionRuntime? runtime;
  final String? bookId;
  final String title;

  @override
  State<PlayerPane> createState() => _PlayerPaneState();
}

class _PlayerPaneState extends State<PlayerPane> {
  bool _ready = false;
  bool _playing = false;
  String? _error;
  String? _coverArtPath;
  List<SyncManifestChapter> _chapters = const [];
  Set<String> _finished = {};
  final List<StreamSubscription<Object?>> _subs = [];
  final Map<String, List<double>> _peaks = {}; // chapter uuid -> RMS peaks
  final ScrollController _scroll = ScrollController();
  static const double _kRowHeight = 72;

  /// Fetch + cache a chapter's waveform peaks. Local-first (survives offline +
  /// screen recreation + restart); falls back to a live fetch (and persists)
  /// only when nothing is cached locally.
  Future<void> _ensurePeaks(String uuid, int chapterId) async {
    if (_peaks.containsKey(uuid)) return;
    final rt = widget.runtime;
    if (rt == null || widget.bookId == null) return;
    final peaks = await rt.sync.peaksFor(widget.bookId!, uuid, chapterId);
    if (peaks.isNotEmpty && mounted) setState(() => _peaks[uuid] = peaks);
  }

  void _ensureCurrentPeaks() {
    final uuid = widget.runtime?.player.currentChapterUuid;
    if (uuid == null) return;
    final ch = _chapters.where((c) => c.uuid == uuid);
    if (ch.isNotEmpty) _ensurePeaks(uuid, ch.first.id);
  }

  void _scrollToCurrent({required bool animate}) {
    if (!_scroll.hasClients) return;
    final uuid = widget.runtime?.player.currentChapterUuid;
    if (uuid == null) return;
    final i = _chapters.indexWhere((c) => c.uuid == uuid);
    if (i < 0) return;
    final target = chapterScrollOffset(
      index: i,
      rowHeight: _kRowHeight,
      maxExtent: _scroll.position.maxScrollExtent,
    );
    if (animate) {
      _scroll.animateTo(target,
          duration: const Duration(milliseconds: 300), curve: Curves.easeOut);
    } else {
      _scroll.jumpTo(target);
    }
  }

  // DELTA 1 — null/empty-state guard at initState: no load when there's no
  // active book yet (two-pane, before any selection).
  @override
  void initState() {
    super.initState();
    if (widget.runtime == null || widget.bookId == null) return; // empty state; no load
    _prepare();
  }

  Future<void> _prepare() async {
    try {
      final rt = widget.runtime!;
      final bookId = widget.bookId!;
      // DELTA 2 — self-activate (idempotent) so a directly-constructed pane
      // (compact host, or a widget test) still opens its book; activateBook
      // owns ensureDetail/pull-resume/markPlayed/openBook-or-switchBook.
      if (rt.player.currentBookId != bookId) {
        await rt.activateBook(bookId, title: widget.title);
      }
      // ensureDetail is idempotent and the view load needs it regardless of
      // whether activateBook already ran it above.
      await rt.sync.ensureDetail(bookId);
      final chapters = rt.sync.chaptersOf(bookId);
      final finished = await rt.library.finishedChapterUuids(bookId);
      final art = await rt.library.coverThumbPath(bookId);
      if (mounted) {
        setState(() {
          _chapters = chapters;
          _finished = finished;
          _ready = true;
          _coverArtPath = art;
          _playing = rt.player.playing; // seed from real state
          _speed = rt.player.speed; // DELTA 3 — seed from the engine
        });
        _ensureCurrentPeaks();
        WidgetsBinding.instance.addPostFrameCallback((_) {
          _scrollToCurrent(animate: false);
        });
      }
      // If the pane was disposed during the awaits above (e.g. a fast two-pane
      // book switch re-keys and tears this pane down mid-_prepare), bail before
      // subscribing — otherwise these subs land on a disposed state's _subs list
      // that dispose() already drained, and leak until the runtime streams close.
      if (!mounted) return;
      // Track the real engine playing state so the transport reflects out-of-band
      // stops (headset/Android Auto disconnect, audio-focus loss) — not a local
      // flag that only flips on tap (which caused the "tap twice to restart" bug).
      _subs.add(rt.player.playingStream.listen((playing) {
        if (mounted) setState(() => _playing = playing);
      }));
      // Move the highlight + progress as chapters change (incl. auto-advance).
      _subs.add(rt.player.nowPlayingStream.listen((_) {
        if (mounted) {
          setState(() {});
          _scrollToCurrent(animate: true);
        }
      }));
      // Tick a chapter to "done" the moment it finishes, no reopen needed.
      _subs.add(rt.player.chapterCompletedStream.listen((uuid) {
        if (mounted) setState(() => _finished = {..._finished, uuid});
      }));
    } catch (e) {
      if (mounted) setState(() => _error = '$e');
    }
  }

  @override
  void dispose() {
    for (final s in _subs) {
      s.cancel();
    }
    _scroll.dispose();
    // DELTA 4 — the pane no longer owns book lifecycle (activateBook/the
    // two-pane shell does), but keep the local save + best-effort push
    // (idempotent) so a compact-host pop still flushes resume promptly.
    final rt = widget.runtime;
    if (rt != null) {
      // Only pause if THIS pane's book is still the engine's active book. On a
      // two-pane switch, activateBook has already loaded the NEXT book before
      // this pane disposes, so an unguarded pause() would hit the just-selected
      // book. (Benign today — openBook doesn't auto-play — but guarded so it
      // stays correct if that ever changes.) The resume push still targets THIS
      // pane's outgoing book, whose position switchBook already saved locally.
      final flush = rt.player.currentBookId == widget.bookId
          ? rt.player.pause()
          : Future<void>.value();
      flush
          .then((_) => rt.resumeSync.syncBook(widget.bookId!))
          .catchError((_) => ResumeAction.noop);
    }
    super.dispose();
  }

  Future<void> _playChapter(String uuid) async {
    await widget.runtime!.player.playChapter(uuid);
    // _playing follows playingStream; no optimistic flip.
    _ensureCurrentPeaks();
  }

  Future<void> _togglePlay() async {
    final p = widget.runtime!.player;
    // Decide off the real engine state, not a local flag that can be stale after
    // an out-of-band stop — otherwise the first tap is a silent no-op.
    if (p.playing) {
      await p.pause();
    } else {
      await p.play();
    }
    // _playing updates via playingStream.
  }

  bool _isFinished(String uuid) => _finished.contains(uuid);

  /// `Ch. <id> · <title>` for the loaded chapter, or empty when none.
  String _currentChapterLabel(PlayerController player) {
    final uuid = player.currentChapterUuid;
    if (uuid == null) return '';
    final match = _chapters.where((c) => c.uuid == uuid);
    if (match.isEmpty) return '';
    final c = match.first;
    final title = c.title.isEmpty ? 'Chapter ${c.id}' : c.title;
    return 'Ch. ${c.id} · $title';
  }

  String _fmt(Duration d) {
    final h = d.inHours;
    final m = d.inMinutes.remainder(60).toString().padLeft(2, '0');
    final s = d.inSeconds.remainder(60).toString().padLeft(2, '0');
    return h > 0 ? '$h:$m:$s' : '$m:$s';
  }

  // DELTA 1 — null/empty-state guard at build.
  @override
  Widget build(BuildContext context) {
    if (widget.bookId == null || widget.runtime == null) {
      return const Center(child: Text('Select a book to start listening'));
    }
    final player = widget.runtime!.player;
    if (_error != null) {
      return Center(
        child: Padding(
          padding: const EdgeInsets.all(24),
          child: Text('Playback error: $_error', key: const Key('player-error')),
        ),
      );
    }
    if (!_ready) {
      return const Center(child: CircularProgressIndicator());
    }
    return Column(
      children: [
        if (_coverArtPath != null) _coverHeader(),
        Expanded(
          child: ListView.builder(
            controller: _scroll,
            itemCount: _chapters.length,
            itemBuilder: (_, i) {
              final c = _chapters[i];
              final current = c.uuid == player.currentChapterUuid;
              final finished = _isFinished(c.uuid);
              return Column(
                mainAxisSize: MainAxisSize.min,
                children: [
                  ListTile(
                    key: Key('chapter-${c.uuid}'),
                    leading: CircleAvatar(child: Text('${c.id}')),
                    title: Text(
                      c.title.isEmpty ? 'Chapter ${c.id}' : c.title,
                      style: finished && !current
                          ? TextStyle(
                              color: Theme.of(context)
                                  .colorScheme
                                  .onSurfaceVariant)
                          : null,
                    ),
                    subtitle: c.durationSec != null
                        ? Text(formatDuration(c.durationSec))
                        : null,
                    trailing: current
                        ? Icon(_playing ? Icons.volume_up : Icons.pause,
                            color: Theme.of(context).colorScheme.primary)
                        : (finished
                            ? Icon(Icons.check_circle,
                                color:
                                    Theme.of(context).colorScheme.primary)
                            : null),
                    selected: current,
                    onTap: c.hasAudio ? () => _playChapter(c.uuid) : null,
                    enabled: c.hasAudio,
                  ),
                  if (current) _currentProgressBar(c),
                ],
              );
            },
          ),
        ),
        const Divider(height: 1),
        _transport(player),
      ],
    );
  }

  /// Cover art + book title above the chapter list, so the player reads as
  /// "now playing this book" rather than a bare chapter picker.
  Widget _coverHeader() {
    return Padding(
      padding: const EdgeInsets.fromLTRB(16, 12, 16, 4),
      child: Row(
        children: [
          ClipRRect(
            borderRadius: BorderRadius.circular(8),
            child: SizedBox(
              width: 64,
              height: 64,
              child: Image.file(File(_coverArtPath!),
                  fit: BoxFit.cover,
                  errorBuilder: (_, _, _) => const Icon(Icons.menu_book)),
            ),
          ),
          const SizedBox(width: 12),
          Expanded(
            child: Text(
              widget.title,
              maxLines: 2,
              overflow: TextOverflow.ellipsis,
              style: Theme.of(context).textTheme.titleMedium,
            ),
          ),
        ],
      ),
    );
  }

  /// A 2px progress bar under the current chapter row, position / duration.
  Widget _currentProgressBar(SyncManifestChapter c) {
    final durMs = (c.durationSec ?? 0) * 1000;
    if (durMs <= 0) return const SizedBox.shrink();
    return StreamBuilder<Duration>(
      stream: widget.runtime!.player.positionStream,
      builder: (_, snap) {
        final posMs = (snap.data ?? Duration.zero).inMilliseconds.toDouble();
        final value = (posMs / durMs).clamp(0.0, 1.0);
        return LinearProgressIndicator(
          minHeight: 2,
          value: value,
          key: Key('progress-${c.uuid}'),
        );
      },
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
                    Padding(
                      padding: const EdgeInsets.fromLTRB(16, 2, 16, 4),
                      child: Align(
                        alignment: Alignment.centerLeft,
                        child: InkWell(
                          onTap: () => _scrollToCurrent(animate: true),
                          child: Text(
                            _currentChapterLabel(player),
                            key: const Key('player-current-chapter'),
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                            style: Theme.of(context).textTheme.titleSmall,
                          ),
                        ),
                      ),
                    ),
                    Builder(builder: (context) {
                      final uuid = player.currentChapterUuid;
                      final peaks = uuid != null ? _peaks[uuid] : null;
                      final progress = maxMs > 0
                          ? pos.inMilliseconds / maxMs
                          : 0.0;
                      if (peaks != null && peaks.isNotEmpty) {
                        return Padding(
                          padding: const EdgeInsets.symmetric(horizontal: 12),
                          child: WaveformBar(
                            peaks: peaks,
                            progress: progress,
                            onSeek: maxMs > 0
                                ? (f) => player.seekTo(
                                    Duration(milliseconds: (f * maxMs).round()))
                                : null,
                          ),
                        );
                      }
                      return Slider(
                        key: const Key('player-progress'),
                        value: v,
                        max: maxMs > 0 ? maxMs.toDouble() : 1.0,
                        onChanged: maxMs > 0
                            ? (x) => player
                                .seekTo(Duration(milliseconds: x.round()))
                            : null,
                      );
                    }),
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
                        IconButton(
                          key: const Key('player-boost'),
                          tooltip: 'Volume boost',
                          icon: Icon(widget.runtime!.settings.volumeBoostDb > 0
                              ? Icons.volume_up
                              : Icons.volume_up_outlined),
                          onPressed: _openBoostSheet,
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

  /// Quick volume-boost slider; writes through the runtime so it persists and
  /// stays in sync with the settings screen.
  void _openBoostSheet() {
    final rt = widget.runtime!;
    showModalBottomSheet<void>(
      context: context,
      builder: (_) {
        var boost = rt.settings.volumeBoostDb;
        return StatefulBuilder(
          builder: (ctx, setSheet) => Padding(
            padding: const EdgeInsets.all(20),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                Text('Volume boost  +${boost.toStringAsFixed(0)} dB',
                    style: Theme.of(ctx).textTheme.titleMedium),
                Slider(
                  value: boost,
                  min: 0,
                  max: 12,
                  divisions: 12,
                  label: '+${boost.toStringAsFixed(0)} dB',
                  onChanged: (v) => setSheet(() => boost = v),
                  onChangeEnd: (v) =>
                      rt.updateSettings(rt.settings.copyWith(volumeBoostDb: v)),
                ),
              ],
            ),
          ),
        );
      },
    ).then((_) => mounted ? setState(() {}) : null); // refresh the boost icon
  }

  Future<void> _cycleSpeed() async {
    final next = _speeds[(_speeds.indexOf(_speed) + 1) % _speeds.length];
    await widget.runtime!.player.setSpeed(next);
    if (mounted) setState(() => _speed = next);
  }
}
