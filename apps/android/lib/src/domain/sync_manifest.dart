/// Dart mirrors of the srv-32 sync-manifest contract
/// (`server/src/workspace/sync-manifest.ts`, plan 191). Pure data with no
/// platform dependencies, so the delta-sync planner can be unit-tested against
/// them without any IO. The companion diffs this two-level manifest to pull
/// only changed chapters.
library;

/// One lightweight book row from the manifest INDEX.
class SyncManifestIndexBook {
  const SyncManifestIndexBook({
    required this.bookId,
    required this.updatedAt,
    required this.title,
    required this.author,
    required this.series,
    required this.seriesPosition,
    required this.chapterCount,
    this.coverUrl,
    this.finished = false,
    this.hidden = false,
  });

  final String bookId;

  /// Audio-aware ISO timestamp — moves on a metadata edit OR an audio regen.
  /// ISO-8601 UTC strings compare chronologically, so a `?since` diff is a
  /// plain string comparison.
  final String updatedAt;
  final String title;
  final String author;
  final String series;
  final double? seriesPosition;

  /// Active (non-excluded) chapter count.
  final int chapterCount;
  final String? coverUrl;
  final bool finished;
  final bool hidden;

  factory SyncManifestIndexBook.fromJson(Map<String, dynamic> json) {
    return SyncManifestIndexBook(
      bookId: json['bookId'] as String,
      updatedAt: json['updatedAt'] as String,
      title: json['title'] as String? ?? '',
      author: json['author'] as String? ?? '',
      series: json['series'] as String? ?? '',
      seriesPosition: (json['seriesPosition'] as num?)?.toDouble(),
      chapterCount: (json['chapterCount'] as num?)?.toInt() ?? 0,
      coverUrl: json['coverUrl'] as String?,
      finished: json['finished'] as bool? ?? false,
      hidden: json['hidden'] as bool? ?? false,
    );
  }
}

/// The manifest INDEX: one row per book plus the full active-book set, which
/// drives stateless client-side eviction (a filesystem scan has no tombstones).
class SyncManifestIndex {
  const SyncManifestIndex({
    required this.schemaVersion,
    required this.books,
    required this.activeBookIds,
  });

  final int schemaVersion;
  final List<SyncManifestIndexBook> books;

  /// ALWAYS the full current set, even under `?since` — the client evicts any
  /// local book absent from it.
  final List<String> activeBookIds;

  factory SyncManifestIndex.fromJson(Map<String, dynamic> json) {
    final books = (json['books'] as List<dynamic>? ?? const [])
        .map((e) => SyncManifestIndexBook.fromJson(e as Map<String, dynamic>))
        .toList(growable: false);
    final active = (json['activeBookIds'] as List<dynamic>? ?? const [])
        .map((e) => e as String)
        .toList(growable: false);
    return SyncManifestIndex(
      schemaVersion: (json['schemaVersion'] as num?)?.toInt() ?? 0,
      books: books,
      activeBookIds: active,
    );
  }
}

/// One chapter from a book's manifest DETAIL, keyed by the stable srv-35
/// `uuid`. `fingerprint`/`urlSuffix`/`audioUrl` are absent when the chapter has
/// no rendered audio.
class SyncManifestChapter {
  const SyncManifestChapter({
    required this.uuid,
    required this.id,
    required this.title,
    this.fingerprint,
    this.urlSuffix,
    this.audioUrl,
    this.durationSec,
    this.lufs,
  });

  /// Stable identifier (srv-35) — the key for sync + bookmarks. NEVER use the
  /// positional [id] as a key.
  final String uuid;

  /// Current positional id — only used to build [audioUrl] server-side; the
  /// client already receives the built [audioUrl].
  final int id;
  final String title;

  /// `audioRenderedAt|fileSize` — changes on every audio-mutating server path.
  final String? fingerprint;

  /// The actual rendered format: `audio.mp3` | `audio.m4a` | `audio.ogg`.
  /// Never hardcode `.mp3`.
  final String? urlSuffix;
  final String? audioUrl;
  final double? durationSec;
  final double? lufs;

  bool get hasAudio => audioUrl != null && fingerprint != null;

  /// The expected on-disk byte size, parsed from the fingerprint's size
  /// component, used for the post-download integrity check. Null without audio.
  int? get expectedSize {
    final fp = fingerprint;
    if (fp == null) return null;
    final parts = fp.split('|');
    if (parts.length != 2) return null;
    return int.tryParse(parts[1]);
  }

  factory SyncManifestChapter.fromJson(Map<String, dynamic> json) {
    return SyncManifestChapter(
      uuid: json['uuid'] as String,
      id: (json['id'] as num).toInt(),
      title: json['title'] as String? ?? '',
      fingerprint: json['fingerprint'] as String?,
      urlSuffix: json['urlSuffix'] as String?,
      audioUrl: json['audioUrl'] as String?,
      durationSec: (json['durationSec'] as num?)?.toDouble(),
      lufs: (json['lufs'] as num?)?.toDouble(),
    );
  }
}

/// A single book's manifest DETAIL: its active chapters (keyed by `uuid`) plus
/// the full active-chapter set for client-side eviction.
class SyncManifestBookDetail {
  const SyncManifestBookDetail({
    required this.schemaVersion,
    required this.bookId,
    required this.updatedAt,
    required this.chapters,
    required this.activeChapterUuids,
  });

  final int schemaVersion;
  final String bookId;
  final String updatedAt;
  final List<SyncManifestChapter> chapters;

  /// Full active-chapter set for this book — the client evicts any local
  /// chapter absent from it.
  final List<String> activeChapterUuids;

  factory SyncManifestBookDetail.fromJson(Map<String, dynamic> json) {
    final chapters = (json['chapters'] as List<dynamic>? ?? const [])
        .map((e) => SyncManifestChapter.fromJson(e as Map<String, dynamic>))
        .toList(growable: false);
    final active = (json['activeChapterUuids'] as List<dynamic>? ?? const [])
        .map((e) => e as String)
        .toList(growable: false);
    return SyncManifestBookDetail(
      schemaVersion: (json['schemaVersion'] as num?)?.toInt() ?? 0,
      bookId: json['bookId'] as String,
      updatedAt: json['updatedAt'] as String,
      chapters: chapters,
      activeChapterUuids: active,
    );
  }
}
