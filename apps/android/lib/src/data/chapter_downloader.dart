import 'file_store.dart';

/// A streamed range-download response: the HTTP status plus the (lazy) byte
/// stream. Injectable so the downloader unit-tests without real TLS.
class RangeResponse {
  const RangeResponse({required this.statusCode, required this.body});
  final int statusCode;
  final Stream<List<int>> body;
}

/// Performs one range-capable GET. The headers map carries the `Range` header
/// when resuming a partial download.
typedef RangeFetch = Future<RangeResponse> Function(
    Uri url, Map<String, String> headers);

class DownloadException implements Exception {
  const DownloadException(this.message);
  final String message;
  @override
  String toString() => 'DownloadException: $message';
}

/// The result of a download: whether it was committed into place, and the paths
/// involved (so a deferred swap can be applied later from the `.tmp`).
class DownloadOutcome {
  const DownloadOutcome({
    required this.committed,
    required this.tmpPath,
    required this.finalPath,
  });
  final bool committed;
  final String tmpPath;
  final String finalPath;
}

/// Downloads a single chapter's audio to `<finalPath>.tmp` with **range-resume**
/// (continue a dropped download from the partial bytes), a **size integrity
/// check** against the manifest fingerprint, **retry/backoff**, and an **atomic
/// rename** into place. Defers the rename when [commit] is false (the player has
/// the live file open — `app-5` applies the swap on next stop).
class ChapterDownloader {
  ChapterDownloader(
    this._fetch,
    this._store, {
    int retries = 3,
    Future<void> Function(int attempt)? delay,
  })  : _maxRetries = retries,
        _delay = delay ?? _defaultBackoff;

  final RangeFetch _fetch;
  final FileStore _store;
  final int _maxRetries;
  final Future<void> Function(int attempt) _delay;

  static Future<void> _defaultBackoff(int attempt) =>
      Future<void>.delayed(Duration(milliseconds: 500 * (1 << attempt)));

  Future<DownloadOutcome> download({
    required Uri url,
    required String finalPath,
    int? expectedSize,
    bool commit = true,
    void Function(int received, int? total)? onProgress,
  }) async {
    final tmp = '$finalPath.tmp';

    for (var attempt = 0;; attempt++) {
      try {
        var resumeFrom = await _store.size(tmp);
        if (resumeFrom < 0) resumeFrom = 0;

        final headers = <String, String>{};
        if (resumeFrom > 0) headers['range'] = 'bytes=$resumeFrom-';

        final res = await _fetch(url, headers);

        if (resumeFrom > 0 && res.statusCode == 200) {
          // Server ignored the Range and is sending the whole file again —
          // discard the partial and append from scratch.
          await _store.delete(tmp);
          resumeFrom = 0;
        } else if (res.statusCode != 200 && res.statusCode != 206) {
          throw DownloadException('unexpected status ${res.statusCode}');
        }

        var received = resumeFrom;
        await for (final chunk in res.body) {
          await _store.append(tmp, chunk);
          received += chunk.length;
          onProgress?.call(received, expectedSize);
        }

        final actual = await _store.size(tmp);
        if (expectedSize != null && actual != expectedSize) {
          // Corrupt/incomplete — drop it so the next attempt restarts cleanly.
          await _store.delete(tmp);
          throw DownloadException(
              'size mismatch: got $actual, expected $expectedSize');
        }

        if (commit) {
          await _store.rename(tmp, finalPath);
          return DownloadOutcome(committed: true, tmpPath: tmp, finalPath: finalPath);
        }
        return DownloadOutcome(committed: false, tmpPath: tmp, finalPath: finalPath);
      } catch (e) {
        if (attempt >= _maxRetries) {
          throw e is DownloadException ? e : DownloadException('$e');
        }
        await _delay(attempt);
        // Loop: a partial `.tmp` left by a mid-stream failure drives the
        // Range-resume on the next attempt.
      }
    }
  }
}
