---
status: active
shipped: null
owner: dudarenok-maker
---

# fs-1 — In-app upgrade pathway (versioned-directory)

> Status: active — implemented on `feat/server-in-app-upgrade`, pending the v1.6.0 release cut.
> Key files: `launch.mjs`, `scripts/{setup-versioned-install,restart-after-upgrade}.mjs`, `server/src/workspace/upgrade-coordinator.ts`, `server/src/upgrade/*`, `server/src/routes/{upgrade,info}.ts`, `src/components/{upgrade-card,whats-new-banner}.tsx`, `src/store/upgrade-slice.ts`, `src/lib/use-app-info.ts`
> URL surface: `#/account` (Application updates card) + the what's-new banner on every view
> OpenAPI ops: `GET /api/info`, `POST /api/info/dismiss-whats-new`, `POST /api/upgrade/{stage,apply,abort}`, `GET /api/upgrade/state` (routes live; openapi.yaml entries are a follow-up — see below)
> Issue: [#395](https://github.com/dudarenok-maker/AudioBook-Generator/issues/395)

## Benefit / Rationale

- **User:** upgrading drops from a five-step terminal rite (stop → download → extract → `npm ci` → restart) to one click in **Account → Application updates**, with auto-backup-before-migrate and a post-upgrade "what's new" banner.
- **Technical:** establishes a generic per-file schema-migration seam (`schema-migrate.ts`) + a boot coordinator that backs up before migrating — the tested home for every future non-additive workspace-JSON change.
- **Architectural:** moves the install to a **versioned-directory** layout (each release in `releases/vX.Y.Z/`, a stable `launch.mjs` runs the newest, user data in shared siblings). Rollback is "don't flip the pointer"; the running release is never deleted. Shared `RELEASE_NOTES.md` + `/api/info` plumbing also unblocks `ops-1` (Windows installer) and `ops-2` (Docker).

## Architectural impact

- **New seams:** `app-dirs.ts` (`APP_LOG_DIR`/`APP_RUN_DIR`), `SIDECAR_VENV_DIR`, `schema-migrate.ts` (`SCHEMA_SEAMS`), `upgrade-coordinator.ts`, `routes/upgrade.ts` + `upgrade/*`, `routes/info.ts`, `use-app-info.ts`, `upgrade-slice.ts`, `version.py`.
- **Invariants preserved:** OpenAPI-as-truth (types still flow from `api-types.ts`; openapi.yaml entries owed below); discriminated-union `ui.stage` untouched; mocks-behind-`VITE_USE_MOCKS` (mock api is "always up to date"); RTK immer; concurrent-multi-book (the upgrade gate refuses while ANY book renders/analyses — `activeGenerationBooks`/`activeAnalysisManuscripts`).
- **Migration story:** the five secondary workspace JSONs (cast / manuscript-edits / revisions / listen-progress / voices) get a generic migrator, all at schema v1 today (identity). Writers do **not** yet stamp `schema` (24 call sites) — deferred to the first real bump, where it's load-bearing and testable; absence-means-v1 keeps unstamped files loading. user-settings gains additive `lastSeenAppVersion` / `showWhatsNew` / `schemaVersion`, written only by `writeUpgradeMeta` (stripped from the general PUT).

## Versioned-directory layout

```
<install>/
  launch.mjs            # STABLE entry; NEVER replaced by an upgrade
  .current-version      # "1.6.0" pointer (text file — Windows-safe, no symlink)
  releases/v1.6.0/      # one extracted release zip (code + node_modules)
  workspace/  venv/  models/kokoro/  logs/  .run/   # SHARED, outside releases
```

`launch.mjs` no-ops to today's `start-app-prod.mjs` in a plain dev checkout (no `releases/` + `.current-version`), so it ships harmlessly in every zip.

## Apply flow (what happens on "Apply upgrade")

1. `POST /stage` (multer) → `validateUpgradeZip` (single `audiobook-generator-vX.Y.Z/` top dir, required artefacts, semver, **412 on downgrade**, **409 if busy**) → records the candidate + req-hash in `<install>/.upgrade-staging/state.json`.
2. `POST /apply` → `202`, then in the background: extract into a **new** `releases/v<cand>/` (running dir untouched) → `npm ci` (root + server) → conditional pip into the **shared** venv (only when req-hash changed) → **atomic flip** of `.current-version` (the commit) → spawn detached `restart-after-upgrade.mjs` → `SIGTERM` self.
3. The restarter waits for the old PID to exit, then runs `launch.mjs`, which boots the new release. The UI overlay polls `/api/upgrade/state` + `/api/info`; on the version flip it toasts + reloads.
4. **Rollback:** any failure before the flip leaves the pointer (old release stays current) and clears the half-written candidate dir. The boot coordinator prunes to the newest 2 release dirs after a healthy boot.

## Seed-release honesty

1.5.x has none of this, so the jump **into** 1.6.0 is manual: a one-time `scripts/setup-versioned-install.mjs --apply` converts a single-checkout install to the versioned layout (moves workspace / venv / Kokoro weights into shared siblings — never re-downloads). **The first self-upgrade a tester experiences is 1.6.0 → 1.7.0.** Documented in `INSTALL.md` "Updating".

## Test plan

Automated (all green on the branch):
- Server: `app-dirs`, `app-version`, `schema-migrate`, `upgrade-coordinator`, `upgrade/{zip-validate,busy-probe,apply,paths}`, `routes/{upgrade,info}`, `user-settings` (upgrade-meta).
- Scripts (node:test): `launch`, `restart-after-upgrade`, `setup-versioned-install`, `bump-version` (version.py lockstep), `release-manifest` (RELEASE_NOTES + scripts shipped).
- Sidecar (pytest, CI-skips): `/health __version__`.
- Frontend: `upgrade-slice`, `whats-new-banner`, `use-app-info`; Playwright `e2e/upgrade-flow.spec.ts` (stage → confirm → apply → overlay + cancel).

Manual acceptance (run before announcing v1.6.0):
1. `setup-versioned-install.mjs --apply` converts a real 1.5.x tree idempotently; weights + venv MOVED not re-downloaded.
2. Stage a valid newer zip → confirm dialog shows the delta + notes; a downgrade zip → 412; a busy book → 409.
3. Apply → overlay → version pill flips → what's-new banner appears once; `.upgrade-backups/from-…/` written; old release pruned to last 2.
4. Kill mid-apply before the flip → next launch runs OLD. Cross-OS smoke on macOS (the Node-ESM swap is the cross-platform risk).

## Deferred follow-ups (filed as Could-bucket backlog items)

- Add the four `/api/upgrade/*` + `/api/info` ops to `openapi.yaml` and regenerate `api-types.ts` (routes work today off hand-written `src/lib/types.ts`).
- Thread writer-side `stampSeamSchema` through the workspace-JSON write sites when the first real schema bump lands.
- Downgrade-with-data-rollback (reverse migrations + restore-from-backup UI).
- Ed25519 signature verification on the uploaded zip; differential/patch upgrades; auto-poll a drop location.

## Ship notes

_Pending: fill the shipped date + commit SHA and flip `status: stable` when v1.6.0 is cut and the manual acceptance above passes._
