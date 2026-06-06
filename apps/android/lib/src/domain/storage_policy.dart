/// Pure storage accounting + eviction policy for the offline library (`app-4`).
/// No IO — the drift store gathers usage, calls this to decide what to remove,
/// then applies the [EvictionPlan]. `app-13` supplies the cap + toggles.
library;

class ChapterUsage {
  const ChapterUsage({
    required this.uuid,
    required this.bytes,
    this.finished = false,
  });
  final String uuid;

  /// On-disk audio size (0 when no file is present).
  final int bytes;
  final bool finished;
}

class BookUsage {
  const BookUsage({
    required this.bookId,
    required this.lastPlayedAt,
    required this.chapters,
  });
  final String bookId;

  /// ISO timestamp of last playback, or null if never played.
  final String? lastPlayedAt;
  final List<ChapterUsage> chapters;

  int get totalBytes =>
      chapters.fold(0, (sum, c) => sum + c.bytes);
}

/// A chapter whose audio file should be deleted while its metadata row stays.
class ChapterRef {
  const ChapterRef(this.bookId, this.uuid);
  final String bookId;
  final String uuid;
}

class EvictionPlan {
  const EvictionPlan({required this.chapterFilesToDrop, required this.booksToEvict});

  /// Finished chapters whose audio file is dropped (row + progress kept).
  final List<ChapterRef> chapterFilesToDrop;

  /// Books removed wholesale (rows + all files) by the storage-cap policy.
  final List<String> booksToEvict;
}

/// Decide what to evict to keep the cache under [capBytes]:
///   1. if [autoDeleteFinished], drop every finished chapter's audio file
///      (freeing its bytes; the row + listen-progress stay);
///   2. if still over [capBytes], evict whole books **least-recently-played
///      first**, always protecting the [keepRecentBooks] most-recently-played.
EvictionPlan planStorageEviction({
  required List<BookUsage> books,
  required int capBytes,
  required bool autoDeleteFinished,
  required int keepRecentBooks,
}) {
  // Per-book remaining bytes, reduced as we plan finished-file drops.
  final remaining = <String, int>{for (final b in books) b.bookId: b.totalBytes};
  final drops = <ChapterRef>[];

  if (autoDeleteFinished) {
    for (final b in books) {
      for (final c in b.chapters) {
        if (c.finished && c.bytes > 0) {
          drops.add(ChapterRef(b.bookId, c.uuid));
          remaining[b.bookId] = remaining[b.bookId]! - c.bytes;
        }
      }
    }
  }

  final toEvict = <String>[];
  var total = remaining.values.fold(0, (s, v) => s + v);

  if (total > capBytes) {
    // Most-recently-played first; nulls (never played) sort oldest.
    final byRecencyDesc = [...books]
      ..sort((a, b) => (b.lastPlayedAt ?? '').compareTo(a.lastPlayedAt ?? ''));
    final protected =
        byRecencyDesc.take(keepRecentBooks).map((b) => b.bookId).toSet();
    // Eviction candidates, oldest first.
    final candidates = byRecencyDesc.reversed
        .where((b) => !protected.contains(b.bookId))
        .toList();

    for (final b in candidates) {
      if (total <= capBytes) break;
      toEvict.add(b.bookId);
      total -= remaining[b.bookId]!;
    }
  }

  // A wholesale-evicted book subsumes its finished-file drops — don't list both.
  final evicted = toEvict.toSet();
  final filteredDrops =
      drops.where((d) => !evicted.contains(d.bookId)).toList();

  return EvictionPlan(chapterFilesToDrop: filteredDrops, booksToEvict: toEvict);
}
