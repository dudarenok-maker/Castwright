import 'dart:convert';

import 'file_store.dart';

/// The local-store **port** the sync engine reads and writes through. `app-3`
/// ships a minimal JSON-snapshot adapter ([FileLocalLibrary]); `app-4` grows the
/// real persistent store (storage accounting, eviction policies, thumbnails)
/// behind this same interface.
abstract class LocalLibrary {
  /// Locally-known per-book last-synced `updatedAt` (drives the index `?since`
  /// diff + book eviction).
  Future<Map<String, String>> syncedBookUpdatedAt();

  /// Locally-known per-chapter fingerprint for a book, keyed by the stable
  /// `uuid` (drives the per-chapter download diff + chapter eviction).
  Future<Map<String, String>> chapterFingerprints(String bookId);

  /// The on-disk path a chapter's audio lives at, derived from its `uuid` and
  /// actual `urlSuffix` (`audio.mp3` | `.m4a` | `.ogg`).
  String audioPath(String bookId, String uuid, String urlSuffix);

  /// Record a freshly-downloaded chapter's fingerprint + format.
  Future<void> recordChapter(
      String bookId, String uuid, String fingerprint, String urlSuffix);

  /// Record a book's last-synced `updatedAt`.
  Future<void> setBookUpdatedAt(String bookId, String updatedAt);

  /// Forget a chapter and delete its on-disk audio.
  Future<void> evictChapter(String bookId, String uuid);

  /// Forget a book and delete all its on-disk audio.
  Future<void> evictBook(String bookId);
}

/// Minimal [LocalLibrary] backed by a single JSON snapshot file under [root],
/// with per-chapter audio at `<root>/books/<bookId>/<uuid>/<urlSuffix>`. The
/// snapshot is loaded lazily and rewritten on each mutation.
class FileLocalLibrary implements LocalLibrary {
  FileLocalLibrary(this._store, {required String root}) : _rootPath = root;

  final FileStore _store;
  final String _rootPath;

  String get _snapshotPath => '$_rootPath/sync-state.json';
  String _bookDir(String bookId) => '$_rootPath/books/$bookId';

  /// `{ books: { <bookId>: { updatedAt, chapters: { <uuid>: { fingerprint, urlSuffix } } } } }`
  Map<String, dynamic>? _cache;

  Future<Map<String, dynamic>> _load() async {
    if (_cache != null) return _cache!;
    final bytes = await _store.read(_snapshotPath);
    if (bytes == null) {
      return _cache = {'books': <String, dynamic>{}};
    }
    final decoded = jsonDecode(utf8.decode(bytes));
    return _cache = decoded is Map<String, dynamic>
        ? decoded
        : {'books': <String, dynamic>{}};
  }

  Future<void> _persist() async {
    await _store.writeBytes(_snapshotPath, utf8.encode(jsonEncode(_cache)));
  }

  Map<String, dynamic> _books(Map<String, dynamic> snap) =>
      (snap['books'] as Map).cast<String, dynamic>();

  Map<String, dynamic> _bookEntry(Map<String, dynamic> snap, String bookId) {
    final books = _books(snap);
    return (books[bookId] ??= <String, dynamic>{
      'updatedAt': '',
      'chapters': <String, dynamic>{},
    }) as Map<String, dynamic>;
  }

  @override
  Future<Map<String, String>> syncedBookUpdatedAt() async {
    final snap = await _load();
    return {
      for (final e in _books(snap).entries)
        e.key: (e.value as Map)['updatedAt'] as String? ?? '',
    };
  }

  @override
  Future<Map<String, String>> chapterFingerprints(String bookId) async {
    final snap = await _load();
    final book = _books(snap)[bookId] as Map<String, dynamic>?;
    if (book == null) return {};
    final chapters = (book['chapters'] as Map).cast<String, dynamic>();
    return {
      for (final e in chapters.entries)
        e.key: (e.value as Map)['fingerprint'] as String? ?? '',
    };
  }

  @override
  String audioPath(String bookId, String uuid, String urlSuffix) =>
      '${_bookDir(bookId)}/$uuid/$urlSuffix';

  @override
  Future<void> recordChapter(
      String bookId, String uuid, String fingerprint, String urlSuffix) async {
    final snap = await _load();
    final book = _bookEntry(snap, bookId);
    final chapters = (book['chapters'] as Map).cast<String, dynamic>();
    chapters[uuid] = {'fingerprint': fingerprint, 'urlSuffix': urlSuffix};
    await _persist();
  }

  @override
  Future<void> setBookUpdatedAt(String bookId, String updatedAt) async {
    final snap = await _load();
    _bookEntry(snap, bookId)['updatedAt'] = updatedAt;
    await _persist();
  }

  @override
  Future<void> evictChapter(String bookId, String uuid) async {
    final snap = await _load();
    final book = _books(snap)[bookId] as Map<String, dynamic>?;
    if (book != null) {
      (book['chapters'] as Map).remove(uuid);
      await _persist();
    }
    await _store.deleteDir('${_bookDir(bookId)}/$uuid');
  }

  @override
  Future<void> evictBook(String bookId) async {
    final snap = await _load();
    _books(snap).remove(bookId);
    await _persist();
    await _store.deleteDir(_bookDir(bookId));
  }
}
