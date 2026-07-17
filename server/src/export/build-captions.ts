/* fs-52 — caption export orchestrator. Sibling to build-m4b.ts /
   build-mp3-zip.ts: both caption scopes (whole-book single file,
   per-chapter zip) are single-artifact builds, so this slots into
   runExportJob's existing single-file branch with no new job-lifecycle
   code. See
   docs/superpowers/specs/2026-07-10-fs52-caption-srt-export-design.md. */

import { createWriteStream } from 'node:fs';
import { stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ZipFile } from 'yazl';
import { audioDir, castJsonPath } from '../workspace/paths.js';
import { readJson } from '../workspace/state-io.js';
import { findChapterAudio } from '../workspace/chapter-audio-file.js';
import { sanitizeIdSegment } from '../util/safe-path.js';
import { probeDurationSec } from './build-m4b.js';
import { ExportIncompleteError, sanitiseForZip, pad2 } from './build-mp3-zip.js';
import { loadManuscriptSentencesByChapter } from './manuscript-sentences.js';
import {
  buildSentenceCues,
  buildLineCues,
  buildWordCues,
  hasUnverifiableTextHash,
  type SegmentInput,
} from './caption-cues.js';
import { writeSrt, writeVtt, type CaptionCue } from './caption-format.js';
import type { BookStateJson } from '../workspace/scan.js';
import type { ChapterSegmentsFile } from '../audio/finalize-chapter-write.js';

export { ExportIncompleteError } from './build-mp3-zip.js';

export interface BuildCaptionsOptions {
  bookDir: string;
  state: BookStateJson;
  captionFileFormat: 'srt' | 'vtt';
  captionGranularity: 'line' | 'sentence' | 'word';
  captionScope: 'whole-book' | 'per-chapter';
  outPath: string;
  onProgress?: (ratio: number) => void;
  signal?: AbortSignal;
}

export interface BuildCaptionsResult {
  sizeBytes: number;
  /** Round-2-of-plan-review decision: set when any sentence/line segment
      predates the `textHash` staleness stamp (#1105) and so couldn't be
      verified as still matching the current manuscript text — "can't
      tell", not "confirmed fresh." The export still succeeds; this is a
      non-fatal heads-up surfaced on the job, not a failure. Never set for
      word mode, which doesn't join manuscript text at all. */
  warning?: string;
}

const UNVERIFIABLE_STALENESS_WARNING =
  "Some of this book's chapters predate render-time staleness tracking, so we couldn't fully " +
  'verify these captions are still in sync with the audio. Re-render for a guaranteed-accurate export.';

interface CastJson {
  characters?: Array<{ id: string; name?: string }>;
}

function formatCues(cues: CaptionCue[], format: 'srt' | 'vtt'): string {
  return format === 'srt' ? writeSrt(cues) : writeVtt(cues);
}

function toSegmentInputs(file: ChapterSegmentsFile): SegmentInput[] {
  return file.segments.map((s) => ({
    characterId: s.characterId,
    sentenceIds: s.sentenceIds,
    startSec: s.startSec,
    endSec: s.endSec,
    kind: s.kind,
    textHash: s.textHash,
  }));
}

async function chapterCues(
  granularity: 'line' | 'sentence' | 'word',
  chapterAudioPath: string,
  segFile: ChapterSegmentsFile,
  sentenceText: Record<number, string>,
  speakerNames: Record<string, string>,
  language: string | null,
  signal?: AbortSignal,
): Promise<CaptionCue[]> {
  const segments = toSegmentInputs(segFile);
  if (granularity === 'word') {
    /* Spec §2 — ASR always passes the book's language via X-Language, same
       as segment-asr-qa.ts already does for non-English books. */
    return buildWordCues(chapterAudioPath, segments, segFile.chapterTitle, { language, signal });
  }
  return granularity === 'sentence'
    ? buildSentenceCues(segments, sentenceText, speakerNames, segFile.chapterTitle)
    : buildLineCues(segments, sentenceText, speakerNames, segFile.chapterTitle);
}

export async function buildCaptions(opts: BuildCaptionsOptions): Promise<BuildCaptionsResult> {
  const { bookDir, state, captionFileFormat, captionGranularity, captionScope, outPath, onProgress, signal } = opts;

  const chapters = [...state.chapters].filter((c) => !c.excluded).sort((a, b) => a.id - b.id);
  const root = audioDir(bookDir);

  const missing: string[] = [];
  const resolved: Array<{ chapter: (typeof chapters)[number]; audioPath: string }> = [];
  for (const chapter of chapters) {
    const audio = findChapterAudio(root, chapter.slug);
    if (!audio) {
      missing.push(chapter.slug);
      continue;
    }
    resolved.push({ chapter, audioPath: audio.path });
  }
  if (missing.length > 0) throw new ExportIncompleteError(missing);

  const sentencesByChapter = await loadManuscriptSentencesByChapter(bookDir);
  if (!sentencesByChapter) {
    throw new Error(
      'No manuscript data found for this book (manuscript-edits.json missing). ' +
        'Re-run analysis, then generate again before exporting captions.',
    );
  }

  const cast = await readJson<CastJson>(castJsonPath(bookDir));
  const speakerNames: Record<string, string> = {};
  for (const c of cast?.characters ?? []) {
    if (c.name) speakerNames[c.id] = c.name;
  }

  const perChapterCues: CaptionCue[][] = [];
  const perChapterDurations: number[] = [];
  let anyUnverifiable = false;
  for (let i = 0; i < resolved.length; i++) {
    signal?.throwIfAborted();
    const { chapter, audioPath } = resolved[i];
    const segFile = await readJson<ChapterSegmentsFile>(
      join(root, `${sanitizeIdSegment(chapter.slug)}.segments.json`),
    );
    if (!segFile) throw new Error(`No segments.json found for rendered chapter ${chapter.slug}.`);
    const text = sentencesByChapter[chapter.id] ?? {};
    const sentenceText: Record<number, string> = {};
    for (const [id, s] of Object.entries(text)) sentenceText[Number(id)] = s.text;

    const cues = await chapterCues(
      captionGranularity,
      audioPath,
      segFile,
      sentenceText,
      speakerNames,
      state.language ?? null,
      signal,
    );
    perChapterCues.push(cues);
    /* Round-2-of-plan-review decision: word mode never joins manuscript
       text, so it's immune to the staleness class this flags — only check
       for sentence/line granularity. */
    if (captionGranularity !== 'word' && hasUnverifiableTextHash(toSegmentInputs(segFile))) {
      anyUnverifiable = true;
    }
    /* Plan-review fix: only probe duration for whole-book scope, which is
       the only branch that consumes perChapterDurations (the cumulative
       cross-chapter offset, computed from the SAME encoded-file duration
       source build-m4b.ts uses for its own chapter marks — see spec §2).
       Per-chapter scope never reads it — probing every chapter's duration
       there was pure wasted ffprobe work. */
    if (captionScope === 'whole-book') {
      perChapterDurations.push(await probeDurationSec(audioPath));
    }
    onProgress?.((i + 1) / resolved.length);
  }
  const warning = anyUnverifiable ? UNVERIFIABLE_STALENESS_WARNING : undefined;

  if (captionScope === 'whole-book') {
    let cursorSec = 0;
    const allCues: CaptionCue[] = [];
    for (let i = 0; i < perChapterCues.length; i++) {
      for (const cue of perChapterCues[i]) {
        allCues.push({ ...cue, startSec: cue.startSec + cursorSec, endSec: cue.endSec + cursorSec });
      }
      cursorSec += perChapterDurations[i];
    }
    const content = formatCues(allCues, captionFileFormat);
    /* No mkdir here — the caller (export.ts's POST handler) already
       ensures the exports dir exists before computing outPath, same
       guarantee build-m4b.ts/build-mp3-zip.ts rely on. */
    await writeFile(outPath, content, 'utf8');
    const st = await stat(outPath);
    return { sizeBytes: st.size, warning };
  }

  // per-chapter: zip of one caption file per chapter, each zero-based.
  return new Promise<BuildCaptionsResult>((resolve, reject) => {
    const zip = new ZipFile();
    const ws = createWriteStream(outPath);
    ws.on('error', reject);
    let bytes = 0;
    zip.outputStream.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
    });
    zip.outputStream.on('error', reject);
    zip.outputStream.pipe(ws).on('finish', () => resolve({ sizeBytes: bytes, warning }));

    for (let i = 0; i < resolved.length; i++) {
      const { chapter } = resolved[i];
      const content = formatCues(perChapterCues[i], captionFileFormat);
      const entryName = `${pad2(i + 1)} - ${sanitiseForZip(chapter.title)}.${captionFileFormat}`;
      zip.addBuffer(Buffer.from(content, 'utf8'), entryName, { mtime: new Date() });
    }
    zip.end();
  });
}
