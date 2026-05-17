/* preserveExistingAsPrevious — invariants the rollback model relies on.
   The generation write path calls this helper right before clobbering the
   live audio pair, so:

   - First render (no existing audio): MUST no-op without throwing.
   - Subsequent render: MUST move BOTH the audio file AND segments.json to
     `.previous.*` siblings. The new render then writes to the freshly-empty
     live names.
   - Stale `.previous.*` from a prior accept/reject that the user has moved
     on from: MUST be overwritten (it's dead state). */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { preserveExistingAsPrevious, hasPreviousAudio } from './preserve-previous-audio.js';

let workdir: string;

beforeEach(async () => {
  workdir = await mkdtemp(join(tmpdir(), 'preserve-previous-test-'));
});

afterEach(async () => {
  await rm(workdir, { recursive: true, force: true });
});

describe('preserveExistingAsPrevious', () => {
  it('no-ops on first render (no existing audio)', async () => {
    const result = await preserveExistingAsPrevious(workdir, 'ch01');
    expect(result).toEqual({ preserved: false });

    const remaining = await readdir(workdir);
    expect(remaining).toEqual([]);
  });

  it('preserves an existing mp3 + segments.json to .previous.*', async () => {
    await writeFile(join(workdir, 'ch01.mp3'), 'fake-mp3-bytes');
    await writeFile(join(workdir, 'ch01.segments.json'), JSON.stringify({ v: 1 }));

    const result = await preserveExistingAsPrevious(workdir, 'ch01');
    expect(result).toEqual({ preserved: true });

    const remaining = (await readdir(workdir)).sort();
    expect(remaining).toEqual(['ch01.previous.mp3', 'ch01.previous.segments.json']);

    /* Content survives the rename — we move atomically, not copy-then-zero. */
    expect(await readFile(join(workdir, 'ch01.previous.mp3'), 'utf8')).toBe('fake-mp3-bytes');
    expect(
      JSON.parse(await readFile(join(workdir, 'ch01.previous.segments.json'), 'utf8')),
    ).toEqual({ v: 1 });
  });

  it('overwrites stale .previous.* from an earlier preserve', async () => {
    /* Simulate: user regenerated, didn't accept/reject, regenerated again.
       The OLDER .previous pair must yield to the freshly-preserved pair —
       it's dead state. */
    await writeFile(join(workdir, 'ch01.previous.mp3'), 'OLD-previous-bytes');
    await writeFile(join(workdir, 'ch01.previous.segments.json'), JSON.stringify({ v: 0 }));
    await writeFile(join(workdir, 'ch01.mp3'), 'CURRENT-bytes');
    await writeFile(join(workdir, 'ch01.segments.json'), JSON.stringify({ v: 1 }));

    const result = await preserveExistingAsPrevious(workdir, 'ch01');
    expect(result.preserved).toBe(true);

    /* Previous now holds what was the CURRENT pair, not the older one. */
    expect(await readFile(join(workdir, 'ch01.previous.mp3'), 'utf8')).toBe('CURRENT-bytes');
    expect(
      JSON.parse(await readFile(join(workdir, 'ch01.previous.segments.json'), 'utf8')),
    ).toEqual({ v: 1 });
  });

  it('moves audio even when segments.json is missing', async () => {
    /* Edge case: chapter has audio but the segments.json was lost or
       never existed (e.g. a corrupted workspace). The helper still
       preserves the audio so the audition has a fighting chance. */
    await writeFile(join(workdir, 'ch01.mp3'), 'fake-mp3-bytes');

    const result = await preserveExistingAsPrevious(workdir, 'ch01');
    expect(result).toEqual({ preserved: true });

    const remaining = (await readdir(workdir)).sort();
    expect(remaining).toEqual(['ch01.previous.mp3']);
  });
});

describe('hasPreviousAudio', () => {
  it('returns false when nothing preserved', () => {
    expect(hasPreviousAudio(workdir, 'ch01')).toBe(false);
  });

  it('returns true for .previous.mp3', async () => {
    await writeFile(join(workdir, 'ch01.previous.mp3'), '');
    expect(hasPreviousAudio(workdir, 'ch01')).toBe(true);
  });
});
