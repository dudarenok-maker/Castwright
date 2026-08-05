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
import type { TtsModelKey } from '../tts/index.js';
import { buildCastResolver } from '../store/cast-resolve.js';
import type { CastIdHistory } from '../store/cast-id-history.js';

export interface CharacterSnapshot {
  tone?: { warmth?: number; pace?: number; authority?: number; emotion?: number };
  gender?: 'male' | 'female' | 'neutral';
  ageRange?: 'child' | 'teen' | 'adult' | 'elderly';
  voiceId?: string;
  voiceEngine?: string;
  /** The model key this character ACTUALLY rendered under — for Qwen, the
      per-character elevate-only tier (`resolveCharacterQwenTier`); for any other
      engine, that engine's canonical key. The srv-36 audition centroid renders
      under this exact tier so its embeddings are comparable to the anchors AND a
      0.6B base is never pulled co-resident with a 1.7B render. Absent on segments
      written before this stamp (aggregate falls back to the chapter `modelKey`). */
  modelKey?: TtsModelKey;
  /** The voice NAME actually sent to the provider at render time (plan 108
      Wave 2b) — for a bespoke Qwen render this is the designed voiceId (e.g.
      `qwen-oduvan`). Absent on pre-108 segments. #1972 — recorded from what
      the render actually synthesised, not re-derived from the cast record
      afterwards; see `character-snapshots.ts`'s `buildCharacterSnapshots`. */
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
    /** #2023 Piece 1 — the cast character id that ACTUALLY spoke this segment
        when `characterId` above is an orphaned id (no cast entry at all) and
        the render's orphaned-characterId safety net substituted the narrator
        for it. See `ChapterSegment.renderedFallbackCharacterId`'s doc comment
        in tts/synthesise-chapter.ts. */
    renderedFallbackCharacterId?: string | null;
    textHash?: string;
    /* fs-58 (#1041) — djb2-base36 hash of the group's RAW explicit `instruct`,
       stamped ONLY on the per-group qwen-1.7b liveInstruct path (the instruct
       sibling of `textHash`). The frontend diffs it against the live manuscript
       instruct to flag a chapter whose instruct was edited after it rendered.
       Absent on every other engine/path and on pre-fs-58 renders. */
    instructHash?: string;
    /** #1972 — the voice name ACTUALLY sent to the provider for this segment
        (post-fallback, post-emotion-variant). `baseVoiceName` is the same,
        minus any `__<emotion>` variant suffix — read by
        `collectOrphanedCharacterFallbacks` below (#2023 Piece 1) to report
        the voice actually used for an orphaned-id substitution. */
    voiceName?: string;
    baseVoiceName?: string;
  }>;
}

/** #2023 Piece 1, widened #2040 Wave 3 (task 16) — the render-time record of
    an orphaned characterId: one whose value does not exactly match a live
    cast id. Reported for EVERY such segment, not only the ones #2023 stamped
    (measured: 188 orphaned segments across 20 books, 0 carrying the stamp —
    every affected render predates it; see spec §4.6). */
export interface OrphanedCharacterFallback {
  /** The cast character id that rendered the line instead (usually the book's
      narrator — see `resolveNarratorChar` in tts/synthesise-chapter.ts).
      Present only when the render stamped `renderedFallbackCharacterId`
      (post-#2023); absent on every pre-#2023 render, which is most of the
      affected segments as of Wave 3. */
  characterId?: string;
  /** The voice name actually sent to the provider, when the render recorded
      one. Absent on a pre-#2023 render whose segments predate this stamp. */
  voiceName?: string;
  /** How this record's key (the orphaned id) resolves against the live cast
      + id history: `'alias'` when it matches through the id-history
      side-table (`cast-id-history.ts`), `'normalised'` when it matches a
      live cast id only after separator/case normalisation
      (`normaliseIdKey`), `'unresolved'` when neither applies — a genuine
      miss. An id that matches a live cast id EXACTLY is never reported here
      at all (see the collector below), so `'exact'` never appears. */
  resolution: 'alias' | 'normalised' | 'unresolved';
  /** The live cast id this orphaned id resolves onto, when `resolution` is
      `'alias'` or `'normalised'`. Absent when `resolution` is
      `'unresolved'`. */
  resolvedCharacterId?: string;
  /** How many rendered segments (summed across every rendered chapter) carry
      this orphaned id. */
  segments: number;
  /** #2092/#2089 D4 — every live cast id this orphaned id has been rejected
      AGAINST (`cast-id-history.json`'s `rejectedPairs`, keyed on this
      record's own orphaned id as the pair's `from`). Absent when the id has
      never been rejected against anything. Populated regardless of
      `resolution` — a rejected id is NOT filtered out of this map (D4's own
      "do not filter rejected ids out of the banner as a tidy-up" trap: doing
      so would delete the row, which is worse feedback than no chip at all,
      and it would orphan the frontend's Undo control, which reads this
      field to know what to undo). The frontend renders one "Not <Name> ·
      Undo" chip per entry. */
  rejectedAgainst?: string[];
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

/* fs-58 — the render-time sentence→instructHash map per rendered chapter, recovered
   from each segment's `instructHash` (stamped only on the per-group 1.7b liveInstruct
   path). Shape: `{ [chapterId]: { [sentenceId]: instructHash } }`. The frontend diffs
   it against the live manuscript `instruct` to flag a chapter whose instruct was edited
   after it rendered — the instruct sibling of collectRenderedTextHashesByChapter.

   Only chapters with at least one stamped instructHash appear; a chapter that rendered
   on a non-liveInstruct engine (nothing stamped) is omitted so the client reads it as
   "can't tell" rather than "every instruct edited". */
export async function collectRenderedInstructHashesByChapter(
  bookDir: string,
  chapters: Array<{ id: number; slug: string }>,
): Promise<Record<number, Record<number, string>>> {
  const out: Record<number, Record<number, string>> = {};
  const segs = await loadSegmentsFiles(bookDir, chapters);
  for (const seg of segs) {
    const map: Record<number, string> = {};
    for (const s of seg.segments ?? []) {
      if (!s.instructHash || !Array.isArray(s.sentenceIds)) continue;
      for (const sid of s.sentenceIds) {
        if (typeof sid === 'number') map[sid] = s.instructHash;
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

/* #2023 Piece 1, widened #2040 Wave 3 (task 16) — per-orphaned-id render-time
   substitution, aggregated across a book's rendered chapters. Keyed by the
   ORPHANED id itself (never a live cast id, so it can't collide with
   `collectRenderedFallbackEngines`'s cast-id keyspace above).

   Originally gated on `renderedFallbackCharacterId`, the stamp #2023
   introduced — but measured across all 20 books, that stamp covers 0 of 188
   orphaned segments, because every affected render predates it. And an id
   resolved through an alias never takes `resolveGroup`'s orphan/stamp branch
   at all, so gating on the stamp made the "auto-reconciled" half of the
   banner empty by construction (spec §4.6). The gate is now "does
   `characterId` fail to match a live cast id EXACTLY", using the same
   resolver the render path and the drift detector already use
   (`buildCastResolver`) — not a second matcher — so a segment is reported
   whether or not it happens to carry the #2023 stamp.

   `castIdHistory` (#2092/#2089 task 3) takes the WHOLE loaded `CastIdHistory`
   object — not a bare `supersededBy` map with `rejected`/`rejectedPairs`
   threaded separately as prior independent parameters. That used to let this
   collector's caller (book-state.ts) pass `supersededBy` alone and silently
   default the reject fields to empty — the exact shared-consumer-contract
   defect shape #2040 Task 17 fix round 1 already closed for
   `buildCastResolver` itself, and the SAME hazard this task exists to close
   here structurally: a caller that forgets to thread `rejectedPairs` no
   longer CAN, because there's only one parameter to pass. */
export async function collectOrphanedCharacterFallbacks(
  bookDir: string,
  chapters: Array<{ id: number; slug: string }>,
  cast: ReadonlyArray<{ id: string }>,
  castIdHistory: Pick<CastIdHistory, 'supersededBy' | 'rejected' | 'rejectedPairs'>,
): Promise<Record<string, OrphanedCharacterFallback>> {
  const out: Record<string, OrphanedCharacterFallback> = {};
  const segs = await loadSegmentsFiles(bookDir, chapters);
  const resolver = buildCastResolver(cast, castIdHistory);

  /* #2092/#2089 D4 — `from -> [to, ...]` for the "Not <Name> · Undo" chip,
     keyed RAW rather than normalised. This function's own aggregation map
     (`out`) is keyed by the untouched raw `s.characterId` straight off the
     segment — never normalised anywhere in this function — so the lookup
     below has to agree with THAT keyspace, not with any one resolver tier's
     (cast-resolve.ts's tier-3/4 checks normalise instead, because those
     tiers themselves match by normalised key; there is no such tier here,
     only this collector's own raw-keyed `out` map). A pair therefore only
     surfaces a chip against the exact raw id it was rejected under. */
  const rejectedAgainstByFrom = new Map<string, string[]>();
  for (const pair of castIdHistory.rejectedPairs ?? []) {
    const list = rejectedAgainstByFrom.get(pair.from) ?? [];
    list.push(pair.to);
    rejectedAgainstByFrom.set(pair.from, list);
  }

  for (const seg of segs) {
    for (const s of seg.segments ?? []) {
      if (!s.characterId) continue;
      const resolution = resolver.resolve(s.characterId);
      /* An exact live cast id is not an orphan at all — never reported. */
      if (resolution?.via === 'exact') continue;

      /* #2040 Wave 3 review round 1 CRITICAL — read WHICH tier matched
         straight off `resolution.via`, the resolver's own precedence-ordered
         record, rather than recomputing "does this look like history" here.
         A recomputation that only checks history-key membership can disagree
         with the resolver: a normalised id can simultaneously collide with a
         live cast id (tier 3, `'normalised-id'`) AND an unrelated history
         entry that happens to normalise to the same key (tier 4,
         `'normalised-history'`) — only the resolver's own tier order knows
         tier 3 won. See cast-resolve.ts's `via` field and
         cast-resolve.test.ts's "tier 3 beats tier 4" regression. `'history'`
         and `'normalised-history'` both surface as `'alias'` (resolved
         through the id-history side-table, exact or normalised key);
         `'normalised-id'` surfaces as `'normalised'` (resolved against a
         live cast id with no history involved). `'exact'` already `continue`d
         above, so it can't reach here. */
      const resolutionTag: OrphanedCharacterFallback['resolution'] = !resolution
        ? 'unresolved'
        : resolution.via === 'normalised-id'
          ? 'normalised'
          : 'alias';

      const existing = out[s.characterId];
      out[s.characterId] = {
        /* GATE 1 review — `resolveGroup` (synthesise-chapter.ts) stamps
           `baseVoiceName` unconditionally on every segment, so a `?? s.voiceName`
           fallback here was dead in production (and untested — both existing
           test cases set the two fields to the same string). Only a pre-#1972
           segments.json predates the field at all, which `?? undefined` still
           covers. Falls back to a PRIOR occurrence's value across chapters
           so a later, unstamped segment for the same orphaned id doesn't
           blank out what an earlier one recorded. */
        characterId: s.renderedFallbackCharacterId ?? existing?.characterId,
        voiceName: s.baseVoiceName ?? existing?.voiceName,
        resolution: resolutionTag,
        resolvedCharacterId: resolution?.character.id,
        segments: (existing?.segments ?? 0) + 1,
        /* #2092/#2089 D4 — trap: never filtered out of this map even when
           `resolutionTag` is 'unresolved' (which it always is for a
           rejected id, per D2's no-fall-through). Doing so would delete the
           row and orphan the frontend's Undo control. */
        rejectedAgainst: rejectedAgainstByFrom.get(s.characterId),
      };
    }
  }
  return out;
}
