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
constrains), [`archive/185-golden-audio.md`](archive/185-golden-audio.md) (the
deferred drift half) · ops-35 · [#1877](https://github.com/dudarenok-maker/Castwright/issues/1877)

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
7. **`BlockerCause` is mirrored by hand in `src/lib/api.ts:7247`** — it is not
   generated, because `/api/setup/readiness` is absent from `openapi.yaml`. Any
   new cause must be added to both. (That mirror has already drifted on `info`:
   server sends `{ gpu, vramTotalMb }`, frontend declares `{ gpu }` —
   pre-existing, out of scope, recorded here so it isn't mistaken for new.)
8. **The preflight's side effects sit behind `require.main === module`.**
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
  cannot drift apart.
- `server/src/routes/setup-diagnosis.test.ts` (vitest) — below floor yields
  `status: 'warn'` + `cause: 'ffmpeg-too-old'` with both versions in the
  message; absence still fails; unparseable and null-floor pass; and an explicit
  assertion that `every(pass || warn)` still holds (invariant 4).
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

## Ship notes

_Pending._
