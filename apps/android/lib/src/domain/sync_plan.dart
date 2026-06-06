/// Pure delta planner for the companion sync engine. Given the srv-32 manifest
/// and the app's local state, it decides what to fetch, download, and evict —
/// with zero IO, so it is exhaustively unit-testable.
///
/// Keying is by the stable srv-35 `uuid` and the per-chapter fingerprint; the
/// positional chapter `id` is never a key, so a server-side reorder/rename
/// never triggers a needless re-download.
library;

import 'sync_manifest.dart';

/// What an index sync should do: which books need their detail fetched +
/// downloaded, and which local books are gone server-side and must be evicted.
class IndexPlan {
  const IndexPlan({required this.booksToSync, required this.bookIdsToEvict});
  final List<SyncManifestIndexBook> booksToSync;
  final List<String> bookIdsToEvict;
}

/// What a single book's sync should do: which chapters to (re)download and which
/// local chapters are gone server-side and must be evicted.
class BookPlan {
  const BookPlan({required this.chaptersToDownload, required this.chapterUuidsToEvict});
  final List<SyncManifestChapter> chaptersToDownload;
  final List<String> chapterUuidsToEvict;
}

/// Diff the manifest index against the locally-known per-book `updatedAt` map.
///
/// A book needs syncing when it is unknown locally OR its server `updatedAt` is
/// newer than what we last synced. A local book absent from [SyncManifestIndex.activeBookIds]
/// no longer exists on the server and is evicted (stateless deletion).
IndexPlan planIndexSync(
  SyncManifestIndex index,
  Map<String, String> localBookUpdatedAt,
) {
  final toSync = <SyncManifestIndexBook>[];
  for (final b in index.books) {
    final local = localBookUpdatedAt[b.bookId];
    if (local == null || b.updatedAt.compareTo(local) > 0) {
      toSync.add(b);
    }
  }
  final active = index.activeBookIds.toSet();
  final toEvict = localBookUpdatedAt.keys
      .where((id) => !active.contains(id))
      .toList(growable: false);
  return IndexPlan(booksToSync: toSync, bookIdsToEvict: toEvict);
}

/// Diff a book's manifest detail against the locally-known fingerprint per
/// chapter `uuid`.
///
/// A chapter is downloaded when it has rendered audio AND is either unknown
/// locally or its fingerprint changed. A local chapter absent from
/// [SyncManifestBookDetail.activeChapterUuids] is evicted.
BookPlan planBookSync(
  SyncManifestBookDetail detail,
  Map<String, String> localFingerprintByUuid,
) {
  final toDownload = <SyncManifestChapter>[];
  for (final c in detail.chapters) {
    if (!c.hasAudio) continue;
    final local = localFingerprintByUuid[c.uuid];
    if (local == null || local != c.fingerprint) {
      toDownload.add(c);
    }
  }
  final active = detail.activeChapterUuids.toSet();
  final toEvict = localFingerprintByUuid.keys
      .where((uuid) => !active.contains(uuid))
      .toList(growable: false);
  return BookPlan(chaptersToDownload: toDownload, chapterUuidsToEvict: toEvict);
}
