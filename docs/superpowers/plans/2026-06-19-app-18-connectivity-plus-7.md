# app-18 — connectivity_plus 7.x on macos-26 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Re-bump the Flutter companion's `connectivity_plus` 6.1.0 → 7.1.1 and move the `ios-compile` CI job onto the GA `macos-26` runner (iOS 26 SDK), unblocking #895.

**Architecture:** Two one-line config changes plus docs. `apps/android/pubspec.yaml` bumps the dep; `.github/workflows/app.yml`'s `ios-compile` job switches `runs-on: macos-latest → macos-26` (whose default Xcode 26.4.1 ships the iOS 26 SDK that connectivity_plus 7.1.0+ needs to compile). No application source, no Flutter bump, no iOS deployment-target change.

**Tech Stack:** Flutter 3.44.1 (pinned), Dart, GitHub Actions (`subosito/flutter-action@v2`), pub.

## Global Constraints

- **Branch:** `chore/app-connectivity-plus-7` (already cut). Type/scope: `chore(app)`.
- **connectivity_plus pin is exact (no caret):** `connectivity_plus: 7.1.1` — verify it is the latest 7.x at implementation time; use a newer 7.x only if one has shipped. Never re-introduce a caret.
- **Do NOT change the Flutter pin.** It stays `3.44.1` in **both** `app.yml` jobs. The Trip-B lockstep guard (`app.yml` lines 84–101) greps `flutter-version:` across `app.yml` + `app-deps-watch.yml` and fails on any drift.
- **Do NOT add a `setup-xcode` step.** `macos-26`'s default Xcode (26.4.1) already has the iOS 26 SDK; a select step is redundant and hard-fails if the match is absent.
- **Do NOT touch:** the Android job, `android/gradle.properties` (KGP escape-hatch flags), `app-deps-watch.yml`, or `ios/Runner.xcodeproj/project.pbxproj` (`IPHONEOS_DEPLOYMENT_TARGET = 13.0` stays — 7.x's iOS podspec floor is 12.0).
- **Verification reality:** the Dart/Android side is locally verifiable on this Windows box (`flutter pub get` / `analyze` / `test`). The **iOS compile is CI-only** — `app.yml` runs it on the PR push; that green run is the acceptance gate. On Windows/PowerShell the binary is `flutter.bat`; under the Bash tool / git-bash use `flutter` if on PATH.
- **Spec:** `docs/superpowers/specs/2026-06-19-app-18-connectivity-plus-7-design.md`.

---

### Task 1: Bump connectivity_plus to 7.1.1 (Dart side, locally verified)

**Files:**
- Modify: `apps/android/pubspec.yaml:66`
- Modify (generated): `apps/android/pubspec.lock` (via `flutter pub get`)
- Test (existing, unchanged): `apps/android/test/data/network_info_test.dart`

**Interfaces:**
- Consumes: nothing from prior tasks.
- Produces: `pubspec.yaml` pinned at `connectivity_plus: 7.1.1` and a refreshed `pubspec.lock` — Task 2 (CI runner) depends on this dep being present so the iOS compile actually exercises the 7.x Swift code.

> Note on TDD: this is a no-op API change — connectivity_plus 6.x and 7.x expose the identical Dart surface (`Connectivity().checkConnectivity() → List<ConnectivityResult>`). The existing `network_info_test.dart` (5 cases) is the regression net and must stay green **before and after** the bump; we do **not** fabricate a new failing test (it would be gold-plating — see spec "Testing & verification").

- [ ] **Step 1: Confirm the latest 7.x version**

Run (from `apps/android`):
```bash
cd apps/android
flutter pub outdated --show-all | grep connectivity_plus
```
Expected: a row showing `connectivity_plus` with `Latest` at `7.1.1` (or newer). Use that exact version in Step 2. If `Latest` is a `6.x` (unexpected — pub cache stale), run `flutter pub cache repair` and retry.

- [ ] **Step 2: Bump the pin in pubspec.yaml**

Change `apps/android/pubspec.yaml:66`:
```diff
- connectivity_plus: 6.1.0
+ connectivity_plus: 7.1.1
```
(Exact pin, no caret — match the surrounding deps.)

- [ ] **Step 3: Resolve and refresh the lockfile**

Run (from `apps/android`):
```bash
flutter pub get
```
Expected: `Got dependencies!` (or `Changed N dependencies!`), exit 0, and `pubspec.lock` now shows `connectivity_plus 7.1.1`. If it errors with a Dart/Flutter SDK constraint, STOP — the spec verified 7.1.1's floor is Dart ≥3.3 / Flutter ≥3.19, which 3.44.1 clears, so a failure here means an unexpected newer version; reassess before proceeding.

- [ ] **Step 4: Verify the Dart side is green (the existing regression net)**

Run (from `apps/android`):
```bash
flutter analyze
flutter test test/data/network_info_test.dart
```
Expected: `analyze` → `No issues found!`; `test` → all 5 cases **pass** (the `List<ConnectivityResult>` mapping is unchanged on 7.x). Optionally run the full `flutter test` (round 4 baseline: 306/306).

- [ ] **Step 5: Commit**

```bash
git add apps/android/pubspec.yaml apps/android/pubspec.lock
git commit -m "chore(app): bump connectivity_plus 6.1.0 -> 7.1.1 (#895)"
```

---

### Task 2: Move the ios-compile job to macos-26

**Files:**
- Modify: `.github/workflows/app.yml:104` (the `ios-compile` job's `runs-on`)

**Interfaces:**
- Consumes: the 7.1.1 dep from Task 1 (so the iOS build compiles the 7.x Swift that calls `NWPath.isUltraConstrained`).
- Produces: an `ios-compile` job that runs on the iOS-26-SDK image — the CI gate Task 3 confirms green.

> This change is **CI-only verifiable** — there is no macOS/Xcode on the dev box. Correctness is checked by the PR's `app.yml` run in Task 3.

- [ ] **Step 1: Switch the runner**

Change `.github/workflows/app.yml:104` (inside the `ios-compile:` job — **not** the `android:` job, which stays `ubuntu-latest`):
```diff
   ios-compile:
-    runs-on: macos-latest
+    runs-on: macos-26          # iOS 26 SDK (Xcode 26.4.1 default); was macos-latest (mid-migration, nondeterministic). #895
     steps:
       - uses: actions/checkout@v6
       - uses: subosito/flutter-action@v2
         with:
           channel: stable
           flutter-version: 3.44.1
           cache: true
       - run: flutter pub get
       - run: flutter build ios --no-codesign
```
Do **not** add any `setup-xcode` step and do **not** change `flutter-version` (the Trip-B lockstep guard depends on it).

- [ ] **Step 2: Sanity-check the YAML didn't disturb the guards**

Run (from repo root):
```bash
grep -n 'runs-on:' .github/workflows/app.yml
grep -hE 'flutter-version:' .github/workflows/app.yml .github/workflows/app-deps-watch.yml | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | sort -u
```
Expected: `android` → `ubuntu-latest`, `ios-compile` → `macos-26`; and the second command prints exactly **one** line (`3.44.1`) — proving the lockstep guard will still pass.

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/app.yml
git commit -m "ci(app): run ios-compile on macos-26 for the iOS 26 SDK (#895)"
```

---

### Task 3: Docs/tracking, push, and confirm CI green

**Files:**
- Modify: `docs/BACKLOG.md` (remove the `app-18` row)
- Modify: `docs/features/archive/224-deps-round-4.md` (update the behaviour-delta note)

**Interfaces:**
- Consumes: Tasks 1–2 committed on the branch.
- Produces: a PR with `Closes #895`; the green `app.yml` run is the acceptance signal.

- [ ] **Step 1: Remove the app-18 row from the backlog**

Open `docs/BACKLOG.md`, find the `app-18` block (the `#### \`app-18\` — connectivity_plus 6→7 …` heading and its `_What:_` bullet, ~5 lines) and delete the whole block. Verify nothing else references `app-18`:
```bash
grep -rn 'app-18' docs/BACKLOG.md
```
Expected: no matches after deletion.

- [ ] **Step 2: Update the round-4 archive behaviour-delta note**

In `docs/features/archive/224-deps-round-4.md`, update the three spots that say connectivity_plus was reverted/held to record the re-bump. Replace the "Held at 6.1.0; re-bump tracked as `app-18` (#895)" phrasing in the **Ship notes** section (lines ~120–124) and the **Out of scope** bullet (lines ~113–114) with a forward pointer, e.g.:

> connectivity_plus was reverted in round 4 (iOS SDK gap) and **re-bumped to 7.1.1 in app-18 / #895** once GitHub's `macos-26` runner (iOS 26 SDK) shipped.

Leave the `network_info.dart` invariant line (line ~51) accurate — update "held at connectivity_plus 6.1.0 — see app-18" to "bumped to connectivity_plus 7.1.1 in app-18". Keep the archive's `status: stable` frontmatter unchanged (it's a historical record; this is a one-line accuracy fix).

- [ ] **Step 3: Commit the docs**

```bash
git add docs/BACKLOG.md docs/features/archive/224-deps-round-4.md
git commit -m "docs(app): retire app-18 backlog row, note connectivity_plus re-bump (#895)"
```

- [ ] **Step 4: Push and open the PR**

```bash
git push -u origin chore/app-connectivity-plus-7
```
(Note: the pre-push hook runs `npm run verify`. This branch touches no JS/frontend/server source, so the relevant legs are cache/no-op; let it finish — a multi-minute near-silent battery is the hook, not a hang.)

Then open the PR (title must match the commit-convention subject):
```bash
gh pr create \
  --title "chore(app): re-bump connectivity_plus to 7.x on macos-26 (#895)" \
  --body "$(cat <<'BODY'
## Summary

Re-bumps the companion's `connectivity_plus` 6.1.0 → 7.1.1 and moves the
`ios-compile` CI job to `runs-on: macos-26` (default Xcode 26.4.1 / iOS 26 SDK),
unblocking app-18. Round 4 reverted the bump because 7.x's iOS Swift calls
`NWPath.isUltraConstrained` (an iOS-26-SDK symbol) and the runner's Xcode lacked
that SDK; the `macos-26` image now provides it. No feature, no API change, no
Flutter bump, no iOS deployment-target change (7.x podspec floor is 12.0 ≤ 13.0).

Spec: `docs/superpowers/specs/2026-06-19-app-18-connectivity-plus-7-design.md`

## Test plan

- Local (Windows): `flutter pub get` resolves 7.1.1 on Flutter 3.44.1;
  `flutter analyze` clean; `flutter test` green incl. `network_info_test.dart`.
- CI (`app.yml`): the **`ios-compile` job on macos-26 is the acceptance gate** —
  it failed on 7.x before, must pass now (the iOS compile can't run locally).
- Android job + Trip-B lockstep / KGP-flag guards stay green (untouched).

Closes #895
BODY
)"
```

- [ ] **Step 5: Confirm the CI acceptance gate**

Watch the `app.yml` run on the PR:
```bash
gh pr checks --watch
```
Expected: the **`ios-compile`** job is **green** (the regression gate for #895), the `android` job is green, and the Trip-B guards pass. If `ios-compile` fails, read the Swift compile log — a surviving `NWPath` error means the runner didn't get an iOS 26 SDK (re-check `runs-on: macos-26`); anything else is a genuine new finding to triage, not a bypass.

- [ ] **Step 6: Post-merge confirmation (after the PR merges)**

The monthly `app-deps-watch` A1 channel — currently RED-by-design because connectivity_plus was held behind latest — should no longer flag it. No action needed; note it as the closing signal on #895.

---

## Self-Review

**Spec coverage:**
- app.yml `ios-compile` → `macos-26`, no setup-xcode → Task 2. ✓
- connectivity_plus 6.1.0 → 7.1.1, refresh lock, exact pin → Task 1. ✓
- No Flutter bump / no deployment-target bump (verified floors) → Global Constraints + Task 1 Step 3. ✓
- Trip-B lockstep + KGP guards untouched → Global Constraints + Task 2 Step 2. ✓
- Docs: BACKLOG row, archive 224, `Closes #895` → Task 3. ✓
- Local-vs-CI verification split → Global Constraints + Task 1 Step 4 + Task 3 Step 5. ✓
- "Adjacent items" (no other deferral / no Flutter upgrade) → informational in spec; no task needed. ✓

**Placeholder scan:** No TBD/TODO; every code/diff step shows exact content. The only deliberate variable is "use the latest 7.x" — bounded by Task 1 Step 1 which resolves it concretely. ✓

**Type/name consistency:** `connectivity_plus: 7.1.1`, `runs-on: macos-26`, `flutter-version: 3.44.1`, job names `android` / `ios-compile` used consistently across tasks and match the real `app.yml`. ✓
