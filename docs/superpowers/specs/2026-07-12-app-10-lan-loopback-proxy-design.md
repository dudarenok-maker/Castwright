# app-10 — Stream-over-LAN instant play via an in-app loopback proxy

**Status:** design approved (2026-07-12)
**Issue:** [#553](https://github.com/dudarenok-maker/Castwright/issues/553) (`app-10`, reopened twice as BLOCKED)
**Umbrella:** [plan 188 — Android companion app](../../features/188-android-companion-app.md)
**Scope:** `apps/android/` (Flutter companion) + a docs reconciliation. No server changes.

## Problem

`app-10` ("play an undownloaded chapter instantly over the home LAN") shipped as
scaffolding in June 2026 but has been **blocked and inert** ever since — reopened
twice on #553. The pure pieces exist and are unit-tested
(`resolvePlaybackSource`, `AppSettings.streamOverLan`, the settings toggle,
`AudioEngine.setStreamUrl`), but **nothing in production consumes them**, and the
feature cannot be wired under the companion's TLS model:

- The companion trusts the server by **app-level pinning only**: `ApiClient`
  builds a `SecurityContext(withTrustedRoots: false)` and pins the mkcert root CA
  (`api_client.dart:311`). There is deliberately **no OS-level cert install**
  (`README.md:141`).
- `just_audio`'s `AudioSource.uri` streams via the **native OS platform player**
  (ExoPlayer on Android / AVPlayer on iOS), which uses the **OS trust store** —
  not the app's pinned Dart `HttpClient`. Streaming `https://<lan>:8443/…` from
  the platform player therefore **fails TLS validation** (mkcert CA untrusted at
  OS level).

Server auth is **not** the blocker: the audio endpoint
(`GET /api/books/:bookId/chapters/:chapterId/audio.mp3`,
`server/src/routes/chapter-audio.ts:352`) already supports `Accept-Ranges`/`206`
and sits behind the LAN guard, which accepts the `Authorization: Bearer` device
token the app already holds. The recent LAN-HTTPS-default work (plans 225/250)
changed the *server + browser* story (`castwright.local`, `__Host-cw_lan`
cookie, browser trusts the CA at OS level) but did **not** touch the companion's
app-pinned model — so the blocker stands.

## Goal

Make an undownloaded chapter play **instantly over the home LAN** while preserving
both invariants the companion depends on: **app-pinned CA (no OS cert install)**
and **HTTPS-on-LAN (no cleartext audio/token on the wire)**. Offline-first is
unchanged — a downloaded chapter always plays its local file.

**Non-goals (YAGNI):** persistence of the streamed bytes, background-download
coupling, auto-download-after-preview, mDNS discovery, iOS-specific work beyond
what the cross-platform `dart:io` path gives for free, and any server change.

## Chosen approach: in-app loopback TLS-terminating proxy

A tiny `dart:io HttpServer` runs **inside the app**, bound to `127.0.0.1:0`
(OS-assigned ephemeral port, loopback interface only). The platform player streams
**plaintext from loopback**; the proxy re-fetches over HTTPS via the
**already-pinned** client, streaming `Range`/`206` bytes straight through. The
mkcert CA never has to be trusted by the OS, the Bearer token never leaves the
app (the player only ever sees `http://127.0.0.1:<port>/…`), and the plaintext hop
is `127.0.0.1` in-process only.

Rejected alternatives:

- **OS-level cert trust** (install mkcert root in the OS store): least code, but
  breaks the explicit "no OS cert install" design goal, forces a profile-install
  step per device (awkward/limited on iOS), and widens the trust surface. Already
  rejected on #553.
- **Plaintext LAN HTTP for audio**: violates the HTTPS-on-LAN requirement and puts
  chapter bytes + Bearer token on the wire in cleartext. Out of scope.

## Product decisions (locked during brainstorming)

- **Ephemeral preview only.** Streaming plays live from the LAN; nothing is
  persisted. Offline = the existing explicit Download flow (a separate tap). No
  coupling to the downloader.
- **Stream-through, not buffered.** For "instant play" the proxy pipes upstream
  bytes incrementally, honoring the platform player's `Range` requests. Whole-file
  buffering would defeat "instant" and risk OOM on large chapters.
- **Demand-scoped, never a background server.** Nothing binds a socket at app
  launch, on pairing, or while playing downloaded files. The proxy `start()`s only
  on the first resolution to `PlaybackSource.lanStream`, and is disposed with the
  `PlayerController`.
- **No auto-retry on stream failure.** A single clean fallback to "download to
  play" beats a silent retry loop.

## Components

### 1. `LoopbackProxy` (new — `apps/android/lib/src/data/loopback_proxy.dart`)

```dart
class LoopbackProxy {
  Future<void> start();                     // idempotent; binds 127.0.0.1:0
  Uri register({required Uri upstream,      // https://<lan>:8443/api/books/…/audio.mp3
                required Map<String, String> headers});  // {Authorization: Bearer …}
  Future<void> dispose();                   // closes server, clears mappings
}
```

- `register` mints a **128-bit random opaque id** and returns
  `http://127.0.0.1:<port>/s/<id>`. That loopback URL is what we hand to
  `setStreamUrl` — the Bearer token and the real HTTPS URL **never reach the
  platform player**; the proxy injects them on the upstream side.
- **Per-request** (each GET/HEAD on `/s/<id>`):
  1. Unknown/stale id → `404`. Non-GET/HEAD → `405`.
  2. Forward the incoming `Range` header to `ApiClient.pinnedRangeStream`
     (component 2) with the registered Bearer header.
  3. Relay upstream status (`200`/`206`) and pass through `Content-Type`,
     `Content-Length`, `Content-Range`, `Accept-Ranges`; then **pipe the upstream
     body straight through** (no full-file buffering), flushing as bytes arrive.
     `HEAD` relays headers only.
  4. **Client disconnect (seek/stop) → cancel the upstream fetch** so sockets
     don't leak.
- **One active mapping at a time** (single-player app): registering a new chapter
  evicts the prior id, so any stale loopback URL cleanly `404`s.
- **Security:** loopback-only bind + unguessable 128-bit path id + single active
  mapping. Unreachable off-device; unguessable to other local apps; upstream stays
  HTTPS+pinned.

### 2. `ApiClient.pinnedRangeStream` (new sibling — `apps/android/lib/src/data/api_client.dart`)

```dart
Future<PinnedStreamResponse> pinnedRangeStream(Uri url, {String? range});

class PinnedStreamResponse {
  final int statusCode;                  // 200 | 206 | 4xx | 5xx
  final Map<String, String> headers;     // Content-Type/Length/Range, Accept-Ranges
  final Stream<List<int>> body;          // the live HttpClientResponse — NOT drained
  final Future<void> Function() cancel;  // aborts the upstream request
}
```

- Reuses the **same** private pinned-client factory (`_pinnedHttpClient()`,
  `api_client.dart:311`) as every other pinned call — one CA-pinning code path, not
  two. Same `Authorization: Bearer` injection and 2 s `connectionTimeout`.
- `dart:io`'s `HttpClientResponse` **is** a `Stream<List<int>>`, so stream-through
  is native — the proxy receives the undrained response and pipes it. No new
  buffering, no new dependency.
- `4xx/5xx` propagate as status codes for the proxy/controller to act on.
- The buffered `pinnedRangeFetch` (downloader hot path) is **untouched** — we add a
  seam, not a refactor. The two share only the private factory.

### 3. Player-flow wiring (`apps/android/lib/src/data/player_controller.dart`)

`_loadIndex` (currently an unconditional `_engine.setFilePath(c.path)` at
`player_controller.dart:280`) gains the single decision point that consumes the
existing-but-dead `resolvePlaybackSource`:

```dart
final src = resolvePlaybackSource(
  localFileExists:  c.isDownloaded,
  onHomeLan:        _reachability.onHomeLan,
  streamingEnabled: _settings.streamOverLan,
);
switch (src) {
  case PlaybackSource.localFile:
    await _engine.setFilePath(c.path);
  case PlaybackSource.lanStream:
    await _proxy.start();                                   // FIRST bind, on demand
    final loopback = _proxy.register(
      upstream: _resolveUpstream(c),
      headers: {'Authorization': 'Bearer ${_conn.token}'},
    );
    await _engine.setStreamUrl(loopback.toString());         // player sees only 127.0.0.1
  case PlaybackSource.needsDownload:
    _notifyDownloadToPlay();                                 // no silent no-op
}
```

Consequences:

- `PlaybackSource.lanStream` gets its **first and only production consumer**.
- The `settings_screen.dart` "Stream over LAN" toggle **stops being inert** — it now
  gates this branch.
- The accrual caveat at `player_controller.dart:352-355` is honored: while
  streaming, stats accrual is additionally gated on `processingState == ready`, so
  buffering stalls don't inflate listen-time.
- Controller `dispose()` also disposes the proxy — no lingering socket.

### 4. Reachability signal (`onHomeLan`)

Reuse the existing app-8 `NetworkType` probe (`network_info.dart`, currently
unconnected): `onHomeLan = networkType != cellular` (on Wi-Fi/wired). This is a
cheap **attempt gate** — no mandatory network round-trip on the happy path, no
background polling. Whether the paired server is actually on *this* Wi-Fi is settled
by the streaming attempt itself, via the failure path below.

A mandatory pinned reachability pre-probe was considered and rejected: it adds up to
2 s before every stream and duplicates what the first upstream request already
proves.

### 5. Failure / fallback behavior — no silent stalls

The proxy's first upstream request **is** the real reachability test. The engine
error stream drives fallback (no infinite buffer spinner):

| Failure | Where caught | User-visible result |
|---|---|---|
| Server unreachable / timeout (wrong Wi-Fi, server off) | proxy → `502/504` → engine error | Stop; message *"Couldn't stream over LAN — download to play"*; chapter stays needs-download |
| `401/403` (device token expired/revoked) | proxy relays status → controller | Reuse ApiClient's existing **re-pair** path (`api_client.dart:55`) |
| `404/5xx` from server | proxy relays status → engine error | Same "couldn't stream — download" message |
| Toggle off / off-Wi-Fi / downloaded-but-missing file | `resolvePlaybackSource → needsDownload` | *"Download this chapter to play"* — never a silent no-op |

Streaming is best-effort; any failure degrades gracefully to the offline-first
download flow with a clear one-line message. **No auto-retry.**

## Testing strategy

Automated tests run in `app.yml` (`flutter analyze` + `flutter test`) — the only
automated gate for `apps/android/`.

**Automatable (ship in this PR):**

1. **`LoopbackProxy`** — real `dart:io` server on `127.0.0.1:0` against a **fake
   upstream** (injected `pinnedRangeStream` stub; no real TLS needed): `register`
   → loopback URL; unknown id → `404`; non-GET/HEAD → `405`; `Range` forwarded;
   `206` + `Content-Range`/`Length`/`Type`/`Accept-Ranges` relayed; body bytes
   match; `HEAD` = headers only; client disconnect → `cancel()`; new registration
   evicts prior id (old URL → `404`); single active mapping.
2. **`pinnedRangeStream`** — status/headers/stream passthrough, `Bearer` injected,
   `Range` forwarded, `cancel` aborts. (CA-pinning stays covered by the existing
   `cert_pinning`/`api_client` tests — same factory reused.)
3. **`PlayerController` wiring** (fake engine/proxy/reachability/settings):
   downloaded → `setFilePath` (unchanged); undownloaded+on+Wi-Fi →
   `start()`+`register`+`setStreamUrl(loopback)` with **Bearer never passed to the
   engine**; **lazy invariant** — `proxy.start()` never called in
   `localFile`/`needsDownload` branches; toggle off / off-Wi-Fi → `needsDownload`
   message + no proxy start; stream engine-error → fallback message + mapping
   cleared + **no auto-retry**; accrual gated on `processingState == ready`;
   `dispose()` disposes the proxy.
4. **`resolvePlaybackSource`** — extend the existing truth-table test for the
   `networkType → onHomeLan` mapping.

**On-device (the "live device acceptance owed" step — owner):** real phone on home
Wi-Fi, undownloaded chapter, toggle on → instant play, seek, lock-screen controls,
**no OS cert install**; off-LAN → download prompt. This cannot run from a dev box
and is why #553 closes on merge with acceptance owed.

## Docs reconciliation

- **Plan 188** currently mis-states `app-10` as "closed #553" (line 52) — reconcile
  to "wired via in-app loopback proxy," and add the on-device acceptance walkthrough
  to its `app-10` section.
- Two release-notes entries (`docs/release-notes-next.md` technical +
  `RELEASE_NOTES.md` brand-voice) for the in-progress version.

## Acceptance / definition of done

Code-complete + the automated tests above green + docs updated + PR merged (which
closes #553). On-device smoke test is **owed to the owner** post-merge (standard
app-* "live device acceptance owed" pattern); reopen only if it fails on a real
phone.
