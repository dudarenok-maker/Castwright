/* The A/B take functions in the take module (#4334, spec §7 Phase 1 step 3).
   Moved from the old A/B audio-steps test and the old preserve helper's test:
   every case that pinned today's mp3 behaviour stays (P7), and the
   real-extension cases (P1-P5) are new. Residuals H1/H2 stay pinned: restore
   deletes the live take BEFORE the rename and swallows a failed segments
   rename (Phase 3's restoreTake fixes them). */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { failRename } = vi.hoisted(() => ({ failRename: { value: false } }));
vi.mock('./atomic-rename.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('./atomic-rename.js')>();
  return {
    ...real,
    renameWithRetry: async (src: string, dest: string) => {
      if (failRename.value && src.endsWith('.previous.mp3')) throw new Error('EBUSY: simulated');
      return real.renameWithRetry(src, dest);
    },
  };
});

import {
  acceptPreviousAudio,
  findPreviousAudio,
  hasPreviousAudio,
  preserveExistingAsPrevious,
  restorePreviousAudio,
  TAKE_SUFFIXES,
  takeSuffixPath,
} from './chapter-take.js';

const SLUG = '01-one';
let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'chapter-take-previous-'));
  failRename.value = false;
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});
const p = (name: string) => join(root, name);
const names = () => readdirSync(root).sort();

describe('findPreviousAudio', () => {
  it('returns null without a previous take, and the descriptor of the name it found', () => {
    expect(findPreviousAudio(root, SLUG)).toBeNull();
    writeFileSync(p(`${SLUG}.previous.mp3`), 'PREV');
    expect(findPreviousAudio(root, SLUG)).toEqual({
      path: p(`${SLUG}.previous.mp3`),
      ext: 'mp3',
      mime: 'audio/mpeg',
      urlSuffix: 'audio/previous.mp3',
    });
  });
});

describe('TAKE_SUFFIXES / takeSuffixPath', () => {
  it('holds the live exts, the six sidecars and every previous.* part (3 + 6 + 3 + 6 = 18)', () => {
    expect(new Set(TAKE_SUFFIXES).size).toBe(TAKE_SUFFIXES.length);
    expect(TAKE_SUFFIXES).toHaveLength(18);
    expect(TAKE_SUFFIXES).toContain('previous.m4a');
    expect(TAKE_SUFFIXES).toContain('previous.render-integrity-attempted.json');
  });
  it('builds join(audioRoot, slug.suffix)', () => {
    expect(takeSuffixPath(root, SLUG, 'previous.ogg')).toBe(join(root, `${SLUG}.previous.ogg`));
  });
});

describe('preserveExistingAsPrevious', () => {
  it('no-ops on first render (no existing audio)', async () => {
    expect(await preserveExistingAsPrevious(root, SLUG)).toEqual({ preserved: false });
    expect(names()).toEqual([]);
  });

  it('P7: an mp3 take is preserved to exactly the names it always had, bytes intact', async () => {
    writeFileSync(p(`${SLUG}.mp3`), 'fake-mp3-bytes');
    writeFileSync(p(`${SLUG}.segments.json`), JSON.stringify({ v: 1 }));
    expect(await preserveExistingAsPrevious(root, SLUG)).toEqual({ preserved: true });
    expect(names()).toEqual([`${SLUG}.previous.mp3`, `${SLUG}.previous.segments.json`]);
    expect(readFileSync(p(`${SLUG}.previous.mp3`), 'utf8')).toBe('fake-mp3-bytes');
    expect(JSON.parse(readFileSync(p(`${SLUG}.previous.segments.json`), 'utf8'))).toEqual({ v: 1 });
  });

  it('P7: overwrites a stale same-extension .previous pair from an earlier preserve', async () => {
    writeFileSync(p(`${SLUG}.previous.mp3`), 'OLD');
    writeFileSync(p(`${SLUG}.previous.segments.json`), JSON.stringify({ v: 0 }));
    writeFileSync(p(`${SLUG}.mp3`), 'CURRENT');
    writeFileSync(p(`${SLUG}.segments.json`), JSON.stringify({ v: 1 }));
    expect((await preserveExistingAsPrevious(root, SLUG)).preserved).toBe(true);
    expect(readFileSync(p(`${SLUG}.previous.mp3`), 'utf8')).toBe('CURRENT');
    expect(JSON.parse(readFileSync(p(`${SLUG}.previous.segments.json`), 'utf8'))).toEqual({ v: 1 });
  });

  it('moves audio even when segments.json is missing', async () => {
    writeFileSync(p(`${SLUG}.mp3`), 'fake-mp3-bytes');
    expect(await preserveExistingAsPrevious(root, SLUG)).toEqual({ preserved: true });
    expect(names()).toEqual([`${SLUG}.previous.mp3`]);
  });

  for (const ext of ['m4a', 'ogg'] as const) {
    it(`P1: preserving a ${ext} take gives .previous.${ext} and .previous.segments.json, and no .previous.mp3`, async () => {
      writeFileSync(p(`${SLUG}.${ext}`), `LIVE-${ext}`);
      writeFileSync(p(`${SLUG}.segments.json`), '{"s":1}');
      expect(await preserveExistingAsPrevious(root, SLUG)).toEqual({ preserved: true });
      expect(names()).toEqual([`${SLUG}.previous.${ext}`, `${SLUG}.previous.segments.json`]);
      expect(existsSync(p(`${SLUG}.previous.mp3`))).toBe(false);
      expect(readFileSync(p(`${SLUG}.previous.${ext}`), 'utf8')).toBe(`LIVE-${ext}`);
    });
  }

  it('P2: a live m4a beside a stale .previous.mp3 leaves only .previous.m4a after preserve', async () => {
    writeFileSync(p(`${SLUG}.previous.mp3`), 'STALE-MP3-TAKE');
    writeFileSync(p(`${SLUG}.m4a`), 'LIVE-M4A');
    writeFileSync(p(`${SLUG}.segments.json`), '{}');
    expect((await preserveExistingAsPrevious(root, SLUG)).preserved).toBe(true);
    expect(names()).toEqual([`${SLUG}.previous.m4a`, `${SLUG}.previous.segments.json`]);
    expect(readFileSync(p(`${SLUG}.previous.m4a`), 'utf8')).toBe('LIVE-M4A');
  });

  it('P2b: a stale other-extension .previous that cannot be removed aborts the preserve, so two previous takes never coexist', async () => {
    /* A directory at the stale name makes `unlink` fail on every OS. */
    mkdirSync(p(`${SLUG}.previous.mp3`));
    writeFileSync(p(`${SLUG}.m4a`), 'LIVE-M4A');
    writeFileSync(p(`${SLUG}.segments.json`), '{"s":1}');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    expect(await preserveExistingAsPrevious(root, SLUG)).toEqual({ preserved: false });

    expect(warn).toHaveBeenCalled();
    expect(existsSync(p(`${SLUG}.previous.m4a`))).toBe(false);
    expect(readFileSync(p(`${SLUG}.m4a`), 'utf8')).toBe('LIVE-M4A');
    expect(existsSync(p(`${SLUG}.segments.json`))).toBe(true);
    expect(existsSync(p(`${SLUG}.previous.segments.json`))).toBe(false);
    warn.mockRestore();
  });
});

describe('hasPreviousAudio', () => {
  it('is false when nothing is preserved and true for .previous.mp3', () => {
    expect(hasPreviousAudio(root, SLUG)).toBe(false);
    writeFileSync(p(`${SLUG}.previous.mp3`), '');
    expect(hasPreviousAudio(root, SLUG)).toBe(true);
  });
  it('P5: is true for a chapter with only .previous.ogg', () => {
    writeFileSync(p(`${SLUG}.previous.ogg`), '');
    expect(hasPreviousAudio(root, SLUG)).toBe(true);
  });
});

describe('acceptPreviousAudio', () => {
  it("answers 'none' when nothing is preserved", async () => {
    writeFileSync(p(`${SLUG}.mp3`), 'LIVE');
    expect(await acceptPreviousAudio(root, SLUG)).toBe('none');
    expect(existsSync(p(`${SLUG}.mp3`))).toBe(true);
  });

  it("P7: deletes both .previous files, leaves live, answers 'deleted'", async () => {
    writeFileSync(p(`${SLUG}.mp3`), 'LIVE');
    writeFileSync(p(`${SLUG}.previous.mp3`), 'PREV');
    writeFileSync(p(`${SLUG}.previous.segments.json`), '{}');
    expect(await acceptPreviousAudio(root, SLUG)).toBe('deleted');
    expect(names()).toEqual([`${SLUG}.mp3`]);
    expect(readFileSync(p(`${SLUG}.mp3`), 'utf8')).toBe('LIVE');
  });

  it('P4: Accept on a .previous.ogg take deletes it and its segments', async () => {
    writeFileSync(p(`${SLUG}.ogg`), 'LIVE');
    writeFileSync(p(`${SLUG}.previous.ogg`), 'PREV');
    writeFileSync(p(`${SLUG}.previous.segments.json`), '{}');
    expect(await acceptPreviousAudio(root, SLUG)).toBe('deleted');
    expect(names()).toEqual([`${SLUG}.ogg`]);
  });
});

describe('restorePreviousAudio', () => {
  it("answers 'none' and touches nothing when nothing is preserved", async () => {
    writeFileSync(p(`${SLUG}.mp3`), 'LIVE');
    expect(await restorePreviousAudio(root, SLUG)).toBe('none');
    expect(readFileSync(p(`${SLUG}.mp3`), 'utf8')).toBe('LIVE');
  });

  it("P7: promotes .previous over live (audio + segments) and answers 'restored'", async () => {
    writeFileSync(p(`${SLUG}.mp3`), 'LIVE');
    writeFileSync(p(`${SLUG}.segments.json`), '{"live":true}');
    writeFileSync(p(`${SLUG}.previous.mp3`), 'PREV');
    writeFileSync(p(`${SLUG}.previous.segments.json`), '{"prev":true}');
    expect(await restorePreviousAudio(root, SLUG)).toBe('restored');
    expect(readFileSync(p(`${SLUG}.mp3`), 'utf8')).toBe('PREV');
    expect(JSON.parse(readFileSync(p(`${SLUG}.segments.json`), 'utf8'))).toEqual({ prev: true });
    expect(existsSync(p(`${SLUG}.previous.mp3`))).toBe(false);
  });

  it('P3: Reject of an m4a take restores <slug>.m4a and its segments; no <slug>.mp3 exists; the bytes are the previous take', async () => {
    writeFileSync(p(`${SLUG}.m4a`), 'LIVE-M4A');
    writeFileSync(p(`${SLUG}.segments.json`), '{"live":true}');
    writeFileSync(p(`${SLUG}.previous.m4a`), 'PREV-M4A');
    writeFileSync(p(`${SLUG}.previous.segments.json`), '{"prev":true}');
    expect(await restorePreviousAudio(root, SLUG)).toBe('restored');
    expect(names()).toEqual([`${SLUG}.m4a`, `${SLUG}.segments.json`]);
    expect(existsSync(p(`${SLUG}.mp3`))).toBe(false);
    expect(readFileSync(p(`${SLUG}.m4a`), 'utf8')).toBe('PREV-M4A');
    expect(JSON.parse(readFileSync(p(`${SLUG}.segments.json`), 'utf8'))).toEqual({ prev: true });
  });

  it('format switch: a live .m4a is deleted and a .previous.mp3 comes back as .mp3', async () => {
    writeFileSync(p(`${SLUG}.m4a`), 'LIVE-M4A');
    writeFileSync(p(`${SLUG}.previous.mp3`), 'PREV');
    expect(await restorePreviousAudio(root, SLUG)).toBe('restored');
    expect(existsSync(p(`${SLUG}.m4a`))).toBe(false);
    expect(readFileSync(p(`${SLUG}.mp3`), 'utf8')).toBe('PREV');
  });

  it('today (H1): a failed rename throws AFTER the live take was deleted; .previous stays intact', async () => {
    writeFileSync(p(`${SLUG}.mp3`), 'LIVE');
    writeFileSync(p(`${SLUG}.previous.mp3`), 'PREV');
    failRename.value = true;
    await expect(restorePreviousAudio(root, SLUG)).rejects.toThrow(/simulated/);
    expect(existsSync(p(`${SLUG}.mp3`))).toBe(false);
    expect(readFileSync(p(`${SLUG}.previous.mp3`), 'utf8')).toBe('PREV');
  });
});
