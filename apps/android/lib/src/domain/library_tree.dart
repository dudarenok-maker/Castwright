/// Pure library-tree grouping for the browse UI (`app-7`): author → series →
/// book, plus search filtering. No IO — the UI maps the drift store's
/// `BookSummary` rows into [LibraryBook] and renders the returned tree.
library;

enum BookDownloadState { notDownloaded, downloading, downloaded, updateAvailable }

/// A library book as the browse UI needs it (display fields + download state).
class LibraryBook {
  const LibraryBook({
    required this.bookId,
    required this.title,
    required this.author,
    required this.series,
    required this.seriesPosition,
    required this.downloadState,
  });
  final String bookId;
  final String title;
  final String author;
  final String series;

  /// Decimal so novellas (e.g. 8.5) sort between whole-numbered entries.
  final double? seriesPosition;
  final BookDownloadState downloadState;
}

/// Render a series position for display: whole numbers without a decimal
/// (`1`, `9`), fractional ones with it (`8.5`); null → empty string.
String formatSeriesPosition(double? pos) {
  if (pos == null) return '';
  return pos == pos.roundToDouble() ? pos.toInt().toString() : '$pos';
}

class SeriesGroup {
  const SeriesGroup({required this.series, required this.books});
  final String series;
  final List<LibraryBook> books;
}

class AuthorGroup {
  const AuthorGroup({required this.author, required this.series});
  final String author;
  final List<SeriesGroup> series;
}

/// Group books by author (alphabetical) → series (alphabetical) → book (by
/// `seriesPosition`, falling back to title).
List<AuthorGroup> buildLibraryTree(List<LibraryBook> books) {
  final byAuthor = <String, Map<String, List<LibraryBook>>>{};
  for (final b in books) {
    (byAuthor.putIfAbsent(b.author, () => {}).putIfAbsent(b.series, () => []))
        .add(b);
  }
  final authors = byAuthor.keys.toList()..sort();
  return [
    for (final author in authors)
      AuthorGroup(
        author: author,
        series: () {
          final seriesNames = byAuthor[author]!.keys.toList()..sort();
          return [
            for (final s in seriesNames)
              SeriesGroup(
                series: s,
                books: byAuthor[author]![s]!.toList()
                  ..sort(_byPositionThenTitle),
              ),
          ];
        }(),
      ),
  ];
}

int _byPositionThenTitle(LibraryBook a, LibraryBook b) {
  final pa = a.seriesPosition, pb = b.seriesPosition;
  if (pa != null && pb != null && pa != pb) return pa.compareTo(pb);
  if (pa != null && pb == null) return -1;
  if (pa == null && pb != null) return 1;
  return a.title.toLowerCase().compareTo(b.title.toLowerCase());
}

/// Case-insensitive filter on title, author, OR series; empty query returns
/// all. (Series matters: filtering "Keeper" should keep every book in the
/// "The Hollow Tide" series, not just the one titled that.)
List<LibraryBook> filterBooks(List<LibraryBook> books, String query) {
  final q = query.trim().toLowerCase();
  if (q.isEmpty) return books;
  return books
      .where((b) =>
          b.title.toLowerCase().contains(q) ||
          b.author.toLowerCase().contains(q) ||
          b.series.toLowerCase().contains(q))
      .toList();
}
