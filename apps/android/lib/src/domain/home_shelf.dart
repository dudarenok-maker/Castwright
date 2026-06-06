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
  });
  final String bookId;
  final String title;
  final String author;

  /// ISO last-played time; null/empty = never started.
  final String? lastPlayedAt;

  /// ISO last-updated time (server-side change).
  final String updatedAt;

  bool get inProgress => (lastPlayedAt ?? '').isNotEmpty;
}

/// In-progress books, most-recently-played first.
List<ShelfBook> buildContinueListening(List<ShelfBook> books) {
  final inProgress = books.where((b) => b.inProgress).toList()
    ..sort((a, b) => b.lastPlayedAt!.compareTo(a.lastPlayedAt!));
  return inProgress;
}

/// Recently-updated rail, newest first, capped at [limit].
List<ShelfBook> buildRecentlyUpdated(List<ShelfBook> books, {int limit = 10}) {
  final sorted = [...books]..sort((a, b) => b.updatedAt.compareTo(a.updatedAt));
  return sorted.take(limit).toList();
}
