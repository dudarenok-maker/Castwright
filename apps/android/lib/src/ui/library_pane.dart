import 'dart:io';

import 'package:flutter/material.dart';

import '../domain/home_shelf.dart';
import '../domain/library_tree.dart';
import '../domain/listen_progress.dart';

/// Single source of truth for which book the detail pane shows (app-21).
class ActiveBook extends ChangeNotifier {
  String? _bookId;
  String _title = '';
  String? get bookId => _bookId;
  String get title => _title;
  void select(String? id, {String title = ''}) {
    if (_bookId == id) return;
    _bookId = id;
    _title = title;
    notifyListeners();
  }
}

/// Library body: search field, "Continue listening" rail, grouped
/// author→series→book tree, and download/removal actions — extracted from
/// [LibraryHomeScreen] so it renders identically single-pane and inside the
/// two-pane [AdaptiveLibraryShell] `Row`. Purely presentational + callback
/// driven; the host owns all the data-loading state.
class LibraryPane extends StatelessWidget {
  const LibraryPane({
    super.key,
    required this.books,
    required this.continueBooks,
    required this.covers,
    required this.progress,
    required this.totalSec,
    required this.listened,
    required this.collapsedKeys,
    required this.query,
    required this.loading,
    required this.error,
    required this.currentBookId,
    required this.onQueryChanged,
    required this.onToggleCollapse,
    required this.onSelect,
    required this.onDownload,
    required this.onRemoveDownload,
    required this.onRemoveFromShelf,
  });

  final List<LibraryBook> books;
  final List<ShelfBook> continueBooks;
  final Map<String, String> covers;
  final Map<String, String> progress;
  final Map<String, double> totalSec;
  final Map<String, double> listened;
  final Set<String> collapsedKeys;
  final String query;
  final bool loading;
  final String? error;

  /// The currently-playing book, if any — guards "remove download" while
  /// that book is live.
  final String? currentBookId;

  final ValueChanged<String> onQueryChanged;
  final ValueChanged<String> onToggleCollapse;

  /// Book selection — routed through by all three selection paths (row tap,
  /// popup-menu "Play", and the Continue-listening shelf card).
  final void Function(String bookId, String title) onSelect;
  final Future<void> Function(LibraryBook book) onDownload;
  final Future<void> Function(LibraryBook book) onRemoveDownload;
  final Future<void> Function(ShelfBook book) onRemoveFromShelf;

  @override
  Widget build(BuildContext context) {
    final tree = buildLibraryTree(filterBooks(books, query));
    return Column(
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
            onChanged: onQueryChanged,
          ),
        ),
        if (loading)
          const Expanded(child: Center(child: CircularProgressIndicator()))
        else if (error != null)
          Expanded(
            child: Center(
              child: Padding(
                padding: const EdgeInsets.all(24),
                child: Text('Sync failed: $error', key: const Key('library-error')),
              ),
            ),
          )
        else
          Expanded(
            child: ListView(
              children: [
                if (continueBooks.isNotEmpty && query.isEmpty)
                  _continueRail(context),
                for (final author in tree) ..._authorSection(context, author),
              ],
            ),
          ),
      ],
    );
  }

  Widget _continueRail(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Padding(
          padding: const EdgeInsets.fromLTRB(16, 12, 16, 4),
          child: Text('Continue listening',
              style: Theme.of(context)
                  .textTheme
                  .titleMedium
                  ?.copyWith(fontWeight: FontWeight.bold)),
        ),
        SizedBox(
          height: 156,
          child: ListView(
            scrollDirection: Axis.horizontal,
            padding: const EdgeInsets.symmetric(horizontal: 8),
            children: [for (final b in continueBooks) _shelfCard(context, b)],
          ),
        ),
        const Divider(),
      ],
    );
  }

  Future<void> _confirmRemoveFromShelf(BuildContext context, ShelfBook b) async {
    final remove = await showModalBottomSheet<bool>(
      context: context,
      builder: (ctx) => SafeArea(
        child: ListTile(
          key: const Key('remove-from-shelf'),
          leading: const Icon(Icons.remove_circle_outline),
          title: const Text('Remove from Continue listening'),
          onTap: () => Navigator.of(ctx).pop(true),
        ),
      ),
    );
    if (remove != true) return;
    await onRemoveFromShelf(b);
  }

  Widget _shelfCard(BuildContext context, ShelfBook b) {
    final path = covers[b.bookId];
    return InkWell(
      key: Key('continue-${b.bookId}'),
      onTap: () => onSelect(b.bookId, b.title),
      onLongPress: () => _confirmRemoveFromShelf(context, b),
      child: SizedBox(
        width: 100,
        child: Padding(
          padding: const EdgeInsets.all(6),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              ClipRRect(
                borderRadius: BorderRadius.circular(6),
                child: SizedBox(
                  width: 88,
                  height: 112,
                  child: path != null
                      ? Image.file(File(path),
                          fit: BoxFit.cover,
                          errorBuilder: (_, _, _) => const Icon(Icons.menu_book))
                      : ColoredBox(
                          color: Theme.of(context).colorScheme.surfaceContainerHighest,
                          child: const Icon(Icons.menu_book)),
                ),
              ),
              const SizedBox(height: 4),
              Flexible(
                child: Text(b.title,
                    maxLines: 2,
                    overflow: TextOverflow.ellipsis,
                    style: Theme.of(context).textTheme.bodySmall),
              ),
            ],
          ),
        ),
      ),
    );
  }

  Widget _sectionHeader(
    BuildContext context, {
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

  List<Widget> _authorSection(BuildContext context, AuthorGroup author) {
    final aKey = 'author:${author.author}';
    final aCollapsed = collapsedKeys.contains(aKey);
    final bold = Theme.of(context)
        .textTheme
        .titleMedium
        ?.copyWith(fontWeight: FontWeight.bold);
    final bookCount =
        author.series.fold<int>(0, (n, s) => n + s.books.length);
    return [
      _sectionHeader(
        context,
        label: author.author,
        collapsed: aCollapsed,
        onTap: () => onToggleCollapse(aKey),
        indent: 12,
        style: bold,
        trailing: '$bookCount',
      ),
      const Divider(height: 1),
      if (!aCollapsed)
        for (final series in author.series)
          ..._seriesSection(context, author.author, series),
    ];
  }

  List<Widget> _seriesSection(
      BuildContext context, String author, SeriesGroup series) {
    if (series.series.isEmpty) {
      return [for (final book in series.books) _bookTile(context, book)];
    }
    final sKey = 'series:$author/${series.series}';
    final sCollapsed = collapsedKeys.contains(sKey);
    return [
      _sectionHeader(
        context,
        label: series.series,
        collapsed: sCollapsed,
        onTap: () => onToggleCollapse(sKey),
        indent: 28,
        style: Theme.of(context).textTheme.labelLarge,
        trailing: '${series.books.length}',
      ),
      if (!sCollapsed) for (final book in series.books) _bookTile(context, book),
    ];
  }

  Widget _bookTile(BuildContext context, LibraryBook book) {
    final downloading = progress.containsKey(book.bookId);
    return ListTile(
      key: Key('book-${book.bookId}'),
      leading: _cover(context, book.bookId),
      title: Text(book.title),
      subtitle: _subtitleWidget(context, book),
      isThreeLine: true,
      onTap: (book.downloadState == BookDownloadState.downloaded ||
              book.downloadState == BookDownloadState.updateAvailable)
          ? () => onSelect(book.bookId, book.title)
          : null,
      trailing: downloading
          ? _progressWidget(book.bookId)
          : _action(context, book),
    );
  }

  Widget _cover(BuildContext context, String bookId) {
    final path = covers[bookId];
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

  Widget _action(BuildContext context, LibraryBook book) {
    switch (book.downloadState) {
      case BookDownloadState.notDownloaded:
        return IconButton(
          key: Key('download-${book.bookId}'),
          icon: const Icon(Icons.download),
          tooltip: 'Download',
          onPressed: () => onDownload(book),
        );
      case BookDownloadState.updateAvailable:
      case BookDownloadState.downloaded:
        // Downloaded (tap row to play) — menu offers update/remove.
        return PopupMenuButton<String>(
          key: Key('book-menu-${book.bookId}'),
          onSelected: (v) {
            if (v == 'play') onSelect(book.bookId, book.title);
            if (v == 'update') onDownload(book);
            if (v == 'remove') _removeDownload(context, book);
          },
          itemBuilder: (_) => [
            const PopupMenuItem(value: 'play', child: Text('Play')),
            if (book.downloadState == BookDownloadState.updateAvailable)
              const PopupMenuItem(
                  value: 'update', child: Text('Update (re-sync)')),
            const PopupMenuItem(
                value: 'remove', child: Text('Remove download')),
          ],
        );
      case BookDownloadState.downloading:
        return _progressWidget(book.bookId);
    }
  }

  Future<void> _removeDownload(BuildContext context, LibraryBook book) async {
    if (currentBookId == book.bookId) {
      ScaffoldMessenger.of(context).showSnackBar(const SnackBar(
          content: Text('Stop playback before removing this book.')));
      return;
    }
    final ok = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('Remove download?'),
        content: Text(
            'Deletes the downloaded audio for "${book.title}". You can re-download it later.'),
        actions: [
          TextButton(
              onPressed: () => Navigator.pop(ctx, false),
              child: const Text('Cancel')),
          FilledButton(
              onPressed: () => Navigator.pop(ctx, true),
              child: const Text('Remove')),
        ],
      ),
    );
    if (ok != true) return;
    await onRemoveDownload(book);
  }

  Widget _progressWidget(String bookId) {
    final p = progress[bookId] ?? '…';
    return Row(mainAxisSize: MainAxisSize.min, children: [
      Text(p),
      const SizedBox(width: 8),
      const SizedBox(
          width: 18, height: 18, child: CircularProgressIndicator(strokeWidth: 2)),
    ]);
  }

  Widget _subtitleWidget(BuildContext context, LibraryBook book) {
    final pos = formatSeriesPosition(book.seriesPosition);
    final seriesLine = book.series.isEmpty
        ? null
        : '${book.series}${pos.isNotEmpty ? ' #$pos' : ''}';
    final total = totalSec[book.bookId];
    final status = _statusLabel(book.downloadState) +
        (total != null ? ' · ${formatDuration(total)}' : '');
    final bookListened = listened[book.bookId];
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        if (seriesLine != null) Text(seriesLine),
        Text(status),
        if (bookListened != null && bookListened > 0)
          Padding(
            padding: const EdgeInsets.only(top: 4, right: 12),
            child: LinearProgressIndicator(
              value: bookListened,
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
