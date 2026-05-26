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
      bespoke Qwen render this is the designed voiceId (e.g. `qwen-elwin`).
      Absent on pre-108 segments. */
  resolvedVoiceName?: string;
  /** Attribute list captured at synthesis time, sorted by generation.ts. */
  attributes?: string[];
}

export interface SegmentsFile {
  chapterId: number;
  chapterTitle?: string;
  synthesizedAt?: string;
  characterSnapshots?: Record<string, CharacterSnapshot>;
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
