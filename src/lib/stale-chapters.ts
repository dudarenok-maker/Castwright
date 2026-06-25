/* fs-34 — shared "which rendered chapters does this character speak in" helper.
   Extracted from the cast-save stale-audio handler in layout.tsx so the new
   emotion-edit + variant-design/remove staleness triggers reuse the SAME
   predicate (a `done` chapter whose `characters` map includes the id) instead
   of diverging. The hook dispatches `setStaleAudio` so the existing banner
   (plan 114) fires for emotion/variant changes too. */

import { useAppDispatch, useAppSelectorShallow } from '../store';
import { uiActions } from '../store/ui-slice';
import type { Chapter, ChangeLogEvent } from './types';

export function renderedChaptersForCharacter(characterId: string, chapters: Chapter[]): number[] {
  return chapters
    .filter((ch) => ch.state === 'done' && ch.characters && characterId in ch.characters)
    .map((ch) => ch.id);
}

/* Bug 2 — a rendered chapter whose sentence→speaker assignments were changed
   AFTER it was generated is stale and needs regenerating. Derived (not a stored
   flag) from two pieces of already-persisted state, so the indicator survives a
   reload: the change-log `boundary_move` events (one is appended/bumped for every
   sentence reassignment) and the chapter's `audioRenderedAt` render stamp.

   This is the "optimistic now" half of the indicator: time-based, so a
   reassign-then-undo still reads stale until regenerated. The precise per-sentence
   net-diff is a filed follow-up. Correctness precondition: EVERY reassignment path
   must emit a `boundary_move` (see manuscript.tsx). */

/** The ISO time of the most recent sentence-reassignment logged for a chapter, or
    undefined if none. `events` are newest-first (the change-log unshifts), so the
    first match is the latest. */
export function latestReassignAt(
  chapterId: number,
  events: ChangeLogEvent[],
): string | undefined {
  return events.find((e) => e.type === 'boundary_move' && e.chapterId === chapterId)?.at;
}

/** True when a `done` chapter's audio predates its latest sentence reassignment. */
export function isChapterStaleFromReassign(chapter: Chapter, events: ChangeLogEvent[]): boolean {
  if (chapter.state !== 'done' || !chapter.audioRenderedAt) return false;
  const reassignedAt = latestReassignAt(chapter.id, events);
  return reassignedAt != null && reassignedAt > chapter.audioRenderedAt;
}

/* #650 — PRECISE staleness: diff the render-time sentence→speaker map (from the
   chapter's segments.json, shipped on the book-state GET as
   `renderedSpeakersByChapter`) against the LIVE manuscript. Supersedes the
   time-based heuristic above: it's precise (a reassign-then-undo reads
   not-stale) AND immediate (recomputed from the live manuscript slice, no
   refetch needed). The Generate view uses this when the render map is present
   for a chapter and falls back to `isChapterStaleFromReassign` otherwise.

   Asymmetric on purpose — iterate the RENDERED ids only. A rendered sentence
   whose current speaker differs (reassign) or that's now gone (split/merge/
   delete) ⇒ stale; a sentence that never made it into the segments map (e.g. a
   structural/empty line) can't trip a false positive because it isn't a key. */
export function isChapterReassignedSinceRender(
  rendered: Record<number, string> | undefined,
  currentSentences: Array<{ id: number; characterId: string }>,
): boolean {
  if (!rendered || Object.keys(rendered).length === 0) return false;
  const current = new Map<number, string>();
  for (const s of currentSentences) current.set(s.id, s.characterId);
  for (const sidStr of Object.keys(rendered)) {
    const sid = Number(sidStr);
    if (current.get(sid) !== rendered[sid]) return true;
  }
  return false;
}

/* #1105 — PRECISE text staleness, the text sibling of isChapterReassignedSinceRender.
   A rendered chapter whose sentence TEXT was edited after it rendered is stale on
   EVERY engine (synth is keyed on sentence text), yet the speaker-diff above can't
   see it (it compares characterId only). Derived from persisted JSON — the live
   manuscript text vs the render-time text hash stamped into segments.json — so it's
   precise (edit-then-revert reads not-stale), immediate (no refetch), survives a
   reload, AND catches EVERY edit path (Script Review strip_tag, a future manual
   editor, a direct manuscript-edits.json/MCP edit), not just the ones that remember
   to log a boundary_move.

   djb2 base-36, byte-identical to server/src/audio/segments-io.ts textHashForStale
   (the cross-package contract is pinned by a shared vector in both test files).
   Hash the RAW sentence text — the server stamps the raw group text, and this side
   hashes the live raw `sent.text`, so a normalisation mismatch can't desync them. */
export function textHashForStale(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i += 1) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return Math.abs(h).toString(36);
}

/** True when any sentence the chapter RENDERED now has different text (edited) or is
    gone. Asymmetric on purpose — iterate the RENDERED ids only, mirroring
    isChapterReassignedSinceRender: a current sentence that was never rendered (a
    structural/empty line, or one added after render) isn't a key, so it can't trip a
    false positive. Returns false when no render text map exists (pre-#1105 render),
    letting the caller fall back to the time-based heuristic. */
export function isChapterTextEditedSinceRender(
  renderedTextHashes: Record<number, string> | undefined,
  currentSentences: Array<{ id: number; text: string }>,
): boolean {
  if (!renderedTextHashes || Object.keys(renderedTextHashes).length === 0) return false;
  const current = new Map<number, string>();
  for (const s of currentSentences) current.set(s.id, s.text);
  for (const sidStr of Object.keys(renderedTextHashes)) {
    const sid = Number(sidStr);
    const liveText = current.get(sid);
    if (liveText === undefined) return true; // rendered sentence now gone
    if (textHashForStale(liveText) !== renderedTextHashes[sid]) return true;
  }
  return false;
}

/* fs-58 Unit B — flag_nonstory precise staleness. Iterate the RENDERED ids
   (keys that produced a segment at render time, from renderedSpeakersByChapter);
   if any is now excludeFromSynthesis ⇒ that line will be dropped on the next
   render ⇒ stale. Asymmetric like isChapterReassignedSinceRender: a never-
   rendered id can't trip a false positive. The re-include direction (a line
   excluded AT render, later re-included) is covered coarsely on the manual
   toggle, not here. */
export function isChapterExcludedSinceRender(
  rendered: Record<number, string> | undefined,
  currentSentences: Array<{ id: number; excludeFromSynthesis?: boolean }>,
): boolean {
  if (!rendered || Object.keys(rendered).length === 0) return false;
  const excluded = new Set(currentSentences.filter((s) => s.excludeFromSynthesis).map((s) => s.id));
  for (const sidStr of Object.keys(rendered)) {
    if (excluded.has(Number(sidStr))) return true;
  }
  return false;
}

/* fs-58 — PRECISE instruct staleness, the instruct sibling of
   isChapterTextEditedSinceRender. A rendered chapter whose sentence `instruct` was
   edited after it rendered ON THE 1.7b liveInstruct path is stale (only that path's
   audio depends on the instruct). Derived from the render-time instructHash map
   (only populated for liveInstruct renders) vs the live `instruct`. Asymmetric —
   iterate the stamped ids only; a chapter with no stamps reads not-stale (a
   non-liveInstruct render never used the instruct). Hash the live instruct the same
   way the server stamps it: textHashForStale of the raw (trimmed) string. */
export function isChapterInstructEditedSinceRender(
  renderedInstructHashes: Record<number, string> | undefined,
  currentSentences: Array<{ id: number; instruct?: string }>,
): boolean {
  if (!renderedInstructHashes || Object.keys(renderedInstructHashes).length === 0) return false;
  const current = new Map<number, string>();
  // Trim to match the server stamp (setSentenceInstruct stores the trimmed value, §6.5).
  for (const s of currentSentences) current.set(s.id, (s.instruct ?? '').trim());
  for (const sidStr of Object.keys(renderedInstructHashes)) {
    const sid = Number(sidStr);
    const liveInstruct = current.get(sid) ?? '';
    if (textHashForStale(liveInstruct) !== renderedInstructHashes[sid]) return true;
  }
  return false;
}

/** Returns a callback that marks a character's rendered audio stale (no-op when
    the character speaks in no `done` chapter). Reads chapters from the store. */
export function useMarkCharacterStaleIfRendered(): (character: {
  id: string;
  name: string;
}) => void {
  const dispatch = useAppDispatch();
  /* Optional-chained so a partial test store (no chapters slice) is a safe
     no-op rather than a render-time crash. */
  const chapters = useAppSelectorShallow((s) => s.chapters?.chapters);
  return (character) => {
    const chapterIds = renderedChaptersForCharacter(character.id, chapters ?? []);
    if (chapterIds.length > 0) {
      dispatch(
        uiActions.setStaleAudio({
          characterId: character.id,
          characterName: character.name,
          chapterIds,
        }),
      );
    }
  };
}
