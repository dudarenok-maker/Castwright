# Deps Hygiene Round 4 — Design

- **Date:** 2026-06-18
- **Status:** approved design (pre-implementation)
- **Branch:** `chore/deps-round-4` (JS) + `chore/app-flutter-deps` (Flutter)
- **Implementation plan:** `docs/features/224-deps-round-4.md` (to be authored by writing-plans)
- **Backlog items touched:** `srv-4` (#431), `ops-14` (#711), `ops-17` (#790) + one new `area:side` item filed for the deferred sidecar spike.

## 1. Goal & success criteria

Drive every _actionable_ dependency current across the three live dependency
surfaces (frontend npm, server npm, Flutter pub); re-confirm and correct the
three upstream-blocked backlog items; and explicitly defer the Python TTS
sidecar engine deps as a separate GPU-validated spike rather than bumping them
blind.

**Done =**

- `npm outdated` (root) shows only the eslint-10 majors (blocked).
- `npm outdated --prefix server` shows only `@types/node` (deliberately pinned `^20`).
- `flutter pub outdated` (companion) shows only blocked/discontinued transitives.
- `npm run verify` green; `cd server && npm run test:slow` green; `flutter analyze` + `flutter test` green.
- The three blocked-item notes carry a 2026-06-18 re-confirmation; the sidecar
  spike has a `needs-plan` issue **and** a `docs/BACKLOG.md` row.

## 2. The dependency surfaces (load-bearing — this drove a design correction)

This repo is a **two-lockfile npm workspace with no npm `workspaces` field**,
plus a Flutter package. There are **three** dependency surfaces, each with its
own manifest + lockfile, and a root `npm update` only ever touches the first:

| Surface | Manifest | Lockfile | How to bump |
|---|---|---|---|
| Frontend / tooling | `package.json` | `package-lock.json` | `npm update` (root) |
| Server | `server/package.json` | `server/package-lock.json` | `cd server && npm install <pkg>@<ver>` |
| Flutter companion | `apps/android/pubspec.yaml` | `apps/android/pubspec.lock` | `flutter pub upgrade` |

> **Critical correction from review:** `sharp` and `express-rate-limit` are
> **server** deps. A root `npm update` / `npm install` does **not** read
> `server/package.json` (no `workspaces` field; the build shells out via
> `npm --prefix server`). Bumping them from the repo root is a silent no-op —
> the lockfile the server actually uses is never written. Wave 2 must `cd server`.

The Python sidecar (`server/tts-sidecar/requirements/*.txt`) is a **fourth**
surface, deliberately **out of scope** for this round (see §6).

## 3. Audit findings (2026-06-18, verified against npm/pub/changelogs)

### Tier 1 — safe in-range refreshes

- **Root (8, `npm update`):** `@playwright/test` 1.61.0, `@tailwindcss/postcss`
  4.3.1, `@tanstack/react-virtual` 3.14.3, `@types/node` 25.9.3,
  `react-router-dom` 7.18.0, `tailwindcss` 4.3.1, `typescript-eslint` 8.61.1,
  `vitest` 4.1.9.
- **Server in-range:** none (only the two majors below + `@types/node`, pinned).
- **Flutter non-major:** `app_links` 7.1.2, `drift`/`drift_dev` 2.34.0,
  `path_provider` 2.1.6, + transitive minors.

### Tier 2 — deliberate majors

- **Server — `express-rate-limit` 7.5.1 → 8.5.2.** Real breaking change is
  **IPv6 `/56` subnet masking by default** (+ a new `ip-address` transitive),
  **not** the `max`→`limit` rename (`max` still works as a deprecated alias).
  Our usage (`windowMs`/`max`/`standardHeaders: true`/`legacyHeaders: false`/`skip`)
  is unchanged; `standardHeaders: true` still emits `RateLimit-*`; the CodeQL
  "route dominance" posture (unconditional mount + `skip: () => !!process.env.VITEST`)
  is untouched. Node floor 14→16 (non-issue; we're 20.19+). Behavior note only.
- **Server — `sharp` 0.34.5 → 0.35.1.** `sharp(buffer).jpeg({quality}).toBuffer()`
  (the only call site, `server/src/cover/upload.ts`) is unchanged. 0.35.0 bumped
  the **Node engines floor** (drops Node 18 — harmless here) and libvips to
  8.18.3 (new prebuilt binaries). win32-ia32 prebuilts deprecated (we're x64).
- **Flutter — `connectivity_plus` 6.1.0 → 7.1.1.** Dart API unchanged
  (`checkConnectivity()` still returns `List<ConnectivityResult>`; the list
  migration was 6.0.0, already absorbed in `network_info.dart`). 7.0.0's
  breaking change is an **Android toolchain floor** (Kotlin 2.2 / AGP ≥8.12.1 /
  Gradle ≥8.13) — **already met**: the companion is on Gradle 9.1.0 / AGP 9.0.1
  / Kotlin 2.3.20. Pre-cleared; confirm via `flutter analyze`/`test`.

### Tier 3 — confirmed still blocked upstream (re-confirmed today)

- **`srv-4` (#431) — `node-domexception`.** Pulled via
  `@google/genai@2.8.0 → google-auth-library@10.7.0 → gaxios@7.1.5 →
  node-fetch@3.3.2 → fetch-blob@3.2.0 → node-domexception@1.0.0`. The backlog
  root-cause is **wrong**: genai is _already_ at the "fix" version 2.8.0; the
  real culprit is `gaxios` still depending on `node-fetch` (no gaxios v8 / no
  native-fetch migration published). Don't bump `fetch-blob` to 4.x — it still
  pins node-domexception; node-domexception 2.0.2 is also deprecated. **No
  action possible; correct the note + re-date.**
- **`ops-14` (#711) — eslint 9→10.** `eslint-plugin-react@7.37.5` caps `eslint
  ^9.7`, `eslint-plugin-jsx-a11y@6.10.2` caps `^9`; only `react-hooks` added
  `^10`. eslint 9 is now in the `maintenance` dist-tag. The peer cap is a
  warning not a hard block, but running eslint 10 with these plugins is
  unsupported — "blocked" stays the correct conservative call. Re-confirm + re-date.
- **`ops-17` (#790) — Flutter KGP-applying plugins.** `audio_session` /
  `flutter_foreground_task` / `mobile_scanner` still at latest with no migrated
  release (not flagged outdated). Separate from `connectivity_plus` 7's
  toolchain floor (which is met). Re-confirm + re-date.

### Tier 4 — Python sidecar engine deps (DEFERRED, §6)

~24 behind, but the heavy ones are safety-pinned: `torch` 2.11→2.12 (cu130-only
→ driver bump + voids the CVE-cleared cu128 pin), `transformers` 4.57→5.12
(`<5.0` is a hard Qwen/Kokoro/Coqui lockstep), `huggingface_hub` 0.36→1.19
(major), `kokoro-onnx` 0.4.9→0.5.0, `onnxruntime-gpu` 1.27,
`fastapi`/`starlette`/`uvicorn` majors. Each needs a GPU box + the golden-audio
gate to validate. **Not hygiene — its own spike.**

## 4. Work plan — three surfaces, two PRs, one deferral

### PR 1 — `chore/deps-round-4` (JS: frontend + server, scope `deps`)

**Wave 1 — frontend in-range (root).**
1. `npm update` → the 8 Tier-1 pkgs (lockfile-only; no manifest edit needed —
   all in caret range). Keep `tailwindcss` + `@tailwindcss/postcss` in lockstep.
2. `npx playwright install chromium` (1.60→1.61 crosses the browser-binary
   boundary; without it the pre-push `test:e2e` gate red-fails on a clean tree).
3. Eyeball the `package-lock.json` diff for unexpected transitive **major** jumps.
4. Gate: `npm run verify`. Commit: `chore(deps): refresh in-range frontend deps`.

**Wave 2 — server majors (separate lockfile — `cd server`).** Each its own
revertable commit.
1. `cd server && npm install express-rate-limit@^8` → edit `server/package.json`
   to `^8`. Run `npm run typecheck && npm test`. Verify the IPv6-masking note
   holds (no code change); the middleware test (`rate-limit.test.ts`, which
   overrides `skip` so it _does_ exercise the limiter) stays green.
   Commit: `chore(deps): express-rate-limit 7→8 (server)`.
2. `cd server && npm install sharp@^0.35` → edit `server/package.json` to `^0.35`.
   **Verify the full `@img/sharp-*` + `@img/sharp-libvips-*` platform matrix is
   present in `server/package-lock.json`** (esp. `linux-x64`, `linuxmusl-x64`
   for CI/release, `win32-x64` dev box, `darwin-arm64` Mac deployer) — a pruned
   matrix is a release blocker, not just a CI annoyance. Run `npm test` (cover
   routes exercise sharp). Commit: `chore(deps): sharp 0.34→0.35 (server)`.
3. Full `npm run verify` from root. **Add the `run-ci` label** for one clean-room
   Ubuntu run (sharp lockfile-matrix insurance, since the bump is authored on Windows).

### PR 2 — `chore/app-flutter-deps` (scope `app`, gated by `app.yml`)

Split out because `apps/android/**` is the `app` scope (not `deps`), and
`app.yml` auto-runs `flutter analyze`/`test`/build on those paths — it's the
**only** automated Flutter coverage and no local hook runs it. Folding it into
PR 1 mis-scopes the commit and buries the `connectivity_plus` change under
"lockfile hygiene."

1. `flutter pub upgrade` (non-major) → app_links/drift/drift_dev/path_provider +
   transitives.
2. **Regenerate drift codegen:** `cd apps/android && dart run build_runner build
   --delete-conflicting-outputs`; commit any diff to
   `lib/src/data/library_database.g.dart` **in the same commit** as the drift
   bump. (CI never runs build_runner — it trusts the committed `*.g.dart`. For
   2.34 the output is expected byte-identical, but regenerate-on-drift-bump is a
   standing step; `schemaVersion` 5 has a real migration ladder a stale
   generated shape could desync from.)
3. Edit `pubspec.yaml` → `connectivity_plus: ^7.1.1`; `flutter pub get`.
4. Gate: `flutter analyze` + `flutter test` locally; confirm `checkConnectivity()`
   still returns `List<ConnectivityResult>`. `app.yml` is the CI gate.
   Open as **draft**, `gh pr ready` once green.

### Docs & deferral (in PR 1)

1. **Author `docs/features/224-deps-round-4.md`** (status frontmatter, the three
   majors' migration notes, Key files, `Refs #431 #711 #790`) + an `INDEX.md`
   entry. (Every prior round — 167/170/202 — shipped a plan doc; the brainstorming
   spec lives under `specs/` and is a design artifact, not the regression home.)
2. **Correct + re-date the blocked-item notes** in `docs/BACKLOG.md`: fix
   `srv-4`'s root cause (gaxios→node-fetch, genai already at 2.8.0), re-confirm
   `ops-14` / `ops-17`, stamp 2026-06-18.
3. **File a new `area:side` `needs-plan` Backlog issue** for the deferred sidecar
   engine-dep spike (torch/transformers/hf-hub/etc., GPU + golden-audio
   validated) **and add its thin `docs/BACKLOG.md` row** — same round, per the
   backlog rule.

## 5. Testing & verification

- **Frontend (Wave 1):** `npm run verify` (typecheck + frontend + server +
  server-slow + e2e + build). The in-range bumps need no new tests. After the
  Playwright bump, `npx playwright install chromium` precedes `test:e2e`.
- **Server (Wave 2):** existing suites are the regression net, and each major's
  seam is named:
  - express-rate-limit 8 → `server/src/middleware/rate-limit.test.ts` (exercises
    the limiter; asserts `ratelimit-limit` + 429). Re-run after the bump; pin the
    header assertion to the draft surface v8 emits (`standardHeaders: true` is
    unchanged, so no flip expected).
  - sharp 0.35 → the cover routes' tests (`cover.test.ts`, `upload.test.ts`)
    exercise `sharp(...).jpeg().toBuffer()` end-to-end.
- **Flutter (PR 2):** `flutter analyze` + `flutter test` (the pure
  `network_info_test.dart` locks the connectivity mapping); `app.yml` re-runs in CI.
- **Skipped legs (stated explicitly per the checklist):** sidecar pytest and
  golden-audio are **not** run — this round touches no sidecar code (deferral is
  decoupled: no npm/Flutter bump crosses the `/health` `/synthesize` contract or
  touches onnxruntime / Kokoro weights / model manifests). `test:e2e:mobile` is
  not run (no mobile-viewport surface changed).

## 6. Out of scope (deferred, tracked)

- **Python sidecar engine deps (Tier 4).** Each is a GPU-box + golden-audio
  validated spike (torch cu130 driver implications, transformers lockstep,
  hf-hub major). Filed as a new `area:side` `needs-plan` issue + BACKLOG row.
  The user asked for "all four surfaces"; this is the conscious carve-out — the
  sidecar surface is _audited_ here but _not bumped_, because bumping it blind
  risks the whole TTS pipeline.
- **eslint 9→10 (`ops-14`)** and **`node-domexception` (`srv-4`)** — upstream-blocked,
  no action possible; re-confirmed only.
- **`@types/node` on the server** stays `^20` (matches the Node-20 runtime;
  isolated from root's `^25` — the two TS projects don't share a `tsc -b` graph,
  and `skipLibCheck: true` insulates both).

## 7. Risks & rollback

- **Mid-PR major failure.** If a Wave-2 major fails `verify` and the fix isn't a
  one-liner, `git revert` that single commit, re-run `verify`, and re-file the
  major as its own follow-up issue — ship the rest (mirrors the
  reconciliation-pattern "drop the offending branch, ship the rest" discipline).
- **sharp platform-matrix pruning** (Windows-dev authoring → Linux-CI/macOS
  release). Mitigated by the post-bump matrix check + the `run-ci` Ubuntu run.
- **Playwright browser boundary.** Mitigated by `npx playwright install chromium`
  in Wave 1; consider pinning `@playwright/test` to `~1.60.0` to keep the
  browser-binary boundary out of routine `npm update` churn (open question for
  the plan).

## 8. Known non-issues (do not re-flag in future audits)

- `@types/node` 25 (root) vs `^20` (server) — isolated TS projects, no shared
  build graph, `skipLibCheck: true`. Safe.
- `js@0.6.7` (Flutter) — discontinued but **dev-only transitive** via
  `drift_dev`'s codegen toolchain; never imported in `apps/android/lib`, never
  shipped. Ignore.
- Sidecar deferral — verified decoupled from every npm/Flutter bump in this round.
