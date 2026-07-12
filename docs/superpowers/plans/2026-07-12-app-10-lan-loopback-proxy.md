# app-10 — Stream-over-LAN via an in-app loopback proxy — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make an undownloaded chapter play instantly over the home LAN in the Flutter companion by running a tiny in-app loopback HTTP proxy that re-serves CA-pinned HTTPS chapter bytes as plaintext `127.0.0.1` to the native platform player.

**Architecture:** A `dart:io HttpServer` bound to `127.0.0.1:0` accepts the platform player's plaintext range requests and re-fetches each range over the app's already-pinned HTTPS client (`ApiClient`), streaming `206` bytes straight through. The mkcert CA never has to be trusted by the OS and the Bearer token never leaves the app. Playback-source selection, failure fallback (download-to-play vs. re-pair), and an engine error seam wire the proxy into the existing `PlayerController` without disturbing the offline-first download path.

**Tech Stack:** Dart / Flutter, `dart:io` (`HttpServer`, `HttpClient`), `just_audio` (native ExoPlayer/AVPlayer), `flutter_test`. No new pubspec dependency. Android `network_security_config.xml`.

**Spec:** [`docs/superpowers/specs/2026-07-12-app-10-lan-loopback-proxy-design.md`](../specs/2026-07-12-app-10-lan-loopback-proxy-design.md) (design approved 2026-07-12, converged after 3 adversarial rounds).

**Issue:** [#553](https://github.com/dudarenok-maker/Castwright/issues/553) (`app-10`). PR closes it; on-device Android smoke test is owed to the owner post-merge (standard app-* "live device acceptance owed").

## Global Constraints

- **No new pubspec dependency.** Everything is `dart:io` / existing packages.
- **Two invariants must both hold:** (a) **app-pinned CA only — no OS cert install**; (b) **HTTPS-on-LAN — no cleartext chapter bytes or token off-device.** The only permitted cleartext is the in-process `127.0.0.1` hop.
- **Ephemeral preview only.** Streamed bytes are never persisted; no coupling to the downloader. Offline stays the existing explicit Download flow.
- **Stream-through, never whole-file buffering** (instant play + no OOM on large chapters).
- **Demand-scoped, never a background server.** No socket binds at app launch, on pairing, or while playing local files. The proxy `start()`s only on the first resolution to `PlaybackSource.lanStream` and is disposed with the `PlayerController`.
- **No auto-retry on stream failure.** A single clean fallback (download-to-play, or re-pair on `401/403`) — no silent retry loop.
- **Backward-compatible constructor.** `PlayerController` gains the streaming deps as ONE optional bundle; when absent, `_loadIndex` keeps its exact current behaviour (`setFilePath(c.path)`), so every existing `PlayerController` test stays green unchanged.
- **Commit convention:** `<type>(<scope>): <subject>`; scope for companion code is `app`, for docs is `docs`. The commit-msg hook enforces this.
- **The only automated gate for `apps/android/` is `app.yml`** (`flutter analyze` + `flutter test`). Every task below ships paired Dart tests; run `flutter test` from `apps/android/`.
- **`network_security_config.xml` + manifest wiring is NOT unit-testable for effect** — a string-assertion test guards its presence; real behaviour is validated only on-device.

## Deviations from the spec (deliberate, carry into the handover)

1. **`LoopbackProxy.register` drops the `headers` parameter.** The spec's §1 `register({upstream, headers})` and §2 "`pinnedRangeStream` … Same `Authorization: Bearer` injection" would inject the Bearer twice. Resolution: **auth lives in exactly one place — `pinnedRangeStream` injects the Bearer** (consistent with `pinnedRangeFetch`). The proxy is constructed with the `pinnedRangeStream` tear-off as its upstream fetch and stays auth-agnostic; `register` needs only `upstream`. No token is ever handed to the proxy or duplicated.
2. **`pinnedRangeStream` uses ONE shared streaming client and `cancel()` aborts via the held `StreamSubscription` only** (never `client.close(force: true)`) — exactly the spec §2 trap. A `@visibleForTesting` `streamRange(HttpClient, …)` helper isolates the socket logic so the cancel-only-this-request contract is tested against a real plaintext `HttpServer` without TLS.
3. **The `PlayerController` streaming deps are bundled into one optional `StreamingConfig`** (rather than 6 separate required constructor params) to keep the change backward-compatible and bound test churn, per the Global Constraint above.

---

## File Structure

**New files:**
- `apps/android/lib/src/data/loopback_proxy.dart` — the `LoopbackProxy` (`HttpServer` on `127.0.0.1:0`, one active mapping, upstream relay, failure side-channel).
- `apps/android/test/data/loopback_proxy_test.dart` — proxy tests against a fake upstream fetch.
- `apps/android/android/app/src/main/res/xml/network_security_config.xml` — loopback-scoped cleartext exemption.
- `apps/android/test/network_security_config_test.dart` — string-assertion guard for the config + manifest wiring.
- `apps/android/test/data/api_client_stream_test.dart` — `pinnedRangeStream` / `streamRange` transport tests (real plaintext server).
- `apps/android/test/data/loopback_reachability_test.dart` — `Reachability.onHomeLan` mapping.

**Modified files:**
- `apps/android/lib/src/data/api_client.dart` — add `PinnedStreamResponse`, `pinnedRangeStream`, `streamRange`.
- `apps/android/lib/src/data/audio_engine.dart` — add `Stream<Object> get errorStream;`.
- `apps/android/lib/src/data/just_audio_engine.dart` — map `playbackEventStream` errors onto `errorStream`.
- `apps/android/lib/src/demo/demo_audio_engine.dart` — empty `errorStream`.
- `apps/android/lib/src/data/network_info.dart` — add `Reachability` + `CurrentNetwork` typedef.
- `apps/android/lib/src/data/player_controller.dart` — `PlayableChapter.audioUrl`; `StreamingConfig`; source-resolution + failure routing in `_loadIndex`.
- `apps/android/lib/src/data/sync_controller.dart` — carry `audioUrl` through `playlistFor`.
- `apps/android/lib/src/data/companion_runtime.dart` — build + inject the `StreamingConfig`; thread `onRepairNeeded`.
- `apps/android/lib/main.dart` — expose the re-pair entry to the runtime.
- `apps/android/android/app/src/main/AndroidManifest.xml` — `android:networkSecurityConfig` attribute.
- Test fakes implementing `AudioEngine` (add `errorStream`): `test/data/player_controller_test.dart`, `test/data/player_controller_playing_stream_test.dart`, `test/data/companion_runtime_test.dart`, `test/data/companion_audio_handler_test.dart`.
- `apps/android/test/domain/playback_source_test.dart` — add the `NetworkType → onHomeLan` cases.
- `docs/features/188-android-companion-app.md` — reconcile the `app-10` row + acceptance walkthrough.
- `docs/release-notes-next.md` + `RELEASE_NOTES.md` — one entry each (at ship time).

---

## Task 1: `pinnedRangeStream` — CA-pinned, cancellable range streaming

**Files:**
- Modify: `apps/android/lib/src/data/api_client.dart`
- Test: `apps/android/test/data/api_client_stream_test.dart` (create)

**Interfaces:**
- Consumes: `_pinnedHttpClient(Connection)` (`api_client.dart:311`), `connection.server.token`.
- Produces:
  - `class PinnedStreamResponse { final int statusCode; final Map<String,String> headers; final Stream<List<int>> body; final Future<void> Function() cancel; }`
  - `Future<PinnedStreamResponse> ApiClient.pinnedRangeStream(Uri url, {String? range})`
  - `@visibleForTesting Future<PinnedStreamResponse> streamRange(HttpClient client, Uri url, {required String bearer, String? range})`

- [ ] **Step 1: Write the failing test**

Create `apps/android/test/data/api_client_stream_test.dart`:

```dart
import 'dart:async';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:castwright/src/data/api_client.dart';

void main() {
  late HttpServer server;
  final received = <HttpRequest>[];

  setUp(() async {
    received.clear();
    server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
    server.listen((req) async {
      received.add(req);
      final res = req.response;
      res.statusCode = req.headers.value(HttpHeaders.rangeHeader) != null ? 206 : 200;
      res.headers.set(HttpHeaders.contentTypeHeader, 'audio/mpeg');
      res.headers.set('x-echo-range', req.headers.value(HttpHeaders.rangeHeader) ?? '');
      res.headers.set('x-echo-auth', req.headers.value(HttpHeaders.authorizationHeader) ?? '');
      res.add([1, 2, 3, 4]);
      await res.close();
    });
  });

  tearDown(() async => server.close(force: true));

  Uri url() => Uri.parse('http://127.0.0.1:${server.port}/audio.mp3');

  test('streamRange passes status, headers, body; injects Bearer; forwards Range', () async {
    final client = HttpClient();
    final r = await streamRange(client, url(), bearer: 'TKN', range: 'bytes=0-3');
    expect(r.statusCode, 206);
    expect(r.headers['content-type'], 'audio/mpeg');
    expect(r.headers['x-echo-range'], 'bytes=0-3');
    expect(r.headers['x-echo-auth'], 'Bearer TKN');
    final bytes = <int>[];
    await for (final chunk in r.body) {
      bytes.addAll(chunk);
    }
    expect(bytes, [1, 2, 3, 4]);
    client.close(force: true);
  });

  test('cancel aborts only this request; a sibling on the same client survives', () async {
    // A slow server that streams a byte, waits, then finishes — so we can cancel
    // request `a` mid-stream (after it has actually started reading).
    final slow = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
    slow.listen((req) async {
      final res = req.response;
      res.add([9]);
      await res.flush();
      await Future<void>.delayed(const Duration(milliseconds: 200));
      res.add([9]);
      await res.close();
    });
    final slowUrl = Uri.parse('http://127.0.0.1:${slow.port}/x');
    final client = HttpClient(); // ONE shared client for both requests

    final a = await streamRange(client, slowUrl, bearer: 't');
    final b = await streamRange(client, slowUrl, bearer: 't');

    // ACTIVELY read `a` up to its first chunk so a real socket read is in flight
    // on the shared client — otherwise cancel() would be a no-op and prove nothing.
    final aStarted = Completer<void>();
    final aSub = a.body.listen((_) {
      if (!aStarted.isCompleted) aStarted.complete();
    });
    await aStarted.future.timeout(const Duration(seconds: 2));

    // Drain b fully in parallel, then cancel a mid-stream.
    final bDone = b.body.fold<List<int>>(<int>[], (acc, c) => acc..addAll(c));
    await a.cancel();
    await aSub.cancel();

    // The sibling completes despite a's mid-stream cancel — cancel tore down only
    // a's socket, not the shared client's pool.
    final bBytes = await bDone.timeout(const Duration(seconds: 2));
    expect(bBytes, [9, 9]);
    client.close(force: true);
    await slow.close(force: true);
  });
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/android && flutter test test/data/api_client_stream_test.dart`
Expected: FAIL — `streamRange`/`PinnedStreamResponse` not defined.

- [ ] **Step 3: Write minimal implementation**

In `apps/android/lib/src/data/api_client.dart`, add the `visibleForTesting` import usage is already present (`import 'package:flutter/foundation.dart' show visibleForTesting;`). Add this class near the top-level types and the two functions (method on `ApiClient`, helper at file scope):

```dart
/// A streamed, CA-pinned range response for the loopback proxy (`app-10`). The
/// [body] is a single-subscription stream that preserves backpressure; [cancel]
/// aborts THIS request's socket via the held subscription — it never closes the
/// shared streaming client, so sibling concurrent range fetches keep running.
class PinnedStreamResponse {
  const PinnedStreamResponse({
    required this.statusCode,
    required this.headers,
    required this.body,
    required this.cancel,
  });
  final int statusCode;
  final Map<String, String> headers; // lower-cased header names
  final Stream<List<int>> body;
  final Future<void> Function() cancel;
}
```

Add a lazily-created shared streaming client field + method on `ApiClient` (after `pinnedRangeFetch()`):

```dart
  HttpClient? _streamClient;

  /// A range-capable, CA-pinned, streamed byte fetcher for `app-10` LAN preview.
  /// Reuses ONE pinned client across concurrent range fetches in a playback
  /// session (connection reuse); each response's [PinnedStreamResponse.cancel]
  /// aborts only its own socket. The Bearer is injected here, so the loopback
  /// proxy never sees the token.
  Future<PinnedStreamResponse> pinnedRangeStream(Uri url, {String? range}) {
    final client = _streamClient ??= _pinnedHttpClient(connection);
    return streamRange(client, url, bearer: connection.server.token, range: range);
  }
```

Add the file-scope helper (after `_pinnedSend`):

```dart
/// Transport core for [ApiClient.pinnedRangeStream], split out so the streaming +
/// cancel behaviour is unit-testable against a real plaintext `HttpServer`
/// (production passes the CA-pinned client). Holds the response subscription so
/// [PinnedStreamResponse.cancel] tears down ONLY this socket.
@visibleForTesting
Future<PinnedStreamResponse> streamRange(HttpClient client, Uri url,
    {required String bearer, String? range}) async {
  final req = await client.getUrl(url);
  req.headers.set(HttpHeaders.authorizationHeader, 'Bearer $bearer');
  if (range != null) req.headers.set(HttpHeaders.rangeHeader, range);
  final res = await req.close();

  final headers = <String, String>{};
  res.headers.forEach((name, values) => headers[name] = values.join(','));

  final out = StreamController<List<int>>();
  // Subscribe EAGERLY (then pause) — not lazily in onListen — so `cancel()` can
  // always tear down the real socket, even on a HEAD / non-2xx path where the
  // body is never drained (`addStream` never fires onListen). A lazy subscription
  // would leave the HttpClientResponse dangling on every HEAD probe and every
  // 401/404/5xx upstream. dart:io delivers events async, so the pause below can't
  // race a synchronous first event.
  final sub = res.listen(
    out.add,
    onError: out.addError,
    onDone: () {
      if (!out.isClosed) out.close();
    },
    cancelOnError: true,
  );
  sub.pause();
  out.onListen = () => sub.resume();
  out.onPause = () => sub.pause();
  out.onResume = () => sub.resume();
  out.onCancel = () => sub.cancel();

  Future<void> cancel() async {
    await sub.cancel(); // abort THIS socket only — never client.close()
    if (!out.isClosed) await out.close();
  }

  return PinnedStreamResponse(
    statusCode: res.statusCode,
    headers: headers,
    body: out.stream,
    cancel: cancel,
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/android && flutter test test/data/api_client_stream_test.dart`
Expected: PASS (both tests).

- [ ] **Step 5: Commit**

```bash
git add apps/android/lib/src/data/api_client.dart apps/android/test/data/api_client_stream_test.dart
git commit -m "feat(app): add CA-pinned cancellable range streaming for LAN preview"
```

---

## Task 2: `LoopbackProxy` — the in-app loopback server

**Files:**
- Create: `apps/android/lib/src/data/loopback_proxy.dart`
- Test: `apps/android/test/data/loopback_proxy_test.dart` (create)

**Interfaces:**
- Consumes: `PinnedStreamResponse` (Task 1). The upstream fetch is injected as `typedef UpstreamFetch = Future<PinnedStreamResponse> Function(Uri url, {String? range})` — production passes `apiClient.pinnedRangeStream`.
- Produces:
  - `LoopbackProxy(UpstreamFetch fetch, {Random? random})`
  - `Future<void> start()` — idempotent; binds `127.0.0.1:0`.
  - `Uri register({required Uri upstream})` — mints a 128-bit id, resets `lastUpstreamStatus`, returns `http://127.0.0.1:<port>/s/<id>`.
  - `int? get lastUpstreamStatus`
  - `void clearMapping()`
  - `Future<void> dispose()`

- [ ] **Step 1: Write the failing test**

Create `apps/android/test/data/loopback_proxy_test.dart`:

```dart
import 'dart:async';
import 'dart:io';
import 'dart:math';

import 'package:flutter_test/flutter_test.dart';
import 'package:castwright/src/data/api_client.dart';
import 'package:castwright/src/data/loopback_proxy.dart';

/// A programmable fake upstream. Records the URL/range it was asked for and
/// returns a canned PinnedStreamResponse.
class _FakeUpstream {
  int status = 206;
  Map<String, String> headers = {
    'content-type': 'audio/mpeg',
    'content-length': '4',
    'content-range': 'bytes 0-3/4',
    'accept-ranges': 'bytes',
  };
  List<int> bytes = [1, 2, 3, 4];
  final List<String?> ranges = [];
  int cancelled = 0;
  bool throwOnFetch = false;

  Future<PinnedStreamResponse> fetch(Uri url, {String? range}) async {
    ranges.add(range);
    if (throwOnFetch) throw const SocketException('unreachable');
    final ctl = StreamController<List<int>>();
    ctl.onListen = () {
      ctl.add(bytes);
      ctl.close();
    };
    return PinnedStreamResponse(
      statusCode: status,
      headers: headers,
      body: ctl.stream,
      cancel: () async {
        cancelled++;
        if (!ctl.isClosed) await ctl.close();
      },
    );
  }
}

Future<HttpClientResponse> _get(Uri url, {String method = 'GET', String? range}) async {
  final client = HttpClient();
  final req = await client.openUrl(method, url);
  if (range != null) req.headers.set(HttpHeaders.rangeHeader, range);
  final res = await req.close();
  return res;
}

void main() {
  late _FakeUpstream up;
  late LoopbackProxy proxy;

  setUp(() async {
    up = _FakeUpstream();
    // Seeded Random so ids are deterministic in tests.
    proxy = LoopbackProxy(up.fetch, random: Random(1));
    await proxy.start();
  });

  tearDown(() async => proxy.dispose());

  test('register returns a loopback URL that streams upstream bytes', () async {
    final loopback = proxy.register(upstream: Uri.parse('https://lan:8443/a.mp3'));
    expect(loopback.host, '127.0.0.1');
    expect(loopback.path, startsWith('/s/'));
    final res = await _get(loopback, range: 'bytes=0-3');
    expect(res.statusCode, 206);
    expect(res.headers.value('content-range'), 'bytes 0-3/4');
    expect(res.headers.value(HttpHeaders.acceptRangesHeader), 'bytes');
    final body = await res.fold<List<int>>(<int>[], (a, c) => a..addAll(c));
    expect(body, [1, 2, 3, 4]);
    expect(up.ranges.last, 'bytes=0-3'); // Range forwarded
  });

  test('unknown / stale id -> 404; non-GET/HEAD -> 405', () async {
    final loopback = proxy.register(upstream: Uri.parse('https://lan/a.mp3'));
    final bad = loopback.replace(path: '/s/deadbeef');
    expect((await _get(bad)).statusCode, 404);
    expect((await _get(loopback, method: 'POST')).statusCode, 405);
  });

  test('HEAD relays headers only (no body); cancels upstream', () async {
    final loopback = proxy.register(upstream: Uri.parse('https://lan/a.mp3'));
    final res = await _get(loopback, method: 'HEAD');
    expect(res.statusCode, 206);
    expect(res.headers.value(HttpHeaders.contentTypeHeader), 'audio/mpeg');
    final body = await res.fold<List<int>>(<int>[], (a, c) => a..addAll(c));
    expect(body, isEmpty);
    expect(up.cancelled, greaterThanOrEqualTo(1));
  });

  test('registering a new chapter evicts the prior id (old URL 404s)', () async {
    final first = proxy.register(upstream: Uri.parse('https://lan/a.mp3'));
    final second = proxy.register(upstream: Uri.parse('https://lan/b.mp3'));
    expect((await _get(first)).statusCode, 404);
    expect((await _get(second)).statusCode, 206);
  });

  test('non-2xx upstream sets lastUpstreamStatus and relays the code', () async {
    up.status = 401;
    final loopback = proxy.register(upstream: Uri.parse('https://lan/a.mp3'));
    final res = await _get(loopback);
    expect(res.statusCode, 401);
    expect(proxy.lastUpstreamStatus, 401);
  });

  test('fetch throw -> 502 and lastUpstreamStatus 0', () async {
    up.throwOnFetch = true;
    final loopback = proxy.register(upstream: Uri.parse('https://lan/a.mp3'));
    final res = await _get(loopback);
    expect(res.statusCode, 502);
    expect(proxy.lastUpstreamStatus, 0);
  });

  test('register() resets lastUpstreamStatus to null', () async {
    up.status = 500;
    await _get(proxy.register(upstream: Uri.parse('https://lan/a.mp3')));
    expect(proxy.lastUpstreamStatus, 500);
    proxy.register(upstream: Uri.parse('https://lan/b.mp3'));
    expect(proxy.lastUpstreamStatus, isNull);
  });

  test('start() is idempotent (same port on a second call)', () async {
    final before = proxy.register(upstream: Uri.parse('https://lan/a.mp3')).port;
    await proxy.start();
    final after = proxy.register(upstream: Uri.parse('https://lan/b.mp3')).port;
    expect(after, before);
  });
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/android && flutter test test/data/loopback_proxy_test.dart`
Expected: FAIL — `loopback_proxy.dart` does not exist.

- [ ] **Step 3: Write minimal implementation**

Create `apps/android/lib/src/data/loopback_proxy.dart`:

```dart
import 'dart:async';
import 'dart:io';
import 'dart:math';

import 'api_client.dart' show PinnedStreamResponse;

/// Fetches one upstream range over the CA-pinned HTTPS client. Production passes
/// `ApiClient.pinnedRangeStream` (which injects the Bearer), so the proxy stays
/// auth-agnostic and the token never reaches the platform player.
typedef UpstreamFetch = Future<PinnedStreamResponse> Function(Uri url, {String? range});

/// An in-app loopback TLS-terminating proxy (`app-10`). Binds `127.0.0.1:0` on
/// demand and re-serves CA-pinned HTTPS chapter bytes as plaintext to the native
/// platform player, honouring `Range`/`206`. One active mapping at a time
/// (single-player app); a stale loopback id cleanly `404`s. Loopback-only bind +
/// an unguessable 128-bit path id keep it unreachable off-device and unguessable
/// to other local apps.
class LoopbackProxy {
  LoopbackProxy(this._fetch, {Random? random}) : _random = random ?? Random.secure();

  final UpstreamFetch _fetch;
  final Random _random;

  HttpServer? _server;
  String? _activeId;
  Uri? _activeUpstream;
  int? _lastUpstreamStatus;

  /// The last non-2xx upstream code (or `0` for a connection/timeout failure),
  /// scoped to the current registration — [register] resets it to null.
  int? get lastUpstreamStatus => _lastUpstreamStatus;

  /// Bind the loopback socket. Idempotent — a second call is a no-op.
  Future<void> start() async {
    if (_server != null) return;
    _server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
    _server!.listen(_handle);
  }

  /// Point the proxy at [upstream] under a fresh 128-bit id and return the
  /// loopback URL to hand to the player. Evicts any prior mapping and resets
  /// [lastUpstreamStatus].
  Uri register({required Uri upstream}) {
    final server = _server;
    if (server == null) {
      throw StateError('LoopbackProxy.register called before start()');
    }
    _lastUpstreamStatus = null;
    final id = _mintId();
    _activeId = id;
    _activeUpstream = upstream;
    return Uri.parse('http://127.0.0.1:${server.port}/s/$id');
  }

  /// Drop the active mapping so any live loopback URL `404`s (called on failure).
  void clearMapping() {
    _activeId = null;
    _activeUpstream = null;
  }

  Future<void> dispose() async {
    clearMapping();
    await _server?.close(force: true);
    _server = null;
  }

  String _mintId() {
    final b = List<int>.generate(16, (_) => _random.nextInt(256));
    return b.map((x) => x.toRadixString(16).padLeft(2, '0')).join();
  }

  Future<void> _handle(HttpRequest req) async {
    final res = req.response;
    if (req.method != 'GET' && req.method != 'HEAD') {
      res.statusCode = HttpStatus.methodNotAllowed; // 405
      await res.close();
      return;
    }
    final path = req.uri.path;
    final id = path.startsWith('/s/') ? path.substring(3) : '';
    final upstreamUrl = _activeUpstream;
    if (id.isEmpty || id != _activeId || upstreamUrl == null) {
      res.statusCode = HttpStatus.notFound; // 404
      await res.close();
      return;
    }

    final range = req.headers.value(HttpHeaders.rangeHeader);
    PinnedStreamResponse upstream;
    try {
      upstream = await _fetch(upstreamUrl, range: range);
    } catch (_) {
      _lastUpstreamStatus = 0;
      res.statusCode = HttpStatus.badGateway; // 502
      await res.close();
      return;
    }

    if (upstream.statusCode < 200 || upstream.statusCode >= 300) {
      _lastUpstreamStatus = upstream.statusCode;
      res.statusCode = upstream.statusCode;
      await upstream.cancel();
      await res.close();
      return;
    }

    res.statusCode = upstream.statusCode; // 200 | 206
    for (final h in const [
      HttpHeaders.contentTypeHeader,
      HttpHeaders.contentLengthHeader,
      'content-range',
      HttpHeaders.acceptRangesHeader,
    ]) {
      final v = upstream.headers[h];
      if (v != null) res.headers.set(h, v);
    }

    if (req.method == 'HEAD') {
      await upstream.cancel();
      await res.close();
      return;
    }

    try {
      await res.addStream(upstream.body); // backpressure-preserving
      await res.close();
    } catch (_) {
      // Client disconnect (seek/stop) → abort the upstream socket so it can't leak.
      await upstream.cancel();
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/android && flutter test test/data/loopback_proxy_test.dart`
Expected: PASS (all cases).

- [ ] **Step 5: Commit**

```bash
git add apps/android/lib/src/data/loopback_proxy.dart apps/android/test/data/loopback_proxy_test.dart
git commit -m "feat(app): add in-app loopback proxy for LAN chapter streaming"
```

---

## Task 3: Android cleartext-to-loopback config

**Files:**
- Create: `apps/android/android/app/src/main/res/xml/network_security_config.xml`
- Modify: `apps/android/android/app/src/main/AndroidManifest.xml:15-18` (the `<application>` open tag)
- Test: `apps/android/test/network_security_config_test.dart` (create)

**Interfaces:** None (declarative). Without this, ExoPlayer's `DefaultHttpDataSource` throws on a cleartext `http://127.0.0.1` load and the feature serves zero bytes on release builds.

- [ ] **Step 1: Write the failing test**

Create `apps/android/test/network_security_config_test.dart`:

```dart
import 'dart:io';
import 'package:flutter_test/flutter_test.dart';

void main() {
  test('network security config permits cleartext ONLY for 127.0.0.1 loopback', () {
    final xml = File('android/app/src/main/res/xml/network_security_config.xml')
        .readAsStringSync();
    // Base default stays secure (no global cleartext).
    expect(xml.contains('<base-config cleartextTrafficPermitted="false"'), isTrue);
    // A domain-config opens cleartext for loopback only.
    expect(xml.contains('cleartextTrafficPermitted="true"'), isTrue);
    expect(xml.contains('<domain includeSubdomains="false">127.0.0.1</domain>'), isTrue);
    // The LAN-HTTPS invariant: no other host is granted cleartext.
    expect(xml.contains('0.0.0.0'), isFalse);
  });

  test('manifest wires the network security config on <application>', () {
    final manifest =
        File('android/app/src/main/AndroidManifest.xml').readAsStringSync();
    expect(
      manifest.contains(
          'android:networkSecurityConfig="@xml/network_security_config"'),
      isTrue,
    );
  });
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/android && flutter test test/network_security_config_test.dart`
Expected: FAIL — file missing / manifest attribute absent.

- [ ] **Step 3: Write minimal implementation**

Create `apps/android/android/app/src/main/res/xml/network_security_config.xml`:

```xml
<?xml version="1.0" encoding="utf-8"?>
<!-- app-10: permit cleartext ONLY for the in-app loopback proxy (127.0.0.1).
     Everything else stays HTTPS-only, preserving the LAN-HTTPS invariant. The
     proxy re-serves CA-pinned HTTPS chapter bytes as plaintext to the native
     player over loopback; ExoPlayer's NetworkSecurityPolicy would otherwise
     throw on the http://127.0.0.1 load. -->
<network-security-config>
    <base-config cleartextTrafficPermitted="false" />
    <domain-config cleartextTrafficPermitted="true">
        <domain includeSubdomains="false">127.0.0.1</domain>
    </domain-config>
</network-security-config>
```

In `apps/android/android/app/src/main/AndroidManifest.xml`, add the attribute to the `<application>` open tag (currently lines 15-18):

```xml
    <application
        android:label="Castwright"
        android:name="${applicationName}"
        android:networkSecurityConfig="@xml/network_security_config"
        android:icon="@mipmap/ic_launcher">
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/android && flutter test test/network_security_config_test.dart`
Expected: PASS (both tests).

- [ ] **Step 5: Commit**

```bash
git add apps/android/android/app/src/main/res/xml/network_security_config.xml apps/android/android/app/src/main/AndroidManifest.xml apps/android/test/network_security_config_test.dart
git commit -m "feat(app): scope Android cleartext to 127.0.0.1 for the loopback proxy"
```

---

## Task 4: Engine error seam (`AudioEngine.errorStream`)

**Files:**
- Modify: `apps/android/lib/src/data/audio_engine.dart`
- Modify: `apps/android/lib/src/data/just_audio_engine.dart`
- Modify: `apps/android/lib/src/demo/demo_audio_engine.dart`
- Modify (add `errorStream` to fakes): `apps/android/test/data/player_controller_test.dart`, `test/data/player_controller_playing_stream_test.dart`, `test/data/companion_runtime_test.dart`, `test/data/companion_audio_handler_test.dart`
- Test: `apps/android/test/data/player_controller_test.dart` (the fake gains `emitError`, used by Task 7)

**Interfaces:**
- Produces: `Stream<Object> get errorStream;` on `AudioEngine`. `JustAudioEngine` maps `just_audio`'s `playbackEventStream` error events onto it; demo/fake engines emit nothing but expose a hook for controller tests.

- [ ] **Step 1: Add the interface method + a failing fake hook**

In `apps/android/lib/src/data/audio_engine.dart`, add to the abstract class (after `completionStream`):

```dart
  /// Fires when the underlying player reports a load/playback error (e.g. a
  /// failed loopback fetch mid-stream — `app-10`). Drives the streaming
  /// fallback in [PlayerController]. Empty on engines that never error.
  Stream<Object> get errorStream;
```

In `apps/android/test/data/player_controller_test.dart`, extend `FakeAudioEngine` with an error controller + emitter (add fields near the other controllers, the getter, and dispose):

```dart
  final _errorCtl = StreamController<Object>.broadcast();
  @override
  Stream<Object> get errorStream => _errorCtl.stream;
  void emitError(Object e) => _errorCtl.add(e);
```

Add `await _errorCtl.close();` inside `FakeAudioEngine.dispose()`.

- [ ] **Step 2: Run analyze to verify it fails**

Run `flutter analyze` (NOT a single-file `flutter test` — that compiles only that file's transitive imports, where the local `FakeAudioEngine` already has `errorStream`, so it would pass and hide the gap).

Run: `cd apps/android && flutter analyze`
Expected: FAIL — `just_audio_engine.dart`, `demo_audio_engine.dart`, and the other three test fakes are missing the `errorStream` override (`missing_concrete_implementation` / non-abstract-class errors).

- [ ] **Step 3: Implement across every `AudioEngine`**

`apps/android/lib/src/data/just_audio_engine.dart` — add an error controller fed from `playbackEventStream`'s error channel, the getter, and close on dispose. Change the private constructor body and add fields:

```dart
  final _errors = StreamController<Object>.broadcast();

  JustAudioEngine._(this._loudness)
      : _player = AudioPlayer(
          audioPipeline: AudioPipeline(androidAudioEffects: [_loudness]),
        ) {
    // just_audio surfaces load/playback failures on playbackEventStream's error
    // channel (a PlayerException). Route them to errorStream for the app-10
    // streaming fallback. The listener never cancels — it lives with the engine.
    _player.playbackEventStream.listen(
      (_) {},
      onError: (Object e, StackTrace _) {
        if (!_errors.isClosed) _errors.add(e);
      },
    );
  }
```

Add the getter:

```dart
  @override
  Stream<Object> get errorStream => _errors.stream;
```

Change `dispose`:

```dart
  @override
  Future<void> dispose() async {
    await _errors.close();
    await _player.dispose();
  }
```

`apps/android/lib/src/demo/demo_audio_engine.dart` — add an empty broadcast getter:

```dart
  @override
  Stream<Object> get errorStream => const Stream<Object>.empty();
```

Add the same `errorStream` getter (empty stream, or a controller with an `emitError` hook if the test drives errors) to the remaining fakes: `DrivableEngine` (`test/data/player_controller_playing_stream_test.dart`), `_FakeAudioEngine` (`test/data/companion_runtime_test.dart`), `FakeAudioEngine` (`test/data/companion_audio_handler_test.dart`). For fakes that don't drive errors, `Stream<Object> get errorStream => const Stream<Object>.empty();` suffices. Confirm completeness with:

```bash
cd apps/android && grep -rln "implements AudioEngine" lib test
```

Every hit must now declare `errorStream`.

- [ ] **Step 4: Run the suites to verify green**

Run: `cd apps/android && flutter test test/data/player_controller_test.dart test/data/player_controller_playing_stream_test.dart test/data/companion_runtime_test.dart test/data/companion_audio_handler_test.dart`
Expected: PASS (behaviour unchanged; the seam compiles everywhere).

- [ ] **Step 5: Commit**

```bash
git add apps/android/lib/src/data/audio_engine.dart apps/android/lib/src/data/just_audio_engine.dart apps/android/lib/src/demo/demo_audio_engine.dart apps/android/test/data/player_controller_test.dart apps/android/test/data/player_controller_playing_stream_test.dart apps/android/test/data/companion_runtime_test.dart apps/android/test/data/companion_audio_handler_test.dart
git commit -m "feat(app): add an error stream seam to AudioEngine for streaming fallback"
```

---

## Task 5: Reachability (`onHomeLan`)

**Files:**
- Modify: `apps/android/lib/src/data/network_info.dart`
- Test: `apps/android/test/data/loopback_reachability_test.dart` (create) + extend `apps/android/test/domain/playback_source_test.dart`

**Interfaces:**
- Consumes: `NetworkType` (`sync_gate.dart:7`), `currentNetwork` (`network_info.dart:22`).
- Produces:
  - `typedef CurrentNetwork = Future<NetworkType> Function();`
  - `class Reachability { const Reachability(CurrentNetwork); Future<bool> onHomeLan(); }`

- [ ] **Step 1: Write the failing test**

Create `apps/android/test/data/loopback_reachability_test.dart`:

```dart
import 'package:flutter_test/flutter_test.dart';
import 'package:castwright/src/data/network_info.dart';
import 'package:castwright/src/domain/sync_gate.dart';

void main() {
  Reachability r(NetworkType n) => Reachability(() async => n);

  test('onHomeLan true on unmetered + metered Wi-Fi', () async {
    expect(await r(NetworkType.wifiUnmetered).onHomeLan(), isTrue);
    expect(await r(NetworkType.wifiMetered).onHomeLan(), isTrue);
  });

  test('onHomeLan false on mobile AND offline (NOT `!= mobile`)', () async {
    expect(await r(NetworkType.mobile).onHomeLan(), isFalse);
    expect(await r(NetworkType.offline).onHomeLan(), isFalse);
  });
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/android && flutter test test/data/loopback_reachability_test.dart`
Expected: FAIL — `Reachability` not defined.

- [ ] **Step 3: Write minimal implementation**

In `apps/android/lib/src/data/network_info.dart`, add (after `currentNetwork`):

```dart
/// The current-network resolver seam (injectable for tests).
typedef CurrentNetwork = Future<NetworkType> Function();

/// Answers "is the paired server plausibly reachable on THIS network?" for the
/// `app-10` streaming decision. True on any Wi-Fi/Ethernet (metered or not),
/// false on mobile AND offline. Deliberately NOT `network != mobile` — that is
/// true when offline, which would route an offline tap to a doomed LAN stream.
class Reachability {
  const Reachability(this._currentNetwork);
  final CurrentNetwork _currentNetwork;

  Future<bool> onHomeLan() async {
    final n = await _currentNetwork();
    return n == NetworkType.wifiUnmetered || n == NetworkType.wifiMetered;
  }
}
```

- [ ] **Step 4: Run test to verify it passes; extend the source truth-table**

Run: `cd apps/android && flutter test test/data/loopback_reachability_test.dart`
Expected: PASS.

Then add a group to `apps/android/test/domain/playback_source_test.dart` documenting the `onHomeLan → resolvePlaybackSource` composition (offline ⇒ `onHomeLan false` ⇒ needs-download):

```dart
  group('onHomeLan feeds resolvePlaybackSource', () {
    test('offline (onHomeLan false) + streaming on -> needs download', () {
      expect(
        resolvePlaybackSource(
            localFileExists: false, onHomeLan: false, streamingEnabled: true),
        PlaybackSource.needsDownload,
      );
    });
  });
```

Run: `cd apps/android && flutter test test/domain/playback_source_test.dart`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/android/lib/src/data/network_info.dart apps/android/test/data/loopback_reachability_test.dart apps/android/test/domain/playback_source_test.dart
git commit -m "feat(app): add onHomeLan reachability for the streaming decision"
```

---

## Task 6: Data plumbing — carry `audioUrl` through the playlist

**Files:**
- Modify: `apps/android/lib/src/data/player_controller.dart:16-27` (`PlayableChapter`)
- Modify: `apps/android/lib/src/data/sync_controller.dart:186-199` (`playlistFor`)
- Test: `apps/android/test/data/sync_controller_test.dart` (extend)

**Interfaces:**
- Produces: `PlayableChapter.audioUrl` (`String?`) — the full server path for streaming. `playlistFor` copies `c.audioUrl` from the manifest chapter onto each `PlayableChapter`.

- [ ] **Step 1: Write the failing test**

Add to `apps/android/test/data/sync_controller_test.dart` (a test that `playlistFor` carries `audioUrl`). Locate the existing detail-building helper in that file and add:

```dart
  test('playlistFor carries audioUrl through the projection', () async {
    // Arrange a SyncController whose in-session detail has a rendered chapter
    // with a known audioUrl, then assert the PlayableChapter carries it.
    // (Mirror the existing test setup in this file for building `detail`.)
    final detail = SyncManifestBookDetail(
      schemaVersion: 1,
      bookId: 'bk',
      updatedAt: '',
      chapters: const [
        SyncManifestChapter(
          uuid: 'u1',
          id: 1,
          title: 'One',
          fingerprint: 'abc|123',
          urlSuffix: 'audio.mp3',
          audioUrl: '/api/books/bk/chapters/1/audio.mp3',
          durationSec: 42,
        ),
      ],
      activeChapterUuids: const ['u1'],
    );
    final sync = makeSyncControllerWithDetail('bk', detail); // existing helper or inline construct
    final list = sync.playlistFor('bk');
    expect(list.single.audioUrl, '/api/books/bk/chapters/1/audio.mp3');
  });
```

> Implementation note for the engineer: `sync_controller_test.dart` already constructs `SyncController` and seeds `_details` via a fetched `bookDetail`. Reuse whatever seeding pattern that file uses (e.g. `downloadBook`/`ensureDetail` against a fake `ManifestApi`) rather than a new helper if one isn't present — the assertion (`list.single.audioUrl == …`) is the point.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/android && flutter test test/data/sync_controller_test.dart`
Expected: FAIL — `PlayableChapter` has no `audioUrl` getter.

- [ ] **Step 3: Write minimal implementation**

In `apps/android/lib/src/data/player_controller.dart`, widen `PlayableChapter`:

```dart
class PlayableChapter {
  const PlayableChapter({
    required this.uuid,
    required this.path,
    this.title = '',
    this.durationSec,
    this.audioUrl,
  });
  final String uuid;
  final String path;
  final String title;
  final double? durationSec;

  /// Full server path for LAN streaming (`app-10`), e.g.
  /// `/api/books/<id>/chapters/<n>/audio.mp3`. Null when the chapter has no
  /// rendered audio (never added to a playlist in that case).
  final String? audioUrl;
}
```

In `apps/android/lib/src/data/sync_controller.dart`, carry it in `playlistFor`:

```dart
        if (c.hasAudio)
          PlayableChapter(
            uuid: c.uuid,
            path: _library.audioPath(bookId, c.uuid, c.urlSuffix!),
            title: c.title,
            durationSec: c.durationSec,
            audioUrl: c.audioUrl,
          ),
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/android && flutter test test/data/sync_controller_test.dart`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/android/lib/src/data/player_controller.dart apps/android/lib/src/data/sync_controller.dart apps/android/test/data/sync_controller_test.dart
git commit -m "feat(app): carry chapter audioUrl through the player playlist"
```

---

## Task 7: `PlayerController` streaming wiring + failure routing

**Files:**
- Modify: `apps/android/lib/src/data/player_controller.dart` (constructor, `_loadIndex`, new `_loadSource`/`_handleStreamFailure`, `StreamingConfig`)
- Test: `apps/android/test/data/player_controller_test.dart` (add a streaming group)

**Interfaces:**
- Consumes: `LoopbackProxy` (Task 2), `Reachability`/closures (Task 5), `PlayableChapter.audioUrl` (Task 6), `AudioEngine.errorStream` + `FakeAudioEngine.emitError` (Task 4), `resolvePlaybackSource` (`playback_source.dart`).
- Produces:
  - `class StreamingConfig { fileStore, streamOverLan, onHomeLan, urlResolver, proxy, onRepairNeeded }`
  - `PlayerController({ …, StreamingConfig? streaming })`
  - `Stream<String> get needsDownloadStream` (emits the chapter uuid that couldn't stream / needs downloading).

- [ ] **Step 1: Write the failing tests**

Add a group to `apps/android/test/data/player_controller_test.dart`. First, a tiny fake proxy + config builder near the top of the file:

```dart
class FakeProxy implements LoopbackProxy {
  int starts = 0;
  final List<Uri> registered = [];
  int? lastUpstreamStatus;
  int clears = 0;
  bool disposed = false;

  @override
  Future<void> start() async => starts++;
  @override
  Uri register({required Uri upstream}) {
    registered.add(upstream);
    return Uri.parse('http://127.0.0.1:9/s/id');
  }
  @override
  void clearMapping() => clears++;
  @override
  Future<void> dispose() async => disposed = true;
}
```

(Import `package:castwright/src/data/loopback_proxy.dart`, `.../network_info.dart`, `.../file_store.dart`, `.../domain/playback_source.dart` at the top.)

Then the tests:

```dart
  group('app-10 streaming', () {
    Future<StreamingConfig> cfg(
      FakeProxy proxy, {
      required bool streamOn,
      required bool onLan,
      Set<String> downloaded = const {},
      void Function()? onRepair,
    }) async {
      final fs = InMemoryFileStore();
      for (final p in downloaded) {
        await fs.writeBytes(p, const [0]); // seed as "exists"
      }
      return StreamingConfig(
        fileStore: fs,
        streamOverLan: () => streamOn,
        onHomeLan: () async => onLan,
        urlResolver: (path) => Uri.parse('https://lan:8443$path'),
        proxy: proxy,
        onRepairNeeded: onRepair ?? () {},
      );
    }

    List<PlayableChapter> list = const [
      PlayableChapter(uuid: 'u1', path: '/b1/u1/audio.mp3', audioUrl: '/api/books/b1/chapters/1/audio.mp3'),
    ];

    test('downloaded chapter plays the local file (proxy never starts)', () async {
      final engine = FakeAudioEngine();
      final proxy = FakeProxy();
      final pc = PlayerController(
        audioEngine: engine,
        playbackStore: MemPlaybackStore(),
        playlistLoader: (_) async => list,
        clock: () => DateTime.utc(2026, 6, 6),
        streaming: await cfg(proxy, streamOn: true, onLan: true, downloaded: {'/b1/u1/audio.mp3'}),
      );
      await pc.openBook('b1');
      expect(engine.calls, contains('set:/b1/u1/audio.mp3'));
      expect(proxy.starts, 0);
    });

    test('undownloaded + streaming + on Wi-Fi -> proxy start + register + stream (no headers)', () async {
      final engine = FakeAudioEngine();
      final proxy = FakeProxy();
      final pc = PlayerController(
        audioEngine: engine,
        playbackStore: MemPlaybackStore(),
        playlistLoader: (_) async => list,
        clock: () => DateTime.utc(2026, 6, 6),
        streaming: await cfg(proxy, streamOn: true, onLan: true),
      );
      await pc.openBook('b1');
      expect(proxy.starts, 1);
      expect(proxy.registered.single.toString(),
          'https://lan:8443/api/books/b1/chapters/1/audio.mp3');
      expect(engine.calls, contains('stream:http://127.0.0.1:9/s/id'));
    });

    test('toggle off / off-Wi-Fi -> needs download, proxy never starts', () async {
      for (final c in [
        await cfg(FakeProxy(), streamOn: false, onLan: true),
        await cfg(FakeProxy(), streamOn: true, onLan: false),
      ]) {
        final engine = FakeAudioEngine();
        final pc = PlayerController(
          audioEngine: engine,
          playbackStore: MemPlaybackStore(),
          playlistLoader: (_) async => list,
          clock: () => DateTime.utc(2026, 6, 6),
          streaming: c,
        );
        final emitted = <String>[];
        pc.needsDownloadStream.listen(emitted.add);
        await pc.playChapter('u1'); // user-initiated
        await Future<void>.delayed(Duration.zero);
        expect(engine.calls.where((x) => x.startsWith('stream:')), isEmpty);
        expect(emitted, ['u1']); // user-initiated prompt
      }
    });

    test('errorStream with lastUpstreamStatus 404 -> needs-download, clears mapping, no re-pair', () async {
      final engine = FakeAudioEngine();
      final proxy = FakeProxy()..lastUpstreamStatus = 404;
      var repaired = 0;
      final pc = PlayerController(
        audioEngine: engine,
        playbackStore: MemPlaybackStore(),
        playlistLoader: (_) async => list,
        clock: () => DateTime.utc(2026, 6, 6),
        streaming: await cfg(proxy, streamOn: true, onLan: true, onRepair: () => repaired++),
      );
      final emitted = <String>[];
      pc.needsDownloadStream.listen(emitted.add);
      await pc.playChapter('u1'); // streams
      engine.emitError('boom');
      await Future<void>.delayed(Duration.zero);
      expect(emitted, ['u1']);
      expect(proxy.clears, greaterThanOrEqualTo(1));
      expect(repaired, 0);
    });

    test('errorStream with lastUpstreamStatus 401 -> onRepairNeeded, no download prompt', () async {
      final engine = FakeAudioEngine();
      final proxy = FakeProxy()..lastUpstreamStatus = 401;
      var repaired = 0;
      final pc = PlayerController(
        audioEngine: engine,
        playbackStore: MemPlaybackStore(),
        playlistLoader: (_) async => list,
        clock: () => DateTime.utc(2026, 6, 6),
        streaming: await cfg(proxy, streamOn: true, onLan: true, onRepair: () => repaired++),
      );
      final emitted = <String>[];
      pc.needsDownloadStream.listen(emitted.add);
      await pc.playChapter('u1');
      engine.emitError('boom');
      await Future<void>.delayed(Duration.zero);
      expect(repaired, 1);
      expect(emitted, isEmpty);
    });

    test('auto-advance into a needs-download chapter halts quietly (no play/stream)', () async {
      // ch1 downloaded, ch2 not; streaming OFF so ch2 resolves to needsDownload.
      final engine = FakeAudioEngine();
      final proxy = FakeProxy();
      const two = [
        PlayableChapter(uuid: 'u1', path: '/b1/u1.mp3', audioUrl: '/api/books/b1/chapters/1/audio.mp3'),
        PlayableChapter(uuid: 'u2', path: '/b1/u2.mp3', audioUrl: '/api/books/b1/chapters/2/audio.mp3'),
      ];
      final pc = PlayerController(
        audioEngine: engine,
        playbackStore: MemPlaybackStore(),
        playlistLoader: (_) async => two,
        clock: () => DateTime.utc(2026, 6, 6),
        streaming: await cfg(proxy, streamOn: false, onLan: true, downloaded: {'/b1/u1.mp3'}),
      );
      await pc.openBook('b1'); // loads u1 (downloaded local file)
      await pc.play();
      engine.calls.clear();
      engine.emitCompletion(); // end of u1 -> _advance into u2 (needsDownload)
      await Future<void>.delayed(Duration.zero);
      // No new source loaded and no play() on the quiet-halt path.
      expect(
        engine.calls.where((x) =>
            x.startsWith('set:') || x.startsWith('stream:') || x == 'play'),
        isEmpty,
      );
    });

    test('dispose disposes the proxy', () async {
      final proxy = FakeProxy();
      final pc = PlayerController(
        audioEngine: FakeAudioEngine(),
        playbackStore: MemPlaybackStore(),
        playlistLoader: (_) async => list,
        clock: () => DateTime.utc(2026, 6, 6),
        streaming: await cfg(proxy, streamOn: true, onLan: true),
      );
      await pc.dispose();
      expect(proxy.disposed, isTrue);
    });
  });
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd apps/android && flutter test test/data/player_controller_test.dart`
Expected: FAIL — `StreamingConfig` / `streaming:` / `needsDownloadStream` undefined.

- [ ] **Step 3: Implement**

In `apps/android/lib/src/data/player_controller.dart`:

Add imports at the top:

```dart
import '../domain/playback_source.dart';
import 'file_store.dart';
import 'loopback_proxy.dart';
```

Add the config type (near `PlayableChapter`):

```dart
/// The `app-10` streaming dependencies, bundled so [PlayerController]'s
/// constructor stays backward-compatible: when this is null the controller keeps
/// its exact offline-first behaviour (always `setFilePath`). All-or-nothing —
/// the runtime always supplies every field together.
class StreamingConfig {
  const StreamingConfig({
    required this.fileStore,
    required this.streamOverLan,
    required this.onHomeLan,
    required this.urlResolver,
    required this.proxy,
    required this.onRepairNeeded,
  });

  final FileStore fileStore;
  final bool Function() streamOverLan; // live toggle (re-read per load)
  final Future<bool> Function() onHomeLan;
  final Uri Function(String path) urlResolver;
  final LoopbackProxy proxy;
  final void Function() onRepairNeeded;
}
```

Add the constructor param + field + error subscription. In the constructor parameter list add `this._streaming,` (after `this._localDate,`), add the field, and subscribe to `errorStream`:

```dart
  final StreamingConfig? _streaming;
  StreamSubscription<Object>? _errorSub;
  bool _currentIsStream = false;

  final StreamController<String> _downloadToPlay =
      StreamController<String>.broadcast();
  /// Emits the chapter uuid the user tried to play that must be downloaded first
  /// (or whose LAN stream failed for a non-auth reason). The UI shows the
  /// one-line "download to play" message.
  Stream<String> get needsDownloadStream => _downloadToPlay.stream;
```

In the constructor body (after `_playingSub = …`):

```dart
    if (_streaming != null) {
      // Mid-stream failure channel (§6). `_handleStreamFailure` self-guards on
      // `_currentIsStream`, so a local-file playback error no-ops and a single
      // failure can't be routed twice (this errorStream event AND the initial-load
      // `catch` in `_loadSource` can both fire — the guard makes it idempotent).
      _errorSub = _engine.errorStream.listen((_) => _handleStreamFailure());
    }
```

> Constructor-signature note: add `this._streaming,` as an **initializing formal** inside the existing named-optional `{ }` block, exactly like the current `this._statsDb,` / `this._sessionId,` / `this._localDate,` (which ARE named-optional initializing formals — confirmed against the live `companion_runtime.dart:161-174` call site that passes `statsDb:` / `sessionId:` / `localDate:`). Do NOT also declare a separate `StreamingConfig? streaming` param or a manual `_streaming = streaming` initializer — an initializing formal and a manual initializer for the same field is a compile error. The underscore is auto-stripped, so call sites read `streaming: …`.

Change `_loadIndex` to return whether a source actually loaded, thread `userInitiated`, and gate the post-load engine calls (speed/boost/seek) on a real load so a `needsDownload` resolution doesn't mutate the PREVIOUS still-loaded source. Signature + early return:

```dart
  Future<bool> _loadIndex(int index, {int seekMs = 0, bool userInitiated = false}) async {
    if (index < 0 || index >= _playlist.length) return false;
```

Replace the single `await _engine.setFilePath(c.path);` line (currently `player_controller.dart:280`) and the speed/boost/seek block that follows it with:

```dart
    final loaded = await _loadSource(c, userInitiated: userInitiated);
    if (loaded) {
      if (_speed != 1.0) await _engine.setSpeed(_speed); // persist across chapters
      if (_boostDb > 0) await _engine.setVolumeBoost(_boostDb);
      if (seekMs > 0) await _engine.seek(Duration(milliseconds: seekMs));
    }
```

At the end of `_loadIndex` (after the `_bookReplayed` emit), `return loaded;`.

Update the callers to pass `userInitiated` and gate `play()` on the load result (so an auto-advance or a user tap into a `needsDownload` chapter halts quietly instead of replaying the prior chapter):
- `openBook` → `await _loadIndex(index, seekMs: saved?.positionMs ?? 0, userInitiated: true);` (openBook does not auto-play; return ignored).
- `playChapter` → `final loaded = await _loadIndex(i, userInitiated: true); if (loaded) await play();`
- `skip`'s `ChapterStep` branch → `await _loadIndex(next, userInitiated: true);` (skip never calls `play()`; return ignored).
- `_advance` → `final loaded = await _loadIndex(_index + 1); if (loaded) await play();` (default `userInitiated: false`).

Add the resolver + failure router:

```dart
  /// Loads the chapter's playback source. Returns true iff a source was actually
  /// set on the engine (local file or a live stream); false for `needsDownload`,
  /// a null `audioUrl`, or a failed stream — callers skip `play()` on false.
  Future<bool> _loadSource(PlayableChapter c, {required bool userInitiated}) async {
    final cfg = _streaming;
    if (cfg == null) {
      _currentIsStream = false;
      await _engine.setFilePath(c.path); // legacy: offline-first only
      return true;
    }
    final src = resolvePlaybackSource(
      localFileExists: await cfg.fileStore.exists(c.path),
      onHomeLan: await cfg.onHomeLan(),
      streamingEnabled: cfg.streamOverLan(),
    );
    switch (src) {
      case PlaybackSource.localFile:
        _currentIsStream = false;
        await _engine.setFilePath(c.path);
        return true;
      case PlaybackSource.lanStream:
        final audioUrl = c.audioUrl;
        if (audioUrl == null) {
          _currentIsStream = false;
          if (userInitiated) _notifyDownloadToPlay();
          return false;
        }
        await cfg.proxy.start(); // first bind, on demand
        final loopback = cfg.proxy.register(upstream: cfg.urlResolver(audioUrl));
        _currentIsStream = true;
        try {
          // The player only ever sees http://127.0.0.1/… and NO headers.
          await _engine.setStreamUrl(loopback.toString());
          return true;
        } catch (_) {
          _handleStreamFailure(); // initial-load throw channel (§6/§7)
          return false;
        }
      case PlaybackSource.needsDownload:
        _currentIsStream = false;
        if (userInitiated) _notifyDownloadToPlay(); // else auto-advance: halt quietly
        return false;
    }
  }

  /// The single §7 failure router (shared by the initial-load throw and the
  /// mid-stream errorStream event). Self-guards on `_currentIsStream` so it is
  /// idempotent per stream load AND no-ops on a local-file error: reads the
  /// proxy's upstream-status side-channel, clears the mapping, and either re-pairs
  /// (fresh 401/403) or surfaces "download to play" (everything else, incl. null).
  /// No auto-retry.
  void _handleStreamFailure() {
    final cfg = _streaming;
    if (cfg == null) return;
    if (!_currentIsStream) return; // not streaming, or already handled
    _currentIsStream = false;
    final status = cfg.proxy.lastUpstreamStatus;
    cfg.proxy.clearMapping();
    if (status == 401 || status == 403) {
      cfg.onRepairNeeded();
    } else {
      _notifyDownloadToPlay();
    }
  }

  void _notifyDownloadToPlay() {
    final uuid = currentChapterUuid;
    if (uuid != null && !_downloadToPlay.isClosed) _downloadToPlay.add(uuid);
  }
```

In `dispose()`, cancel the error sub, close the stream, and dispose the proxy (add before `await _engine.dispose();`):

```dart
    await _errorSub?.cancel();
    await _downloadToPlay.close();
    await _streaming?.proxy.dispose();
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd apps/android && flutter test test/data/player_controller_test.dart`
Expected: PASS (existing tests unchanged + the new streaming group green).

- [ ] **Step 5: Commit**

```bash
git add apps/android/lib/src/data/player_controller.dart apps/android/test/data/player_controller_test.dart
git commit -m "feat(app): wire LAN streaming + failure fallback into PlayerController"
```

---

## Task 8: Runtime + app-shell wiring (`onRepairNeeded` → pairing)

**Files:**
- Modify: `apps/android/lib/src/data/companion_runtime.dart` (build + inject `StreamingConfig`; accept an `onRepairNeeded`)
- Modify: `apps/android/lib/main.dart` (pass the re-pair entry into the runtime)
- Test: `apps/android/test/data/companion_runtime_test.dart` (the forDemo path stays green; add a smoke test that a runtime built with a StreamingConfig still wires finished-tracking)

**Interfaces:**
- Consumes: `PlayerController.streaming`, `LoopbackProxy`, `Reachability`, `ApiClient.pinnedRangeStream`.
- Produces: `CompanionRuntime.forConnection(connection, {handler, onRepairNeeded})` — the `onRepairNeeded` reaches `main.dart`'s `_openPairing`.

> This task is **device glue** (`CompanionRuntime.forConnection` is explicitly "exercised on a device, not in unit tests"). Keep the testable surface minimal: the wiring compiles + the existing runtime tests stay green; behaviour is validated on-device.

- [ ] **Step 1: Add the `onRepairNeeded` parameter (failing compile at call site)**

In `apps/android/lib/src/data/companion_runtime.dart`, change the `forConnection` signature:

```dart
  static Future<CompanionRuntime> forConnection(
    Connection connection, {
    CompanionAudioHandler? handler,
    void Function()? onRepairNeeded,
  }) async {
```

- [ ] **Step 2: Build the `StreamingConfig` and inject it into the player**

In `forConnection`, after `final fs = const DiskFileStore();` is available and the `resolve` closure is defined, construct the proxy + config and pass it to the `PlayerController`:

```dart
    final proxy = LoopbackProxy(api.pinnedRangeStream);
    // Settings are loaded below; read the live toggle via a closure so a runtime
    // settings change takes effect on the next chapter load.
    late final CompanionRuntime runtimeRef; // for the live settings read
```

Because `settings` is loaded *after* the player is currently constructed, reorder so `settingsStore.load()` runs before building the `PlayerController`, then pass:

```dart
    final settingsStore = SettingsStore(fs, path: '$root/settings.json');
    final settings = await settingsStore.load();

    final proxy = LoopbackProxy(api.pinnedRangeStream);
    final player = PlayerController(
      audioEngine: JustAudioEngine(),
      playbackStore: library,
      playlistLoader: (bookId) async => sync.playlistFor(bookId),
      clock: DateTime.now,
      statsDb: db,
      sessionId: sessionId,
      localDate: () { /* unchanged */ },
      streaming: StreamingConfig(
        fileStore: fs,
        streamOverLan: () => runtimeRef.settings.streamOverLan,
        onHomeLan: const Reachability(currentNetwork).onHomeLan,
        urlResolver: resolve,
        proxy: proxy,
        onRepairNeeded: onRepairNeeded ?? () {},
      ),
    );
```

Then assign `runtimeRef` when the runtime is constructed at the end (so the `streamOverLan` closure reads the live, mutable `settings` field). The simplest robust form: capture the runtime in a local after `CompanionRuntime._(...)` is built and before returning:

```dart
    final runtime = CompanionRuntime._(api, library, sync, player, thumbnails,
        settingsStore, settings, resumeSync, sleepTimer, handler,
        [connectivitySub, ...finishedSubs]);
    runtimeRef = runtime;
    return runtime;
```

> Note: `settingsStore`/`settings` currently sit *below* the player build (`companion_runtime.dart:183-184`); this task moves those two lines above the player construction. The subsequent `await player.setSpeed(settings.defaultSpeed)` etc. block stays where it is. Verify the file still reads top-to-bottom with `settings` defined before first use.

Add the imports at the top of `companion_runtime.dart`:

```dart
import 'loopback_proxy.dart';
// network_info.dart is already imported (currentNetwork); add Reachability use.
```

(`network_info.dart` is already imported at `companion_runtime.dart:17`, so `Reachability` is in scope.)

- [ ] **Step 3: Thread `onRepairNeeded` from `main.dart`**

In `apps/android/lib/main.dart`, the widget already has `_openPairing`. Pass it into the runtime build (`main.dart:245-246`):

```dart
      final runtime = await CompanionRuntime.forConnection(
        conn,
        handler: widget.audioHandler,
        onRepairNeeded: () => _openPairing(),
      );
```

`_openPairing` is idempotent (`if (_pairingOpen) return;`), so a burst of stream errors can't stack pairing screens.

- [ ] **Step 4: Run the runtime + shell suites**

Run: `cd apps/android && flutter test test/data/companion_runtime_test.dart test/ui/runtime_override_test.dart test/main_deep_link_test.dart`
Expected: PASS — `forDemo` path is unchanged (no `onRepairNeeded`), and the new named param is optional.

Then the full app suite:

Run: `cd apps/android && flutter test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/android/lib/src/data/companion_runtime.dart apps/android/lib/main.dart apps/android/test/data/companion_runtime_test.dart
git commit -m "feat(app): wire the loopback proxy + re-pair callback into the runtime"
```

---

## Task 9: Docs reconciliation + release notes

**Files:**
- Modify: `docs/features/188-android-companion-app.md:52` + its `app-10` narrative
- Modify: `docs/release-notes-next.md`, `RELEASE_NOTES.md`

**Interfaces:** None (docs). Do this at ship time (in the same PR as the code).

- [ ] **Step 1: Reconcile plan 188**

The `app-10` row (`docs/features/188-android-companion-app.md:52`) currently reads as `closed #553 … 4 paired Dart tests` — factually wrong (the feature shipped as inert scaffolding and #553 was reopened as BLOCKED). Update the row to state that `app-10` was blocked by the companion's app-pinned-CA-vs-platform-player TLS gap and is now delivered via the in-app loopback proxy (link the spec + this plan), with the new component set (`LoopbackProxy`, `pinnedRangeStream`, `network_security_config.xml`, engine error seam) and the paired Dart tests from Tasks 1-8. Add the on-device acceptance walkthrough (below) to its `app-10` section.

- [ ] **Step 2: Add the on-device acceptance walkthrough**

Under the `app-10` narrative, add: real Android phone on home Wi-Fi, undownloaded chapter, "Stream over LAN" on → tap play → instant start; seek mid-chapter; lock-screen transport controls; background survival via the media foreground service; confirm NO OS cert install prompt; then toggle off / leave Wi-Fi → tap the same chapter → "download to play" message (no stall).

- [ ] **Step 3: Release notes**

Append to `docs/release-notes-next.md` (technical register, ref this PR):

```markdown
- **app-10 — Stream-over-LAN instant play (companion).** An undownloaded chapter now plays instantly over the home LAN via an in-app loopback proxy that re-serves CA-pinned HTTPS audio as plaintext to the native player — no OS cert install, token never leaves the app. Failure degrades cleanly to download-to-play (or a re-pair prompt on an expired device token). (#553)
```

Append to the in-progress version section at the top of `RELEASE_NOTES.md` (brand voice):

```markdown
- **Play instantly at home.** Start any chapter you haven't downloaded yet the moment you tap it — as long as you're on your home Wi-Fi with your library server running. Off the home network, we'll nudge you to download it first.
```

- [ ] **Step 4: Commit**

```bash
git add docs/features/188-android-companion-app.md docs/release-notes-next.md RELEASE_NOTES.md
git commit -m "docs(docs): reconcile app-10 to the loopback proxy + release notes"
```

---

## Definition of done

- All of Tasks 1-8 green under `cd apps/android && flutter test` and `flutter analyze` clean (the `app.yml` gate).
- Docs reconciled (Task 9); the `app-10` row no longer claims a false "closed."
- PR body carries `Closes #553`; mandatory `code-review` pass (single-scope `feat(app)` → `medium` effort per model-routing) triaged before merge.
- **On-device Android smoke test is owed to the owner post-merge** (standard app-* "live device acceptance owed"). Reopen #553 only if it fails on a real phone.

## Self-review (writing-plans)

**Spec coverage** — every spec component maps to a task:
- §1 `LoopbackProxy` → Task 2. §2 `pinnedRangeStream` → Task 1. §3 Android config → Task 3. §4 wiring + data plumbing → Tasks 6 (data) + 7 (controller) + 8 (runtime/shell). §5 reachability → Task 5. §6 engine error seam → Task 4. §7 failure/fallback table + re-pair wiring → Task 7 (`_handleStreamFailure`) + Task 8 (`onRepairNeeded` → `_openPairing`). Testing strategy items 1-6 → the per-task tests. Docs reconciliation → Task 9.
- Two spec/impl inconsistencies were resolved and recorded under **Deviations** (register headers → single-point Bearer injection; shared streaming client + subscription-cancel).

**Type consistency** — `PinnedStreamResponse` (Task 1) is consumed by `UpstreamFetch`/`LoopbackProxy` (Task 2) and `ApiClient.pinnedRangeStream` (Tasks 1, 8). `LoopbackProxy` surface (`start`/`register({upstream})`/`lastUpstreamStatus`/`clearMapping`/`dispose`) is used identically by the `FakeProxy` (Task 7) and the runtime (Task 8). `StreamingConfig` fields (Task 7) are constructed with the same names in Task 8. `AudioEngine.errorStream` (Task 4) is subscribed in Task 7. `PlayableChapter.audioUrl` (Task 6) is read in Task 7's `_loadSource`. `Reachability.onHomeLan` (Task 5) is used in Task 8's config.

**Placeholder scan** — no TBD/TODO; every code step carries full code. The one soft spot (Task 6 Step 1's "reuse the file's existing detail-seeding pattern") is called out explicitly with the exact assertion, because `sync_controller_test.dart`'s existing harness should drive the seeding rather than a fabricated helper.

**Adversarial assumption-check (Premium/Opus) — folded 2026-07-12.** The mandatory plan-review gate ran and returned *ready-with-fixes*; all findings were folded before approval:
- **[Major] Real-socket leak on HEAD / non-2xx** — `streamRange` created its response subscription lazily in `onListen`, so `cancel()` on a never-drained body was a no-op and leaked the `HttpClientResponse`. Fixed: subscribe eagerly then `pause()`; `cancel()` now always aborts the real socket (Task 1 Step 3).
- **[Major] Placebo cancel test** — the concurrency test never listened to `a.body`, so `a.cancel()` proved nothing. Fixed: actively read `a` to its first chunk, cancel mid-stream, assert the sibling still completes (Task 1 Step 1, test 2) — this is the spec's core §2 trap, now genuinely verified.
- **[Major] Contradictory constructor instructions** — the note told the engineer to add BOTH `this._streaming` (initializing formal) AND a manual `_streaming = streaming` initializer (a compile error). Fixed: keep only `this._streaming,`, matching the live `this._statsDb` pattern (Task 7 Step 3).
- **[Minor] Task 4 "expected FAIL"** used a single-file `flutter test` that would pass; switched to `flutter analyze`.
- **[Minor] Unused imports** (`dart:convert` in the proxy test) scrubbed to keep `flutter analyze` green.
- **[Minor] Auto-advance quiet-halt** — `_advance` unconditionally called `play()` after a `needsDownload` load; `_loadSource`/`_loadIndex` now return whether a source loaded and callers gate `play()` on it (+ a new auto-advance-halts test).
- **[Minor] Double-route guard** — `_handleStreamFailure` is now idempotent (`if (!_currentIsStream) return`), so the initial-load `catch` and the mid-stream `errorStream` event can't both emit.
- **[Minor] Unawaited seed** — the test `cfg` builder now `await`s `fileStore.writeBytes`.
- **On-device checklist (not plan defects):** the two load-bearing just_audio assumptions — `setAudioSource` rejecting on initial-load failure, and mid-stream errors arriving via `playbackEventStream.listen(onError:)` — plus the §6 `_completionSub`-not-torn-down check, are called out for the on-device acceptance pass (Task 9 walkthrough).
