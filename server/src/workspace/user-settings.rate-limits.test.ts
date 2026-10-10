/* #3084 W3 — analyzerRateLimitsByModel persistence and the one-time migration of the
   retired rate.*.gemma* config overrides. Fresh module + temp settings file per test,
   the same isolation #3163's rate-limit test used. */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

async function freshSettingsModule(initial: unknown) {
  vi.resetModules();
  const dir = mkdtempSync(join(tmpdir(), 'cw-ratemap-'));
  const file = join(dir, 'user-settings.json');
  process.env.USER_SETTINGS_FILE = file;
  writeFileSync(file, JSON.stringify(initial));
  const ws = await import('./user-settings.js');
  return { ws, file };
}

afterEach(() => {
  delete process.env.USER_SETTINGS_FILE;
});

describe('analyzerRateLimitsByModel persistence (#3084)', () => {
  it('migrates saved rate.*.gemma* config overrides into the map and strips them from disk', async () => {
    const { ws, file } = await freshSettingsModule({
      configOverrides: { 'rate.rpm.gemma': 12, 'rate.tpm.gemma26': 0, 'analyzer.ollama.numCtx': 16384 },
    });
    const s = await ws.readUserSettings();
    expect(s.analyzerRateLimitsByModel).toEqual({
      'gemma-4-31b-it': { rpm: 12 },
      'gemma-4-26b-a4b-it': { tpm: 0 },
    });
    expect(s.configOverrides).toEqual({ 'analyzer.ollama.numCtx': 16384 });
    const onDisk = JSON.parse(readFileSync(file, 'utf8'));
    expect(onDisk.configOverrides['rate.rpm.gemma']).toBeUndefined();
    expect(onDisk.analyzerRateLimitsByModel['gemma-4-31b-it']).toEqual({ rpm: 12 });
  });

  it('a value already in the map wins over a legacy override for the same field', async () => {
    const { ws } = await freshSettingsModule({
      configOverrides: { 'rate.rpm.gemma': 12 },
      analyzerRateLimitsByModel: { 'gemma-4-31b-it': { rpm: 3 } },
    });
    expect((await ws.readUserSettings()).analyzerRateLimitsByModel['gemma-4-31b-it']).toEqual({ rpm: 3 });
  });

  it('a malformed saved override is dropped without resetting any other setting (P8)', async () => {
    const { ws, file } = await freshSettingsModule({
      defaultAnalysisModel: 'mistral:7b',
      configOverrides: { 'rate.rpm.gemma': -3, 'rate.tpm.gemma': 'fast', 'rate.rpd.gemma': 2.5, 'rate.rpm.gemma26': 0, 'rate.tpm.gemma26': 0 },
    });
    const s = await ws.readUserSettings();
    expect(s.defaultAnalysisModel).toBe('mistral:7b');
    expect(s.analyzerRateLimitsByModel).toEqual({ 'gemma-4-26b-a4b-it': { tpm: 0 } });
    expect(s.configOverrides).toEqual({});
    expect(JSON.parse(readFileSync(file, 'utf8')).defaultAnalysisModel).toBe('mistral:7b');
  });

  it('an override above 2^53 is dropped without resetting any other setting (P8: Number.isSafeInteger)', async () => {
    const unsafe = 2 ** 53 + 2; // an integer to Number.isInteger, not a safe integer
    const { ws, file } = await freshSettingsModule({
      defaultAnalysisModel: 'mistral:7b',
      configOverrides: { 'rate.rpd.gemma': unsafe },
    });
    const s = await ws.readUserSettings();
    expect(s.defaultAnalysisModel).toBe('mistral:7b');
    expect(s.analyzerRateLimitsByModel).toEqual({});
    expect(s.configOverrides).toEqual({});
    expect(JSON.parse(readFileSync(file, 'utf8')).defaultAnalysisModel).toBe('mistral:7b');
  });

  it('never throws on a shape it does not recognise, and leaves it for the schema (P8)', async () => {
    const { ws } = await freshSettingsModule({});
    for (const raw of [null, 'x', 42, [], { configOverrides: 'x' }, { configOverrides: 7 }, { configOverrides: null }, { configOverrides: [] }]) {
      expect(ws.migrateLegacyRateLimitOverrides(raw)).toBe(raw);
    }
    const brokenMap = { configOverrides: { 'rate.rpm.gemma': 12 }, analyzerRateLimitsByModel: 'broken' };
    expect(ws.migrateLegacyRateLimitOverrides(brokenMap)).toEqual({ configOverrides: {}, analyzerRateLimitsByModel: 'broken' });
    const brokenEntry = { configOverrides: { 'rate.rpm.gemma': 12 }, analyzerRateLimitsByModel: { 'gemma-4-31b-it': 'broken' } };
    expect(ws.migrateLegacyRateLimitOverrides(brokenEntry)).toEqual({ configOverrides: {}, analyzerRateLimitsByModel: { 'gemma-4-31b-it': 'broken' } });
  });

  it('the general PUT replaces the whole map (a model omitted from the patch is removed)', async () => {
    const { ws } = await freshSettingsModule({});
    await ws.writeUserSettings({
      analyzerRateLimitsByModel: { 'gemini-3.6-flash': { rpm: 2 }, 'openai:lab::m': { rpd: 100 } },
    });
    const after = await ws.writeUserSettings({ analyzerRateLimitsByModel: { 'openai:lab::m': { rpd: 50 } } });
    expect(after.analyzerRateLimitsByModel).toEqual({ 'openai:lab::m': { rpd: 50 } });
  });

  it('rejects an rpm below 1 and unknown fields', async () => {
    const { ws } = await freshSettingsModule({});
    await expect(ws.writeUserSettings({ analyzerRateLimitsByModel: { m: { rpm: 0 } } })).rejects.toThrow();
    await expect(ws.writeUserSettings({ analyzerRateLimitsByModel: { m: { burst: 3 } } })).rejects.toThrow();
  });
});
