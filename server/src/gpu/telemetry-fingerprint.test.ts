import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { mkdir, rm, writeFile, readFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let fp: typeof import('./telemetry-fingerprint.js');
let stats: typeof import('../analyzer/model-vram-stats.js');
let telemetryDir: () => string;
beforeAll(async () => {
  process.env.WORKSPACE_DIR = mkdtempSync(join(tmpdir(), 'vram-fp-'));
  fp = await import('./telemetry-fingerprint.js');
  stats = await import('../analyzer/model-vram-stats.js');
  ({ telemetryDir } = await import('../workspace/paths.js'));
});

describe('telemetry fingerprint rotation', () => {
  const marker = () => join(telemetryDir(), 'vram-fingerprint.json');
  beforeEach(async () => {
    await mkdir(telemetryDir(), { recursive: true });
    await rm(stats.vramStatsFilePath(), { force: true });
    await rm(`${stats.vramStatsFilePath()}.stale`, { force: true });
    await rm(marker(), { force: true });
  });

  it('first run writes the marker', async () => {
    expect(await fp.rotateStatsIfDeviceChanged(12288)).toBe('first-run');
    expect(JSON.parse(await readFile(marker(), 'utf8')).totalMb).toBe(12288);
  });
  it('same fingerprint keeps the file', async () => {
    await fp.rotateStatsIfDeviceChanged(12288);
    await writeFile(stats.vramStatsFilePath(), '{"at":"x","key":"k","vramMb":1}\n', 'utf8');
    expect(await fp.rotateStatsIfDeviceChanged(12288)).toBe('kept');
    await access(stats.vramStatsFilePath());
  });
  it('changed fingerprint rotates to .stale and rewrites marker', async () => {
    await fp.rotateStatsIfDeviceChanged(8188);
    await writeFile(stats.vramStatsFilePath(), '{"at":"x","key":"k","vramMb":1}\n', 'utf8');
    expect(await fp.rotateStatsIfDeviceChanged(12288)).toBe('rotated');
    await access(`${stats.vramStatsFilePath()}.stale`);
    expect(JSON.parse(await readFile(marker(), 'utf8')).totalMb).toBe(12288);
  });
  it('null total (no nvidia-smi) is a no-op', async () => {
    await fp.rotateStatsIfDeviceChanged(12288);
    expect(await fp.rotateStatsIfDeviceChanged(null)).toBe('kept');
  });
});
