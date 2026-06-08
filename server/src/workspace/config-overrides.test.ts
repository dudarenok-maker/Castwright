import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('configOverrides store', () => {
  beforeEach(() => {
    vi.resetModules();
    delete process.env.GEN_WORKERS;
    const dir = mkdtempSync(join(tmpdir(), 'cw-cfg-'));
    process.env.USER_SETTINGS_FILE = join(dir, 'user-settings.json');
    writeFileSync(process.env.USER_SETTINGS_FILE, '{}');
  });

  it('writes and reads a sparse override', async () => {
    const m = await import('./user-settings.js');
    await m.writeConfigOverride('analyzer.stage2.minCoverage', 0.55);
    expect(m.readConfigOverrides()['analyzer.stage2.minCoverage']).toBe(0.55);
  });

  it('clearConfigOverride removes only that key', async () => {
    const m = await import('./user-settings.js');
    await m.writeConfigOverride('a.b', 1);
    await m.writeConfigOverride('c.d', 2);
    await m.clearConfigOverride('a.b');
    const all = m.readConfigOverrides();
    expect(all['a.b']).toBeUndefined();
    expect(all['c.d']).toBe(2);
  });

  it('clearAllConfigOverrides empties the map', async () => {
    const m = await import('./user-settings.js');
    await m.writeConfigOverride('a.b', 1);
    await m.clearAllConfigOverrides();
    expect(m.readConfigOverrides()).toEqual({});
  });

  it('getResolvedGenerationWorkers honours a tts.gen.workers override', async () => {
    const m = await import('./user-settings.js');
    expect(m.getResolvedGenerationWorkers()).toBe(1); // shipped default
    await m.writeConfigOverride('tts.gen.workers', 3);
    expect(m.getResolvedGenerationWorkers()).toBe(3);
  });
});
