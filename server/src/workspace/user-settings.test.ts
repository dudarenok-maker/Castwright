/* Tight schema tests for the user-settings document — pins plan 40's
   coverPickerDefaultTab field across schema parse, write+read round-trip,
   and legacy-file back-compat. */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_USER_SETTINGS, userSettingsSchema } from './user-settings.js';

let workspaceRoot: string;

beforeEach(() => {
  workspaceRoot = mkdtempSync(join(tmpdir(), 'user-settings-test-'));
  process.env.WORKSPACE_DIR = workspaceRoot;
});

afterEach(() => {
  if (workspaceRoot) rmSync(workspaceRoot, { recursive: true, force: true });
  delete process.env.WORKSPACE_DIR;
});

describe('userSettingsSchema — defaultThemePreference (plan 41)', () => {
  it("defaults to 'system' on a fresh user-settings document", () => {
    expect(DEFAULT_USER_SETTINGS.defaultThemePreference).toBe('system');
  });

  it("accepts 'light', 'dark', and 'system'", () => {
    for (const value of ['light', 'dark', 'system'] as const) {
      expect(
        userSettingsSchema.parse({ ...DEFAULT_USER_SETTINGS, defaultThemePreference: value })
          .defaultThemePreference,
      ).toBe(value);
    }
  });

  it("rejects unknown values such as 'sepia'", () => {
    expect(() =>
      userSettingsSchema.parse({ ...DEFAULT_USER_SETTINGS, defaultThemePreference: 'sepia' }),
    ).toThrow();
  });

  it('treats the field as optional — legacy settings files without it parse cleanly', () => {
    const { defaultThemePreference, ...legacy } = DEFAULT_USER_SETTINGS;
    const parsed = userSettingsSchema.parse(legacy);
    expect(parsed.defaultThemePreference).toBeUndefined();
  });

  it('round-trips through writeUserSettings + readUserSettings', async () => {
    const mod = await import('./user-settings.js');
    mod._resetUserSettingsCache();
    const before = await mod.readUserSettings();
    try {
      const updated = await mod.writeUserSettings({ defaultThemePreference: 'dark' });
      expect(updated.defaultThemePreference).toBe('dark');
      mod._resetUserSettingsCache();
      const reread = await mod.readUserSettings();
      expect(reread.defaultThemePreference).toBe('dark');
    } finally {
      await mod.writeUserSettings({
        defaultThemePreference: before.defaultThemePreference ?? 'system',
      });
      mod._resetUserSettingsCache();
    }
  });
});

describe('userSettingsSchema — coverPickerDefaultTab (plan 40)', () => {
  it("defaults to 'search' on a fresh user-settings document", () => {
    expect(DEFAULT_USER_SETTINGS.coverPickerDefaultTab).toBe('search');
  });

  it("accepts 'search' and 'upload'", () => {
    expect(userSettingsSchema.parse({ ...DEFAULT_USER_SETTINGS, coverPickerDefaultTab: 'search' })
      .coverPickerDefaultTab).toBe('search');
    expect(userSettingsSchema.parse({ ...DEFAULT_USER_SETTINGS, coverPickerDefaultTab: 'upload' })
      .coverPickerDefaultTab).toBe('upload');
  });

  it("rejects unknown values such as 'frame' (Frame tab is never a valid default)", () => {
    expect(() =>
      userSettingsSchema.parse({ ...DEFAULT_USER_SETTINGS, coverPickerDefaultTab: 'frame' }),
    ).toThrow();
  });

  it('treats the field as optional — legacy settings files without it parse cleanly', () => {
    const { coverPickerDefaultTab, ...legacy } = DEFAULT_USER_SETTINGS;
    const parsed = userSettingsSchema.parse(legacy);
    expect(parsed.coverPickerDefaultTab).toBeUndefined();
  });

  it('round-trips through writeUserSettings + readUserSettings', async () => {
    // Defer-load so WORKSPACE_DIR is honoured by paths.ts at module init.
    const mod = await import('./user-settings.js');
    mod._resetUserSettingsCache();
    // The user-settings file lives under the server dir, not the workspace
    // — so the test asserts the schema directly via the public read/write
    // helpers but is OK with the on-disk write going to the real
    // server/user-settings.json. We restore the file at the end.
    const before = await mod.readUserSettings();
    try {
      const updated = await mod.writeUserSettings({ coverPickerDefaultTab: 'upload' });
      expect(updated.coverPickerDefaultTab).toBe('upload');
      mod._resetUserSettingsCache();
      const reread = await mod.readUserSettings();
      expect(reread.coverPickerDefaultTab).toBe('upload');
    } finally {
      // Restore so we don't pollute the dev's user-settings.json.
      await mod.writeUserSettings({ coverPickerDefaultTab: before.coverPickerDefaultTab ?? 'search' });
      mod._resetUserSettingsCache();
    }
  });
});
