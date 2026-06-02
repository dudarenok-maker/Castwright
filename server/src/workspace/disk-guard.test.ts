/* srv-28 — pre-flight disk-space guard tests. Inject a mocked `probe` so the
   verdict logic is exercised without touching a real volume:
     - ample free space → ok,
     - tight free space in warn mode → warn (message names the GB figures),
     - insufficient free space in block mode → block,
     - the chapter-count × AVG_CHAPTER_BYTES estimate math.
   Also pins `diskGuardMode` env parsing. */

import { describe, it, expect, afterEach } from 'vitest';
import {
  AVG_CHAPTER_BYTES,
  diskGuardMode,
  evaluateDiskGuard,
  type DiskEstimate,
} from './disk-guard.js';
import { DISK_FAIL_GB } from '../diagnostics/disk.js';
import type { DiskProbe } from '../diagnostics/disk.js';

const GB = 1024 * 1024 * 1024;

/* A fake probe that always reports the given free GB, regardless of path. */
function fakeProbe(freeGb: number): (path: string) => Promise<DiskProbe> {
  return async (path: string) => ({ status: 'ok', freeGb, path });
}

const genEstimate = (chapters: number): DiskEstimate => ({
  estimatedBytes: chapters * AVG_CHAPTER_BYTES,
  basis: 'generation',
  chapters,
});

afterEach(() => {
  delete process.env.DISK_GUARD_MODE;
});

describe('diskGuardMode', () => {
  it('defaults to warn when unset', () => {
    delete process.env.DISK_GUARD_MODE;
    expect(diskGuardMode()).toBe('warn');
  });
  it('honours block / off / warn', () => {
    process.env.DISK_GUARD_MODE = 'block';
    expect(diskGuardMode()).toBe('block');
    process.env.DISK_GUARD_MODE = 'off';
    expect(diskGuardMode()).toBe('off');
    process.env.DISK_GUARD_MODE = 'warn';
    expect(diskGuardMode()).toBe('warn');
  });
  it('falls back to warn on an unrecognised value', () => {
    process.env.DISK_GUARD_MODE = 'nonsense';
    expect(diskGuardMode()).toBe('warn');
  });
});

describe('evaluateDiskGuard', () => {
  it('returns ok when free space comfortably exceeds estimate + headroom', async () => {
    const v = await evaluateDiskGuard('/ws', genEstimate(10), { mode: 'warn' }, fakeProbe(500));
    expect(v.status).toBe('ok');
    expect(v.freeGb).toBe(500);
  });

  it('estimate math: estimatedGb reflects chapters × AVG_CHAPTER_BYTES', async () => {
    const v = await evaluateDiskGuard('/ws', genEstimate(40), { mode: 'warn' }, fakeProbe(500));
    const expectedGb = (40 * AVG_CHAPTER_BYTES) / GB;
    expect(v.estimatedGb).toBeCloseTo(expectedGb, 2);
  });

  it('warns (not blocks) in warn mode when free < estimate + headroom; message names GB', async () => {
    /* 10 chapters ≈ 0.176 GB est + 2 GB headroom ≈ 2.18 GB needed; 1.5 GB free
       is short, so warn mode → warn. */
    const v = await evaluateDiskGuard('/ws', genEstimate(10), { mode: 'warn' }, fakeProbe(1.5));
    expect(v.status).toBe('warn');
    expect(v.message).toMatch(/1\.5/);
    expect(v.message).toMatch(/GB/);
  });

  it('blocks in block mode when free is insufficient', async () => {
    const v = await evaluateDiskGuard('/ws', genEstimate(10), { mode: 'block' }, fakeProbe(0.5));
    expect(v.status).toBe('block');
    expect(v.message).toMatch(/GB/);
  });

  it('warns (does NOT block) in warn mode even when free is critically low', async () => {
    const v = await evaluateDiskGuard('/ws', genEstimate(40), { mode: 'warn' }, fakeProbe(0.1));
    expect(v.status).toBe('warn');
  });

  it('respects the DISK_FAIL_GB headroom — free just above estimate but below headroom warns', async () => {
    /* Tiny estimate (1 chapter), free just over it but under estimate+headroom. */
    const estGb = AVG_CHAPTER_BYTES / GB;
    const free = estGb + DISK_FAIL_GB - 0.5; // inside the headroom band
    const v = await evaluateDiskGuard('/ws', genEstimate(1), { mode: 'warn' }, fakeProbe(free));
    expect(v.status).toBe('warn');
  });

  it('export basis flows through to the verdict', async () => {
    const est: DiskEstimate = { estimatedBytes: 3 * GB, basis: 'export' };
    const v = await evaluateDiskGuard('/ws', est, { mode: 'block' }, fakeProbe(1));
    expect(v.status).toBe('block');
    expect(v.estimatedGb).toBeCloseTo(3, 2);
  });
});
