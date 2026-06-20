/// Pure builders for the home surface (`app-14`): a "Continue listening" shelf
/// of in-progress books (most-recently-played first) and a recently-updated
/// rail. No IO — the UI maps store rows into [ShelfBook].
library;

class ShelfBook {
  const ShelfBook({
    required this.bookId,
    required this.title,
    required this.author,
    required this.lastPlayedAt,
    required this.updatedAt,
    this.hidden = false,
    this.finished = false,
  });
  final String bookId;
  final String title;
  final String author;

  /// ISO last-played time; null/empty = never started.
  final String? lastPlayedAt;

  /// ISO last-updated time (server-side change).
  final String updatedAt;

  /// Whether this book is hidden from the "Continue listening" shelf
  /// (manually removed). Defaults to false so existing callers compile
  /// without change.
  final bool hidden;

  /// Whether the server has marked this book finished. Defaults to false so
  /// existing callers compile without change.
  final bool finished;

  bool get inProgress => (lastPlayedAt ?? '').isNotEmpty;
}

/// In-progress books, most-recently-played first. Hidden and finished books
/// are excluded.
List<ShelfBook> buildContinueListening(List<ShelfBook> books) {
  final inProgress =
      books.where((b) => b.inProgress && !b.hidden && !b.finished).toList()
        ..sort((a, b) => b.lastPlayedAt!.compareTo(a.lastPlayedAt!));
  return inProgress;
}

/// Recently-updated rail, newest first, capped at [limit].
List<ShelfBook> buildRecentlyUpdated(List<ShelfBook> books, {int limit = 10}) {
  final sorted = [...books]..sort((a, b) => b.updatedAt.compareTo(a.updatedAt));
  return sorted.take(limit).toList();
}
