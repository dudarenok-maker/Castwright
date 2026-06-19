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
and its **default Xcode is 26.4.1**, which ships the **iOS 26 SDK** — the SDK
that defines `NWPath.isUltraConstrained`. This is a **GA** toolchain, not a beta,
so there is no beta-toolchain risk. Apple additionally now mandates building
against the iOS 26 SDK, so moving the compile guard there is correct independent
of this dep.

Why the job is red today is a **determinism** problem, not "the SDK exists
nowhere": `app.yml`'s `ios-compile` job runs on `runs-on: macos-latest`, and
`macos-latest` **began its rolling migration to macOS 26 on 2026-06-15** (a
30-day rollout, [migration notice](https://github.blog/changelog/2026-05-14-github-actions-upcoming-image-migrations/)).
Mid-migration, a given job can still land on the **old** image (macOS 15 / Xcode
16.x, no iOS 26 SDK) — which is exactly why the round-4 attempt failed on
2026-06-18. Pinning `runs-on: macos-26` removes that coin-flip: the job
deterministically gets the iOS-26-SDK image with **no Xcode-selection step
needed** (the image default *is* Xcode 26.4.1). An explicit `setup-xcode` pin was
considered and rejected — it only *selects* a pre-installed Xcode and hard-fails
if the match is absent, and a bare-major (`'26'`) merely floats to the newest
installed 26.x, adding fragility without real determinism (see "Adjacent items"
and the rejected alternative below).

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

Pin the job's **image** to the GA iOS-26 runner; take its default Xcode (26.4.1,
iOS 26 SDK). One-line change, no extra step:

```yaml
ios-compile:
  runs-on: macos-26                 # was: macos-latest
  steps:
    - uses: actions/checkout@v6
    - uses: subosito/flutter-action@v2
      with:
        channel: stable
        flutter-version: 3.44.1     # unchanged — lockstep guard still holds
        cache: true
    - run: flutter pub get
    - run: flutter build ios --no-codesign
```

- **No `setup-xcode` step.** The `macos-26` image default is already Xcode 26.4.1
  with the iOS 26 SDK, so a select step is redundant; and `maxim-lobanov/setup-xcode`
  only *selects* a pre-installed Xcode (hard-fails if the match is absent), so a
  bare-major `'26'` pin adds fragility (illusion of pinning that floats to the
  newest installed 26.x) without real determinism. Determinism here comes from
  pinning the **image**, which is enough.
- **The Android jobs and the Trip-B grep assertions are untouched.**
  `flutter-version` stays `3.44.1` in both jobs, so the app.yml ↔
  app-deps-watch.yml lockstep assertion (it greps `flutter-version:` for a single
  unique semver) still passes — `runs-on:` is not part of that guard.

### 2. `apps/android/pubspec.yaml`

```diff
- connectivity_plus: 6.1.0
+ connectivity_plus: 7.1.1   # current latest 7.x (re-resolve at impl time)
```

Re-resolve with `flutter pub get` and commit the refreshed `pubspec.lock`. Keep
the exact-pin (no-caret) style consistent with the surrounding deps.

Verified constraints (adversarial review, 2026-06-19):
- **7.1.1 `environment:` floor is Dart ≥3.3.0 / Flutter ≥3.19.0** — `3.44.1`
  clears it comfortably; **no Flutter bump required** (and so no Trip-B guard
  churn).
- **iOS podspec floor is `:ios, '12.0'`** — our `IPHONEOS_DEPLOYMENT_TARGET =
  13.0` satisfies it; **no deployment-target bump required**.
- The iOS-26-SDK compile requirement enters at **7.1.0** (it added satellite
  support → `isUltraConstrained`); 7.1.1 is a docs-only follow-up. Targeting
  7.1.1 is correct.
- **The bump is global, not iOS-only.** connectivity_plus 7.0.0 also raised
  Android floors (AGP ≥8.12.1 / Gradle ≥8.13 / Kotlin 2.2.0; minSdk→21 at 7.1.0)
  — but round 4 already proved 7.1.1 builds the Android side green, and this
  PR's `android` job + local `flutter analyze`/`test` re-confirm it.

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

Per the project's testing-discipline rule, the paired coverage for this change is.
Most of it **can be run locally on the Windows dev box** — only the iOS Swift
compile is genuinely CI-only:

- **Local (Windows), before pushing** — the same Dart-side checks the ubuntu
  `android` job runs: `flutter pub get` (confirms 7.1.1 resolves on 3.44.1),
  `flutter analyze`, `flutter test` (incl. `network_info_test.dart`, whose
  `checkConnectivity()` → `List<ConnectivityResult>` shape is unchanged on 7.x),
  and `flutter build apk --debug` if the local Android toolchain is set up. This
  catches any Dart/Android regression before CI.
- **CI-only — the one thing the dev box can't run:** the `ios-compile` job
  (`flutter build ios --no-codesign`). This is **the regression test for this
  very issue** — it failed on 7.x before, must pass after — and needs macOS/Xcode.
  `app.yml` fires automatically on `apps/android/**` + `.github/workflows/app.yml`
  changes, so the PR push exercises it; on `pull_request` GitHub uses the
  workflow from the head branch, so the `macos-26` change takes effect on its own
  PR.
- **Android APK/AAB jobs** in `app.yml` must stay green (already passed with 7.1.1
  in round 4).
- **Trip-B lockstep + KGP-flag guards** must stay green (unaffected — Flutter pin
  and `gradle.properties` untouched).
- **No new unit test is added.** The Dart API is byte-identical across the bump,
  so a fresh test would be gold-plating; the existing `network_info_test.dart`
  plus the CI iOS-compile guard fully cover the change. (Called out explicitly per
  the before-shipping checklist rather than silently skipped.)

## Risks & mitigations

| Risk | Mitigation |
|---|---|
| Pinning `macos-26` means we won't auto-pick up a future `macos-27` | Acceptable — determinism is the goal; when GitHub ships macos-27 we revisit deliberately (and note flutter/flutter#187741 would raise iOS min 13→15 for **Xcode 27**, a real future task). The `macos-26` image is GA and supported, not a soon-to-expire preview. |
| `macos-26` default Xcode shifts within 26.x on an image refresh | Harmless — any 26.x ships the iOS 26 SDK, which is all the compile needs; we deliberately do **not** pin a point release that could be removed. |
| iOS 26 *simulator runtime* sometimes missing on the macos-26 image | Does not apply — `flutter build ios --no-codesign` builds for **device**, not simulator; no simulator runtime is loaded. (Flagged for any future simulator/test step on this runner.) |
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
