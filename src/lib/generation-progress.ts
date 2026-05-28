/* Pure helpers for the Generate view's overall-progress bar and the
   per-chapter character meta. Lives outside the React component so the
   weighting math is easy to unit-test without mounting jsdom.

   Why this needs to exist: Done chapters hydrated from disk don't carry a
   `totalLines` value (the SSE never fired in this session), so the naive
   sentence-weighted average drops them to zero and collapses the bar to
   just the in-flight chapter's progress — the 3/7-done-but-shows-4 % bug.
   We weight by sentences-per-chapter from the manuscript when available,
   falling back to the live tick's `totalLines`, then to the average of
   what we do know, then to 1 (equal-weight). */

import type { Chapter, Sentence } from './types';

/** Map of chapterId → sentence count derived from the manuscript. */
export function sentencesPerChapter(sentences: Sentence[]): Record<number, number> {
  const out: Record<number, number> = {};
  for (const s of sentences) out[s.chapterId] = (out[s.chapterId] ?? 0) + 1;
  return out;
}

/** Map of chapterId → characterId → { lines, words } from the manuscript. */
export function characterStatsByChapter(
  sentences: Sentence[],
): Record<number, Record<string, { lines: number; words: number }>> {
  const out: Record<number, Record<string, { lines: number; words: number }>> = {};
  for (const s of sentences) {
    const chap = out[s.chapterId] ?? (out[s.chapterId] = {});
    const slot = chap[s.characterId] ?? (chap[s.characterId] = { lines: 0, words: 0 });
    slot.lines += 1;
    slot.words += countWords(s.text);
  }
  return out;
}

/** Map of chapterId → characterId → ascending list of 1-indexed line
   positions within the chapter where that character speaks.

   Why this needs to exist: the slice's per-character status field only
   tells us who is *currently* speaking, not how many of each character's
   lines have already been synthesised. By line 13 of an 82-line chapter,
   four characters had each spoken at least once, the slice had flipped
   three of them to `done`, and the expanded row showed three full-green
   "Done" bars while 80 % of the chapter was still ahead — the lie behind
   the screenshot bug. With these positions the view can derive the real
   "lines synthesised for this character so far" from `chapter.currentLine`. */
export function characterLinePositionsByChapter(
  sentences: Sentence[],
): Record<number, Record<string, number[]>> {
  const byChapter: Record<number, Sentence[]> = {};
  for (const s of sentences) (byChapter[s.chapterId] ??= []).push(s);
  const out: Record<number, Record<string, number[]>> = {};
  for (const [chapIdStr, list] of Object.entries(byChapter)) {
    const chap: Record<string, number[]> = (out[Number(chapIdStr)] = {});
    list.forEach((s, idx) => {
      (chap[s.characterId] ??= []).push(idx + 1);
    });
  }
  return out;
}

/** Count of positions ≤ currentLine. `positions` must be sorted ascending
   (which `characterLinePositionsByChapter` guarantees because it walks the
   chapter's sentences in narrative order). Binary search keeps this O(log N)
   per character per render. */
export function linesDoneAt(positions: number[] | undefined, currentLine: number): number {
  if (!positions || positions.length === 0 || currentLine <= 0) return 0;
  let lo = 0,
    hi = positions.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (positions[mid] <= currentLine) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Per-character row completion for the Generate view's expanded chapter card.

   The slice's per-character `status` field is NOT a reliable completion
   signal during an in-progress chapter: a regenerate re-streams a chapter
   whose audio still exists on disk, so `hydrateFromBookState` can re-seed
   every cast member as `'done'`, and `applyGenerationTick` only un-`'done'`s
   the *currently speaking* character. Trusting `status === 'done'` therefore
   left previously-rendered speakers pinned at a full-green "Done" bar until
   their first line of the new run — the regenerate stale-Done bug.

   Real completion derives from `chapter.currentLine` + the character's
   manuscript line positions. We only honor the slice when the WHOLE chapter
   is finished (`chapterState === 'done'`, which `chapter_complete` sets atomically
   with every character's `'done'`); otherwise we count lines behind the playhead.
   `linesDoneAt` returns 0 for `currentLine <= 0`, so a fresh/just-regenerated
   run reads as zero for everyone. */
export function characterRowProgress(args: {
  chapterState: Chapter['state'];
  status: string;
  linesTotal: number;
  positions: number[] | undefined;
  currentLine: number;
}): { derivedDone: number; fraction: number; fullyDone: boolean } {
  const { chapterState, status, linesTotal, positions, currentLine } = args;
  const chapterDone = chapterState === 'done';
  const derivedDone = chapterDone
    ? linesTotal
    : status === 'skipped'
      ? 0
      : linesDoneAt(positions, currentLine);
  const fraction = linesTotal > 0 ? Math.min(1, derivedDone / linesTotal) : 0;
  const fullyDone = chapterDone || (linesTotal > 0 && derivedDone >= linesTotal);
  return { derivedDone, fraction, fullyDone };
}

export function countWords(text: string): number {
  const stripped = text.replace(/\[[^\]]*\]/g, ' ');
  const m = stripped.match(/\S+/g);
  return m ? m.length : 0;
}

/** Sentence-weighted overall progress.

    Weight precedence per chapter:
    1. manuscript sentence count for that chapter (canonical, available
       as soon as analysis completed);
    2. the live `totalLines` carried on the chapter (set by the SSE);
    3. the mean weight across chapters where one of the above resolved;
    4. 1 — full equal-weight fallback when nothing is known yet. */
export function overallProgress(
  chapters: Chapter[],
  manuscriptCounts: Record<number, number> = {},
): number {
  /* Excluded chapters never generate audio, so they contribute neither
     numerator nor denominator. Without this filter a 10-chapter book
     with 2 excluded would stall the bar at 80 % when 8/8 active
     chapters finish. */
  const active = chapters.filter((c) => !c.excluded);
  if (active.length === 0) return 0;

  const knownWeights: number[] = [];
  const baseWeight = (c: Chapter): number | null => {
    const m = manuscriptCounts[c.id];
    if (m && m > 0) return m;
    if (c.totalLines && c.totalLines > 0) return c.totalLines;
    return null;
  };

  for (const c of active) {
    const w = baseWeight(c);
    if (w != null) knownWeights.push(w);
  }
  const avgKnown =
    knownWeights.length > 0 ? knownWeights.reduce((a, b) => a + b, 0) / knownWeights.length : 0;

  const weightOf = (c: Chapter): number => baseWeight(c) ?? (avgKnown > 0 ? avgKnown : 1);

  let totalWeight = 0;
  let weightedNum = 0;
  for (const c of active) {
    const w = weightOf(c);
    totalWeight += w;
    weightedNum += c.progress * w;
  }
  return totalWeight > 0 ? weightedNum / totalWeight : 0;
}
