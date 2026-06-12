/* Tight schema tests for the user-settings document — pins plan 40's
   coverPickerDefaultTab field across schema parse, write+read round-trip,
   and legacy-file back-compat. */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import {
  DEFAULT_USER_SETTINGS,
  userSettingsSchema,
  getResolvedAutoStartSidecar,
  getResolvedGenerationWorkers,
  resolveUserSettingsPath,
  migrateLegacyUserSettings,
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

describe('userSettingsSchema — generationWorkers (plan 111)', () => {
  it('defaults to 1 on a fresh user-settings document', () => {
    expect(DEFAULT_USER_SETTINGS.generationWorkers).toBe(1);
  });

  it('accepts integers in [1, 4]', () => {
    for (const value of [1, 2, 3, 4]) {
      expect(
        userSettingsSchema.parse({ ...DEFAULT_USER_SETTINGS, generationWorkers: value })
          .generationWorkers,
      ).toBe(value);
    }
  });

  it('rejects out-of-range and non-integer values (0, 5, 2.5)', () => {
    for (const value of [0, 5, 2.5]) {
      expect(() =>
        userSettingsSchema.parse({ ...DEFAULT_USER_SETTINGS, generationWorkers: value }),
      ).toThrow();
    }
  });

  it('treats the field as optional — legacy settings files without it parse cleanly', () => {
    const { generationWorkers: _generationWorkers, ...legacy } = DEFAULT_USER_SETTINGS;
    const parsed = userSettingsSchema.parse(legacy);
    expect(parsed.generationWorkers).toBeUndefined();
  });

  describe('getResolvedGenerationWorkers', () => {
    beforeEach(() => {
      _resetUserSettingsCache();
      delete process.env.GEN_WORKERS;
      delete process.env.GEN_CHAPTER_CONCURRENCY;
    });

    afterEach(() => {
      delete process.env.GEN_WORKERS;
      delete process.env.GEN_CHAPTER_CONCURRENCY;
      _resetUserSettingsCache();
    });

    it('returns the default (1) when nothing is cached and no env override', () => {
      expect(getResolvedGenerationWorkers()).toBe(1);
    });

    it('honors GEN_WORKERS env', () => {
      process.env.GEN_WORKERS = '3';
      expect(getResolvedGenerationWorkers()).toBe(3);
    });

    it('ignores the retired GEN_CHAPTER_CONCURRENCY env (plan 111 wave 4)', () => {
      process.env.GEN_CHAPTER_CONCURRENCY = '4';
      /* No longer read — falls through to the default. */
      expect(getResolvedGenerationWorkers()).toBe(1);
    });

    it('falls through to the cached user setting when no env is set', async () => {
      const mod = await import('./user-settings.js');
      mod._resetUserSettingsCache();
      const before = await mod.readUserSettings();
      try {
        await mod.writeUserSettings({ generationWorkers: 4 });
        expect(mod.getResolvedGenerationWorkers()).toBe(4);
      } finally {
        await mod.writeUserSettings({ generationWorkers: before.generationWorkers ?? 1 });
        mod._resetUserSettingsCache();
      }
    });

    it('ignores a non-numeric env and falls back to the default', () => {
      process.env.GEN_WORKERS = 'lots';
      expect(getResolvedGenerationWorkers()).toBe(1);
    });

    it('defaults to 1 worker when no env, override, or setting is present', () => {
      delete process.env.GEN_WORKERS;
      expect(getResolvedGenerationWorkers()).toBe(1);
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

describe('userSettingsSchema — eagerLoadKokoro', () => {
  it('defaults to true on a fresh user-settings document', () => {
    expect(DEFAULT_USER_SETTINGS.eagerLoadKokoro).toBe(true);
  });

  it('accepts true and false', () => {
    expect(
      userSettingsSchema.parse({ ...DEFAULT_USER_SETTINGS, eagerLoadKokoro: true })
        .eagerLoadKokoro,
    ).toBe(true);
    expect(
      userSettingsSchema.parse({ ...DEFAULT_USER_SETTINGS, eagerLoadKokoro: false })
        .eagerLoadKokoro,
    ).toBe(false);
  });

  it("rejects non-boolean values such as 'yes'", () => {
    expect(() =>
      userSettingsSchema.parse({ ...DEFAULT_USER_SETTINGS, eagerLoadKokoro: 'yes' }),
    ).toThrow();
  });

  it('treats the field as optional — legacy settings files without it parse cleanly', () => {
    const { eagerLoadKokoro: _eagerLoadKokoro, ...legacy } = DEFAULT_USER_SETTINGS;
    const parsed = userSettingsSchema.parse(legacy);
    expect(parsed.eagerLoadKokoro).toBeUndefined();
  });

  it('round-trips through writeUserSettings + readUserSettings', async () => {
    const mod = await import('./user-settings.js');
    mod._resetUserSettingsCache();
    const before = await mod.readUserSettings();
    try {
      const updated = await mod.writeUserSettings({ eagerLoadKokoro: false });
      expect(updated.eagerLoadKokoro).toBe(false);
      mod._resetUserSettingsCache();
      const reread = await mod.readUserSettings();
      expect(reread.eagerLoadKokoro).toBe(false);
    } finally {
      await mod.writeUserSettings({
        eagerLoadKokoro: before.eagerLoadKokoro ?? true,
      });
      mod._resetUserSettingsCache();
    }
  });
});

describe('userSettingsSchema — eagerLoadQwen', () => {
  it('defaults to true on a fresh user-settings document', () => {
    expect(DEFAULT_USER_SETTINGS.eagerLoadQwen).toBe(true);
  });

  it('accepts true and false', () => {
    expect(
      userSettingsSchema.parse({ ...DEFAULT_USER_SETTINGS, eagerLoadQwen: true }).eagerLoadQwen,
    ).toBe(true);
    expect(
      userSettingsSchema.parse({ ...DEFAULT_USER_SETTINGS, eagerLoadQwen: false }).eagerLoadQwen,
    ).toBe(false);
  });

  it("rejects non-boolean values such as 'yes'", () => {
    expect(() =>
      userSettingsSchema.parse({ ...DEFAULT_USER_SETTINGS, eagerLoadQwen: 'yes' }),
    ).toThrow();
  });

  it('treats the field as optional — legacy settings files without it parse cleanly', () => {
    const { eagerLoadQwen: _eagerLoadQwen, ...legacy } = DEFAULT_USER_SETTINGS;
    const parsed = userSettingsSchema.parse(legacy);
    expect(parsed.eagerLoadQwen).toBeUndefined();
  });

  it('round-trips through writeUserSettings + readUserSettings', async () => {
    const mod = await import('./user-settings.js');
    mod._resetUserSettingsCache();
    const before = await mod.readUserSettings();
    try {
      const updated = await mod.writeUserSettings({ eagerLoadQwen: false });
      expect(updated.eagerLoadQwen).toBe(false);
      mod._resetUserSettingsCache();
      const reread = await mod.readUserSettings();
      expect(reread.eagerLoadQwen).toBe(false);
    } finally {
      await mod.writeUserSettings({
        eagerLoadQwen: before.eagerLoadQwen ?? true,
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

describe('user-settings location (plan 122 — shared across checkouts)', () => {
  describe('resolveUserSettingsPath', () => {
    const sharedDefault = join(homedir(), '.castwright', 'user-settings.json');

    it('honours USER_SETTINGS_FILE when set', () => {
      expect(
        resolveUserSettingsPath({ USER_SETTINGS_FILE: '/custom/us.json' } as NodeJS.ProcessEnv),
      ).toBe('/custom/us.json');
    });

    it('falls back to ~/.castwright/user-settings.json (NOT the checkout)', () => {
      expect(resolveUserSettingsPath({} as NodeJS.ProcessEnv)).toBe(sharedDefault);
    });

    it('ignores a blank / whitespace override', () => {
      expect(resolveUserSettingsPath({ USER_SETTINGS_FILE: '   ' } as NodeJS.ProcessEnv)).toBe(
        sharedDefault,
      );
    });
  });

  describe('migrateLegacyUserSettings', () => {
    let dir: string;
    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), 'us-migrate-'));
    });
    afterEach(() => {
      rmSync(dir, { recursive: true, force: true });
    });

    it('copies the legacy file to the shared path when the shared file is absent', async () => {
      const from = join(dir, 'legacy.json');
      const to = join(dir, 'shared', 'user-settings.json'); // dir created on demand
      writeFileSync(
        from,
        JSON.stringify({ defaultTtsModelKey: 'qwen3-tts-0.6b', eagerLoadKokoro: false }),
      );
      expect(await migrateLegacyUserSettings({ from, to, overridden: false })).toBe(true);
      expect(existsSync(to)).toBe(true);
      expect(JSON.parse(readFileSync(to, 'utf8')).defaultTtsModelKey).toBe('qwen3-tts-0.6b');
    });

    it('is a no-op (no overwrite) when the shared file already exists', async () => {
      const from = join(dir, 'legacy.json');
      const to = join(dir, 'shared.json');
      writeFileSync(from, JSON.stringify({ eagerLoadKokoro: false }));
      writeFileSync(to, JSON.stringify({ eagerLoadKokoro: true }));
      expect(await migrateLegacyUserSettings({ from, to, overridden: false })).toBe(false);
      expect(JSON.parse(readFileSync(to, 'utf8')).eagerLoadKokoro).toBe(true); // untouched
    });

    it('is a no-op when there is no legacy file to migrate', async () => {
      const to = join(dir, 'shared.json');
      expect(
        await migrateLegacyUserSettings({ from: join(dir, 'nope.json'), to, overridden: false }),
      ).toBe(false);
      expect(existsSync(to)).toBe(false);
    });

    it('is skipped when the path is overridden, so a test run never migrates real settings', async () => {
      const from = join(dir, 'legacy.json');
      const to = join(dir, 'shared.json');
      writeFileSync(from, JSON.stringify({ eagerLoadKokoro: false }));
      expect(await migrateLegacyUserSettings({ from, to, overridden: true })).toBe(false);
      expect(existsSync(to)).toBe(false);
    });
  });
});

describe('getResolvedTtsModelKey — Qwen-when-installed default', () => {
  beforeEach(async () => {
    const mod = await import('./user-settings.js');
    /* The whole server suite shares one throwaway USER_SETTINGS_FILE that
       persists across tests; delete it so each case starts from factory
       defaults (explicit=false) — the explicit sentinel can't be un-set via
       the public API, so a leaked file would cross-contaminate. */
    rmSync(mod.USER_SETTINGS_PATH, { force: true });
    mod._resetUserSettingsCache();
    await mod.readUserSettings();
  });

  it('defaults to kokoro-v1 when Qwen install-state is unknown/not-installed', async () => {
    const mod = await import('./user-settings.js');
    mod.setLastKnownQwenInstallState('not-installed');
    expect(mod.getResolvedTtsModelKey()).toBe('kokoro-v1');
    mod.setLastKnownQwenInstallState('weights-missing');
    expect(mod.getResolvedTtsModelKey()).toBe('kokoro-v1');
  });

  it('prefers qwen3-tts-0.6b when Qwen is installed (ready or loaded) and no explicit choice', async () => {
    const mod = await import('./user-settings.js');
    mod.setLastKnownQwenInstallState('ready');
    expect(mod.getResolvedTtsModelKey()).toBe('qwen3-tts-0.6b');
    mod.setLastKnownQwenInstallState('loaded');
    expect(mod.getResolvedTtsModelKey()).toBe('qwen3-tts-0.6b');
  });

  it('honours an explicit user choice over the Qwen preference', async () => {
    const mod = await import('./user-settings.js');
    mod.setLastKnownQwenInstallState('ready');
    /* The frontend pins Kokoro by sending the explicit flag (re-selecting the
       value that equals the stored key isn't a "change", so the flag is the
       mechanism that lets a Qwen-box user keep Kokoro). */
    await mod.writeUserSettings({
      defaultTtsModelKey: 'kokoro-v1',
      defaultTtsModelKeyExplicit: true,
    });
    expect(mod.getResolvedTtsModelKey()).toBe('kokoro-v1');
  });

  it('latches defaultTtsModelKeyExplicit only on a genuine change (no-op round-trip stays implicit)', async () => {
    const mod = await import('./user-settings.js');
    // Re-writing the SAME stored value must NOT mark explicit (the GET→PUT
    // round-trip of the stored key would otherwise falsely lock the user).
    const sameValue = await mod.writeUserSettings({ defaultTtsModelKey: 'kokoro-v1' });
    expect(sameValue.defaultTtsModelKeyExplicit).toBeFalsy();
    // A real change to a different model DOES latch it.
    const changed = await mod.writeUserSettings({ defaultTtsModelKey: 'coqui-xtts-v2' });
    expect(changed.defaultTtsModelKeyExplicit).toBe(true);
    mod.setLastKnownQwenInstallState('ready');
    expect(mod.getResolvedTtsModelKey()).toBe('coqui-xtts-v2');
  });
});

describe('setupCompletedAt (fs-21 wave 0)', () => {
  beforeEach(async () => {
    const mod = await import('./user-settings.js');
    rmSync(mod.USER_SETTINGS_PATH, { force: true });
    mod._resetUserSettingsCache();
    await mod.readUserSettings();
  });

  afterEach(async () => {
    const mod = await import('./user-settings.js');
    rmSync(mod.USER_SETTINGS_PATH, { force: true });
    mod._resetUserSettingsCache();
  });

  it('reads null when unset', async () => {
    const { getResolvedSetupCompletedAt } = await import('./user-settings.js');
    expect(getResolvedSetupCompletedAt()).toBeNull();
  });

  it('round-trips a stamped ISO string', async () => {
    const { writeSetupCompletedAt, getResolvedSetupCompletedAt } = await import('./user-settings.js');
    await writeSetupCompletedAt('2026-06-12T00:00:00.000Z');
    expect(getResolvedSetupCompletedAt()).toBe('2026-06-12T00:00:00.000Z');
  });
});

describe('userSettingsSchema — fs-1 upgrade bookkeeping', () => {
  beforeEach(async () => {
    const mod = await import('./user-settings.js');
    rmSync(mod.USER_SETTINGS_PATH, { force: true });
    mod._resetUserSettingsCache();
    await mod.readUserSettings();
  });

  it('parses the additive fields and treats them as optional (legacy files load)', () => {
    const parsed = userSettingsSchema.parse({
      ...DEFAULT_USER_SETTINGS,
      lastSeenAppVersion: '1.5.1',
      showWhatsNew: true,
      schemaVersion: 1,
    });
    expect(parsed.lastSeenAppVersion).toBe('1.5.1');
    expect(parsed.showWhatsNew).toBe(true);
    // Absent on a fresh document (no migration needed for old files).
    expect(userSettingsSchema.parse(DEFAULT_USER_SETTINGS).lastSeenAppVersion).toBeUndefined();
  });

  it('writeUpgradeMeta persists the version + banner flag and reads them back', async () => {
    const mod = await import('./user-settings.js');
    await mod.writeUpgradeMeta({ lastSeenAppVersion: '1.6.0', showWhatsNew: true });
    mod._resetUserSettingsCache();
    const reread = await mod.readUserSettings();
    expect(reread.lastSeenAppVersion).toBe('1.6.0');
    expect(reread.showWhatsNew).toBe(true);
  });

  it('the general PUT path STRIPS the upgrade fields (only writeUpgradeMeta may set them)', async () => {
    const mod = await import('./user-settings.js');
    await mod.writeUpgradeMeta({ lastSeenAppVersion: '1.6.0', showWhatsNew: true });
    // A client PUT trying to forge these must be ignored.
    const after = await mod.writeUserSettings({
      displayName: 'Tamperer',
      lastSeenAppVersion: '9.9.9',
      showWhatsNew: false,
    } as unknown);
    expect(after.displayName).toBe('Tamperer'); // legit field applied
    expect(after.lastSeenAppVersion).toBe('1.6.0'); // forged field stripped
    expect(after.showWhatsNew).toBe(true);
  });
});
