/* fs-18 — ffmpeg/ffprobe presence probe. Stubs node:child_process spawnSync so
   the present/missing matrix can be exercised without the real binaries.

   ops-35 (#1877) — extended with version reporting. The parse/compare cases
   are driven from scripts/tests/fixtures/ffmpeg-version-cases.json, the SAME
   corpus scripts/tests/ffmpeg-version.test.mjs feeds the CJS preflight parser,
   so the two implementations cannot drift apart. */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const spawnSyncMock = vi.fn();
vi.mock('node:child_process', () => ({
  spawnSync: (...args: unknown[]) => spawnSyncMock(...args),
}));

import { probeFfmpeg, parseFfmpegVersion, isBelowFloor, readFfmpegFloor } from './ffmpeg.js';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const CASES = JSON.parse(
  readFileSync(resolve(REPO_ROOT, 'scripts/tests/fixtures/ffmpeg-version-cases.json'), 'utf8'),
) as {
  parse: { name: string; stdout: string; expected: string | null }[];
  belowFloor: { name: string; version: string | null; minimum: string | null; expected: boolean }[];
};

/* Drive the mock by binary name: status 0 = present, null (ENOENT) = missing.
   `banner` becomes ffmpeg's stdout so the version path can be exercised. */
function bins(present: { ffmpeg: boolean; ffprobe: boolean }, banner = '') {
  spawnSyncMock.mockImplementation((bin: string) => ({
    status: (bin === 'ffmpeg' ? present.ffmpeg : present.ffprobe) ? 0 : null,
    stdout: bin === 'ffmpeg' ? banner : '',
  }));
}

beforeEach(() => spawnSyncMock.mockReset());

describe('probeFfmpeg', () => {
  it('reports both present when each -version exits 0', () => {
    bins({ ffmpeg: true, ffprobe: true }, 'ffmpeg version 8.1.1-full_build');
    expect(probeFfmpeg()).toEqual({
      ffmpeg: true,
      ffprobe: true,
      version: '8.1',
      belowFloor: false,
      minimum: '6.0',
    });
  });

  it('reports ffprobe missing when only ffmpeg is on PATH', () => {
    bins({ ffmpeg: true, ffprobe: false }, 'ffmpeg version 8.1.1-full_build');
    expect(probeFfmpeg()).toMatchObject({ ffmpeg: true, ffprobe: false });
  });

  it('treats a non-zero exit (or ENOENT null status) as not-present', () => {
    // ENOENT surfaces as status null; a broken binary as a non-zero status.
    spawnSyncMock.mockImplementation((bin: string) => ({
      status: bin === 'ffmpeg' ? 1 : null,
      stdout: '',
    }));
    expect(probeFfmpeg()).toMatchObject({ ffmpeg: false, ffprobe: false, version: null });
  });

  it('flags a below-floor version WITHOUT claiming ffmpeg is absent', () => {
    bins({ ffmpeg: true, ffprobe: true }, 'ffmpeg version 4.4.2-0ubuntu0.22.04.1');
    const p = probeFfmpeg();
    expect(p.ffmpeg).toBe(true);
    expect(p.version).toBe('4.4');
    expect(p.belowFloor).toBe(true);
  });

  it('never reports belowFloor for an unparseable git build', () => {
    bins({ ffmpeg: true, ffprobe: true }, 'ffmpeg version 2026-01-01-git-abc1234');
    const p = probeFfmpeg();
    expect(p.version).toBeNull();
    expect(p.belowFloor).toBe(false);
  });

  it('never reports belowFloor when ffmpeg is absent', () => {
    bins({ ffmpeg: false, ffprobe: false });
    expect(probeFfmpeg().belowFloor).toBe(false);
  });

  /* The Setup Wizard's "Re-check" button and the diagnostics board's 30 s
     refresh both re-hit this. If the probe were cached per-process, a user
     who installed ffmpeg and clicked Re-check would be told it is still
     missing until they restarted the server. */
  it('re-probes on every call so Re-check sees a freshly installed ffmpeg', () => {
    bins({ ffmpeg: false, ffprobe: false });
    expect(probeFfmpeg().ffmpeg).toBe(false);

    // User installs ffmpeg, then clicks Re-check.
    bins({ ffmpeg: true, ffprobe: true }, 'ffmpeg version 8.1.1');
    expect(probeFfmpeg().ffmpeg).toBe(true);
    expect(probeFfmpeg().version).toBe('8.1');
  });

  it('re-probes after an upgrade so a below-floor warning can clear', () => {
    bins({ ffmpeg: true, ffprobe: true }, 'ffmpeg version 4.4.2-0ubuntu0.22.04.1');
    expect(probeFfmpeg().belowFloor).toBe(true);

    bins({ ffmpeg: true, ffprobe: true }, 'ffmpeg version 6.1.1-3ubuntu5');
    expect(probeFfmpeg().belowFloor).toBe(false);
  });
});

describe('ffmpeg version parsing (shared corpus)', () => {
  it.each(CASES.parse)('parses $name', ({ stdout, expected }) => {
    expect(parseFfmpegVersion(stdout)).toBe(expected);
  });

  it.each(CASES.belowFloor)('compares $name', ({ version, minimum, expected }) => {
    expect(isBelowFloor(version, minimum)).toBe(expected);
  });

  it('reads the declared floor from root package.json', () => {
    expect(readFfmpegFloor()).toBe('6.0');
  });
});
