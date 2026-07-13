/// Book-level audio orchestration for selecting/opening a book (app-21), as a pure
/// function over injected callables so it unit-tests without a real runtime. The
/// per-book *view* state (chapter list, finished ticks, cover header, peaks, scroll)
/// is owned by PlayerPane — this only drives engine + persistence + server reconcile.
Future<void> runActivateBook({
  required String bookId,
  required String title,
  String? artPath,
  required String? currentBookId,
  required Future<void> Function(String bookId) ensureDetail,
  required Future<String?> Function(String bookId) coverThumbPath,
  required Future<void> Function() saveNow,
  required Future<void> Function(String bookId) syncBook,
  required Future<void> Function(String bookId, String title, String? art) switchBook,
  required Future<void> Function(String bookId, String title, String? art) openBook,
  required Future<void> Function(String bookId) markPlayed,
}) async {
  // 0. Early idempotency guard: re-selecting the open book is a true no-op.
  if (currentBookId == bookId) return;

  // 1. Ensure detail so PlayerPane can read sync.chaptersOf.
  await ensureDetail(bookId);

  // 2. Resolve cover art if not supplied.
  final art = artPath ?? await coverThumbPath(bookId);

  // 3. Hand off (fresh outgoing position) or open.
  if (currentBookId != null) {
    await saveNow();                       // persist LIVE outgoing position
    try { await syncBook(currentBookId); } catch (_) {/* offline */}
    await switchBook(bookId, title, art);
  } else {
    await openBook(bookId, title, art);
  }

  // 4. Continue-listening + LRU eviction ordering.
  await markPlayed(bookId);

  // 5. Reconcile the newly-active book (bidirectional; offline-safe).
  try { await syncBook(bookId); } catch (_) {/* offline */}
}
