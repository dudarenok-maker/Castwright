import type { Chapter } from './types';

/** #3507 — true when generation skipped an included chapter that has no
    narratable text: it counts as done but has no audio to play or record.
    Both halves matter: the flag can linger on a row that was re-queued, is
    running or failed. */
export function isSkippedNoTextChapter(
  chapter: Pick<Chapter, 'state' | 'skippedNoText'>,
): boolean {
  return chapter.state === 'done' && chapter.skippedNoText === true;
}
