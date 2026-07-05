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
});
