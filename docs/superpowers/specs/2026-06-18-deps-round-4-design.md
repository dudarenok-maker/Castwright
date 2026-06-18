# Deps Hygiene Round 4 — Design

- **Date:** 2026-06-18
- **Status:** approved design (pre-implementation)
- **Branch:** `chore/deps-round-4` (single branch; JS + Flutter land as separately-scoped commits in one PR)
- **Implementation plan:** `docs/features/224-deps-round-4.md` (to be authored by writing-plans)
- **Backlog items touched:** `srv-4` (#431), `ops-14` (#711), `ops-17` (#790) re-confirmed/corrected + one new `area:side` item filed (issue + BACKLOG row) for the deferred sidecar spike.

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
- The `node-domexception` deprecation warning **persists** (upstream-pinned via
  gaxios→node-fetch, `srv-4`) — expected, not a regression. It never appears in
  `npm outdated` (it's a deprecated _transitive_, not an out-of-date direct dep),
  so "outdated is clean" and "the warning is gone" are different things; only the
  former is a done-criterion here.

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

## 4. Work plan — three surfaces, one PR, one deferral

The spine of the round is the **three majors** (each carries a behavior/floor
change worth pinning a deliberate note to) plus the **backlog reconciliation +
sidecar-spike filing**. The 8 in-range root bumps ride along (a future
`npm install` would re-apply them anyway); they're hygiene, not the point.

All of it lands in **one PR** on `chore/deps-round-4`, as three separately-scoped
commit groups — `chore(deps): …` (JS surfaces), `chore(app): …` (Flutter), and
`docs(deps): …` (plan doc + backlog reconciliation).
This matches the repo's "one integration PR" default; squash/rebase are disabled
so the per-commit scopes survive in history, which is where the granularity the
scope table cares about actually lives. A second PR would add a verify run, a
merge, and a doc-allocation/merge-order problem for zero mechanical benefit
(`app.yml` triggers on `apps/android/**` _paths_, not PR boundaries).

### Commit group A — JS (frontend + server, scope `deps`)

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
   present in `server/package-lock.json`** — concretely, `grep -c '@img/sharp-'
   server/package-lock.json` and confirm the per-triple entries are all listed:
   `linux-x64`, `linuxmusl-x64` (CI/release), `win32-x64` (dev box),
   `darwin-arm64`, `darwin-x64` (Mac deployer), `linux-arm64`. A pruned matrix
   (Windows-authoring dropping a non-win32 entry) is a **release blocker**, not
   just a CI annoyance. Run `npm test` (cover routes exercise sharp).
   Commit: `chore(deps): sharp 0.34→0.35 (server)`.
3. Full `npm run verify` from root. **No cloud CI run is needed for the sharp
   matrix.** A `run-ci` Ubuntu run only exercises `linux-x64` and would _not_
   catch a pruned `darwin-arm64`/`linuxmusl-x64` entry — the lockfile-content
   check in step 2 is the real, OS-independent assertion (sharp's per-platform
   `@img/*` packages are `optionalDependencies` npm writes to the lockfile on any
   OS; the failure mode is _absent lockfile entries_, not a Linux runtime error),
   and `release.yml` already exercises the full cross-OS matrix at tag time for free.

### Commit group B — Flutter (scope `app`)

A separate, correctly-scoped `chore(app): …` commit on the **same branch/PR** —
not a second PR. `apps/android/**` is the `app` scope, and `app.yml` triggers on
those **paths** (not on PR boundaries), so one PR containing this commit fires the
Flutter CI (`flutter analyze`/`test`/build — the only automated Flutter coverage,
no local hook runs it) identically. Keeping `connectivity_plus`/codegen as its own
commit keeps the diff legible without forking the PR.

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
4. Gate: `flutter analyze` + `flutter test` **locally — mandatory, not
   belt-and-suspenders.** Pre-commit (`verify:fast:scoped`) and pre-push run **no**
   Flutter leg, so `app.yml` (which runs only after push) is the _only_ automated
   Flutter coverage — a red Flutter tree slips through every local gate otherwise.
   Confirm `checkConnectivity()` still returns `List<ConnectivityResult>`.

### Docs & deferral (`docs(deps): …` commit)

1. **Author `docs/features/224-deps-round-4.md`** from `docs/features/TEMPLATE.md`
   — the template's required sections are `Benefit/Rationale`, `Architectural
   impact`, `Test plan`; mark the thin ones "n/a — hygiene round" _explicitly_
   rather than omitting them. Include the three majors' migration notes, Key
   files, and `Refs #431 #711 #790`. **Lifecycle:** author as `status: active`;
   on merge flip to `status: stable`, fill Ship notes (date + merge SHA),
   `git mv` it under `docs/features/archive/`, and place its `INDEX.md` entry
   under **`## Shipped (archive)`** — matching rounds 167/170/202, which all live
   in `archive/` (a deps round has no active life after it merges).
2. **Rewrite + re-date the blocked-item rows** in `docs/BACKLOG.md`:
   - `srv-4` (≈ line 138, "Maintenance & upkeep") — the existing _What_ ("bump
     `@google/genai` 2.8+") is now **wrong** and must be **replaced**, not just
     dated: genai is already 2.8.0; the culprit is `gaxios@7.1.5 →
     node-fetch@^3.3.2` and no published gaxios drops it (don't chase `fetch-blob`
     4.x either — it still pins node-domexception).
   - `ops-17` (≈ line 144, same section) — re-confirm "still latest, no migrated
     release," stamp 2026-06-18.
   - `ops-14` (≈ line 372, a **different** section) — re-confirm the plugin peer
     caps (`eslint-plugin-react ^9.7`, `eslint-plugin-jsx-a11y ^9`), stamp 2026-06-18.
3. **File the deferred sidecar spike** as a new Backlog item, full recipe:
   - Issue title `side-<n> — sidecar engine-dep major bump (torch / transformers
     / huggingface_hub / …)`, where `<n>` is the next free `side-` ID; labels
     `area:side` + `moscow:could` + `type:chore` + `needs-plan`; body notes it
     needs a GPU box + the golden-audio gate to validate.
   - Add the thin `docs/BACKLOG.md` row under the Could "Reliability &
     observability" sub-group: a `#### side-<n> — … (#NN)` header + the
     `_What:_` / `_Benefit (technical):_` / `_Full detail + acceptance:_` triplet,
     linking the issue.
4. **PR body** uses `Refs #431 #711 #790 #<sidecar-issue>` — everything this round
   touches is deferred or re-confirmed; **nothing is `Closes`d.**

### PR lifecycle

Open the PR once commit group A is pushed (draft is fine — CI is opt-in and bills
0 minutes by default). `gh pr ready` only after all three commit groups are in and
both `npm run verify` and `flutter analyze`/`flutter test` are green locally. Merge
via the "Create a merge commit" button (squash/rebase are disabled at the repo
level); the head branch auto-deletes on merge.

## 5. Testing & verification

- **Frontend (Wave 1):** `npm run verify` (typecheck + frontend + server +
  server-slow + e2e + build). The in-range bumps need no new tests. After the
  Playwright bump, `npx playwright install chromium` precedes `test:e2e`.
- **Server (Wave 2):** existing suites are the regression net, and each major's
  seam is named:
  - express-rate-limit 8 → `server/src/middleware/rate-limit.test.ts` (exercises
    the limiter via a `skip: () => false` override; asserts `ratelimit-limit` +
    429). Re-run after the bump (`standardHeaders: true` is unchanged, so no flip
    expected). _Fallback if it flips:_ if v8 maps `standardHeaders: true` to a
    draft that drops the individual `ratelimit-limit` header, pin the test to
    `standardHeaders: 'draft-6'` or assert the combined `RateLimit` header instead.
  - sharp 0.35 → the cover routes' tests (`cover.test.ts`, `upload.test.ts`)
    exercise `sharp(...).jpeg().toBuffer()` end-to-end.
- **Flutter (commit group B):** `flutter analyze` + `flutter test` (the pure
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
  release). Mitigated by the post-bump lockfile-matrix grep (OS-independent) +
  `release.yml`'s existing cross-OS verify at tag time — not a cloud CI run (an
  Ubuntu runner only validates `linux-x64`).
- **Playwright browser boundary.** Mitigated by `npx playwright install chromium`
  in Wave 1. **Decision: do _not_ pin `@playwright/test`.** Pinning `~1.60.0`
  would both conflict with this round's own 1.61.0 bump and freeze Playwright out
  of all future minors — a worse trade than the cheap, idempotent, already-
  documented install step (the e2e harness errors with a clear hint when chromium
  is missing). The durable fix is "run `playwright install` when the lockfile's
  playwright version changes," not a version freeze.

## 8. Known non-issues (do not re-flag in future audits)

- `@types/node` 25 (root) vs `^20` (server) — isolated TS projects, no shared
  build graph, `skipLibCheck: true`. Safe.
- `js@0.6.7` (Flutter) — discontinued but **dev-only transitive** via
  `drift_dev`'s codegen toolchain; never imported in `apps/android/lib`, never
  shipped. Ignore.
- Sidecar deferral — verified decoupled from every npm/Flutter bump in this round.
- vitest "version skew" (root vs server) — a non-issue: server vitest already
  floated to 4.1.9 while root sits at 4.1.8, so `npm outdated --prefix server` is
  already clean of vitest and the root `npm update` simply converges both to
  4.1.9. No server-side vitest step is needed; the §1 done-criterion holds.
