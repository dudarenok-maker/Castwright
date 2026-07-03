# fs-54 — Audiobookshelf export robustness + Export status pill — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Harden the Audiobookshelf export hand-off (series metadata, an ABS-native `metadata.json` + folder cover, an M4B option, author-level folder nesting) and add a fourth global status pill — Export — mirroring the existing Analysis/Generation/Design pills, so export progress and completion are visible without babysitting the Listen view.

**Architecture:** Two independent halves sharing no new plumbing between them. Part 1 (server) extends three existing export builders (`build-m4b.ts`, `id3-tags.ts`, `build-mp3-folder.ts`) and one existing sync writer (`sync-folder.ts`) plus their sole caller (`routes/export.ts`); no wire-protocol change. Part 2 (frontend) adds a `linger` field + two reducers to the existing `exports-slice.ts`, a new middleware (`export-pill-middleware.ts`) modeled directly on `cast-design-stream-middleware.ts`, and a new pill consumer in `top-bar.tsx`/`layout.tsx`/`status-popover.tsx` mirroring the three pills already there.

**Tech Stack:** TypeScript, Express (server), React 18 + Redux Toolkit (frontend), Vitest (both), real-ffmpeg integration tests (server export builders).

## Global Constraints

- Cut a branch off `main` first, per `CLAUDE.md`'s branching workflow: `git switch -c feat/server+frontend-fs54-abs-export-status-pill`.
- Every task's tests follow the codebase's existing convention for that file — server export-builder tests spawn real ffmpeg/ffprobe (`describeIfFfmpeg`/`describeIf`, skip gracefully when absent); frontend tests use Vitest + React Testing Library + Redux `configureStore`.
- No `appHint` threading over the wire anywhere in this plan — every shared-builder change applies universally (all three folder-scanning tiles benefit), per the approved spec.
- The series-emission gate, used identically in every task that touches series metadata, is: **`state.isStandalone !== true && !!state.series?.trim()`** for whether to emit series at all, and **`state.seriesPosition != null`** (independently) for whether to emit a position/sequence sub-field. Never gate on presence of `state.series` alone — standalone books store a real (non-empty) string there.
- Design spec: `docs/superpowers/specs/2026-07-03-fs54-audiobookshelf-export-and-status-pill-design.md` (issue [#978](https://github.com/dudarenok-maker/Castwright/issues/978)).
- Run `npm run test:server` (Part 1 tasks) / `npm run test` (Part 2 tasks) after each task; run the full `npm run verify` before opening the PR.

---

## Part 1 — Audiobookshelf export robustness (server)

### Task 1: Series metadata in `buildFfmetadata` (M4B)

**Files:**
- Modify: `server/src/export/build-m4b.ts:148-197` (`buildFfmetadata`)
- Test: `server/src/export/build-m4b.test.ts`

**Interfaces:**
- Consumes: `BookStateJson.series: string`, `.seriesPosition: number | null`, `.isStandalone: boolean` (all already on the type, `server/src/workspace/scan.ts:45-58`).
- Produces: `buildFfmetadata`'s output now includes optional `grouping=`/`disc=` FFMETADATA lines, consumed downstream by `runFfmpegMux`'s `-map_metadata 1` (unchanged).

**Corrected during plan review, verified against real ffmpeg on this box (8.1.1):** an earlier draft of this task used `series=`/`series-part=` as the FFMETADATA keys, mirroring the ID3 approach in Task 2. That does **not** work for M4B — unlike the ID3 muxer (which falls back arbitrary unknown `-metadata` keys to a `TXXX` frame, confirmed working in Task 2), ffmpeg's **mov/mp4 muxer silently drops any `-metadata` key it doesn't recognize**, including a `----:com.apple.iTunes:series` freeform-atom attempt — both were empirically tested and neither survived into `ffprobe`'s `format.tags`. The mov muxer *does* recognize a fixed set of keys, including `grouping` (which becomes the standard `©grp` "Grouping" MP4 atom) and `disc` (`©disk`, "disc number") — both round-tripped correctly in testing. This task uses those instead:

- `grouping` carries the series **name**. There is no dedicated "series" atom in the MP4/iTunes tag vocabulary; `©grp` is the closest ffmpeg-recognized field for "which collection this belongs to" and at minimum survives into any general MP4 tag reader.
- `disc` carries the series **position** (`seriesPosition`) — repurposing "disc number of a set" for "book N of a series", the same kind of reasonable-adjacent-field reuse `©grp` already requires.
- **Caveat, stated plainly rather than assumed:** whether Audiobookshelf's own M4B parser specifically surfaces `grouping`/`disc` as series info is *not verified* — Audiobookshelf's documented, authoritative series channel is the `metadata.json` sidecar (Task 4, mp3-folder path only) and/or folder-name parsing, neither of which the M4B path touches. This task ships a real, non-dropped, standards-adjacent embedding for any MP4 tag reader; it is a best-effort improvement for the M4B format specifically, not a guaranteed Audiobookshelf-series-view win the way Task 4's sidecar is.

- [ ] **Step 1: Write the failing tests**

Add to `server/src/export/build-m4b.test.ts`, inside the existing `describeIfTools('buildM4b', ...)` block (after the last existing `it(...)`):

```ts
  it('omits grouping/disc for a standalone book (fs-54)', async () => {
    const out = join(tmpRoot, 'standalone.m4b');
    await buildM4b({ bookDir, state: makeState(), outPath: out });
    const tags = ffprobeJson(out).format.tags ?? {};
    expect(tags.grouping).toBeUndefined();
    expect(tags.disc).toBeUndefined();
  });

  it('emits grouping without disc when seriesPosition is null on a real series book (fs-54)', async () => {
    const out = join(tmpRoot, 'series-noseq.m4b');
    await buildM4b({
      bookDir,
      state: makeState({ series: 'The Coalfall Saga', seriesPosition: null, isStandalone: false }),
      outPath: out,
    });
    const tags = ffprobeJson(out).format.tags ?? {};
    expect(tags.grouping).toBe('The Coalfall Saga');
    expect(tags.disc).toBeUndefined();
  });

  it('emits grouping + disc when seriesPosition is set (fs-54)', async () => {
    const out = join(tmpRoot, 'series-seq.m4b');
    await buildM4b({
      bookDir,
      state: makeState({ series: 'The Coalfall Saga', seriesPosition: 2, isStandalone: false }),
      outPath: out,
    });
    const tags = ffprobeJson(out).format.tags ?? {};
    expect(tags.grouping).toBe('The Coalfall Saga');
    expect(tags.disc).toBe('2');
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd server && npx vitest run src/export/build-m4b.test.ts -t "fs-54"`
Expected: FAIL — `tags.grouping` is `undefined` in the second/third case (no grouping/disc lines emitted yet).

- [ ] **Step 3: Implement**

In `server/src/export/build-m4b.ts`, edit `buildFfmetadata` (currently lines 155-161, starting at `const artist = artistForExport(state);`):

```ts
  const artist = artistForExport(state);
  lines.push(`title=${escapeFfmetadata(state.title)}`);
  lines.push(`artist=${escapeFfmetadata(artist)}`);
  lines.push(`album=${escapeFfmetadata(state.title)}`);
  lines.push(`album_artist=${escapeFfmetadata(state.author)}`);
  if (state.genre) lines.push(`genre=${escapeFfmetadata(state.genre)}`);
  if (state.publicationDate) lines.push(`date=${escapeFfmetadata(state.publicationDate)}`);
  /* fs-54 — series metadata via the MP4 `grouping` (©grp) / `disc` (©disk)
     atoms — the closest ffmpeg-recognized fields for "which collection" /
     "position in that collection". There is no dedicated MP4 series atom,
     and an arbitrary `series=`/`series-part=` key (or a `----:` freeform
     atom) is silently dropped by ffmpeg's mov muxer (verified against real
     ffmpeg — unlike the ID3 muxer's TXXX fallback in id3-tags.ts, mov has
     no generic unknown-key fallback). Gate is `!isStandalone && !!series`,
     NOT presence of `series` alone: a standalone book still carries a real
     (non-empty) string in that field, so `isStandalone` — the codebase's
     own established discriminator (server/src/routes/cast-design.ts:555,
     qwen-voice.ts:565, single-design.ts:260) — is the correct gate. `disc`
     is an independently-optional sub-field: a real series book can have a
     null `seriesPosition` when its source has no numeric index
     (server/src/parsers/epub.ts). */
  const hasSeries = state.isStandalone !== true && !!state.series?.trim();
  if (hasSeries) {
    lines.push(`grouping=${escapeFfmetadata(state.series)}`);
    if (state.seriesPosition != null) {
      lines.push(`disc=${escapeFfmetadata(String(state.seriesPosition))}`);
    }
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd server && npx vitest run src/export/build-m4b.test.ts`
Expected: PASS (all tests in the file, including the 3 new ones).

- [ ] **Step 5: Commit**

```bash
git add server/src/export/build-m4b.ts server/src/export/build-m4b.test.ts
git commit -m "feat(server): series metadata in M4B FFMETADATA (fs-54)"
```

---

### Task 2: Series ID3 frame in `applyId3v24Tags`

**Files:**
- Modify: `server/src/export/id3-tags.ts`
- Test: `server/src/export/id3-tags.test.ts`

**Interfaces:**
- Produces: `Id3Tags` gains optional `series?: string | null` and `seriesPart?: number | null` fields, consumed by Task 3 (`build-mp3-folder.ts`).

- [ ] **Step 1: Write the failing tests**

Add to `server/src/export/id3-tags.test.ts`, inside the existing `describeIf('applyId3v24Tags', ...)` block:

```ts
  it('writes series + series-part as custom ID3v2 frames when both are set', async () => {
    const destPath = join(tmpDir, 'with-series.mp3');
    await applyId3v24Tags(srcPath, destPath, {
      title: 'Chapter 1',
      album: 'The Coalfall Saga: Book Two',
      artist: 'Jane Narrator',
      albumArtist: 'Some Author',
      track: 1,
      trackTotal: 3,
      series: 'The Coalfall Saga',
      seriesPart: 2,
    });
    const { tags } = await probe(destPath);
    expect(tags.series).toBe('The Coalfall Saga');
    expect(tags['series-part']).toBe('2');
  });

  it('omits series-part when only series is set', async () => {
    const destPath = join(tmpDir, 'series-no-part.mp3');
    await applyId3v24Tags(srcPath, destPath, {
      title: 'Chapter 1',
      album: 'Album',
      artist: 'Narrator',
      albumArtist: 'Author',
      track: 1,
      trackTotal: 1,
      series: 'The Coalfall Saga',
    });
    const { tags } = await probe(destPath);
    expect(tags.series).toBe('The Coalfall Saga');
    expect(tags['series-part']).toBeUndefined();
  });

  it('omits series entirely when not provided', async () => {
    const destPath = join(tmpDir, 'no-series.mp3');
    await applyId3v24Tags(srcPath, destPath, {
      title: 'Chapter 1',
      album: 'Album',
      artist: 'Narrator',
      albumArtist: 'Author',
      track: 1,
      trackTotal: 1,
    });
    const { tags } = await probe(destPath);
    expect(tags.series).toBeUndefined();
    expect(tags['series-part']).toBeUndefined();
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd server && npx vitest run src/export/id3-tags.test.ts -t "series"`
Expected: FAIL with a TypeScript error (`series` not a known property of the tags argument) or, once that's stubbed, `tags.series` undefined.

- [ ] **Step 3: Implement**

In `server/src/export/id3-tags.ts`:

```ts
/* ID3v2.4 re-tagger. Takes an existing MP3 on disk, writes a new MP3 to
   `destPath` with the supplied tags and the input's audio frames copied
   byte-for-byte (`-c:a copy`). No re-encode — the LAME VBR V2 bytes
   produced by encodePcmToAudio survive intact.

   ffmpeg strips inbound MP3 tags by default when remuxing to mp3, so the
   destination ends up with only the tags we pass via `-metadata`. We
   suppress the ID3v1 trailer (deprecated, capped at 30-char fields) and
   pin to ID3v2.4 — PocketBook Reader on Android reads v2.3/2.4 fine.

   Tag mapping:
     title        → TIT2 (chapter title)
     album        → TALB (book title)
     artist       → TPE1 (narrator credit, falling back to author)
     album_artist → TPE2 (author)
     track        → TRCK ("N/total")
     genre        → TCON
     date         → TDRC (YYYY or YYYY-MM-DD)
     series       → TXXX:series (fs-54 — ID3v2 has no first-class series
                    frame; ffmpeg's mp3 muxer maps an unrecognized
                    `-metadata` key to a TXXX frame keyed by that name)
     seriesPart   → TXXX:series-part (fs-54, same mechanism)
     cover (opt)  → APIC (embedded JPEG/PNG, attached_pic disposition) */

import { spawn } from 'node:child_process';

export interface Id3Tags {
  title: string;
  album: string;
  artist: string;
  albumArtist: string;
  track: number;
  trackTotal: number;
  genre?: string | null;
  date?: string | null;
  /** fs-54 — series name; omitted entirely (not written) when absent. */
  series?: string | null;
  /** fs-54 — series position/sequence; only meaningful (and only ever
      written) alongside a non-null `series`. */
  seriesPart?: number | null;
  /** Optional free-form comment written to the ID3v2 COMM frame.
      When set, ffmpeg emits `-metadata comment=<value>`.
      Intended for the "Rendered with Castwright · castwright.ai" stamp. */
  comment?: string | null;
}
```

Then, in `applyId3v24Tags`, after the existing `if (tags.genre)` / `if (tags.date)` lines and before `if (tags.comment)`:

```ts
  if (tags.genre) args.push('-metadata', `genre=${tags.genre}`);
  if (tags.date) args.push('-metadata', `date=${tags.date}`);
  if (tags.series) {
    args.push('-metadata', `series=${tags.series}`);
    if (tags.seriesPart != null) args.push('-metadata', `series-part=${tags.seriesPart}`);
  }
  if (tags.comment) args.push('-metadata', `comment=${tags.comment}`);
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd server && npx vitest run src/export/id3-tags.test.ts`
Expected: PASS (all tests in the file).

- [ ] **Step 5: Commit**

```bash
git add server/src/export/id3-tags.ts server/src/export/id3-tags.test.ts
git commit -m "feat(server): series ID3 frame in applyId3v24Tags (fs-54)"
```

---

### Task 3: Thread series into `buildMp3Folder`'s per-chapter tags

**Files:**
- Modify: `server/src/export/build-mp3-folder.ts:96-107`
- Test: `server/src/export/build-mp3-folder.test.ts`

**Interfaces:**
- Consumes: `Id3Tags.series`/`.seriesPart` from Task 2.

- [ ] **Step 1: Write the failing test**

Add to `server/src/export/build-mp3-folder.test.ts`, inside the existing `describeIfFfmpeg('buildMp3Folder', ...)` block. Reuse the `readId3Frame` helper already in the file, extended for a custom frame — add this small addition right after the existing `readId3Frame` function:

```ts
function readId3TxxxFrame(mp3: Buffer, description: string): string | null {
  if (mp3[0] !== 0x49 || mp3[1] !== 0x44 || mp3[2] !== 0x33) return null;
  const tagSize =
    ((mp3[6] & 0x7f) << 21) | ((mp3[7] & 0x7f) << 14) | ((mp3[8] & 0x7f) << 7) | (mp3[9] & 0x7f);
  let p = 10;
  while (p < 10 + tagSize - 10) {
    const frameId = mp3.subarray(p, p + 4).toString('latin1');
    const frameSize = mp3.readUInt32BE(p + 4);
    if (frameSize === 0) break;
    if (frameId === 'TXXX') {
      const enc = mp3[p + 10];
      const body = mp3.subarray(p + 11, p + 10 + frameSize);
      const nul = enc === 1 ? body.indexOf(Buffer.from([0, 0])) : body.indexOf(0);
      if (nul >= 0) {
        const descBytes = body.subarray(0, nul);
        const desc = enc === 3 || enc === 0 ? descBytes.toString('latin1') : descBytes.toString('utf16le');
        if (desc === description) {
          const valueBytes = body.subarray(nul + (enc === 1 ? 2 : 1));
          return (enc === 3 || enc === 0
            ? valueBytes.toString('latin1')
            : valueBytes.toString('utf16le')
          ).replace(/\0+$/, '');
        }
      }
    }
    p += 10 + frameSize;
  }
  return null;
}
```

Then add the test itself:

```ts
  it('writes series + series-part TXXX frames when the book is in a series (fs-54)', async () => {
    const outDir = join(tmpRoot, 'export-series', 'Book Two');
    await buildMp3Folder({
      bookDir,
      state: makeState({ series: 'The Coalfall Saga', seriesPosition: 2, isStandalone: false }),
      outDir,
    });
    const names = readdirSync(outDir)
      .filter((n) => n.endsWith('.mp3'))
      .sort();
    const ch1 = readFileSync(join(outDir, names[0]));
    expect(readId3TxxxFrame(ch1, 'series')).toBe('The Coalfall Saga');
    expect(readId3TxxxFrame(ch1, 'series-part')).toBe('2');
  });

  it('omits series TXXX frames for a standalone book (fs-54)', async () => {
    const outDir = join(tmpRoot, 'export-no-series', 'the Coalfall Commission');
    await buildMp3Folder({ bookDir, state: makeState(), outDir });
    const names = readdirSync(outDir)
      .filter((n) => n.endsWith('.mp3'))
      .sort();
    const ch1 = readFileSync(join(outDir, names[0]));
    expect(readId3TxxxFrame(ch1, 'series')).toBeNull();
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd server && npx vitest run src/export/build-mp3-folder.test.ts -t "fs-54"`
Expected: FAIL — `readId3TxxxFrame(ch1, 'series')` returns `null` for the series case (no `series`/`seriesPart` threaded into `Id3Tags` yet).

- [ ] **Step 3: Implement**

In `server/src/export/build-mp3-folder.ts`, in `buildMp3Folder`, right after the existing `const album = state.title;` line (currently line 73), add:

```ts
  /* fs-54 — same series gate as buildFfmetadata (build-m4b.ts). */
  const hasSeries = state.isStandalone !== true && !!state.series?.trim();
```

Then edit the `Id3Tags` object construction (currently lines 96-106):

```ts
    const tags: Id3Tags = {
      title: chapter.title,
      album,
      artist,
      albumArtist,
      track: i + 1,
      trackTotal: total,
      genre: state.genre ?? null,
      date: state.publicationDate ?? null,
      series: hasSeries ? state.series : null,
      seriesPart: hasSeries ? state.seriesPosition : null,
      comment: 'Rendered with Castwright · castwright.ai',
    };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd server && npx vitest run src/export/build-mp3-folder.test.ts`
Expected: PASS (all tests in the file).

- [ ] **Step 5: Commit**

```bash
git add server/src/export/build-mp3-folder.ts server/src/export/build-mp3-folder.test.ts
git commit -m "feat(server): thread series metadata into mp3-folder chapter tags (fs-54)"
```

---

### Task 4: `metadata.json` + folder-level `cover.jpg` for every mp3-folder export

**Files:**
- Modify: `server/src/export/build-mp3-folder.ts`
- Test: `server/src/export/build-mp3-folder.test.ts`

**Interfaces:**
- Consumes: `bookStateLanguage(state)` from `server/src/workspace/scan.ts:262-264`; `DEFAULT_NARRATOR_CREDIT` from `server/src/export/narrator-credit.ts:9`.
- Produces: `<outDir>/metadata.json` and (when a cover exists) `<outDir>/cover.jpg`, written into the same staging directory the per-chapter MP3s land in.

- [ ] **Step 1: Write the failing tests**

Add to `server/src/export/build-mp3-folder.test.ts`:

```ts
  describe('Audiobookshelf sidecars (fs-54)', () => {
    it('writes metadata.json with core fields and no series for a standalone book', async () => {
      const outDir = join(tmpRoot, 'export-meta-standalone', 'the Coalfall Commission');
      await buildMp3Folder({ bookDir, state: makeState(), outDir });
      const meta = JSON.parse(readFileSync(join(outDir, 'metadata.json'), 'utf8'));
      expect(meta.title).toBe('the Coalfall Commission');
      expect(meta.authors).toEqual(['Della Renwick']);
      expect(meta.narrators).toEqual(['Anders Vale']);
      expect(meta.genres).toEqual(['Fantasy']);
      expect(meta.language).toBe('en');
      expect(meta.series).toBeUndefined();
    });

    it('includes a series entry without sequence when seriesPosition is null on a real series book', async () => {
      const outDir = join(tmpRoot, 'export-meta-series-noseq', 'Book Two');
      await buildMp3Folder({
        bookDir,
        state: makeState({ series: 'The Coalfall Saga', seriesPosition: null, isStandalone: false }),
        outDir,
      });
      const meta = JSON.parse(readFileSync(join(outDir, 'metadata.json'), 'utf8'));
      expect(meta.series).toEqual([{ name: 'The Coalfall Saga' }]);
    });

    it('includes series + sequence when seriesPosition is set', async () => {
      const outDir = join(tmpRoot, 'export-meta-series-seq', 'Book Two');
      await buildMp3Folder({
        bookDir,
        state: makeState({ series: 'The Coalfall Saga', seriesPosition: 2, isStandalone: false }),
        outDir,
      });
      const meta = JSON.parse(readFileSync(join(outDir, 'metadata.json'), 'utf8'));
      expect(meta.series).toEqual([{ name: 'The Coalfall Saga', sequence: 2 }]);
    });

    it('omits narrators when narratorCredit is the Castwright brand default', async () => {
      const outDir = join(tmpRoot, 'export-meta-brand-narrator', 'the Coalfall Commission');
      await buildMp3Folder({ bookDir, state: makeState({ narratorCredit: 'Castwright' }), outDir });
      const meta = JSON.parse(readFileSync(join(outDir, 'metadata.json'), 'utf8'));
      expect(meta.narrators).toEqual([]);
    });

    it('copies cover.jpg into outDir when a cover exists on disk', async () => {
      /* Must be a real, decodable JPEG — buildMp3Folder feeds coverJpegPath
         into ffmpeg as an -i input for every chapter's APIC frame (existing
         behavior, unchanged by this task), and ffmpeg rejects a bogus image
         before writeAudiobookshelfSidecars ever runs. Same 1x1 JPEG fixture
         already used by id3-tags.test.ts's cover-embedding tests. */
      const jpegBytes = Buffer.from(
        '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEB' +
          'AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEB/9sAQwEBAQEBAQEBAQEBAQEB' +
          'AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEB' +
          '/8AAEQgAAQABAwERAAIRAQMRAf/EABQAAQAAAAAAAAAAAAAAAAAAAAj/xAAUAQEAAAAAAAAA' +
          'AAAAAAAAAAAA/8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAwDAQACEQMRAD8Aov8A/9k=',
        'base64',
      );
      mkdirSync(join(bookDir, '.audiobook'), { recursive: true });
      const coverSrc = join(bookDir, '.audiobook', 'cover.jpg');
      writeFileSync(coverSrc, jpegBytes);
      try {
        const outDir = join(tmpRoot, 'export-meta-cover', 'the Coalfall Commission');
        await buildMp3Folder({ bookDir, state: makeState(), outDir });
        expect(existsSync(join(outDir, 'cover.jpg'))).toBe(true);
      } finally {
        rmSync(coverSrc, { force: true });
      }
    });

    it('omits cover.jpg when no cover exists on disk', async () => {
      const outDir = join(tmpRoot, 'export-meta-no-cover', 'the Coalfall Commission');
      await buildMp3Folder({ bookDir, state: makeState(), outDir });
      expect(existsSync(join(outDir, 'cover.jpg'))).toBe(false);
    });
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd server && npx vitest run src/export/build-mp3-folder.test.ts -t "Audiobookshelf sidecars"`
Expected: FAIL — `readFileSync(join(outDir, 'metadata.json'), ...)` throws ENOENT (the file doesn't exist yet).

- [ ] **Step 3: Implement**

In `server/src/export/build-mp3-folder.ts`, update the imports:

```ts
import { stat, mkdir, rm, writeFile, copyFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { audioDir, coverImagePath } from '../workspace/paths.js';
import { findChapterAudio } from '../workspace/chapter-audio-file.js';
import { applyId3v24Tags, type Id3Tags } from './id3-tags.js';
import { ExportIncompleteError, pad2, sanitiseForZip } from './build-mp3-zip.js';
import { DEFAULT_NARRATOR_CREDIT, artistForExport } from './narrator-credit.js';
import { bookStateLanguage, type BookStateJson } from '../workspace/scan.js';
```

Then, at the end of `buildMp3Folder` — replace:

```ts
    entries.push(taggedPath);
    onProgress?.((i + 1) / total);
  }

  return { totalBytes, entries };
}
```

with:

```ts
    entries.push(taggedPath);
    onProgress?.((i + 1) / total);
  }

  /* fs-54 — written into every mp3-folder export (all three folder-scanning
     tiles get it, not just Audiobookshelf — Smart AudioBook Player /
     BookPlayer simply ignore the two extra files). Must run after the
     rm(outDir)-then-recreate above, which it does — this call is the last
     thing in the function. */
  await writeAudiobookshelfSidecars({ state, outDir, coverJpegPath });

  return { totalBytes, entries };
}

/* fs-54 — Audiobookshelf's own preferred metadata source: a `metadata.json`
   at the book-folder root, which ABS treats as authoritative over embedded
   ID3 tags when both are present. Folder-level `cover.jpg` sits alongside
   it, copied from the same source the per-chapter APIC frames already use.
   Series gate mirrors buildFfmetadata's (build-m4b.ts): `!isStandalone &&
   !!series`, never presence of `series` alone. */
async function writeAudiobookshelfSidecars(opts: {
  state: BookStateJson;
  outDir: string;
  coverJpegPath: string | null;
}): Promise<void> {
  const { state, outDir, coverJpegPath } = opts;
  const hasSeries = state.isStandalone !== true && !!state.series?.trim();
  const humanNarrator = state.narratorCredit?.trim();
  const narrators =
    humanNarrator && humanNarrator !== DEFAULT_NARRATOR_CREDIT ? [humanNarrator] : [];
  const description = state.description?.trim();
  const publishedYear = state.publicationDate ? parsePublishedYear(state.publicationDate) : null;

  const metadata: Record<string, unknown> = {
    title: state.title,
    authors: [state.author],
    narrators,
    genres: state.genre ? [state.genre] : [],
    language: bookStateLanguage(state),
  };
  if (hasSeries) {
    const seriesEntry: { name: string; sequence?: number } = { name: state.series };
    if (state.seriesPosition != null) seriesEntry.sequence = state.seriesPosition;
    metadata.series = [seriesEntry];
  }
  if (description) metadata.description = description;
  if (publishedYear != null) metadata.publishedYear = publishedYear;

  await writeFile(join(outDir, 'metadata.json'), JSON.stringify(metadata, null, 2), 'utf8');

  if (coverJpegPath) {
    await copyFile(coverJpegPath, join(outDir, 'cover.jpg'));
  }
}

/** Parses the leading 4-digit year out of a publicationDate string (e.g.
    "2026" or "2026-06-01") — metadata.json's `publishedYear` is a bare
    number, unlike the free-form ID3/FFMETADATA `date` string. Returns null
    when no 4-digit year can be found rather than emitting a wrong value. */
function parsePublishedYear(publicationDate: string): number | null {
  const match = publicationDate.match(/\d{4}/);
  return match ? Number(match[0]) : null;
}
```

(`artistForExport` stays imported and used exactly as before, higher up in `buildMp3Folder` — this edit only adds `DEFAULT_NARRATOR_CREDIT` alongside it.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd server && npx vitest run src/export/build-mp3-folder.test.ts`
Expected: PASS (all tests in the file, including every prior task's cases).

- [ ] **Step 5: Commit**

```bash
git add server/src/export/build-mp3-folder.ts server/src/export/build-mp3-folder.test.ts
git commit -m "feat(server): metadata.json + folder cover.jpg for mp3-folder exports (fs-54)"
```

---

### Task 5: `writeFolderToSyncFolder` copy-filter allowlist

**Files:**
- Modify: `server/src/export/sync-folder.ts:77-82`
- Test: `server/src/export/sync-folder.test.ts`

**Interfaces:**
- Produces: `writeFolderToSyncFolder` now also copies `metadata.json`/`cover.jpg` (Task 4's output) into the sync destination — without this, they're built into staging and then silently dropped.

- [ ] **Step 1: Write the failing tests**

`sync-folder.test.ts` currently has no coverage at all for `writeFolderToSyncFolder` (only `writeToSyncFolder`). Update the two existing top-of-file imports:

```ts
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
```

```ts
import { writeToSyncFolder, writeFolderToSyncFolder } from './sync-folder.js';
```

Then add a new top-level `describe` block:

```ts
describe('writeFolderToSyncFolder', () => {
  let tmpRoot: string;
  let srcDir: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'sync-folder-dir-'));
    srcDir = join(tmpRoot, 'staging');
    mkdirSync(srcDir, { recursive: true });
    writeFileSync(join(srcDir, '01 - Chapter One.mp3'), 'mp3-bytes-1');
    writeFileSync(join(srcDir, '02 - Chapter Two.mp3'), 'mp3-bytes-2');
  });

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('copies every .mp3 into <destDir>/<bookSubfolder>/', async () => {
    const destDir = join(tmpRoot, 'sync');
    const result = await writeFolderToSyncFolder(srcDir, destDir, 'The Coalfall Commission');
    expect(result.copied).toBe(2);
    const names = readdirSync(result.syncPath).sort();
    expect(names).toEqual(['01 - Chapter One.mp3', '02 - Chapter Two.mp3']);
  });

  it('copies metadata.json and cover.jpg through the allowlist (fs-54)', async () => {
    writeFileSync(join(srcDir, 'metadata.json'), '{"title":"x"}');
    writeFileSync(join(srcDir, 'cover.jpg'), 'jpeg-bytes');
    const destDir = join(tmpRoot, 'sync');
    const result = await writeFolderToSyncFolder(srcDir, destDir, 'The Coalfall Commission');
    expect(result.copied).toBe(4);
    const names = readdirSync(result.syncPath).sort();
    expect(names).toEqual([
      '01 - Chapter One.mp3',
      '02 - Chapter Two.mp3',
      'cover.jpg',
      'metadata.json',
    ]);
  });

  it('excludes an unrelated stray file that is neither .mp3 nor an allowlisted sidecar', async () => {
    writeFileSync(join(srcDir, 'README.txt'), 'not for shipping');
    const destDir = join(tmpRoot, 'sync');
    const result = await writeFolderToSyncFolder(srcDir, destDir, 'The Coalfall Commission');
    expect(result.copied).toBe(2);
    expect(existsSync(join(result.syncPath, 'README.txt'))).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd server && npx vitest run src/export/sync-folder.test.ts -t "fs-54"`
Expected: FAIL — `result.copied` is `2` (metadata.json/cover.jpg dropped by the current `.mp3`-only filter), not `4`.

- [ ] **Step 3: Implement**

In `server/src/export/sync-folder.ts`, edit `writeFolderToSyncFolder`'s loop (currently lines 77-82):

```ts
  const entries = await readdir(srcDir);
  let copied = 0;
  for (const name of entries) {
    /* fs-54 — allowlist, not a bare extension check. Per-chapter MP3s are
       always eligible; `metadata.json` + `cover.jpg` are the Audiobookshelf
       sidecars build-mp3-folder.ts now writes into every mp3-folder export's
       staging dir (all three folder-scanning tiles get them — Smart
       AudioBook Player / BookPlayer just ignore the extras). Anything else
       (a stray README, a future cuesheet) still doesn't leak into the sync
       target. */
    const lower = name.toLowerCase();
    const isAllowed = lower.endsWith('.mp3') || name === 'metadata.json' || name === 'cover.jpg';
    if (!isAllowed) continue;
    const src = join(srcDir, name);
    const finalPath = join(targetDir, basename(name));
    const tmpPath = `${finalPath}.tmp-${process.pid}-${Date.now()}-${copied}`;
    await copyFile(src, tmpPath);
    try {
      await renameWithRetry(tmpPath, finalPath);
    } catch (e) {
      await unlink(tmpPath).catch(() => {});
      throw wrapWithSyncHint(e, targetDir);
    }
    copied++;
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd server && npx vitest run src/export/sync-folder.test.ts`
Expected: PASS (all tests in the file).

- [ ] **Step 5: Commit**

```bash
git add server/src/export/sync-folder.ts server/src/export/sync-folder.test.ts
git commit -m "fix(server): stop dropping metadata.json/cover.jpg during sync-folder copy (fs-54)"
```

---

### Task 6: Author-level folder nesting for every sync-folder destination

**Files:**
- Modify: `server/src/routes/export.ts:518-522,564-567`
- Test: `server/src/routes/export.test.ts`

**Interfaces:**
- Consumes: `writeFolderToSyncFolder`/`writeToSyncFolder` signatures unchanged (both already take a `destDir` argument); `sanitiseForZip` already imported at `export.ts:35`.

- [ ] **Step 1: Write the failing tests**

Add to `server/src/routes/export.test.ts`, inside the existing `describeIfFfmpeg('POST /api/books/:bookId/exports + GET status + download', ...)` block:

```ts
  it('nests an mp3-folder sync-folder export under a sanitized author subfolder (fs-54)', async () => {
    const { writeUserSettings } = await import('../workspace/user-settings.js');
    const { sanitiseForZip } = await import('../export/build-mp3-zip.js');
    const syncRoot = mkdtempSync(join(tmpdir(), 'export-sync-author-'));
    try {
      await writeUserSettings({ exportSyncFolder: syncRoot });

      const create = await request(app)
        .post(`/api/books/${bookId}/exports`)
        .send({ format: 'mp3-folder', destination: 'sync-folder' });
      expect(create.status).toBe(201);

      const { body: done } = await waitForDone(create.body.id as string);
      expect(done.status).toBe('done');

      const expectedDir = join(syncRoot, sanitiseForZip(AUTHOR), sanitiseForZip(TITLE));
      expect(done.syncPath).toBe(expectedDir);
      expect(existsSync(join(expectedDir, 'metadata.json'))).toBe(true);
    } finally {
      rmSync(syncRoot, { recursive: true, force: true });
      await writeUserSettings({ exportSyncFolder: null });
    }
  });

  it('nests a single-file (M4B) sync-folder export under a sanitized author subfolder (fs-54)', async () => {
    const { writeUserSettings } = await import('../workspace/user-settings.js');
    const { sanitiseForZip } = await import('../export/build-mp3-zip.js');
    const syncRoot = mkdtempSync(join(tmpdir(), 'export-sync-author-m4b-'));
    try {
      await writeUserSettings({ exportSyncFolder: syncRoot });

      const create = await request(app)
        .post(`/api/books/${bookId}/exports`)
        .send({ format: 'm4b', destination: 'sync-folder' });
      expect(create.status).toBe(201);

      const { body: done } = await waitForDone(create.body.id as string);
      expect(done.status).toBe('done');

      const expectedPath = join(syncRoot, sanitiseForZip(AUTHOR), done.filename as string);
      expect(done.syncPath).toBe(expectedPath);
      expect(existsSync(expectedPath)).toBe(true);
    } finally {
      rmSync(syncRoot, { recursive: true, force: true });
      await writeUserSettings({ exportSyncFolder: null });
    }
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd server && npx vitest run src/routes/export.test.ts -t "fs-54"`
Expected: FAIL — `done.syncPath` is `join(syncRoot, sanitiseForZip(TITLE))` / `join(syncRoot, done.filename)` (no author segment yet), not matching `expectedDir`/`expectedPath`.

- [ ] **Step 3: Implement**

In `server/src/routes/export.ts`, inside `runExportJob`, edit the mp3-folder sync branch (currently lines 518-522):

```ts
      if (syncFolder) {
        /* fs-54 — author-level nesting, applied to every sync-folder
           destination (this branch AND the single-file branch below), not
           just Audiobookshelf — keeps behavior consistent across every
           export tile and needs no wire-protocol change: `state.author`
           is already in scope here. */
        const authoredSyncDir = join(syncFolder, sanitiseForZip(state.author));
        const bookSubfolder = sanitiseForZip(state.title);
        const synced = await writeFolderToSyncFolder(outPath, authoredSyncDir, bookSubfolder);
        job.syncPath = synced.syncPath;
      }
```

And the single-file sync branch (currently lines 564-567):

```ts
      if (job.destination === 'sync-folder' && syncFolder) {
        const authoredSyncDir = join(syncFolder, sanitiseForZip(state.author));
        const synced = await writeToSyncFolder(outPath, authoredSyncDir, job.filename);
        job.syncPath = synced.syncPath;
      }
```

(No new imports needed — `join` and `sanitiseForZip` are already imported at the top of `export.ts`.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd server && npx vitest run src/routes/export.test.ts`
Expected: PASS (all tests in the file — including the pre-existing ones, which use a flat `syncFolder` path in assertions only where destination is `download`, unaffected by this change).

- [ ] **Step 5: Commit**

```bash
git add server/src/routes/export.ts server/src/routes/export.test.ts
git commit -m "feat(server): nest sync-folder exports under an author subfolder (fs-54)

BREAKING: sync-folder exports (mp3-folder AND single-file M4B/zip) now
land at <syncFolder>/<author>/... instead of flat <syncFolder>/...
Existing Voice-tile/mp3-zip sync-folder users see their next export
land one level deeper — call out in release notes."
```

---

### Task 7: Audiobookshelf tile format toggle (mp3-folder ⇄ M4B)

**Files:**
- Modify: `src/modals/export-audiobook.tsx`
- Test: `src/modals/export-audiobook.test.tsx`

**Interfaces:**
- Consumes: nothing new — reuses the modal's existing `format`/`setFormat` state and the `BookExportRequest['format']` wire type.

- [ ] **Step 1: Write the failing tests**

Add to `src/modals/export-audiobook.test.tsx` (new top-level `describe` block, after the existing "Voice mode" block):

```tsx
describe('ExportAudiobookModal — Audiobookshelf format toggle (fs-54)', () => {
  it('shows an MP3 folder / M4B toggle', () => {
    renderModal({
      prefill: { format: 'mp3-folder', destination: 'sync-folder', appHint: 'audiobookshelf' },
    });
    expect(screen.getByTestId('export-tile-body-audiobookshelf')).toBeInTheDocument();
    expect(screen.getByTestId('export-tile-format-mp3-folder')).toBeInTheDocument();
    expect(screen.getByTestId('export-tile-format-m4b')).toBeInTheDocument();
  });

  it('switches the submitted format to m4b when the toggle is clicked', async () => {
    mockedApi.createBookExport.mockResolvedValue(makeJob({ status: 'in_progress', progress: 0 }));

    render(
      <Provider store={makeStoreWithSyncFolder('C:\\Users\\me\\OneDrive\\Audiobooks')}>
        <ExportAudiobookModal
          open={true}
          bookId="demo__sa__test"
          prefill={{ format: 'mp3-folder', destination: 'sync-folder', appHint: 'audiobookshelf' }}
          onClose={vi.fn()}
        />
      </Provider>,
    );
    fireEvent.click(screen.getByTestId('export-tile-format-m4b'));
    fireEvent.click(screen.getByTestId('export-submit'));
    await waitFor(() => {
      expect(mockedApi.createBookExport).toHaveBeenCalledWith(
        'demo__sa__test',
        expect.objectContaining({ format: 'm4b', destination: 'sync-folder' }),
      );
    });
  });

  it('does not show the format toggle on a tile without formatOptions (e.g. Voice)', () => {
    renderModal({ prefill: { format: 'm4b', destination: 'sync-folder', appHint: 'voice' } });
    expect(screen.queryByTestId('export-tile-format-toggle')).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/modals/export-audiobook.test.tsx -t "fs-54"`
Expected: FAIL — `getByTestId('export-tile-format-mp3-folder')` throws (the toggle doesn't exist yet).

- [ ] **Step 3: Implement**

In `src/modals/export-audiobook.tsx`, edit the `TileHint` interface (currently lines 78-89) to add an optional field:

```ts
interface TileHint {
  format: FormatId;
  destination: TabId;
  headerTitle: string;
  submitLabel: string;
  footerNote: string;
  bodyIntro: string;
  folderInputLabel: string;
  /** Caption shown above the input when a sync folder is already
      configured. Receives the saved path so the copy can name it. */
  savedCaption: (savedPath: string) => string;
  /** fs-54 — when set, TileBody renders a small format toggle (mp3-folder
      vs m4b today) instead of collapsing to the single fixed `format`
      above. Currently only the Audiobookshelf tile uses this — every
      other tile keeps its one fixed shape. */
  formatOptions?: Array<{ id: FormatId; label: string }>;
}
```

Update the `audiobookshelf` entry in `TILE_HINTS` (currently lines 130-142):

```ts
  audiobookshelf: {
    format: 'mp3-folder',
    destination: 'sync-folder',
    headerTitle: 'Send to Audiobookshelf',
    submitLabel: 'Export to Audiobookshelf library',
    footerNote:
      'Audiobookshelf rescans its library on a schedule — the new book appears after the next scan once your sync finishes pushing it.',
    bodyIntro:
      "Audiobookshelf scans a configured library root on the server and treats each subfolder as one book. Point this at the same folder your sync app mirrors to the server's library path. Pick M4B for one chaptered file, or MP3 folder for per-chapter files with a metadata.json Audiobookshelf reads directly — either way, chapters, cover, and series arrive tagged and ready.",
    folderInputLabel: 'Audiobookshelf library folder',
    savedCaption: (saved) => `Saves to your Audiobookshelf library at ${saved}.`,
    formatOptions: [
      { id: 'mp3-folder', label: 'MP3 folder' },
      { id: 'm4b', label: 'M4B' },
    ],
  },
```

Update `TileBodyProps` (currently lines 648-651):

```ts
interface TileBodyProps extends SyncFolderTabProps {
  hint: TileHint;
  hintKey: string;
  /** fs-54 — only rendered when hint.formatOptions is set. */
  format: FormatId;
  setFormat: (next: FormatId) => void;
}
```

Update the `TileBody` function signature and body (currently lines 652-699) — add `format, setFormat` to the destructure and render the toggle right after the intro paragraph:

```tsx
function TileBody({
  hint,
  hintKey,
  format,
  setFormat,
  draft,
  setDraft,
  saved,
  saving,
  onSave,
  onBlur,
  saveError,
}: TileBodyProps) {
  const isDirty = (saved ?? '') !== draft;
  const bodyTestId = hintKey === 'voice' ? 'export-voice-body' : `export-tile-body-${hintKey}`;
  const captionTestId =
    hintKey === 'voice' ? 'export-voice-caption' : `export-tile-caption-${hintKey}`;
  return (
    <div className="space-y-3" data-testid={bodyTestId}>
      <p>{hint.bodyIntro}</p>
      {hint.formatOptions && (
        <div
          className="flex items-center gap-1 bg-ink/4 rounded-full p-0.5 text-xs w-fit"
          data-testid="export-tile-format-toggle"
        >
          {hint.formatOptions.map((opt) => (
            <button
              key={opt.id}
              type="button"
              data-testid={`export-tile-format-${opt.id}`}
              onClick={() => setFormat(opt.id)}
              className={`px-3 py-1.5 rounded-full font-medium transition-colors ${format === opt.id ? 'bg-white text-ink shadow-card' : 'text-ink/60'}`}
            >
              {opt.label}
            </button>
          ))}
        </div>
      )}
      {saved && !isDirty ? (
        <p className="text-xs text-ink/55" data-testid={captionTestId}>
          {hint.savedCaption(saved)}
        </p>
      ) : null}
      <label className="block">
        <span className="text-[11px] uppercase tracking-wider text-ink/50 font-semibold">
          {hint.folderInputLabel}
        </span>
        <input
          type="text"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={onBlur}
          placeholder="C:\Users\you\OneDrive\Audiobooks"
          className="mt-1 w-full px-3 py-2 rounded-xl bg-canvas border border-ink/10 text-sm text-ink focus:outline-hidden focus:border-ink/30 font-mono"
          aria-label={hint.folderInputLabel}
          data-testid="sync-folder-input"
        />
      </label>
      <SyncFolderControls
        draft={draft}
        isDirty={isDirty}
        saving={saving}
        onSave={onSave}
        saveError={saveError}
      />
    </div>
  );
}
```

Update the `<TileBody .../>` call site inside `ExportAudiobookModal` (currently lines 411-422) to pass the two new props:

```tsx
            {tileHint ? (
              <TileBody
                hint={tileHint}
                hintKey={prefill?.appHint as string}
                format={format}
                setFormat={setFormat}
                draft={syncFolderDraft}
                setDraft={setSyncFolderDraft}
                saved={syncFolder}
                saving={syncFolderSaving}
                onSave={handleSaveSyncFolder}
                onBlur={handleSyncFolderBlur}
                saveError={account.error}
              />
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/modals/export-audiobook.test.tsx`
Expected: PASS (all tests in the file).

- [ ] **Step 5: Commit**

```bash
git add src/modals/export-audiobook.tsx src/modals/export-audiobook.test.tsx
git commit -m "feat(frontend): mp3-folder / M4B format toggle on the Audiobookshelf tile (fs-54)"
```

---

## Part 2 — Global Export status pill

### Task 8: `linger` state on `exports-slice.ts`

**Files:**
- Modify: `src/store/exports-slice.ts`
- Test: `src/store/exports-slice.test.ts`
- Test: `src/store/exports-middleware.test.ts` (two pre-existing `ExportsState` literals need the new required field — see Step 1)

**Interfaces:**
- Produces: `ExportsState.linger: Record<string, { state: 'done' | 'failed' }>` (a **required** field, not optional — `layout.tsx`'s Task 11 reads `state.exports.linger` unconditionally, and an optional field would let a store construction site legally omit it, leaving `undefined` for Immer to write into at runtime); new actions `exportLingerSet({ bookId, state })` / `exportLingerCleared({ bookId })`. Consumed by Task 9 (middleware, writer) and Task 11 (layout.tsx, reader).

- [ ] **Step 1: Write the failing tests, and fix the two pre-existing `ExportsState` literals `linger` breaks**

Update the `initial` fixture at the top of `src/store/exports-slice.test.ts` (currently `const initial: ExportsState = { byBookId: {}, lanUrls: [], lanPort: null };`) to:

```ts
const initial: ExportsState = { byBookId: {}, lanUrls: [], lanPort: null, linger: {} };
```

**Also fix `src/store/exports-middleware.test.ts`**, caught during plan review: its `makeStore(seed: ExportsState)` helper (line 34) has two call sites (lines 51-55 and 79-83) that construct an `ExportsState` literal without `linger` — both become `Property 'linger' is missing` compile errors once the field is required. Update both:

```ts
    const store = makeStore({
      byBookId: { [failed.bookId]: [failed] },
      lanUrls: [],
      lanPort: null,
      linger: {},
    });
```

(Same 4-line shape at both the line-51 and line-79 call sites — add `linger: {},` to each.)

Then add to `src/store/exports-slice.test.ts`:

```ts
  describe('exportLingerSet / exportLingerCleared (fs-54)', () => {
    it('records a done/failed snapshot for a book', () => {
      const s = exportsSlice.reducer(
        initial,
        exportsActions.exportLingerSet({ bookId: 'b1', state: 'done' }),
      );
      expect(s.linger['b1']).toEqual({ state: 'done' });
    });

    it('overwrites an earlier snapshot for the same book', () => {
      let s = exportsSlice.reducer(
        initial,
        exportsActions.exportLingerSet({ bookId: 'b1', state: 'done' }),
      );
      s = exportsSlice.reducer(s, exportsActions.exportLingerSet({ bookId: 'b1', state: 'failed' }));
      expect(s.linger['b1']).toEqual({ state: 'failed' });
    });

    it('removes the snapshot for a book on clear', () => {
      let s = exportsSlice.reducer(
        initial,
        exportsActions.exportLingerSet({ bookId: 'b1', state: 'done' }),
      );
      s = exportsSlice.reducer(s, exportsActions.exportLingerCleared({ bookId: 'b1' }));
      expect(s.linger['b1']).toBeUndefined();
    });

    it('clearing an unset book is a no-op', () => {
      const s = exportsSlice.reducer(initial, exportsActions.exportLingerCleared({ bookId: 'b1' }));
      expect(s.linger).toEqual({});
    });
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/store/exports-slice.test.ts -t "fs-54"`
Expected: FAIL — TypeScript error (`exportsActions.exportLingerSet` doesn't exist) or, once stubbed, a runtime error.

- [ ] **Step 3: Implement**

In `src/store/exports-slice.ts`:

```ts
export interface ExportsState {
  byBookId: Record<string, BookExportJob[]>;
  lanUrls: string[];
  lanPort: number | null;
  /** fs-54 — per-book terminal-completion snapshot for the global Export
      status pill's brief "done"/"failed" summary. Keyed by bookId; a later
      completion for the same book overwrites an earlier one (consistent
      with how the other three status pills aggregate per-book, not
      per-job). Populated + cleared by export-pill-middleware.ts. */
  linger: Record<string, { state: 'done' | 'failed' }>;
}

const initialState: ExportsState = {
  byBookId: {},
  lanUrls: [],
  lanPort: null,
  linger: {},
};
```

Add two reducers, right after `lanUrlsHydrated`:

```ts
    lanUrlsHydrated: (s, a: PayloadAction<{ urls: string[]; port: number }>) => {
      s.lanUrls = a.payload.urls;
      s.lanPort = a.payload.port;
    },

    /* fs-54 — Export pill completion linger (see ExportsState.linger doc).
       Dispatched by export-pill-middleware.ts. */
    exportLingerSet: (s, a: PayloadAction<{ bookId: string; state: 'done' | 'failed' }>) => {
      s.linger[a.payload.bookId] = { state: a.payload.state };
    },
    exportLingerCleared: (s, a: PayloadAction<{ bookId: string }>) => {
      delete s.linger[a.payload.bookId];
    },
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/store/exports-slice.test.ts src/store/exports-middleware.test.ts`
Expected: PASS (all tests in both files — `exports-middleware.test.ts`'s pre-existing tests are otherwise unaffected by this task; they only needed the `linger: {}` addition to keep compiling).

- [ ] **Step 5: Commit**

```bash
git add src/store/exports-slice.ts src/store/exports-slice.test.ts src/store/exports-middleware.test.ts
git commit -m "feat(frontend): add the Export pill's linger state to exports-slice (fs-54)"
```

---

### Task 9: `export-pill-middleware.ts` (new) + store wiring

**Files:**
- Create: `src/store/export-pill-middleware.ts`
- Test: `src/store/export-pill-middleware.test.ts`
- Modify: `src/store/index.ts`

**Interfaces:**
- Consumes: `exportsActions.exportUpdated`/`exportStarted` (existing), `exportsActions.exportLingerSet`/`exportLingerCleared` (Task 8).
- Produces: `exportPillMiddleware` (default export analog — a `Middleware` singleton), `createExportPillMiddleware(opts?)` factory for test injection, `EXPORT_LINGER_MS` constant. Consumed by Task 11 only indirectly (it reads the `linger` state this middleware writes).

- [ ] **Step 1: Write the failing tests**

Create `src/store/export-pill-middleware.test.ts`:

```ts
/* fs-54 — pins the Export pill's completion-linger contract: a book's last
   non-terminal job going done/failed sets a linger snapshot that clears
   after EXPORT_LINGER_MS, clears immediately if a new export starts on the
   same book first, and cancelled never lingers. Modeled on
   cast-design-stream-middleware.test.ts's fake-timer shape — same passive
   "does the snapshot still match what I set?" guard, no timer-handle
   bookkeeping (the reference middleware doesn't have any either). */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { configureStore } from '@reduxjs/toolkit';
import { exportsSlice, exportsActions } from './exports-slice';
import { createExportPillMiddleware } from './export-pill-middleware';
import type { BookExportJob } from '../lib/types';

function makeJob(overrides: Partial<BookExportJob> = {}): BookExportJob {
  return {
    id: 'exp_1',
    bookId: 'b1',
    format: 'mp3-zip',
    destination: 'download',
    status: 'in_progress',
    filename: 'Test.zip',
    sizeBytes: null,
    progress: 0,
    downloadUrl: null,
    syncPath: null,
    errorReason: null,
    createdAt: '2025-01-01T00:00:00Z',
    completedAt: null,
    ...overrides,
  };
}

function makeStore() {
  return configureStore({
    reducer: { exports: exportsSlice.reducer },
    middleware: (getDefault) =>
      getDefault().concat(createExportPillMiddleware({ lingerMs: 5000 })),
  });
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('exportPillMiddleware', () => {
  it("sets a done linger when a book's last non-terminal job finishes", () => {
    const store = makeStore();
    const job = makeJob({ status: 'in_progress' });
    store.dispatch(exportsActions.exportStarted(job));
    store.dispatch(exportsActions.exportUpdated({ ...job, status: 'done', progress: 1 }));
    expect(store.getState().exports.linger['b1']).toEqual({ state: 'done' });
  });

  it('sets a failed linger on failure', () => {
    const store = makeStore();
    const job = makeJob({ status: 'in_progress' });
    store.dispatch(exportsActions.exportStarted(job));
    store.dispatch(
      exportsActions.exportUpdated({ ...job, status: 'failed', errorReason: 'boom' }),
    );
    expect(store.getState().exports.linger['b1']).toEqual({ state: 'failed' });
  });

  it('does not linger while another non-terminal job for the same book remains', () => {
    const store = makeStore();
    const jobA = makeJob({ id: 'exp_a', status: 'in_progress' });
    const jobB = makeJob({ id: 'exp_b', status: 'in_progress' });
    store.dispatch(exportsActions.exportStarted(jobA));
    store.dispatch(exportsActions.exportStarted(jobB));
    store.dispatch(exportsActions.exportUpdated({ ...jobA, status: 'done', progress: 1 }));
    expect(store.getState().exports.linger['b1']).toBeUndefined();
  });

  it('clears the linger after the configured duration', () => {
    const store = makeStore();
    const job = makeJob({ status: 'in_progress' });
    store.dispatch(exportsActions.exportStarted(job));
    store.dispatch(exportsActions.exportUpdated({ ...job, status: 'done', progress: 1 }));
    vi.advanceTimersByTime(5001);
    expect(store.getState().exports.linger['b1']).toBeUndefined();
  });

  it('clears the linger immediately when a new export starts on the same book', () => {
    const store = makeStore();
    const job = makeJob({ status: 'in_progress' });
    store.dispatch(exportsActions.exportStarted(job));
    store.dispatch(exportsActions.exportUpdated({ ...job, status: 'done', progress: 1 }));
    expect(store.getState().exports.linger['b1']).toEqual({ state: 'done' });

    store.dispatch(exportsActions.exportStarted(makeJob({ id: 'exp_2', status: 'in_progress' })));
    expect(store.getState().exports.linger['b1']).toBeUndefined();
  });

  it('never lingers on cancelled', () => {
    const store = makeStore();
    const job = makeJob({ status: 'in_progress' });
    store.dispatch(exportsActions.exportStarted(job));
    store.dispatch(
      exportsActions.exportUpdated({
        ...job,
        status: 'cancelled',
        errorReason: 'Cancelled by user.',
      }),
    );
    expect(store.getState().exports.linger['b1']).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/store/export-pill-middleware.test.ts`
Expected: FAIL — the module `./export-pill-middleware` doesn't exist yet.

- [ ] **Step 3: Implement**

Create `src/store/export-pill-middleware.ts`:

```ts
/* fs-54 — Export status-pill completion linger. Watches `exports/exportUpdated`
   for a job transitioning into a terminal state; when a book's LAST
   non-terminal job goes `done`/`failed`, records a brief linger snapshot
   (exports-slice's `linger` state) so the global Export pill can show
   "Export done" / "Export failed" for a few seconds even if the user isn't
   on that book's Listen view. `cancelled` never lingers — it's a result of
   the user's own dismiss/retry action, not something to notify about after
   the fact.

   Modeled on cast-design-stream-middleware.ts's terminal-summary pattern: a
   passive setTimeout that no-ops if the snapshot it set has since been
   replaced or cleared — no timer-handle bookkeeping to cancel (the Design
   pill's own reference middleware doesn't do that either; it just re-checks
   state when the timer fires). A NEW export starting on a book while a
   linger is showing clears it immediately so live progress isn't shadowed
   by a stale summary — the now-orphaned pending timeout's own no-op check
   handles cleanup for the timer that was about to fire anyway. */

import type { Middleware, AnyAction } from '@reduxjs/toolkit';
import { exportsActions } from './exports-slice';
import type { BookExportJob } from '../lib/types';

/** ms the terminal "Export done"/"Export failed" summary lingers before the
    pill clears — matches the Design pill's SUMMARY_LINGER_MS
    (cast-design-stream-middleware.ts). */
export const EXPORT_LINGER_MS = 5000;

const TERMINAL: ReadonlySet<BookExportJob['status']> = new Set(['done', 'failed', 'cancelled']);

interface ExportsRootState {
  exports: {
    byBookId: Record<string, BookExportJob[]>;
    linger: Record<string, { state: 'done' | 'failed' }>;
  };
}

/** Factory so tests can inject a short linger duration. */
export function createExportPillMiddleware(opts?: { lingerMs?: number }): Middleware {
  const lingerMs = opts?.lingerMs ?? EXPORT_LINGER_MS;

  return (store) => (next) => (action) => {
    const result = next(action);
    const a = action as AnyAction;

    if (a.type === exportsActions.exportUpdated.type) {
      const job = a.payload as BookExportJob;
      if (job.status === 'done' || job.status === 'failed') {
        const jobs = (store.getState() as ExportsRootState).exports.byBookId[job.bookId] ?? [];
        const stillRunning = jobs.some((j) => !TERMINAL.has(j.status));
        if (!stillRunning) {
          const terminalState = job.status;
          store.dispatch(
            exportsActions.exportLingerSet({ bookId: job.bookId, state: terminalState }),
          );
          setTimeout(() => {
            const state = store.getState() as ExportsRootState;
            if (state.exports.linger[job.bookId]?.state === terminalState) {
              store.dispatch(exportsActions.exportLingerCleared({ bookId: job.bookId }));
            }
          }, lingerMs);
        }
      }
    }

    if (a.type === exportsActions.exportStarted.type) {
      const job = a.payload as BookExportJob;
      const state = store.getState() as ExportsRootState;
      if (state.exports.linger[job.bookId]) {
        store.dispatch(exportsActions.exportLingerCleared({ bookId: job.bookId }));
      }
    }

    return result;
  };
}

/** Singleton wired into the store in `src/store/index.ts`. */
export const exportPillMiddleware: Middleware = createExportPillMiddleware();
```

Then wire it into `src/store/index.ts`. Add the import near the other exports-related imports (after `import { exportPollMiddleware } from './exports-middleware';`):

```ts
import { exportPollMiddleware } from './exports-middleware';
import { exportPillMiddleware } from './export-pill-middleware';
```

And append it to the middleware chain (currently ends with `exportPollMiddleware,`):

```ts
      exportPollMiddleware,
      exportPillMiddleware,
    ),
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/store/export-pill-middleware.test.ts`
Expected: PASS (all 6 tests).

- [ ] **Step 5: Commit**

```bash
git add src/store/export-pill-middleware.ts src/store/export-pill-middleware.test.ts src/store/index.ts
git commit -m "feat(frontend): export-pill-middleware — the linger snapshot writer (fs-54)"
```

---

### Task 10: `ExportPillData`/`ExportPill` + `StatusInput`/`StatusDetail`/`summarizeStatus` wiring

**Files:**
- Modify: `src/components/top-bar.tsx`

**Interfaces:**
- Produces: `export type ExportPillState`, `export interface ExportPillData`, `export function ExportPill`; adds `exportPill: ExportPillData | null` to `StatusInput` and `StatusDetail`, plus `onGoToExport: () => void` to `StatusDetail`; `summarizeStatus` gains an `exportPill` parameter.
- **Naming note:** the design spec calls this field `export` throughout — that name is a reserved word in JS/TS and cannot be used as a destructured identifier (`const { export } = props` is a syntax error). This plan uses `exportPill` everywhere instead, consistently with the local variable name Task 11 already needs in `layout.tsx`.
- Consumes: nothing new — `IconSpinner`/`IconClock`/`IconWarning` already imported in this file.

There is no dedicated unit test for `ExportPillData`/`ExportPill` in isolation (matching how `GenerationPillData`/`GenerationPill` aren't tested standalone either — they're exercised through `layout.test.tsx` rendering the real pill, which is Task 11). `summarizeStatus`'s new branch IS a pure function and gets direct tests here, matching the existing `top-bar.test.tsx` convention for that function.

- [ ] **Step 1: Write the failing test**

Add to `src/components/top-bar.test.tsx` (find the existing `describe('summarizeStatus', ...)` or equivalent block and add inside it — if no such block exists, add a new one; check the file first for the exact existing block name before inserting):

```ts
  it('shows "Exporting" with a rounded percent while an export runs and nothing else outranks it', () => {
    const result = summarizeStatus({
      analysis: null,
      generation: null,
      design: null,
      exportPill: { state: 'running', runningCount: 1, percent: 0.42, onClick: () => {} },
      pendingRevisionsCount: 0,
      anyModelLoading: false,
    });
    expect(result).toEqual({ label: 'Exporting', tone: 'peach', icon: 'spinner', detail: '42%' });
  });

  it('folds an export stall into the shared "Stalled" rung', () => {
    const result = summarizeStatus({
      analysis: null,
      generation: null,
      design: null,
      exportPill: { state: 'stalled', runningCount: 1, onClick: () => {} },
      pendingRevisionsCount: 0,
      anyModelLoading: false,
    });
    expect(result.label).toBe('Stalled');
  });

  it('does not surface an export "done"/"failed" linger on the compact pill (popover-only, like Design)', () => {
    const result = summarizeStatus({
      analysis: null,
      generation: null,
      design: null,
      exportPill: { state: 'done', onClick: () => {} },
      pendingRevisionsCount: 0,
      anyModelLoading: false,
    });
    expect(result.label).toBe('Status');
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/components/top-bar.test.tsx -t "Exporting"`
Expected: FAIL — TypeScript error (`exportPill` not a known key of `StatusInput`) or a runtime mismatch (label is `'Status'`, not `'Exporting'`).

- [ ] **Step 3: Implement**

In `src/components/top-bar.tsx`, add the new types right after `DesignPillData` (currently ending at line 76), before the "top bar no longer renders..." comment:

```ts
/* fs-54 — sibling of GenerationPillData/DesignPillData for the global Export
   status pill. Unlike Generation (done/total chapter counts), BookExportJob
   carries a single 0..1 `progress` per job, not a sub-divided counter — so
   this aggregates a COUNT of non-terminal jobs across every book, not a
   done/total fraction. `done`/`failed` are the completion-linger states
   (export-pill-middleware.ts); like the Design pill's terminal 'done', they
   don't drive the compact Status pill's dominant rung — only the popover. */
export type ExportPillState = 'running' | 'stalled' | 'done' | 'failed';
export interface ExportPillData {
  state: ExportPillState;
  /** Non-terminal job count across every book. Present only for
      'running'/'stalled'. */
  runningCount?: number;
  /** Average `progress` (0..1) across in_progress jobs. Undefined during
      the terminal 'done'/'failed' linger — those states render as text,
      not a percent bar, same as the Design pill's own 'done' summary. */
  percent?: number;
  onClick: () => void;
}
```

Update `StatusInput` (currently lines 93-104). **`exportPill` must be optional** (`exportPill?:`, not `exportPill:`) — unlike `analysis`/`generation`/`design`, which every existing `summarizeStatus(...)` call site already passes explicitly, no test in `top-bar.test.tsx`'s `describe('summarizeStatus — dominant-state priority ladder (plan 120)', ...)` block passes an export field today. Making it required would break every one of those pre-existing calls; optional (mirroring how `analysisSubstage` is already optional on this same interface) keeps them compiling unchanged:

```ts
export interface StatusInput {
  analysis: AnalysisPillData | null;
  generation: GenerationPillData | null;
  design: DesignPillData | null;
  /** fs-54 — see ExportPillData's doc comment for the naming note (`export`
      is a reserved word, hence `exportPill`). Optional (not `exportPill:
      ExportPillData | null`) so every pre-existing summarizeStatus() call
      site in top-bar.test.tsx keeps compiling unchanged. */
  exportPill?: ExportPillData | null;
  pendingRevisionsCount: number;
  anyModelLoading: boolean;
  analysisSubstage?: { kind: 'prosody' | 'review'; percent: number } | null;
}
```

Update `summarizeStatus` (currently lines 114-153) — add the `exportPill` parameter (defaulted to `null`, same treatment as `analysisSubstage`), fold `'stalled'` into the existing amber rung, and add a new `'running'` rung between Design and the paused check:

```ts
export function summarizeStatus({
  analysis,
  generation,
  design,
  exportPill = null,
  pendingRevisionsCount,
  anyModelLoading,
  analysisSubstage = null,
}: StatusInput): StatusSummary {
  if (analysis?.state === 'halted' || generation?.state === 'halted' || design?.state === 'halted')
    return { label: 'Halted', tone: 'rose', icon: 'warning' };
  if (
    analysis?.state === 'stalled' ||
    generation?.state === 'stalled' ||
    design?.state === 'stalled' ||
    exportPill?.state === 'stalled'
  )
    return { label: 'Stalled', tone: 'amber', icon: 'clock' };
  if (generation?.state === 'running')
    return { label: 'Generating', tone: 'peach', icon: 'spinner', detail: `${generation.percent}%` };
  if (anyModelLoading) return { label: 'Loading model', tone: 'amber', icon: 'spinner' };
  if (analysis?.state === 'running')
    return {
      label: analysis.kind === 'subset' ? 'Retrying' : 'Analysing',
      tone: 'peach',
      icon: 'spinner',
      detail: `${analysis.percent}%`,
    };
  if (analysisSubstage)
    return { label: 'Analysing', tone: 'peach', icon: 'spinner', detail: `${analysisSubstage.percent}%` };
  if (design?.state === 'running')
    return { label: 'Designing', tone: 'peach', icon: 'spinner', detail: `${design.percent}%` };
  if (exportPill?.state === 'running')
    return {
      label: 'Exporting',
      tone: 'peach',
      icon: 'spinner',
      detail: exportPill.percent != null ? `${Math.round(exportPill.percent * 100)}%` : undefined,
    };
  if (analysis?.state === 'paused') return { label: 'Paused', tone: 'neutral', icon: 'clock' };
  if (pendingRevisionsCount > 0)
    return {
      label: 'Revisions',
      tone: 'peach',
      icon: 'warning',
      detail: String(pendingRevisionsCount),
    };
  return { label: 'Status', tone: 'neutral', icon: 'clock' };
}
```

Update `StatusDetail` (currently lines 157-177). **`exportPill`/`onGoToExport` must be optional** (mirroring `analysisSubstage`, already optional on this interface) — `top-bar.test.tsx`'s `STATUS_DETAIL` fixture (used by every `<TopBar>` test in the file) doesn't set them, and making them required would force editing that shared fixture just to keep the file compiling:

```ts
export interface StatusDetail {
  ttsControls: ReactNode;
  analysis: AnalysisPillData | null;
  generation: GenerationPillData | null;
  design: DesignPillData | null;
  pendingRevisionsCount: number;
  onOpenRevisions: () => void;
  onGoToAnalysing: () => void;
  onGoToGeneration: () => void;
  onGoToDesign: () => void;
  /** fs-54 — see ExportPillData's doc comment for the naming note. Optional
      (with onGoToExport below) so top-bar.test.tsx's existing STATUS_DETAIL
      fixture, which doesn't set either, keeps compiling unchanged. */
  exportPill?: ExportPillData | null;
  onGoToExport?: () => void;
  analysisSubstage?: {
    label: string;
    percent: number;
    chapterIndex?: number;
    totalChapters?: number;
    estRemainingMs?: number;
  } | null;
}
```

Update the `StatusPill` component's `<StatusPopover>` call (currently lines 822-852) to forward the new prop and handler. `StatusPopoverProps.exportPill`/`onGoToExport` (Task 12) stay **required** — `StatusPill` always resolves a definite value here via `?? null` / `?.()`, so `<StatusPopover>` itself never has to deal with "maybe present":

```tsx
      <StatusPopover
        open={open}
        anchorRef={pillRef}
        panelRef={panelRef}
        onPointerEnter={openHover}
        onPointerLeave={scheduleHoverClose}
        onFocusCapture={() => setFocusOpen(true)}
        onBlurCapture={() => setFocusOpen(false)}
        ttsControls={detail.ttsControls}
        analysis={detail.analysis}
        generation={detail.generation}
        design={detail.design}
        exportPill={detail.exportPill ?? null}
        pendingRevisionsCount={detail.pendingRevisionsCount}
        analysisSubstage={detail.analysisSubstage}
        onOpenRevisions={() => {
          detail.onOpenRevisions();
          closeAll();
        }}
        onGoToAnalysing={() => {
          detail.onGoToAnalysing();
          closeAll();
        }}
        onGoToGeneration={() => {
          detail.onGoToGeneration();
          closeAll();
        }}
        onGoToDesign={() => {
          detail.onGoToDesign();
          closeAll();
        }}
        onGoToExport={() => {
          detail.onGoToExport?.();
          closeAll();
        }}
      />
```

Finally, add the `ExportPill` component at the end of the file, after `DesignPill`:

```tsx
/* fs-54 — the fourth status pill, "Export" progress/linger. Exported for
   reuse inside the Status popover (onClick overridden to navigate-and-close),
   same pattern as AnalysisPill/GenerationPill/DesignPill. */
export function ExportPill({ data }: { data: ExportPillData }) {
  const { state, runningCount, percent, onClick } = data;
  const variants: Record<
    ExportPillState,
    { className: string; icon: React.ReactNode; label: string }
  > = {
    running: {
      className: 'bg-peach/15 hover:bg-peach/25 text-magenta',
      icon: <IconSpinner className="w-3.5 h-3.5" />,
      label: 'Exporting',
    },
    stalled: {
      className: 'bg-amber-100 hover:bg-amber-200 text-amber-800',
      icon: <IconClock className="w-3.5 h-3.5" />,
      label: 'Stalled',
    },
    done: {
      className: 'bg-ink/6 hover:bg-ink/10 text-ink/70',
      icon: <IconClock className="w-3.5 h-3.5" />,
      label: 'Export done',
    },
    failed: {
      className: 'bg-rose-100 hover:bg-rose-200 text-rose-800',
      icon: <IconWarning className="w-3.5 h-3.5" />,
      label: 'Export failed',
    },
  };
  const v = variants[state];
  const running =
    state === 'running' || state === 'stalled'
      ? `${runningCount ?? 0} running${percent != null ? ` · ${Math.round(percent * 100)}%` : ''}`
      : null;
  return (
    <button
      onClick={onClick}
      data-testid="export-pill"
      className={`inline-flex items-center gap-2 px-3 py-1.5 rounded-full text-xs font-semibold transition-colors ${v.className}`}
    >
      {v.icon}
      <span className="tabular-nums">{running ? `${v.label} · ${running}` : v.label}</span>
    </button>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/components/top-bar.test.tsx`
Expected: PASS (all tests in the file). Note this will not fully type-check in isolation until Task 11/12 update `layout.tsx`/`status-popover.tsx`'s call sites — run `cd .. && npm run typecheck` after Task 12 to confirm the whole chain compiles.

- [ ] **Step 5: Commit**

```bash
git add src/components/top-bar.tsx src/components/top-bar.test.tsx
git commit -m "feat(frontend): ExportPillData/ExportPill + summarizeStatus wiring (fs-54)"
```

---

### Task 11: `exportPill` aggregation in `layout.tsx`

**Files:**
- Modify: `src/components/layout.tsx`
- Test: `src/components/layout.test.tsx`

**Interfaces:**
- Consumes: `ExportPillData` (Task 10), `exports.byBookId`/`exports.linger` (Task 8).
- Produces: the `exportPill` local variable wired into `showStatus`/`statusSummary`/`statusDetail`, readable by the rendered `<TopBar>`.

- [ ] **Step 1: Write the failing tests**

Add a new `describe` block to `src/components/layout.test.tsx` (after the existing "Layout — global TTS pills" block), reusing that file's `makeStore()` / mocked `api` / render pattern:

```tsx
describe('Layout — Export status pill (fs-54)', () => {
  it('shows the Export pill with a running count when a non-terminal job exists for any book', async () => {
    const store = makeStore();
    store.dispatch(
      exportsActions.exportStarted({
        id: 'exp_1',
        bookId: 'b1',
        format: 'mp3-zip',
        destination: 'download',
        status: 'in_progress',
        filename: 'Test.zip',
        sizeBytes: null,
        progress: 0.5,
        downloadUrl: null,
        syncPath: null,
        errorReason: null,
        createdAt: '2026-01-01T00:00:00Z',
        completedAt: null,
      }),
    );

    const { findByTestId } = render(
      <Provider store={store}>
        <MemoryRouter initialEntries={['/books']}>
          <Routes>
            <Route path="/books" element={<Layout />} />
          </Routes>
        </MemoryRouter>
      </Provider>,
    );

    fireEvent.click(await findByTestId('status-pill'));
    const pill = await findByTestId('export-pill');
    expect(pill).toHaveTextContent('Exporting');
    expect(pill).toHaveTextContent('1 running');
    expect(pill).toHaveTextContent('50%');
  });

  it('keeps the Export pill visible via the linger union after the job goes done', async () => {
    const store = makeStore();
    store.dispatch(
      exportsActions.exportLingerSet({ bookId: 'b1', state: 'done' }),
    );

    const { findByTestId } = render(
      <Provider store={store}>
        <MemoryRouter initialEntries={['/books']}>
          <Routes>
            <Route path="/books" element={<Layout />} />
          </Routes>
        </MemoryRouter>
      </Provider>,
    );

    fireEvent.click(await findByTestId('status-pill'));
    const pill = await findByTestId('export-pill');
    expect(pill).toHaveTextContent('Export done');
  });

  it('shows no Export pill in the popover when there are no jobs and no linger entry', async () => {
    /* Pin the default engine deterministically (same precedent as "Layout —
       default-engine TTS pill reachable without an open book") so the
       Status pill is guaranteed present regardless of account-hydration
       timing — this test asserts on the Export section specifically, not
       on whether the Status pill itself renders (that's a pre-existing,
       unrelated concern). */
    const store = makeStore();
    store.dispatch(accountSlice.actions.setDefaultTtsModelKey('kokoro-v1'));

    const { findByTestId } = render(
      <Provider store={store}>
        <MemoryRouter initialEntries={['/books']}>
          <Routes>
            <Route path="/books" element={<Layout />} />
          </Routes>
        </MemoryRouter>
      </Provider>,
    );

    fireEvent.click(await findByTestId('status-pill'));
    expect(screen.queryByTestId('export-pill')).toBeNull();
    expect(await findByTestId('status-popover-export')).toHaveTextContent('Nothing exporting.');
  });
});
```

Add the new store-action import, alongside the existing ones:

```ts
import { exportsActions } from '../store/exports-slice';
```

`layout.test.tsx`'s existing `@testing-library/react` import (currently `import { render, waitFor, fireEvent, act } from '@testing-library/react';`) doesn't include `screen`, which this new test block uses. Update it to:

```ts
import { render, screen, waitFor, fireEvent, act } from '@testing-library/react';
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/components/layout.test.tsx -t "Export status pill"`
Expected: FAIL — `findByTestId('export-pill')` times out (the pill doesn't render yet); the "no pill" case may already pass trivially.

- [ ] **Step 3: Implement**

In `src/components/layout.tsx`, update the top-bar import (currently lines 44-51) to include the new type:

```ts
import {
  TopBar,
  summarizeStatus,
  type GenerationPillData,
  type AnalysisPillData,
  type DesignPillData,
  type ExportPillData,
  type StatusDetail,
} from './top-bar';
```

Add `BookExportJob` to the existing type import from `../lib/types` (currently `import type { Character } from '../lib/types';`):

```ts
import type { Character, BookExportJob } from '../lib/types';
```

Add two new selectors right after `const designSnapshot = useAppSelector((s) => s.castDesign.active);` (line 168):

```ts
  const exportsByBookId = useAppSelector((s) => s.exports.byBookId);
  const exportsLinger = useAppSelector((s) => s.exports.linger);
```

Add the client-side stall tracker (BookExportJob has no `lastTickAt` — adding one would be a wire-protocol change the design spec deliberately avoided). Place this near the other `useEffect`s in the component, close to the `forceClockTick` interval effect (around line 1247-1251):

```ts
  /* fs-54 — client-side stall tracking for export jobs. Unlike the
     generation/analysis/design streams (which stamp lastTickAt on every
     server tick), BookExportJob carries none — adding one would be a wire
     change the design spec deliberately avoided. Instead, track per-job-id
     the last time `progress` actually changed; a job whose progress hasn't
     moved in STALL_THRESHOLD_MS is stalled. Lives in a ref (not state) so
     updating it never itself triggers a re-render — the per-second
     forceClockTick above already re-renders Layout, which is when the ref
     is read (in the exportPill IIFE below). */
  const exportProgressRef = useRef<Record<string, { progress: number | null; changedAt: number }>>(
    {},
  );
  useEffect(() => {
    const now = Date.now();
    const seen = new Set<string>();
    for (const jobs of Object.values(exportsByBookId)) {
      for (const job of jobs) {
        if (job.status !== 'queued' && job.status !== 'in_progress') continue;
        seen.add(job.id);
        const prev = exportProgressRef.current[job.id];
        if (!prev || prev.progress !== job.progress) {
          exportProgressRef.current[job.id] = { progress: job.progress, changedAt: now };
        }
      }
    }
    for (const id of Object.keys(exportProgressRef.current)) {
      if (!seen.has(id)) delete exportProgressRef.current[id];
    }
  }, [exportsByBookId]);
```

Add the `exportPill` IIFE right after the `designPill` IIFE closes (currently ending at line 1393), before the "Plan 120 — collapse..." comment block:

```ts
  /* fs-54 — cross-book Export status pill. Mirrors the analysis/generation/
     design pill IIFEs: computed inline (not memoised) so the per-second
     forceClockTick keeps it live, survives navigation, one click routes
     back to the relevant book's Listen view. Visibility is the union of
     (a) any non-terminal job anywhere, and (b) an active completion-linger
     entry — without (b) the pill would vanish the instant the last job
     goes terminal, before the "Export done"/"Export failed" summary can be
     seen. */
  const exportPill: ExportPillData | null = (() => {
    const nonTerminalJobs: Array<{ bookId: string; job: BookExportJob }> = [];
    for (const [bookId, jobs] of Object.entries(exportsByBookId)) {
      for (const job of jobs) {
        if (job.status === 'queued' || job.status === 'in_progress') {
          nonTerminalJobs.push({ bookId, job });
        }
      }
    }
    const lingerEntries = Object.entries(exportsLinger);
    if (nonTerminalJobs.length === 0 && lingerEntries.length === 0) return null;

    if (nonTerminalJobs.length > 0) {
      const now = Date.now();
      const inProgress = nonTerminalJobs.filter(({ job }) => job.status === 'in_progress');
      const percent =
        inProgress.length > 0
          ? inProgress.reduce((sum, { job }) => sum + (job.progress ?? 0), 0) / inProgress.length
          : undefined;
      /* Stalled only when EVERY in-flight (in_progress) job is quiet — one
         moving job means the run is alive. A queued-only set is never
         "stalled" (it's just waiting its turn). */
      const stalled =
        inProgress.length > 0 &&
        inProgress.every(({ job }) => {
          const tracked = exportProgressRef.current[job.id];
          return tracked != null && now - tracked.changedAt > STALL_THRESHOLD_MS;
        });
      const targetBookId = nonTerminalJobs[0].bookId;
      return {
        state: stalled ? 'stalled' : 'running',
        runningCount: nonTerminalJobs.length,
        percent,
        onClick: () => navigate(`/books/${targetBookId}/listen`),
      };
    }

    /* No live jobs left — render the linger entry. Per-book, not per-job
       (matching how the other three pills aggregate); with several books
       lingering at once, the most recently-set one wins. */
    const [lingerBookId, lingerEntry] = lingerEntries[lingerEntries.length - 1];
    return {
      state: lingerEntry.state,
      onClick: () => navigate(`/books/${lingerBookId}/listen`),
    };
  })();
```

Update `showStatus` (currently lines 1409-1415) to include the new pill:

```ts
  const showStatus =
    showTtsControls ||
    analysisPill !== null ||
    generationPill !== null ||
    designPill !== null ||
    exportPill !== null ||
    analysisSubstage !== null ||
    pending.length > 0;
```

Update the `statusSummary` call (currently lines 1416-1425) and `statusDetail` object (currently lines 1430-1449):

```ts
  const statusSummary = showStatus
    ? summarizeStatus({
        analysis: analysisPill,
        generation: generationPill,
        design: designPill,
        exportPill,
        pendingRevisionsCount: pending.length,
        anyModelLoading,
        analysisSubstage: analysisSubstage ? { kind: analysisSubstage.kind, percent: analysisSubstage.percent } : null,
      })
    : null;
  const statusDetail: StatusDetail = {
    ttsControls: ttsPillElement,
    analysis: analysisPill,
    generation: generationPill,
    design: designPill,
    exportPill,
    pendingRevisionsCount: pending.length,
    onOpenRevisions: () => dispatch(uiActions.setShowRevisionPlayer(true)),
    onGoToAnalysing: () => analysisPill?.onClick(),
    onGoToGeneration: () => generationPill?.onClick(),
    onGoToDesign: () => designPill?.onClick(),
    onGoToExport: () => exportPill?.onClick(),
    analysisSubstage: analysisSubstage
      ? {
          label: analysisSubstage.label,
          percent: analysisSubstage.percent,
          chapterIndex: analysisSubstage.chapterIndex,
          totalChapters: analysisSubstage.totalChapters,
          estRemainingMs: analysisSubstage.estRemainingMs,
        }
      : null,
  };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/components/layout.test.tsx`
Expected: PASS (all tests in the file, including every pre-existing one — this is a purely additive change).

- [ ] **Step 5: Commit**

```bash
git add src/components/layout.tsx src/components/layout.test.tsx
git commit -m "feat(frontend): exportPill cross-book aggregation in layout.tsx (fs-54)"
```

---

### Task 12: `export` section on `<StatusPopover>`

**Files:**
- Modify: `src/components/status-popover.tsx`
- Test: `src/components/status-popover.test.tsx`

**Interfaces:**
- Consumes: `ExportPill`, `ExportPillData` (Task 10).

- [ ] **Step 1: Write the failing test**

`src/components/status-popover.test.tsx` already has a `makeProps(over)` helper (builds a full `StatusPopoverProps` with sensible defaults, spreadable with per-test overrides) used as `render(<StatusPopover {...makeProps({...})} />)`. Add `exportPill: null` and `onGoToExport: vi.fn()` to its defaults (currently ending at `onGoToDesign: vi.fn(),` before the closing `...over,`):

```ts
function makeProps(over: Partial<Parameters<typeof StatusPopover>[0]> = {}) {
  const anchor = document.createElement('button');
  document.body.appendChild(anchor);
  return {
    open: true,
    anchorRef: { current: anchor },
    panelRef: createRef<HTMLDivElement>(),
    onPointerEnter: vi.fn(),
    onPointerLeave: vi.fn(),
    onFocusCapture: vi.fn(),
    onBlurCapture: vi.fn(),
    ttsControls: <span data-testid="tts-sentinel">Kokoro ready</span>,
    analysis,
    generation,
    design: null,
    exportPill: null,
    pendingRevisionsCount: 2,
    onOpenRevisions: vi.fn(),
    onGoToAnalysing: vi.fn(),
    onGoToGeneration: vi.fn(),
    onGoToDesign: vi.fn(),
    onGoToExport: vi.fn(),
    ...over,
  };
}
```

Then add a new describe block, following the file's existing `describe('StatusPopover', () => { ... })` pattern:

```tsx
describe('StatusPopover — Export section (fs-54)', () => {
  it('renders the Export pill when exportPill is set', () => {
    render(
      <StatusPopover
        {...makeProps({
          exportPill: { state: 'running', runningCount: 1, percent: 0.5, onClick: vi.fn() },
        })}
      />,
    );
    expect(screen.getByTestId('status-popover-export')).toHaveTextContent('Exporting');
  });

  it('shows a placeholder message when no export is running', () => {
    render(<StatusPopover {...makeProps({ exportPill: null })} />);
    expect(screen.getByTestId('status-popover-export')).toHaveTextContent('Nothing exporting.');
  });

  it('routes through onGoToExport when the Export pill is clicked', () => {
    const onGoToExport = vi.fn();
    render(
      <StatusPopover
        {...makeProps({
          exportPill: { state: 'running', runningCount: 1, onClick: vi.fn() },
          onGoToExport,
        })}
      />,
    );
    fireEvent.click(screen.getByTestId('export-pill'));
    expect(onGoToExport).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/components/status-popover.test.tsx -t "fs-54"`
Expected: FAIL — TypeScript error (`exportPill`/`onGoToExport` not valid `StatusPopover` props yet) or `getByTestId('status-popover-export')` throws.

- [ ] **Step 3: Implement**

In `src/components/status-popover.tsx`, update the import from `./top-bar` (currently lines 25-32):

```ts
import {
  AnalysisPill,
  GenerationPill,
  DesignPill,
  ExportPill,
  type AnalysisPillData,
  type GenerationPillData,
  type DesignPillData,
  type ExportPillData,
} from './top-bar';
```

Update `StatusPopoverProps` (currently lines 40-75) to add the two new props, right after `design`:

```ts
  generation: GenerationPillData | null;
  design: DesignPillData | null;
  exportPill: ExportPillData | null;
  pendingRevisionsCount: number;
  onOpenRevisions: () => void;
  onGoToAnalysing: () => void;
  onGoToGeneration: () => void;
  onGoToDesign: () => void;
  onGoToExport: () => void;
```

Update the `StatusPopover` function's destructure and add the new Section — currently the function signature (lines 124-142) and the Generation section (lines 236-242):

```tsx
export function StatusPopover({
  open,
  anchorRef,
  panelRef,
  onPointerEnter,
  onPointerLeave,
  onFocusCapture,
  onBlurCapture,
  ttsControls,
  analysis,
  analysisSubstage,
  generation,
  design,
  exportPill,
  pendingRevisionsCount,
  onOpenRevisions,
  onGoToAnalysing,
  onGoToGeneration,
  onGoToDesign,
  onGoToExport,
}: StatusPopoverProps) {
```

```tsx
      <Section title="Generation" testid="status-popover-generation">
        {generation ? (
          <GenerationPill data={{ ...generation, onClick: onGoToGeneration }} />
        ) : (
          <p className="text-sm text-ink/60">Nothing generating.</p>
        )}
      </Section>
      <Section title="Export" testid="status-popover-export">
        {exportPill ? (
          <ExportPill data={{ ...exportPill, onClick: onGoToExport }} />
        ) : (
          <p className="text-sm text-ink/60">Nothing exporting.</p>
        )}
      </Section>
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/components/status-popover.test.tsx`
Expected: PASS (all tests in the file).

- [ ] **Step 5: Run the full frontend + typecheck to confirm the whole pill chain compiles**

Run: `npm run typecheck && npx vitest run`
Expected: PASS — this is the first point where `top-bar.tsx` (Task 10), `layout.tsx` (Task 11), and `status-popover.tsx` (Task 12) are all consistent together.

- [ ] **Step 6: Commit**

```bash
git add src/components/status-popover.tsx src/components/status-popover.test.tsx
git commit -m "feat(frontend): Export section on the Status popover (fs-54)"
```

---

## Wrap-up

### Task 13: Regression plan doc + INDEX.md entry

**Files:**
- Create: `docs/features/238-fs54-audiobookshelf-export-status-pill.md`
- Modify: `docs/features/INDEX.md`

- [ ] **Step 1: Write the regression plan**

Create `docs/features/238-fs54-audiobookshelf-export-status-pill.md` using the template at `docs/features/TEMPLATE.md`, with:

```markdown
---
status: active
shipped: null
owner: null
---

# 238 — fs-54: Audiobookshelf export robustness + global Export status pill

> Status: active
> Key files: `server/src/export/build-m4b.ts`, `server/src/export/id3-tags.ts`, `server/src/export/build-mp3-folder.ts`, `server/src/export/sync-folder.ts`, `server/src/routes/export.ts`, `src/modals/export-audiobook.tsx`, `src/store/exports-slice.ts`, `src/store/export-pill-middleware.ts`, `src/components/top-bar.tsx`, `src/components/layout.tsx`, `src/components/status-popover.tsx`
> URL surface: indirect — the export modal (`#/books/<id>/listen`) and the top-bar Status pill, present everywhere
> OpenAPI ops: none — no wire-protocol change

## Benefit / Rationale

- **User:** an Audiobookshelf user gets series metadata, an ABS-native `metadata.json`, a folder cover, an M4B option, and author-grouped sync folders — the tile is no longer identical to Smart AudioBook Player/BookPlayer's. Everyone gets a persistent Export pill so a started export doesn't require staying on the Listen view to know when it finishes.
- **Technical:** closes a real bug (metadata.json/cover.jpg were being silently dropped by the sync-folder copy filter) and a wrong-gate bug (series metadata) caught during design review — see the design spec's three assumption-checker rounds.
- **Architectural:** the Export pill reuses the exact Analysis/Generation/Design pill pattern (cross-book aggregation IIFE in `layout.tsx`, terminal-linger middleware modeled on `cast-design-stream-middleware.ts`) rather than inventing a new one.

## Architectural impact

- **New seams:** `ExportsState.linger` + `exportLingerSet`/`exportLingerCleared` actions; `export-pill-middleware.ts` as a new middleware in the store chain.
- **Invariants preserved:** no `BookExportRequest`/`BookExportJob` wire-schema change; `writeFolderToSyncFolder`/`writeToSyncFolder` signatures unchanged (author-nesting is caller-side in `routes/export.ts`).
- **Migration story:** none — additive slice state, defaults to `{}`.
- **Reversibility:** each of the 12 tasks is an independent commit; any can be reverted without breaking the others except Task 8 (exports-slice) is a dependency of Task 9/11.

## Invariants to preserve

- The series-emission gate is `state.isStandalone !== true && !!state.series?.trim()` — never presence of `state.series` alone. Pinned by `build-m4b.test.ts`, `build-mp3-folder.test.ts`'s "Audiobookshelf sidecars" describe block, and `id3-tags.test.ts`.
- `writeFolderToSyncFolder`'s copy filter is an allowlist (`.mp3` OR `metadata.json` OR `cover.jpg`), not a bare extension check — `server/src/export/sync-folder.ts`. Pinned by `sync-folder.test.ts`'s "copies metadata.json and cover.jpg through the allowlist" case.
- Sync-folder destinations nest under `<syncFolder>/<sanitizeForZip(author)>/...` — a breaking layout change from the prior flat structure, applied uniformly to both `writeFolderToSyncFolder` and `writeToSyncFolder` call sites in `routes/export.ts`. Pinned by `export.test.ts`'s two "nests ... under a sanitized author subfolder" cases.
- The Export pill's visibility is the union of (a) any non-terminal job and (b) an active linger entry — `layout.tsx`'s `exportPill` IIFE. Breaking this union makes the linger unreachable (the pill would vanish the instant the last job goes terminal).

## Testing

Full matrix: `build-m4b.test.ts`, `id3-tags.test.ts`, `build-mp3-folder.test.ts`, `sync-folder.test.ts`, `export.test.ts` (server); `export-audiobook.test.tsx`, `exports-slice.test.ts`, `export-pill-middleware.test.ts`, `top-bar.test.tsx`, `layout.test.tsx`, `status-popover.test.tsx` (frontend). No new e2e — the pill aggregation is exercised by rendering the real `<Layout>` in `layout.test.tsx`, and the export modal/tile flow is already covered by existing Playwright specs at the browser level.

## Residual / follow-up

- Whether a pre-`isStandalone`-field legacy book could reach the export path with `state.isStandalone` genuinely `undefined` on disk was flagged during design review as unresolved — `import.ts` guarantees an explicit boolean on every book created through it, but this wasn't independently re-verified against `state-migrate.ts`'s backfill coverage. Worth a spot-check during implementation if a real legacy-book test fixture is available.
- The M4B path carries series metadata via the `grouping`/`disc` MP4 atoms (Task 1) rather than a dedicated series field, since ffmpeg's mov muxer drops any `-metadata` key it doesn't recognize (verified against real ffmpeg during plan review) — whether Audiobookshelf's own M4B parser reads either atom as series info is unconfirmed. The mp3-folder path's `metadata.json` (Task 4) remains the authoritative, ABS-documented series channel.
- Direct Audiobookshelf API push + post-sync library-rescan trigger — explicitly out of scope (needs a new ABS server URL + API key setting).
- Series-level folder nesting (`<author>/<series>/<title>/`) and a cross-book export queue modal — explicitly out of scope, see the design spec's Future work section.
```

- [ ] **Step 2: Add the INDEX.md entry**

In `docs/features/INDEX.md`, under `### H. Listen & playback` (after the existing `159 —` entry, before the `### K. Cross-cutting invariants` heading), add:

```markdown
- [238 — fs-54: Audiobookshelf export robustness + global Export status pill](238-fs54-audiobookshelf-export-status-pill.md) — `active`. Series metadata (`isStandalone`-gated) in the M4B FFMETADATA and mp3-folder ID3 tags; an ABS-native `metadata.json` + folder `cover.jpg` written into every mp3-folder export; an M4B option on the Audiobookshelf tile; author-level sync-folder nesting (breaking layout change) across every folder/single-file sync destination. Plus a new global Export status pill (top bar) mirroring Analysis/Generation/Design — cross-book aggregation, stall detection, a brief done/failed completion linger modeled on the Design pill's terminal summary. Design spec: `2026-07-03-fs54-audiobookshelf-export-and-status-pill-design.md`. Refs [#978](https://github.com/dudarenok-maker/Castwright/issues/978).
```

- [ ] **Step 3: Commit**

```bash
git add docs/features/238-fs54-audiobookshelf-export-status-pill.md docs/features/INDEX.md
git commit -m "docs(docs): fs-54 regression plan + INDEX entry"
```

---

### Task 14: Release notes + BACKLOG.md

**Files:**
- Modify: `docs/release-notes-next.md`, `RELEASE_NOTES.md`, `docs/BACKLOG.md`

- [ ] **Step 1: Append to `docs/release-notes-next.md`**

Add a technical-register bullet (PR-refed once the PR number is known — placeholder `#PR` is filled in by whoever opens the PR, per this file's existing convention) under the current in-progress version section:

```markdown
- fs-54: Audiobookshelf export robustness — series metadata (M4B FFMETADATA + mp3-folder ID3), an ABS-native `metadata.json` + folder `cover.jpg`, an M4B option on the Audiobookshelf tile, author-level sync-folder nesting (breaking layout change for existing Voice-tile/mp3-zip sync-folder users) — plus a new global Export status pill mirroring Analysis/Generation/Design. Closes #978. (#PR)
```

- [ ] **Step 2: Append a brand-voice line to `RELEASE_NOTES.md`**

Add to the top (in-progress) version section:

```markdown
- **Audiobookshelf, done properly.** Series, cover, and metadata now travel with every book you send to Audiobookshelf — and you can pick a single chaptered file or a folder of tracks, whichever your library prefers.
- **An export you don't have to watch.** Kick off an export and walk away — a small indicator in the top bar tells you when it's done, or if something went wrong, no matter which screen you're on.
```

- [ ] **Step 3: Remove the fs-54 row from `docs/BACKLOG.md`**

Delete the `#### \`fs-54\` — Audiobookshelf export / hand-off` entry (currently 5 lines under `### Agents & integrations`) — the item is shipping in this PR, so per `CLAUDE.md`'s "when you ship a backlog item" rule it comes off the thin planning view (the GitHub issue remains the canonical detail home, closed via `Closes #978` in the PR body).

- [ ] **Step 4: Commit**

```bash
git add docs/release-notes-next.md RELEASE_NOTES.md docs/BACKLOG.md
git commit -m "docs(docs): fs-54 release notes + BACKLOG row removal"
```

---

## Before opening the PR

1. Run `npm run verify` (full battery: typecheck + all tests + e2e + build) — catches anything the per-task runs missed.
2. Open the PR with `Closes #978` in the body (per `CLAUDE.md`'s PR-gate issue-verification rule).
3. Per `CLAUDE.md`'s model-routing rules, this PR is multi-scope (`server` + `frontend`) → **`high`** effort for the mandatory `code-review` pass once fully staged.
4. Explicitly call out the breaking sync-folder layout change (Task 6) in the PR description, not just in the release notes.
