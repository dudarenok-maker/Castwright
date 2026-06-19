# ops-17 — KGP / built-in-Kotlin guardrail (design)

- **Date:** 2026-06-19
- **Backlog item:** `ops-17` ([#790](https://github.com/dudarenok-maker/Castwright/issues/790))
- **Status:** design approved; ready for implementation plan
- **Branch:** `feat/app-ops-17-kgp-guardrail`

## Problem

`flutter build apk --release` on the companion emits a forward-deprecation
warning: three plugins still apply the standalone **Kotlin Gradle Plugin
(KGP)** — `audio_session`, `flutter_foreground_task`, `mobile_scanner`:

> WARNING: Your app uses the following plugins that apply Kotlin Gradle Plugin
> (KGP): audio_session, flutter_foreground_task, mobile_scanner. Future
> versions of Flutter will fail to build if your app uses plugins that apply KGP.

App developers cannot fix this directly — the only app-side fix is upgrading
each plugin to a built-in-Kotlin / AGP-9 release once its author migrates.

## Ground truth (verified 2026-06-19)

**Upstream — all three still unmigrated, all pinned at latest:**

| Plugin | Pin | Latest | Migrated off KGP? | Tracking |
|---|---|---|---|---|
| `audio_session` | `^0.2.3` | 0.2.3 | No (`apply plugin: "kotlin-android"` on master) | open issues #175/#180, **unmerged** PR #181 "Support AGP 9." |
| `flutter_foreground_task` | `^9.2.2` | 9.2.2 | No | open issues #384/#385 |
| `mobile_scanner` | `^7.2.0` | 7.2.0 | No | 5+ open issues (#1708, #1718, #1719, #1721, #1705) |

So **bumping is impossible** — there is nothing to bump to. The central Flutter
tracker (flutter/flutter#181383) covers only flutter-maintained plugins, not
these three third-party packages.

**Local toolchain — already forward-safe.** This is the load-bearing finding.
`apps/android/android/`:

- AGP **9.0.1**, Gradle **9.1.0**, Kotlin **2.3.20** (`settings.gradle.kts`,
  `gradle/wrapper/gradle-wrapper.properties`).
- `gradle.properties` already contains the Flutter-template **escape-hatch**
  flags:

  ```
  android.newDsl=false
  android.builtInKotlin=false
  ```

  These are exactly what let the three unmigrated KGP plugins keep building
  under AGP 9. **The release build works today; the warning is pure
  forward-deprecation noise.**

**CI — `app.yml`** pins **Flutter 3.44.1 (stable)**, runs on `apps/android/**`,
builds debug + release APK + appbundle, and already carries a custom build-guard
precedent (the "Verify 16 KB ELF alignment" step that fails the build on a
regression).

## Why this is not urgent (and what the real break is)

We are **past AGP 9** and the build is green because of the escape hatch. The
hard break is **not** AGP 9 adoption — it is the day Flutter **removes the
`android.builtInKotlin=false` escape hatch**, which Flutter intends to do
"before AGP 10." Until then, nothing breaks. And because `app.yml` pins
Flutter 3.44.1, escape-hatch removal cannot surprise us — it is gated on **our
own deliberate Flutter-pin bump**, where we would see the warning/failure
anyway.

This reframes ops-17 from "migrate now" (impossible — no upstream target) to
"stay safe and stop hand-re-checking until upstream catches up."

## Decision

Accept "blocked upstream"; add a lightweight guardrail. Do **not** vendor / fork
/ patch the plugins (rejected — see below).

## Three trip conditions

| Trip | Condition | Mechanism | Urgency |
|---|---|---|---|
| **A** | Any direct `apps/android` pub dep is behind (the monthly catch-up nudge; the three KGP plugins are the ones that matter for ops-17, but the whole set is in scope) | Monthly scheduled `flutter pub outdated` check that **warns** + refreshes #790 | Low — act when it fires |
| **B** | The escape-hatch flags get deleted from `gradle.properties` (silent build break) | Assertion step in `app.yml` | Caught at PR time |
| **C** | Flutter actually removes the escape hatch | **Not chased** — gated on our own Flutter-pin bump | N/A |

### Why not Dependabot

`audio_session` / `flutter_foreground_task` / `mobile_scanner` are `pub`
dependencies, and Dependabot supports `pub`. But it is the wrong fit for the
stated requirement (**all pub deps · warn · no PR**):

- **Dependabot version updates** (`.github/dependabot.yml`, ecosystem `pub`)
  produce the "new version available" signal we want — but their **only**
  output is a **PR**. There is no warn-only mode. A per-dep PR drip also
  collides with the project's deliberate manual "deps round N" cadence.
- **Dependabot alerts** (Security tab, on by default for public repos — this
  repo went public 2026-06-17) are the warn-only surface, but they fire **only
  on security advisories** from the GitHub Advisory Database. The pub/Dart
  advisory DB is effectively empty for UI plugins like these, so alerts will
  **never** announce a KGP-migrating release. Wrong signal.

"New-version-available + warn-only + no PR" is precisely the gap Dependabot
cannot fill, so Trip A is a small custom scheduled check instead. Existing
repo-level Dependabot alerts are left as-is (harmless, not load-bearing here).

### Why not vendor / fork / patch the plugins

Stripping `apply plugin: 'kotlin-android'` from each plugin's
`android/build.gradle` via Gradle overrides or local forks would clear the
warning and drop the escape-hatch dependency — but it costs three patches to
re-sync on every plugin bump, requires proving Flutter's built-in Kotlin is
compatible with each plugin's Kotlin source, and buys nothing the escape hatch
isn't already buying us today. Rejected as over-engineering for a
not-currently-broken build.

## Components

### 1. Trip A — `app-deps-watch.yml` (new scheduled workflow)

- **Trigger:** `workflow_dispatch` + monthly `schedule` (e.g. `cron: '0 3 1 * *'`
  — 1st of month, 03:00 UTC; mirrors the off-peak-cron convention in
  `cross-os.yml`). Monthly, not weekly — these plugins move on a multi-month
  cadence.
- **Job:** ubuntu, `flutter-action@v2` pinned to the same Flutter `3.44.1` as
  `app.yml`, `flutter pub get`, then `flutter pub outdated` in `apps/android`.
- **Warn surface (no PR), three layers:**
  - **Visibility:** write the full `flutter pub outdated` table to the GitHub
    **job summary** (`$GITHUB_STEP_SUMMARY`) every run — direct **and**
    transitive, the complete picture.
  - **Alarm (all direct deps):** the job **exits non-zero** when **any direct
    dependency** (anything in `pubspec.yaml` `dependencies` / `dev_dependencies`)
    has a newer resolvable version. A red monthly run is the deliberate
    "catch-up this month" nudge and emails repo admins via GitHub's standard
    scheduled-failure notification; it self-clears once the directs are current.
    The three KGP plugins are the ones that matter for ops-17, but a monthly
    all-directs sweep is sensible upkeep regardless. **Transitive-only drift**
    stays summary-only and does **not** turn the run red — it isn't directly
    actionable (no `pubspec.yaml` line to bump), so reddening on it would be
    permanent unactionable noise.
  - **#790 refresh (always, every run):** maintain a **single auto-managed
    "sticky" comment** on #790, identified by a hidden marker
    (`<!-- ops-17-deps-watch -->`). Each run **edits that one comment in place**
    (creating it the first time) with the current-as-of-`<run date>` status:
    the three KGP plugins' migration status (still-blocked vs. a release now
    available) and the outdated-directs table. This is a **proper refresh** — it
    replaces the prior content in the same comment rather than appending, so
    #790 carries exactly one always-current status block, never a growing log.
    Requires `permissions: issues: write` and `gh` (default-available in
    Actions). Note: editing a comment in place does **not** send a GitHub
    notification — the **red-run failure email** (above) is the active ping;
    the sticky comment is the durable current-status record. The one-time
    landing edit to the #790 *body* (§3) and this monthly sticky comment are
    distinct: the body holds the human-curated What/Acceptance; the comment
    holds the machine-refreshed status.

### 2. Trip B — escape-hatch assertion in `app.yml`

- A step (next to the existing 16 KB-alignment guard) asserting
  `apps/android/android/gradle.properties` still contains **both**
  `android.builtInKotlin=false` and `android.newDsl=false`. Fail with a message
  pointing at ops-17 / #790 if either is missing.
- Enrich the comments on those two flags in `gradle.properties` to explain
  *why* they exist (the KGP escape hatch, ops-17/#790) so a future "cleanup"
  doesn't silently delete them. Currently they only say "added by the Flutter
  template."

### 3. Issue + backlog housekeeping

- One-time: re-date the #790 **body** with the 2026-06-19 re-confirmation and
  note the guardrail landed (the issue **stays open** — still blocked upstream;
  the guardrail is the interim, not the fix). Ongoing status refresh is then
  automated by the monthly sticky comment (§1), so the body stays the stable
  human-curated What/Acceptance.
- Update the `ops-17` row in `docs/BACKLOG.md` with the same re-date + a pointer
  to the guardrail.

## Out of scope

- Bumping the three plugins (no migrated release exists).
- Vendoring / forking / patching the plugins (rejected above).
- Building against Flutter beta/master to pre-detect escape-hatch removal
  (Trip C — gated on our own Flutter-pin bump).
- Adding Dependabot `pub` version updates or any npm/server Dependabot ecosystem
  (project stays on manual deps rounds).

## Testing

- **Trip A:** unit-test the pure helper that, given a `flutter pub outdated
  --json` payload, returns (a) the set of **direct** deps that are behind (drives
  the exit code), (b) the three KGP plugins' status (drives the sticky-comment
  body), and (c) the rendered summary/comment markdown. Same shape as the
  existing companion script unit tests under `scripts/tests/`. Covers:
  all-current → exit 0; a direct dep behind → exit 1; only a transitive dep
  behind → exit 0 + summary lists it; a KGP plugin now has a newer version →
  comment body flips that plugin from "blocked" to "release available". The
  workflow YAML itself is exercised by a `workflow_dispatch` run (which also
  proves the sticky-comment create-then-edit path against #790).
- **Trip B:** the assertion is self-testing — temporarily removing a flag turns
  `app.yml` red. Document the manual check; no separate harness needed for a
  grep guard. If the parsing/check is factored into a script, add a Pester/node
  case mirroring the alignment-guard pattern.

## Acceptance

- `app-deps-watch.yml` exists and runs on `workflow_dispatch`. A manual run
  writes the full outdated table to the job summary, edits/creates the single
  `<!-- ops-17-deps-watch -->` sticky comment on #790 with current status, and
  goes **red iff any direct `apps/android` dep is behind** (today: green only if
  every direct dep is current — otherwise the run is red as the catch-up nudge,
  which is expected/correct behaviour, not a defect).
- A second `workflow_dispatch` run **edits the same** sticky comment rather than
  adding a new one (proper-refresh check).
- Deleting either escape-hatch flag turns an `apps/android` PR red via the new
  `app.yml` assertion; restoring it goes green.
- #790 re-dated and left open; `docs/BACKLOG.md` `ops-17` row re-dated.
- When upstream eventually ships a migrated release: the monthly watch goes red
  → bump the plugin(s) → re-run `flutter build apk --release` → confirm the KGP
  warning is gone → drop the escape-hatch flags + Trip-B assertion → close #790.
