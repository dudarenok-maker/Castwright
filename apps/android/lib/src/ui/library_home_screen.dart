import 'package:flutter/material.dart';

import '../data/companion_runtime.dart';
import '../domain/home_shelf.dart';
import '../domain/library_load.dart';
import '../domain/library_tree.dart';
import '../domain/listen_progress.dart';
import '../domain/paired_server.dart';
import '../domain/window_size.dart';
import 'adaptive_library_shell.dart';
import 'app_settings_screen.dart';
import 'library_pane.dart';
import 'player_screen.dart';

/// Post-pairing home: a cover-art library grouped into author → series
/// sections, with a search/filter, per-book download (with progress) +
/// update-available badge, and tap-to-open the player.
class LibraryHomeScreen extends StatefulWidget {
  const LibraryHomeScreen({
    super.key,
    required this.runtime,
    required this.server,
    required this.onUnpair,
    this.demoMode = false,
  });

  final CompanionRuntime runtime;
  final PairedServer server;
  final Future<void> Function() onUnpair;
  final bool demoMode;

  @override
  State<LibraryHomeScreen> createState() => _LibraryHomeScreenState();
}

class _LibraryHomeScreenState extends State<LibraryHomeScreen> {
  List<LibraryBook> _books = [];
  List<ShelfBook> _continue = []; // app-14: in-progress, most-recent first
  final Map<String, String> _covers = {}; // bookId -> thumb path
  final Map<String, String> _progress = {}; // bookId -> "done/total"
  final Map<String, double> _totalSec = {}; // bookId -> total duration (s)
  final Map<String, double> _listened = {}; // bookId -> listened fraction (0..1)
  final Set<String> _collapsed = {}; // collapsed author/series section keys
  String _query = '';
  bool _loading = true;
  bool _offline = false;
  bool _connecting = false; // background server probe in flight
  String? _error;

  /// Single source of truth for which book the detail pane shows (app-21).
  final ActiveBook _activeBook = ActiveBook();

  @override
  void initState() {
    super.initState();
    _refresh();
  }

  @override
  void dispose() {
    _activeBook.dispose();
    super.dispose();
  }

  /// Local-first: paint the downloaded library immediately, then reconcile with
  /// the server in the background. A connection failure never blocks the user —
  /// they stay on the local library with an "Offline" retry chip. The state
  /// machine lives in [loadLibraryLocalFirst] so its ordering is unit-tested.
  Future<void> _refresh() async {
    setState(() => _error = null);
    // app-14: continue-listening rail from local lastPlayedAt (always local).
    // FIX 4: pass finished: here too so an already-finished book does not flash
    // on the shelf during the brief window before the post-pull re-query.
    // FIX 5: one-shot guard so the post-pull re-query runs at most once per _refresh.
    var postPullRequeried = false;
    final shelf = buildContinueListening([
      for (final s in await widget.runtime.library.listBooks())
        ShelfBook(
          bookId: s.bookId,
          title: s.title,
          author: s.author,
          lastPlayedAt: s.lastPlayedAt,
          updatedAt: '',
          hidden: s.hidden,
          finished: s.finished,
        ),
    ]);
    await for (final s in loadLibraryLocalFirst(
      loadLocal: widget.runtime.sync.loadLocalLibrary,
      loadServer: widget.runtime.sync.loadLibrary,
    )) {
      if (!mounted) return;
      setState(() {
        _books = s.books;
        _continue = shelf;
        _offline = s.offline;
        _connecting = s.connecting;
        _loading = s.loading;
        _error = s.error;
      });
      _loadCovers(s.books);
      _loadDurations(s.books);

      // After the pull completes, re-query Drift so that any finished/hidden
      // state persisted by loadIndex→setBookSyncState is reflected in the
      // shelf. The stream payload only carries the library grid, not the shelf
      // rows, so we must re-read listBooks() once the loading phase is done.
      // FIX 5: _postPullRequeried guards against running this block more than
      // once per _refresh — the stream can emit multiple non-loading ticks when
      // a local library exists (local + server ticks both have loading:false).
      if (!s.loading && !postPullRequeried && mounted) {
        postPullRequeried = true;
        final updated = buildContinueListening([
          for (final b in await widget.runtime.library.listBooks())
            ShelfBook(
              bookId: b.bookId,
              title: b.title,
              author: b.author,
              lastPlayedAt: b.lastPlayedAt,
              updatedAt: '',
              hidden: b.hidden,
              finished: b.finished,
            ),
        ]);
        if (mounted) setState(() => _continue = updated);
      }
    }
  }

  Future<void> _loadCovers(List<LibraryBook> books) async {
    for (final b in books) {
      if (_covers.containsKey(b.bookId)) continue;
      try {
        final path = await widget.runtime.thumbnails.ensureThumbnail(b.bookId);
        if (mounted) setState(() => _covers[b.bookId] = path);
      } catch (_) {
        /* no cover — show a placeholder */
      }
    }
  }

  /// Fetch each book's detail (cheap JSON, like covers) to show total
  /// duration; for downloaded books, compute the listener-progress fraction
  /// from the stored resume point.
  Future<void> _loadDurations(List<LibraryBook> books) async {
    for (final b in books) {
      try {
        await widget.runtime.sync.ensureDetail(b.bookId);
        final chs = widget.runtime.sync.chaptersOf(b.bookId);
        final durations = [for (final c in chs) c.durationSec];
        final total = durations.fold<double>(0, (s, d) => s + (d ?? 0));
        if (total <= 0) continue;
        double? fraction;
        if (b.downloadState == BookDownloadState.downloaded ||
            b.downloadState == BookDownloadState.updateAvailable) {
          final pb = await widget.runtime.library.loadPlayback(b.bookId);
          if (pb != null) {
            final idx = chs.indexWhere((c) => c.uuid == pb.chapterUuid);
            fraction = listenedFraction(
              durations: durations,
              resumeIndex: idx < 0 ? 0 : idx,
              resumePositionSec: pb.positionMs / 1000.0,
            );
          }
        }
        if (mounted) {
          setState(() {
            _totalSec[b.bookId] = total;
            if (fraction != null) _listened[b.bookId] = fraction;
          });
        }
      } catch (_) {
        /* detail unavailable (older server without durationSec, or offline) */
      }
    }
  }

  Future<void> _download(LibraryBook book) async {
    setState(() => _progress[book.bookId] = '…');
    // app-3: run under a foreground service so the OS doesn't kill a long
    // download when the app is backgrounded.
    await widget.runtime.foreground
        .start('Downloading', book.title)
        .catchError((_) {});
    try {
      await widget.runtime.sync.downloadBook(
        book.bookId,
        onProgress: (d, t) {
          setState(() => _progress[book.bookId] = t > 0 ? '$d/$t' : '…');
          if (t > 0) {
            widget.runtime.foreground
                .update('${book.title} — $d/$t')
                .catchError((_) {});
          }
        },
      );
      if (mounted) setState(() => _progress.remove(book.bookId));
      await widget.runtime.enforceStorageCap(); // app-4: keep under the cap
      await _refresh();
    } catch (e) {
      if (mounted) {
        setState(() => _progress.remove(book.bookId));
        ScaffoldMessenger.of(context)
            .showSnackBar(SnackBar(content: Text('Download failed: $e')));
      }
    } finally {
      await widget.runtime.foreground.stop().catchError((_) {});
    }
  }

  /// Layout-aware selection (app-21). The freshly-keyed [PlayerPane] self-activates
  /// its book (engine + persistence + reconcile) in its own `initState`, so selection
  /// here only updates [ActiveBook] and, in single-pane/medium, pushes [PlayerScreen].
  /// Not gating on `activateBook` means the two-pane detail pane appears immediately
  /// (with its loading spinner) instead of after a possibly-slow server reconcile.
  void _onSelect(String bookId, String title) {
    _activeBook.select(bookId, title: title);
    final twoPane = libraryLayoutFor(
            windowSizeClassFor(MediaQuery.of(context).size.width)) ==
        LibraryLayout.twoPane;
    if (!twoPane) {
      Navigator.of(context)
          .push(MaterialPageRoute(
            builder: (_) => PlayerScreen(
                runtime: widget.runtime, bookId: bookId, title: title),
          ))
          .then((_) {
        // Returning from the player: the book was just played (markPlayed), so
        // refresh to surface it in the "Continue listening" rail + update progress.
        // (Two-pane has no such return moment; its rail self-heals on next sync.)
        if (mounted) _refresh();
      });
    }
  }

  Future<void> _handleRemoveFromShelf(ShelfBook b) async {
    await widget.runtime.library.setBookHidden(b.bookId, true);
    widget.runtime.api.setShelfStatus(b.bookId, hidden: true).catchError((_) {});
    if (mounted) await _refresh();
  }

  Future<void> _handleRemoveDownload(LibraryBook book) async {
    await widget.runtime.library.evictBook(book.bookId);
    await _refresh();
    if (mounted) {
      ScaffoldMessenger.of(context)
          .showSnackBar(SnackBar(content: Text('Removed "${book.title}".')));
    }
  }

  void _toggle(String key) => setState(
      () => _collapsed.contains(key) ? _collapsed.remove(key) : _collapsed.add(key));

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const Text('Library'),
        actions: [
          if (widget.demoMode)
            const Padding(
              padding: EdgeInsets.symmetric(vertical: 8, horizontal: 4),
              child: Chip(
                key: Key('demo-badge'),
                label: Text('Demo'),
                visualDensity: VisualDensity.compact,
              ),
            ),
          if (_offline)
            Padding(
              padding: const EdgeInsets.symmetric(vertical: 8, horizontal: 4),
              child: ActionChip(
                key: const Key('offline-chip'),
                avatar: Icon(Icons.cloud_off,
                    size: 18, color: Theme.of(context).colorScheme.onErrorContainer),
                label: const Text('Offline'),
                backgroundColor: Theme.of(context).colorScheme.errorContainer,
                labelStyle: TextStyle(
                    color: Theme.of(context).colorScheme.onErrorContainer),
                onPressed: _refresh, // tap to retry
              ),
            )
          else
            IconButton(
              key: const Key('library-sync'),
              tooltip: _connecting ? 'Connecting…' : 'Sync',
              icon: const Icon(Icons.sync),
              onPressed: (_loading || _connecting) ? null : _refresh,
            ),
          IconButton(
            key: const Key('open-settings'),
            tooltip: 'Settings',
            icon: const Icon(Icons.settings_outlined),
            onPressed: () => Navigator.of(context).push(MaterialPageRoute(
              builder: (_) => AppSettingsScreen(
                runtime: widget.runtime,
                server: widget.server,
                onUnpair: widget.onUnpair,
                onLibraryCleared: _refresh,
                demoMode: widget.demoMode,
              ),
            )),
          ),
        ],
      ),
      body: AdaptiveLibraryShell(
        runtime: widget.runtime,
        activeBook: _activeBook,
        libraryPane: LibraryPane(
          books: _books,
          continueBooks: _continue,
          covers: _covers,
          progress: _progress,
          totalSec: _totalSec,
          listened: _listened,
          collapsedKeys: _collapsed,
          query: _query,
          loading: _loading,
          error: _error,
          currentBookId: widget.runtime.player.currentBookId,
          onQueryChanged: (v) => setState(() => _query = v),
          onToggleCollapse: _toggle,
          onSelect: (bookId, title) => _onSelect(bookId, title),
          onDownload: _download,
          onRemoveDownload: _handleRemoveDownload,
          onRemoveFromShelf: _handleRemoveFromShelf,
        ),
      ),
    );
  }
}
