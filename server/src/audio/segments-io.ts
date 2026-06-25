/* Shared reader for the per-chapter `<slug>.segments.json` sidecar files
   that generation.ts writes after a successful render.

   Two consumers read these back:
     - the drift detector (`routes/revisions.ts`) compares each snapshot
       against the live cast.json, and
     - the voice library aggregator (`routes/voices.ts`) stamps a bespoke
       Qwen voice as `generated` once it appears in a rendered snapshot.

   The on-disk shape is the strict `ChapterSegmentsFile` written by
   generation.ts; here we model the loose READ view (every field optional)
   because pre-108 files predate `characterSnapshots` and the per-snapshot
   fields. Presence of the segments file is itself the "rendered" signal —
   an unrendered chapter has no file, so callers never see it. */

import { existsSync, readdirSync } from 'node:fs';
import { audioDir } from '../workspace/paths.js';
import { readJson } from '../workspace/state-io.js';

export interface CharacterSnapshot {
  tone?: { warmth?: number; pace?: number; authority?: number; emotion?: number };
  gender?: 'male' | 'female' | 'neutral';
  ageRange?: 'child' | 'teen' | 'adult' | 'elderly';
  voiceId?: string;
  voiceEngine?: string;
  /** The voice NAME resolved at render time (plan 108 Wave 2b) — for a
      bespoke Qwen render this is the designed voiceId (e.g. `qwen-oduvan`).
      Absent on pre-108 segments. */
  resolvedVoiceName?: string;
  /** Engine this character ACTUALLY rendered in when it differs from its
      configured engine — `'kokoro'` when a Qwen character fell back (no
      designed voice, or Qwen unavailable). Undefined = rendered in its
      configured engine. Drives the "Fallback (Kokoro)" cast status (fe-16). */
  renderedFallbackEngine?: string;
  /** Attribute list captured at synthesis time, sorted by generation.ts. */
  attributes?: string[];
}

export interface SegmentsFile {
  chapterId: number;
  chapterTitle?: string;
  synthesizedAt?: string;
  characterSnapshots?: Record<string, CharacterSnapshot>;
  /** Per-character speaking segments captured at render time. Each segment
      records which sentence ids that character spoke, so the render-time
      sentence→speaker mapping is recoverable. Used to detect a chapter whose
      sentences were reassigned AFTER it rendered (precise, net-diff staleness).
      Absent on pre-108 / title-only files; a `kind: 'title'` segment carries an
      empty `sentenceIds`.
      `renderedFallbackEngine` is the per-SEGMENT fallback engine (srv-36 aggregate
      reads this to exclude individual fallback lines from anchor-eligible set;
      do NOT use `characterSnapshots[id].renderedFallbackEngine` for this — that
      is a per-CHARACTER collapse that over-excludes).
      `textHash` (#1105) is the djb2-base36 hash of the segment's RAW rendered
      sentence text, stamped at synthesis time. The frontend diffs it against the
      live manuscript text to flag a chapter whose text was edited after it
      rendered (the text sibling of the speaker-map diff). Absent on pre-#1105
      renders. */
  segments?: Array<{
    characterId?: string;
    sentenceIds?: number[];
    renderedFallbackEngine?: string | null;
    textHash?: string;
  }>;
}

/* #1105 — djb2 base-36 hash of a sentence's RAW text. Byte-identical to
   src/lib/stale-chapters.ts textHashForStale (the cross-package staleness
   contract is pinned by a shared vector in both test files). Stamped into each
   segment at render time and compared client-side against the live text. */
export function textHashForStale(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i += 1) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return Math.abs(h).toString(36);
}

/* Load every rendered chapter's segments file for a book, in chapter order.
   Skips chapters with no file on disk (i.e. never rendered) and any file
   that fails to parse or lacks a numeric chapterId. */
export async function loadSegmentsFiles(
  bookDir: string,
  chapters: Array<{ id: number; slug: string }>,
): Promise<SegmentsFile[]> {
  const root = audioDir(bookDir);
  if (!existsSync(root)) return [];
  const filesOnDisk = new Set<string>();
  try {
    for (const f of readdirSync(root)) {
      if (f.endsWith('.segments.json')) filesOnDisk.add(f);
    }
  } catch {
    return [];
  }

  const out: SegmentsFile[] = [];
  for (const ch of chapters) {
    const fileName = `${ch.slug}.segments.json`;
    if (!filesOnDisk.has(fileName)) continue;
    const seg = await readJson<SegmentsFile>(`${root}/${fileName}`).catch(() => null);
    if (seg && typeof seg.chapterId === 'number') out.push(seg);
  }
  return out;
}

/* Collect the set of bespoke-Qwen voice NAMES (designed voiceIds) that have
   actually rendered audio in a book — the union of every rendered snapshot
   whose `voiceEngine === 'qwen'`. Used by the voices aggregator to split
   "Designed" from "Generated" for Qwen voices. */
export async function collectRenderedQwenVoiceNames(
  bookDir: string,
  chapters: Array<{ id: number; slug: string }>,
): Promise<Set<string>> {
  const names = new Set<string>();
  const segs = await loadSegmentsFiles(bookDir, chapters);
  for (const seg of segs) {
    for (const snap of Object.values(seg.characterSnapshots ?? {})) {
      if (snap.voiceEngine === 'qwen' && snap.resolvedVoiceName) {
        names.add(snap.resolvedVoiceName);
      }
    }
  }
  return names;
}

/* The render-time sentence→speaker map per rendered chapter, recovered from each
   `<slug>.segments.json`'s per-character `segments[]`. Shape:
   `{ [chapterId]: { [sentenceId]: characterId } }`. Only chapters with a segments
   file on disk appear (i.e. rendered ones). Title/silence segments (empty
   `sentenceIds`) and malformed entries are skipped.

   The frontend diffs this against the LIVE manuscript sentence→speaker mapping to
   flag a `done` chapter whose sentences were reassigned after it rendered — a
   precise, net-diff signal (reassign-then-undo reads not-stale) that supersedes the
   time-based change-log heuristic. */
export async function collectRenderedSpeakerMaps(
  bookDir: string,
  chapters: Array<{ id: number; slug: string }>,
): Promise<Record<number, Record<number, string>>> {
  const out: Record<number, Record<number, string>> = {};
  const segs = await loadSegmentsFiles(bookDir, chapters);
  for (const seg of segs) {
    const map: Record<number, string> = {};
    for (const s of seg.segments ?? []) {
      if (!s.characterId || !Array.isArray(s.sentenceIds)) continue;
      for (const sid of s.sentenceIds) {
        if (typeof sid === 'number') map[sid] = s.characterId;
      }
    }
    /* Only surface chapters that actually carried per-sentence segments — an
       empty map (legacy file without `segments`) would otherwise read as "every
       sentence reassigned" on the client. */
    if (Object.keys(map).length > 0) out[seg.chapterId] = map;
  }
  return out;
}

/* #1105 — the render-time sentence→textHash map per rendered chapter, recovered
   from each segment's `textHash`. Shape: `{ [chapterId]: { [sentenceId]: textHash } }`.
   The frontend diffs it against the live manuscript text to flag a `done` chapter
   whose text was EDITED after it rendered (synth is keyed on sentence text, so the
   audio is stale on every engine) — the text sibling of collectRenderedSpeakerMaps.

   Only chapters with at least one stamped textHash appear; a chapter rendered
   before #1105 (no textHash on any segment) is omitted so the client reads it as
   "can't tell" rather than "every sentence edited". */
export async function collectRenderedTextHashesByChapter(
  bookDir: string,
  chapters: Array<{ id: number; slug: string }>,
): Promise<Record<number, Record<number, string>>> {
  const out: Record<number, Record<number, string>> = {};
  const segs = await loadSegmentsFiles(bookDir, chapters);
  for (const seg of segs) {
    const map: Record<number, string> = {};
    for (const s of seg.segments ?? []) {
      if (!s.textHash || !Array.isArray(s.sentenceIds)) continue;
      for (const sid of s.sentenceIds) {
        if (typeof sid === 'number') map[sid] = s.textHash;
      }
    }
    if (Object.keys(map).length > 0) out[seg.chapterId] = map;
  }
  return out;
}

/* fe-16 — per-character fallback engine aggregated across a book's rendered
   chapters. A character maps to `'kokoro'` when ANY rendered snapshot stamped
   `renderedFallbackEngine === 'kokoro'` (the Qwen → Kokoro graceful fallback:
   no designed voice, or Qwen unavailable at render time). The book-state GET
   threads this map to the cast view so the live Status pill shows
   "Fallback (Kokoro)" for characters still on the placeholder voice.

   "ANY chapter fell back" wins over "some chapter rendered fine" on purpose:
   a character that fell back in even one rendered chapter has placeholder
   audio in the assembled book and still needs a designed voice. Designing the
   voice + regenerating overwrites those snapshots with no fallback stamp, so
   the map clears on the next render. */
export async function collectRenderedFallbackEngines(
  bookDir: string,
  chapters: Array<{ id: number; slug: string }>,
): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const segs = await loadSegmentsFiles(bookDir, chapters);
  for (const seg of segs) {
    for (const [characterId, snap] of Object.entries(seg.characterSnapshots ?? {})) {
      if (snap.renderedFallbackEngine) out[characterId] = snap.renderedFallbackEngine;
    }
  }
  return out;
}
