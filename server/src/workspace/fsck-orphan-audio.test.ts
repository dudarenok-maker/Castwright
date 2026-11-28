/* Unit coverage for the rollback-preservation fsck (plan 20).
 *
 * Pins three on-disk shapes the preserve helper's two-rename window can
 * leave behind plus the inert no-op case:
 *   (1) `<slug>.previous.mp3` alone with no live `<slug>.mp3` →
 *       promote `.previous.*` back to live.
 *   (2) `<slug>.previous.segments.json` alone (no audio sibling) →
 *       left in place: the take module's sweep quarantines it, run by
 *       `fsckAllBooks` before this function (`chapter-take.sweep.test.ts`).
 *       This function never deletes it.
 *   (3) Live + previous both present → valid pending-revision; leave
 *       both files untouched.
 *   (4) Both previous halves present without a live → promote the
 *       audio AND its matching segments file in one go.
 *
 * The fsck is fire-and-forget safe (never throws); every assertion
 * here goes through the function's normal return path. */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync, readFileSync } from 'node:fs';
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

  it('never deletes an orphan <slug>.previous.segments.json: it is the sweep\'s to quarantine (#4320)', async () => {
    seedFile('03-chapter-3.previous.segments.json', '{"segments":[]}');

    const result = await fsckOrphanAudio(audioRoot);

    expect(result.errors).toEqual([]);
    expect(result.recovered).toEqual([]);
    expect(readFileSync(join(audioRoot, '03-chapter-3.previous.segments.json'), 'utf8')).toBe(
      '{"segments":[]}',
    );
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

  /* #3457: the live take on an m4a/ogg book is `<slug>.m4a`/`.ogg`, never
     `<slug>.mp3`. A `.previous.mp3` beside it is a valid pending revision,
     not an orphan — promoting it would revert the chapter on every boot. */
  for (const ext of ['m4a', 'ogg'] as const) {
    it(`leaves a pending revision alone when the live take is .${ext} (#3457)`, async () => {
      seedFile(`10-chapter-10.${ext}`, 'live bytes');
      seedFile('10-chapter-10.segments.json', '{"live":true}');
      seedFile('10-chapter-10.previous.mp3', 'preserved bytes');
      seedFile('10-chapter-10.previous.segments.json', '{"live":false}');

      const result = await fsckOrphanAudio(audioRoot);

      expect(result.errors).toEqual([]);
      expect(result.recovered).toEqual([]);
      expect(readFileSync(join(audioRoot, `10-chapter-10.${ext}`), 'utf8')).toBe('live bytes');
      expect(readFileSync(join(audioRoot, '10-chapter-10.segments.json'), 'utf8')).toBe(
        '{"live":true}',
      );
      expect(existsSync(join(audioRoot, '10-chapter-10.mp3'))).toBe(false);
      expect(existsSync(join(audioRoot, '10-chapter-10.previous.mp3'))).toBe(true);
      expect(existsSync(join(audioRoot, '10-chapter-10.previous.segments.json'))).toBe(true);
    });
  }

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
    expect(actions).toEqual(['06-chapter-6:promoted-previous-to-live']);
    /* Chapter 6 promoted, chapter 7 left to the sweep, chapter 8 untouched, chapter 9 pair preserved. */
    expect(existsSync(join(audioRoot, '06-chapter-6.mp3'))).toBe(true);
    expect(existsSync(join(audioRoot, '07-chapter-7.previous.segments.json'))).toBe(true);
    expect(existsSync(join(audioRoot, '09-chapter-9.mp3'))).toBe(true);
    expect(existsSync(join(audioRoot, '09-chapter-9.previous.mp3'))).toBe(true);
  });

  /* #4335 — the fsck promotes with the previous take's REAL extension (H13). */
  it('F1: a lone .previous.m4a plus its segments is promoted to <slug>.m4a and <slug>.segments.json', async () => {
    seedFile('11-chapter-11.previous.m4a', 'm4a bytes');
    seedFile('11-chapter-11.previous.segments.json', '{"segments":[]}');

    const result = await fsckOrphanAudio(audioRoot);

    expect(result.errors).toEqual([]);
    expect(result.recovered).toEqual([
      { audioRoot, slug: '11-chapter-11', action: 'promoted-previous-to-live' },
    ]);
    expect(readFileSync(join(audioRoot, '11-chapter-11.m4a'), 'utf8')).toBe('m4a bytes');
    expect(existsSync(join(audioRoot, '11-chapter-11.mp3'))).toBe(false);
    expect(existsSync(join(audioRoot, '11-chapter-11.segments.json'))).toBe(true);
    expect(existsSync(join(audioRoot, '11-chapter-11.previous.m4a'))).toBe(false);
    expect(existsSync(join(audioRoot, '11-chapter-11.previous.segments.json'))).toBe(false);
  });

  it('F2: the same with ogg', async () => {
    seedFile('12-chapter-12.previous.ogg', 'ogg bytes');
    seedFile('12-chapter-12.previous.segments.json', '{"segments":[]}');

    const result = await fsckOrphanAudio(audioRoot);

    expect(result.errors).toEqual([]);
    expect(result.recovered).toEqual([
      { audioRoot, slug: '12-chapter-12', action: 'promoted-previous-to-live' },
    ]);
    expect(readFileSync(join(audioRoot, '12-chapter-12.ogg'), 'utf8')).toBe('ogg bytes');
    expect(existsSync(join(audioRoot, '12-chapter-12.mp3'))).toBe(false);
    expect(existsSync(join(audioRoot, '12-chapter-12.segments.json'))).toBe(true);
  });

  it('F3: an mp3 book behaves as before (pin)', async () => {
    seedFile('13-chapter-13.previous.mp3', 'mp3 bytes');
    seedFile('13-chapter-13.previous.segments.json', '{"segments":[]}');

    const result = await fsckOrphanAudio(audioRoot);

    expect(result.errors).toEqual([]);
    expect(result.recovered).toEqual([
      { audioRoot, slug: '13-chapter-13', action: 'promoted-previous-to-live' },
    ]);
    expect(readFileSync(join(audioRoot, '13-chapter-13.mp3'), 'utf8')).toBe('mp3 bytes');
    expect(existsSync(join(audioRoot, '13-chapter-13.segments.json'))).toBe(true);
    expect(existsSync(join(audioRoot, '13-chapter-13.previous.mp3'))).toBe(false);
  });

  it('F4: a live take of one extension beside a previous of another is left alone, both directions (#3457)', async () => {
    seedFile('14-chapter-14.ogg', 'live ogg');
    seedFile('14-chapter-14.previous.mp3', 'prev mp3');
    seedFile('15-chapter-15.mp3', 'live mp3');
    seedFile('15-chapter-15.previous.m4a', 'prev m4a');

    const result = await fsckOrphanAudio(audioRoot);

    expect(result.errors).toEqual([]);
    expect(result.recovered).toEqual([]);
    expect(existsSync(join(audioRoot, '14-chapter-14.ogg'))).toBe(true);
    expect(existsSync(join(audioRoot, '14-chapter-14.previous.mp3'))).toBe(true);
    expect(existsSync(join(audioRoot, '14-chapter-14.mp3'))).toBe(false);
    expect(existsSync(join(audioRoot, '15-chapter-15.mp3'))).toBe(true);
    expect(existsSync(join(audioRoot, '15-chapter-15.previous.m4a'))).toBe(true);
    expect(existsSync(join(audioRoot, '15-chapter-15.m4a'))).toBe(false);
  });

  it('F5: a previous segments file survives this function, beside a .previous.ogg or with no previous audio at all', async () => {
    seedFile('16-chapter-16.mp3', 'live'); // live take, so case 1 does not promote
    seedFile('16-chapter-16.previous.ogg', 'prev ogg');
    seedFile('16-chapter-16.previous.segments.json', '{"segments":[]}');
    seedFile('17-chapter-17.mp3', 'live');
    seedFile('17-chapter-17.previous.segments.json', '{"segments":[]}');

    const result = await fsckOrphanAudio(audioRoot);

    expect(result.errors).toEqual([]);
    expect(result.recovered).toEqual([]);
    expect(existsSync(join(audioRoot, '16-chapter-16.previous.segments.json'))).toBe(true);
    expect(existsSync(join(audioRoot, '16-chapter-16.previous.ogg'))).toBe(true);
    expect(existsSync(join(audioRoot, '17-chapter-17.previous.segments.json'))).toBe(true);
  });
});
