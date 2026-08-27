---
status: active
shipped: null
owner: null
---

# 269 — ffmpeg version floor

> Status: active
> Key files: `package.json` (`castwright.ffmpeg.minimum` — the single source of
> truth), `scripts/preflight-ffmpeg.cjs` (parser + hard-fail),
> `server/src/diagnostics/ffmpeg.ts` (`probeFfmpeg` version reporting),
> `server/src/routes/setup-diagnosis.ts` (`diagnoseFfmpeg` warn branch),
> `server/src/routes/setup-readiness.ts` (`BlockerCause`, the probe call site),
> `server/src/routes/diagnostics.ts` (board detail string),
> `src/lib/api.ts` (hand-mirrored `BlockerCause`),
> `src/components/setup/step-ffmpeg.tsx` (third render state),
> `src/components/setup/setup-wizard.tsx` (three-way summary status),
> `pinokio-scripts/install.js` + `update.js` (`"ffmpeg>=6"`),
> `pinokio-scripts/lib/ffmpeg-pin.test.js`
> URL surface: the Setup Wizard's ffmpeg step (`#/setup`) and the admin
> diagnostics board (`#/admin`)
> OpenAPI ops: none — `/api/setup/readiness` is not described in `openapi.yaml`

Source spec: [`docs/superpowers/specs/2026-07-27-ffmpeg-version-floor-design.md`](../superpowers/specs/2026-07-27-ffmpeg-version-floor-design.md)
Implementation plan: [`docs/superpowers/plans/2026-07-27-ffmpeg-version-floor.md`](../superpowers/plans/2026-07-27-ffmpeg-version-floor.md)
Related: [`218-pinokio-installer.md`](218-pinokio-installer.md) (the conda env this
constrains), [`archive/185-golden-audio-regression.md`](archive/185-golden-audio-regression.md) (the
deferred drift half) · [`272-golden-assembly-comparison.md`](272-golden-assembly-comparison.md)
(the follow-up that built the drift comparison) · ops-35 · [#1877](https://github.com/dudarenok-maker/Castwright/issues/1877)

## Benefit / Rationale

- **User:** an ffmpeg too old for the audio pipeline is now named as such —
  with the detected version, the required floor, an upgrade command, and a docs
  link — instead of silently producing differently-normalised audio.
- **Technical:** closes a silent-drift surface on the one external binary the
  audio pipeline cannot work without and **whose output we parse**
  (`server/src/tts/loudnorm.ts` reads the loudnorm JSON summary, including the
  literal `"-inf"` case). Before this, nothing anywhere declared a required
  version.
- **Architectural:** establishes one declared floor read by every consumer
  (preflight, server probe, Pinokio launcher test), so the enforcement points
  cannot disagree. Unblocks #1876, which declined to pin ffmpeg in the Pinokio
  conda env precisely because no validated floor existed to pin to.

## Architectural impact

- **New seam:** `castwright.ffmpeg.minimum` in root `package.json`. Read at
  runtime by `server/src/diagnostics/ffmpeg.ts` (the pattern
  `server/src/app-version.ts:19` already uses), at preflight time by
  `scripts/preflight-ffmpeg.cjs`, and at test time by
  `pinokio-scripts/lib/ffmpeg-pin.test.js`. **Never restate the value
  anywhere** — every consumer parses it.
- **Invariants preserved:** `readiness.ready` semantics are unchanged —
  `setup-readiness.ts` already counted `'warn'` toward ready, so the new state
  slots in without touching the gate.
- **Migration:** none. Additive fields on `FfmpegProbe` and one new
  `BlockerCause` member.
- **Reversibility:** set `castwright.ffmpeg.minimum` to `null`. Every consumer
  treats that as "no floor" and degrades to the previous presence-only
  behaviour. This is the documented rollback if a CI or release leg ever goes
  red on the version check — it does not require reverting the PR.

## Invariants to preserve

1. **The floor is declared in exactly one place** —
   `package.json` `castwright.ffmpeg.minimum` (`"6.0"`). Consumers read it;
   none hardcode it. `pinokio-scripts/lib/ffmpeg-pin.test.js` enforces this for
   the launchers by parsing the major back out of `package.json`.
2. **Unparseable version output always passes.** `parseFfmpegVersion` returns
   `null` for git/nightly banners (`2026-01-01-git-abc1234`, `N-114293-g…`), and
   `isBelowFloor(null, …)` is `false` on both the CJS and TS sides. Git builds
   are near-certainly newer than the floor; rejecting one over a regex miss
   costs more than the drift being guarded.
3. **A null floor disables the check** rather than throwing
   (`preflight-ffmpeg.cjs:readFfmpegFloor`, `diagnostics/ffmpeg.ts:readFfmpegFloor`).
4. **Only the preflight hard-fails.** Every user-facing surface warns.
   `setup-readiness.ts:96` computes `ready` as
   `every(status === 'pass' || status === 'warn')`, so a below-floor ffmpeg must
   never set `readiness.ready` to `false`, never block the Setup Wizard, and
   never block generation.
5. **Absence outranks staleness.** `diagnoseFfmpeg` returns `ffmpeg-missing` /
   `ffprobe-missing` / `both-missing` at `'fail'` *before* it considers
   `belowFloor`.
6. **`probeFfmpeg()` is NOT cached.** The Setup Wizard's Re-check button and the
   diagnostics board's 30 s refresh both exist so a user can install or upgrade
   ffmpeg and see the result without restarting the server. A process-lifetime
   cache would freeze the first answer forever.
7. **`StepFfmpeg` branches on `status`, never on `cause`.** `warn` → the
   outdated card, `fail` → the missing card. Keying the outdated card on
   `cause === 'ffmpeg-too-old'` would send the *next* warn cause down the
   "ffmpeg isn't installed yet" path — reintroducing the exact bug this plan
   fixed. The card leads with `diagnosis.message`, so any warn reads correctly.
8. **Each summary row owns its own `warn` screen-reader phrasing**
   (`SummaryRow.warnLabel`). `warn` means different things per row — the
   analyzer's is "no cloud backup", ffmpeg's is "older than we support" — so a
   shared string announces something untrue. Before this, an outdated ffmpeg
   announced "Audio assembly: ready, no backup".
9. **`BlockerCause` is mirrored by hand in `src/lib/api.ts:7247`** — it is not
   generated, because `/api/setup/readiness` is absent from `openapi.yaml`. Any
   new cause must be added to both. (That mirror has already drifted on `info`:
   server sends `{ gpu, vramTotalMb }`, frontend declares `{ gpu }` —
   pre-existing, out of scope, recorded here so it isn't mistaken for new.)
10. **The preflight's side effects sit behind `require.main === module`.**
   Without it, `require`ing the module runs the check and calls `process.exit`,
   which kills the `node --test` run and scores the file as one passing test —
   a placebo that hides every parser assertion.

## Test plan

### Automated coverage

- `scripts/tests/ffmpeg-version.test.mjs` (`node:test`, run by
  `npm run test:hooks`) — asserts the CJS parser across every build-channel
  banner, the fail-open comparisons, the floor read, and that requiring the
  preflight does not execute it.
- `server/src/diagnostics/ffmpeg.test.ts` (vitest) — `probeFfmpeg` shape
  including `version` / `belowFloor` / `minimum`; below-floor does not imply
  absent; unparseable and absent never set `belowFloor`; and **two re-probe
  tests** pinning invariant 6 (install-then-Re-check, and upgrade-clears-warning).
- **Shared corpus:** both of the above read
  `scripts/tests/fixtures/ffmpeg-version-cases.json`, so the CJS and TS parsers
  cannot drift apart. **The corpus is wired into both steps' cache inputs and
  CI scopes** — `scripts/verify-cache.mjs` lists it under `test:hooks` (with
  `preflight-ffmpeg.cjs`) *and* `test:server`, and `verify.yml`'s `server` scope
  regex matches `scripts/tests/fixtures/`. Without that, a fixture-only diff —
  the intended way to add a drift case — would re-check only the CJS side, and
  neither side locally. Same #1847 trap `test:pinokio` already documents.
- `server/src/routes/setup-diagnosis.test.ts` (vitest) — below floor yields
  `status: 'warn'` + `cause: 'ffmpeg-too-old'` with both versions in the
  message; unparseable and null-floor pass; and the ordering guard (invariant 5)
  driven with the **contradictory** input `ffmpegPresent: false, belowFloor: true`
  — with `belowFloor: false` the assertion cannot detect a hoisted floor check
  and is a placebo.
- `server/src/routes/setup-readiness.orchestration.test.ts` (vitest + supertest)
  — **invariant 4 through the real route**: a below-floor probe yields
  `blockers.ffmpeg.status === 'warn'` *and* `ready === true`, while an absent
  ffmpeg still yields `ready === false`. Asserted here rather than in a unit
  test because re-implementing `every(pass || warn)` over a local array is a
  tautology that passes whatever `setup-readiness.ts:96` actually says. Both
  cases were mutation-checked: flipping `:96` to `every(pass)` fails them.
- `server/src/routes/diagnostics.test.ts` (vitest) — the board's version detail
  string, the below-floor `warn`, and the unparseable-version fallback.
- `src/components/setup/step-ffmpeg.test.tsx` (vitest + RTL) — the outdated card
  renders, and is **neither** the ready card **nor** the missing card; shows the
  version and floor; offers upgrade rather than install commands; links the wiki.
- `pinokio-scripts/lib/ffmpeg-pin.test.js` (`node:test`, run by
  `npm run test:pinokio`) — the constraint is present in **both** `install.js`
  and `update.js`, both agree, and the major satisfies `package.json`.

### Manual acceptance walkthrough

Requires a box where ffmpeg can be swapped — see the on-box register row.

1. **Supported ffmpeg (≥ 6.0).** `npm run dev` → preflight silent, exit 0.
   Setup Wizard ffmpeg step shows the green "Audio assembly ready" card.
   Admin → diagnostics shows `both present · ffmpeg <version>` at status `ok`.
2. **Below-floor ffmpeg (e.g. 4.4 from Ubuntu 22.04's archive).**
   `npm run test:server` → preflight **fails** with "ffmpeg 4.4 is older than
   Castwright supports", naming the upgrade command for the host OS, exit 1.
3. **Same box, server running.** The wizard's ffmpeg step shows the amber
   *outdated* card (`data-testid="step-ffmpeg-outdated"`) — **not** the "isn't
   installed yet" card — with the version, the floor, upgrade commands, and the
   prerequisites link. The wizard **still advances**; `readiness.ready` stays
   `true`. Diagnostics board shows status `warn`.
4. **Upgrade ffmpeg, click Re-check** (do not restart the server). The card
   flips to the green ready state — this is invariant 6; if it stays amber, the
   probe has been cached somewhere.
5. **Rollback.** Set `castwright.ffmpeg.minimum` to `null`, re-run step 2 →
   preflight passes, surfaces show no warning.

## Ship steps

- **Run `npm run wiki:sync` after merge.** The Setup Wizard's outdated card links
  to the *published* GitHub wiki, which keeps saying "ffmpeg on PATH" with no
  floor until the sync runs — so the in-app "verify the floor" link is dead on
  arrival without it.

## Known limitations

- **Do not recommend the `ffmpeg` snap.** Its stable channel is **4.3.1**,
  published 2020-11-08 (verified against `api.snapcraft.io/v2/snaps/info/ffmpeg`)
  — *older* than Ubuntu 22.04's own archive build of 4.4.2. An earlier draft of
  this work told below-floor users to `apt remove ffmpeg && snap install ffmpeg`,
  which would have destroyed a working install to **downgrade** them, leaving the
  warning up against a worse binary. Two further reasons it is the wrong target
  even if it were current: both candidate snaps are strictly confined, and
  `WORKSPACE_ROOT` defaults relative to the install dir
  (`server/src/workspace/paths.ts:39`), so a deployer install under `/opt` or an
  external drive would hit `EACCES` on every encode — turning a cosmetic warning
  into a hard generation failure. The sibling `ffmpeg-2404` snap is 7.1.5 but
  exposes `/snap/bin/ffmpeg-2404`, not `ffmpeg`, so the PATH probe would not
  find it.
- **Ubuntu 22.04 has no supported in-repo route to the floor.** The docs say so
  plainly rather than inventing one; the honest options are an OS upgrade or a
  user-supplied build placed first on `PATH`.

- `pinokio-scripts/lib/ffmpeg-pin.test.js` compares **majors only**, so a future
  floor of `"7.1"` would be satisfied by `"ffmpeg>=7"`, which conda can resolve
  to 7.0. Fine while the floor is `x.0`; tighten the guard if a non-zero minor
  floor is ever declared.
- The below-floor warning is **not** surfaced in the status popover
  (`status-popover.tsx:274` gates its ffmpeg banner on `status === 'fail'`), so
  "every user-facing surface warns" means the wizard, the diagnostics board and
  the top-bar health dot — not the popover.

## Ship notes

**Shipped 2026-07-27** in [#1881](https://github.com/dudarenok-maker/Castwright/pull/1881),
merge commit `c7ceee9b`.

`status:` stays **`active`**, not `stable` — the plan does **not** move to
`archive/` yet, because its on-box acceptance
(the [ops-35 ffmpeg-floor blocked row](../testing/onbox-acceptance-register.md))
is still owed.
Every assertion this plan ships drives a **mocked `spawnSync`**; no test has
met a real ffmpeg binary of any version. Per the Before-shipping checklist, a
row comes out only when the acceptance was actually run on the box, or the repo
owner confirms it was exercised for real — "tests pass, so it's presumably
fine" never removes it.

Post-merge steps completed: `npm run wiki:sync` ran 2026-07-28 (0 added, 48
changed, 0 removed) and the published
[Installing Castwright](https://github.com/dudarenok-maker/Castwright/wiki/Installing-Castwright)
page was verified to show "ffmpeg 6.0 or newer on PATH" and "validated on
Ubuntu 24.04+". Until that ran, the wizard's outdated-ffmpeg card linked to a
page that still said only "ffmpeg on PATH" with no floor.

Deferred by design: [#1880](https://github.com/dudarenok-maker/Castwright/issues/1880)
(ops-36) — the golden-audio assembly tier asserts a 20-LU loudness band and
fixture-derived durations, not output bytes, so the ffmpeg version stamp #1877
asked about would have implied a comparison that test does not make.
