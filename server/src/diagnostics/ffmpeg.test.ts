/* fs-18 — ffmpeg/ffprobe presence probe. Stubs node:child_process spawnSync so
   the present/missing matrix can be exercised without the real binaries. */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const spawnSyncMock = vi.fn();
vi.mock('node:child_process', () => ({
  spawnSync: (...args: unknown[]) => spawnSyncMock(...args),
}));

import { probeFfmpeg } from './ffmpeg.js';

/* Drive the mock by binary name: status 0 = present, null (ENOENT) = missing. */
function bins(present: { ffmpeg: boolean; ffprobe: boolean }) {
  spawnSyncMock.mockImplementation((bin: string) => ({
    status: (bin === 'ffmpeg' ? present.ffmpeg : present.ffprobe) ? 0 : null,
  }));
}

beforeEach(() => spawnSyncMock.mockReset());

describe('probeFfmpeg', () => {
  it('reports both present when each -version exits 0', () => {
    bins({ ffmpeg: true, ffprobe: true });
    expect(probeFfmpeg()).toEqual({ ffmpeg: true, ffprobe: true });
  });

  it('reports ffprobe missing when only ffmpeg is on PATH', () => {
    bins({ ffmpeg: true, ffprobe: false });
    expect(probeFfmpeg()).toEqual({ ffmpeg: true, ffprobe: false });
  });

  it('treats a non-zero exit (or ENOENT null status) as not-present', () => {
    // ENOENT surfaces as status null; a broken binary as a non-zero status.
    spawnSyncMock.mockImplementation((bin: string) => ({
      status: bin === 'ffmpeg' ? 1 : null,
    }));
    expect(probeFfmpeg()).toEqual({ ffmpeg: false, ffprobe: false });
  });
});
