/* Companion to the 2026-05-22 LUFS-drift backfill script
   (`scripts/relufs-existing.mjs`). Covers:

   - parseEbur128Summary: real-shape ffmpeg stderr fixtures (production +
     degenerate -inf cases) → integrated loudness, range, true peak.
   - iterChapters: workspace walker against a fixture <Author>/<Series>/<Book>
     tree → only yields MP3s with a sibling .lufs.json.

   We deliberately do NOT exercise the full main() against a fixture
   workspace from this test — that would require either spawning real ffmpeg
   on synthetic MP3 bytes (slow + brittle) or mocking the spawn (the
   existing real-ffmpeg integration in server/src/tts/mp3.test.ts covers
   the ebur128 measurement seam). The pure parser + walker are what we
   lock down here. */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { iterChapters, parseEbur128Summary } from '../relufs-existing.mjs';

test('parseEbur128Summary extracts I, LRA, and Peak from a real-shape stderr', () => {
  /* Verbatim shape ffmpeg's ebur128 filter prints. The per-frame "I:" lines
     before the "Summarizing" block are intermediate gate values — the parser
     must scope to the trailing summary, not the first match. */
  const stderr = `
[Parsed_ebur128_0 @ 0x55] t: 0.4 I: -22.3 LUFS
[Parsed_ebur128_0 @ 0x55] t: 1.4 I: -18.1 LUFS
[Parsed_ebur128_0 @ 0x55] t: 2.4 I: -17.0 LUFS
[Parsed_ebur128_0 @ 0x55] Summarizing
[Parsed_ebur128_0 @ 0x55]   Integrated loudness:
[Parsed_ebur128_0 @ 0x55]     I:         -16.0 LUFS
[Parsed_ebur128_0 @ 0x55]     Threshold: -26.1 LUFS
[Parsed_ebur128_0 @ 0x55]   Loudness range:
[Parsed_ebur128_0 @ 0x55]     LRA:        8.4 LU
[Parsed_ebur128_0 @ 0x55]     Threshold: -36.1 LUFS
[Parsed_ebur128_0 @ 0x55]     LRA low:   -21.0 LUFS
[Parsed_ebur128_0 @ 0x55]     LRA high:  -12.6 LUFS
[Parsed_ebur128_0 @ 0x55]   True peak:
[Parsed_ebur128_0 @ 0x55]     Peak:      -1.5 dBFS
`;
  const measurement = parseEbur128Summary(stderr);
  assert.equal(measurement.i, -16.0);
  assert.equal(measurement.lra, 8.4);
  assert.equal(measurement.tp, -1.5);
});

test('parseEbur128Summary coerces "-inf" peak to -Infinity (silent input)', () => {
  /* Dead-silent / near-silent MP3s report -inf for the integrated loudness
     and peak. The script wants the raw measurement through so the caller
     can decide whether to skip; the parser doesn't reject. */
  const stderr = `
[Parsed_ebur128_0 @ 0x55] Summarizing
[Parsed_ebur128_0 @ 0x55]   Integrated loudness:
[Parsed_ebur128_0 @ 0x55]     I:         -inf LUFS
[Parsed_ebur128_0 @ 0x55]     Threshold: -70.0 LUFS
[Parsed_ebur128_0 @ 0x55]   Loudness range:
[Parsed_ebur128_0 @ 0x55]     LRA:        0.0 LU
[Parsed_ebur128_0 @ 0x55]   True peak:
[Parsed_ebur128_0 @ 0x55]     Peak:      -inf dBFS
`;
  const measurement = parseEbur128Summary(stderr);
  assert.equal(measurement.i, -Infinity);
  assert.equal(measurement.lra, 0);
  assert.equal(measurement.tp, -Infinity);
});

test('parseEbur128Summary throws when there is no summary block', () => {
  /* Defends against the case where ffmpeg ran but exited before emitting
     the summary (e.g. malformed input file). Caller logs the failure and
     skips the chapter rather than silently writing NaN to the sidecar. */
  assert.throws(() => parseEbur128Summary('no ebur128 output here'), /Integrated loudness/);
});

test('iterChapters yields only MP3s that have a sibling .lufs.json', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'relufs-test-'));
  try {
    const books = join(tmp, 'books');
    const bookAAudio = join(books, 'Author A', 'Series One', 'Book Alpha', 'audio');
    const bookBAudio = join(books, 'Author B', 'Standalones', 'Book Beta', 'audio');
    mkdirSync(bookAAudio, { recursive: true });
    mkdirSync(bookBAudio, { recursive: true });

    /* Book A, chapter 1: MP3 + sidecar → yielded. */
    writeFileSync(join(bookAAudio, '01-intro.mp3'), 'mp3-bytes');
    writeFileSync(
      join(bookAAudio, '01-intro.lufs.json'),
      JSON.stringify({ i: -22.5, target: -16, twoPass: true }),
    );

    /* Book A, chapter 2: MP3 only (legacy / loudnorm disabled at render
       time) → NOT yielded. The backfill won't fabricate sidecars; it
       only refreshes ones that exist. */
    writeFileSync(join(bookAAudio, '02-no-sidecar.mp3'), 'mp3-bytes');

    /* Book B, chapter 1: MP3 + sidecar in a different author/series →
       yielded. Exercises the three-level <Author>/<Series>/<Book> walk. */
    writeFileSync(join(bookBAudio, '01-only.mp3'), 'mp3-bytes');
    writeFileSync(
      join(bookBAudio, '01-only.lufs.json'),
      JSON.stringify({ i: -18.0, target: -16, twoPass: true }),
    );

    /* A stray non-MP3 in the audio dir → ignored. */
    writeFileSync(join(bookAAudio, '01-intro.peaks.json'), '{"peaks": []}');

    const yielded = Array.from(iterChapters(books)).map((c) => c.mp3Path);
    assert.equal(yielded.length, 2);
    assert.ok(
      yielded.some((p) => p.endsWith(join('Book Alpha', 'audio', '01-intro.mp3'))),
      `expected Book Alpha intro to be yielded, got: ${yielded.join(', ')}`,
    );
    assert.ok(
      yielded.some((p) => p.endsWith(join('Book Beta', 'audio', '01-only.mp3'))),
      `expected Book Beta to be yielded, got: ${yielded.join(', ')}`,
    );
    assert.ok(
      !yielded.some((p) => p.includes('02-no-sidecar')),
      'chapter without a sibling .lufs.json must NOT be yielded',
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('iterChapters returns nothing when the books root does not exist', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'relufs-empty-'));
  try {
    /* No books/ subdirectory created — the walker must short-circuit
       without crashing. Fresh-clone workspaces hit this path. */
    const yielded = Array.from(iterChapters(join(tmp, 'books')));
    assert.deepEqual(yielded, []);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
