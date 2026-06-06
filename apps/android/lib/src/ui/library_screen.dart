import 'package:flutter/material.dart';

import '../domain/library_tree.dart';

/// Hierarchical library browse (`app-7`): author → series → book, with search
/// and per-book download/remove. Presentational — driven by [books] + callbacks
/// so it widget-tests without the store; the host wires it to the drift library.
class LibraryScreen extends StatefulWidget {
  const LibraryScreen({
    super.key,
    required this.books,
    required this.onOpen,
    required this.onDownload,
    required this.onRemove,
  });

  final List<LibraryBook> books;
  final void Function(String bookId) onOpen;
  final void Function(String bookId) onDownload;
  final void Function(String bookId) onRemove;

  @override
  State<LibraryScreen> createState() => _LibraryScreenState();
}

class _LibraryScreenState extends State<LibraryScreen> {
  String _query = '';

  @override
  Widget build(BuildContext context) {
    final tree = buildLibraryTree(filterBooks(widget.books, _query));
    return Scaffold(
      appBar: AppBar(title: const Text('Library')),
      body: Column(
        children: [
          Padding(
            padding: const EdgeInsets.all(12),
            child: TextField(
              key: const Key('library-search'),
              decoration: const InputDecoration(
                prefixIcon: Icon(Icons.search),
                hintText: 'Search title or author',
                border: OutlineInputBorder(),
              ),
              onChanged: (v) => setState(() => _query = v),
            ),
          ),
          Expanded(
            child: ListView(
              children: [
                for (final author in tree)
                  ExpansionTile(
                    title: Text(author.author),
                    initiallyExpanded: true,
                    children: [
                      for (final series in author.series)
                        ...series.series.isEmpty
                            ? series.books.map(_bookTile)
                            : [
                                ExpansionTile(
                                  title: Text(series.series),
                                  initiallyExpanded: true,
                                  children: series.books.map(_bookTile).toList(),
                                ),
                              ],
                    ],
                  ),
              ],
            ),
          ),
        ],
      ),
    );
  }

  Widget _bookTile(LibraryBook b) {
    return ListTile(
      key: Key('book-${b.bookId}'),
      title: Text(b.title),
      subtitle: Text(_pillLabel(b.downloadState)),
      onTap: () => widget.onOpen(b.bookId),
      trailing: _trailing(b),
    );
  }

  Widget _trailing(LibraryBook b) {
    switch (b.downloadState) {
      case BookDownloadState.notDownloaded:
      case BookDownloadState.updateAvailable:
        return IconButton(
          key: Key('download-${b.bookId}'),
          icon: const Icon(Icons.download),
          tooltip: 'Download',
          onPressed: () => widget.onDownload(b.bookId),
        );
      case BookDownloadState.downloading:
        return const SizedBox(
          width: 24,
          height: 24,
          child: CircularProgressIndicator(strokeWidth: 2),
        );
      case BookDownloadState.downloaded:
        return IconButton(
          key: Key('remove-${b.bookId}'),
          icon: const Icon(Icons.delete_outline),
          tooltip: 'Remove download',
          onPressed: () => widget.onRemove(b.bookId),
        );
    }
  }

  String _pillLabel(BookDownloadState s) {
    switch (s) {
      case BookDownloadState.notDownloaded:
        return 'Not downloaded';
      case BookDownloadState.downloading:
        return 'Downloading…';
      case BookDownloadState.downloaded:
        return 'Downloaded';
      case BookDownloadState.updateAvailable:
        return 'Update available';
    }
  }
}
