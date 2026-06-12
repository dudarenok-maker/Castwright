import 'dart:convert';

import '../data/api_client.dart' show HttpSend, HttpResult;
import 'demo_data.dart';

/// A fake [HttpSend] for marketing capture. Pattern-matches the request path and
/// returns canned JSON — driving the manifest index, per-book details, waveform
/// peaks, and a 404 listen-progress, with ZERO TLS. When [offline], the manifest
/// paths return 503 so the library falls back to its local store (offline scene).
HttpSend demoHttpSend({bool offline = false}) {
  return (String method, Uri url, Map<String, String> headers) async {
    final path = url.path;
    final qs = url.queryParameters;

    if (path == '/api/library/sync-manifest') {
      if (offline) return const HttpResult(503, '');
      if (qs.containsKey('bookId')) {
        return HttpResult(200, jsonEncode(demoDetailJson(qs['bookId']!)));
      }
      return HttpResult(200, jsonEncode(demoIndexJson()));
    }
    if (path.endsWith('/audio')) {
      return HttpResult(200, jsonEncode({'peaks': demoPeaks}));
    }
    if (path.endsWith('/listen-progress')) {
      return const HttpResult(404, '');
    }
    if (path == '/api/info') {
      return HttpResult(200, jsonEncode({'version': 'demo', 'name': 'Castwright'}));
    }
    return const HttpResult(404, '');
  };
}
