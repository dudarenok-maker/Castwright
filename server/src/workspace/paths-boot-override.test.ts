/* Regression for #1337 — resource-telemetry.test.ts (and any other suite
   relying on WORKSPACE_DIR isolation) failed deterministically on machines
   with a legacy `<SERVER_ROOT>/user-settings.json` carrying a
   `workspaceDirOverride`: readBootOverride() read that hardcoded path
   directly, ignoring USER_SETTINGS_FILE, so the override always won over a
   test's WORKSPACE_DIR env var and every run wrote to the same real,
   persistent directory instead of a per-test tmpdir.

   Fix: readBootOverride() reads the resolved USER_SETTINGS_PATH (plan 122),
   which itself honours USER_SETTINGS_FILE — the same env var test-setup.ts
   already redirects to a throwaway file for every test. Dynamic import
   (after setting the env var) is required since USER_SETTINGS_PATH and
   readBootOverride's behaviour are fixed at module-eval time. */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readBootOverride } from './paths.js';

describe('readBootOverride (#1337)', () => {
  let dir: string;
  const originalUserSettingsFile = process.env.USER_SETTINGS_FILE;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'audiobook-boot-override-test-'));
    /* USER_SETTINGS_PATH (user-settings.js) and the boot-override resolution
       (paths.js) are both fixed at module-eval time — force a fresh module
       graph per test so each one observes its own USER_SETTINGS_FILE. */
    vi.resetModules();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    if (originalUserSettingsFile === undefined) delete process.env.USER_SETTINGS_FILE;
    else process.env.USER_SETTINGS_FILE = originalUserSettingsFile;
  });

  it('reads workspaceDirOverride from the USER_SETTINGS_FILE-resolved path, not a hardcoded legacy one', async () => {
    const settingsPath = join(dir, 'user-settings.json');
    writeFileSync(
      settingsPath,
      JSON.stringify({ workspaceDirOverride: 'D:/some/custom/workspace' }),
    );
    process.env.USER_SETTINGS_FILE = settingsPath;

    const mod = await import('./paths.js');
    expect(mod.readBootOverride()).toBe('D:/some/custom/workspace');
  });

  it('returns null when the USER_SETTINGS_FILE-resolved file has no override', async () => {
    const settingsPath = join(dir, 'user-settings.json');
    writeFileSync(settingsPath, JSON.stringify({}));
    process.env.USER_SETTINGS_FILE = settingsPath;

    const mod = await import('./paths.js');
    expect(mod.readBootOverride()).toBeNull();
  });

  it('returns null when the USER_SETTINGS_FILE-resolved file does not exist', async () => {
    process.env.USER_SETTINGS_FILE = join(dir, 'does-not-exist.json');

    const mod = await import('./paths.js');
    expect(mod.readBootOverride()).toBeNull();
  });

  /* Regression for a boot-timing gap introduced by the #1337 fix above (code
     review, PR #1353): migrateLegacyUserSettings only copies the legacy file
     to the shared USER_SETTINGS_PATH the first time readUserSettings() runs
     — async, and for the server's own boot, strictly LATER than paths.ts's
     synchronous module-eval-time read (index.ts imports ./workspace/paths.js
     before ever calling readUserSettings()). Without a legacy fallback, a
     user whose override lives only in the legacy file would have it silently
     ignored for a whole process lifetime post-fix — pre-fix this worked on
     the very first boot. These use the injectable-path form directly (no
     module reload needed — no module-level state is involved). */
  it('falls back to the legacy path when the shared file has no override and no USER_SETTINGS_FILE override is active', () => {
    const sharedPath = join(dir, 'shared-user-settings.json');
    const legacyPath = join(dir, 'legacy-user-settings.json');
    writeFileSync(legacyPath, JSON.stringify({ workspaceDirOverride: 'D:/legacy/workspace' }));
    // sharedPath deliberately does not exist — the not-yet-migrated case.

    expect(readBootOverride(sharedPath, legacyPath, {})).toBe('D:/legacy/workspace');
  });

  it('does not fall back to the legacy path when a USER_SETTINGS_FILE override is active (test isolation)', () => {
    const sharedPath = join(dir, 'shared-user-settings.json');
    const legacyPath = join(dir, 'legacy-user-settings.json');
    writeFileSync(legacyPath, JSON.stringify({ workspaceDirOverride: 'D:/legacy/workspace' }));

    expect(
      readBootOverride(sharedPath, legacyPath, { USER_SETTINGS_FILE: sharedPath }),
    ).toBeNull();
  });

  it('prefers the shared path over the legacy path when both carry an override', () => {
    const sharedPath = join(dir, 'shared-user-settings.json');
    const legacyPath = join(dir, 'legacy-user-settings.json');
    writeFileSync(sharedPath, JSON.stringify({ workspaceDirOverride: 'D:/shared/workspace' }));
    writeFileSync(legacyPath, JSON.stringify({ workspaceDirOverride: 'D:/legacy/workspace' }));

    expect(readBootOverride(sharedPath, legacyPath, {})).toBe('D:/shared/workspace');
  });
});
