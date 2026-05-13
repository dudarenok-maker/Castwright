/* Change-log helpers — payload builders for `regenerate` events and the
   `at` → `ts`/`date` formatter used at render time.

   Display fields (`ts`, `date`) are derived from the persisted `at` ISO
   timestamp on every render so entries written days ago bucket into
   "yesterday" / "earlier" instead of staying frozen as "Just now". */

import { REGEN_REASONS } from '../data/regen-reasons';
import type { Chapter, ChangeLogEvent, Character } from './types';

export type RegenScope = 'this' | 'forward';

const DAY_MS = 86_400_000;

/** Bucket an ISO timestamp into the view's date groups, relative to `now`. */
export function bucketDate(at: string, now: Date = new Date()): ChangeLogEvent['date'] {
  const t = new Date(at).getTime();
  if (Number.isNaN(t)) return 'earlier';
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  if (t >= startOfToday) return 'today';
  if (t >= startOfToday - DAY_MS) return 'yesterday';
  return 'earlier';
}

/** Human-readable relative timestamp ("2 min ago", "Yesterday, 4:12pm",
    "Last week"). Mirrors the phrasing already in the fixture so the
    Activity view stays visually consistent. */
export function relativeTime(at: string, now: Date = new Date()): string {
  const t = new Date(at).getTime();
  if (Number.isNaN(t)) return '';
  const diffMs = now.getTime() - t;
  if (diffMs < 60_000) return 'Just now';
  if (diffMs < 60 * 60_000) return `${Math.round(diffMs / 60_000)} min ago`;
  const bucket = bucketDate(at, now);
  if (bucket === 'today') return `${Math.round(diffMs / (60 * 60_000))} hr ago`;
  if (bucket === 'yesterday') {
    return `Yesterday, ${formatClock(new Date(at))}`;
  }
  return diffMs < 7 * DAY_MS ? 'This week' : 'Last week';
}

function formatClock(d: Date): string {
  const h = d.getHours();
  const m = d.getMinutes();
  const am = h < 12;
  const hh = ((h + 11) % 12) + 1;
  return `${hh}:${String(m).padStart(2, '0')}${am ? 'am' : 'pm'}`;
}

/** Recompute `ts` + `date` on every event that carries an `at` timestamp,
    leaving fixture-only entries untouched so their hand-authored copy
    survives. */
export function withRecomputedDisplay(events: ChangeLogEvent[], now: Date = new Date()): ChangeLogEvent[] {
  return events.map(e => e.at
    ? { ...e, ts: relativeTime(e.at, now), date: bucketDate(e.at, now) }
    : e,
  );
}

function reasonLabel(reasonId: string): string {
  return REGEN_REASONS.find(r => r.id === reasonId)?.label ?? 'Unknown reason';
}

/** Build a `regenerate` log event for a whole-chapter regen. */
export function buildChapterRegenEvent(args: {
  chapter: Chapter;
  scope: RegenScope;
  reason: string;
  note: string;
  /** Total chapter count for the scope label ("propagated through 4 chapters"). */
  affectedChapterCount: number;
  now?: Date;
}): ChangeLogEvent {
  const { chapter, scope, reason, note, affectedChapterCount } = args;
  const now = args.now ?? new Date();
  const scopeText = scope === 'forward'
    ? affectedChapterCount > 1
      ? ` Propagated forward through ${affectedChapterCount} chapters.`
      : ' Propagated forward.'
    : '';
  const noteSuffix = note.trim() ? ` ${note.trim()}` : '';
  return {
    id: now.getTime(),
    at: now.toISOString(),
    ts: 'Just now',
    date: 'today',
    type: 'regenerate',
    title: `Regenerated Chapter ${chapter.id}`,
    note: `Reason: ${reasonLabel(reason).toLowerCase()}.${noteSuffix}${scopeText}`.trim(),
    actor: 'you',
    chapterId: chapter.id,
    revertible: true,
  };
}

/** Build a `regenerate` log event for a single character across one-or-more
    chapters. */
export function buildCharacterRegenEvent(args: {
  character: Character;
  chapterIds: number[];
  reason: string;
  note: string;
  now?: Date;
}): ChangeLogEvent {
  const { character, chapterIds, reason, note } = args;
  const now = args.now ?? new Date();
  const n = chapterIds.length;
  const scopeText = n === 0
    ? ''
    : n === 1
      ? ` in Chapter ${chapterIds[0]}`
      : ` across ${n} chapters`;
  const noteSuffix = note.trim() ? ` ${note.trim()}` : '';
  return {
    id: now.getTime(),
    at: now.toISOString(),
    ts: 'Just now',
    date: 'today',
    type: 'regenerate',
    title: `Regenerated ${character.name}'s lines`,
    note: `Reason: ${reasonLabel(reason).toLowerCase()}.${noteSuffix}${scopeText ? ` Re-voicing${scopeText}.` : ''}`.trim(),
    actor: 'you',
    chapterId: n === 1 ? chapterIds[0] : undefined,
    revertible: true,
  };
}

/** System-emitted event: a generation run has just started. Fires from the
    middleware on the first non-idle tick of a run so the activity feed has a
    "Started generating N chapters" anchor and the user can verify their
    Regenerate click actually kicked off a stream. */
export function buildGenerationStartedEvent(args: {
  chapterIds: number[];
  now?: Date;
}): ChangeLogEvent {
  const { chapterIds } = args;
  const now = args.now ?? new Date();
  const n = chapterIds.length;
  return {
    id: now.getTime(),
    at: now.toISOString(),
    ts: 'Just now',
    date: 'today',
    type: 'generation_started',
    title: n === 0 ? 'Generation started' : `Generation started — ${n} chapter${n === 1 ? '' : 's'}`,
    note: n === 0
      ? 'Resuming any chapters that still need audio.'
      : n === 1
        ? `Synthesising Chapter ${chapterIds[0]}.`
        : `Synthesising chapters ${chapterIds.slice(0, 4).join(', ')}${n > 4 ? `, +${n - 4} more` : ''}.`,
    actor: 'system',
    chapterId: n === 1 ? chapterIds[0] : undefined,
  };
}

/** System-emitted event: a chapter just transitioned to `done`. */
export function buildChapterCompleteEvent(args: {
  chapter: Chapter;
  now?: Date;
}): ChangeLogEvent {
  const { chapter } = args;
  const now = args.now ?? new Date();
  return {
    id: now.getTime(),
    at: now.toISOString(),
    ts: 'Just now',
    date: 'today',
    type: 'chapter_complete',
    title: `Chapter ${chapter.id} complete`,
    note: chapter.title
      ? `Finished synthesising "${chapter.title}".`
      : 'Finished synthesising.',
    actor: 'system',
    chapterId: chapter.id,
  };
}

/** System-emitted event: a chapter failed mid-synthesis. The reason carries
    the same string surfaced on the chapter row, so the activity feed and the
    in-place error row stay in sync. */
export function buildChapterFailedEvent(args: {
  chapter: Chapter;
  errorReason: string;
  now?: Date;
}): ChangeLogEvent {
  const { chapter, errorReason } = args;
  const now = args.now ?? new Date();
  return {
    id: now.getTime(),
    at: now.toISOString(),
    ts: 'Just now',
    date: 'today',
    type: 'chapter_failed',
    title: `Chapter ${chapter.id} failed`,
    note: errorReason || 'Synthesis failed.',
    actor: 'system',
    chapterId: chapter.id,
  };
}

/** Build a `regenerate` log event for the batch-character regen. */
export function buildBatchCharacterRegenEvent(args: {
  characters: Character[];
  chapterIds: number[];
  reason: string;
  note: string;
  now?: Date;
}): ChangeLogEvent {
  const { characters, chapterIds, reason, note } = args;
  const now = args.now ?? new Date();
  const names = characters.map(c => c.name).join(', ');
  const scopeText = chapterIds.length > 0
    ? ` across ${chapterIds.length} ${chapterIds.length === 1 ? 'chapter' : 'chapters'}`
    : '';
  const noteSuffix = note.trim() ? ` ${note.trim()}` : '';
  return {
    id: now.getTime(),
    at: now.toISOString(),
    ts: 'Just now',
    date: 'today',
    type: 'regenerate',
    title: `Batch regenerated ${characters.length} characters`,
    note: `Reason: ${reasonLabel(reason).toLowerCase()}.${noteSuffix} Re-voicing ${names}${scopeText}.`.trim(),
    actor: 'you',
    revertible: true,
  };
}
