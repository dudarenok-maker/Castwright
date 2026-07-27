# ffmpeg version floor — design

**Date:** 2026-07-27
**Issue:** [ops-35 / #1877](https://github.com/dudarenok-maker/Castwright/issues/1877)
**Status:** approved — ready for `writing-plans`
**Revision:** 2 — rewritten after an adversarial `assumption-checker` pass falsified
three load-bearing claims in revision 1. See "What revision 1 got wrong".

## Problem

The repo declares no minimum ffmpeg version anywhere, yet the audio path does not
merely *invoke* ffmpeg — it **parses ffmpeg's diagnostic output**.
`server/src/tts/loudnorm.ts` reads the two-pass `loudnorm` JSON summary
(`input_i`, `input_lra`, `input_tp`, `input_thresh`, `target_offset`, the
`output_*` side, `normalization_type`), including a special case for the literal
`"-inf"` ffmpeg emits on silent input. Parsing a tool's diagnostic output is a
version-sensitive contract, and it breaks at *encode* time on a real book, not in
a unit test fed a canned string.

Every install channel is unmanaged: `winget` / `brew` / `choco` / `apt` /
`conda-forge` all install whatever they ship that day. #1876 considered pinning
ffmpeg in the Pinokio conda env and **deliberately declined**, because there was
no validated known-good version to pin to and choosing one arbitrarily would be a
guess dressed as rigor. Establishing the floor is the prerequisite that unblocks
it.

## Findings

**1. The issue's "the plumbing is largely there" premise is wrong.**
`scripts/preflight-ffmpeg.cjs` never reads `-version` output — it spawns with
`stdio: 'ignore'` and tests `status === 0` (`:31`). The parsing it does is of the
*Windows registry PATH*, for the "installed but this shell predates the install"
hint. Version parsing is new code. Small, but new.

**2. There are three presence checks, and preflight reaches the fewest users.**

| Site | Runs when | Population |
|---|---|---|
| `scripts/preflight-ffmpeg.cjs` | `npm run test:server` (via `server/package.json:11` `pretest`) and `npm run dev` | contributors + CI |
| `server/src/diagnostics/ffmpeg.ts` → `probeFfmpeg()` | every `/api/diagnostics` + `/api/setup/readiness` poll | **all end users** |
| `server/src/tts/mp3.ts:93` `-codecs` probe | first encode | all end users |

Neither `scripts/start-app.mjs` (`npm start`) nor `scripts/start-app-prod.mjs`
(`npm run start:prod`) calls preflight at all — confirmed by grep. `npm start` is
CLAUDE.md's documented primary command, and `start:prod` is what a release-zip
user runs. **The entire end-user population is outside preflight's reach**, which
is why the fix cannot be preflight-only.

**3. A purely capability-derived floor would land uselessly low.** `loudnorm`
landed in ffmpeg 3.1 (2016) and the `print_format=json` field set we parse is
documented identically in the 4.0, 4.1, 7.1 and 8.0 filter docs. "The oldest
version that provably works" resolves to roughly 4.x — below anything a 2026
package manager ships, so the check would never fire.

## Verified facts

Revision 1 asserted these from memory. They are now measured, because the floor
number gates pre-commit, pre-push, the required `verify.yml` check, and
`release.yml`.

| Channel | ffmpeg | Source |
|---|---|---|
| Ubuntu 22.04 jammy | **4.4.2** | [Launchpad](https://launchpad.net/ubuntu/+source/ffmpeg) |
| Ubuntu 24.04 noble | **6.1.1** | Launchpad |
| Ubuntu 26.04 resolute | 8.0.1 | Launchpad |
| `ubuntu-latest` GH runner | = **24.04** → 6.1.1 | [changelog](https://github.blog/changelog/2024-09-25-actions-new-images-and-ubuntu-latest-changes/); 26.04 exists but is opt-in |
| brew / choco / winget / conda-forge | current 8.x | — |
| This dev box | 8.1.1 | `ffmpeg -version` |

**Every channel that any gate runs on ships ≥ 6.1.1.** The floor has headroom on
every one, and stays safe if GitHub later flips `ubuntu-latest` to 26.04 (8.0.1).

## Decisions

### D1 — The floor is a *support* floor, stated as one

**"The oldest ffmpeg we test against and are willing to support"**, not "the
oldest that provably works". Anchored to a real platform rather than a feature
bisect. The docs must say plainly that it is a policy line, so nobody later
mistakes it for evidence of breakage below it.

*Rejected:* a capability floor (honest but inert, per finding 3); publishing two
thresholds (more machinery than the problem warrants).

### D2 — Floor = **6.0**, anchored to Ubuntu 24.04 LTS; 22.04 retired

Windows, macOS and conda-forge all ship 8.x, so Linux is the binding constraint.
Ubuntu 24.04 ships 6.1.1.

**This retires the "validated on Ubuntu 22.04+" claim, deliberately.** The
adversarial pass established that the retirement is *not forced* — that claim is
about the deployer scripts, and the same paragraph documents snap-installed
ffmpeg, which ships current on 22.04, so a 22.04 user could satisfy a 6.0 floor.
Retiring it anyway is a chosen simplification: one supported ffmpeg source per
platform beats "supported, but only via a channel the archive doesn't use". It is
a **user-visible support reduction** and belongs in the release notes as such,
not buried as a docs tweak.

The claim appears in **two** files, byte-identical — `docs/wiki/Installing-Castwright.md:47`
**and `INSTALL.md:33`**. Both change. (Revision 1 updated only the wiki; this
repo has a recorded history of locked choices propagating to only some of the
sites that name them.)

### D3 — Preflight hard-fails; every user-facing surface warns

**Revision 1 claimed the hard-fail was "free because preflight runs on boxes we
control". That was wrong and is corrected here.**

`server/package.json:11` wires preflight as `pretest`, so it fires on **every**
`npm run test:server`, which means:

- **pre-commit** (`verify:fast:scoped`) and **pre-push** (`verify:fast:branch`)
- `verify.yml`'s server leg (a required status check on `main`)
- `cross-os.yml`, `quarantine-health.yml`, `copilot-setup-steps.yml`
- **all three `release.yml` legs (Ubuntu / macOS / Windows)**

CLAUDE.md forbids `--no-verify`. A floor set one notch too high therefore does
not produce a diagnostic — it stops contributors committing, turns the required
check red on every PR, and **blocks a public-beta release**. This is why the
version table above had to be measured before the number was written down. With
every gate channel verified at ≥ 6.1.1, floor 6.0 clears them all.

**Rollback:** if any gate goes red on ffmpeg version, set the floor to `null` in
`package.json` (parser treats it as "no floor", check degrades to today's
presence-only behaviour) rather than reverting the PR. `SKIP_FFMPEG_PREFLIGHT=1`
remains as the per-run escape.

User-facing surfaces **warn without blocking**: a support floor is not evidence
that a given binary is broken, and bricking a working install over a policy
threshold is a worse failure than the one being prevented.
`server/src/routes/setup-readiness.ts:96` already computes
`ready = every(status === 'pass' || status === 'warn')`, and
`BlockerDiagnosis.status` already includes `'warn'` on both sides.

*Rejected:* preflight-only (finding 2 — misses the entire end-user population);
refusing to start the server (unoverridable; punishes a machine that may be fine).

### D4 — No golden-audio version stamp; the drift half is deferred honestly

**Revision 1 proposed stamping the golden-audio baseline, on the premise that
Suite B is where drift would be detectable. That premise is false.**
`server/src/tts/golden-assembly.golden.test.ts` asserts segment counts
(`:106`, `:202`, `:220`), `sampleRate` (`:107`), start/end times and durations
computed from the input fixture's **own byte lengths** (`:115-116`, `:123-124`),
file existence (`:204-205`, `:211`), and a **20-LU-wide** loudness band
(`:213-214`: `-30 < i < -10`). It compares no output bytes. An ffmpeg upgrade
that shifted loudnorm by 2 LU or changed LAME framing passes silently.

A version stamp on that test would imply a comparison it does not make. So the
issue's acceptance bullet 5 is answered honestly: **deferred, because the
assembly golden does not compare output bytes.** The real fix — hashing or
narrowly comparing the encoded MP3 so the stamp has something to protect — is a
plan of its own (byte-exact MP3 comparison across ffmpeg builds is itself
fragile) and gets a **follow-up issue filed in this round**, per CLAUDE.md's
"net-new → BACKLOG first".

*Rejected:* stamping anyway as pure provenance (adds a field whose value is
deferred while leaving the bullet effectively unanswered); widening scope to
build the byte comparison here (materially bigger, and not what this issue is).

## Design

### §1 Single source of truth: `package.json`

The floor lives in the **root `package.json`**, in a `castwright` block beside
`engines`:

```json
"castwright": { "ffmpeg": { "minimum": "6.0" } }
```

`preflight-ffmpeg.cjs` `require`s it. The server reads it the same way
`server/src/app-version.ts:19` already reads `package.json` at runtime.

**Revision 1 invented `scripts/ffmpeg-support.json` plus a duplicated TS
constant, a pin test, a release-manifest allowlist entry, and a `verify.yml`
scope-glob fix — four moving parts built on a constraint the repo dissolves.**
Every objection to reading `package.json` at runtime is already answered in-tree:

| Concern | Already answered by |
|---|---|
| "the server can't read a file at runtime" | `server/src/app-version.ts:19`, `server/src/export/build-portable-book.ts:111` |
| "the zip might omit it" | `scripts/build-release-zip.mjs:39-40` includes `package.json` + `package-lock.json` **unconditionally** — `npm ci` requires them, so omission is structurally impossible |
| "a scope-filtered CI leg would skip the pin" | `verify.yml:161` marks root `package.json` `shared=true`, which runs **every** leg |
| "`vitest --changed` wouldn't select a runtime-read pin" (ops-30 / #1848) | `server/vitest.config.ts` `forceRerunTriggers` already contains `**/package.json/**` |
| "is there a precedent for a tool floor here?" | `pinokio-scripts/lib/node-pin.test.js` parses `engines.node` out of `package.json`; #1876's acceptance required it be **parsed from both sources, not two hardcoded literals** |

Choosing `package.json` deletes the JSON file, the duplicated constant, the
allowlist edit, the scope-glob edit, the `force-rerun-triggers.test.ts` row, and
revision 1's Risk 4 — while landing on the pattern #1876 already established.

*Verified:* root `package.json`'s top-level keys are `name, version, private,
type, engines, scripts, dependencies, devDependencies, overrides` — no
`castwright` key to collide with. `verify.yml:163` is
`match '^(package\.json|package-lock\.json)$' && shared=true`, and
`server/vitest.config.ts:109` `forceRerunTriggers[0]` is
`'{**/package.json,**/.*/**/package.json}'`. Both mechanisms cover the root file
as claimed.

### §2 Version parsing, and the unparseable rule

The first line of `ffmpeg -version` varies by build channel:

```
ffmpeg version 6.1.1-3ubuntu5                  # Ubuntu / Debian
ffmpeg version n6.1                            # Arch / some source builds
ffmpeg version 4.4.2-0ubuntu0.22.04.1          # Ubuntu 22.04
ffmpeg version 8.1.1-full_build-www.gyan.dev   # Windows / Gyan
ffmpeg version 2026-01-01-git-abc1234          # nightly / git — no semver
```

The parser extracts a leading optional `n` then `MAJOR.MINOR`.

**Unparseable output passes, on both sides. It never fails.** A git/dated build
is near-certainly *newer* than the floor, and hard-failing a working install over
a regex miss inverts the cost of the two errors. Concretely: when the version
cannot be parsed, `belowFloor` is **`false`** and the surfaces show the raw
version string with no warning. A `minimum` of `null` in `package.json` disables
the check entirely (the D3 rollback).

`probeFfmpeg()` must start **capturing stdout** where it currently passes
`stdio: 'ignore'` (`server/src/diagnostics/ffmpeg.ts:21`). Since it runs on every
`/api/diagnostics` and `/api/setup/readiness` poll, the parsed version is cached
per-process, following the existing `cachedHasLibFdkAac` precedent at
`server/src/tts/mp3.ts:79`.

### §3 Surfaces

| File | Change |
|---|---|
| `scripts/preflight-ffmpeg.cjs:31` | Capture `-version` stdout; parse; **hard-fail** below floor, reusing the file's existing OS-tailored hint structure |
| `server/src/diagnostics/ffmpeg.ts:19-29` | `probeFfmpeg()` also returns `version: string \| null` and `belowFloor: boolean`; cache per-process |
| `server/src/routes/setup-readiness.ts:39-50` | New `BlockerCause` member `'ffmpeg-too-old'` |
| `server/src/routes/setup-diagnosis.ts:199` | `diagnoseFfmpeg()` returns `'warn'` / `'ffmpeg-too-old'` when present-but-below-floor |
| **`src/lib/api.ts:7247`** | **Hand-mirrored `BlockerCause` — add the same member** |
| `src/components/setup/step-ffmpeg.tsx:14` | **Third render state** (below) |
| `src/components/setup/setup-wizard.tsx:355` | **Three-way status mapping** (below) |
| `src/components/status-popover.tsx:274` | Gates on `=== 'fail'`; also surface the too-old `warn` |
| `server/src/routes/diagnostics.ts:279-288` | `detail` becomes e.g. `both present · ffmpeg 6.1.1`; `warn` below floor |

Three things revision 1 missed or oversold:

**`src/lib/api.ts:7247` hand-mirrors the server's `BlockerCause`** ("Mirrors
SetupReadiness in server/src/routes/setup-readiness.ts") and is not generated —
`/api/setup/readiness` is genuinely absent from `openapi.yaml`, so there is no
regeneration, but there *is* a second file to edit. That mirror has **already
drifted**: server `info` is `{ gpu; vramTotalMb }`
(`setup-readiness.ts:80`), frontend `info` is `{ gpu }` (`api.ts:7279`). That
drift is **pre-existing and out of scope** — noted here, not fixed, per CLAUDE.md
"leave pre-existing dead code alone; mention it rather than deleting it". It is
evidence the mirror rots silently, so the new member must be added to both.

**`step-ffmpeg.tsx:14` is binary** — `passed = readiness.blockers.ffmpeg.status === 'pass'`
— so a `warn` renders the *"ffmpeg isn't installed yet"* branch, which is flatly
wrong for a user who has it. The third state reads "ffmpeg 5.1 found — Castwright
is tested against 6.0 and newer", carries the per-OS upgrade command, and **links
the documentation**. `src/lib/wiki-links.ts:82` already maps
`ffmpeg → Installing-Castwright`; the wiki page needs an anchor at the stated
floor.

**`setup-wizard.tsx:355` is also binary** —
`status: blockers.ffmpeg.status === 'pass' ? 'ok' : 'attention'` — so `warn`
renders identically to `fail` in the summary row, reading as a hard blocker.
It gains a real three-way mapping, mirroring `analyzerStatus` at `:341`, which
already does exactly this.

### §4 Pinokio — install **and** update

`pinokio-scripts/install.js:34` currently runs
`conda install -y -c conda-forge ffmpeg mkcert nodejs=24` — ffmpeg unpinned. It
becomes `"ffmpeg>=6"`. A `>=` constraint, not a pin: it excludes unsupported
versions while keeping security updates flowing, which is what #1876 wanted and
could not express without a floor. conda-forge ships 8.x, so this is a guard, not
a behaviour change.

**`update.js` matters as much as `install.js`.** Its step 0
(`update.js:34`) re-asserts `nodejs=24` on every update but says nothing about
ffmpeg, so an env created before this change would never have the constraint
applied. It gains `"ffmpeg>=6"` in the same `conda install`, on the same
idempotent-solve rationale already documented there for the Node pin.

**The one-update lag applies identically** and must be documented, not
discovered: Pinokio loads `update.js` from the *currently checked-out* release
and iterates the `run[]` it loaded, while a later step checks out the new tag
mid-run. A user updating *from* a pre-change release runs their old `update.js`
with no ffmpeg constraint; it applies from their next update onward. Nothing here
can close that window — it is called out in
`docs/features/218-pinokio-installer.md` and the on-box acceptance register so a
tester expects the lag rather than reporting it as a broken constraint.

`pinokio-scripts/lib/node-pin.test.js` is the exact precedent. The ffmpeg
constraint gets the same treatment: present in **both** scripts, with the
constraint's major **parsed from `package.json`** rather than hardcoded —
matching #1876's own acceptance criterion and closing the SSOT loop.

### §5 Documentation

- `INSTALL.md` — state the floor in prerequisites; extend the existing "ffmpeg
  not found on PATH" troubleshooting entry to cover "too old"; **and update the
  Ubuntu 22.04+ claim at `:33`** (D2).
- `docs/wiki/Installing-Castwright.md:31` — the ffmpeg prerequisite bullet gains
  the version, matching how Node and Python already state theirs.
- `docs/wiki/Installing-Castwright.md:47` — **22.04+ → 24.04+** (D2).
- No `docs/wiki/Advanced-Settings.md` row: the floor is a constant, not a
  registry knob.

## Testing

| Layer | Harness | Coverage |
|---|---|---|
| `scripts/tests/*.test.mjs` | **`node:test`, run by `npm run test:hooks`** (*not* vitest; `test:scripts` is Pester) | Version parser across every string form in §2, including unparseable-passes and `minimum: null` |
| `server/src/diagnostics/ffmpeg.test.ts` | vitest | `probeFfmpeg()` shape; version parse; caching; floor read from `package.json` |
| `server/src/routes/setup-diagnosis.test.ts` | vitest | too-old → `warn` + `'ffmpeg-too-old'`; `ready` stays `true` |
| `src/components/setup/step-ffmpeg.test.tsx` | vitest | Third render state; asserts it is **not** the "isn't installed" copy; docs link present |
| `src/components/setup/setup-wizard.test.tsx` | vitest | `warn` maps to its own summary status, not `attention` |
| `pinokio-scripts/lib/ffmpeg-pin.test.js` | `node:test` | Constraint in **both** scripts; major parsed from `package.json`, not hardcoded |

Tracing every consumer of `blockers.ffmpeg` (`setup-wizard.tsx:354-355`,
`step-ffmpeg.tsx:14`, `status-popover.tsx:274,279,281`) and of `readiness.ready`
confirms **no existing test breaks** — all fixtures use `'pass'` or `'fail'`.

## Risks

1. **The gate surface is wide** (D3): pre-commit, pre-push, the required
   `verify.yml` check, `cross-os.yml`, `quarantine-health.yml`,
   `copilot-setup-steps.yml`, and all three `release.yml` legs. Mitigated by the
   measured version table (every channel ≥ 6.1.1) and the `minimum: null`
   rollback.
2. **Retiring Ubuntu 22.04** is a chosen, user-visible support reduction (D2) —
   release-notes material, and both files that carry the claim must change.
3. **The drift half stays open** (D4). The follow-up issue must actually be filed
   in this round, or the issue's acceptance bullet 5 is simply dropped.

## Before-shipping obligations

- **Regression plan:** this touches the fs-21 setup wizard and the Pinokio
  installer (plan 218). Either a new `docs/features/` plan or an update to 218 —
  the plan thread decides which.
- **Release notes:** both `docs/release-notes-next.md` and `RELEASE_NOTES.md`,
  covering the floor *and* the 22.04 retirement.
- **Follow-up issue:** golden-audio byte comparison (D4), filed with the row in
  `docs/BACKLOG.md`.

## Out of scope

Vendoring or bundling ffmpeg. Per-chapter `.lufs.json` provenance stamping. Any
change to what `loudnorm.ts` parses. Fixing the pre-existing `info.vramTotalMb`
mirror drift in `src/lib/api.ts`.

## What revision 1 got wrong

Recorded because the corrections are the substance of this design, and because
two of them were premises the repo owner made decisions on.

1. **"Preflight runs on boxes we control, so a hard-fail is free."** False —
   `server/package.json:11` puts it in `pretest`, hence in pre-commit, pre-push
   and all three release legs (D3).
2. **"Suite B is the only place drift is detectable, so stamp it."** False —
   that test compares no bytes, only a 20-LU band and fixture-derived durations
   (D4).
3. **"The server can't read the floor from a shipped file, so we need a JSON +
   duplicated const + pin test + CI scope fix."** False — `app-version.ts:19`,
   unconditional zip inclusion, `shared=true`, and existing `forceRerunTriggers`
   coverage dissolve all four (§1).
4. **"Floor 6.0 forces retiring Ubuntu 22.04."** False — snap/PPA satisfies it on
   22.04. The retirement is now a *chosen* simplification, argued as one (D2).
5. **Wrong test harness** for `scripts/tests/` (`node:test`, not vitest).
6. **Missed `src/lib/api.ts:7247`**, the hand-mirrored `BlockerCause`.
7. **Missed `INSTALL.md:33`**, the second site carrying the 22.04 claim.
8. **Cited `pinokio-scripts/install.js:24` and a precedent test that did not
   exist on the branch** — the worktree was three commits behind a `main` that
   moved mid-session (#1878). Rebased to `3fb01fa6`; line numbers corrected to
   `:34`.
