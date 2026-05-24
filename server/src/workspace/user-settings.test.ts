/* Tight schema tests for the user-settings document — pins plan 40's
   coverPickerDefaultTab field across schema parse, write+read round-trip,
   and legacy-file back-compat. */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DEFAULT_USER_SETTINGS,
  userSettingsSchema,
  getResolvedAutoStartSidecar,
  _resetUserSettingsCache,
} from './user-settings.js';

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
    const { defaultThemePreference: _defaultThemePreference, ...legacy } = DEFAULT_USER_SETTINGS;
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

describe('userSettingsSchema — autoStartSidecar (plan 43)', () => {
  it('defaults to true on a fresh user-settings document', () => {
    expect(DEFAULT_USER_SETTINGS.autoStartSidecar).toBe(true);
  });

  it('accepts true and false', () => {
    expect(
      userSettingsSchema.parse({ ...DEFAULT_USER_SETTINGS, autoStartSidecar: true })
        .autoStartSidecar,
    ).toBe(true);
    expect(
      userSettingsSchema.parse({ ...DEFAULT_USER_SETTINGS, autoStartSidecar: false })
        .autoStartSidecar,
    ).toBe(false);
  });

  it("rejects non-boolean values such as 'yes'", () => {
    expect(() =>
      userSettingsSchema.parse({ ...DEFAULT_USER_SETTINGS, autoStartSidecar: 'yes' }),
    ).toThrow();
  });

  it('treats the field as optional — legacy settings files without it parse cleanly', () => {
    const { autoStartSidecar: _autoStartSidecar, ...legacy } = DEFAULT_USER_SETTINGS;
    const parsed = userSettingsSchema.parse(legacy);
    expect(parsed.autoStartSidecar).toBeUndefined();
  });

  describe('getResolvedAutoStartSidecar', () => {
    beforeEach(() => {
      _resetUserSettingsCache();
      delete process.env.DISABLE_AUTOSTART_SIDECAR;
    });

    afterEach(() => {
      delete process.env.DISABLE_AUTOSTART_SIDECAR;
    });

    it('returns the default (true) when nothing is cached and no env override', () => {
      expect(getResolvedAutoStartSidecar()).toBe(true);
    });

    it('returns false when DISABLE_AUTOSTART_SIDECAR=1 regardless of preference', () => {
      process.env.DISABLE_AUTOSTART_SIDECAR = '1';
      expect(getResolvedAutoStartSidecar()).toBe(false);
    });

    it('ignores DISABLE_AUTOSTART_SIDECAR values other than "1"', () => {
      process.env.DISABLE_AUTOSTART_SIDECAR = 'true';
      expect(getResolvedAutoStartSidecar()).toBe(true);
      process.env.DISABLE_AUTOSTART_SIDECAR = '0';
      expect(getResolvedAutoStartSidecar()).toBe(true);
    });
  });
});

describe('userSettingsSchema — dualModelEnabled', () => {
  it('defaults to false on a fresh user-settings document', () => {
    expect(DEFAULT_USER_SETTINGS.dualModelEnabled).toBe(false);
  });

  it('accepts true and false', () => {
    expect(
      userSettingsSchema.parse({ ...DEFAULT_USER_SETTINGS, dualModelEnabled: true })
        .dualModelEnabled,
    ).toBe(true);
    expect(
      userSettingsSchema.parse({ ...DEFAULT_USER_SETTINGS, dualModelEnabled: false })
        .dualModelEnabled,
    ).toBe(false);
  });

  it("rejects non-boolean values such as 'yes'", () => {
    expect(() =>
      userSettingsSchema.parse({ ...DEFAULT_USER_SETTINGS, dualModelEnabled: 'yes' }),
    ).toThrow();
  });

  it('treats the field as optional — legacy settings files without it parse cleanly', () => {
    const { dualModelEnabled: _dualModelEnabled, ...legacy } = DEFAULT_USER_SETTINGS;
    const parsed = userSettingsSchema.parse(legacy);
    expect(parsed.dualModelEnabled).toBeUndefined();
  });

  it('round-trips through writeUserSettings + readUserSettings', async () => {
    const mod = await import('./user-settings.js');
    mod._resetUserSettingsCache();
    const before = await mod.readUserSettings();
    try {
      const updated = await mod.writeUserSettings({ dualModelEnabled: true });
      expect(updated.dualModelEnabled).toBe(true);
      mod._resetUserSettingsCache();
      const reread = await mod.readUserSettings();
      expect(reread.dualModelEnabled).toBe(true);
    } finally {
      await mod.writeUserSettings({
        dualModelEnabled: before.dualModelEnabled ?? false,
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
    expect(
      userSettingsSchema.parse({ ...DEFAULT_USER_SETTINGS, coverPickerDefaultTab: 'search' })
        .coverPickerDefaultTab,
    ).toBe('search');
    expect(
      userSettingsSchema.parse({ ...DEFAULT_USER_SETTINGS, coverPickerDefaultTab: 'upload' })
        .coverPickerDefaultTab,
    ).toBe('upload');
  });

  it("rejects unknown values such as 'frame' (Frame tab is never a valid default)", () => {
    expect(() =>
      userSettingsSchema.parse({ ...DEFAULT_USER_SETTINGS, coverPickerDefaultTab: 'frame' }),
    ).toThrow();
  });

  it('treats the field as optional — legacy settings files without it parse cleanly', () => {
    const { coverPickerDefaultTab: _coverPickerDefaultTab, ...legacy } = DEFAULT_USER_SETTINGS;
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
      await mod.writeUserSettings({
        coverPickerDefaultTab: before.coverPickerDefaultTab ?? 'search',
      });
      mod._resetUserSettingsCache();
    }
  });
});
