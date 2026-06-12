import 'library_tree.dart';

/// One render state for the library home screen, emitted by
/// [loadLibraryLocalFirst]. The screen maps each emission straight onto its
/// widget state — covers/durations are layered on top by the screen.
class LibraryLoad {
  const LibraryLoad({
    required this.books,
    required this.offline,
    required this.connecting,
    required this.loading,
    this.error,
  });

  /// The books to show right now (local first, then server-reconciled).
  final List<LibraryBook> books;

  /// True once we've confirmed the server is unreachable but have a local
  /// (downloaded) library to keep showing — drives the "Offline" retry chip.
  final bool offline;

  /// True while the background server probe is still in flight.
  final bool connecting;

  /// True only when there is nothing to show yet (no local library AND the
  /// server hasn't answered) — the sole case that warrants a full-screen spinner.
  final bool loading;

  /// Set only when we have NOTHING to show and the server is unreachable.
  final String? error;
}

/// Local-first library load: show the downloaded library immediately, then
/// reconcile with the server in the background if it's reachable. A connection
/// failure never blocks or errors the user out as long as something is on disk
/// — it just leaves them on the local library with an "Offline" affordance.
///
/// Emits the local state first (so the UI paints instantly), then a second
/// state once the server answers (or fails). Extracted from the widget so this
/// ordering contract is unit-tested without the device-only [CompanionRuntime].
Stream<LibraryLoad> loadLibraryLocalFirst({
  required Future<List<LibraryBook>> Function() loadLocal,
  required Future<List<LibraryBook>> Function() loadServer,
}) async* {
  List<LibraryBook> local;
  try {
    local = await loadLocal();
  } catch (_) {
    local = const []; // nothing downloaded yet
  }

  // 1. Paint whatever is on disk straight away; probe the server in the back-
  //    ground. Spinner only when there's genuinely nothing to show yet.
  yield LibraryLoad(
    books: local,
    offline: false,
    connecting: true,
    loading: local.isEmpty,
  );

  // 2. Reconcile with the server. Success upgrades to the live catalogue;
  //    failure keeps the local library (offline) and only surfaces an error
  //    when there was nothing local to fall back to.
  try {
    final server = await loadServer();
    yield LibraryLoad(
        books: server, offline: false, connecting: false, loading: false);
  } catch (e) {
    if (local.isNotEmpty) {
      yield LibraryLoad(
          books: local, offline: true, connecting: false, loading: false);
    } else {
      yield LibraryLoad(
          books: const [],
          offline: false,
          connecting: false,
          loading: false,
          error: '$e');
    }
  }
}
