---
status: active
shipped: null
owner: null
---

# 188 — Android (Flutter) companion app

> Status: draft (epic / initiative umbrella — the `app-*` items each ship under their own plan)
> Key files (to be created): `apps/android/` (Flutter project), `server/src/routes/` (the `srv-32` sync-manifest route)
> URL surface: native app — pairs to the server over LAN HTTPS; no new web URL
> OpenAPI ops: **new** `GET /api/library/sync-manifest` (`srv-32`); **extends** `PUT /api/books/{id}/listen-progress` (optional `listenedAt`, `srv-34`) + the `GET /api/export/lan` / pairing payload (`token` + `caFingerprint`, `srv-20`); **reuses** `GET /api/library`, `GET /api/books/{id}/chapters/{cid}/audio(.mp3)`, `GET /api/books/{id}/listen-progress`, `GET /api/books/{id}/cover`, `GET /api/info`, `GET /cert/root.crt`

This is the **umbrella spec** for a native, Android-first listening companion app. It
is the durable home for the architecture, the cross-cutting iOS-readiness principles,
the full backlog decomposition (`srv-32` + `app-1..14`), the v1 definition-of-done, and
the wave-sequenced delivery roadmap. Each backlog item lands under its own branch + plan
per CLAUDE.md; this doc is what they hang off.

> **Build status (2026-06-07):** **the entire `app-*` build track + `srv-33` are
> code-complete** — all MVP server prereqs (`srv-34`/`srv-20`/`srv-35`/`srv-32`) + the full
> MVP app block (`app-1`…`app-8`, `app-13`, `app-14`) + `app-11` (signed APK) + the follow-ups
> `app-9` (in-car), `app-10` (LAN streaming), and **`srv-33` (per-device tokens + revoke)** are
> all built, tested, and merged. **The only thing left is the batched live-device acceptance
> pass** (per the user's directive) — and the parked `app-12` (iOS release). See **Build
> progress & dev setup** immediately below.

---

## Build progress & dev setup (handoff)

### Shipped (2026-06-06)

| Item | PR(s) | Notes |
|---|---|---|
| `srv-34` | #558 (closed #539) | listen-progress `listenedAt` + guarded compare-and-set |
| `srv-20` | #561 (middleware) + #564 (D2 payload), closed #425 | opt-in LAN token guard (`lan-auth.ts`); `/api/export/lan` now carries `token` + `caFingerprint` |
| `srv-35` | #569 (merge `61df595`), closed #540 | stable per-chapter `uuid` (lazy backfill + persist), restructure/rename-proof, anti-strip PUT guard, listen-progress resolves resume by `uuid`; also repairs the web player. Plan [190](190-srv-35-stable-chapter-uuid.md) |
| `srv-32` | #570 (merge `439e27a`), closed #538 | two-level gzip'd `GET /api/library/sync-manifest` (index + `?bookId=` detail), `?since` delta + full active-ID sets for stateless deletion, per-chapter fingerprint + actual `urlSuffix`/`audioUrl`, keyed by the `srv-35` `uuid`; bumps `/api/info` `schemas.syncManifest`. Plan [191](191-srv-32-sync-manifest.md) |
| `app-1` | #562 (closed #541) | Flutter scaffold at `apps/android/` (pkg `audiobook_companion`), domain seam, CI lane `.github/workflows/app.yml` |
| `app-2` | #565 + #566 + #567 (closed #542) | full pairing: QR/manual → fetch CA → verify SHA-256 → pin in `SecurityContext` → token probe; `SecurePairingStore`; `ApiClient` (authenticated, CA-pinned) |
| `app-3` | #572 (merge `d6fe920`, closed #543) | delta sync engine: pure `sync_manifest`/`sync_plan` domain (uuid+fingerprint keyed), `ApiClient.syncManifest{Index,BookDetail}`, range-resume + size-integrity + atomic `.tmp`→rename `ChapterDownloader` over an injectable `FileStore`, `LocalLibrary` JSON store, `SyncEngine` (per-book failure isolation, deferred swap via `isInUse`, progress stream, active-ID eviction), thin `flutter_foreground_task` keep-alive shim. 41 paired Dart tests. **Live device acceptance owed** (no sync-trigger UI until `app-7`/`app-14`). |
| `app-4` | #573 (merge `9d4c2a3`, closed #544) | offline store: **drift/SQLite** `LibraryDatabase` (Books+Chapters), `DriftLocalLibrary` implementing the `app-3` `LocalLibrary` port + accounting (`bookUsages`/`totalBytes`), `markPlayed`/`setChapterFinished`, `applyEviction`, cover-thumb paths, display meta, and a **one-time `sync-state.json`→drift import**. Pure `storage_policy` (auto-delete-finished + LRU book eviction). `ThumbnailCache` (ensure-if-missing) + pure `package:image` JPEG downscale (~250 px; client-side, D11 server `?width=` deferred). 25 paired Dart tests. **Live device acceptance owed.** |
| `app-5` | #575 (merge `056ea33`, closed #545) | native player: testable `PlayerController` brain over an injectable `AudioEngine` port — per-book resume/switch (saves position on switch, restores each book's own point), ~10 s **autosave throttle** (survives OS kill), **media-key→seek default** (`skip_behavior` ±30/±15 s, chapter-mode toggle), `isInUse` for app-3 deferred swap; drift **Playback** table (schema v2 + migration); real `JustAudioEngine` (just_audio) + `CompanionAudioHandler` (audio_service: lock-screen/Bluetooth/notification) + `MainActivity`→`AudioServiceActivity` + manifest service. 14 paired Dart tests. **Live device acceptance owed.** |
| `app-6` | #576 (merge `5042c3f`, closed #546) | two-way resume sync: pure `reconcileResume` (LWW by client `listenedAt`, not network-receive time) + `ResumeSyncService` (push local / pull remote / noop over an injectable `ListenProgressApi` + `PlaybackStore` + a `chapterIdResolver`; the local Playback row IS the offline queue); `ApiClient.get/putListenProgress` (real CA-pinned, `listenedAt` per `srv-34`); `PlaybackPoint` gains `listenedAt`. 12 paired Dart tests. **Live device acceptance owed.** |
| `app-7` | #577 (merge `9cc7061`, closed #547) | library browse: pure `library_tree` (author→series→book grouping + sort by `seriesPosition`/title + case-insensitive `filterBooks`) + `BookDownloadState`; presentational `LibraryScreen` (collapsible groups, search, per-book state pill + download/remove, prop-driven so it widget-tests). 9 paired Dart tests (6 tree + 3 widget). **Live device acceptance owed.** |
| `app-13` | #579 (merge `e54c2af`, closed #549) | settings: pure `AppSettings` (sleep timer, default speed, skip-silence, skip-button behaviour, unmetered-Wi-Fi-only, storage cap + auto-delete-finished + keep-recent-books, auto-sync/auto-download — drives app-5/app-4/app-8) with json round-trip + tolerant `fromJson`; `SettingsStore` (FileStore JSON, defaults on corrupt); testable `SleepTimer` (injectable scheduler); presentational `SettingsScreen`. 14 paired Dart tests. **Live device acceptance owed.** |
| `app-8` | #580 (merge `b064b0d`, closed #548) | auto-sync on reconnect: pure `shouldAutoSync` gate (never on mobile/offline, only unmetered Wi-Fi unless opted in, only when the paired server is reachable — token never leaves the home LAN) + `AutoSyncService` (pre-gates before probing so it never probes off-LAN; runs delta sync + resume flush when allowed) + pure `networkTypeFromConnectivity` + real `connectivity_plus` resolver (pinned 6.x — 7.x iOS uses an iOS-26 `NWPath` API that fails the CI iOS compile). 17 paired Dart tests. **Live device acceptance owed.** |
| `app-14` | #582 (merge `e5b5da9`, closed #550) | home shelf + multi-book switching: pure `home_shelf` (`buildContinueListening` = in-progress books most-recently-played first; `buildRecentlyUpdated` newest-first capped) + presentational `HomeScreen` (Continue-listening rail + recently-updated rail; tap → `onOpenBook`, host wires to the player's `switchBook` for seamless per-book resume). 6 paired Dart tests. **Live device acceptance owed.** **MVP app block (app-1..8,13,14) complete.** |
| `app-11` | #586 (merge `0563f05`, closed #554) | distribution: Gradle release signing via git-ignored `android/key.properties` (real upload keystore) with a **debug-signed fallback** so `flutter build apk --release` always produces an installable sideload APK; `key.properties.example` + `.gitignore` for the secrets; CI publishes a `companion-release-apk` artifact per build. Build-config (no Dart tests); release APK verified locally (65.6 MB). |
| `app-9` | #588 (merge `e05753d`, closed #552) | in-car (Android Auto + CarPlay): pure `media_browse_tree` (root→books→chapters `MediaNode` + `bookMediaId`/`chapterMediaId` codec + `childrenOf`) wired into `CompanionAudioHandler.getChildren`/`playFromMediaId` (audio_service `MediaBrowser`); Android Auto descriptor (`automotive_app_desc.xml` + manifest meta-data). 6 paired Dart tests. **Live device/head-unit acceptance owed.** |
| `app-10` | #589 (merge `c51f71e`, closed #553) | stream-over-LAN instant play: pure `resolvePlaybackSource` (downloaded → local file; else streaming-on + on-LAN → LAN stream; else needs-download — offline-first) + `AppSettings.streamOverLan` toggle (default off) + `AudioEngine.setStreamUrl` (just_audio `AudioSource.uri` with auth headers) + a settings switch. 4 paired Dart tests. **Live device acceptance owed.** |
| `srv-33` | _this PR_ (closed #551) | per-device tokens + revoke, layered on srv-20 (server): `workspace/device-tokens.ts` (pure `findValidDevice`/`hashToken`/`redactDevice` + cache-backed mint/list/revoke, sha-256-only at rest) + `routes/devices.ts` (`GET`/`POST`/`DELETE /api/devices` behind the LAN guard) + `lan-auth.ts` now accepts the shared secret **OR** a non-revoked device token (still sync). Backward-compatible. 18 server tests; openapi `/api/devices` + `Device` schema. **App-side adoption (mint+use a per-device token at pairing) is an optional small follow-up — the shipped app keeps working on the shared token.** |

### Build track complete

**Every `app-*` item through `app-10`, plus the `srv-33` server follow-up, is built, tested,
and merged.** The only remaining work is the **batched live-device/head-unit acceptance pass**
(per the user's directive — run the whole feature set on the Pixel 10 Pro / a physical device +
a head unit against the real GPU server). Parked: **`app-12`** (iOS release — the codebase is
iOS-ready: app-pinned TLS, dual-platform plugins, the unsigned-iOS CI compile is green on every
PR). _srv-33 ships the server capability; wiring the companion to mint + use a per-device token
at pairing (so revoke targets one phone) is a tiny optional follow-up._

### Update (2026-06-09) — web pairing-QR surface + scanner ML Kit crash

**Web pairing QR shipped (the desktop half of `app-2`).** The app could always scan/parse
a `{ url, token, caFingerprint }` QR (`PairedServer.fromQrPayload`), but nothing in the web
app *drew* one — pairing was manual-entry only. Added `src/modals/pair-device.tsx`
(`PairDeviceModal`) + a **"Pair a device"** button on the listen-view companion banner
(`companion-app-banner.tsx`). It renders the QR from `GET /api/export/lan`, which **already**
returns `token` + `caFingerprint` (srv-20), so **no server change was needed**. Falls back to
a copyable manual-entry list, and explains how to enable LAN HTTPS when the payload is
incomplete (not https / no token / no CA). Tests: `pair-device.test.tsx` (11) +
`companion-app-banner.test.tsx` (pair-button→modal) + an e2e in `download-tiles.spec.ts`.

**Scanner crash on Android 16 → replaced ML Kit with zxing (`flutter_zxing`).** `Scan QR`
crashed with `NullPointerException: Attempt to invoke virtual method '…' on a null object
reference`. Diagnosed via `adb logcat`: the NPE is **inside Google ML Kit's own `process()`
pipeline** (every stack frame is obfuscated Google code — mobile_scanner's own Kotlin would show
un-obfuscated `dev.steenbakker.*` and never appears), reproduced on a Pixel 10 Pro **API-36**
emulator *and* a real device. Ruled out: camera permission (granted; `GrantPermissionsActivity`
fires), native-load / 16 KB alignment (no `dlopen`/`UnsatisfiedLink` — the lib loads), and the
ML Kit variant (bundled 17.3.0 **and** unbundled 18.3.1 fail identically). Root cause: ML Kit
barcode is incompatible with this Android-16 runtime, and it's closed/obfuscated — unfixable from
our layer. **Fix: dropped mobile_scanner entirely and swapped to `flutter_zxing` (zxing-cpp via
FFI — no ML Kit, no Play Services).** `qr_scan_screen.dart` now uses `ReaderWidget`
(`Format.qrCode`) with a built-in gallery-import fallback. Built with NDK r27 (16 KB-aligned
`.so` by default). **Verified end-to-end on the Android-16 emulator** (the same box that
faithfully reproduced the NPE): (1) the live camera preview opens with **zero NPE / native-load
error**, and (2) decoding the real pairing QR via gallery-import lands back on the pairing form
with all three fields auto-populated — exercising the same `onScan → PairedServer.fromQrPayload`
path the live camera uses. 193 app Dart tests green.

### Dev setup (this box — full toolchain installed + validated)

The Flutter + Android toolchain is installed and the app **runs on a Pixel 10 Pro emulator**:

- **Flutter** 3.44.1 at `C:\Users\dudar\flutter` (on the User PATH; or `C:\Users\dudar\flutter\bin\flutter.bat`).
- **Android SDK** at `%LOCALAPPDATA%\Android\Sdk` — `ANDROID_HOME` set, licences accepted, cmdline-tools + platform-tools installed (`adb` on PATH).
- **Emulator:** AVD `Pixel_10_Pro` — `flutter emulators --launch Pixel_10_Pro`.
- **App code:** `apps/android/` (pkg `audiobook_companion`). Layers: `lib/src/domain` (models), `lib/src/data` (cert pinning, pairing service/store, API client), `lib/src/ui` (pairing + QR screens).

### Build / test / run (from `apps/android/`)

- `flutter pub get` · `flutter analyze` · `flutter test` (Dart VM, no device) — all must be green.
- `flutter build apk --debug` → `build/app/outputs/flutter-apk/app-debug.apk`.
- Run: boot the emulator, then `flutter run` (or `adb install -r build/app/outputs/flutter-apk/app-debug.apk`).
- **CI:** `.github/workflows/app.yml` (path-filtered to `apps/android/**`) — analyze + test + debug APK on Ubuntu, unsigned iOS compile on macOS.

### Conventions for the next agent

Each item = its own branch (`feat/app-…` / `feat/server-…`) + PR per CLAUDE.md; `app` is a
registered commit scope + BACKLOG prefix. The pure-Dart `pair` / `ApiClient` logic is built
with **injectable IO** so it unit-tests without real TLS/native plugins; the QR camera +
secure storage are exercised on a physical device. Full OpenAPI Dart codegen is deferred —
`ApiClient` is a thin hand-written client for now.

---

## Benefit / Rationale

The web app *already* works on an Android phone today over LAN HTTPS (plan 81 —
responsive, touch-equivalent, QR/cert install), so "use it on a phone" is solved. The
companion's value-add is the stuff a browser tab can't do well, and specifically the
one thing the existing export → sideload → third-party-listener-app flow handles badly:
**incremental sync of a constantly-regenerated library.**

- **User:** Fix one chapter's attribution, add an emotion variant, or upgrade a voice on
  the server, and today you must re-export and re-copy the *entire* M4B to your phone.
  The companion re-pulls **only the one changed chapter**. It also flows your in-car
  listening position back to the server (today resume is one-way), and gives seamless
  offline + Bluetooth/lock-screen playback for the car without a per-change full resync.
- **Technical:** A delta-sync client built on **per-chapter audio files** (each
  independently addressable + HTTP-range-capable) instead of monolithic exports — so a
  regenerated chapter costs a one-file re-pull, never a whole-book rebuild.
- **Architectural:** Establishes the **`app` surface** (`apps/android/`, prefix `app`,
  commit scope `app`) and a server-side **sync-manifest contract** (`srv-32`) that any
  future client (incl. iOS) consumes. Chosen Flutter so iOS is a near-free follow-up.

## The killer feature (why this exists)

Today's pain, in the user's words: the library is **alive** — chapters get re-recorded
(attribution fixes, per-character splices, QA re-records, loudness renorm), emotion
variants get added, voices get upgraded — and every such change forces a full-book
re-export + re-sync into whatever third-party player they sideloaded to. The companion
makes the phone a **delta-sync mirror** of the server's per-book audio: on each home-LAN
reconnect it pulls only what changed and pushes back where you listened. That is the
differentiator vs. the existing listener-app handoffs (`fe-3`/`fs-7`/`fs-8`).

## Architecture

- **Product shape:** native listening client (not a PWA, not a WebView wrapper) that
  **pairs to the server**.
- **Tech stack:** **Flutter** (`just_audio` + `audio_service`), cross-platform so iOS is
  an incremental follow-up ("Android **initially**").
- **Code location & IDs:** monorepo at **`apps/android/`** (the Flutter project is
  multi-platform; the iOS target lives in the same project). New permanent BACKLOG prefix
  **`app`** + new commit scope **`app`**.
- **Core design principle:** a **delta-sync mirror of each book's per-chapter audio + a
  two-way resume sync**, offline-first. Sync **per-chapter `…/audio.mp3` files**, NOT
  M4B exports — a regenerated chapter = one-file re-pull.
- **Reachability model:** sync happens on the home LAN (LAN HTTPS, mkcert-trusted);
  playback is offline and works anywhere. **No internet exposure / tunneling in v1.**

### Server facts (verified — grounds the items)

| Need | Status | What it means |
|---|---|---|
| Cover image **bytes** | **EXISTS** — `GET /api/books/:id/cover` (range, cacheable JPEG) | App caches covers offline; no server work. |
| Version/capability **handshake** | **EXISTS** — `GET /api/info` (`appVersion` + `schemas` map) | Reuse for compat-gating; no new endpoint. App checks the server is new enough for the sync manifest via a `schemas` bump. |
| LAN **root CA** for trust | **EXISTS** — `GET /cert/root.crt` (mkcert CA PEM); `GET /api/export/lan` returns `{ urls, port, protocol }` only (no token/fingerprint **yet**) | **Key iOS unlock:** app fetches the CA at pairing and **pins it in its own Dart `SecurityContext`** — trusting the server **without** an OS cert install (removes the iOS ATS/MDM blocker; identical on Android). **Hardening from secondary review:** the pairing QR must also carry the `srv-20` token + the CA's SHA-256 so the app *auto-verifies* the fetched CA (no manual hex compare) — a small extension to the LAN/pairing payload (`srv-20`). |
| Per-chapter **fingerprint** | **PARTIAL** — `audioRenderedAt` + `audioModelKey` + file size change on regen; no content hash | Manifest = reshape of existing `scan.ts` data (cheap). **Catch:** every audio-mutating path must bump the stamp (see `srv-32` acceptance). |
| Listen-progress scope | **PER-BOOK ONLY** (confirmed) | Cross-book "continue listening" is client-side (app sorts books by `listen-progress.updatedAt`). Ties to `fs-15`. |
| `GET /api/library` cost | **GAP** — O(books) walk, no `?since`/pagination | Manifest needs a **`?since=` delta** from day one to stay cheap on big libraries. Deletions can't use server tombstones (a stateless filesystem scan has no memory of deleted folders) — instead every response carries the **full active book/chapter ID set** and the client evicts what's missing (see `srv-32`). |

### Cross-cutting iOS-readiness principles (enforced per item)

1. **App-managed TLS trust, not OS trust — auto-verified.** The pairing QR carries
   `{ url, token, caFingerprint }`. At pair time the app fetches `/cert/root.crt` over a
   **one-shot, validation-bypassing** HTTP client (the self-signed cert isn't trusted
   yet), asserts the fetched CA's SHA-256 **equals the scanned `caFingerprint`**
   (automated MitM check — never a manual 64-char hex compare), then **discards the
   bootstrap client** and pins the verified CA in the main client's `SecurityContext`.
   No per-OS root-cert install — the single biggest iOS blocker, removed.
2. **In-car is cross-platform from the start.** The in-car item is **Android Auto *and*
   CarPlay** over one `audio_service`-backed media-browser; Android ships first, CarPlay
   is the sibling, not a rewrite.
3. **Dual-platform plugins, isolated native code.** `just_audio`/`audio_service`
   (background audio, both OSes), a background-download plugin wrapping Android
   WorkManager **and** iOS background `URLSession`, `flutter_secure_storage`
   (Keystore/Keychain). Keep the sync/store/domain layer **pure Dart** (sqlite/drift or
   Isar) with zero platform assumptions.
4. **CI compiles the iOS target early.** Reuse the GitHub-hosted macOS runner in
   `.github/workflows/cross-os.yml` for an unsigned iOS build (`flutter build ios
   --no-codesign`) of the Flutter app from `app-1` on, so divergence is caught long
   before iOS is a shipping target.
5. **Codec compatibility (OGG is Android-only).** iOS `AVPlayer` does **not** play `.ogg`
   (Vorbis/Opus); the server can render `.ogg`, `.m4a`, or `.mp3` (`chapter-audio.ts`). So
   for an iOS deployment the server must use **MP3 or M4A/AAC** (both play on Android *and*
   iOS); **`.ogg` is Android-only**. The app reads each chapter's format from the `srv-32`
   `urlSuffix` and, on iOS, surfaces a clear "format not supported on iOS" state for an
   `.ogg` chapter rather than failing silently. (v1 is Android, where all three play — this
   is a forward constraint for `app-12`, captured per the 5th review.)

### Secondary review (2026-06-06) — incorporated

An external technical review pressure-tested this design; the verified-and-adopted
changes are folded into the items below. Summary of what moved:

1. **Auto-verified pairing** (`app-2` + `srv-20`): the QR carries `{ url, token,
   caFingerprint }`; the app fetches the CA over a one-shot bad-cert-bypass client and
   asserts its hash == the scanned fingerprint, then pins — replacing error-prone manual
   hex comparison.
2. **Offline-correct resume ordering** (new **`srv-34`** + `app-6`): the verified bug —
   `book-state.ts:1171` stamps `updatedAt` at *receive* time, so a late-arriving offline
   push silently overwrites a newer position made elsewhere. Fix: the PUT accepts an
   optional client `listenedAt` (server sanity-bounds it: not future / not absurd) and
   uses it for ordering.
3. **Stateless deletion** (`srv-32` + `app-3`): drop the self-contradictory "server
   tombstones"; the manifest returns the full active-ID set and the client diffs to evict.
4. **Atomic chapter swap** (`app-3`/`app-5`): download to `.tmp`, verify, atomic rename;
   defer the swap if the player has the file open.
5. **Frequent local autosave** (`app-5`): persist position to local DB every ~5–10 s
   (cheap, local) so an OS background-kill never loses progress — decoupled from the
   debounced server push.
6. **Media-key safety** (`app-5`/`app-13`): default Bluetooth/notification skip buttons to
   **±30 s / ±15 s seek**, not next/prev *chapter* (an accidental steering-wheel press
   shouldn't skip a whole chapter); a setting flips to chapter-skip.
7. **Storage policies** (`app-4`/`app-13`): concrete eviction — auto-delete finished
   chapters (keep metadata + progress) and least-recently-listened book eviction at the cap.

---

## The item decomposition

IDs are permanent. Priority = position. MVP block first, follow-ups after.

### Server prerequisites

#### `srv-32` — Per-chapter sync-manifest endpoint (delta-friendly)

> ✅ **Shipped 2026-06-06** — PR #570 (merge `439e27a`), closed #538. Plan [191](191-srv-32-sync-manifest.md).

- **What:** a **two-level, gzip/brotli-compressed** manifest (so a 200-book / 4,000-chapter
  library never ships as one giant JSON — 4th-review point 2): a lightweight **index**
  (`GET /api/library/sync-manifest` — book IDs + per-book version/`updatedAt` + cover ref +
  the active **book**-ID set; `?since=<iso>` trims it) and a **per-book detail**
  (`GET /api/library/sync-manifest?bookId=<id>` — that book's chapters with, per chapter:
  the **stable `uuid`** (`srv-35`), a **fingerprint** (`audioRenderedAt` + file size; hash
  optional), `durationSec`/`lufs`/`listen-progress.updatedAt`, and the **exact audio
  `urlSuffix`** — `audio.mp3` | `audio.m4a` | `audio.ogg`, since a chapter can render in any
  of the three (`chapter-audio.ts:310-312`) — plus the active **chapter**-ID set). The
  client diffs the index, then pulls only changed books' detail (isolates failures, drives
  "Syncing Book A…" UI). **Deletion stays server-stateless:** the active book/chapter ID
  sets let the client evict what's gone (a filesystem scan can't emit tombstones for deleted
  folders). Reuses `server/src/workspace/scan.ts`.
- **Acceptance highlights:** (1) the fingerprint MUST change on **every** audio-mutating
  path — full regen, per-character splice (`fs-26`), QA re-record (plan 179), loudness
  renorm — or the companion silently misses updates (test asserts each path bumps it);
  (2) the per-chapter `urlSuffix` reflects the **actual rendered format** so the client
  never hardcodes `.mp3`; (3) chapters are keyed by the `srv-35` `uuid`, not the positional
  `id`.
- **Benefit (architectural/user):** the one change that makes delta sync possible; also
  feeds `fs-15`. **Depends on:** nothing.

*(No separate version-handshake item — the companion gates compatibility off the existing
`GET /api/info` `schemas` map, which `srv-32` bumps.)*

#### `srv-34` — Listen-progress PUT accepts a client `listenedAt` (offline-correct ordering)

- **What:** extend `PUT /api/books/:id/listen-progress` (`server/src/routes/book-state.ts`
  + `openapi.yaml` + the `ListenProgressFile` shape) to accept an **optional client
  `listenedAt`** timestamp. When present and sane, the server uses it as `updatedAt`
  instead of receive-time; it **sanity-bounds** it (reject future-dated beyond a small
  skew; clamp absurd values) so a misconfigured device clock can't poison ordering.
  Additive + backward-compatible (legacy callers that omit it keep server-stamp behaviour).
- **Why:** verified bug — today `book-state.ts:1171` stamps `updatedAt = now()` at
  *receive* time, so a phone that listened offline 1–2 pm and reconnects at 3 pm
  **overwrites** a newer 2:30 pm position made on the web client. The fix makes
  last-write-wins reflect *when the user actually listened*, not when the network
  delivered the write.
- **Guarded write (compare-and-set, from 3rd-review point 4):** the PUT must **read the
  stored record first and commit only if the incoming `listenedAt` is strictly newer**
  than the stored one; on a stale write, return `200` with the stored (newer) record so
  the client reconciles. Without this, the server still blind-overwrites
  (`book-state.ts:1168-1175` writes unconditionally) and a slow mobile push clobbers a
  newer web write. This is the targeted fix for concurrent web+companion writers — it does
  **NOT** wake the broader `srv-10`/`fe-11` multi-writer items (those cover `state.json`;
  listen-progress only here). *Open nuance for the plan: a wholesale reject can drop a
  marker added on the losing side — consider union-merging `markers` while LWW-ing the
  position.*
- **Benefit (user/technical):** correct cross-device resume; unblocks `app-6`'s two-way
  sync. **Depends on:** nothing (consumed by `app-6`).

#### `srv-35` — Stable per-chapter identifier (reorder/rename-proof) — **MVP prereq**

> ✅ **Shipped 2026-06-06** — PR #569 (merge `61df595`), closed #540. Plan [190](190-srv-35-stable-chapter-uuid.md).

- **What:** add an immutable per-chapter `uuid` at import, preserved through restructure
  (merge/split/reorder, `restructure.ts`) and rename (`78-chapter-rename`), and key
  listen-progress + the sync manifest (`srv-32`) by it. **Verified gap (3rd review,
  point 5):** chapter `id` is *positional* — re-issued 1..N on reorder
  (`restructure.ts:1185-1189`) — and `slug` embeds both id and title
  (`chapterSlug(id, title)`), so **neither survives a restructure**; today's web
  listen-progress already assumes a stable `id` with no fallback
  (`book-state.ts:1064-1075`). (The reviewer's "store `chapterSlug` as fallback" doesn't
  hold — slug is no more stable than id.)
- **MVP, done up front (user directive 2026-06-06):** not deferred — so the companion keys
  sync + bookmarks by a stable id from day one and a server-side reorder/rename can never
  desync an offline phone. **Also repairs the existing web player's latent bug.**
  `srv-32`/`app-3`/`app-6` key by the `uuid`. Lazy-migrate existing chapters (inject a
  `uuid` on the next `state.json` write); split keeps the original `uuid` on the first
  half + mints a new one for the second; merge keeps the survivor's.
- **Benefit (user/technical):** bookmarks + per-chapter sync survive chapter restructure on
  both web and the companion. **Depends on:** nothing (cross-cutting server change; touches
  `restructure.ts`/`scan.ts`/`state.json`).

### `app-*` — MVP block (first usable, installable Android deployment)

#### `app-1` — Flutter app scaffold in `apps/android/`

- **What:** project structure (incl. the iOS target), a pure-Dart domain/store layer
  (sqlite/drift or Isar) with a **migration discipline**, lint, a widget+unit test
  harness, a **debug/sideload APK** build, and a CI lane running `flutter analyze` +
  tests **and an unsigned iOS compile** (`flutter build ios --no-codesign` — avoids
  provisioning-profile/signing failures on the hosted runner without Apple certs) on the
  macOS cross-os runner. Registers the `app` scope + BACKLOG prefix (done in this doc's
  landing pass).
- **Benefit (technical):** the foundation + test + cross-platform-CI harness everything
  builds on. **Depends on:** nothing.

#### `app-2` — Pairing, app-managed TLS trust, and generated API client

- **What:** scan-QR / enter-URL onboarding. The QR carries `{ url, token, caFingerprint }`
  (`srv-20`). Pairing flow: (1) fetch `/cert/root.crt` over a **one-shot bad-cert-bypass**
  client; (2) assert the fetched CA's SHA-256 == the scanned `caFingerprint`; (3) **discard
  the bootstrap client** and build the main client with the CA **pinned in its
  `SecurityContext`**; (4) store the `srv-20` token in `flutter_secure_storage`. Plus a
  Dart client generated from `openapi.yaml`, reachability detection, and a coherent
  **error model** (unreachable / token-rejected / **fingerprint-mismatch** → refuse to
  pair).
- **Benefit (user):** one-time, *cryptographically auto-verified* pairing that "just
  works" on Android *and* iOS — no OS cert install, no manual hex compare.
  **Depends on:** `app-1`, **`srv-20`** (must surface token + CA fingerprint in the QR).

#### `app-3` — Delta sync engine

- **What:** fetch the `srv-32` **index** (`?since`), diff vs the local store, then pull each
  changed book's **per-book detail** and download only changed/new chapters **via the
  manifest's per-chapter `urlSuffix`** (`audio.mp3` | `.m4a` | `.ogg` — **never hardcode
  `.mp3`**), keyed by the stable `uuid` (`srv-35`), with **resumable range downloads +
  retry/backoff + integrity check** (size/stamp). **Resume, don't restart (5th review):** on
  a dropped connection, check the existing `<file>.tmp`, then send `Range:
  bytes=<localTmpSize>-` and append — the server's `sendFile` serves `206` natively, so a
  10–50 MB chapter never restarts at byte 0. **Atomic swap:** once complete, verify the
  `<file>.tmp`, atomic-rename over the live file — **defer if the player has it open** (apply
  on next stop). **Foreground service:** while a sync is actively downloading,
  run it as an **Android foreground service** (persistent progress notification, e.g.
  "Downloading Book A — ch 3/12") so the OS doesn't kill a multi-book download after a few
  minutes (iOS: background `URLSession` via the download plugin). **Deletion:** evict any
  local book/chapter absent from the active-ID sets. Re-pull a single regenerated chapter,
  never the whole book.
- **Benefit (user):** the killer feature — no full-book resync when one chapter is
  fixed/improved; an in-progress chapter never corrupts mid-listen; large downloads finish
  in the background. **Depends on:** `app-2`, `srv-32`, **`srv-35`**.

#### `app-4` — Offline library store

- **What:** local per-chapter audio + metadata + cover persistence, storage accounting,
  delete/evict a book, **disk-full handling**, and **auto-eviction policies** driven by
  `app-13` settings — (a) **auto-delete finished chapters** (drop the file once listened,
  keep metadata + progress pointer) and (b) **least-recently-listened book eviction** when
  the storage cap is hit (keep the N most-recently-played books). Evicted audio re-syncs
  on demand. **Store each chapter's actual audio extension** (`mp3`/`m4a`/`ogg`) so
  `just_audio` initialises the right codec. **Cache a small cover thumbnail** (~250×250,
  <50 KB JPEG; `?width=` — see D11) for list/grid rendering **and the lock-screen media
  session** (`app-5`); fetch the full-res cover only for the now-playing screen.
- **Benefit (user):** listen anywhere; the cache never silently fills the phone; lists stay
  smooth. **Depends on:** `app-3`.

#### `app-5` — Native audio player

- **What:** `just_audio` + `audio_service`: background playback, lock-screen/notification
  + **Bluetooth** controls (covers driving via car Bluetooth), speed, skip-silence,
  chapter nav, resume; **stale-while-listening** handling (a chapter superseded
  mid-listen swaps cleanly on next play, position preserved — see `app-3` atomic swap).
- **Acceptance highlights:**
  - player state is **per-book** — switching the active book preserves each book's
    chapter+position (backed by the local store + `listen-progress`), so the user can hop
    between several in-progress books freely;
  - **frequent local autosave** — persist position to the local DB every **~5–10 s** during
    playback (cheap, local) so an OS background-kill never loses progress; the server push
    stays debounced/on-reconnect (`app-6`);
  - **media-key safety** — default the Bluetooth/notification skip buttons (and
    steering-wheel/headset keys) to **seek ±30 s / ±15 s**, NOT next/prev *chapter*, so an
    accidental press doesn't skip a whole chapter (toggle to chapter-skip in `app-13`);
  - **lock-screen artwork uses the thumbnail (5th review)** — the `MediaItem` /
    `NowPlayingInfo` artwork points at the **local ~250×250 thumbnail** (`app-4`), never the
    2 MB+ full-res cover, so the background media service can't OOM-crash.
- **Benefit (user):** table-stakes listening UX that survives backgrounding and car
  controls. **Depends on:** `app-4`.

#### `app-6` — Two-way resume sync

- **What:** pull server `listen-progress` on sync; queue local position offline; push
  back on reconnect supplying the client **`listenedAt`** (the wall-clock time the user
  actually listened — see `srv-34`), so **last-write-wins reflects listen time, not
  network-delivery time**. Server sanity-bounds `listenedAt`; the app records it at each
  local autosave. *(Open nuance for the `app-6` plan: position isn't monotonic in time —
  consider "furthest position" vs "latest `listenedAt`" when they disagree; LWW-by-listen-
  time is the v1 default.)*
- **Benefit (user):** in-car progress flows back without clobbering a newer position made
  elsewhere while the phone was offline. **Depends on:** `app-2`, `app-5`, **`srv-34`**.

#### `app-7` — Hierarchical library browse + management

- **What:** navigate the library the way the server already structures it — **by author →
  by series → by book** (series ordered by `seriesPosition`, collapsible groups), with
  search/filter by title/author and pinned books surfaced. Maps directly to the
  `GET /api/library` / `srv-32` tree — **no new server work**. Each book shows its state
  pill (not-downloaded / downloading / downloaded / **update-available**) with
  download/remove, sync status + errors, and storage usage. Renders **thumbnail** covers
  (not full-res) so large libraries don't jank.
- **Benefit (user):** find any book fast in a large, multi-series library.
  **Depends on:** `app-3`, `app-5`.

#### `app-14` — Home shelf + multi-book switching

- **What:** the primary day-to-day surface — a **"Continue listening"** shelf of
  in-progress books (sorted by `listen-progress.updatedAt`) plus recently-added /
  recently-updated rails. Tap any book to **switch the now-playing book seamlessly**;
  each resumes at its own saved position (per-book player state from `app-5` + `app-6`).
- **Benefit (user):** the "listen to multiple books and switch as required" workflow as a
  first-class home screen. **Depends on:** `app-5`, `app-6`, `app-7`.

#### `app-8` — Auto-sync on reconnect

- **What:** detect home-network reachability; background auto-pull deltas + flush the
  resume queue (charging constraints via the cross-platform background-task plugin).
  **Unmetered Wi-Fi only (5th review):** restrict sync to connections the OS reports as
  **unmetered** — a "Wi-Fi" link can be a metered phone hotspot, and syncing 50 MB chapters
  on it would burn the user's mobile data (check the connection's metered flag, not just
  "is Wi-Fi"). **Network gating (4th review):** only attempt sync when the **paired server
  is actually reachable** — a reachability probe with backoff, optionally pinned to
  configured Wi-Fi SSID(s) (`app-13`) — so the app never spams connection attempts to the
  LAN IP, drains battery, or **leaks the token on public/foreign Wi-Fi**. *(SSID pinning
  needs Android location permission; pure reachability-gating avoids it — the plan picks
  one.)* Active downloads run under `app-3`'s foreground service.
- **Benefit (user):** the "sync as you reconnect" ask — fixes + new chapters appear with
  no manual action, safely and without battery drain off-network. **Depends on:** `app-3`,
  `app-6`.

#### `app-13` — Playback & download settings (incl. sleep timer)

- **What:** sleep timer (table-stakes for bedtime listening), default speed,
  skip-silence, **skip-button behaviour toggle** (seek ±30/±15 s vs chapter-skip — drives
  `app-5`'s media keys), **unmetered-Wi-Fi-only** downloads (excludes metered hotspots),
  **storage cap + the two auto-eviction policies** (auto-delete finished chapters;
  least-recently-listened book eviction — drive `app-4`), **auto-sync network gating**
  (paired-network-only / configured home SSID(s) — drives `app-8`), auto-download policy for
  in-progress books, and a "copy diagnostic logs" affordance (self-service observability).
- **Benefit (user):** the settings a real listening app is expected to have.
  **Depends on:** `app-5`, `app-4`.
- **Nice-to-have (follow-up, not v1):** "shake-to-extend" sleep timer — in the last ~30 s,
  duck the volume + soft chime; an accelerometer shake adds another interval without
  unlocking the phone. Premium ergonomic; YAGNI for the MVP, captured so it isn't lost.

### `app-*` — Follow-ups (post-MVP, ranked)

#### `srv-33` — Device pairing + multi-device token management (on top of `srv-20`)

- **What:** per-device tokens + revoke, layered on `srv-20`'s shared-secret primitive.
  *Reconcile, don't absorb:* MVP ships against `srv-20`'s single token; `srv-33` is the
  multi-device refinement.
- **Benefit (user/security):** revocable per-device access. **Depends on:** `srv-20`.

#### `app-9` — In-car support (Android Auto **and** CarPlay)

- **What:** a media-browser service so the library browses + plays on the car head unit,
  designed cross-platform over `audio_service`.
- **Benefit (user):** first-class in-car experience beyond the Bluetooth path in `app-5`.
  **Depends on:** `app-5`.

#### `app-10` — Stream-over-LAN instant play

- **What:** optionally stream `…/audio.mp3` (range) to start a not-yet-downloaded chapter
  on the home network. Deprioritized — the user emphasized offline.
- **Benefit (user):** zero-wait preview before committing a download. **Depends on:**
  `app-2`, `app-5`.

#### `app-11` — Distribution: signed release APK + alpha channel

- **What:** release signing + a versioned APK artifact in the release pipeline (sideload
  for alpha; Play Store later). *(MVP is installable via the `app-1` debug APK; this is
  the proper channel.)*
- **Benefit (user/technical):** testers can actually install it. **Depends on:** `app-1`.

#### `app-12` — iOS build + release

- **What:** the "Android **initially**" follow-through; because of the iOS-readiness
  principles (app-pinned TLS, dual-platform plugins, early iOS CI compile), this should
  be incremental. Filed as a parked **Won't (this round)** backlog row with a clear
  wake-trigger (Android MVP stable + listener demand).
- **Benefit (user):** one codebase, both platforms. **Depends on:** MVP stable.
- **CI note (2026-06-14):** the per-release *unsigned* iOS build (`companion-ios`) was
  REMOVED from `release.yml` — it cost ~80–120 macOS-billed min/tag (10×) for an
  un-installable artifact nothing consumes, and `app.yml`'s `ios-compile` job already
  guards iOS *compileability* on every `apps/android/**` change. When app-12 ships, add
  a **signed `.ipa`** release job here — **but even then weigh the macOS minutes**: a
  manual or occasional signed build is likely the better trade than one on every tag.

### Relationships to existing items (reconcile, don't absorb)

*(Expanded by the 2026-06-06 cross-item coherence review — collisions with non-companion
backlog items.)*

- **`srv-20`** — hard MVP dependency, with two coherence constraints: (a) its LAN/pairing
  payload carries the `token` **and** the CA `caFingerprint` so `app-2` auto-verifies; (b)
  the token middleware must **explicitly exempt `/cert/root.crt`** (top-level `/cert`,
  `index.ts:207` — already outside `/api/*`, but keep the exemption explicit): it's public
  CA material the app fetches over the *untrusted bootstrap channel before* it can pin, so
  it must not require the secret token. *(3rd review, point 2.)*
- **`fe-1`** (in-app LAN HTTPS banner / QR) — shares the LAN-URL + cert plumbing, but the
  companion needs its **own *structured* pairing QR** carrying `{ url, token,
  caFingerprint }`. Do **not** unify it with `fe-1`'s / the export-modal's *browser-open*
  QR — a phone browser scanning a JSON blob breaks; they share source data, not QR format.
  The pairing-QR surface reuses `fe-1`'s machinery, emits the structured payload. *(Point 1
  — adopted with this adjustment.)*
- **`ops-2`** (Docker deployment) — when built, two companion constraints: (a) **mount a
  persistent volume for the mkcert CA** (the `mkcert -CAROOT` dir) so `caFingerprint`
  survives container rebuilds (else every update forces a re-pair); (b) honour a
  **`LAN_HOST` override** in `enumerateLanUrls` (`export-lan.ts` reads
  `os.networkInterfaces()`, which inside a container yields bridge IPs like `172.18.0.x`)
  so the QR carries the host's real LAN IP. Annotated on the `ops-2` row. *(Point 3.)*
- **`srv-10` / `fe-11`** (multi-writer conflict — parked Won't) — the companion adds a
  *second concurrent writer* to listen-progress. `srv-34`'s guarded compare-and-set handles
  that **specific** route; it does **not** wake the broader `state.json` multi-writer items,
  which stay parked. *(Point 4.)*
- **`srv-35`** (stable chapter identifier — **now an MVP server prereq**, above) — chapter
  `id`/`slug` are both restructure-unstable; the companion keys sync + bookmarks by the new
  `uuid` from day one, and it repairs the existing web player too. *(Point 5 — the
  reviewer's slug-fallback was rejected because slug embeds the id + title; user directive
  2026-06-06 promoted it to MVP, not deferred.)*
- **`fs-15`** (cross-book resume) — `srv-32` manifest + the `app-14` "Continue listening"
  shelf overlap; cross-link both ways, keep distinct.
- **`fe-3` / `fs-7` / `fs-8`** (Apple Books / Plex / PocketBook handoffs) — the companion
  is the user's *own* replacement for the sideload pain, but does **not** obsolete them
  (they still serve users who prefer third-party apps).

---

## External dependencies & required cross-area changes

The full set of work **outside the `app-*` items** that must be in place for the companion
to work — found via the 2026-06-06 coherence reviews. Nothing here is new *companion*
code; it's the surrounding changes the app depends on. **Deal with these before/with the
build, not after.** "Blocks" = the MVP can't ship without it.

| # | Dependency | Area / scope | Blocks v1? | What must change |
|---|---|---|---|---|
| D1 | **`srv-20` shared-secret token** lands | server (security) | **YES** — `app-2` | Today `/api/*` is unauthenticated over LAN. srv-20 is the auth primitive the app sends its token to. Also: **carry `token` + `caFingerprint` in the pairing payload**, **exempt `/cert/root.crt`** from the guard, and **don't break the web app's LAN access** (the phone-browser web UI also needs the token). |
| D2 | **CA fingerprint exposed** for pairing | server (security) | **YES** — `app-2` | Compute the SHA-256 of the mkcert root CA (already served by `cert-root.ts`) and surface it in the pairing payload (extend `/api/export/lan` or a small `/api/pair`). Part of `srv-20`. |
| D3 | **`openapi.yaml` documents `srv-32` + `srv-34`** and `api-types` regenerated | openapi | **YES** — `app-2` | The Dart client is generated from `openapi.yaml`; the new sync-manifest op + the `listenedAt` field must be in the spec. `srv-32` also **bumps the `/api/info` `schemas` map** so the app can compat-gate. |
| D4 | **Audio-stamp correctness** on every re-record path | server (generation) | **YES** — `srv-32` | `srv-32`'s fingerprint trusts `audioRenderedAt`(+size) changing on *every* audio mutation. **Audit + fix** per-character splice (`fs-26`), segment-QA re-record (plan 179), loudness renorm — any path that rewrites audio without bumping the stamp makes the companion silently stale. (This is the `srv-32` test obligation, but the fix may reach into those modules.) |
| D5 | **Pairing-QR surface** (structured payload) | frontend | **YES** — `app-2` | A "Pair a device" QR rendering `{ url, token, caFingerprint }`, reusing `fe-1`'s LAN-URL/cert plumbing. Distinct from the browser-open QR. Lands with `srv-20` / `fe-1`. |
| D6 | **Server runs in LAN HTTPS mode** with the mkcert CA installed | operational (no code) | **YES** | The app reaches the server only over `npm run start:lan` / `LAN_HTTPS=1` (all-interfaces bind via `srv-19`, shipped) + `npm run install:cert-mobile`. A loopback-only server is unreachable. Surface this in the pairing flow + docs. |
| D7 | **Path-filtered CI learns the `apps/android/` (`app`) scope** | ops / ci | **YES** — `app-1` | `verify.yml` (plan 103) must run the Flutter lane for `app`-scope PRs and skip frontend/server legs (and vice-versa). New CI plumbing; the iOS compile uses the existing macOS runner (`cross-os.yml`). The `app` commit scope itself is **already registered**. |
| D8 | **`srv-35` stable chapter identifier** | server (cross-cutting) | **YES** — MVP (user directive 2026-06-06) | Chapter `id`/`slug` are restructure-unstable (verified). Add an immutable per-chapter `uuid` preserved through restructure/rename + lazy migration; `srv-32`/`app-3`/`app-6` key by it. Also repairs the **existing web player**. Touches `restructure.ts`/`scan.ts`/`state.json`. |
| D9 | **`ops-2` Docker constraints** | ops | No — only if Dockerised | Persistent mkcert-CA volume (else `caFingerprint` rotates → re-pair) + `LAN_HOST` override (container bridge IPs). |
| D10 | **`app-11` signed APK / distribution** | ops | No — MVP installs the `app-1` debug APK | Proper signed channel for alpha testers; Play Store later. |
| D11 | **Cover thumbnails** (`GET /api/books/{id}/cover?width=`) | server (perf) | No — *strongly recommended* | `cover.ts` serves full-res JPEG (no resize). Add a `?width=` resize (needs an image lib, e.g. sharp) so lists/grids fetch small thumbnails, full-res only for now-playing. Interim: the app can client-downscale (Flutter `cacheWidth`), but that still downloads the full bytes (4th-review point 3). |

**Concurrency note:** the companion is a *second* concurrent writer to `listen-progress`;
`srv-34`'s guarded compare-and-set covers exactly that route — it does **not** reopen the
parked `state.json` multi-writer items (`srv-10` / `fe-11`).

**Net new server/contract items this creates (beyond the app):** `srv-32`, `srv-34`,
`srv-35` (**all MVP**); the cover-thumbnail `?width=` (D11, recommended); plus the `srv-20`
extensions (D1/D2), openapi (D3), generation-stamp (D4), frontend-QR (D5) and CI (D7) work
folded into existing items.

---

## v1 scope (definition of done)

v1 = the `srv-32` + `srv-34` + `srv-35` server prereqs (+ landing `srv-20`) and the 10-item
MVP app block (`app-1..8, 13, 14`). **v1 is "done" when this single end-to-end scenario
passes on a real Android device against the user's real GPU server:**

> Pair the phone to the server (scan QR — token + CA fingerprint **auto-verified**, no OS
> cert install) → browse the library by author/series/book → download 2 books → play
> offline with
> background + lock-screen + Bluetooth controls + sleep timer → switch between the 2
> books and each resumes at its own position → regenerate one chapter of book A on the
> server → return to the home LAN → the app auto-syncs **only that one chapter** and
> pushes the in-car listening position back to the server.

Out of v1 (follow-ups): Android Auto/CarPlay head-unit UI (`app-9`), LAN streaming
(`app-10`), multi-device tokens (`srv-33`), iOS release (`app-12`). v1 ships an
installable signed APK (`app-11`).

## Path to delivery (waves, ordering, agents)

**Why the spine is serial.** A brand-new Flutter codebase has a young shared spine (DI
container, route table, db/store schema, `main.dart`). Parallel agents on it collide on
those files, so foundations are built **one agent at a time, sequentially**. Genuine
parallelism opens in two windows — the foundation (server work is a different codebase
from the app) and the feature leaves (separable views/services). Parallel waves use
`isolation: "worktree"` agents reconciled via the repo's documented `integration/<date>`
pattern (CONTRIBUTING.md): branch off `main`, merge each agent branch one at a time,
`npm run verify` between merges, **one draft integration PR per wave, verified once**.

**Sizing** is relative effort (S/M/L), not time. Each item still gets its own branch +
plan per CLAUDE.md; the waves are the scheduling layer over them.

| Wave | Items (size) | Agents | Isolation | Gate (must pass before next wave) |
|---|---|---|---|---|
| **0 · Backlog landing** | this doc + BACKLOG rows + register `app` scope/prefix + INDEX; then file 16 issues + issue-map (S) | 1 | shared tree (docs only) | `feat(app):` passes commit-msg hook; rows render; doc linked; (after review) issues filed |
| **1 · Foundations** ∥ | **srv-20**→**srv-35**→**srv-32**→**srv-34** (M–L) ‖ **app-1** scaffold (L) | **2** | 1 worktree each (server vs `apps/android/`) | server: `npm run test:server` green + new manifest / auth (token+fingerprint in QR, `/cert/root.crt` exempt) / listen-progress-`listenedAt`-guard / **chapter-`uuid` survives restructure** tests. app: `flutter analyze` + widget tests green, **debug APK builds**, **unsigned iOS compile** (`--no-codesign`) **on the macOS cross-os runner** |
| **2 · Network spine** | **app-2** pairing + TLS-pin + gen API client + secure token + error model (L) | 1 | serial | live pair against `npm run start:lan`; QR token + CA fingerprint **auto-verified** (mismatch refuses to pair); CA pinned in `SecurityContext` (no OS install); integration test hits `/api/info` + `/api/library` |
| **3 · Data spine** | **app-3** delta sync → **app-4** offline store (L, L) | 1 | serial (same track) | sync a real book; regenerate 1 chapter server-side → re-sync pulls **only** that file (atomic `.tmp`→rename); delete a book server-side → client evicts via active-ID diff; storage-cap eviction; resumable download + integrity check |
| **4 · Player** | **app-5** native player + media controls + per-book state (L) | 1 | serial | background + lock-screen + Bluetooth (skip = seek ±30/±15 s default); sleep-timer; **autosave survives an OS kill**; **switch book preserves each position** |
| **5 · Feature leaves** ∥ | **app-7** browse UI ‖ **app-6** resume-sync service ‖ **app-13** settings+sleep-timer (M, M, M) | **3** | 1 worktree each | per-item paired tests; integration PR green; manual verify on emulator. Reconcile order: app-6 → app-7 → app-13 |
| **6 · Integration capstone** | **app-8** auto-sync-on-reconnect → **app-14** home shelf + multi-book switching (M, M) | 1 | serial | the **full v1 end-to-end scenario** above, on a device |
| **7 · Ship** | **app-11** signed release APK + alpha channel (S) | 1 | serial | signed APK installs on the user's phone; real-library acceptance against the GPU server |

**Peak parallelism is 3 agents (Wave 5); most waves are 1.** Total ≈ 7 build sessions,
several of which (waves 2–4) are one continuing agent down the spine.

**Cross-area dependencies map onto the waves** (see *External dependencies*). The Wave 1
server track is broader than just the three `srv-*` items: it also lands **D1/D2**
(`srv-20` token + CA-fingerprint-in-QR + `/cert/root.crt` exemption), **D3** (openapi
ops + `/api/info` schemas bump), **D4** (audio-stamp audit across splice/QA/loudnorm), and
**D5** (the frontend pairing-QR surface, reusing `fe-1`'s plumbing). The Wave 1 app track
also lands **D7** (teach `verify.yml`'s path filter the `apps/android/` `app` scope).
**D6** (server in LAN HTTPS mode + mkcert CA) is an operational precondition for the Wave 2
live-pair gate. **`srv-35` (D8) is now an MVP prereq** (user directive) — it lands first in
the Wave 1 server track (before `srv-32`, which keys by its `uuid`). The cover-thumbnail
`?width=` (**D11**) is recommended (the app can interim client-downscale) — fold it into the
server track when convenient.

**One-time prerequisites (gate before the Wave 1 app track):** install the Flutter SDK +
Android SDK/emulator on the dev box; a physical Android phone for real-device acceptance
(waves 6–7); a `git`-trackable `apps/android/` with its own `.gitignore`. The iOS compile
uses the **GitHub-hosted macOS runner** (`cross-os.yml`) — **no local Mac required** for
v1.

**PR strategy:** serial spine items (`app-1/2/3/4/5`, the server prereqs) each open as a
**draft** PR, `gh pr ready` only when locally `verify`-green (one billed CI run each);
the two parallel waves (1 and 5) land as **one integration PR per wave**.

**Top delivery risks + mitigations:**

- *Fingerprint misses a re-record path* → companion silently stale. **Mitigation:**
  `srv-32` ships a test asserting full-regen / splice (`fs-26`) / QA-rerecord (plan 179)
  / loudness-renorm all bump the stamp (Wave 1 gate).
- *Self-signed cert rejected on device* → no pairing. **Mitigation:** app-pinned CA in
  the Dart `SecurityContext` (Wave 2 gate is a live pair, not a unit test).
- *Young-codebase merge churn in Wave 5* → reconcile cost. **Mitigation:** the three
  leaves are scoped to disjoint dirs (browse view / sync service / settings view);
  integration-branch merge order fixed (app-6 → app-7 → app-13).
- *Flutter toolchain not set up* → Wave 1 app track blocked. **Mitigation:** the
  one-time-prereq gate above, surfaced before Wave 1 starts.

---

## Architectural impact

- **New seams / extension points:**
  - **`app` surface** — `apps/android/`, BACKLOG prefix `app`, commit scope `app`,
    a Flutter CI lane (incl. iOS compile on the existing macOS runner).
  - **`srv-32` sync-manifest** — a delta/`?since`-aware contract over the existing
    workspace scan; the stable API any sync client (Android now, iOS later) consumes.
  - **`srv-20` token middleware** — promoted from "optional hardening" to a load-bearing
    auth primitive the companion depends on; its LAN/pairing payload also gains the CA
    `caFingerprint` so pairing auto-verifies.
  - **`srv-34` listen-progress `listenedAt`** — an additive field on the listen-progress
    PUT so conflict ordering reflects listen time, not network-receive time.
- **Invariants preserved:** the server stays **local-first / single-user**; LAN exposure
  stays **opt-in** (`npm run start:lan`); the companion adds **no internet-facing
  surface** in v1 (home-LAN sync + offline playback only). The per-chapter audio + range
  contract (plan 28) is consumed as-is; the listen-progress contract (plan 47) is
  **extended additively** (optional `listenedAt`), never broken.
- **Migration story:** no server data-shape migration for v1 — `srv-32` reshapes existing
  `scan.ts`/`state.json` data and bumps the `GET /api/info` `schemas` map for compat
  gating. Two small **additive, backward-compatible** contract extensions: the
  listen-progress PUT gains optional `listenedAt` (`srv-34`; legacy callers keep
  server-stamp behaviour) and the LAN/pairing payload gains `token` + `caFingerprint`
  (`srv-20`). App-side local DB owns its own migration discipline (`app-1`).
- **Reversibility:** the app is an additive, separate surface — deleting `apps/android/`
  and the `srv-32` route fully reverts. `srv-20` is independently useful (security
  hardening) regardless of the app.

## Invariants to preserve

1. **Per-chapter, not whole-book.** The companion syncs `…/audio.mp3` per chapter; it
   must never depend on the M4B export pipeline for routine sync (defeats delta).
2. **Fingerprint changes on every audio mutation.** `srv-32`'s per-chapter fingerprint
   must move on full regen, per-character splice (`fs-26`), QA re-record (plan 179), and
   loudness renorm — enforced by a `srv-32` test.
3. **App-managed, auto-verified TLS trust.** Device→server trust is established by
   fetching `/cert/root.crt`, asserting its SHA-256 == the QR-scanned `caFingerprint`, and
   pinning it in the app's `SecurityContext` — never an OS cert install, never a manual
   hex compare (keeps iOS parity + closes the MitM gap).
4. **Last-write-wins by client listen-time, server-guarded.** Two-way resume conflict
   resolution orders by the client `listenedAt` (server sanity-bounded, `srv-34`), NOT by
   network-receive time; the server **commits only if the incoming `listenedAt` is strictly
   newer** than the stored one (compare-and-set) so a stale push can't clobber a newer
   position. Scope: listen-progress only — does not touch `state.json` (`srv-10`/`fe-11`).
5. **Bootstrap cert fetch is unauthenticated.** `srv-20`'s token guard must never cover
   `/cert/root.crt` — it's public CA material the app fetches over the untrusted channel
   before it can pin + present the token.
6. **Chapter keying is the stable `uuid` (`srv-35`).** Chapter `id`/`slug` are restructure-
   unstable (verified), so the manifest, downloads, and bookmarks key by the immutable
   per-chapter `uuid` that `srv-35` adds (an MVP prereq) — never the positional `id`. The
   existing web player adopts it in the same change.
7. **Never-cross-language / never-wrong-voice** server invariants (plan 162, plan 108)
   are unaffected — the app only *plays* server-rendered audio, it does not synthesize.

## Test plan

This is an epic; concrete paired tests land per item under each item's own plan. The
load-bearing test obligations:

- **`srv-32`** — Vitest server test asserting the manifest shape + `?since` delta + the
  full active-ID set in every response, and (critically) that every audio-mutating path
  bumps the fingerprint.
- **`srv-34`** — Vitest server test: PUT with a valid client `listenedAt` is stored as
  `updatedAt`; a future-dated/absurd `listenedAt` is rejected/clamped; omitting it keeps
  legacy server-stamp behaviour.
- **`app-1`** — the Flutter widget/unit test harness itself + the CI lane
  (`flutter analyze`, tests, debug APK build, unsigned iOS compile `--no-codesign`) is
  part of the work.
- **`app-2..14`** — each ships Dart unit/widget tests; the sync engine (`app-3`) and
  resume sync (`app-6`) get unit tests against a stubbed server; the v1 end-to-end
  scenario (see "v1 scope") is the manual acceptance gate on a real device.

### Manual acceptance walkthrough

The single v1 end-to-end scenario under **v1 scope (definition of done)** is the
acceptance walkthrough. It is run on a real Android device against the user's GPU server
once Wave 6 completes.

## Out of scope

- **Internet exposure / remote (non-LAN) sync** — v1 is home-LAN sync + offline play.
- **iOS release** (`app-12`) — parked Won't-this-round; the codebase stays iOS-ready.
- **Android Auto / CarPlay head-unit UI** (`app-9`) — v1 covers driving via car
  Bluetooth + lock-screen only.
- **Multi-device token management** (`srv-33`) — v1 rides `srv-20`'s single token.
- **Synthesis / generation on-device** — the app is a listening + sync client only; all
  TTS stays server-side.

## Ship notes

The MVP **foundation** shipped 2026-06-06 (the epic stays `draft` until the full v1
definition-of-done passes on a real device — see **Build progress & dev setup** near the
top for the running status):

- `srv-34` — PR #558 (closed #539).
- `srv-20` — PR #561 (middleware) + #564 (D2 pairing payload) (closed #425).
- `srv-35` — PR #569 (closed #540). Plan [190](190-srv-35-stable-chapter-uuid.md).
- `srv-32` — PR #570 (closed #538). Plan [191](191-srv-32-sync-manifest.md).
- `app-1` — PR #562 (closed #541).
- `app-2` — PR #565 + #566 + #567 (closed #542).
- `app-3` — delta sync engine (closed #543): `sync_manifest`/`sync_plan` pure domain,
  `ChapterDownloader` (range-resume + size-integrity + atomic swap over an injectable
  `FileStore`), `LocalLibrary` JSON store, `SyncEngine` (per-book isolation, deferred swap,
  progress stream, active-ID eviction), `ApiClient.syncManifest*`, and a thin
  `flutter_foreground_task` keep-alive shim. 41 paired Dart tests; `flutter analyze` clean +
  debug APK builds. **Live device acceptance owed** — there is no sync-trigger UI yet
  (`app-7`/`app-14`), so the engine is exercised by unit tests only until then.
- `app-4` — offline store (closed #544): **drift/SQLite** `LibraryDatabase` + `DriftLocalLibrary`
  (implements the `app-3` `LocalLibrary` port, so the sync engine runs against it unchanged) +
  accounting/eviction/play-tracking/thumbnails + a one-time `sync-state.json`→drift import shim;
  pure `storage_policy` (auto-delete-finished + LRU book eviction); `ThumbnailCache` +
  `package:image` JPEG downscale (client-side; D11 server `?width=` deferred). On-device store
  only — the **server `state.json` is untouched** (out of plan 188). 25 paired Dart tests;
  generated `.g.dart` committed + excluded from analyze; clean + APK builds. **Live device
  acceptance owed.**
- `app-5` — native player (closed #545): testable `PlayerController` over an injectable
  `AudioEngine` (per-book resume/switch, ~10 s autosave throttle, media-key→seek default via
  `skip_behavior`, `isInUse` for app-3 deferred swap) + drift **Playback** table (schema v2 +
  migration); real `JustAudioEngine` (just_audio) + `CompanionAudioHandler` (audio_service
  lock-screen/Bluetooth/notification) + `MainActivity`→`AudioServiceActivity` + manifest service.
  14 paired Dart tests; clean + APK builds. **Live device acceptance owed.**
- `app-6` — two-way resume sync (closed #546): pure `reconcileResume` (LWW by client
  `listenedAt`, not network-receive time) + `ResumeSyncService` (push/pull/noop over an
  injectable `ListenProgressApi`+`PlaybackStore`+`chapterIdResolver`; local Playback row =
  the offline queue) + `ApiClient.get/putListenProgress` (CA-pinned, `listenedAt` per srv-34).
  12 paired Dart tests; clean + APK builds. **Live device acceptance owed.**
- `app-7` — library browse (closed #547): pure `library_tree` (author→series→book grouping +
  sort + `filterBooks`) + `BookDownloadState`; presentational `LibraryScreen` (collapsible
  groups, search, per-book pill + download/remove). 9 paired Dart tests; clean + APK builds.
  **Live device acceptance owed.**
- `app-13` — settings (closed #549): pure `AppSettings` (sleep timer / speed / skip-silence /
  skip-button behaviour / unmetered-Wi-Fi-only / storage cap + auto-delete-finished +
  keep-recent-books / auto-sync — drives app-5/app-4/app-8) + `SettingsStore` (FileStore JSON,
  defaults-on-corrupt) + testable `SleepTimer` (injectable scheduler) + `SettingsScreen`. 14
  paired Dart tests; clean + APK builds. **Live device acceptance owed.**
- `app-8` — auto-sync on reconnect (closed #548): pure `shouldAutoSync` gate (never
  mobile/offline; unmetered Wi-Fi only unless opted in; only when the paired server is
  reachable → token stays on the home LAN) + `AutoSyncService` (pre-gates before probing, so
  it never probes off-LAN) + pure `networkTypeFromConnectivity` + real `connectivity_plus`
  resolver. 17 paired Dart tests; clean + APK builds. **Live device acceptance owed.**
- `app-14` — home shelf + multi-book switching (closed #550): pure `home_shelf`
  (`buildContinueListening` most-recently-played first; `buildRecentlyUpdated`) +
  `HomeScreen` (Continue-listening + recently-updated rails; tap → `onOpenBook` → player
  `switchBook`). 6 paired Dart tests; clean + APK builds. **Live device acceptance owed.**
  **MVP app block (app-1..8,13,14) complete.**
- `app-11` — distribution (closed #554): Gradle release signing reads git-ignored
  `android/key.properties` (real upload keystore) with a **debug-signed fallback**, so
  `flutter build apk --release` always builds an installable sideload APK; `key.properties.example`
  documents keystore generation + CI-secret wiring; CI publishes a `companion-release-apk`
  artifact each build. Build-config only (no Dart tests); release APK verified locally (65.6 MB).
  **To ship a properly-signed alpha:** `keytool -genkey -v -keystore upload-keystore.jks
  -keyalg RSA -keysize 2048 -validity 10000 -alias upload`, drop `android/key.properties`
  (see the example), then `flutter build apk --release`; sideload `app-release.apk`.
  - **Google Play channel (2026-06-13):** the real upload keystore now exists
    (`apps/android/android/app/upload-keystore.jks`, alias `upload`, RSA-2048,
    valid → 2053; upload-cert SHA-256 `ba7b147d…`). `flutter build appbundle
    --release` produces a Play-ready **AAB** signed by that upload key (verified:
    `keytool -printcert -jarfile app-release.aab` → `CN=Mikhail Dudarenok,
    O=Castwright`). The AAB is a **second, parallel channel** for Play
    internal/closed testing — it does **not** replace the sideload APK, which the
    release zip still bundles at `companion/castwright-companion.apk` for
    `GET /api/companion/apk`. CI (`app.yml`) gained a `bundleRelease`
    build-health step (debug-signed; not a Play artifact). The **release
    pipeline** (`release.yml`) now materialises the upload keystore from four
    `ANDROID_UPLOAD_*` repo secrets, signs the release APK **and** AAB with the
    upload key, and attaches `castwright-vX.Y.Z.aab` (+`.sha256`) to the GitHub
    Release (skipped, debug-fallback, when the secret is absent). Wiring the
    upload key into release CI also fixes a latent sideload bug: hosted-runner
    debug keystores drift per run, so debug-signed sideload APKs couldn't update
    in place across releases — upload-key signing gives a stable identity.
    **versionCode iteration band:** `bump-version.mjs` now derives the
    versionCode as `(M*10000+m*100+p)*1000` (1.6.0 → 10600000); the ×1000
    reserves 999 iteration slots so successive Play uploads of the *same*
    marketing version take `base+1, base+2, …`
    (`flutter build … --build-number=<N>`) without colliding with the next
    patch's base — Play forbids reusing a versionCode. Play caveats:
    Android Auto (`app-9`) needs a separate Cars review; App Links (`app-17`)
    must pin the **Play app-signing** key fingerprint in `assetlinks.json`, read
    from Console post-enrollment. Full build/sign/upload doc lives in
    `apps/android/README.md` ("Two distribution channels"). Console-side steps
    (account, create-app + Play App Signing opt-in, App content declarations)
    are maintainer-only.
- `app-9` — in-car (closed #552): pure `media_browse_tree` (root→books→chapters `MediaNode` +
  mediaId codec + `childrenOf`) wired into `CompanionAudioHandler.getChildren`/`playFromMediaId`
  (audio_service `MediaBrowser`, Android Auto + CarPlay) + Android Auto descriptor
  (`automotive_app_desc.xml` + manifest meta-data). 6 paired Dart tests; clean + APK builds.
  **Live device/head-unit acceptance owed.**
- `app-10` — stream-over-LAN instant play (closed #553): pure `resolvePlaybackSource`
  (offline-first: downloaded → local; else streaming-on + on-LAN → stream; else download) +
  `AppSettings.streamOverLan` toggle (default off) + `AudioEngine.setStreamUrl` (just_audio
  `AudioSource.uri` + auth headers) + a settings switch. 4 paired Dart tests; clean + APK
  builds. **Live device acceptance owed.**

**The `app-*` build track (through `app-10`) is code-complete** — all items built, tested
(167 Dart tests), and merged; `flutter analyze` clean and the debug + release APKs build, with
CI (android + unsigned-iOS + verify) green on every PR. The remaining work is the **batched
live-device/head-unit acceptance pass** on the user's real GPU server. Parked follow-ups:
`srv-33`, `app-12` (iOS release).

- 2026-06-13 — `app-15` (iOS `AppIcon` set rendered square + opaque from
  `brand/castwright-icon.svg`, replacing the default Flutter logo) + `app-16`
  (companion brand audit — clean on the hard criteria; added the v2 short-form
  tagline _"Any book, fully cast."_ to the pairing + empty-home surfaces, plus a
  `lib/` source-scan guard against retired copy) shipped on
  `feat/app-companion-brand-finish`. Closes #632, #706.
