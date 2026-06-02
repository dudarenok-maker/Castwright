/* fs-18 — free-disk probe. Stubs node:fs/promises statfs so the ok/warn/fail
   thresholds can be exercised without depending on the host's actual free
   space. */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const statfsMock = vi.fn();
vi.mock('node:fs/promises', () => ({
  statfs: (...args: unknown[]) => statfsMock(...args),
}));

import { probeDiskSpace, DISK_WARN_GB, DISK_FAIL_GB } from './disk.js';

const GB = 1024 * 1024 * 1024;
const BSIZE = 4096;

/* Build a statfs-shaped result whose bavail*bsize equals `freeGb` gigabytes. */
function statfsForFreeGb(freeGb: number) {
  const bavail = Math.round((freeGb * GB) / BSIZE);
  return { bsize: BSIZE, blocks: bavail * 2, bfree: bavail, bavail };
}

beforeEach(() => statfsMock.mockReset());

describe('probeDiskSpace', () => {
  it('is ok well above the warn threshold', async () => {
    statfsMock.mockResolvedValue(statfsForFreeGb(50));
    const r = await probeDiskSpace('/workspace');
    expect(r.status).toBe('ok');
    expect(r.freeGb).toBeCloseTo(50, 1);
    expect(r.path).toBe('/workspace');
  });

  it(`warns below ${DISK_WARN_GB} GB free`, async () => {
    statfsMock.mockResolvedValue(statfsForFreeGb(5));
    const r = await probeDiskSpace('/workspace');
    expect(r.status).toBe('warn');
    expect(r.freeGb).toBeCloseTo(5, 1);
  });

  it(`fails below ${DISK_FAIL_GB} GB free`, async () => {
    statfsMock.mockResolvedValue(statfsForFreeGb(1));
    const r = await probeDiskSpace('/workspace');
    expect(r.status).toBe('fail');
    expect(r.freeGb).toBeCloseTo(1, 1);
  });
});
