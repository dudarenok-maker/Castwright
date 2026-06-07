import 'dart:io';

import 'package:flutter/material.dart';

import '../data/companion_runtime.dart';
import '../domain/library_tree.dart';
import '../domain/listen_progress.dart';
import 'player_screen.dart';

/// Post-pairing home: a cover-art library grouped into author → series
/// sections, with a search/filter, per-book download (with progress) +
/// update-available badge, and tap-to-open the player.
class LibraryHomeScreen extends StatefulWidget {
  const LibraryHomeScreen({
    super.key,
    required this.runtime,
    required this.serverLabel,
    required this.onUnpair,
  });

  final CompanionRuntime runtime;
  final String serverLabel;
  final Future<void> Function() onUnpair;

  @override
  State<LibraryHomeScreen> createState() => _LibraryHomeScreenState();
}

class _LibraryHomeScreenState extends State<LibraryHomeScreen> {
  List<LibraryBook> _books = [];
  final Map<String, String> _covers = {}; // bookId -> thumb path
  final Map<String, String> _progress = {}; // bookId -> "done/total"
  final Map<String, double> _totalSec = {}; // bookId -> total duration (s)
  final Map<String, double> _listened = {}; // bookId -> listened fraction (0..1)
  final Set<String> _collapsed = {}; // collapsed author/series section keys
  String _query = '';
  bool _loading = true;
  String? _error;

  @override
  void initState() {
    super.initState();
    _refresh();
  }

  Future<void> _refresh() async {
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final books = await widget.runtime.sync.loadLibrary();
      if (!mounted) return;
      setState(() {
        _books = books;
        _loading = false;
      });
      _loadCovers(books);
      _loadDurations(books);
    } catch (e) {
      if (mounted) {
        setState(() {
          _error = '$e';
          _loading = false;
        });
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
    try {
      await widget.runtime.sync.downloadBook(
        book.bookId,
        onProgress: (d, t) =>
            setState(() => _progress[book.bookId] = t > 0 ? '$d/$t' : '…'),
      );
      if (mounted) setState(() => _progress.remove(book.bookId));
      await _refresh();
    } catch (e) {
      if (mounted) {
        setState(() => _progress.remove(book.bookId));
        ScaffoldMessenger.of(context)
            .showSnackBar(SnackBar(content: Text('Download failed: $e')));
      }
    }
  }

  void _open(LibraryBook book) {
    Navigator.of(context).push(MaterialPageRoute(
      builder: (_) => PlayerScreen(
          runtime: widget.runtime, bookId: book.bookId, title: book.title),
    ));
  }

  @override
  Widget build(BuildContext context) {
    final tree = buildLibraryTree(filterBooks(_books, _query));
    return Scaffold(
      appBar: AppBar(
        title: const Text('Library'),
        actions: [
          IconButton(
            key: const Key('library-sync'),
            tooltip: 'Sync',
            icon: const Icon(Icons.sync),
            onPressed: _loading ? null : _refresh,
          ),
          IconButton(
            tooltip: 'Unpair',
            icon: const Icon(Icons.link_off),
            onPressed: () async => widget.onUnpair(),
          ),
        ],
      ),
      body: Column(
        children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(12, 8, 12, 4),
            child: TextField(
              key: const Key('library-search'),
              decoration: const InputDecoration(
                prefixIcon: Icon(Icons.search),
                hintText: 'Filter by author, series or title',
                isDense: true,
                border: OutlineInputBorder(),
              ),
              onChanged: (v) => setState(() => _query = v),
            ),
          ),
          if (_loading)
            const Expanded(child: Center(child: CircularProgressIndicator()))
          else if (_error != null)
            Expanded(
              child: Center(
                child: Padding(
                  padding: const EdgeInsets.all(24),
                  child: Text('Sync failed: $_error', key: const Key('library-error')),
                ),
              ),
            )
          else
            Expanded(
              child: ListView(
                children: [
                  for (final author in tree) ..._authorSection(author),
                ],
              ),
            ),
        ],
      ),
    );
  }

  void _toggle(String key) => setState(
      () => _collapsed.contains(key) ? _collapsed.remove(key) : _collapsed.add(key));

  Widget _sectionHeader({
    required String label,
    required bool collapsed,
    required VoidCallback onTap,
    required double indent,
    TextStyle? style,
    String? trailing,
  }) {
    return InkWell(
      onTap: onTap,
      child: Padding(
        padding: EdgeInsets.fromLTRB(indent, 10, 12, 6),
        child: Row(
          children: [
            Icon(collapsed ? Icons.add_box_outlined : Icons.indeterminate_check_box_outlined,
                size: 22),
            const SizedBox(width: 8),
            Expanded(child: Text(label, style: style)),
            if (trailing != null)
              Text(trailing, style: Theme.of(context).textTheme.bodySmall),
          ],
        ),
      ),
    );
  }

  List<Widget> _authorSection(AuthorGroup author) {
    final aKey = 'author:${author.author}';
    final aCollapsed = _collapsed.contains(aKey);
    final bold = Theme.of(context)
        .textTheme
        .titleMedium
        ?.copyWith(fontWeight: FontWeight.bold);
    final bookCount =
        author.series.fold<int>(0, (n, s) => n + s.books.length);
    return [
      _sectionHeader(
        label: author.author,
        collapsed: aCollapsed,
        onTap: () => _toggle(aKey),
        indent: 12,
        style: bold,
        trailing: '$bookCount',
      ),
      const Divider(height: 1),
      if (!aCollapsed)
        for (final series in author.series)
          ..._seriesSection(author.author, series),
    ];
  }

  List<Widget> _seriesSection(String author, SeriesGroup series) {
    if (series.series.isEmpty) {
      return [for (final book in series.books) _bookTile(book)];
    }
    final sKey = 'series:$author/${series.series}';
    final sCollapsed = _collapsed.contains(sKey);
    return [
      _sectionHeader(
        label: series.series,
        collapsed: sCollapsed,
        onTap: () => _toggle(sKey),
        indent: 28,
        style: Theme.of(context).textTheme.labelLarge,
        trailing: '${series.books.length}',
      ),
      if (!sCollapsed) for (final book in series.books) _bookTile(book),
    ];
  }

  Widget _bookTile(LibraryBook book) {
    final downloading = _progress.containsKey(book.bookId);
    return ListTile(
      key: Key('book-${book.bookId}'),
      leading: _cover(book.bookId),
      title: Text(book.title),
      subtitle: _subtitleWidget(book),
      isThreeLine: true,
      onTap: (book.downloadState == BookDownloadState.downloaded ||
              book.downloadState == BookDownloadState.updateAvailable)
          ? () => _open(book)
          : null,
      trailing: downloading
          ? _progressWidget(book.bookId)
          : _action(book),
    );
  }

  Widget _cover(String bookId) {
    final path = _covers[bookId];
    final child = path != null
        ? Image.file(File(path), fit: BoxFit.cover,
            errorBuilder: (_, _, _) => const Icon(Icons.menu_book))
        : const Icon(Icons.menu_book);
    return SizedBox(
      width: 44,
      height: 60,
      child: ClipRRect(borderRadius: BorderRadius.circular(4), child: child),
    );
  }

  Widget _action(LibraryBook book) {
    switch (book.downloadState) {
      case BookDownloadState.notDownloaded:
        return IconButton(
          key: Key('download-${book.bookId}'),
          icon: const Icon(Icons.download),
          tooltip: 'Download',
          onPressed: () => _download(book),
        );
      case BookDownloadState.updateAvailable:
        return IconButton(
          key: Key('update-${book.bookId}'),
          icon: const Icon(Icons.sync_problem),
          color: Theme.of(context).colorScheme.tertiary,
          tooltip: 'Update available — re-sync',
          onPressed: () => _download(book),
        );
      case BookDownloadState.downloaded:
        return IconButton(
          icon: const Icon(Icons.play_circle_outline),
          tooltip: 'Play',
          onPressed: () => _open(book),
        );
      case BookDownloadState.downloading:
        return _progressWidget(book.bookId);
    }
  }

  Widget _progressWidget(String bookId) {
    final p = _progress[bookId] ?? '…';
    return Row(mainAxisSize: MainAxisSize.min, children: [
      Text(p),
      const SizedBox(width: 8),
      const SizedBox(
          width: 18, height: 18, child: CircularProgressIndicator(strokeWidth: 2)),
    ]);
  }

  Widget _subtitleWidget(LibraryBook book) {
    final pos = formatSeriesPosition(book.seriesPosition);
    final seriesLine = book.series.isEmpty
        ? null
        : '${book.series}${pos.isNotEmpty ? ' #$pos' : ''}';
    final total = _totalSec[book.bookId];
    final status = _statusLabel(book.downloadState) +
        (total != null ? ' · ${formatDuration(total)}' : '');
    final listened = _listened[book.bookId];
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        if (seriesLine != null) Text(seriesLine),
        Text(status),
        if (listened != null && listened > 0)
          Padding(
            padding: const EdgeInsets.only(top: 4, right: 12),
            child: LinearProgressIndicator(
              value: listened,
              minHeight: 4,
              backgroundColor: Theme.of(context).colorScheme.surfaceContainerHighest,
            ),
          ),
      ],
    );
  }

  String _statusLabel(BookDownloadState s) {
    switch (s) {
      case BookDownloadState.notDownloaded:
        return 'Not downloaded';
      case BookDownloadState.downloading:
        return 'Downloading…';
      case BookDownloadState.downloaded:
        return 'Downloaded · tap to listen';
      case BookDownloadState.updateAvailable:
        return 'Update available since last sync';
    }
  }
}
