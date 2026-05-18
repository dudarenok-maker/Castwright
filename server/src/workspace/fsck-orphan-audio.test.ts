/* Unit coverage for the rollback-preservation fsck (plan 20).
 *
 * Pins three on-disk shapes the preserve helper's two-rename window can
 * leave behind plus the inert no-op case:
 *   (1) `<slug>.previous.mp3` alone with no live `<slug>.mp3` →
 *       promote `.previous.*` back to live.
 *   (2) `<slug>.previous.segments.json` alone (no audio sibling) →
 *       drop the orphan.
 *   (3) Live + previous both present → valid pending-revision; leave
 *       both files untouched.
 *   (4) Both previous halves present without a live → promote the
 *       audio AND its matching segments file in one go.
 *
 * The fsck is fire-and-forget safe (never throws); every assertion
 * here goes through the function's normal return path. */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fsckOrphanAudio } from './fsck-orphan-audio.js';

let workRoot: string;
let audioRoot: string;

beforeEach(() => {
  workRoot = mkdtempSync(join(tmpdir(), 'fsck-orphan-audio-'));
  audioRoot = join(workRoot, 'audio');
  mkdirSync(audioRoot, { recursive: true });
});

afterEach(() => {
  rmSync(workRoot, { recursive: true, force: true });
});

function seedFile(name: string, contents = 'x'): void {
  writeFileSync(join(audioRoot, name), contents);
}

describe('fsckOrphanAudio', () => {
  it('promotes <slug>.previous.mp3 back to live when <slug>.mp3 is missing (regen crash recovery)', async () => {
    seedFile('01-chapter-1.previous.mp3', 'preserved audio bytes');

    const result = await fsckOrphanAudio(audioRoot);

    expect(result.errors).toEqual([]);
    expect(result.recovered).toEqual([
      { audioRoot, slug: '01-chapter-1', action: 'promoted-previous-to-live' },
    ]);
    expect(existsSync(join(audioRoot, '01-chapter-1.mp3'))).toBe(true);
    expect(existsSync(join(audioRoot, '01-chapter-1.previous.mp3'))).toBe(false);
  });

  it('also promotes the matching segments file when both previous halves are orphaned', async () => {
    seedFile('02-chapter-2.previous.mp3');
    seedFile('02-chapter-2.previous.segments.json', '{"segments":[]}');

    const result = await fsckOrphanAudio(audioRoot);

    expect(result.errors).toEqual([]);
    /* Single recovered entry — segments promotion is bundled into the
       audio recovery action so the report stays per-slug. */
    expect(result.recovered).toEqual([
      { audioRoot, slug: '02-chapter-2', action: 'promoted-previous-to-live' },
    ]);
    expect(existsSync(join(audioRoot, '02-chapter-2.mp3'))).toBe(true);
    expect(existsSync(join(audioRoot, '02-chapter-2.segments.json'))).toBe(true);
    expect(existsSync(join(audioRoot, '02-chapter-2.previous.mp3'))).toBe(false);
    expect(existsSync(join(audioRoot, '02-chapter-2.previous.segments.json'))).toBe(false);
  });

  it('drops orphan <slug>.previous.segments.json when no preserved audio matches it', async () => {
    seedFile('03-chapter-3.previous.segments.json', '{"segments":[]}');

    const result = await fsckOrphanAudio(audioRoot);

    expect(result.errors).toEqual([]);
    expect(result.recovered).toEqual([
      { audioRoot, slug: '03-chapter-3', action: 'dropped-orphan-segments' },
    ]);
    expect(existsSync(join(audioRoot, '03-chapter-3.previous.segments.json'))).toBe(false);
  });

  it('leaves a valid pending-revision pair (.mp3 + .previous.mp3 + .previous.segments.json) untouched', async () => {
    seedFile('04-chapter-4.mp3', 'live bytes');
    seedFile('04-chapter-4.previous.mp3', 'preserved bytes');
    seedFile('04-chapter-4.previous.segments.json', '{"segments":[]}');

    const result = await fsckOrphanAudio(audioRoot);

    expect(result.errors).toEqual([]);
    expect(result.recovered).toEqual([]);
    expect(existsSync(join(audioRoot, '04-chapter-4.mp3'))).toBe(true);
    expect(existsSync(join(audioRoot, '04-chapter-4.previous.mp3'))).toBe(true);
    expect(existsSync(join(audioRoot, '04-chapter-4.previous.segments.json'))).toBe(true);
  });

  it('is a no-op on a fresh book with only live files', async () => {
    seedFile('05-chapter-5.mp3', 'live bytes');
    seedFile('05-chapter-5.segments.json', '{"segments":[]}');

    const result = await fsckOrphanAudio(audioRoot);

    expect(result.recovered).toEqual([]);
    expect(result.errors).toEqual([]);
  });

  it('returns an empty result on a non-existent audio root (fire-and-forget safe)', async () => {
    const result = await fsckOrphanAudio(join(workRoot, 'does-not-exist'));
    expect(result.recovered).toEqual([]);
    expect(result.errors).toEqual([]);
  });

  it('handles multiple orphans in a single sweep without crosstalk', async () => {
    seedFile('06-chapter-6.previous.mp3'); // case 1
    seedFile('07-chapter-7.previous.segments.json', '{"segments":[]}'); // case 2
    seedFile('08-chapter-8.mp3'); // valid live, no previous
    seedFile('09-chapter-9.mp3'); // valid live
    seedFile('09-chapter-9.previous.mp3'); // pending revision — leave alone

    const result = await fsckOrphanAudio(audioRoot);

    expect(result.errors).toEqual([]);
    const actions = result.recovered.map((r) => `${r.slug}:${r.action}`).sort();
    expect(actions).toEqual([
      '06-chapter-6:promoted-previous-to-live',
      '07-chapter-7:dropped-orphan-segments',
    ]);
    /* Chapter 6 promoted, chapter 7 cleaned, chapter 8 untouched, chapter 9 pair preserved. */
    expect(existsSync(join(audioRoot, '06-chapter-6.mp3'))).toBe(true);
    expect(existsSync(join(audioRoot, '07-chapter-7.previous.segments.json'))).toBe(false);
    expect(existsSync(join(audioRoot, '09-chapter-9.mp3'))).toBe(true);
    expect(existsSync(join(audioRoot, '09-chapter-9.previous.mp3'))).toBe(true);
  });
});
