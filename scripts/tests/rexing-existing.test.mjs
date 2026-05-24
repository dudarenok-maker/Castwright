/* Companion to the plan 109 Xing-header repair script
   (`scripts/rexing-existing.mjs`). Covers:

   - hasXingHeaderInBuffer: the idempotency gate — detects a Xing/Info tag in
     the first MPEG frame (after skipping any ID3v2 tag) so already-tagged
     files are skipped on a re-run.
   - iterMp3s: workspace walker against a fixture <Author>/<Series>/<Book>
     tree → yields every *.mp3 (including .previous.mp3), ignores sidecars and
     the script's own .tmp-* droppings.

   We do NOT exercise main() end-to-end here — that needs real ffmpeg on
   synthetic MP3 bytes; the real-ffmpeg remux is covered by the live
   verification in the regression plan (docs/features/109-mp3-xing-vbr-header.md). */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { hasXingHeaderInBuffer, iterMp3s } from '../rexing-existing.mjs';

/* A minimal valid MPEG-2 Layer III frame header (0xFF 0xF3): version bits = 10
   (MPEG-2), layer bits = 01 (Layer III) — neither reserved, so findMpegSync
   accepts it. */
const FRAME = Buffer.from([0xff, 0xf3, 0x40, 0xc0]);

test('hasXingHeaderInBuffer detects a Xing tag in the first frame', () => {
  const buf = Buffer.concat([FRAME, Buffer.alloc(20), Buffer.from('Xing'), Buffer.alloc(100)]);
  assert.equal(hasXingHeaderInBuffer(buf), true);
});

test('hasXingHeaderInBuffer detects an Info tag (CBR) in the first frame', () => {
  const buf = Buffer.concat([FRAME, Buffer.alloc(20), Buffer.from('Info'), Buffer.alloc(100)]);
  assert.equal(hasXingHeaderInBuffer(buf), true);
});

test('hasXingHeaderInBuffer returns false when the frame carries no Xing/Info tag', () => {
  const buf = Buffer.concat([FRAME, Buffer.alloc(150)]);
  assert.equal(hasXingHeaderInBuffer(buf), false);
});

test('hasXingHeaderInBuffer skips a leading ID3v2 tag before finding the frame', () => {
  /* "ID3" + version(2) + flags(1) + synchsafe size(4)=0 → 10-byte tag. The
     Xing-bearing frame sits immediately after, so the gate must skip the tag
     to find it. */
  const id3 = Buffer.concat([
    Buffer.from('ID3'),
    Buffer.from([0x04, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]),
  ]);
  const buf = Buffer.concat([id3, FRAME, Buffer.alloc(20), Buffer.from('Xing'), Buffer.alloc(100)]);
  assert.equal(hasXingHeaderInBuffer(buf), true);
});

test('hasXingHeaderInBuffer returns false when there is no MPEG frame sync', () => {
  assert.equal(hasXingHeaderInBuffer(Buffer.from('not an mp3 at all')), false);
});

test('iterMp3s yields every *.mp3 (incl. .previous.mp3) and ignores sidecars + temp files', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'rexing-test-'));
  try {
    const books = join(tmp, 'books');
    const bookAAudio = join(books, 'Author A', 'Series One', 'Book Alpha', 'audio');
    const bookBAudio = join(books, 'Author B', 'Standalones', 'Book Beta', 'audio');
    mkdirSync(bookAAudio, { recursive: true });
    mkdirSync(bookBAudio, { recursive: true });

    /* Book A: a chapter MP3, its rollback copy, plus sidecars that must be
       ignored (no sidecar gate, unlike the relufs walker). */
    writeFileSync(join(bookAAudio, '01-intro.mp3'), 'mp3');
    writeFileSync(join(bookAAudio, '01-intro.previous.mp3'), 'mp3');
    writeFileSync(join(bookAAudio, '01-intro.segments.json'), '{}');
    writeFileSync(join(bookAAudio, '01-intro.peaks.json'), '{"peaks":[]}');
    writeFileSync(join(bookAAudio, '01-intro.lufs.json'), '{}');
    /* A stray temp dropping from an interrupted run — must NOT be re-picked. */
    writeFileSync(join(bookAAudio, '01-intro.mp3.tmp-123-456'), 'partial');

    /* Book B in a different author/series → exercises the 3-level walk. */
    writeFileSync(join(bookBAudio, '01-only.mp3'), 'mp3');

    const yielded = Array.from(iterMp3s(books)).map((c) => c.mp3Path);
    assert.equal(yielded.length, 3, `expected 3 mp3s, got: ${yielded.join(', ')}`);
    assert.ok(yielded.some((p) => p.endsWith(join('Book Alpha', 'audio', '01-intro.mp3'))));
    assert.ok(
      yielded.some((p) => p.endsWith(join('Book Alpha', 'audio', '01-intro.previous.mp3'))),
    );
    assert.ok(yielded.some((p) => p.endsWith(join('Book Beta', 'audio', '01-only.mp3'))));
    assert.ok(!yielded.some((p) => p.includes('.json')), 'sidecars must not be yielded');
    assert.ok(!yielded.some((p) => p.includes('.tmp-')), 'temp droppings must not be yielded');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('iterMp3s returns nothing when the books root does not exist', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'rexing-empty-'));
  try {
    assert.deepEqual(Array.from(iterMp3s(join(tmp, 'books'))), []);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
