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
  let lo = 0, hi = positions.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (positions[mid] <= currentLine) lo = mid + 1;
    else hi = mid;
  }
  return lo;
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
  if (chapters.length === 0) return 0;

  const knownWeights: number[] = [];
  const baseWeight = (c: Chapter): number | null => {
    const m = manuscriptCounts[c.id];
    if (m && m > 0) return m;
    if (c.totalLines && c.totalLines > 0) return c.totalLines;
    return null;
  };

  for (const c of chapters) {
    const w = baseWeight(c);
    if (w != null) knownWeights.push(w);
  }
  const avgKnown = knownWeights.length > 0
    ? knownWeights.reduce((a, b) => a + b, 0) / knownWeights.length
    : 0;

  const weightOf = (c: Chapter): number => baseWeight(c) ?? (avgKnown > 0 ? avgKnown : 1);

  let totalWeight = 0;
  let weightedNum = 0;
  for (const c of chapters) {
    const w = weightOf(c);
    totalWeight += w;
    weightedNum += c.progress * w;
  }
  return totalWeight > 0 ? weightedNum / totalWeight : 0;
}
