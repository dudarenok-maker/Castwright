# app-18 — re-bump connectivity_plus to 7.x on the iOS-26 toolchain (design)

- **Date:** 2026-06-19
- **Backlog item:** `app-18` ([#895](https://github.com/dudarenok-maker/Castwright/issues/895))
- **Status:** design approved; ready for implementation plan
- **Branch:** `chore/app-connectivity-plus-7`
- **Type / scope:** `chore(app)` — dependency currency, no feature

## Problem

Deps round 4 (plan 224, PR #894) tried to bump the companion's
`connectivity_plus` 6.1.0 → 7.1.1. Android passed; the **iOS compile failed**
in `app.yml`'s `ios-compile` guard:

```
Swift Compiler Error (Xcode): Value of type 'NWPath' has no member 'isUltraConstrained'
  connectivity_plus-7.1.1/ios/.../PathMonitorConnectivityProvider.swift:28
```

connectivity_plus 7.x's iOS Network-framework code references
`NWPath.isUltraConstrained`, an **iOS 26 SDK** symbol. The CI runner's Xcode
didn't ship that SDK, so it was reverted to 6.1.0 (whose Dart API is identical)
and tracked as `app-18` / #895, "blocked on the GitHub macOS image shipping that
SDK."

## What changed since #895 was filed

That blocking condition is now **satisfied**. GitHub's **`macos-26` hosted
runner image went GA on 2026-02-26**
([changelog](https://github.blog/changelog/2026-02-26-macos-26-is-now-generally-available-for-github-hosted-runners/)),
carrying **Xcode 26.x with the iOS 26 SDK** — the SDK that defines
`NWPath.isUltraConstrained`. This is a **GA** toolchain, not a beta, so there is
no beta-toolchain risk. Apple additionally now mandates building against the
iOS 26 SDK, so moving the compile guard there is the correct direction
independent of this dep.

The job is still red today only because `app.yml`'s `ios-compile` job runs on
`runs-on: macos-latest` with **no explicit Xcode pin**: `macos-latest` lags the
newest image by a release or two, and an image's *default-selected* Xcode is not
guaranteed to be the newest one installed. So it compiles against an older SDK.

## Ground truth (verified 2026-06-19)

- **Pin:** `apps/android/pubspec.yaml:66` → `connectivity_plus: 6.1.0` (exact, no
  caret).
- **Dart consumers:**
  - `apps/android/lib/src/data/network_info.dart` — calls only
    `Connectivity().checkConnectivity()` → `List<ConnectivityResult>`, mapped by
    a pure `networkTypeFromConnectivity()` helper. No streams, no advanced API.
  - `apps/android/lib/src/data/companion_runtime.dart` — singleton instantiation.
  - This API surface is **identical** between 6.x and 7.x.
- **Tests:** `apps/android/test/data/network_info_test.dart` (5 tests) locks the
  `checkConnectivity()` → `List<ConnectivityResult>` shape.
- **CI:** `.github/workflows/app.yml` `ios-compile` job — `runs-on: macos-latest`,
  `subosito/flutter-action@v2` pinned to `flutter-version: 3.44.1`, runs
  `flutter build ios --no-codesign` (unsigned compile guard; no iOS distribution,
  Android-only product). `app.yml` triggers automatically on `apps/android/**`
  changes.
- **iOS project:** `apps/android/ios/` exists; `IPHONEOS_DEPLOYMENT_TARGET = 13.0`.
- **Lockstep guard (Trip B):** `app.yml` asserts the Flutter pin matches
  `app-deps-watch.yml` via a grep (`flutter-version:` must be a single unique
  value across both files).
- **Monthly watch:** `app-deps-watch.yml` A1 channel is currently **RED-by-design**
  because connectivity_plus is held behind latest.

## Goal

Re-bump `connectivity_plus` to the latest 7.x on a toolchain that can compile it,
keeping every other behaviour unchanged, and retire the #895 tracking item.

Non-goals: no feature work, no API change, no change to the iOS deployment floor,
no change to the Flutter pin, no new CI guard beyond the Xcode pin.

## Design

### 1. `.github/workflows/app.yml` — `ios-compile` job

Move the job onto the GA iOS-26 toolchain with an **explicit image + explicit
Xcode pin** (matches the repo's exact-pin / lockstep culture and survives GitHub
flipping `macos-latest` or rotating an image's default Xcode):

```yaml
ios-compile:
  runs-on: macos-26                 # was: macos-latest
  steps:
    - uses: actions/checkout@v6
    - uses: maxim-lobanov/setup-xcode@v1
      with:
        xcode-version: '26'         # newest 26.x present on the image
    - uses: subosito/flutter-action@v2
      with:
        channel: stable
        flutter-version: 3.44.1     # unchanged — lockstep guard still holds
        cache: true
    - run: flutter pub get
    - run: flutter build ios --no-codesign
```

- `xcode-version: '26'` resolves to the newest installed **26.x**, not a specific
  point release — so a removed point release can't break us, while the SDK floor
  is guaranteed.
- The Android jobs and the Trip-B grep assertions are untouched; `flutter-version`
  stays `3.44.1`, so the app.yml ↔ app-deps-watch.yml lockstep assertion still
  passes.

### 2. `apps/android/pubspec.yaml`

```diff
- connectivity_plus: 6.1.0
+ connectivity_plus: 7.1.1   # or latest 7.x at implementation time
```

Re-resolve with `flutter pub get` and commit the refreshed `pubspec.lock`. Keep
the exact-pin (no-caret) style consistent with the surrounding deps.

### 3. Docs / tracking

- PR body: `Closes #895`.
- Remove the `app-18` row from `docs/BACKLOG.md`.
- Update the behaviour-delta note in
  `docs/features/archive/224-deps-round-4.md` to record the re-bump landing
  (replacing the "reverted, tracked as app-18" note).
- No change to `app-deps-watch.yml` / `deps-watch.mjs`: the A1 RED-by-design
  state clears automatically once 7.x is the resolved version — a free
  post-merge confirmation signal.

## Behaviour / data flow

Unchanged. `network_info.dart` calls the same `checkConnectivity()` API.
`NWPath.isUltraConstrained` is runtime-gated inside connectivity_plus
(`if #available`), so iOS 13.0 devices are unaffected — the symbol only needs to
*exist in the SDK* to compile, which the iOS 26 SDK provides.

## Testing & verification

Per the project's testing-discipline rule, the paired coverage for this change is:

- **Existing unit net (API):** `network_info_test.dart` must stay green on 7.x —
  the `checkConnectivity()` → `List<ConnectivityResult>` shape is unchanged.
- **The CI `ios-compile` guard is the regression test for this issue** — it
  failed on 7.x before, must pass after. This is the authoritative check and
  **cannot be run locally** (no macOS/Xcode on the dev box; no local hook builds
  iOS). `app.yml` fires automatically on `apps/android/**` changes, so the PR
  push exercises it.
- **Android APK/AAB jobs** in `app.yml` must stay green (they already passed with
  7.x in round 4).
- **No new unit test is added.** The Dart API is byte-identical across the bump,
  so a fresh test would be gold-plating; the CI compile guard plus the existing
  tests fully cover the change. (Called out explicitly per the before-shipping
  checklist rather than silently skipped.)

## Risks & mitigations

| Risk | Mitigation |
|---|---|
| Image's default Xcode drifts off 26 on a future refresh | Explicit `xcode-version: '26'` pin (the reason for the chosen CI option). |
| `'26'` floats to a 26.x GitHub later removes | `'26'` resolves to the newest **present** 26.x, so this can't strand the build; we deliberately avoid pinning a dead point release. |
| Xcode 26 missing Swift compat libs (the Firebase caveat seen in the wild) | Does not apply — the companion uses no Firebase; connectivity_plus is the only iOS-native plugin in play. |
| Re-bump silently reverted later by a deps sweep | Out of scope; the monthly `app-deps-watch` A1 channel would surface a regression. |

## Adjacent items considered (kept out of scope)

Moving the iOS-compile job to `macos-26` is the kind of toolchain change that can
unblock adjacent deferrals, so this was checked deliberately:

- **No other deferral is unblocked.** Among round-4 deferrals, connectivity_plus
  is the *only* iOS-SDK-blocked item. `ops-14` (eslint 9→10, JS plugin caps),
  `srv-4` (node-domexception, transitive pin), `side-17` (sidecar engine deps,
  needs a GPU box + golden-audio gate), and `#790` (KGP plugins, waiting on
  Android plugin-author migration) are all blocked on axes that have nothing to
  do with Xcode/iOS SDK. The runner move touches app-18 alone.
- **No Flutter upgrade is pending or required.** The pin `3.44.1` is already on
  the current stable line (latest is 3.44.x, May 2026), and Flutter has supported
  Xcode 26 / the iOS 26 SDK since **3.38** — so `3.44.1` builds on the iOS 26 SDK
  with no change, and the pin was *not* held back by Xcode. The Flutter pin and
  its lockstep guard stay untouched. (Forward note only: flutter/flutter#187741
  would raise the iOS minimum 13→15 for **Xcode 27** — a future item, irrelevant
  here; the 13.0 floor is fine on Xcode 26.)
- **New SDK deprecation warnings are a non-issue.** Compiling against the iOS 26
  SDK may surface new deprecation *warnings* in plugins, but
  `flutter build ios --no-codesign` does not fail on warnings — so there is no
  hidden follow-on fix to fold in.

## Acceptance

1. `app.yml` `ios-compile` job is **green** on the PR (compiles connectivity_plus
   7.x against the iOS 26 SDK).
2. `app.yml` Android jobs stay green; `network_info_test.dart` passes.
3. Trip-B lockstep assertion still passes (Flutter pin unchanged).
4. #895 closed; `docs/BACKLOG.md` row removed; archive 224 note updated.
5. Post-merge: monthly `app-deps-watch` A1 channel no longer flags
   connectivity_plus as behind.
