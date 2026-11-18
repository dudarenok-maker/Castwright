/* The chapter-take LEAF (spec 2026-11-13-chapter-take-lifecycle-design.md,
   §4.4 "What `scan.ts` takes from the module", R10-2).

   Everything `scan.ts` (and every module it reaches) needs about a chapter's
   take lives here: the take id, the suffix table, the full-path builders, the
   live-take probes, the `state.json` field membership list and the derive /
   heal rules. `chapter-take.ts` (the module, #4327) re-exports all of it.

   LEAF RULE: this file's whole import closure is `node:` builtins plus
   `../util/safe-path.js`, `../audio/format-duration.js` and
   `../audio/engine-breakdown.js` (which reaches only `../tts/model-keys.js`).
   It must never import `scan.ts`, `state-migrate.ts`, `audio/segments-io.ts`
   or `chapter-take.ts`, nor anything that reaches them: the allowlisted
   `scan.ts` cycles are each a single `import type`, and a type-only import is
   an edge for `check:cycles`. Input types are therefore structural and
   declared here.

   Probes: the audio formats the encoder produces are probed in a fixed order
   (plan 72 widened the set from mp3-only to mp3/m4a/ogg). Legacy `.wav` files
   from before plan 39 stay invisible. Voice samples
   (`server/src/routes/voice-sample.ts`) live in a different directory and are
   not handled here. An `.mp3` next to an `.m4a` (e.g. mid-format switch on
   the same book) resolves, for `findChapterAudio`, to whichever ranks first
   in `TAKE_AUDIO_FORMATS` - mp3 wins so existing books keep behaving
   identically until they're re-rendered into a new format. */

import { existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { basename, join } from 'node:path';
import { sanitizeIdSegment } from '../util/safe-path.js';
import { formatDuration } from '../audio/format-duration.js';
import {
  engineBreakdownFromSnapshots,
  effectiveAudioModelKey,
} from '../audio/engine-breakdown.js';
import type { TtsModelKey } from '../tts/model-keys.js';

/* ------------------------------------------------------------------ *
 * Audio formats and the live-take probes
 * ------------------------------------------------------------------ */

export type ChapterAudioExt = 'mp3' | 'm4a' | 'ogg';

export interface ChapterAudioFile {
  path: string;
  ext: ChapterAudioExt;
  mime: 'audio/mpeg' | 'audio/mp4' | 'audio/ogg';
  /** URL path suffix appended after `/chapters/:id/`. Stays per-format so
   *  the chapter-audio route can serve the right content-type without a
   *  second disk probe. Examples: `audio.mp3`, `audio.m4a`, `audio.ogg`. */
  urlSuffix: 'audio.mp3' | 'audio.m4a' | 'audio.ogg';
}

/** A previous take's audio: same shape, but its URL suffix is
 *  `audio/previous.<ext>` (§4.2). */
export interface PreviousAudioFile {
  path: string;
  ext: ChapterAudioExt;
  mime: ChapterAudioFile['mime'];
  urlSuffix: 'audio/previous.mp3' | 'audio/previous.m4a' | 'audio/previous.ogg';
}

interface FormatDescriptor {
  ext: ChapterAudioExt;
  mime: ChapterAudioFile['mime'];
  urlSuffix: ChapterAudioFile['urlSuffix'];
}

/* Probe order: mp3 first so legacy books that pre-date plan 72 resolve
   identically. The other entries are checked in a deterministic order
   when an mp3 isn't present. */
export const TAKE_AUDIO_FORMATS: readonly FormatDescriptor[] = [
  { ext: 'mp3', mime: 'audio/mpeg', urlSuffix: 'audio.mp3' },
  { ext: 'm4a', mime: 'audio/mp4', urlSuffix: 'audio.m4a' },
  { ext: 'ogg', mime: 'audio/ogg', urlSuffix: 'audio.ogg' },
];

/** Every extension a chapter's live audio can carry — the single list the
    probe below and slug-keyed file movers (rewrite-chapter-slugs) share. */
export const CHAPTER_AUDIO_EXTS: readonly ChapterAudioExt[] = TAKE_AUDIO_FORMATS.map((d) => d.ext);

export function findChapterAudio(audioRoot: string, slug: string): ChapterAudioFile | null {
  /* `slug` is derived from user/import-controlled chapter metadata and reaches
     this join unfiltered from every export builder. sanitizeIdSegment collapses
     any `..` run and path separators to `_`, so a crafted slug like
     `../../secret` can only ever resolve to a plain file *inside* audioRoot
     (which won't exist → null), never escape it. It's a no-op on real slugs —
     they contain no separators or `..` runs — so behaviour is unchanged for
     every legitimate chapter. */
  const safeSlug = sanitizeIdSegment(slug);
  for (const desc of TAKE_AUDIO_FORMATS) {
    const path = join(audioRoot, `${safeSlug}.${desc.ext}`);
    if (existsSync(path)) {
      return { path, ext: desc.ext, mime: desc.mime, urlSuffix: desc.urlSuffix };
    }
  }
  return null;
}

/** The live-take predicate (§4.2, R4-1): a take is live iff one of
    `<slug>.{mp3,m4a,ogg}` exists. `.previous.*`, `.next-*`, `.discard-*` and
    `*.tmp-*` names are never probed, so none of them can make a take live. */
export function chapterAudioExists(audioRoot: string, slug: string): boolean {
  return findChapterAudio(audioRoot, slug) !== null;
}

/** Every live audio file for the slug, in probe order (mp3 first). Same
    per-extension probe as `findChapterAudio`, but reports all hits: with
    `<slug>.mp3` and `<slug>.m4a` both present the module sees two files where
    `findChapterAudio` returns the first (§4.2). */
export function liveAudioFiles(audioRoot: string, slug: string): ChapterAudioFile[] {
  const safeSlug = sanitizeIdSegment(slug);
  const hits: ChapterAudioFile[] = [];
  for (const desc of TAKE_AUDIO_FORMATS) {
    const path = join(audioRoot, `${safeSlug}.${desc.ext}`);
    if (existsSync(path)) {
      hits.push({ path, ext: desc.ext, mime: desc.mime, urlSuffix: desc.urlSuffix });
    }
  }
  return hits;
}

/** The previous take's audio (`<slug>.previous.{mp3,m4a,ogg}`), probed in
    that order; reports the ext and mime of the name it found. */
export function findPreviousAudio(audioRoot: string, slug: string): PreviousAudioFile | null {
  const safeSlug = sanitizeIdSegment(slug);
  for (const desc of TAKE_AUDIO_FORMATS) {
    const path = join(audioRoot, `${safeSlug}.previous.${desc.ext}`);
    if (existsSync(path)) {
      return {
        path,
        ext: desc.ext,
        mime: desc.mime,
        urlSuffix: `audio/previous.${desc.ext}`,
      };
    }
  }
  return null;
}

/* ------------------------------------------------------------------ *
 * Suffix table and path builders (§4.3: audio + six sidecar parts)
 * ------------------------------------------------------------------ */

export const TAKE_SIDECAR_SUFFIXES = {
  segments: 'segments.json',
  peaks: 'peaks.json',
  lufs: 'lufs.json',
  embeddings: 'embeddings.json',
  verdicts: 'render-integrity.json',
  attempted: 'render-integrity-attempted.json',
} as const;

export type TakeSidecarPart = keyof typeof TAKE_SIDECAR_SUFFIXES;

/* The builders return the FULL path, byte-identical to the
   `join(audioRoot, `${slug}.<suffix>`)` each replaces. None adds or removes
   sanitising (the probes above sanitise; the builders do not). */

export function liveAudioPath(audioRoot: string, slug: string, ext: ChapterAudioExt): string {
  return join(audioRoot, `${slug}.${ext}`);
}

export function livePartPath(audioRoot: string, slug: string, part: TakeSidecarPart): string {
  return join(audioRoot, `${slug}.${TAKE_SIDECAR_SUFFIXES[part]}`);
}

export function previousAudioPath(audioRoot: string, slug: string, ext: ChapterAudioExt): string {
  return join(audioRoot, `${slug}.previous.${ext}`);
}

export function previousPartPath(audioRoot: string, slug: string, part: TakeSidecarPart): string {
  return join(audioRoot, `${slug}.previous.${TAKE_SIDECAR_SUFFIXES[part]}`);
}

/** Every suffix a take part can carry (§4.3): the live audio exts, the six
    sidecar suffixes, `previous.<each audio ext>` and `previous.<each sidecar
    suffix>`. The single table slug-keyed movers (rewrite-chapter-slugs)
    derive their companion list from. */
export const TAKE_SUFFIXES = [
  ...CHAPTER_AUDIO_EXTS,
  ...Object.values(TAKE_SIDECAR_SUFFIXES),
  ...CHAPTER_AUDIO_EXTS.map((ext) => `previous.${ext}` as const),
  ...Object.values(TAKE_SIDECAR_SUFFIXES).map((suffix) => `previous.${suffix}` as const),
] as const;

export type TakeSuffix = (typeof TAKE_SUFFIXES)[number];

/** `join(audioRoot, `${slug}.${suffix}`)`, byte-identical to the
    `suffixPath` it replaces. */
export function takeSuffixPath(audioRoot: string, slug: string, suffix: TakeSuffix): string {
  return join(audioRoot, `${slug}.${suffix}`);
}

/* ------------------------------------------------------------------ *
 * Take identity (§4.1)
 * ------------------------------------------------------------------ */

export type TakeId = string;

const BASE32_ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567';
const TAKE_ID_RE = /^[a-z2-7]{16}$/;

/** Mint a take id: 16 lowercase base32 characters (alphabet `a-z2-7`) from
    `crypto.randomBytes`, so it is filename-safe on NTFS (§4.1). */
export function mintTakeId(): TakeId {
  const bytes = randomBytes(16);
  let id = '';
  for (let i = 0; i < 16; i++) id += BASE32_ALPHABET[bytes[i] & 31];
  return id;
}

export function isTakeId(x: unknown): x is TakeId {
  return typeof x === 'string' && TAKE_ID_RE.test(x);
}

/* ------------------------------------------------------------------ *
 * state.json take fields (§4.3, §4.4)
 * ------------------------------------------------------------------ */

/** The single membership list of a chapter's take-derived `state.json`
    fields (§4.3). A per-field rule is stated over it, never as a second list. */
export const TAKE_STATE_FIELDS = [
  'duration',
  'audioModelKey',
  'audioEngines',
  'audioRenderedAt',
  'audioQa',
  'audioTakeId',
] as const;

export type TakeStateField = (typeof TAKE_STATE_FIELDS)[number];

/** Structural view of the advisory QA verdict (`state.json` `audioQa`). */
export interface TakeQaView {
  status: 'ok' | 'suspect';
  reasons: string[];
  measuredLufs: number | null;
  truePeakDb: number | null;
  durationSec: number;
  expectedSec: number | null;
  checkedAt: string;
}

/** Structural view of a segments file: only what `deriveTakeFields` reads. */
export interface TakeSegmentsView {
  durationSec?: number;
  modelKey?: string;
  synthesizedAt?: string;
  characterSnapshots?: Record<string, { voiceEngine?: string; renderedFallbackEngine?: string }>;
  qa?: TakeQaView;
  takeId?: string;
}

/** The take-derived members of a `state.json` chapter. Each is optional: a
    member whose source is absent is absent. */
export interface TakeFields {
  duration?: string;
  audioModelKey?: string;
  audioEngines?: Record<string, number>;
  audioRenderedAt?: string;
  audioQa?: TakeQaView;
  audioTakeId?: string;
}

/** Derive the take fields from a segments file, per §4.4's table. The model
    key is the EFFECTIVE one, computed exactly as finalize does
    (`engineBreakdownFromSnapshots` then `effectiveAudioModelKey`), never the
    raw `modelKey`. A member whose source is absent is absent from the result. */
export function deriveTakeFields(segments: TakeSegmentsView): TakeFields {
  const out: TakeFields = {};
  if (typeof segments.durationSec === 'number' && Number.isFinite(segments.durationSec)) {
    out.duration = formatDuration(segments.durationSec);
  }
  const breakdown = segments.characterSnapshots
    ? engineBreakdownFromSnapshots(segments.characterSnapshots)
    : {};
  if (typeof segments.modelKey === 'string' && segments.modelKey.length > 0) {
    out.audioModelKey = effectiveAudioModelKey(breakdown, segments.modelKey as TtsModelKey);
  }
  if (Object.keys(breakdown).length > 0) out.audioEngines = breakdown;
  if (typeof segments.synthesizedAt === 'string' && segments.synthesizedAt.length > 0) {
    out.audioRenderedAt = segments.synthesizedAt;
  }
  if (segments.qa) out.audioQa = segments.qa;
  if (typeof segments.takeId === 'string' && segments.takeId.length > 0) {
    out.audioTakeId = segments.takeId;
  }
  return out;
}

function isAbsentField(field: TakeStateField, value: unknown): boolean {
  if (value === undefined || value === null || value === '') return true;
  // '00:00' is the analysis seed (hydrateFromBookState's fallback), equally unset.
  if (field === 'duration' && value === '00:00') return true;
  return false;
}

/** The scan heal's fill rule (§4.3, §4.4). Returns a NEW object: `fresh` with
    each ABSENT take member filled from `derived`. Never overwrites a present
    member, never fills `audioTakeId` (identity is minted, not healed), and
    fills nothing for a chapter whose slug is in `journalNamedSlugs`. The
    chapter's `slug` is read from `fresh`; its `uuid` is the heal's own
    non-take field and is untouched here. */
export function healTakeFields<C extends { slug?: string } & TakeFields>(
  fresh: C,
  derived: TakeFields,
  journalNamedSlugs: ReadonlySet<string>,
): C & TakeFields {
  const out: C & TakeFields = { ...fresh };
  if (fresh.slug !== undefined && journalNamedSlugs.has(fresh.slug)) return out;
  const target = out as Record<string, unknown>;
  for (const field of TAKE_STATE_FIELDS) {
    if (field === 'audioTakeId') continue;
    const value = derived[field];
    if (value === undefined) continue;
    if (isAbsentField(field, (fresh as Record<string, unknown>)[field])) {
      target[field] = value;
    }
  }
  return out;
}

/** One live part of a take that exists on disk. `name` is the file name
    inside `audioRoot`; `path` is the full path. */
export interface LiveTakePart {
  part: 'audio' | TakeSidecarPart;
  path: string;
  name: string;
}

/** The live parts of a take that exist on disk (F15, §5.A "Readers"): the
    first live audio hit (`findChapterAudio`) and each sidecar part's live
    name. Names come from the suffix table and a directory is NEVER listed by
    prefix, so `.previous.*`, `.next-*`, `.discard-*`, `.take-journal.*`,
    `*.tmp-*` and `.orphaned/` can never appear. Audio first, then the
    sidecars in suffix-table order. */
export function liveTakeParts(audioRoot: string, slug: string): LiveTakePart[] {
  const parts: LiveTakePart[] = [];
  const audio = findChapterAudio(audioRoot, slug);
  if (audio) parts.push({ part: 'audio', path: audio.path, name: basename(audio.path) });
  const safeSlug = sanitizeIdSegment(slug);
  for (const part of Object.keys(TAKE_SIDECAR_SUFFIXES) as TakeSidecarPart[]) {
    const path = livePartPath(audioRoot, safeSlug, part);
    if (existsSync(path)) parts.push({ part, path, name: basename(path) });
  }
  return parts;
}
