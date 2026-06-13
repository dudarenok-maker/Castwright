# Castwright — Android companion

`castwright` — a native **Flutter** listening companion for the
Castwright server app. It pairs to your server over the home LAN (HTTPS,
cert-pinned), **delta-syncs only the chapters that changed**, and plays them
offline with background / lock-screen / Bluetooth controls. Android-first; the
codebase is iOS-ready (one Flutter project, the iOS target lives here too).

Full architecture, the item-by-item delivery log, and the v1 definition-of-done
live in the umbrella plan: [`docs/features/188-android-companion-app.md`](../../docs/features/188-android-companion-app.md).

## What it does

- **Delta sync** — consumes the server's two-level sync-manifest
  (`GET /api/library/sync-manifest`) and re-pulls only chapters whose audio
  changed (keyed by a stable per-chapter `uuid`, not the positional id), with
  resumable range downloads, integrity checks, and atomic swap.
- **Offline store** — drift/SQLite per-chapter audio + metadata + cover
  thumbnails, with storage accounting and auto-eviction (delete-finished /
  least-recently-listened).
- **Native player** — `just_audio` + `audio_service`: background playback,
  lock-screen + Bluetooth controls, per-book resume, ~10 s autosave, sleep
  timer; media-key skip defaults to ±30/±15 s seek (toggle to chapter-skip).
- **Two-way resume** — pushes your listening position back to the server,
  last-write-wins by listen time (never clobbers a newer position).
- **Browse / home** — author → series → book browse + a "Continue listening"
  shelf with seamless multi-book switching.
- **In-car** — Android Auto + CarPlay media-browser tree.
- **LAN streaming (opt-in)** — start an undownloaded chapter instantly at home.

## Prerequisites

- **Flutter** 3.44.1+ (stable) and the **Android SDK** (cmdline-tools +
  platform-tools; `adb` on PATH). Confirm with `flutter doctor`.
- An Android device or emulator (the project's AVD is `Pixel_10_Pro`).

## Build / test / run (from `apps/android/`)

```sh
flutter pub get
flutter analyze        # zero-tolerance — even info lints fail CI
flutter test           # pure Dart VM unit + widget tests (no device needed)
flutter build apk --debug          # build/app/outputs/flutter-apk/app-debug.apk
```

Run on a device/emulator:

```sh
flutter emulators --launch Pixel_10_Pro   # or plug in a phone
flutter run                                # or: adb install -r build/app/outputs/flutter-apk/app-debug.apk
```

> On a 16 KB-page-size emulator image (e.g. recent Pixel images) Android shows a
> one-time "not 16 KB compatible" notice for the **debug** build's native libs
> and runs them in page-size compatibility mode — it's not a crash. It doesn't
> appear on typical 4 KB-page phones; proper 16 KB alignment is a release/Play
> concern.

A signed release APK for sideloading: see **`app-11`** in the plan
(`flutter build apk --release` — falls back to debug signing unless
`android/key.properties` is present; copy `android/key.properties.example`).

## Two distribution channels: sideload APK + Play AAB

The companion ships through **two parallel channels** — both built from the same
signed release config, neither replaces the other:

1. **Sideload APK** (`flutter build apk --release`) — the load-bearing channel.
   The release pipeline bundles it into the server zip at
   `companion/castwright-companion.apk`, where `GET /api/companion/apk` serves
   the in-app **Download .apk** button. This stays the default install path.
2. **Google Play App Bundle** (`flutter build appbundle --release`) →
   `build/app/outputs/bundle/release/app-release.aab` — for the Play
   **internal/closed testing** track. Play requires an **AAB**, not an APK.

```sh
flutter build appbundle --release   # build/app/outputs/bundle/release/app-release.aab
```

**Play signing model (Play App Signing):** the `android/key.properties`
keystore is your **upload key** — you sign every AAB upload with it; Google
holds the app *signing* key and re-signs what users download. The AAB **must**
be signed with the real upload key, which Play accepts but a debug-signed bundle
is rejected.

**Two ways to get a signed AAB:**

- **Release pipeline (preferred for tagged releases).** With the four
  `ANDROID_UPLOAD_*` repo secrets set (see `android/key.properties.example`),
  `.github/workflows/release.yml` materialises the keystore, builds the
  **upload-key-signed** APK *and* AAB, and attaches
  `castwright-vX.Y.Z.aab` (+ `.sha256`) to the GitHub Release. Without the
  secrets it falls back to debug signing and skips the AAB attach.
- **Locally (for ad-hoc Play uploads).** With `android/key.properties` present:
  `flutter build appbundle --release`.

Verify a build with `keytool -printcert -jarfile app-release.aab` (AABs are
JAR-signed, so `keytool` reads them; APKs are v2-signed — use
`apksigner verify --print-certs` for those).

### Iterating internal-test builds (no marketing bump)

Play forbids reusing a **versionCode**, so a second upload of the *same*
marketing version needs a higher code. `bump-version.mjs` derives the
versionCode as `(M*10000 + m*100 + p) * 1000` — the `×1000` reserves a 3-digit
**iteration band** (999 slots) below the next patch's base. So for `1.6.0` the
base is `10600000`; iterate internal-test uploads by overriding the build
number:

```sh
flutter build appbundle --release --build-number=10600001   # 2nd 1.6.0 upload
flutter build appbundle --release --build-number=10600002   # 3rd, etc.
```

The tagged **release** uses the base (iteration 0). To ship a tested build to
production, **promote** the chosen internal build in Play Console (same
versionCode — no re-upload) rather than re-cutting iteration 0, or bump the
patch. The iteration band never overlaps the next patch (`1.6.1 → 10601000`).

**versionCode** is derived monotonically from the semver by
`scripts/bump-version.mjs` (`M*10000 + m*100 + p`, e.g. `1.6.0 → 10600`), so
each released version uploads cleanly. Play forbids reusing a versionCode —
**bump the version before re-uploading the same train to a Play track.**

**Two Play caveats** (neither blocks internal testing):
- **Android Auto** (`app-9`, the `com.google.android.gms.car.application`
  descriptor) triggers a separate Play "Cars" review before Auto works on a
  head unit. The app still installs to internal testing without it.
- **App Links** (`castwright.ai/pair`, `app-17`) need
  `/.well-known/assetlinks.json` to pin the **Play app-signing key** SHA-256
  (read it from Play Console *after* enrollment — not the upload-key
  fingerprint).

## Pairing to your server

The companion needs the server running in **LAN HTTPS mode with an access
token** (see the root [`README.md`](../../README.md#companion-app-android) and
[`INSTALL.md`](../../INSTALL.md)). Then in the app: **Pair a device** → scan the
pairing QR, or enter the **Server URL** (`https://<lan-ip>:8443`), **access
token**, and **CA fingerprint (SHA-256)** by hand. The app fetches
`/cert/root.crt`, verifies its SHA-256 against the scanned/entered fingerprint,
and pins the CA itself — **no OS root-cert install is needed on the phone**
(that's the app-managed-TLS-trust design).

## Architecture (where things live)

- `lib/src/domain/` — pure models + logic (sync manifest/plan, storage policy,
  resume reconcile, skip behaviour, library tree, home shelf, media-browse tree,
  app settings, sleep timer) — fully unit-tested, no IO.
- `lib/src/data/` — adapters over injectable IO seams: `api_client` (cert-pinned
  HTTP), `sync_engine` + `chapter_downloader` + `file_store` + `local_library`
  (drift), `player_controller` + `just_audio_engine` + `companion_audio_handler`,
  `resume_sync_service`, `settings_store`, `network_info`, `cover_thumbnails`.
- `lib/src/ui/` — screens (pairing, QR scan, library, settings, home).

The discipline throughout: a **pure, unit-tested brain over injectable IO**, with
native plugins (just_audio / audio_service / drift / connectivity / secure
storage / flutter_zxing) at the thin, device-tested edge.

## CI

`.github/workflows/app.yml` (path-filtered to `apps/android/**`) runs
`flutter analyze` + `flutter test` + a debug **and** release APK build on Ubuntu,
plus an unsigned iOS compile on macOS to keep the codebase iOS-ready.
