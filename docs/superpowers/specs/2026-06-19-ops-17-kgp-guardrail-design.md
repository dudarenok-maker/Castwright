# ops-17 — KGP / built-in-Kotlin guardrail (design)

- **Date:** 2026-06-19 (rev 2 — after two adversarial reviews)
- **Backlog item:** `ops-17` ([#790](https://github.com/dudarenok-maker/Castwright/issues/790))
- **Status:** design approved; ready for implementation plan
- **Branch:** `feat/app-ops-17-kgp-guardrail`

> **Rev 2 changes (adversarial review):** the monthly red trip is split into two
> decoupled signals — **A1** an all-deps catch-up nudge (user's explicit choice,
> kept) and **A2** a *dedicated* KGP-migration channel (the rare ops-17 event,
> given its own @mention + banner so the routine A1 red can't drown it).
> Tooling corrections folded in: parse the `kind` field; drive "behind" off
> `latest`; `--show-all`; `gh api` PATCH for the sticky comment; `concurrency:`
> guard; Flutter-pin lockstep assertion. See "Revised after adversarial review".

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
Flutter 3.44.1, escape-hatch removal cannot surprise us **so long as that pin
holds** — it is gated on a Flutter-pin bump. That bump is *usually* a deliberate
act we'd review, but not always: a plugin (including the very KGP-migrating
release we're waiting for) could raise its required Dart SDK above what 3.44.1
ships, forcing `flutter pub get` to a newer Flutter as a side effect; or a
contributor could bump the pin directly. So "the pin holds" is itself an
invariant worth guarding (Trip B, below) — not an assumption.

This reframes ops-17 from "migrate now" (impossible — no upstream target) to
"stay safe and stop hand-re-checking until upstream catches up."

## Decision

Accept "blocked upstream"; add a lightweight guardrail. Do **not** vendor / fork
/ patch the plugins (rejected — see below).

## Three trip conditions

| Trip | Condition | Mechanism | Urgency |
|---|---|---|---|
| **A1** | Any direct/dev `apps/android` pub dep is behind `latest` (the monthly catch-up nudge — user's explicit choice) | Monthly scheduled run **goes red** + full table in job summary | Low — routine upkeep |
| **A2** | One of the **three KGP plugins** has a newer `latest` than its pin (the actual ops-17 event) | **Dedicated channel**: ⚠️ banner atop summary + sticky comment, and a one-off @mention on #790 on the *transition* | Act — verify whether it removed KGP |
| **B** | Escape-hatch flags deleted from `gradle.properties` **or** the Flutter pin drifts out of lockstep | Assertion step(s) in `app.yml` | Caught at PR time |
| **C** | Flutter actually removes the escape hatch | **Not chased** — gated on the Flutter pin, which Trip B now guards | N/A |

**Why A1 and A2 are separated (the central review fix):** an 18-direct-dep
Flutter app is *almost always* partially behind, so A1 will be red most months.
If the rare ops-17 event (a KGP plugin migrating) shared that same red status, it
would be indistinguishable cry-wolf. So A2 gets its **own** signal — a transition
@mention that fires a real GitHub notification *only* when a tracked plugin first
shows a newer version — independent of whether A1 is red that month. The user's
"all-deps catch-up" intent is fully preserved in A1 (red nudge) + the all-deps
table in the summary and sticky comment; A2 just ensures the migration is never
buried under it.

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

- **Trigger:** `workflow_dispatch` + monthly `schedule` (`cron: '0 3 1 * *'`
  — 1st of month, 03:00 UTC; mirrors the off-peak-cron convention in
  `cross-os.yml`). Monthly, not weekly — these plugins move on a multi-month
  cadence. Add a **`concurrency:` group** (as `cross-os.yml` does) so a manual
  dispatch overlapping the cron can't run twice and double-post the sticky
  comment.
- **Permissions:** `contents: read`, `issues: write`. `gh` is preinstalled but
  does **not** auto-read the Actions token — set `GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}`
  in the step `env`.
- **Job:** ubuntu, `flutter-action@v2` pinned to the **same Flutter `3.44.1`**
  as `app.yml` (Trip B asserts the two stay in lockstep), `flutter pub get`,
  then `flutter pub outdated --json --show-all` in `apps/android`.
  - Capture the command's stdout and exit status **deliberately** (do *not* let
    `set -euo pipefail` short-circuit) — plain `flutter pub outdated` can exit
    non-zero on environmental faults (missing `package_config.json` → 65,
    resolver faults → 69); those must surface as "tooling broke", not be
    conflated with "deps are behind".

- **Parsing (a pure, unit-tested helper).** The `--json` payload lists one entry
  per package with a **`kind`** field (`"direct"` | `"dev"` | `"transitive"`) and
  four version sub-objects (`current` / `upgradable` / `resolvable` / `latest`).
  - "**Behind**" = `latest.version` > `current.version` (use `latest`, **not**
    `resolvable`: the three plugins are pinned at their latest, so `resolvable`
    never moves for them, and a new *major* shows in `latest` but is capped out
    of `resolvable` by the pin's `^` — exactly the case A2 must catch).
  - `--show-all` is required or up-to-date packages are omitted and the "full
    table" is empty. A package **absent** from the payload = "at latest / no
    newer release", **not** an error.

- **Output surface (no PR), three decoupled layers:**
  - **Visibility (all deps):** write the full `flutter pub outdated --show-all`
    table to the **job summary** (`$GITHUB_STEP_SUMMARY`, 1 MiB cap — ample) —
    direct, dev, and transitive, the complete picture.
  - **A1 — catch-up red (all direct/dev):** the job **exits non-zero** when any
    `kind ∈ {direct, dev}` package is behind. This is the user's deliberate
    monthly "catch-up" nudge; a red scheduled run notifies the **workflow
    author** (GitHub mails the account that last edited the workflow file — for
    this solo-maintainer repo, that's the maintainer) and self-clears once the
    directs are current. Transitive-only drift is summary-only and does **not**
    redden (no `pubspec.yaml` line to bump → unactionable).
  - **A2 — dedicated KGP-migration channel (the ops-17 event):** computed
    separately by comparing each of the three plugins' `latest` against its pin.
    Independent of A1's red/green. When any of the three has a newer `latest`:
    - prepend a **⚠️ banner** to the job summary and the sticky comment naming
      the plugin and version, with the **honest** label *"newer version
      available — verify whether it removed KGP"* (a newer version is **not**
      proof of migration; the author may ship unrelated releases first), plus
      the changelog link and the one-line verification recipe (bump locally →
      `flutter build apk --release` → confirm the KGP warning is gone).
    - on the **transition** (a plugin that was at-pin last run is now ahead —
      detected by diffing against the prior state embedded in the sticky
      comment, see below), post a **one-off `@dudarenok-maker` comment** on #790.
      This is a *new* comment (a real notification), distinct from the silently
      edited sticky — so the migration event pings even in a month A1 is also
      red. *(Optional strengthening, plan may include or defer: fetch the new
      version's `android/build.gradle` from pub.dev and grep for
      `apply plugin: ["']kotlin-android` to report migrated/still-KGP directly
      rather than asking the human to check.)*
  - **#790 sticky refresh (always, every run):** maintain **one** auto-managed
    "sticky" comment on #790, identified by a hidden marker
    (`<!-- ops-17-deps-watch -->`) that also carries a small machine-readable
    state block (the three plugins' last-seen `latest`, so the next run can
    detect an A2 transition). Each run **edits that one comment in place**,
    creating it only if absent — a **proper refresh** (replaces, never appends),
    so #790 carries exactly one always-current block.
    - **Mechanism (precise):** `gh issue view 790 --json comments` / a REST
      `GET /repos/{owner}/{repo}/issues/790/comments` **with `--paginate`** (so a
      long thread can't push the marker off-page and trigger a duplicate
      create), find the comment whose body contains the marker, take its
      **numeric REST `id`** (not the GraphQL node id), and
      `gh api repos/{owner}/{repo}/issues/comments/{id} --method PATCH -f body=@file`.
      `gh issue comment --edit-last` is **not** usable — it edits the most recent
      comment by the author, which breaks the moment any human comments after the
      sticky. Doing the whole find-then-patch through REST `gh api` keeps a single
      id space and avoids the node-id/databaseId mismatch.
    - Editing a comment in place sends **no** notification — that's by design:
      the sticky is the durable *current-state* record; the **A2 transition
      comment** and the **A1 red email** are the active pings.

### 2. Trip B — escape-hatch + pin assertions in `app.yml`

- **Escape-hatch flags:** a step (next to the existing 16 KB-alignment guard)
  asserting `apps/android/android/gradle.properties` still contains **both**
  `android.builtInKotlin=false` and `android.newDsl=false`. Fail with a message
  pointing at ops-17 / #790 if either is missing.
- **Flutter-pin lockstep:** assert the `flutter-version:` pin in `app.yml` and
  in `app-deps-watch.yml` are **equal** (and, ideally, equal to a single
  expected constant). Trip C's "an escape-hatch removal can't surprise us" claim
  rests entirely on the pin holding at 3.44.1; this makes a silent pin drift a
  red PR instead of a silent toolchain change. A simple `grep`/compare step,
  same shape as the flag assertion.
- Enrich the comments on the two `gradle.properties` flags to explain *why* they
  exist (the KGP escape hatch, ops-17/#790) so a future "cleanup" doesn't
  silently delete them. Currently they only say "added by the Flutter template."

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
  (Trip C — gated on the Flutter pin, now guarded by Trip B's lockstep
  assertion rather than assumed).
- Adding Dependabot `pub` version updates or any npm/server Dependabot ecosystem
  (project stays on manual deps rounds).

## Testing

- **Trip A (pure helper, unit-tested).** The helper takes a `flutter pub
  outdated --json --show-all` payload **plus the prior state block** (from the
  existing sticky comment, or empty on first run) and returns: (a) the set of
  `kind ∈ {direct, dev}` packages behind `latest` → drives the A1 exit code;
  (b) each of the three KGP plugins' status (at-pin / newer-available, from
  `latest` vs pin) → drives the A2 banner + sticky body; (c) which (if any)
  plugin **transitioned** at-pin→newer this run → drives the A2 one-off
  comment; (d) the rendered summary/sticky markdown + new state block. Same
  shape as the companion script unit tests under `scripts/tests/`. Cases:
  - all-current → A1 exit 0, no A2 banner, no transition comment.
  - a non-KGP direct/dev dep behind → A1 exit 1, no A2 banner.
  - only a **transitive** dep behind → A1 exit 0 (+ listed in summary).
  - a KGP plugin's `latest` now exceeds its pin, prior state at-pin → A2 banner
    + transition flagged + honest "verify KGP" wording (not "migrated").
  - same plugin still ahead, prior state already-ahead → A2 banner, **no**
    repeat transition comment (transition fires once).
  - a KGP plugin **absent** from the payload (current) → treated as at-pin.
  - the `kind` field present (asserts we filter on `kind`, never on a
    non-existent `isDirect`).
- **Sticky-comment mechanism:** a `workflow_dispatch` run proves create-then-edit
  (first run creates; second run edits the *same* comment, no duplicate) and the
  `--paginate` find. The `concurrency:` group prevents the overlap double-post.
- **Trip B:** self-testing grep guards — temporarily removing a `gradle.properties`
  flag, or skewing the two Flutter pins, turns `app.yml` red. If factored into a
  script, add a Pester/node case mirroring the alignment-guard pattern; otherwise
  document the manual check.

## Acceptance

- `app-deps-watch.yml` exists and runs on `workflow_dispatch`. A manual run
  writes the full `--show-all` table to the job summary and edits/creates the
  single `<!-- ops-17-deps-watch -->` sticky comment on #790 with current status.
- **A2 is green today** (all three KGP plugins at their pin → no banner, no
  transition comment). This is the real ops-17 signal and needs no caveat.
- **A1 reflects all-deps drift** — the run goes red iff a direct/dev dep is
  behind `latest`. It may well be red on day one for unrelated deps; that is the
  intended monthly catch-up nudge, *decoupled* from A2 so it cannot mask a
  migration.
- A second `workflow_dispatch` run **edits the same** sticky comment (no
  duplicate); an overlapping dispatch+cron does not double-post (concurrency).
- Deleting either escape-hatch flag — **or** skewing the Flutter pin between
  `app.yml` and `app-deps-watch.yml` — turns an `apps/android` PR red; restoring
  goes green.
- #790 body re-dated and left open; `docs/BACKLOG.md` `ops-17` row re-dated.
- **The day a plugin migrates** (simulated in the helper unit test today): A2
  posts the transition @mention on #790 → human bumps the plugin → re-runs
  `flutter build apk --release` → confirms the KGP warning is gone → drops the
  escape-hatch flags + Trip-B flag assertion → closes #790. *(This final on-box
  confirmation is a manual gate, not CI-checkable — labelled as such.)*

## Revised after adversarial review

Two adversarial reviews (technical-feasibility + design-soundness) produced two
blockers and several should-fixes; all are folded into rev 2 above. Summary of
dispositions:

- **Cry-wolf (both reviews, BLOCKER):** all-deps red would be red most months,
  burying the ops-17 event. **Fixed** by splitting A1 (all-deps red, user's
  choice) from **A2** (dedicated KGP-migration channel: banner + one-off
  transition @mention), so the migration always pings distinctly.
- **Proxy signal — "newer version" ≠ "KGP removed" (design BLOCKER):** **Fixed**
  by honest wording ("verify whether it removed KGP" + recipe), with an optional
  `build.gradle` grep noted for the plan to include or defer.
- **`kind` not `isDirect`; drive off `latest` not `resolvable`; `--show-all`;
  absent=at-pin (technical):** folded into Parsing.
- **Sticky comment needs `gh api` PATCH, REST numeric id, `--paginate`,
  `concurrency`, `GH_TOKEN` env (technical):** folded into Mechanism.
- **`pipefail` could conflate tooling faults (technical):** capture exit
  deliberately.
- **Trip-C pin can drift / be force-bumped via SDK floor (design):** **Fixed** by
  the Trip-B Flutter-pin lockstep assertion + reworded rationale.
- **Failure email → workflow author, not "repo admins" (both):** corrected.
- **Untestable/contradictory acceptance (design NIT):** A2 green today (no
  apology); A1's possible day-one red is now explicitly the *decoupled* nudge.
- **Decision deferred to user:** keeping A1 across *all* deps (vs scoping red to
  the three plugins) honors the user's explicit "do across all" intent — the
  cry-wolf risk that recommendation addressed is instead neutralised by A2's
  dedicated channel, so all-deps coverage is kept without the downside.
