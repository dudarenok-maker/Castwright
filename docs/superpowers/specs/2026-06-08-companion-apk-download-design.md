# Companion APK download — interim "third distribution method" (design)

- **Date:** 2026-06-08
- **Scope:** `server` + `frontend` + `scripts` + `ci` + `openapi`
- **Builds on:** the Listen-tab companion banner
  (`docs/superpowers/specs/2026-06-08-listen-companion-app-design.md`) and the
  companion app (plan 188, `apps/android`).

## Context

The Listen-tab Castwright Companion banner shipped with two mocked, disabled
store buttons (Google Play / App Store). Until the app lists on the stores, we
offer the packaged Android APK as a **third distribution method** — a direct
sideload download — without touching the store-button placeholders.

## Decisions

| Decision | Choice |
|---|---|
| How to present it | A **new "Download .apk" button** next to the two store buttons (stores untouched) |
| When it shows | **Only when an APK is present** at the server's resolved location (probed via HEAD) — never a dead control; hidden in dev/mock |
| Where the APK lives | Server-served from a drop folder: env `COMPANION_APK_PATH` → default `<release-root>/companion/castwright-companion.apk` |
| Availability probe | **HEAD** `/api/companion/apk` (no extra JSON endpoint); `Content-Length` feeds a size hint |
| Release wiring | The release **bundles the APK into the zip** at `companion/castwright-companion.apk` so the install serves it immediately |

## Server

- **`server/src/companion/apk.ts`** — `resolveCompanionApkPath()` (env override
  → default release-root drop folder, read per-call so a deploy needn't restart)
  and `readCompanionApkInfo()` (stat → `{ available, sizeBytes, filename }`,
  never throws).
- **`server/src/routes/companion.ts`** — `GET /api/companion/apk`: streams the
  APK as an attachment (`application/vnd.android.package-archive`,
  `Content-Disposition: attachment; filename="castwright-companion-<version>.apk"`)
  or **404** when absent. Express serves **HEAD** on the same route → the
  frontend's availability probe. Mounted at `/api/companion` in `index.ts`.
- Documented in `openapi.yaml`; `COMPANION_APK_PATH` in `server/.env.example`.

## Frontend

- **`api.checkCompanionApk()`** → `{ available, sizeBytes }` — real does a HEAD
  probe (reads `res.ok` + `Content-Length`, never throws); **mock returns
  `{ available: false }`** so dev/e2e stay in the store-only state.
- **`CompanionAppBanner`** probes on mount. When available it renders a real
  `<a href="/api/companion/apk" download>` "Download .apk" button (with a size
  hint) as a third button; the two store buttons stay disabled/coming-soon.

## Release process

- **`scripts/build-release-zip.mjs`** stages the APK into the zip at
  `companion/castwright-companion.apk` when a source exists. Source resolves from
  `COMPANION_APK_SRC` (CI) → default Flutter output
  (`apps/android/build/app/outputs/flutter-apk/app-release.apk`). Absent →
  logged `[APK] SKIP`, zip still valid (button just hides).
- **`.github/workflows/release.yml`** — a new `companion-apk-build` job builds
  the APK **once** and uploads it as a workflow artifact; `publish`
  (`needs: [verify, companion-apk-build]`) downloads it, sets `COMPANION_APK_SRC`
  so the zip bundles it, **and** attaches it (+ checksum) as a standalone release
  asset. The old standalone `companion-apk` job is removed (its work split into
  the two). `companion-ios` unchanged.
- **`.gitignore`** ignores `/companion/` so a locally-dropped test APK can't be
  committed.

## Testing

- **Server** (`companion.test.ts`): 404 when absent; 200 + `apk` content-type +
  `attachment` disposition when an APK is pointed at via `COMPANION_APK_PATH`;
  HEAD 200 + `Content-Length` present / 404 absent.
- **Frontend** (`companion-app-banner.test.tsx`): apk button hidden when
  unavailable; renders as a real download link (`href`, `download`, size hint)
  when available; store buttons stay disabled in both states.
- **Scripts** (`release-manifest.test.mjs`): `companionApkZipEntry` nests under
  the release prefix; `companionApkSrc` honours `COMPANION_APK_SRC` else the
  Flutter default. Dry-run verified for both the SKIP and bundled paths.

## Out of scope

- Building/signing the APK locally (CI builds it; release-build falls back to
  debug signing when no keystore — fine for a direct sideload).
- Real Play Store / App Store listings; the two store buttons stay mocked.
- A shipped user data migration or auto-update of a sideloaded APK.

## Verification

1. `npm run verify` green (typecheck + tests + e2e + build).
2. Drop a built APK at `<repo>/companion/castwright-companion.apk` (or set
   `COMPANION_APK_PATH`), run the real server, open the Listen tab → the
   "Download .apk" button appears and downloads the APK; remove it → the button
   disappears.
3. `COMPANION_APK_SRC=<apk> node scripts/build-release-zip.mjs --version vX.Y.Z
   --dry-run` lists `…/companion/castwright-companion.apk` in the manifest.
