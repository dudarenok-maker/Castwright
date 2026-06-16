import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  canonicalVramKey,
  foldEma,
  _emaFromRecords,
} from './model-vram-stats.js';

describe('model-vram-stats helpers', () => {
  it('canonicalises a bare model name to :latest and suffixes num_ctx', () => {
    expect(canonicalVramKey('qwen3.5', 32768)).toBe('qwen3.5:latest@32768');
    expect(canonicalVramKey('gemma-4-E4B-it-GGUF:UD-Q4_K_XL', 32768)).toBe(
      'gemma-4-E4B-it-GGUF:UD-Q4_K_XL@32768',
    );
  });

  it('foldEma weights recent samples more (alpha=0.3)', () => {
    // ema0 = 1000; ema1 = .3*2000 + .7*1000 = 1300
    expect(foldEma([1000, 2000])).toBeCloseTo(1300, 5);
  });

  it('_emaFromRecords returns null when no record matches the key', () => {
    const recs = [{ at: 'x', key: 'other:latest@32768', vramMb: 500 }];
    expect(_emaFromRecords(recs, 'qwen3.5:latest@32768')).toBeNull();
  });

  it('_emaFromRecords folds matching records in file (chronological) order', () => {
    const recs = [
      { at: '1', key: 'm:latest@32768', vramMb: 1000 },
      { at: '2', key: 'm:latest@32768', vramMb: 2000 },
      { at: '3', key: 'other@1', vramMb: 9999 },
    ];
    expect(_emaFromRecords(recs, 'm:latest@32768')).toBeCloseTo(1300, 5);
  });
});

describe('sampleAndRecordVram', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let stats: any;

  beforeAll(async () => {
    process.env.WORKSPACE_DIR = mkdtempSync(join(tmpdir(), 'vram-tel-'));
    stats = await import('./model-vram-stats.js');
  });

  beforeEach(async () => {
    stats._resetVramCacheForTests();
    await rm(stats.vramStatsFilePath(), { force: true });
  });

  it('records a sample only when the model is ~100% on GPU', async () => {
    const fetchFn = async () => ({
      ok: true,
      json: async () => ({
        models: [{ name: 'm:latest', size: 5_000_000_000, size_vram: 5_000_000_000 }],
      }),
    });
    await stats.sampleAndRecordVram('http://x', 'm', 32768, fetchFn as any);
    // 5_000_000_000 bytes ≈ 4768.37 MB
    expect(stats.emaForModelSync('m', 32768)).toBeCloseTo(4768.37, 0);
  });

  it('skips a partially-offloaded model (size_vram << size)', async () => {
    const fetchFn = async () => ({
      ok: true,
      json: async () => ({
        models: [{ name: 'm:latest', size: 5_000_000_000, size_vram: 2_000_000_000 }],
      }),
    });
    await stats.sampleAndRecordVram('http://x', 'm', 32768, fetchFn as any);
    expect(stats.emaForModelSync('m', 32768)).toBeNull();
  });

  it('primeVramCache folds the persisted log into the sync cache', () => {
    stats.primeVramCache([
      { at: '1', key: 'm:latest@32768', vramMb: 1000 },
      { at: '2', key: 'm:latest@32768', vramMb: 2000 },
    ]);
    expect(stats.emaForModelSync('m', 32768)).toBeCloseTo(1300, 5);
  });
});

describe('per-key trim (M2)', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let stats: any;

  beforeAll(async () => {
    process.env.WORKSPACE_DIR = mkdtempSync(join(tmpdir(), 'vram-tel-'));
    stats = await import('./model-vram-stats.js');
  });

  beforeEach(async () => {
    const { rm } = await import('node:fs/promises');
    await rm(stats.vramStatsFilePath(), { force: true });
  });

  it('keeps the last 50 samples for EACH key independently', async () => {
    for (let i = 0; i < 60; i++) await stats.recordVramSample({ at: `c${i}`, key: 'chatty@32768', vramMb: i });
    for (let i = 0; i < 3; i++) await stats.recordVramSample({ at: `r${i}`, key: 'rare@32768', vramMb: 1000 + i });
    const recs = await stats.readAllVramRecords();
    const chatty = recs.filter((r: any) => r.key === 'chatty@32768');
    const rare = recs.filter((r: any) => r.key === 'rare@32768');
    expect(chatty).toHaveLength(50);
    expect(chatty[0].vramMb).toBe(10); // 0..9 dropped, last-50 kept
    expect(rare).toHaveLength(3);
  });
});
