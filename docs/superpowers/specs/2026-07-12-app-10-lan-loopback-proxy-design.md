# app-10 — Stream-over-LAN instant play via an in-app loopback proxy

**Status:** design approved (2026-07-12), revised after adversarial assumption-check
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
token the app already holds (`lan-auth.ts:171-183`; a bare Bearer GET with no
cookie is exempt from the CSRF `requireSameOrigin` guard). The recent
LAN-HTTPS-default work (plans 225/250) changed the *server + browser* story
(`castwright.local`, `__Host-cw_lan` cookie, browser trusts the CA at OS level)
but did **not** touch the companion's app-pinned model — so the blocker stands.

## Goal

Make an undownloaded chapter play **instantly over the home LAN** while preserving
both invariants the companion depends on: **app-pinned CA (no OS cert install)**
and **HTTPS-on-LAN (no cleartext audio/token off-device)**. Offline-first is
unchanged — a downloaded chapter always plays its local file.

**Non-goals (YAGNI):** persistence of the streamed bytes, background-download
coupling, auto-download-after-preview, mDNS discovery, and any server change.

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
- **Cross-platform (Android + iOS), iOS unverified.** The `dart:io` path is
  platform-neutral and we ship it unconditionally. Android is validated on-device;
  the iOS backgrounding path is a **known unverified risk** (see Risks) to confirm
  under app-12, not a v1 blocker.

## Components

### 1. `LoopbackProxy` (new — `apps/android/lib/src/data/loopback_proxy.dart`)

```dart
class LoopbackProxy {
  Future<void> start();                     // idempotent; binds 127.0.0.1:0
  Uri register({required Uri upstream,      // https://<lan>:8443/api/books/…/audio.mp3
                required Map<String, String> headers});  // {Authorization: Bearer …}
  int? get lastUpstreamStatus;              // side-channel: the last non-2xx upstream code
  Future<void> dispose();                   // close(force: true), clears mappings
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
  4. On a **non-2xx upstream** (or fetch throw), record it in `lastUpstreamStatus`
     (`0` for a connection/timeout failure) and return an error status to the
     player. This is the **failure side-channel** the controller reads when the
     engine reports an error (component 6) — the platform player collapses upstream
     codes into one opaque error, so the real `401/403` vs `404/5xx` distinction
     can only come from the proxy, not the engine.
  5. **Client disconnect (seek/stop) → cancel the upstream fetch** so sockets
     don't leak.
- **One active mapping at a time** (single-player app): registering a new chapter
  evicts the prior id, so any stale loopback URL cleanly `404`s. This is safe
  against ExoPlayer's *within-chapter* concurrent range connections — they all
  target the same live id and are served independently per-request; a chapter
  switch tears down the old `AudioSource`, so a stale-id `404` is harmless.
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
  final Future<void> Function() cancel;  // aborts THIS request only (see trap below)
}
```

- Reuses the **same** private pinned-client factory (`_pinnedHttpClient()`,
  `api_client.dart:311`) as every other pinned call — one CA-pinning code path, not
  two. Same `Authorization: Bearer` injection and 2 s `connectionTimeout`.
- `dart:io`'s `HttpClientResponse` **is** a `Stream<List<int>>`, so stream-through
  is native — the proxy receives the undrained response and pipes it. No new
  buffering, no new dependency.
- `4xx/5xx` propagate as status codes for the proxy/controller to act on.
- **Implementation trap (must honor):** `cancel()` MUST abort only *this* request
  by holding the `StreamSubscription` from `response.listen(...)` and calling
  `subscription.cancel()` (dart:io tears down that one socket). It MUST NOT call
  `client.close(force: true)` — a `pinnedRangeStream` client is per-call, so
  closing it wouldn't hurt the downloader, but it **would** kill sibling concurrent
  range fetches within the same playback session. Corollary: the proxy must
  manually `.listen()`-and-forward, **not** `response.pipe(httpResponse)` (which
  gives no subscription handle to cancel). The buffered `pinnedRangeFetch`
  (downloader hot path) is **untouched**; the two share only the private factory.

### 3. Android cleartext-to-loopback (new — `apps/android/android/app/src/main/res/xml/network_security_config.xml` + manifest wiring)

**Without this the feature serves zero bytes on Android release builds.** Android
(target SDK ≥ 28, Flutter's default) sets `cleartextTrafficPermitted=false` for
all hosts with no loopback exemption; ExoPlayer's `DefaultHttpDataSource` consults
`NetworkSecurityPolicy` and throws on a cleartext `http://127.0.0.1` load. There is
currently **no** `network_security_config.xml` and **no**
`usesCleartextTraffic`/`networkSecurityConfig` attribute in the manifest.

Fix — a **narrowly loopback-scoped** config (the LAN-HTTPS invariant is preserved
because only `127.0.0.1` is permitted cleartext, nothing else):

```xml
<!-- network_security_config.xml -->
<network-security-config>
  <base-config cleartextTrafficPermitted="false" />
  <domain-config cleartextTrafficPermitted="true">
    <domain includeSubdomains="false">127.0.0.1</domain>
  </domain-config>
</network-security-config>
```

Wire `android:networkSecurityConfig="@xml/network_security_config"` on
`<application>` in `AndroidManifest.xml`.

iOS needs no equivalent: ATS is **not enforced for raw IP-literal hosts** like
`127.0.0.1`, so AVPlayer loads `http://127.0.0.1:<port>` without an `Info.plist`
exception.

### 4. Player-flow wiring + data plumbing (`player_controller.dart`, `sync_controller.dart`, `sync_manifest.dart`/`PlayableChapter`)

This is **more than a single seam** — the current types don't carry what the
streaming branch needs, so three things move together:

**(a) Widen `PlayableChapter` to carry `audioUrl`.** Today `PlayableChapter`
(`player_controller.dart:16-27`) has only `uuid/path/title/durationSec` and no
`isDownloaded`. `SyncManifestChapter` (`lib/src/domain/sync_manifest.dart:90-131`)
already holds `audioUrl` — the **full server path** (`/api/books/$bookId/chapters/
$id/$urlSuffix`, built server-side, used verbatim at `sync_controller.dart:105`).
So the widening is just: carry `audioUrl` on `PlayableChapter` and stop dropping it
in the `playlistFor` projection (`sync_controller.dart:186-199`), which already
emits undownloaded-but-rendered chapters (`c.hasAudio`) with a *local* `path` that
may not exist on disk. `_resolveUpstream(c)` is then `_resolveUrl(c.audioUrl)` — no
`bookId`+`chapterId`+`urlSuffix` re-assembly needed.

**(b) "Downloaded?" is a file-existence check on `c.path`**, not a non-existent
`isDownloaded` flag.

**(c) Expand the `PlayerController` constructor.** It currently injects none of
the streaming deps; add `fileStore` (for the `exists()` check — `file_store.dart`,
not currently injected), `settings` (for `streamOverLan`), a reachability source
(component 5), the connection/token (`ApiClient` or the paired-server token), and
the `LoopbackProxy`. Every existing `PlayerController` test gains fakes for these.

The decision point in `_loadIndex` (`player_controller.dart:280`) then becomes
(note: `_loadIndex` is already `async`, so awaiting the file-existence and
reachability checks is free):

```dart
final src = resolvePlaybackSource(
  localFileExists:  await _fileStore.exists(c.path),
  onHomeLan:        await _reachability.onHomeLan(),  // component 5 (async, cheap)
  streamingEnabled: _settings.streamOverLan,
);
switch (src) {
  case PlaybackSource.localFile:
    await _engine.setFilePath(c.path);
  case PlaybackSource.lanStream:
    await _proxy.start();                            // FIRST bind, on demand
    final loopback = _proxy.register(
      upstream: _resolveUrl(c.audioUrl),             // audioUrl carried through (a)
      headers: {'Authorization': 'Bearer ${_conn.token}'},
    );
    await _engine.setStreamUrl(loopback.toString()); // player sees only 127.0.0.1, no headers
  case PlaybackSource.needsDownload:
    if (userInitiated) _notifyDownloadToPlay();      // prompt only on explicit play
    // else (auto-advance): halt the run quietly — no unprompted download nag
}
```

Consequences:

- `PlaybackSource.lanStream` gets its **first and only production consumer**; the
  `settings_screen.dart` "Stream over LAN" toggle **stops being inert**.
- `_loadIndex` is also reached via `openBook`, `playChapter`, `_advance`
  (auto-advance) and `skip`'s `ChapterStep`. **Auto-advancing into an
  undownloaded chapter over LAN streams it** (desired — seamless listening); but an
  auto-advance into `needsDownload` (off-LAN / toggle off) must **halt quietly**,
  not pop a download prompt mid-listen. The `needsDownload` prompt fires only for a
  **user-initiated** load; tests cover both the auto-advance-streams and
  auto-advance-halts-quietly paths.
- `setStreamUrl` is called with the loopback URL and **no `headers`** (confirmed:
  `just_audio_engine.dart:47` passes `headers: null` → `AudioSource.uri`), so the
  Bearer never reaches the player.
- Controller `dispose()` also disposes the proxy — no lingering socket.
- **Dropped from v1:** gating stats-accrual on `processingState == ready` (the
  `player_controller.dart:352-355` caveat). We add a minimal *error-only* engine
  seam (§6) for fallback, but **not** the full `processingState` surface — the
  accrual over-count on a buffer stall isn't worth that for an ephemeral preview.
  See Risks.

### 5. Reachability signal (`onHomeLan`)

Reuse the existing app-8 network probe (`network_info.dart`, currently
unconnected). Its enum is `{offline, mobile, wifiMetered, wifiUnmetered}`
(`sync_gate.dart:7`); `currentNetwork()` returns a `Future<NetworkType>` (a cheap
`connectivity_plus.checkConnectivity()` — **not** the ~2 s server probe). The
reachability source exposes:

```dart
Future<bool> onHomeLan() async {
  final n = await _networkInfo.currentNetwork();
  return n == NetworkType.wifiUnmetered || n == NetworkType.wifiMetered;
}
```

**Not** `network != mobile` — that is *true when `offline`*, which would route an
offline tap to `lanStream` and only discover the failure via a doomed upstream
fetch. (`network_info.dart` today only ever returns `wifiUnmetered`/`mobile`/
`offline`, so the `wifiMetered` disjunct is presently dead but harmless.) It is
`await`-ed per load inside the already-async `_loadIndex`; no cached subscription,
no mandatory pre-probe. Whether the paired server is actually on *this* Wi-Fi is
settled by the streaming attempt itself (the failure path below).

### 6. Engine error seam (`AudioEngine` + `JustAudioEngine`)

**New — the fallback in §7 cannot be built without this.** `AudioEngine`
(`audio_engine.dart:4-38`) exposes `position`/`playing`/`duration`/`completion`
but **no error stream**, and `JustAudioEngine` doesn't surface just_audio's
`playbackEventStream`/`processingStateStream`. A failed loopback fetch surfaces in
just_audio as a player error that today goes nowhere. Add a minimal seam:

```dart
Stream<Object> get errorStream;   // AudioEngine interface
```

`JustAudioEngine` maps `_player.playbackEventStream`'s error events (and/or
`processingStateStream` idle-after-load) onto it; the demo/fake engines emit
nothing. The `PlayerController` subscribes and drives §7. This is the seam the
dropped `processingState==ready` idea would also have needed — we add the smaller
error-only version, not the full processing-state surface.

### 7. Failure / fallback behavior — no silent stalls

The proxy's first upstream request **is** the real reachability test. Fallback is
driven by the **engine error seam (§6)** — the platform player collapses upstream
HTTP codes into one opaque error, so on an engine error the controller reads the
proxy's **`lastUpstreamStatus` side-channel (§1)** to recover the real code and
route accordingly (no infinite buffer spinner):

| Failure | How the controller learns it | User-visible result |
|---|---|---|
| Server unreachable / timeout (wrong Wi-Fi, server off) | engine error + `lastUpstreamStatus == 0` | Stop; *"Couldn't stream over LAN — download to play"*; chapter stays needs-download |
| `401/403` (device token expired/revoked) | engine error + `lastUpstreamStatus ∈ {401,403}` | Trigger the existing **re-pair** flow (same UX as `api_client.dart:55`) |
| `404/5xx` from server | engine error + `lastUpstreamStatus ∈ {404,5xx}` | Same "couldn't stream — download" message |
| Toggle off / off-Wi-Fi / offline / local file missing | `resolvePlaybackSource → needsDownload` | user-initiated: *"Download this chapter to play"*; auto-advance: halt quietly |

On any stream error the controller also **clears the proxy mapping** (so the stale
loopback id `404`s) and stops. Streaming is best-effort; every failure degrades to
the offline-first download flow with a clear one-line message. **No auto-retry.**

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
   `Range` forwarded, and the **cancel-aborts-only-this-request** contract (a
   second concurrent fetch on the shared pool keeps working after one is
   cancelled). CA-pinning stays covered by the existing `cert_pinning`/`api_client`
   tests — same factory reused.
3. **Data plumbing** — `PlayableChapter`/`playlistFor` carry `audioUrl` through the
   projection; `_resolveUrl(c.audioUrl)` yields the correct absolute upstream URL.
4. **Engine error seam** — `JustAudioEngine` maps a just_audio player-error event
   onto `errorStream`; the fake engine can emit a synthetic error for controller
   tests.
5. **`PlayerController` wiring** (fake engine/proxy/reachability/settings/fileStore):
   downloaded (file exists) → `setFilePath`; undownloaded+on+Wi-Fi →
   `start()`+`register`+`setStreamUrl(loopback)` with **no headers to the engine**;
   **lazy invariant** — `proxy.start()` never called in `localFile`/`needsDownload`
   branches; toggle off / off-Wi-Fi / offline → `needsDownload` (user-initiated
   prompts, auto-advance halts quietly) + no proxy start; auto-advance into an
   undownloaded chapter streams; **failure routing** — engine error with
   `lastUpstreamStatus` of `0`/`404`/`5xx` → download message, `401/403` → re-pair
   flow, each clearing the mapping with **no auto-retry**; `dispose()` disposes the
   proxy.
6. **`resolvePlaybackSource`** — extend the existing truth-table test; add the
   `NetworkType → onHomeLan` mapping (offline ⇒ false).

**Not unit-testable (on-device / declarative):** the `network_security_config.xml`
+ manifest wiring (Android cleartext-to-loopback) — validated only by the on-device
run; `flutter analyze` won't catch a missing config.

**On-device (the "live device acceptance owed" step — owner):** real Android phone
on home Wi-Fi, undownloaded chapter, toggle on → instant play, seek, lock-screen
controls (background survival via the media foreground service), **no OS cert
install**; off-LAN → download prompt. This cannot run from a dev box and is why
#553 closes on merge with acceptance owed.

## Risks / known limitations

- **iOS backgrounding unverified.** `ios/Runner/Info.plist` has no
  `UIBackgroundModes: audio`, so the loopback server (and AVPlayer buffering) may
  stall when the app is backgrounded on iOS. Accepted for v1 (iOS is app-12
  territory); flagged to validate + add the background mode when iOS is enabled.
- **Stats over-count on buffer stalls.** With the `processingState == ready` gate
  dropped, a LAN preview that stalls mid-buffer while "playing" may slightly
  over-count listen-time. Acceptable for an ephemeral preview; revisit only if it
  proves material.

## Docs reconciliation

- **Plan 188** currently mis-states `app-10` as "closed #553" (line 52) — reconcile
  to "wired via in-app loopback proxy," and add the on-device acceptance walkthrough
  to its `app-10` section.
- Two release-notes entries (`docs/release-notes-next.md` technical +
  `RELEASE_NOTES.md` brand-voice) for the in-progress version.

## Acceptance / definition of done

Code-complete + the automated tests above green + docs updated + PR merged (which
closes #553). On-device Android smoke test is **owed to the owner** post-merge
(standard app-* "live device acceptance owed" pattern); reopen only if it fails on
a real phone.
