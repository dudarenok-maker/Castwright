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
- **Verification reality:** the Dart/Android side is locally verifiable on this Windows box (`flutter pub get` / `analyze` / `test`). The **iOS compile is CI-only** — `app.yml` runs it on the **PR (the `pull_request` event)**, not on the feature-branch push (its `push` trigger is `branches: [main]` only). That green `ios-compile` run is the acceptance gate.
- **`flutter` binary name:** on this box the binary is **`flutter.bat`** under PowerShell; under the Bash tool `flutter` resolves only if it's on PATH. **If a bare `flutter …` step errors with "command not found," re-run it as `flutter.bat …`.** Every `flutter` command below applies this rule.
- **`gh pr create` must run from the Bash tool**, not PowerShell — the heredoc body is a PowerShell parse error (PS here-strings differ). Keep it in a single Bash invocation.
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

> This change is **CI-only verifiable** — there is no macOS/Xcode on the dev box, and `app.yml` runs `ios-compile` on the **PR (`pull_request` event)**, not on the branch push. Correctness is checked by the PR's `app.yml` run in Task 3.

- [ ] **Step 1: Switch the runner**

Change `.github/workflows/app.yml:104` (inside the `ios-compile:` job — **not** the `android:` job, which stays `ubuntu-latest`):
```diff
   ios-compile:
-    runs-on: macos-latest
+    runs-on: macos-26          # was macos-latest; macos-26 ships the iOS 26 SDK (#895)
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

Open `docs/BACKLOG.md` and delete the **entire `app-18` block at lines 138–142** — that is the `#### \`app-18\` — connectivity_plus 6→7 …` heading (138) plus its `_What:_` (140), `_Benefit (technical):_` (141), and `_Full detail:_` (142) lines and the block's own blank line(s). Don't leave an orphaned bullet behind. Then confirm:
```bash
grep -n 'app-18' docs/BACKLOG.md
```
Expected: no matches.

(Note: `grep -rn app-18 docs/` will still show **intentional historical** mentions in `docs/features/INDEX.md` (round-4 archive summary), `docs/features/archive/224-deps-round-4.md`, and this item's own spec/plan. Those are records of what happened and **stay** — only `BACKLOG.md` loses its live row.)

- [ ] **Step 2: Update the round-4 archive behaviour-delta note**

`docs/features/archive/224-deps-round-4.md` has **five** `app-18`/"6.1.0" mentions (lines 51, 77, 97, 114, 124). It is the historical record of round 4, which genuinely *reverted* the bump — **do not falsify that history.** Disposition by line:

- **Line 51** (`## Invariants to preserve` → `network_info.dart` row): present-tense invariant `… held at connectivity_plus 6.1.0 — see app-18`. This goes stale after the re-bump → change `held at connectivity_plus 6.1.0 — see app-18` to `bumped to connectivity_plus 7.1.1 in app-18/#895`.
- **Line 97** (`### Automated coverage` → Flutter row): present-tense `held at connectivity_plus 6.1.0 (see app-18).` → append a forward note so it reads `held at connectivity_plus 6.1.0 at round-4 ship (since re-bumped to 7.1.1 in app-18/#895).`
- **Lines 77, 114, 124** (the `What shipped` reverted-bullet, the `Out of scope` bullet, and the `Ship notes` behaviour-delta): these accurately describe **what round 4 did** ("attempted 6→7, reverted … tracked as `app-18` (#895)"). **Leave them as-is** — they are correct history and the `#895` pointer now resolves to a closed issue.

Keep the `status: stable` frontmatter unchanged. The edit is two stale present-tense lines (51, 97); the three historical lines stay.

- [ ] **Step 3: Commit the docs**

```bash
git add docs/BACKLOG.md docs/features/archive/224-deps-round-4.md
git commit -m "docs(app): retire app-18 backlog row, note connectivity_plus re-bump (#895)"
```

- [ ] **Step 4: Push and open the PR**

Make sure **both** the Task 1 (dep) and Task 2 (runner) commits are on the branch before pushing — if you push and PR with only the dep bump, `ios-compile` runs 7.x on the old runner and reds.

```bash
git push -u origin chore/app-connectivity-plus-7
```
**Pre-push reality:** the hook runs the **full** `npm run verify` battery (typecheck + frontend + server + server-slow + e2e + build) with **no path-scoping** — an app-only branch still runs the entire JS/e2e suite. Expect several minutes of near-silent output (that's the battery, not a hung push — confirm via the final `* [new branch]` line). If it **flake-fails on a pre-existing, unrelated JS/e2e/server test** (the repo flags server-slow timeouts and e2e port contention as flaky under GPU/CPU load):
1. Triage related-vs-pre-existing: `git stash && git switch main && <re-run the failing test> && git switch - && git stash pop`.
2. If it fails the same on `main` → it's pre-existing; **surface it to the user and do NOT `--no-verify`** (per CLAUDE.md commit-gate rule). The Flutter change has no local-hook coverage anyway — its gate is the CI `ios-compile` job, not this push.
3. If it's a true one-off flake (passes in isolation), say so and re-push.

Then open the PR — **run this from the Bash tool** (the heredoc is a PowerShell parse error). Title must match the commit-convention subject:
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
