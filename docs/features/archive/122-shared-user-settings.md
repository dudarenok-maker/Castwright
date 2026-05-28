---
status: stable
shipped: 2026-05-27
owner: null
---

# Shared user-settings location (one file across every checkout)

> Status: stable
> Key files: `server/src/workspace/user-settings.ts`, `server/src/test-setup.ts`, `server/vitest.config.ts`, `server/vitest.config.slow.ts`
> URL surface: indirect — `#/account` reads/writes via `GET`/`PUT /api/user/settings`
> OpenAPI ops: `GET /api/user/settings`, `PUT /api/user/settings`

## Benefit / Rationale

- **User:** account defaults (TTS engine, `eagerLoadKokoro`, analysis model, …) saved once are honoured no matter which checkout the app is launched from. Fixes the recurring "I set the default to Qwen and disabled eager Kokoro, but it reverts on restart" — the change was landing in one git worktree's `server/user-settings.json` while the app was relaunched from another tree (or the saving worktree was later pruned, taking the file with it).
- **Technical:** settings are USER-scoped, so they now live in a single per-user file (`~/.audiobook-generator/user-settings.json`) outside any git checkout. Read/write paths were already correct (verified by a live PUT→disk→GET round-trip); the only bug was the per-checkout *location*.
- **Architectural:** decouples user-level config from the repo tree. A bonus for deployers: settings survive extract-over-the-top reinstalls, since the file no longer lives inside the install folder.

## Architectural impact

- **New seam:** `resolveUserSettingsPath(env)` — pure, exported, unit-tested. Resolution chain: `USER_SETTINGS_FILE` env override → `~/.audiobook-generator/user-settings.json`. `USER_SETTINGS_PATH` is `resolveUserSettingsPath()` evaluated at module load.
- **Migration (one-time, automatic):** `migrateLegacyUserSettings({ from, to, overridden })` copies the pre-122 `<SERVER_ROOT>/user-settings.json` to the shared path the first time `readUserSettings()` runs and the shared file is absent. **Copy, not move** — a rollback to a pre-122 build still finds its file. Skipped when the path is explicitly overridden (so a test run can never migrate a developer's real settings). `console.info` logs the one migration line.
- **Test isolation:** `server/src/test-setup.ts` (new vitest `setupFiles`, wired into both `vitest.config.ts` and `vitest.config.slow.ts`) sets `USER_SETTINGS_FILE` to a throwaway temp file before any module loads. Strictly better than the prior behaviour, where round-trip tests wrote to (and restored) the real on-disk settings file — a crash between write and restore could corrupt real settings.
- **Reversibility:** delete the resolver + migration and restore `join(SERVER_ROOT, 'user-settings.json')`. The legacy file is left in place by the copy-migration, so a revert reads it again with no data loss.
- **Invariants preserved:** the writable-subset schema, the `FORBIDDEN_KEYS` secret-strip, the dedicated `writeGeminiApiKey` path, and the atomic temp-then-rename write (which is why a symlink/hardlink approach was rejected — the rename severs the link on first save).

## Invariants to preserve

- `resolveUserSettingsPath` honours a non-blank `USER_SETTINGS_FILE` and otherwise returns `join(homedir(), '.audiobook-generator', 'user-settings.json')` — `server/src/workspace/user-settings.ts`.
- `migrateLegacyUserSettings` returns `false` (no write) when `overridden`, when the target exists, or when the source is absent; copies otherwise.
- `readUserSettings()` calls the migration before its first disk read and is short-circuited by the in-process `cached` value.
- Both vitest configs list `setupFiles: ['src/test-setup.ts']`; `test-setup.ts` is excluded from the `test`/`spec` include glob.

## Test plan

### Automated

- `server/src/workspace/user-settings.test.ts` — plan-122 block:
  - `resolveUserSettingsPath`: honours `USER_SETTINGS_FILE`, falls back to the shared home path, ignores a blank override.
  - `migrateLegacyUserSettings`: copies when target absent; no-op (no overwrite) when target exists; no-op when source absent; skipped when `overridden`.
- `server/src/routes/user-settings.test.ts` and the existing round-trip tests continue to pass against the temp override (19 + 43 tests green).
- Full fast server suite green (1460 passed / 8 skipped) — the setup-file redirect breaks nothing.

### Manual acceptance

1. From `main`, Account → set TTS model = Qwen, untick "Eager-load Kokoro at startup", Save.
2. Confirm `~/.audiobook-generator/user-settings.json` shows `"defaultTtsModelKey":"qwen3-tts-0.6b"`, `"eagerLoadKokoro":false`.
3. Create a worktree (`node scripts/wt-new.mjs fix/server-x`), launch its app, open Account → the same Qwen / no-eager values show (no per-tree divergence).
4. Clean-restart from main → sidecar log shows no "Preloading Kokoro at startup" (the `false` took effect on the fresh spawn).

## Ship notes

- Shipped 2026-05-27 via PR #294 (`71e97f8`) on branch `fix/server-shared-user-settings`.
- The one-time migration carries the existing `server/user-settings.json` forward on first read; the legacy file is left in place as a rollback safety net (gitignored, harmless).
