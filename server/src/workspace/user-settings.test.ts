/* Tight schema tests for the user-settings document — pins plan 40's
   coverPickerDefaultTab field across schema parse, write+read round-trip,
   and legacy-file back-compat. */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import {
  DEFAULT_USER_SETTINGS,
  userSettingsSchema,
  getResolvedAutoStartSidecar,
  getResolvedGenerationWorkers,
  getResolvedAnalysisEngine,
  getResolvedAllowCloudFallback,
  getResolvedSidecarUrl,
  resolveUserSettingsPath,
  migrateLegacyUserSettings,
  _resetUserSettingsCache,
  _setUserSettingsCacheForTest,
  _setExplicitlySetKeysForTest,
} from './user-settings.js';

let workspaceRoot: string;

beforeEach(() => {
  workspaceRoot = mkdtempSync(join(tmpdir(), 'user-settings-test-'));
  process.env.WORKSPACE_DIR = workspaceRoot;
});

afterEach(() => {
  if (workspaceRoot) rmSync(workspaceRoot, { recursive: true, force: true });
  delete process.env.WORKSPACE_DIR;
  delete process.env.LOCAL_TTS_PORT;
  delete process.env.LOCAL_TTS_URL;
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

describe('analysisEngine default + resolution (Part 0 — local-by-default)', () => {
  beforeEach(() => {
    _resetUserSettingsCache();
    delete process.env.ANALYZER;
  });

  afterEach(() => {
    _resetUserSettingsCache();
    delete process.env.ANALYZER;
  });

  it('DEFAULT_USER_SETTINGS defaults the engine to local (was gemini)', () => {
    expect(DEFAULT_USER_SETTINGS.analysisEngine).toBe('local');
  });

  it('DEFAULT_USER_SETTINGS defaults the analysis model to a local Ollama id, in lockstep with the engine', () => {
    expect(DEFAULT_USER_SETTINGS.defaultAnalysisModel).toBe('qwen3.5:4b');
    /* Ollama-tag shape (contains ':') so getResolvedOllamaModel keeps it and
       engineForModelId derives 'local' — the two must never disagree. */
    expect(DEFAULT_USER_SETTINGS.defaultAnalysisModel).toContain(':');
  });

  it('a legacy file MISSING analysisEngine backfills to local via DEFAULT', () => {
    const { analysisEngine: _drop, ...legacy } = DEFAULT_USER_SETTINGS;
    const parsed = userSettingsSchema.parse({ ...DEFAULT_USER_SETTINGS, ...legacy });
    expect(parsed.analysisEngine).toBe('local');
  });

  it('a corrupt analysisEngine value → all-DEFAULT (local), never gemini', async () => {
    const mod = await import('./user-settings.js');
    mod._resetUserSettingsCache();
    writeFileSync(
      mod.USER_SETTINGS_PATH,
      JSON.stringify({ ...DEFAULT_USER_SETTINGS, analysisEngine: 'cloud' }),
    );
    try {
      const settings = await mod.readUserSettings();
      expect(settings.analysisEngine).toBe('local');
    } finally {
      writeFileSync(mod.USER_SETTINGS_PATH, JSON.stringify(DEFAULT_USER_SETTINGS));
      mod._resetUserSettingsCache();
    }
  });

  it('getResolvedAnalysisEngine returns local on a cold cache', () => {
    expect(getResolvedAnalysisEngine()).toBe('local');
  });

  it('getResolvedAnalysisEngine returns the cached saved engine (gemini)', () => {
    _setUserSettingsCacheForTest({ analysisEngine: 'gemini' });
    expect(getResolvedAnalysisEngine()).toBe('gemini');
  });

  it('ANALYZER env no longer selects the engine — a saved local wins over ANALYZER=gemini', () => {
    _setUserSettingsCacheForTest({ analysisEngine: 'local' });
    process.env.ANALYZER = 'gemini';
    expect(getResolvedAnalysisEngine()).toBe('local');
  });

  it('ANALYZER=gemini in env is inert on a cold cache too (env retired) → local', () => {
    process.env.ANALYZER = 'gemini';
    expect(getResolvedAnalysisEngine()).toBe('local');
  });
});

describe('allowCloudFallback (Part 1 — opt-out cloud fallback gate)', () => {
  beforeEach(() => {
    _resetUserSettingsCache();
    delete process.env.ANALYZER_ALLOW_CLOUD_FALLBACK;
  });

  afterEach(() => {
    _resetUserSettingsCache();
    delete process.env.ANALYZER_ALLOW_CLOUD_FALLBACK;
  });

  it('defaults to true on a fresh user-settings document (non-breaking opt-out)', () => {
    expect(DEFAULT_USER_SETTINGS.allowCloudFallback).toBe(true);
  });

  it('a legacy file missing the field parses to true via the zod default', () => {
    const { allowCloudFallback: _drop, ...legacy } = DEFAULT_USER_SETTINGS;
    const parsed = userSettingsSchema.parse(legacy);
    expect(parsed.allowCloudFallback).toBe(true);
  });

  it('accepts an explicit false (strict-local opt-out)', () => {
    const parsed = userSettingsSchema.parse({ ...DEFAULT_USER_SETTINGS, allowCloudFallback: false });
    expect(parsed.allowCloudFallback).toBe(false);
  });

  it('getResolvedAllowCloudFallback returns true on a cold cache', () => {
    expect(getResolvedAllowCloudFallback()).toBe(true);
  });

  it('a saved false wins over the default', () => {
    _setUserSettingsCacheForTest({ allowCloudFallback: false });
    expect(getResolvedAllowCloudFallback()).toBe(false);
  });

  it('ANALYZER_ALLOW_CLOUD_FALLBACK=0 is a PRE-CACHE under-ride that forces off', () => {
    process.env.ANALYZER_ALLOW_CLOUD_FALLBACK = '0';
    expect(getResolvedAllowCloudFallback()).toBe(false);
  });

  it('a saved value (true) wins over the env under-ride once the cache is warm', () => {
    _setUserSettingsCacheForTest({ allowCloudFallback: true });
    process.env.ANALYZER_ALLOW_CLOUD_FALLBACK = '0';
    expect(getResolvedAllowCloudFallback()).toBe(true);
  });

  it('the env under-ride can never force the gate ON (values other than "0" are inert)', () => {
    process.env.ANALYZER_ALLOW_CLOUD_FALLBACK = '1';
    expect(getResolvedAllowCloudFallback()).toBe(true); // already true by default; not "forced"
    _setUserSettingsCacheForTest({ allowCloudFallback: false });
    expect(getResolvedAllowCloudFallback()).toBe(false); // saved off stays off
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

describe('userSettingsSchema — retired eagerLoadKokoro/eagerLoadQwen (preload-toggle dedup)', () => {
  it('no longer appears on DEFAULT_USER_SETTINGS or a fresh parse', () => {
    expect(DEFAULT_USER_SETTINGS).not.toHaveProperty('eagerLoadKokoro');
    expect(DEFAULT_USER_SETTINGS).not.toHaveProperty('eagerLoadQwen');
    const parsed = userSettingsSchema.parse({
      ...DEFAULT_USER_SETTINGS,
      eagerLoadKokoro: false,
      eagerLoadQwen: false,
    });
    expect(parsed).not.toHaveProperty('eagerLoadKokoro');
    expect(parsed).not.toHaveProperty('eagerLoadQwen');
  });

  it('migrates a legacy Qwen-default settings file into tts.preload.* configOverrides on read, and strips the legacy fields from disk', async () => {
    const mod = await import('./user-settings.js');
    mod._resetUserSettingsCache();
    writeFileSync(
      mod.USER_SETTINGS_PATH,
      JSON.stringify({
        ...DEFAULT_USER_SETTINGS,
        defaultTtsModelKey: 'qwen3-tts-0.6b',
        eagerLoadKokoro: true,
        eagerLoadQwen: false,
      }),
    );
    try {
      const settings = await mod.readUserSettings();
      // Old semantics: Qwen is the resolved default → Kokoro/1.7B-Base were
      // always forced lazy regardless of eagerLoadKokoro; eagerLoadQwen:false
      // governed the 0.6B tier directly.
      expect(settings.configOverrides['tts.preload.kokoro']).toBe(false);
      expect(settings.configOverrides['tts.preload.qwen']).toBe(false);
      expect(settings.configOverrides['tts.preload.qwenBase17']).toBe(false);
      expect(settings).not.toHaveProperty('eagerLoadKokoro');
      expect(settings).not.toHaveProperty('eagerLoadQwen');

      const onDisk = JSON.parse(readFileSync(mod.USER_SETTINGS_PATH, 'utf8'));
      expect(onDisk).not.toHaveProperty('eagerLoadKokoro');
      expect(onDisk).not.toHaveProperty('eagerLoadQwen');
    } finally {
      writeFileSync(mod.USER_SETTINGS_PATH, JSON.stringify(DEFAULT_USER_SETTINGS));
      mod._resetUserSettingsCache();
    }
  });

  it('does not clobber a configOverride the user already set explicitly', async () => {
    const mod = await import('./user-settings.js');
    mod._resetUserSettingsCache();
    writeFileSync(
      mod.USER_SETTINGS_PATH,
      JSON.stringify({
        ...DEFAULT_USER_SETTINGS,
        defaultTtsModelKey: 'kokoro-v1',
        eagerLoadKokoro: false, // legacy value says "off"
        configOverrides: { 'tts.preload.kokoro': true }, // real Advanced Settings choice says "on"
      }),
    );
    try {
      const settings = await mod.readUserSettings();
      expect(settings.configOverrides['tts.preload.kokoro']).toBe(true);
    } finally {
      writeFileSync(mod.USER_SETTINGS_PATH, JSON.stringify(DEFAULT_USER_SETTINGS));
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

describe('per-engine install-state store (fs-38 Wave 3c Task 19)', () => {
  beforeEach(async () => {
    const mod = await import('./user-settings.js');
    mod._resetUserSettingsCache();
  });

  it('a coqui-uninstalled state is observable through the same shape as the qwen one', async () => {
    const mod = await import('./user-settings.js');
    /* Starts 'not-installed' for both engines, same as qwen's documented
       cold-boot default — never optimistically claim either engine usable
       before the first probe/poll. */
    expect(mod.getLastKnownCoquiInstallState()).toBe('not-installed');
    mod.setLastKnownCoquiInstallState('weights-missing');
    expect(mod.getLastKnownCoquiInstallState()).toBe('weights-missing');
    mod.setLastKnownCoquiInstallState('ready');
    expect(mod.getLastKnownCoquiInstallState()).toBe('ready');
    mod.setLastKnownCoquiInstallState('loaded');
    expect(mod.getLastKnownCoquiInstallState()).toBe('loaded');
  });

  it('the generic per-engine lookup and the qwen/coqui-named wrappers read/write the SAME store (no duplicated bespoke function)', async () => {
    const mod = await import('./user-settings.js');
    mod.setLastKnownEngineInstallState('coqui', 'ready');
    expect(mod.getLastKnownCoquiInstallState()).toBe('ready');
    mod.setLastKnownCoquiInstallState('weights-missing');
    expect(mod.getLastKnownEngineInstallState('coqui')).toBe('weights-missing');

    mod.setLastKnownEngineInstallState('qwen', 'loaded');
    expect(mod.getLastKnownQwenInstallState()).toBe('loaded');
    mod.setLastKnownQwenInstallState('not-installed');
    expect(mod.getLastKnownEngineInstallState('qwen')).toBe('not-installed');
  });

  it('qwen and coqui install-state are independent — setting one never touches the other', async () => {
    const mod = await import('./user-settings.js');
    mod.setLastKnownQwenInstallState('loaded');
    mod.setLastKnownCoquiInstallState('not-installed');
    expect(mod.getLastKnownQwenInstallState()).toBe('loaded');
    expect(mod.getLastKnownCoquiInstallState()).toBe('not-installed');

    mod.setLastKnownCoquiInstallState('ready');
    expect(mod.getLastKnownQwenInstallState()).toBe('loaded');
    expect(mod.getLastKnownCoquiInstallState()).toBe('ready');
  });

  it('the qwen call sites behave identically to before — getResolvedTtsModelKey still only reads the qwen slot of the shared store, unaffected by coqui', async () => {
    const mod = await import('./user-settings.js');
    rmSync(mod.USER_SETTINGS_PATH, { force: true });
    mod._resetUserSettingsCache();
    await mod.readUserSettings();
    /* Coqui 'loaded' must NOT flip the default to Qwen — only the qwen slot
       drives getResolvedTtsModelKey (this is the regression guard: the
       generalization must not let the two engines' state cross-contaminate
       the pre-existing Qwen-only resolution rule). */
    mod.setLastKnownCoquiInstallState('loaded');
    expect(mod.getResolvedTtsModelKey()).toBe('kokoro-v1');
    mod.setLastKnownQwenInstallState('ready');
    expect(mod.getResolvedTtsModelKey()).toBe('qwen3-tts-0.6b');
  });

  it('_resetUserSettingsCache resets BOTH engines to not-installed', async () => {
    const mod = await import('./user-settings.js');
    mod.setLastKnownQwenInstallState('loaded');
    mod.setLastKnownCoquiInstallState('ready');
    mod._resetUserSettingsCache();
    expect(mod.getLastKnownQwenInstallState()).toBe('not-installed');
    expect(mod.getLastKnownCoquiInstallState()).toBe('not-installed');
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

describe('tourCompletedAt (guided tour)', () => {
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

  it('getResolvedTourCompletedAt is null before any write', async () => {
    const { getResolvedTourCompletedAt } = await import('./user-settings.js');
    expect(getResolvedTourCompletedAt()).toBeNull();
  });

  it('writeTourCompletedAt persists and the getter reflects it', async () => {
    const { writeTourCompletedAt, getResolvedTourCompletedAt } = await import('./user-settings.js');
    await writeTourCompletedAt('2026-06-12T00:00:00.000Z');
    expect(getResolvedTourCompletedAt()).toBe('2026-06-12T00:00:00.000Z');
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

describe('analyzerKeepAliveByModel', () => {
  it('defaults to an empty object when absent', () => {
    const parsed = userSettingsSchema.parse({ ...DEFAULT_USER_SETTINGS });
    expect(parsed.analyzerKeepAliveByModel).toEqual({});
  });
  it('accepts a sparse integer map', () => {
    const parsed = userSettingsSchema.parse({
      ...DEFAULT_USER_SETTINGS,
      analyzerKeepAliveByModel: { 'qwen36-castwright:latest': 300, 'foo:bar': 0 },
    });
    expect(parsed.analyzerKeepAliveByModel['qwen36-castwright:latest']).toBe(300);
  });
  it('rejects a non-integer keep-alive', () => {
    expect(() =>
      userSettingsSchema.parse({
        ...DEFAULT_USER_SETTINGS,
        analyzerKeepAliveByModel: { 'foo:bar': 1.5 },
      }),
    ).toThrow();
  });
  it('is present in DEFAULT_USER_SETTINGS', () => {
    expect(DEFAULT_USER_SETTINGS.analyzerKeepAliveByModel).toEqual({});
  });

  it('survives a targeted save of an UNRELATED field (partial-patch default-clobber regression)', async () => {
    const mod = await import('./user-settings.js');
    mod._resetUserSettingsCache();
    try {
      // 1. Save a per-model keep-alive override.
      await mod.writeUserSettings({
        analyzerKeepAliveByModel: { 'qwen36-cw-iq4-32k:latest': 90 },
      });
      // 2. Save an UNRELATED field with NO keep-alive key — mirrors the
      //    analysing-screen phase-model dropdown (saves just analyzerPhase0Model).
      //    Before the fix, patchSchema (userSettingsSchema.partial()) applied
      //    analyzerKeepAliveByModel's `.default({})` and the wholesale merge
      //    wiped the saved 90 back to {}.
      const after = await mod.writeUserSettings({ analyzerPhase0Model: 'qwen3.5:4b' });
      expect(after.analyzerKeepAliveByModel).toEqual({ 'qwen36-cw-iq4-32k:latest': 90 });
      expect(after.analyzerPhase0Model).toBe('qwen3.5:4b');
      // 3. And it survives a reload from disk (not just the in-memory cache).
      mod._resetUserSettingsCache();
      const reread = await mod.readUserSettings();
      expect(reread.analyzerKeepAliveByModel).toEqual({ 'qwen36-cw-iq4-32k:latest': 90 });
    } finally {
      await mod.writeUserSettings({ analyzerKeepAliveByModel: {}, analyzerPhase0Model: null });
      mod._resetUserSettingsCache();
    }
  });
});

describe('getResolvedSidecarUrl — port resolution (#2632)', () => {
  beforeEach(() => {
    _resetUserSettingsCache();
    delete process.env.LOCAL_TTS_URL;
    delete process.env.LOCAL_TTS_PORT;
  });

  afterEach(() => {
    _resetUserSettingsCache();
    delete process.env.LOCAL_TTS_URL;
    delete process.env.LOCAL_TTS_PORT;
  });

  it('returns the default 127.0.0.1:9000 when nothing is set', () => {
    expect(getResolvedSidecarUrl()).toBe('http://127.0.0.1:9000');
  });

  it('resolves sidecar port from LOCAL_TTS_PORT when no explicit URL is configured (#2632)', () => {
    // Simulates a worktree with LOCAL_TTS_PORT=9110 but no explicit sidecarUrl user setting
    process.env.LOCAL_TTS_PORT = '9110';
    // Cache has default sidecarUrl because user never customized it
    _setUserSettingsCacheForTest({ ...DEFAULT_USER_SETTINGS });

    expect(getResolvedSidecarUrl()).toBe('http://127.0.0.1:9110');
  });

  it('prioritizes LOCAL_TTS_URL env var over LOCAL_TTS_PORT', () => {
    process.env.LOCAL_TTS_PORT = '9110';
    process.env.LOCAL_TTS_URL = 'http://localhost:9999';
    _setUserSettingsCacheForTest({ ...DEFAULT_USER_SETTINGS });

    expect(getResolvedSidecarUrl()).toBe('http://localhost:9999');
  });

  it('prioritizes explicit user sidecarUrl over LOCAL_TTS_PORT', () => {
    process.env.LOCAL_TTS_PORT = '9110';
    _setUserSettingsCacheForTest({ ...DEFAULT_USER_SETTINGS, sidecarUrl: 'http://localhost:9888' });
    // Mark sidecarUrl as explicitly set (was in the file)
    _setExplicitlySetKeysForTest(new Set(['sidecarUrl']));

    expect(getResolvedSidecarUrl()).toBe('http://localhost:9888');
  });

  it('still enforces srv-21 SSRF guard but derives from LOCAL_TTS_PORT on reject', () => {
    process.env.LOCAL_TTS_PORT = '9110';
    // Invalid: non-loopback URL in LOCAL_TTS_URL is rejected by srv-21
    process.env.LOCAL_TTS_URL = 'http://evil.example.com:9110';
    _setUserSettingsCacheForTest({ ...DEFAULT_USER_SETTINGS });

    // Rejects the evil URL, then derives from LOCAL_TTS_PORT (#2632)
    expect(getResolvedSidecarUrl()).toBe('http://127.0.0.1:9110');
  });

  it('prioritizes customised sidecarUrl over LOCAL_TTS_URL (per openapi.yaml:4539)', () => {
    process.env.LOCAL_TTS_URL = 'http://localhost:9999';
    // User explicitly set a different URL via the UI
    _setUserSettingsCacheForTest({ ...DEFAULT_USER_SETTINGS, sidecarUrl: 'http://192.168.1.20:9000' });
    // Mark sidecarUrl as explicitly set (was in the file)
    _setExplicitlySetKeysForTest(new Set(['sidecarUrl']));

    // User's explicit URL wins over the env var (documented API contract)
    expect(getResolvedSidecarUrl()).toBe('http://192.168.1.20:9000');
  });

  // N1: DEFAULT-valued LOCAL_TTS_URL should not shadow port derivation
  it('N1: treats DEFAULT-valued LOCAL_TTS_URL as non-choice, lets port derivation win', () => {
    // Pre-existing server/.env has DEFAULT value, which should not shadow port derivation
    process.env.LOCAL_TTS_PORT = '9110';
    process.env.LOCAL_TTS_URL = 'http://localhost:9000'; // Factory default value
    _setUserSettingsCacheForTest({ ...DEFAULT_USER_SETTINGS });

    // The DEFAULT-valued env var does not beat the port derivation
    expect(getResolvedSidecarUrl()).toBe('http://127.0.0.1:9110');
  });

  it('N1: non-default LOCAL_TTS_URL still beats port derivation', () => {
    process.env.LOCAL_TTS_PORT = '9110';
    // Non-default value — an explicit choice in .env
    process.env.LOCAL_TTS_URL = 'http://192.168.1.20:9000';
    _setUserSettingsCacheForTest({ ...DEFAULT_USER_SETTINGS });

    // Non-default URL is a real choice and wins
    expect(getResolvedSidecarUrl()).toBe('http://192.168.1.20:9000');
  });

  // N21: a trailing slash or a case change on the factory-default LOCAL_TTS_URL
  // must still be treated as a non-choice — otherwise it beats port derivation
  // and the server spawns its own sidecar on LOCAL_TTS_PORT while talking to
  // whatever else holds :9000 (the exact split #2632/N1 exists to prevent).
  it('N21: trailing-slash factory-default LOCAL_TTS_URL is still a non-choice', () => {
    process.env.LOCAL_TTS_PORT = '9110';
    process.env.LOCAL_TTS_URL = 'http://localhost:9000/';
    _setUserSettingsCacheForTest({ ...DEFAULT_USER_SETTINGS });

    expect(getResolvedSidecarUrl()).toBe('http://127.0.0.1:9110');
  });

  it('N21: case-varied factory-default LOCAL_TTS_URL is still a non-choice', () => {
    process.env.LOCAL_TTS_PORT = '9110';
    process.env.LOCAL_TTS_URL = 'http://LOCALHOST:9000';
    _setUserSettingsCacheForTest({ ...DEFAULT_USER_SETTINGS });

    expect(getResolvedSidecarUrl()).toBe('http://127.0.0.1:9110');
  });

  it('N21: trailing-slash factory-default sidecarUrl setting is still a non-choice', () => {
    process.env.LOCAL_TTS_PORT = '9110';
    _setUserSettingsCacheForTest({ ...DEFAULT_USER_SETTINGS, sidecarUrl: 'http://localhost:9000/' });
    _setExplicitlySetKeysForTest(new Set(['sidecarUrl']));

    expect(getResolvedSidecarUrl()).toBe('http://127.0.0.1:9110');
  });

  it('N21: case-varied factory-default sidecarUrl setting is still a non-choice', () => {
    process.env.LOCAL_TTS_PORT = '9110';
    _setUserSettingsCacheForTest({ ...DEFAULT_USER_SETTINGS, sidecarUrl: 'http://LOCALHOST:9000' });
    _setExplicitlySetKeysForTest(new Set(['sidecarUrl']));

    expect(getResolvedSidecarUrl()).toBe('http://127.0.0.1:9110');
  });

  // N2/B3: sidecarUrl requires BOTH key-present AND value-different (not just key-present)
  it('B3 regression: sidecarUrl at factory default (written by unrelated writer) loses to port derivation', () => {
    // Reproduces B3: an unrelated writer (e.g., writeSetupCompletedAt) writes the complete merged
    // object, including sidecarUrl at factory default. Key-presence alone would wrongly claim "user chose this".
    // Requires BOTH key-present AND value-different to correctly read as unset.
    process.env.LOCAL_TTS_PORT = '9110';

    // Simulate file that has sidecarUrl at factory default (as written by unrelated writer)
    _setUserSettingsCacheForTest({ ...DEFAULT_USER_SETTINGS });
    _setExplicitlySetKeysForTest(new Set(['sidecarUrl'])); // Key IS in the file

    // Key present at default value should lose to port derivation (B3 fix requires both conditions)
    expect(getResolvedSidecarUrl()).toBe('http://127.0.0.1:9110');
  });

  it('N2: uses sidecarUrl when value differs from factory default and key is present', () => {
    // User explicitly set sidecarUrl to a custom value in their settings file.
    // Key-present AND value-different → use it.
    process.env.LOCAL_TTS_PORT = '9110';

    // Simulate file that has sidecarUrl at custom value
    const customUrl = 'http://192.168.1.20:9000';
    _setUserSettingsCacheForTest({ ...DEFAULT_USER_SETTINGS, sidecarUrl: customUrl });
    _setExplicitlySetKeysForTest(new Set(['sidecarUrl'])); // Key IS in the file

    // Key present with non-default value should win
    expect(getResolvedSidecarUrl()).toBe(customUrl);
  });

  // N8: the four tests above hand-set explicitlySetKeys directly — they never
  // call readUserSettings(), so they exercise the FLAG, not the mechanism that
  // populates it from a real file. These two go through the real read path:
  // write a settings file to disk, call readUserSettings(), then resolve.
  it('B3 regression (live path): sidecarUrl written by an UNRELATED writer at factory default loses to LOCAL_TTS_PORT', async () => {
    const mod = await import('./user-settings.js');
    mod._resetUserSettingsCache();
    // This is the real shape of ~/.castwright/user-settings.json on a box
    // that has completed onboarding: setupCompletedAt/tourCompletedAt were
    // written by writeSetupCompletedAt/writeTourCompletedAt, which persist
    // the FULL merged object — including sidecarUrl at its factory default,
    // even though no one ever chose that value. #2632 B3.
    writeFileSync(
      mod.USER_SETTINGS_PATH,
      JSON.stringify({
        ...DEFAULT_USER_SETTINGS,
        setupCompletedAt: '2026-01-01T00:00:00.000Z',
        tourCompletedAt: '2026-01-01T00:00:00.000Z',
        sidecarUrl: DEFAULT_USER_SETTINGS.sidecarUrl,
      }),
    );
    try {
      process.env.LOCAL_TTS_PORT = '9110';
      await mod.readUserSettings(); // real path: populates explicitlySetKeys from disk
      expect(mod.getResolvedSidecarUrl()).toBe('http://127.0.0.1:9110');
    } finally {
      writeFileSync(mod.USER_SETTINGS_PATH, JSON.stringify(DEFAULT_USER_SETTINGS));
      mod._resetUserSettingsCache();
    }
  });

  it('live path: a genuinely user-chosen non-default sidecarUrl still wins over LOCAL_TTS_PORT', async () => {
    const mod = await import('./user-settings.js');
    mod._resetUserSettingsCache();
    const customUrl = 'http://192.168.1.20:9000';
    writeFileSync(
      mod.USER_SETTINGS_PATH,
      JSON.stringify({
        ...DEFAULT_USER_SETTINGS,
        setupCompletedAt: '2026-01-01T00:00:00.000Z',
        tourCompletedAt: '2026-01-01T00:00:00.000Z',
        sidecarUrl: customUrl,
      }),
    );
    try {
      process.env.LOCAL_TTS_PORT = '9110';
      await mod.readUserSettings();
      expect(mod.getResolvedSidecarUrl()).toBe(customUrl);
    } finally {
      writeFileSync(mod.USER_SETTINGS_PATH, JSON.stringify(DEFAULT_USER_SETTINGS));
      mod._resetUserSettingsCache();
    }
  });

  // N19: the two srv-21 rejection sites (user-settings sidecarUrl, LOCAL_TTS_URL)
  // used to share one dedupe variable, so an identical rejected value on both
  // sources latched the first site's warning and silently suppressed the second's.
  it('N19: an identical rejected non-private value on BOTH sidecarUrl and LOCAL_TTS_URL warns for both sources, not just the first', () => {
    const evilUrl = 'http://evil.example.com:9000';
    process.env.LOCAL_TTS_PORT = '9110';
    process.env.LOCAL_TTS_URL = evilUrl;
    _setUserSettingsCacheForTest({ ...DEFAULT_USER_SETTINGS, sidecarUrl: evilUrl });
    _setExplicitlySetKeysForTest(new Set(['sidecarUrl']));

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(getResolvedSidecarUrl()).toBe('http://127.0.0.1:9110');
      const messages = warnSpy.mock.calls.map((call) => String(call[0]));
      expect(messages.some((m) => m.includes('from user settings'))).toBe(true);
      expect(messages.some((m) => m.includes('from LOCAL_TTS_URL'))).toBe(true);
    } finally {
      warnSpy.mockRestore();
    }
  });

  // N26: _resetUserSettingsCache() must clear BOTH srv-21 warn-dedup latches,
  // or a rejected value that was already warned about in an earlier test (or
  // an earlier call in the same test) silently gets zero warnings after a
  // reset — a suppressed-warning bug that would read as a passing dedupe test.
  it('N26: _resetUserSettingsCache() clears both warn-dedup latches so a repeated rejected value warns again', () => {
    const evilUrl = 'http://evil.example.com:9000';
    process.env.LOCAL_TTS_PORT = '9110';
    process.env.LOCAL_TTS_URL = evilUrl;
    _setUserSettingsCacheForTest({ ...DEFAULT_USER_SETTINGS, sidecarUrl: evilUrl });
    _setExplicitlySetKeysForTest(new Set(['sidecarUrl']));

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      // First resolution latches both dedupe variables and warns for both sources.
      expect(getResolvedSidecarUrl()).toBe('http://127.0.0.1:9110');
      expect(warnSpy).toHaveBeenCalledTimes(2);
      warnSpy.mockClear();

      // Without a reset, the identical rejected value would warn zero more
      // times here (that's the dedupe working as intended, not this bug).
      // A reset should behave as if nothing was ever latched.
      _resetUserSettingsCache();
      _setUserSettingsCacheForTest({ ...DEFAULT_USER_SETTINGS, sidecarUrl: evilUrl });
      _setExplicitlySetKeysForTest(new Set(['sidecarUrl']));

      expect(getResolvedSidecarUrl()).toBe('http://127.0.0.1:9110');
      const messages = warnSpy.mock.calls.map((call) => String(call[0]));
      expect(messages.some((m) => m.includes('from user settings'))).toBe(true);
      expect(messages.some((m) => m.includes('from LOCAL_TTS_URL'))).toBe(true);
    } finally {
      warnSpy.mockRestore();
    }
  });
});
