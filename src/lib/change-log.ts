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
export function withRecomputedDisplay(
  events: ChangeLogEvent[],
  now: Date = new Date(),
): ChangeLogEvent[] {
  return events.map((e) =>
    e.at ? { ...e, ts: relativeTime(e.at, now), date: bucketDate(e.at, now) } : e,
  );
}

function reasonLabel(reasonId: string): string {
  return REGEN_REASONS.find((r) => r.id === reasonId)?.label ?? 'Unknown reason';
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
  const scopeText =
    scope === 'forward'
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
  const scopeText =
    n === 0 ? '' : n === 1 ? ` in Chapter ${chapterIds[0]}` : ` across ${n} chapters`;
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
    title:
      n === 0 ? 'Generation started' : `Generation started — ${n} chapter${n === 1 ? '' : 's'}`,
    note:
      n === 0
        ? 'Resuming any chapters that still need audio.'
        : n === 1
          ? `Synthesising Chapter ${chapterIds[0]}.`
          : `Synthesising chapters ${chapterIds.slice(0, 4).join(', ')}${n > 4 ? `, +${n - 4} more` : ''}.`,
    actor: 'system',
    chapterId: n === 1 ? chapterIds[0] : undefined,
  };
}

/** System-emitted event: a whole generation run finished. Rolls up every
    chapter that transitioned to `done` during the run so the audit feed gets
    one line per Generate click instead of one per chapter — a 14-chapter
    book becomes one entry, not fourteen. Per-chapter completion still
    streams to the UI via SSE; only persistence is collapsed.

    Failures stay as their own per-chapter events (see buildChapterFailedEvent)
    because they're low-volume and individually actionable. */
export function buildGenerationRunCompleteEvent(args: {
  chapterIds: number[];
  now?: Date;
}): ChangeLogEvent {
  const { chapterIds } = args;
  const now = args.now ?? new Date();
  const n = chapterIds.length;
  const sortedIds = [...chapterIds].sort((a, b) => a - b);
  const rangeText =
    n === 0
      ? ''
      : n === 1
        ? `Chapter ${sortedIds[0]}.`
        : sortedIds[n - 1] - sortedIds[0] === n - 1
          ? `Chapters ${sortedIds[0]}–${sortedIds[n - 1]}.`
          : `Chapters ${sortedIds.slice(0, 4).join(', ')}${n > 4 ? `, +${n - 4} more` : ''}.`;
  return {
    id: now.getTime(),
    at: now.toISOString(),
    ts: 'Just now',
    date: 'today',
    type: 'generation_run_complete',
    title: n === 1 ? 'Generated 1 chapter' : `Generated ${n} chapters`,
    note: rangeText || 'Run finished with no chapter transitions.',
    actor: 'system',
    chapterId: n === 1 ? sortedIds[0] : undefined,
  };
}

/** System-emitted event: a chapter just transitioned to `done`.

    No longer dispatched by the generation-stream middleware — kept so legacy
    persisted entries from before the rollup migration still render with the
    right copy. Retained as a builder because per-book reparse paths and
    other one-off flows may still emit a single chapter_complete. */
export function buildChapterCompleteEvent(args: { chapter: Chapter; now?: Date }): ChangeLogEvent {
  const { chapter } = args;
  const now = args.now ?? new Date();
  const lines = chapter.totalLines ?? null;
  const lineSuffix = lines
    ? ` — ${lines.toLocaleString()} line${lines === 1 ? '' : 's'} synthesised.`
    : '';
  return {
    id: now.getTime(),
    at: now.toISOString(),
    ts: 'Just now',
    date: 'today',
    type: 'chapter_complete',
    title: `Chapter ${chapter.id} complete`,
    note: chapter.title
      ? `Finished "${chapter.title}".${lineSuffix}`
      : `Finished synthesising.${lineSuffix}`,
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

/** User-emitted event: cast was confirmed (transition confirm → ready). */
export function buildCastConfirmEvent(args: {
  characterCount: number;
  bookTitle?: string;
  now?: Date;
}): ChangeLogEvent {
  const { characterCount, bookTitle } = args;
  const now = args.now ?? new Date();
  const n = characterCount;
  return {
    id: now.getTime(),
    at: now.toISOString(),
    ts: 'Just now',
    date: 'today',
    type: 'cast_confirm',
    title: 'Confirmed the cast',
    note: bookTitle
      ? `${n} character${n === 1 ? '' : 's'} locked in for "${bookTitle}".`
      : `${n} character${n === 1 ? '' : 's'} locked in.`,
    actor: 'you',
  };
}

/** User-emitted event: a character's voice was tuned via Profile Drawer. The
    `hadConflict` flag captures the gender/age-mismatch reset where the saved
    library voiceId is dropped — surfacing it in the note tells the reader why
    the engine fell back to a prebuilt voice. */
export function buildVoiceTuneEvent(args: {
  character: Character;
  hadConflict?: boolean;
  now?: Date;
}): ChangeLogEvent {
  const { character, hadConflict } = args;
  const now = args.now ?? new Date();
  return {
    id: now.getTime(),
    at: now.toISOString(),
    ts: 'Just now',
    date: 'today',
    type: 'voice_tune',
    title: `Tuned ${character.name}'s voice`,
    note: hadConflict
      ? 'Identity edit reset the library match — falling back to a prebuilt voice.'
      : 'Voice tone updated.',
    actor: 'you',
  };
}

/** User-emitted event: a character's voice was locked via Profile Drawer. */
export function buildVoiceLockEvent(args: { character: Character; now?: Date }): ChangeLogEvent {
  const { character } = args;
  const now = args.now ?? new Date();
  return {
    id: now.getTime(),
    at: now.toISOString(),
    ts: 'Just now',
    date: 'today',
    type: 'voice_lock',
    title: `Locked ${character.name}'s voice`,
    note: 'Future regenerates will preserve this voice.',
    actor: 'you',
  };
}

/** User-emitted event: a boundary was moved (sentence(s) reassigned). Used by
    the change-log slice's `bumpBoundaryMove` aggregator — repeated boundary
    edits on the same chapter rewrite this event in place so a single drag
    gesture or session of edits doesn't spam the log. */
export function buildBoundaryMoveEvent(args: {
  chapterId: number;
  count: number;
  now?: Date;
}): ChangeLogEvent {
  const { chapterId, count } = args;
  const now = args.now ?? new Date();
  return {
    id: now.getTime(),
    at: now.toISOString(),
    ts: 'Just now',
    date: 'today',
    type: 'boundary_move',
    title: `Adjusted boundaries in Chapter ${chapterId}`,
    note: `${count} sentence${count === 1 ? '' : 's'} reassigned.`,
    actor: 'you',
    chapterId,
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
  const names = characters.map((c) => c.name).join(', ');
  const scopeText =
    chapterIds.length > 0
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
